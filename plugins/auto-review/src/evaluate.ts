import {
  effectiveConfig,
  readProjectConfig,
  type FireReason,
} from "./config.js";
import {
  queuedRowExists,
  recordFire,
  type EffectiveConfig,
  type FireExtra,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { decide } from "./decide.js";
import { deferTurn, providerReviewInFlight } from "./deferral.js";
import { removeDeferral } from "./deferrals.js";
import {
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  isBranchCheckout,
  mainlineBase,
  runningChildIds,
  stoppedByUser,
  turnChangedPaths,
  type AvailableWorkspace,
  type TurnChanges,
} from "./detect.js";
import { dispatchReview } from "./dispatch.js";
import { isBusyStatus, selfIsWorktree } from "./gate.js";
import {
  reviewContinuationPending,
  userTurnSinceDelivery,
} from "./review-continuation.js";
import {
  deliveredPatch,
  recordUnfinishedReview,
  userStoppedReview,
} from "./review-outcome.js";
import { removeReview } from "./reviews.js";
import {
  isStale,
  LATCH_KEYS,
  readState,
  resetToIdlePatch,
  REVIEW_IN_FLIGHT_PHASES,
  writeState,
  type ThreadState,
  type TurnStart,
} from "./state.js";

/**
 * End the turn without a review. A turn that had been deferred is unparked
 * here too — otherwise a deferral that later turns out to have nothing to
 * review would latch the thread in `deferred` and freeze its cursor.
 */
async function standDown(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  reason: FireReason,
  extra: FireExtra = {},
): Promise<void> {
  const { bb } = ctx;
  if (state.phase === "deferred") {
    const { set, remove } = resetToIdlePatch();
    await writeState(bb, thread.id, set, remove);
    await removeDeferral(bb, thread.id);
  }
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", reason, extra);
}

/**
 * Whether the user's next turn is already lined up: a message they queued
 * during this turn, or a turn already started because core drained the queue
 * before this idle was handled. Scheduled and failed rows do not count.
 */
async function userTurnQueued(ctx: ReviewContext, threadId: string): Promise<boolean> {
  const { bb } = ctx;
  const now = Date.now();
  const [{ status }, rows] = await Promise.all([
    bb.sdk.threads.get({ threadId }),
    bb.sdk.threads.queuedMessages.list({ threadId }),
  ]);
  return (
    isBusyStatus(status) ||
    rows.some(
      (row) =>
        row.initiator === "user" &&
        row.origin !== "plugin" &&
        row.failureReason === null &&
        (row.sendAt === null || row.sendAt <= now),
    )
  );
}

/**
 * Fold this turn's review into the user's next turn instead of firing it
 * alongside their message. The cursor is kept, so the review that fires once
 * the thread goes idle with nothing of theirs waiting covers every turn since.
 */
async function carryOver(ctx: ReviewContext, thread: GateThreadLike, state: ThreadState): Promise<void> {
  const { bb } = ctx;
  await writeState(bb, thread.id, { phase: "idle" }, [
    "deferredSince",
    "turnDecided",
    "heldBy",
  ]);
  if (state.phase === "deferred") {
    await removeDeferral(bb, thread.id);
  }
  await recordFire(ctx, thread.projectId, thread.id, "deferred", "user-queued");
}

/**
 * The turn's start cursor when this idle may go on to review. A stand-down or a
 * carry-over ends the turn here and yields null.
 */
async function eligibleTurnStart(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  config: EffectiveConfig,
): Promise<TurnStart | null> {
  const { bb } = ctx;
  if (!config.enabled) {
    await standDown(ctx, thread, state, "disabled");
    return null;
  }
  if (state.turnStart === undefined) {
    await standDown(ctx, thread, state, "no-turn-start");
    return null;
  }
  // The user stopped this turn to take over; reviewing and committing
  // half-done work behind their back is the last thing they asked for. A
  // stopped child does not count: an agent stopping its own child records
  // the same `manual-stop` reason as a user would.
  if (await stoppedByUser(bb, thread.id, state.turnStart.sinceSeq)) {
    await standDown(ctx, thread, state, "user-stopped");
    return null;
  }
  if (await userTurnQueued(ctx, thread.id)) {
    await carryOver(ctx, thread, state);
    return null;
  }
  return state.turnStart;
}

async function branchWorkspace(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  environmentId: string,
): Promise<AvailableWorkspace | null> {
  const workspace = await fetchWorkspace(ctx.bb, environmentId);
  if (workspace === null) {
    await standDown(ctx, thread, state, "status-unavailable");
    return null;
  }
  if (!isBranchCheckout(workspace)) {
    await standDown(ctx, thread, state, "not-a-branch");
    return null;
  }
  return workspace;
}

/** Parks the turn behind running children or another thread's review; true when parked. */
async function deferredBehindOthers(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  environmentId: string,
): Promise<boolean> {
  // A spawned child still running will wake this thread when it ends, and
  // that wake-up turn is where the supervisor acts on the child's result —
  // so that turn's idle, not this one, is what should review its work.
  const runningChildren = await runningChildIds(ctx.bb, thread.id);
  if (runningChildren.length > 0) {
    await deferTurn(ctx, thread, state, environmentId, {
      reason: "children-active",
      heldBy: runningChildren,
    });
    return true;
  }

  // Past the children check, only another thread's review in flight parks
  // this turn — two reviews staging, committing and merging in one working
  // tree at once is the one thing to avoid. Threads that are merely
  // running, including this thread's own advisor or non-child subagents,
  // never do.
  if (await providerReviewInFlight(ctx, thread.providerId, thread.id)) {
    await deferTurn(ctx, thread, state, environmentId, { reason: "sibling-active" });
    return true;
  }
  return false;
}

interface ReviewScope {
  turn: TurnChanges;
  scope: string[];
  isWorktree: boolean;
}

/** The turn's changed paths still worth reviewing; null (after standing down) when there are none. */
async function reviewScope(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  turnStart: TurnStart,
  environmentId: string,
  workspace: AvailableWorkspace,
): Promise<ReviewScope | null> {
  const { bb } = ctx;
  const threadEntries = await bb.sdk.threads.list({
    environmentId,
    includeHidden: true,
  });
  const isWorktree = selfIsWorktree(threadEntries, thread.id);

  const turn = await turnChangedPaths(bb, {
    threadId: thread.id,
    environmentId,
    turnStart,
    workspace,
    threadEntries,
  });
  if (turn.paths.length === 0) {
    // Changes none of this thread's family made are not its to review; nothing changed at all is no authorship.
    await (turn.unclaimed.length > 0
      ? standDown(ctx, thread, state, "unclaimed-changes", { unclaimedCount: turn.unclaimed.length })
      : standDown(ctx, thread, state, "no-authorship"));
    return null;
  }
  const scope = computeScope(
    turn.paths,
    dirtyOrAheadPaths(workspace, turn.committedPaths),
  );
  if (scope.length === 0) {
    await standDown(ctx, thread, state, "empty-scope");
    return null;
  }
  return { turn, scope, isWorktree };
}

export async function evaluate(
  ctx: ReviewContext,
  thread: GateThreadLike,
): Promise<void> {
  const { bb } = ctx;
  const state = await readState(bb, thread.id);
  // Three drivers reach this: a thread's own idle, a sibling's idle releasing
  // a deferral, and the expiry sweep. Each decides to call evaluate before
  // taking this thread's lock, so two can decide on the same parked thread
  // and only one wins the lock. Re-check under the lock: a review that is
  // already queued or in flight means the loser has nothing to do. Silent and
  // idempotent — it records no fire, because nothing was decided here.
  if (REVIEW_IN_FLIGHT_PHASES.includes(state.phase)) {
    return;
  }
  // This idle decides the turn; `carryOver` below reopens it when the review
  // is folded into the user's queued next turn.
  if (state.turnDecided !== true) {
    await writeState(bb, thread.id, { turnDecided: true });
  }
  const project = await readProjectConfig(bb, thread.projectId);
  const config = effectiveConfig(ctx.globals, project);

  const turnStart = await eligibleTurnStart(ctx, thread, state, config);
  if (turnStart === null) {
    return;
  }
  const environmentId = thread.environmentId;
  if (environmentId === null) {
    return;
  }

  const workspace = await branchWorkspace(ctx, thread, state, environmentId);
  if (workspace === null) {
    return;
  }
  if (await deferredBehindOthers(ctx, thread, state, environmentId)) {
    return;
  }
  const reviewed = await reviewScope(ctx, thread, state, turnStart, environmentId, workspace);
  if (reviewed === null) {
    return;
  }

  const base = mainlineBase(workspace);
  const decision = decide({
    base,
    currentBranch: workspace.branch.currentBranch,
    isDedicatedWorktree: reviewed.isWorktree,
    mergeEligibleMainlines: config.mergeEligibleMainlines,
  });
  await dispatchReview(ctx, {
    thread,
    state,
    environmentId,
    config,
    decision,
    base,
    ...reviewed,
  });
}

export async function handleIdle(ctx: ReviewContext, thread: GateThreadLike): Promise<void> {
  const { bb } = ctx;
  const state = await readState(bb, thread.id);
  if (state.phase === "awaiting-review") {
    // A review that handed its lens reviews or fixes to child threads ends
    // its own turn while they run. Each child's wake-up turn is the review's
    // continuation, so it stays in flight until none are running or queued —
    // otherwise the turns that apply its fixes would be reviewed again, round
    // after round. The user's own say ends it first: a stop, or a turn of theirs.
    const stopped = await userStoppedReview(bb, thread.id, state);
    const userRequestSeq = stopped ? null : await userTurnSinceDelivery(bb, thread.id, state);
    if (userRequestSeq !== null) {
      await recordUnfinishedReview(bb, thread.id, state, "idle");
      await removeReview(bb, thread.id);
      if (state.turnStart !== undefined && state.turnStart.sinceSeq >= userRequestSeq) {
        // The cursor `onThreadActive` took for the user's turn stays, so the
        // normal path reviews it, parked behind any child still running.
        await writeState(
          bb,
          thread.id,
          { phase: "idle" },
          LATCH_KEYS.filter((key) => key !== "turnStart"),
        );
        await evaluate(ctx, thread);
        return;
      }
      // The cursor is the review's or a wake-up turn's, older than the user's
      // request: the user's turn is queued behind this idle, or was steered
      // into the running turn. Evaluating from that cursor would review the
      // review's own fixes again. Start clean: that turn takes a fresh cursor
      // in `onThreadActive`, and its own idle reviews it. A steered message's
      // edits inside the review or wake-up turn count as part of the review.
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      return;
    }
    if (!stopped && (await reviewContinuationPending(ctx, state, thread.id))) {
      return;
    }
    await recordUnfinishedReview(bb, thread.id, state, "idle");
    const { set, remove } = resetToIdlePatch();
    await writeState(bb, thread.id, set, remove);
    await removeReview(bb, thread.id);
    return;
  }
  if (state.phase === "pending-dispatch") {
    if (isStale(state, Date.now())) {
      if (
        state.pendingEntryId !== undefined &&
        (await queuedRowExists(ctx, thread.id, state.pendingEntryId))
      ) {
        await writeState(bb, thread.id, { dispatchedAt: Date.now() });
        return;
      }
      // The row is gone, so core dispatched it and the review reached the agent.
      await writeState(
        bb,
        thread.id,
        { phase: "awaiting-review", ...(await deliveredPatch(bb, thread.id)) },
        ["pendingEntryId"],
      );
    }
    return;
  }
  await evaluate(ctx, thread);
}
