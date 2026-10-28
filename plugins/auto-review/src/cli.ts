import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import {
  effectiveConfig,
  readLastFire,
  readProjectConfig,
  type GlobalDefaults,
  type LastFire,
} from "./config.js";
import { setAutoApprove } from "./cli-auto-approve.js";
import { reviewStatusView, showFindings } from "./cli-findings.js";
import { lastParkedAtOf, lastParkedLine, providerParkReleaseText, skippedText } from "./cli-park.js";
import { json } from "./cli-result.js";
import { resolveProjectId, setScope, type SettingsHandle } from "./cli-scope.js";
import { removeDeferral } from "./deferrals.js";
import { isBusyStatus, planGateServes } from "./gate.js";
import { recordUnfinishedReview } from "./review-outcome.js";
import {
  activePlanHold,
  LATCH_KEYS,
  PLAN_GATE_KEYS,
  PRESENT_PLAN_KEYS,
  readState,
  withThreadLock,
  writeState,
} from "./state.js";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Flags that never take a value, so they must not swallow a following positional. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "global", "clear"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ??
      // v8 ignore start -- @preserve the loop bound (cli.ts:37) proves argv[index] is present, so the empty fallback cannot run.
      "";
    // v8 ignore stop
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const nextToken = argv[index + 1];
    if (
      !BOOLEAN_FLAGS.has(body) &&
      nextToken !== undefined &&
      !nextToken.startsWith("--")
    ) {
      flags.set(body, nextToken);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { positionals, flags };
}

function threadError(threadId: string, wantsJson: boolean): PluginCliResult {
  const message = `Thread ${threadId} not found or unavailable.`;
  return wantsJson
    ? { exitCode: 1, stdout: `${JSON.stringify({ ok: false, threadId, error: message }, null, 2)}\n` }
    : { exitCode: 1, stderr: `${message}\n` };
}

/** The last fire for `status`: its outcome, reason and time, and how many changes stood unclaimed by the thread's family or were made while the turn waited, when it counted any. */
function lastFireLine(lastFire: LastFire | null): string {
  if (lastFire === null) {
    return "never";
  }
  const unclaimed =
    lastFire.unclaimedCount === undefined ? "" : `, ${lastFire.unclaimedCount} change(s) not made by this thread's family`;
  const parts = [
    lastFire.parkedCount ? `${lastFire.parkedCount} change(s)` : "",
    lastFire.parkedCommits?.length ? `commit(s) ${lastFire.parkedCommits.map((sha) => sha.slice(0, 7)).join(", ")}` : "",
  ].filter(Boolean);
  const parked = parts.length === 0 ? "" : `, ${parts.join(" and ")} made while this turn waited`;
  return `${lastFire.outcome} (${lastFire.reason}) at ${new Date(lastFire.at).toISOString()}${unclaimed}${parked}${skippedText(lastFire)}`;
}

/** The arm-age line for an active plan hold: the age of the arm against its window. */
function planHoldLine(planHold: { armedAt: number; windowMs: number } | null): string {
  if (planHold === null) {
    return "";
  }
  return `plan hold: armed ${Math.floor((Date.now() - planHold.armedAt) / 60_000)} min ago, window ${Math.floor(planHold.windowMs / 60_000)} min\n`;
}

/** What releases a deferred turn, for `status`. */
function deferredWaitText(heldBy: string[] | undefined, canStandDown: boolean): string {
  if (heldBy !== undefined) {
    return (
      `held by child threads (as of the last check): ${heldBy.join(", ")}\n` +
      "  It is reviewed when this thread next goes idle after bb wakes it for the last " +
      "of them ending, or by the 5-minute sweep once all of them have ended (idle, " +
      "errored, archived or deleted).\n" +
      "  Stop or archive a stuck child to release it — the turn is then re-checked for " +
      "review.\n"
    );
  }
  return (
    "waiting for another auto-review on the same provider to finish.\n" +
    `  ${providerParkReleaseText(canStandDown)}`
  );
}

