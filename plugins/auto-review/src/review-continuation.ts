import type { ReviewContext } from "./context.js";
import { firstUserTurnSince, spawnedDescendantIds } from "./detect.js";
import { REVIEW_CONTINUATION_CAP_MS, type ThreadState } from "./state.js";

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
 * The seq of the first turn of the user's own requested since the review was
 * delivered (or, with no delivery cursor, since this turn's start), or null.
 * The cursor is the one a stop is read against: a turn's request is logged
 * before the `thread.active` that takes `turnStart`, so that alone could miss
 * it. A failed lookup warns and answers null — the latch must never stick on
 * an error.
 */
export async function userTurnSinceDelivery(
  bb: ReviewContext["bb"],
  threadId: string,
  state: ThreadState,
): Promise<number | null> {
  const sinceSeq = state.reviewDeliveredSeq ?? state.turnStart?.sinceSeq;
  if (sinceSeq === undefined) {
    return null;
  }
  try {
    return await firstUserTurnSince(bb, threadId, sinceSeq);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read whether the user started a turn in ${threadId}; ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
