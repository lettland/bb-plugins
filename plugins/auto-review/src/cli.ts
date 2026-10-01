import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  defineAutoReviewSettings,
  effectiveConfig,
  readLastFire,
  readProjectConfig,
  writeProjectConfig,
  type GlobalDefaults,
} from "./config.js";
import { removeDeferral } from "./deferrals.js";
import {
  LATCH_KEYS,
  PLAN_GATE_KEYS,
  readState,
  withThreadLock,
  writeState,
} from "./state.js";

type SettingsHandle = ReturnType<typeof defineAutoReviewSettings>;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

/** Flags that never take a value, so they must not swallow a following positional. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["json", "global"]);

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
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

function json(value: unknown, exitCode = 0): PluginCliResult {
  return { exitCode, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

function threadError(threadId: string, wantsJson: boolean): PluginCliResult {
  const message = `Thread ${threadId} not found or unavailable.`;
  return wantsJson
    ? { exitCode: 1, stdout: `${JSON.stringify({ ok: false, threadId, error: message }, null, 2)}\n` }
    : { exitCode: 1, stderr: `${message}\n` };
}

/** What releases a deferred turn, and how to drop it instead, for `status`. */
function deferredWaitText(threadId: string, heldBy: string[] | undefined): string {
  if (heldBy !== undefined) {
    return (
      `held by child threads (as of the last check): ${heldBy.join(", ")}\n` +
      "  It is reviewed when this thread next goes idle after bb wakes it for the last " +
      "of them ending, or by the 5-minute sweep once all of them have ended (idle, " +
      "errored, archived or deleted).\n" +
      "  Stop or archive a stuck child to release it — the turn is then re-checked for " +
      "review.\n" +
      `  To drop it instead: bb auto-review reset ${threadId}\n`
    );
  }
  return (
    "waiting for another auto-review on the same provider to finish.\n" +
    "  It fires automatically as soon as that review ends.\n" +
    `  To drop it instead: bb auto-review reset ${threadId}\n`
  );
}

/** What a dropped deferred turn was waiting on, for `reset`'s report. */
function droppedDeferralWaitText(heldBy: string[] | undefined): string {
  return heldBy !== undefined
    ? `waiting for child threads to finish (${heldBy.join(", ")}), not stuck`
    : "waiting for another review on its provider to finish, not stuck";
}

async function resolveProjectId(
  bb: BbPluginApi,
  context: PluginCliContext,
): Promise<string | null> {
  if (context.threadId === undefined || context.threadId === null) {
    return null;
  }
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  return thread.projectId;
}