export function registerAutoReviewCli(
  bb: BbPluginApi,
  settings: SettingsHandle,
  getGlobals: () => GlobalDefaults,
): void {
  bb.cli.register({
    name: "auto-review",
    summary: "Inspect and control automatic post-turn review, commit, and merge",
    commands: [
      {
        name: "status",
        summary: "Show effective state and last-fire outcome for a thread",
        usage: "bb auto-review status [thread-id] [--json]",
      },
      {
        name: "show",
        summary: "Show full effective settings for a project",
        usage: "bb auto-review show [--project <id>] [--json]",
      },
      {
        name: "enable",
        summary: "Enable auto-review globally or for one project",
        usage: "bb auto-review enable [--global | --project <id>] [--json]",
      },
      {
        name: "disable",
        summary: "Disable auto-review globally or for one project",
        usage: "bb auto-review disable [--global | --project <id>] [--json]",
      },
      {
        name: "auto-approve",
        summary:
          "Approve plans automatically once they completed auto-review's review, for one project (off by default)",
        usage: "bb auto-review auto-approve <on|off> --project <id> [--json]",
      },
      {
        name: "findings",
        summary:
          "List what a thread's reviews reported (finding chains and incidents); --clear drops the chains (terminal only, explicit thread id)",
        usage: "bb auto-review findings [thread-id] [--json] [--clear]",
      },
      {
        name: "reset",
        summary:
          "Clear a wedged latch for one idle thread; refused while it is running or holds a deferred turn",
        usage: "bb auto-review reset <thread-id> [--json]",
      },
    ],
    async run(argv, context): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const parsed = parseArgs(rest);
      const wantsJson = parsed.flags.has("json");

      if (command === "enable") {
        return setScope(bb, settings, context, {
          projectFlag: parsed.flags.get("project"),
          global: parsed.flags.has("global"),
          wantsJson: parsed.flags.has("json"),
        }, true);
      }
      if (command === "disable") {
        return setScope(bb, settings, context, {
          projectFlag: parsed.flags.get("project"),
          global: parsed.flags.has("global"),
          wantsJson: parsed.flags.has("json"),
        }, false);
      }

      if (command === "auto-approve") {
        return setAutoApprove(bb, context, {
          value: parsed.positionals[0],
          projectId: parsed.flags.get("project"),
          global: parsed.flags.has("global"),
          wantsJson,
        });
      }

      if (command === "findings") {
        return showFindings(bb, context, {
          threadId: parsed.positionals[0],
          clear: parsed.flags.has("clear"),
          wantsJson,
        });
      }

      if (command === "skip" || command === "unskip") {
        const message = `\`${command}\` was removed: auto-review reviews every turn and plan.`;
        return wantsJson
          ? json({ ok: false, command, error: message }, 2)
          : { exitCode: 2, stderr: `${message}\n` };
      }

      if (command === "reset") {
        const threadId = parsed.positionals[0] ?? context.threadId ?? null;
        // The fallback chain above ends in `?? null`, so the id is null, never undefined.
        if (threadId === null) {
          return {
            exitCode: 2,
            stderr: `A thread id is required: bb auto-review reset <thread-id>\n`,
          };
        }
        try {
          // Under the same lock the event drivers use: reset writes both thread
          // state and the deferral index, and an unlocked interleave with a
          // concurrent evaluate could delete an index entry that evaluate had
          // just written, re-stranding the thread. The status is read under the
          // lock too, so a turn that starts while reset waits for it is seen.
          const outcome = await withThreadLock(threadId, async () => {
            // Resetting a thread mid-turn would delete its `turnStart` and make the
            // turn in progress stand down unreviewed, so only an idle thread resets.
            const { status } = await bb.sdk.threads.get({ threadId });
            if (isBusyStatus(status)) {
              return {
                refused: `thread ${threadId} is ${status}; reset only clears a stuck latch on an idle thread — wait for the turn to end, then retry.`,
              };
            }
            const before = await readState(bb, threadId);
            // Its review runs when the hold clears; resetting would drop it.
            if (before.phase === "deferred") {
              return {
                refused: `thread ${threadId} has a deferred turn; its review runs when the hold clears — reset would drop it. ` +
                  `Check \`bb auto-review status ${threadId}\`; if the hold never clears, stop or archive the holding child thread, ` +
                  "or send the thread another message: its turn re-checks the hold, and once the hold has cleared, a turn that changes something reviews the parked work (a question leaves it carried).",
              };
            }
            // A review cut off by the reset must not leave the badge on the one before it.
            await recordUnfinishedReview(bb, threadId, before, "stopped");
            await writeState(bb, threadId, { phase: "idle" }, [
              ...LATCH_KEYS,
              // The escape hatch also lifts the one-review-per-user-message rule.
              "lastCodeReviewSeq",
              // Leftover from the removed per-thread skip flag.
              "skip",
              ...PLAN_GATE_KEYS,
              // Survives the gate's own disarms by design; a reset ends its one-shot life too.
              "planReleased",
              ...PRESENT_PLAN_KEYS,
            ]);
            await removeDeferral(bb, threadId);
            return { prior: before };
          });
          if ("refused" in outcome) {
            return wantsJson
              ? json({ ok: false, threadId, error: outcome.refused }, 2)
              : { exitCode: 2, stderr: `${outcome.refused}\n` };
          }
          const { prior } = outcome;
          const payload = {
            ok: true,
            command,
            threadId,
            priorPhase: prior.phase,
            wasLatched: prior.phase !== "idle",
          };
          if (wantsJson) {
            return json(payload);
          }
          if (prior.phase === "idle") {
            return {
              exitCode: 0,
              stdout: `reset ${threadId} (was already idle; nothing latched).\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `reset ${threadId} (cleared ${prior.phase} latch).\n`,
          };
        } catch {
          return threadError(threadId, wantsJson);
        }
      }

      if (command === "status") {
        const threadId = parsed.positionals[0] ?? context.threadId ?? null;
        if (threadId === null || threadId === undefined) {
          return {
            exitCode: 2,
            stderr:
              "A thread id is required: bb auto-review status [thread-id] (or run inside a thread).\n",
          };
        }
        let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
        try {
          thread = await bb.sdk.threads.get({ threadId });
        } catch {
          return threadError(threadId, wantsJson);
        }
        const projectId = thread.projectId;
        const state = await readState(bb, threadId);
        const project = await readProjectConfig(bb, projectId);
        const config = effectiveConfig(getGlobals(), project);
        const planGate = planGateServes(thread, config);
        const lastFire = await readLastFire(bb, projectId, threadId);
        const review = await reviewStatusView(bb, threadId, state.phase);
        const lastParkedAt = lastParkedAtOf(state);
        const planHold = activePlanHold(state, Date.now());
        const payload = {
          threadId,
          projectId,
          enabled: config.enabled,
          reviewMode: config.reviewMode,
          mergeEligibleMainlines: config.mergeEligibleMainlines,
          autoApprovePlans: config.autoApprovePlans,
          planGate,
          phase: state.phase,
          deferredSince: state.deferredSince ?? null,
          lastParkedAt,
          heldBy: state.heldBy ?? null,
          planHoldArmedAt: planHold?.armedAt ?? null,
          planHoldWindowMs: planHold?.windowMs ?? null,
          lastFire,
          ...review.fields,
        };
        if (wantsJson) {
          return json(payload);
        }
        const lastFireText = lastFireLine(lastFire);
        // A parked turn is the one phase a user is likely to see and not
        // recognise, so spell out how long it has waited and what happens next
        // rather than printing a bare word.
        const deferredText =
          state.phase === "deferred" && state.deferredSince !== undefined
            ? `deferred for: ${Math.floor((Date.now() - state.deferredSince) / 60_000)} min — ` +
              deferredWaitText(state.heldBy, lastParkedAt !== null)
            : "";
        const lastParkedText = lastParkedLine(lastParkedAt);
        return {
          exitCode: 0,
          stdout:
            `enabled: ${config.enabled}\n` +
            `reviewMode: ${config.reviewMode}\n` +
            `mergeEligibleMainlines: ${config.mergeEligibleMainlines.join(", ")}\n` +
            `autoApprovePlans: ${config.autoApprovePlans}\n` +
            `planGate: ${planGate}\n` +
            `phase: ${state.phase}\n` +
            deferredText +
            lastParkedText +
            planHoldLine(planHold) +
            `lastFire: ${lastFireText}\n` +
            review.text,
        };
      }

      if (command === "show") {
        const projectFlag = parsed.flags.get("project");
        const projectId =
          typeof projectFlag === "string"
            ? projectFlag
            : await resolveProjectId(bb, context);
        const project =
          projectId === null ? {} : await readProjectConfig(bb, projectId);
        const globals = getGlobals();
        const config = effectiveConfig(globals, project);
        const payload = {
          projectId,
          globals,
          projectOverride: project,
          effective: {
            enabled: config.enabled,
            reviewMode: config.reviewMode,
            mergeEligibleMainlines: config.mergeEligibleMainlines,
            autoApprovePlans: config.autoApprovePlans,
          },
        };
        if (wantsJson) {
          return json(payload);
        }
        return {
          exitCode: 0,
          stdout:
            `project: ${projectId ?? "(none)"}\n` +
            `enabled: ${config.enabled}\n` +
            `reviewMode: ${config.reviewMode}\n` +
            `mergeEligibleMainlines: ${config.mergeEligibleMainlines.join(", ")}\n` +
            `autoApprovePlans: ${config.autoApprovePlans}\n`,
        };
      }

      return {
        exitCode: 2,
        stderr:
          "Usage: bb auto-review <status|show|enable|disable|auto-approve|findings|reset> [--json]\n",
      };
    },
  });
}
