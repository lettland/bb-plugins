import type { GateThreadLike, ReviewContext } from "./context.js";
import {
  endedTurn,
  fetchWorkspace,
  NoTurnCompletedError,
  spawnedDescendantIds,
  turnChangedPaths,
  UnreadTurnError,
} from "./detect.js";
import { REVIEW_CONTINUATION_CAP_MS, writeState, type ThreadState, type TurnStart } from "./state.js";

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
 * What a hold idle knows of the turn that has just ended. `read` is false when
 * the turn could not be read; `completedSeq` is then still set when the turn's
 * end was found, and absent when no turn had completed.
 */
export type HoldTurn =
  | { read: true; users: boolean; completedSeq: number }
  | { read: false; completedSeq: number | undefined };

/**
 * The next turn to end during the hold and whether it was the user's, read from
 * the requests that started it (see `endedTurn`). The cursor is the one taken
 * before the review was sent where there is one, so the review's own turn is
 * read like any other. A turn that cannot be read comes back unread, and the
 * caller counts it as the user's: a follow-up review that finds nothing costs
 * less than an edit nobody reviewed. When no turn has ended since the last one
 * handled, the answer is null if `required` is false (the caller was only
 * catching up), and an unread turn, with a warning, if it is true.
 */
export async function readEndedTurn(
  bb: ReviewContext["bb"],
  threadId: string,
  state: ThreadState,
  turnStart: TurnStart,
  required: boolean,
): Promise<HoldTurn | null> {
  const sinceSeq = state.lastCodeReviewSeq ?? state.reviewDeliveredSeq ?? turnStart.sinceSeq;
  try {
    return { read: true, ...(await endedTurn(bb, threadId, sinceSeq, state.handledTurnEndSeq)) };
  } catch (error) {
    if (error instanceof NoTurnCompletedError && !required) {
      return null;
    }
    bb.log.warn(
      `auto-review: could not read whether the turn that ended in ${threadId} was the user's; counting it as theirs: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { read: false, completedSeq: error instanceof UnreadTurnError ? error.completedSeq : undefined };
  }
}

/**
 * Whether a turn of the user's own during the hold changed files, by the same
 * attribution a review uses. A check that cannot be made warns and counts as
 * authored: the follow-up review stands down on its own when nothing changed.
 */
async function userTurnAuthored(
  ctx: ReviewContext,
  thread: GateThreadLike,
  turnStart: TurnStart,
): Promise<boolean> {
  const { bb } = ctx;
  try {
    const { environmentId } = thread;
    const workspace = environmentId === null ? null : await fetchWorkspace(bb, environmentId);
    if (environmentId === null || workspace === null) {
      throw new Error("the workspace is unavailable");
    }
    const threadEntries = await bb.sdk.threads.list({ environmentId, includeHidden: true });
    const turn = await turnChangedPaths(bb, {
      threadId: thread.id,
      environmentId,
      turnStart,
      workspace,
      threadEntries,
    });
    return turn.paths.length > 0;
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read whether the user's turn in ${thread.id} changed files; counting it as authored: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

/**
 * What the idle that just ended a turn during the hold adds to the state, for
 * each turn of the user's own that ended: where their work began, whether any
 * of it changed files, and the cursor a stop inside the turn is read against,
 * which is where the turn completed, so a stop pressed in a turn already
 * drained behind it is not swallowed. A turn that could not be read counts as
 * the user's and as authored, with no check, and leaves the floor where it was:
 * a stop in what may have been the review's or a wake-up turn must still end
 * the review. Every turn's end is recorded, user's or not, read or not (when it
 * was found), and the turns that ended since the last idle are read oldest
 * first until none is left, so one idle for two completed turns reads both. An
 * idle with nothing new to read, after some turn was handled, is a surplus one
 * and changes nothing.
 * Written before the stop check; the returned state includes it.
 */
export async function noteUserTurn(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
): Promise<ThreadState> {
  const { bb } = ctx;
  const { turnStart } = state;
  if (turnStart === undefined) {
    return state;
  }
  let held = state;
  // Every check measures the same turnStart-to-now window, so one answer serves the whole idle.
  let authored: boolean | undefined;
  for (let first = true; ; first = false) {
    // Core logs a turn's `turn/completed` before it delivers that turn's `thread.idle`, so once a
    // turn was handled, an idle with nothing new to read is a surplus one, not a gap in the log.
    const ended = await readEndedTurn(bb, thread.id, held, turnStart, first && held.handledTurnEndSeq === undefined);
    if (ended === null) {
      break;
    }
    const users = !ended.read || ended.users;
    const patch: Partial<ThreadState> = {
      ...(ended.completedSeq === undefined ? {} : { handledTurnEndSeq: ended.completedSeq }),
      ...(users && held.userTurnStart === undefined ? { userTurnStart: turnStart } : {}),
      ...(users &&
      held.userTurnAuthored !== true &&
      (!ended.read || (authored ??= await userTurnAuthored(ctx, thread, turnStart)))
        ? { userTurnAuthored: true as const }
        : {}),
      ...(users && ended.read ? { userStopFloorSeq: ended.completedSeq } : {}),
    };
    await writeState(bb, thread.id, patch);
    held = { ...held, ...patch };
    // Each read starts after the end just handled, so it moves on; with no end found it cannot.
    if (ended.completedSeq === undefined) {
      break;
    }
  }
  return held;
}
