import type { PluginAgentToolContext, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { recordCodeReport } from "./baseline-store.js";
import { queuedRowExists, type ReviewContext } from "./context.js";
import { reviewReportSchema, type ReviewReport } from "./findings-schema.js";
import { readFindings, writeFindings } from "./findings-store.js";
import { mergeReport, openChains } from "./findings.js";
import { AUTO_REVIEW_MARKER } from "./prompt.js";
import { deliveredPatch } from "./review-outcome.js";
import { readState, withThreadLock, writeState } from "./state.js";

/** The structured-report tool every top-level thread gets (see `configure` in present-plan.ts). */
export const REPORT_REVIEW_TOOL_NAME = "ReportReview";

const NO_REVIEW_MESSAGE =
  `${AUTO_REVIEW_MARKER} No auto-review is in progress for this thread, so nothing was recorded. Only call ReportReview when an ${AUTO_REVIEW_MARKER} prompt asks you to.`;

function ackText(
  report: ReviewReport,
  counts: { open: number; fixed: number; falsePositive: number },
  ignored: readonly { key: string; why: string }[],
): string {
  const lines = [
    `${AUTO_REVIEW_MARKER} Review recorded: ${report.outcome} (${counts.open} open, ${counts.fixed} fixed, ${counts.falsePositive} false positive).`,
  ];
  if (ignored.length > 0) {
    lines.push(
      `Ignored, unchanged: ${ignored.map(({ key }) => key).join(", ")} — already dismissed with that reason; a new reason is needed to dismiss it again.`,
    );
  }
  lines.push("Call ReportReview again only if the result changes: the last report replaces this one.");
  return lines.join("\n");
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
    let state = await readState(bb, ctx.threadId);
    // A queued review whose row is gone was dispatched; the event that says so
    // can be missed, and the agent calling this is proof it arrived.
    if (
      state.phase === "pending-dispatch" &&
      state.pendingEntryId !== undefined &&
      !(await queuedRowExists(review, ctx.threadId, state.pendingEntryId))
    ) {
      const delivered = await deliveredPatch(bb, ctx.threadId);
      await writeState(bb, ctx.threadId, { phase: "awaiting-review", ...delivered }, ["pendingEntryId"]);
      const { pendingEntryId: _gone, ...rest } = state;
      state = { ...rest, phase: "awaiting-review", ...delivered };
    }
    if (state.phase !== "awaiting-review" || state.reviewDeliveredAt === undefined) {
      return { content: [{ type: "text", text: NO_REVIEW_MESSAGE }], isError: true };
    }
    const merged = mergeReport(
      await readFindings(bb, ctx.threadId),
      report,
      state.reviewDeliveredAt,
      Date.now(),
    );
    await writeFindings(bb, ctx.threadId, merged.store);
    await recordCodeReport(
      bb,
      ctx.threadId,
      report,
      report.outcome === "blocked" || openChains(merged.store).some((chain) => chain.severity === "blocker"),
    );
    return ackText(report, merged.counts, merged.ignored);
  });
}

export function registerReportTool(review: ReviewContext): void {
  review.bb.agents.registerTool({
    name: REPORT_REVIEW_TOOL_NAME,
    description:
      `Only call this when an ${AUTO_REVIEW_MARKER} prompt asks you to. A finding's key is lowercase [a-z0-9._:/-] (for example src-foo-ts:null-check) and its file a repo-relative path without spaces (the nearest file for a finding that is not about one). Set \`security: true\` on a finding about a secret, credential or other security issue. Describe secrets by location and type, never by value.`,
    presentation: {
      label: { pending: "Reporting review", completed: "Reported review" },
    },
    parameters: reviewReportSchema,
    async execute(input, ctx): Promise<PluginAgentToolResult> {
      return reportReview(review, input, ctx);
    },
  });
}
