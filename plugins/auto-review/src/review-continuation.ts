import type { GateThreadLike, ReviewContext } from "./context.js";
import {
  endedTurn,
  fetchWorkspace,
  NoTurnCompletedError,
  spawnedDescendantIds,
  turnChangedPaths,
  UnreadTurnError,
  type ApprovedPlan,
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
 * end was found, and absent when no turn had completed. `reviewTurn` marks the
 * review's own turn, by the code-review opening its request carried; the
 * caller records that turn's end as the approval cut-off, once. `approvedPlans`
 * are the plan approvals the turn resolved; the caller sets the ones
 * auto-review gave itself, and the ones at or before the cut-off, aside.
 */
export type HoldTurn =
  | {
      read: true;
      users: boolean;
      completedSeq: number;
      approvedPlans: ApprovedPlan[];
      reviewTurn: boolean;
    }
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
 * The plan approvals of an ended turn that count as the user's own: not one
 * auto-review resolved itself (`state.autoResolvedPlanIds`, written before the
 * resolve it vouches for), and each resolved after the cut-off — the review's
 * own end once that turn was read, its delivery cursor or the pre-send cursor
 * before it. Every approval set aside is logged with its interaction id and
 * seq: the lifecycle event carries no resolver, so the log is the record of
 * why the work under it gets no follow-up review.
 */
function countUserApprovals(
  bb: ReviewContext["bb"],
  threadId: string,
  state: ThreadState,
  approvals: readonly ApprovedPlan[],
  cutOff: number,
): ApprovedPlan[] {
  const auto = state.autoResolvedPlanIds ?? [];
  const counted: ApprovedPlan[] = [];
  for (const approval of approvals) {
    if (!auto.includes(approval.id) && approval.seq > cutOff) {
      counted.push(approval);
      continue;
    }
    bb.log.info(
      `auto-review: the plan approval ${approval.id} at seq ${approval.seq} in thread ${threadId} is set aside (${
        auto.includes(approval.id)
          ? "auto-review resolved it itself"
          : "it was resolved at or before the review's cut-off"
      }), so the work under it is covered by the review itself`,
    );
  }
  return counted;
}

/**
 * What the idle that just ended a turn during the hold adds to the state, for
 * each turn of the user's own that ended: where their work began, whether any
 * of it changed files, and the cursor a stop inside the turn is read against,
 * which is where the turn completed, so a stop pressed in a turn already
 * drained behind it is not swallowed. A turn that could not be read counts as
 * the user's and as authored, with no check, and leaves the floor where it was:
 * a stop in what may have been the review's or a wake-up turn must still end
 * the review. The review's own turn is recognized by the code-review opening
 * its request carried, and its end is recorded once, never moved, as
 * `reviewTurnEndSeq` — the cut-off the plan approvals of every later turn are
 * judged against, and, for that same turn, its own. A later turn that resolved
 * an approval of the user's counts as a turn of theirs as well: it starts the
 * user window and counts as authored without the tree check, because the
 * approved work usually lands later, in wake-up turns of delegated children —
 * and it sets no stop floor, so a stop pressed in a review or wake-up turn
 * still ends the review. Every turn's end is recorded, user's or not, read or
 * not (when it was found), and the turns that ended since the last idle are
 * read oldest first until none is left, so one idle for two completed turns
 * reads both. An idle with nothing new to read, after some turn was handled,
 * is a surplus one and changes nothing.
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
    let byApproval = false;
    if (ended.read) {
      // The approval cut-off: the review turn's end once read — that turn's
      // own for the iteration that reads it — or, until then, the cursor the
      // review was delivered at, the one taken before it was sent, or the
      // hold's turn start. Always defined, and it only moves forward, so an
      // approval set aside now can never be counted later: the rule fails
      // toward more review, never less. Only a turn that was read carries
      // approvals to judge.
      const cutOff =
        held.reviewTurnEndSeq ??
        (ended.reviewTurn ? ended.completedSeq : undefined) ??
        held.reviewDeliveredSeq ??
        held.lastCodeReviewSeq ??
        turnStart.sinceSeq;
      byApproval = countUserApprovals(bb, thread.id, held, ended.approvedPlans, cutOff).length > 0;
    }
    const users = !ended.read || ended.users || byApproval;
    const patch: Partial<ThreadState> = {
      ...(ended.completedSeq === undefined ? {} : { handledTurnEndSeq: ended.completedSeq }),
      ...(held.reviewTurnEndSeq === undefined && ended.read && ended.reviewTurn
        ? { reviewTurnEndSeq: ended.completedSeq }
        : {}),
      ...(users && held.userTurnStart === undefined ? { userTurnStart: turnStart } : {}),
      ...(users &&
      held.userTurnAuthored !== true &&
      (!ended.read || byApproval || (authored ??= await userTurnAuthored(ctx, thread, turnStart)))
        ? { userTurnAuthored: true as const }
        : {}),
      ...(ended.read && ended.users ? { userStopFloorSeq: ended.completedSeq } : {}),
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
