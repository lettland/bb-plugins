import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { stoppedByUser, tryCaptureSinceSeq } from "./detect.js";
import { readFindings, recordUnreported, reviewRecorded } from "./findings.js";
import type { ThreadState } from "./state.js";

/**
 * The state patch for a review prompt that has just reached the agent: the
 * time is the review's id, the cursor tells a later stop apart from the work
 * turn's. A cursor that cannot be read only costs the stop-versus-silence
 * distinction, so it is left out rather than failing the delivery.
 */
export async function deliveredPatch(
  bb: BbPluginApi,
  threadId: string,
): Promise<Pick<ThreadState, "reviewDeliveredAt" | "reviewDeliveredSeq">> {
  const reviewDeliveredAt = Date.now();
  const reviewDeliveredSeq = await tryCaptureSinceSeq(bb, threadId, `the delivered review in ${threadId}`);
  return reviewDeliveredSeq === undefined ? { reviewDeliveredAt } : { reviewDeliveredAt, reviewDeliveredSeq };
}

const NOT_REPORTED_HINT =
  "The review turn ended without a ReportReview call; its commit and merge may still have happened. If this session started before the plugin update, restart it so it gets the tool.";

async function userStoppedReview(
  bb: BbPluginApi,
  threadId: string,
  state: ThreadState,
): Promise<boolean> {
  const sinceSeq = state.reviewDeliveredSeq ?? state.turnStart?.sinceSeq;
  if (sinceSeq === undefined) {
    return false;
  }
  try {
    return await stoppedByUser(bb, threadId, sinceSeq);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read whether the review in ${threadId} was stopped: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Records how a delivered review ended when its agent never reported: `stopped`
 * when the user (or a reset) ended it, `not-reported` — with an incident —
 * when it simply ended. Nothing is recorded when the report did arrive.
 * Callers hold the thread's lock and reset the latch afterwards.
 *
 * `cause` is how the caller knows the review ended: `idle` still has to tell a
 * stop from silence, the others already know.
 */
export async function recordUnfinishedReview(
  bb: BbPluginApi,
  threadId: string,
  state: ThreadState,
  cause: "idle" | "stopped" | "gone",
): Promise<void> {
  if (state.phase !== "awaiting-review") {
    return;
  }
  const store = await readFindings(bb, threadId);
  if (reviewRecorded(store, state.reviewDeliveredAt)) {
    return;
  }
  const reviewId = state.reviewDeliveredAt ?? state.dispatchedAt ?? Date.now();
  const stopped = cause === "stopped" || (cause === "idle" && (await userStoppedReview(bb, threadId, state)));
  await recordUnreported(
    bb,
    threadId,
    stopped
      ? { reviewId, outcome: "stopped", summary: "The review was stopped before it reported." }
      : {
          reviewId,
          outcome: "not-reported",
          summary: "The review ended without reporting.",
          incident: { kind: "not-reported", detail: NOT_REPORTED_HINT },
        },
  );
}

/** A queued review that was cancelled before it reached the agent. */
export async function recordCancelledReview(
  bb: BbPluginApi,
  threadId: string,
  state: ThreadState,
): Promise<void> {
  await recordUnreported(bb, threadId, {
    reviewId: state.dispatchedAt ?? Date.now(),
    outcome: "stopped",
    summary: "The queued review was cancelled before it ran.",
  });
}
