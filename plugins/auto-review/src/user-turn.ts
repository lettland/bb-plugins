/**
 * Whether a user turn is queued or running: the checks that carry a review
 * into the user's next turn.
 */
import type { ReviewContext } from "./context.js";
import { userTurnRunningSince } from "./detect.js";
import { isBusyStatus } from "./gate.js";

/**
 * Whether the user's next turn is already lined up: a message they queued
 * during this turn, or a turn already started because core drained the queue
 * before this idle was handled (`busy`). Scheduled and failed rows do not count.
 */
export async function userTurnQueued(
  ctx: ReviewContext,
  threadId: string,
): Promise<{ busy: boolean; queued: boolean; userQueued: boolean }> {
  const { bb } = ctx;
  const now = Date.now();
  const [{ status }, rows] = await Promise.all([
    bb.sdk.threads.get({ threadId }),
    bb.sdk.threads.queuedMessages.list({ threadId }),
  ]);
  const busy = isBusyStatus(status);
  const userQueued = rows.some(
    (row) =>
      row.initiator === "user" &&
      row.origin !== "plugin" &&
      row.failureReason === null &&
      (row.sendAt === null || row.sendAt <= now),
  );
  return { busy, queued: busy || userQueued, userQueued };
}

/**
 * Whether the turn running now is the user's, read from the requests after
 * `sinceSeq`. True when the read fails: the thread is busy, so the review is
 * carried rather than sent into a turn that may be the user's.
 */
export async function userTurnRunning(
  ctx: ReviewContext,
  threadId: string,
  sinceSeq: number,
): Promise<boolean> {
  try {
    return (await userTurnRunningSince(ctx.bb, threadId, sinceSeq)) !== null;
  } catch (error) {
    ctx.bb.log.warn(
      `auto-review: could not read whether the running turn of ${threadId} is the user's; carrying the review: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}
