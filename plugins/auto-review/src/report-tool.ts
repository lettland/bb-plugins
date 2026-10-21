import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { recordCodeReport } from "./baseline-store.js";
import { queuedRowExists, type ReviewContext } from "./context.js";
import { reviewReportSchema, type ReviewReport } from "./findings-schema.js";
import { readFindings, writeFindings } from "./findings-store.js";
import { mergeReport, openChains } from "./findings.js";
import { reviewSkillLoaded } from "./plan.js";
import { AUTO_REVIEW_MARKER } from "./prompt.js";
import { deliveredPatch } from "./review-outcome.js";
import { readState, withThreadLock, writeState, type ThreadState } from "./state.js";

/** The structured-report tool every top-level thread gets (see `configure` in present-plan.ts). */
export const REPORT_REVIEW_TOOL_NAME = "ReportReview";

const NO_REVIEW_MESSAGE =
  `${AUTO_REVIEW_MARKER} No auto-review is in progress for this thread, so nothing was recorded. Only call ReportReview when an ${AUTO_REVIEW_MARKER} prompt asks you to.`;

/** The summary prefix the prompt prescribes for a stand-down (see src/prompt.ts). */
const STOOD_DOWN_PREFIX = "Stood down: no own edits.";
/** The plugin's own skipped step: what the evidence check says about the agent's `review-code` load. */
const REVIEW_CODE_NOT_LOADED = "review-code was not loaded";

/** The ack's opening line, then any repeated dismissals the merge left unchanged. */
function ackLines(opening: string, ignored: readonly { key: string; why: string }[]): string[] {
  const lines = [opening];
  if (ignored.length > 0) {
    lines.push(
      `Ignored, unchanged: ${ignored.map(({ key }) => key).join(", ")} — already dismissed with that reason; a new reason is needed to dismiss it again.`,
    );
  }
  return lines;
}

/**
 * The tool's ack. With `notRun`, the steps the review never ran: the record is
 * `incomplete`, never the reported outcome, and the agent must open its final
 * reply by saying so to the user.
 */
function ackText(
  report: ReviewReport,
  counts: { open: number; fixed: number; falsePositive: number },
  ignored: readonly { key: string; why: string }[],
  notRun?: readonly string[],
): string {
  const opening =
    notRun === undefined
      ? `${AUTO_REVIEW_MARKER} Review recorded: ${report.outcome} (${counts.open} open, ${counts.fixed} fixed, ${counts.falsePositive} false positive).`
      : `${AUTO_REVIEW_MARKER} Review recorded as incomplete, not ${report.outcome} (${counts.open} open, ${counts.fixed} fixed, ${counts.falsePositive} false positive): not run — ${notRun.join(", ")}.`;
  const lines = ackLines(opening, ignored);
  if (notRun === undefined) {
    lines.push("Call ReportReview again only if the result changes: the last report replaces this one.");
    return lines.join("\n");
  }
  // Only a committed or merged report names work that landed without the full review.
  const landed =
    report.outcome === "committed" || report.outcome === "merged"
      ? ` The work was already ${report.outcome} without the full review: say so in your final reply.`
      : "";
  lines.push(
    `Open your final reply by telling the user the auto-review did not run in full: name each skipped step and why.${landed} Never describe this review as clean or as having found nothing.`,
  );
  lines.push(
    "To finish the review instead, run the missing steps and put any fixes through the prompt's stage, check, and commit steps, then call ReportReview again: that call is re-checked, and a passing report replaces this one.",
  );
  return lines.join("\n");
}

/** A stand-down only in its exact documented shape (src/prompt.ts); the same summary prefix on any other report is still checked. */
function isStandDown(report: ReviewReport): boolean {
  return (
    report.outcome === "no-changes" &&
    report.findings.length === 0 &&
    report.summary.startsWith(STOOD_DOWN_PREFIX)
  );
}

/**
 * The steps of the review this report says did not run: the plugin's own
 * `review-code` evidence when the dispatch-time latch required it — read from
 * the pre-send `lastCodeReviewSeq`, never the later `reviewDeliveredSeq` —
 * plus whatever the agent declared in `skipped`. "unknown" (no cursor, a log
 * that cannot be read or is over the page cap) accuses nobody, so no step is
 * named; the caller then only holds the baseline back.
 */