async function setScope(
  bb: BbPluginApi,
  settings: SettingsHandle,
  context: PluginCliContext,
  parsed: ParsedArgs,
  enabled: boolean,
): Promise<PluginCliResult> {
  const wantsJson = parsed.flags.has("json");
  const projectFlag = parsed.flags.get("project");
  if (parsed.flags.has("global") && projectFlag !== undefined) {
    return {
      exitCode: 2,
      stderr: "Specify only one of --global or --project <id>.\n",
    };
  }
  const global = parsed.flags.has("global") || projectFlag === undefined;

  if (global) {
    await settings.experimental_set({ enabled });
    const payload = { ok: true, scope: "global", enabled };
    return wantsJson
      ? json(payload)
      : {
          exitCode: 0,
          stdout: `Auto-review ${enabled ? "enabled" : "disabled"} globally.\n`,
        };
  }

  const projectId =
    typeof projectFlag === "string"
      ? projectFlag
      : await resolveProjectId(bb, context);
  if (projectId === null) {
    return {
      exitCode: 2,
      stderr: "A project id is required: pass --project <id> or run inside a thread.\n",
    };
  }
  await writeProjectConfig(bb, projectId, { enabled });
  const payload = { ok: true, scope: "project", projectId, enabled };
  return wantsJson
    ? json(payload)
    : {
        exitCode: 0,
        stdout: `Auto-review ${enabled ? "enabled" : "disabled"} for project ${projectId}.\n`,
      };
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
        name: "skip",
        summary: "Skip auto-review for one thread",
        usage: "bb auto-review skip <thread-id> [--json]",
      },
      {
        name: "unskip",
        summary: "Clear the skip flag for one thread",
        usage: "bb auto-review unskip <thread-id> [--json]",
      },
      {
        name: "reset",
        summary:
          "Clear a wedged latch (and skip) for one thread — also DROPS a deferred turn's pending review",
        usage: "bb auto-review reset <thread-id> [--json]",
      },
    ],
    async run(argv, context): Promise<PluginCliResult> {
      const [command, ...rest] = argv;
      const parsed = parseArgs(rest);
      const wantsJson = parsed.flags.has("json");

      if (command === "enable") {
        return setScope(bb, settings, context, parsed, true);
      }
      if (command === "disable") {
        return setScope(bb, settings, context, parsed, false);
      }

      if (command === "skip" || command === "unskip" || command === "reset") {
        const threadId = parsed.positionals[0] ?? context.threadId ?? null;
        if (threadId === null || threadId === undefined) {
          return {
            exitCode: 2,
            stderr: `A thread id is required: bb auto-review ${command} <thread-id>\n`,
          };
        }
        try {
          if (command === "skip") {
            await writeState(bb, threadId, { skip: true });
          } else if (command === "unskip") {
            await writeState(bb, threadId, {}, ["skip"]);
          } else {
            // Under the same lock the event drivers use: reset now writes both
            // thread state and the deferral index, and an unlocked interleave
            // with a concurrent evaluate could delete an index entry that
            // evaluate had just written, re-stranding the thread.
            const prior = await withThreadLock(threadId, async () => {
              const before = await readState(bb, threadId);
              await writeState(bb, threadId, { phase: "idle" }, [
                ...LATCH_KEYS,
                "skip",
                ...PLAN_GATE_KEYS,
              ]);
              await removeDeferral(bb, threadId);
              return before;
            });
            const payload = {
              ok: true,
              command,
              threadId,
              priorPhase: prior.phase,
              wasLatched: prior.phase !== "idle",
              droppedDeferral: prior.phase === "deferred",
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
            if (prior.phase === "deferred") {
              return {
                exitCode: 0,
                stdout:
                  `reset ${threadId} (dropped a deferred turn).\n` +
                  `That turn was ${droppedDeferralWaitText(prior.heldBy)} — ` +
                  "its review and commit will now never run.\n",
              };
            }
            return {
              exitCode: 0,
              stdout: `reset ${threadId} (cleared ${prior.phase} latch).\n`,
            };
          }
        } catch {
          return threadError(threadId, wantsJson);
        }
        const payload = { ok: true, command, threadId };
        return wantsJson
          ? json(payload)
          : { exitCode: 0, stdout: `${command} applied to ${threadId}.\n` };
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
        let projectId: string;
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          projectId = thread.projectId;
        } catch {
          return threadError(threadId, wantsJson);
        }
        const state = await readState(bb, threadId);
        const project = await readProjectConfig(bb, projectId);
        const config = effectiveConfig(getGlobals(), project, state.skip === true);
        const lastFire = await readLastFire(bb, projectId, threadId);
        const payload = {
          threadId,
          projectId,
          enabled: config.enabled,
          skipped: config.skipped,
          reviewMode: config.reviewMode,
          mergeEligibleMainlines: config.mergeEligibleMainlines,
          phase: state.phase,
          deferredSince: state.deferredSince ?? null,
          heldBy: state.heldBy ?? null,
          lastFire,
        };
        if (wantsJson) {
          return json(payload);
        }
        const lastFireText =
          lastFire === null
            ? "never"
            : `${lastFire.outcome} (${lastFire.reason}) at ${new Date(lastFire.at).toISOString()}`;
        // A parked turn is the one phase a user is likely to see and not
        // recognise, so spell out how long it has waited and what happens next
        // rather than printing a bare word.
        const deferredText =
          state.phase === "deferred" && state.deferredSince !== undefined
            ? `deferred for: ${Math.floor((Date.now() - state.deferredSince) / 60_000)} min — ` +
              deferredWaitText(threadId, state.heldBy)
            : "";
        return {
          exitCode: 0,
          stdout:
            `enabled: ${config.enabled}\n` +
            `skipped: ${config.skipped}\n` +
            `reviewMode: ${config.reviewMode}\n` +
            `mergeEligibleMainlines: ${config.mergeEligibleMainlines.join(", ")}\n` +
            `phase: ${state.phase}\n` +
            deferredText +
            `lastFire: ${lastFireText}\n`,
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
        const config = effectiveConfig(globals, project, false);
        const payload = {
          projectId,
          globals,
          projectOverride: project,
          effective: {
            enabled: config.enabled,
            reviewMode: config.reviewMode,
            mergeEligibleMainlines: config.mergeEligibleMainlines,
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
            `mergeEligibleMainlines: ${config.mergeEligibleMainlines.join(", ")}\n`,
        };
      }

      return {
        exitCode: 2,
        stderr:
          "Usage: bb auto-review <status|show|enable|disable|skip|unskip|reset> [--json]\n",
      };
    },
  });
}
