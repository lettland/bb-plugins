import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import { commandError, json } from "./cli-result.js";
import { MAX_PROMPT_FINDINGS, type FindingChain, type FindingsStore } from "./findings-schema.js";
import { readFindings, writeFindings } from "./findings-store.js";
import { omittedOpenCount, summarizeReview } from "./findings.js";
import { REVIEW_IN_FLIGHT_PHASES, withThreadLock, type AutoReviewPhase } from "./state.js";

const FINDINGS_USAGE = "Usage: bb auto-review findings [thread-id] [--json] [--clear]";

/** A chain dismissed more than once at high severity is worth a second look, whoever dismissed it. */
function repeatedlyDismissed(chain: FindingChain): boolean {
  return chain.dismissCount > 1 && (chain.severity === "high" || chain.severity === "blocker");
}

function chainLine(chain: FindingChain): string {
  const flags = [
    chain.reRaised ? "re-raised" : null,
    repeatedlyDismissed(chain) ? `dismissed ${chain.dismissCount}x — worth a second look` : null,
  ].filter((flag) => flag !== null);
  const location = chain.line === undefined ? chain.file : `${chain.file}:${chain.line}`;
  return (
    `  ${chain.key} [${chain.severity}] ${chain.status} ${location} — ${chain.title}` +
    (chain.reason === undefined ? "" : ` (${chain.reason})`) +
    ` raised ${chain.raisedCount}x` +
    (flags.length > 0 ? ` — ${flags.join("; ")}` : "")
  );
}

function sortedChains(store: FindingsStore): FindingChain[] {
  return Object.values(store.chains).sort(
    (left, right) =>
      Number(right.status === "open") - Number(left.status === "open") ||
      right.lastSeenAt - left.lastSeenAt,
  );
}

function findingsText(threadId: string, store: FindingsStore, omitted: number): string {
  const chains = sortedChains(store);
  const open = chains.filter((chain) => chain.status === "open").length;
  const capNote =
    omitted > 0
      ? ` (the next review lists the first ${MAX_PROMPT_FINDINGS}; ${omitted} more are not listed)`
      : "";
  const lines = [
    `thread: ${threadId}`,
    store.lastReport === undefined
      ? "lastReport: none"
      : `lastReport: ${store.lastReport.outcome} at ${new Date(store.lastReport.at).toISOString()} — ${store.lastReport.summary}`,
    `open: ${open}${capNote}`,
    chains.length === 0 ? "findings: none" : "findings:",
    ...chains.map(chainLine),
  ];
  if (store.incidents.length > 0) {
    lines.push("incidents:");
    for (const incident of store.incidents) {
      lines.push(`  ${new Date(incident.at).toISOString()} ${incident.kind}: ${incident.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The review part of `bb auto-review status`: the keys added to its `--json`
 * payload and the lines added to its text.
 */
export async function reviewStatusView(
  bb: BbPluginApi,
  threadId: string,
  phase: AutoReviewPhase,
): Promise<{ fields: Record<string, unknown>; text: string }> {
  const store = await readFindings(bb, threadId);
  const review = summarizeReview(store, REVIEW_IN_FLIGHT_PHASES.includes(phase));
  const result =
    review.status === "none"
      ? "none"
      : `${review.status}${review.at === null ? "" : ` at ${new Date(review.at).toISOString()}`} (${review.openCount} open${
          review.omittedFromPrompt > 0 ? ` — ${review.omittedFromPrompt} not listed in the next review's prompt` : ""
        }, ${review.reRaisedCount} re-raised)`;
  const incident =
    review.lastIncident === null
      ? ""
      : `lastIncident: ${review.lastIncident.kind} at ${new Date(review.lastIncident.at).toISOString()}: ${review.lastIncident.detail}\n`;
  return {
    fields: {
      reviewResult: {
        status: review.status,
        at: review.at,
        summary: store.lastReport?.summary ?? null,
      },
      openFindings: review.openCount,
      reRaisedFindings: review.reRaisedCount,
      omittedFromPrompt: review.omittedFromPrompt,
      lastIncident: review.lastIncident,
    },
    text: `reviewResult: ${result}\n${incident}`,
  };
}

/**
 * `bb auto-review findings`: what the thread's reviews reported. `--clear`
 * drops the chains only (the last report and incidents stay), and, like turning
 * plan auto-approve on, is refused from inside a thread and needs an explicit
 * thread id — a guard against an agent wiping its own history by accident. It
 * keys off the thread context, which an agent could strip, so it is not a
 * security boundary.
 */
export async function showFindings(
  bb: BbPluginApi,
  context: PluginCliContext,
  args: { threadId: string | undefined; clear: boolean; wantsJson: boolean },
): Promise<PluginCliResult> {
  const { clear, wantsJson } = args;
  const inThread = context.threadId ?? null;
  if (clear && inThread !== null) {
    return commandError("findings", "--clear is only allowed from a terminal outside a bb thread.", wantsJson);
  }
  const threadId = clear ? args.threadId : (args.threadId ?? inThread ?? undefined);
  if (threadId === undefined) {
    return commandError(
      "findings",
      clear
        ? "--clear needs an explicit thread id: bb auto-review findings <thread-id> --clear"
        : `A thread id is required (or run inside a thread). ${FINDINGS_USAGE}`,
      wantsJson,
    );
  }
  try {
    await bb.sdk.threads.get({ threadId });
  } catch {
    const message = `Thread ${threadId} not found or unavailable.`;
    return wantsJson
      ? json({ ok: false, threadId, error: message }, 1)
      : { exitCode: 1, stderr: `${message}\n` };
  }
  if (clear) {
    const cleared = await withThreadLock(threadId, async () => {
      const store = await readFindings(bb, threadId);
      await writeFindings(bb, threadId, { ...store, chains: {} });
      return Object.keys(store.chains).length;
    });
    bb.log.info(`findings for thread ${threadId}: cleared ${cleared} chain(s) (via terminal)`);
    return wantsJson
      ? json({ ok: true, command: "findings", threadId, cleared })
      : { exitCode: 0, stdout: `Cleared ${cleared} finding(s) for ${threadId}.\n` };
  }
  const store = await readFindings(bb, threadId);
  const omitted = omittedOpenCount(store);
  if (wantsJson) {
    return json({
      threadId,
      lastReport: store.lastReport ?? null,
      chains: sortedChains(store),
      incidents: store.incidents,
      omittedFromPrompt: omitted,
    });
  }
  return { exitCode: 0, stdout: findingsText(threadId, store, omitted) };
}