async function skippedSteps(
  bb: BbPluginApi,
  threadId: string,
  state: ThreadState,
  report: ReviewReport,
): Promise<{ steps: string[]; unknown: boolean }> {
  const declared = report.skipped ?? [];
  if (state.reviewSkillRequired !== true) {
    return { steps: declared, unknown: false };
  }
  const loaded = await reviewSkillLoaded(bb, threadId, state.lastCodeReviewSeq);
  if (loaded === "unknown") {
    return { steps: declared, unknown: true };
  }
  // A union: the plugin's own step first, then the agent's, without repeats.
  const steps = loaded === "missing" ? [REVIEW_CODE_NOT_LOADED, ...declared] : declared;
  return { steps: [...new Set(steps)], unknown: false };
}

/**
 * Promotes a queued review whose row is gone: the event that says it was
 * dispatched can be missed, and the agent calling this is proof it arrived.
 */
async function promoteMissedDispatch(
  review: ReviewContext,
  threadId: string,
  state: ThreadState,
): Promise<ThreadState> {
  const { bb } = review;
  if (
    state.phase !== "pending-dispatch" ||
    state.pendingEntryId === undefined ||
    (await queuedRowExists(review, threadId, state.pendingEntryId))
  ) {
    return state;
  }
  const delivered = await deliveredPatch(bb, threadId);
  await writeState(bb, threadId, { phase: "awaiting-review", ...delivered }, ["pendingEntryId"]);
  const { pendingEntryId: _gone, ...rest } = state;
  return { ...rest, phase: "awaiting-review", ...delivered };
}

/**
 * `ReportReview`'s `execute`: accepted only while a review is in flight AND its
 * prompt has reached the agent, so a stray call (an ordinary turn, a queued
 * review that has not run, a latch since reset) records nothing.
 */
export async function reportReview(
  review: ReviewContext,
  report: ReviewReport,
  ctx: PluginAgentToolContext,
): Promise<PluginAgentToolResult> {
  const { bb } = review;
  return withThreadLock(ctx.threadId, async () => {
    const state = await promoteMissedDispatch(review, ctx.threadId, await readState(bb, ctx.threadId));
    if (state.phase !== "awaiting-review" || state.reviewDeliveredAt === undefined) {
      return { content: [{ type: "text", text: NO_REVIEW_MESSAGE }], isError: true };
    }
    // `blocked` and a documented stand-down are exempt from the check; a
    // stand-down reviewed nothing, so its baseline is never recorded clean.
    const standDown = isStandDown(report);
    const skipped =
      standDown || report.outcome === "blocked"
        ? { steps: [] as string[], unknown: false }
        : await skippedSteps(bb, ctx.threadId, state, report);
    const notClean = standDown || skipped.steps.length > 0 || skipped.unknown;
    const merged = mergeReport(
      await readFindings(bb, ctx.threadId),
      report,
      state.reviewDeliveredAt,
      Date.now(),
      skipped.steps.length > 0
        ? { detail: `Reported as ${report.outcome}; not run: ${skipped.steps.join(", ")}` }
        : undefined,
    );
    await writeFindings(bb, ctx.threadId, merged.store);
    await recordCodeReport(
      bb,
      ctx.threadId,
      report,
      notClean ||
        report.outcome === "blocked" ||
        openChains(merged.store).some((chain) => chain.severity === "blocker"),
    );
    if (skipped.steps.length > 0) {
      bb.log.warn(
        `auto-review: the review reported for ${ctx.threadId} was incomplete, not run: ${skipped.steps.join(", ")}`,
      );
      return ackText(report, merged.counts, merged.ignored, skipped.steps);
    }
    if (skipped.unknown) {
      bb.log.warn(
        `auto-review: could not verify review-code was loaded in ${ctx.threadId}; the report is kept and the review baseline is recorded as not clean`,
      );
    }
    return ackText(report, merged.counts, merged.ignored);
  });
}

export function registerReportTool(review: ReviewContext): void {
  review.bb.agents.registerTool({
    name: REPORT_REVIEW_TOOL_NAME,
    description:
      `Only call this when an ${AUTO_REVIEW_MARKER} prompt asks you to. A finding's key is lowercase [a-z0-9._:/-] (for example src-foo-ts:null-check) and its file a repo-relative path without spaces (the nearest file for a finding that is not about one). Set \`security: true\` on a finding about a secret, credential or other security issue. Describe secrets by location and type, never by value. List in \`skipped\` each step of the review that did not run as written.`,
    presentation: {
      label: { pending: "Reporting review", completed: "Reported review" },
    },
    parameters: reviewReportSchema,
    async execute(input, ctx): Promise<PluginAgentToolResult> {
      return reportReview(review, input, ctx);
    },
  });
}
