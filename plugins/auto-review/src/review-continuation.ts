import type { ReviewContext } from "./context.js";
import { endedTurnIsUsers, spawnedDescendantIds } from "./detect.js";
import { REVIEW_CONTINUATION_CAP_MS, type ThreadState, type TurnStart } from "./state.js";

/**
 * Whether the review is still being carried on by its children: one running,
 * or a wake-up queued behind the review turn — a message due now that is not
 * the user's or a plugin's and comes from no thread or one this thread spawned. Past the cap,
 * or with no date to measure it from, it never holds, so a hung child cannot
 * keep the latch forever. A failed lookup warns and answers no — the latch must
 * never stick on an error.
 *
 * Residual race: a child that goes idle before core queues its wake-up row
 * leaves nothing to see here, so the hold ends one idle early and that
 * wake-up turn's fixes get one more review.
 */
export async function reviewContinuationPending(
  ctx: ReviewContext,
  state: ThreadState,
  threadId: string,
): Promise<boolean> {
  const since = state.reviewDeliveredAt ?? state.dispatchedAt;
  if (since === undefined || Date.now() - since > REVIEW_CONTINUATION_CAP_MS) {
    return false;
  }
  try {
    const descendants = await spawnedDescendantIds(ctx.bb, threadId);
    if (descendants.running.length > 0) {
      return true;
    }
    const now = Date.now();
    const rows = await ctx.bb.sdk.threads.queuedMessages.list({ threadId });
    return rows.some(
      (row) =>
        row.failureReason === null &&
        row.initiator !== "user" &&
        row.origin !== "plugin" &&
        (row.sendAt === null || row.sendAt <= now) &&
        (row.senderThreadId === null || descendants.all.has(row.senderThreadId)),
    );
  } catch (error) {
    ctx.bb.log.warn(
      `auto-review: could not check what ${threadId}'s review is waiting on; ending it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/**
 * Whether the turn that has just ended during the hold was the user's, read
 * from the requests that started it (see `endedTurnIsUsers`). The cursor is the
 * one taken before the review was sent where there is one, so the review's own
 * turn is read like any other. A turn that cannot be read counts as the user's: a
 * follow-up review that finds nothing costs less than an edit nobody reviewed.
 */
export async function userTurnEnded(
  bb: ReviewContext["bb"],
  threadId: string,
  state: ThreadState,
  turnStart: TurnStart,
): Promise<boolean> {
  const sinceSeq = state.lastCodeReviewSeq ?? state.reviewDeliveredSeq ?? turnStart.sinceSeq;
  try {
    return await endedTurnIsUsers(bb, threadId, sinceSeq);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read whether the turn that ended in ${threadId} was the user's; counting it as theirs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}
