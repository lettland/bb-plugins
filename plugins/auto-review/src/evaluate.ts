import { effectiveConfig, readProjectConfig } from "./config.js";
import {
  queuedRowExists,
  recordFire,
  type EffectiveConfig,
  type GateThreadLike,
  type ReviewContext,
} from "./context.js";
import { decide } from "./decide.js";
import { deferTurn, providerReviewInFlight } from "./deferral.js";
import {
  computeScope,
  dirtyOrAheadPaths,
  fetchWorkspace,
  firstUserTurnSince,
  isBranchCheckout,
  mainlineBase,
  runningChildIds,
  stoppedByUser,
  turnChangedPaths,
  userTurnRunningSince,
  type AvailableWorkspace,
  type TurnChanges,
} from "./detect.js";
import { parkedFire } from "./detect-park.js";
import type { ParkBaseline } from "./detect-upstream.js";
import type { ThreadListEntry } from "./detect-workspace.js";
import { dispatchReview } from "./dispatch.js";
import { isBusyStatus, selfIsWorktree } from "./gate.js";
import { lastIdleFloor, refreshIdleSnapshot, refreshLastIdle } from "./last-idle.js";
import { noNewWork, parkBaseline, parkRelease } from "./no-new-work.js";
import {
  noteUserTurn,
  reviewContinuationPending,
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
import { parkStandDown } from "./park-stand-down.js";
import { keepCursor, standDown } from "./turn-end.js";

/**
 * Whether the user's next turn is already lined up: a message they queued
 * during this turn, or a turn already started because core drained the queue
 * before this idle was handled (`busy`). Scheduled and failed rows do not count.
 */
async function userTurnQueued(
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
async function userTurnRunning(
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

/**
 * Fold this turn's review into the user's next turn instead of firing it
 * alongside their message. The cursor is kept, so the review that fires once
 * that turn, or a later one, changes something covers every turn since. When
 * the user's turn is already running (`busy`), the snapshot is anchored on its
 * request, so its own edits still count as new.
 */
async function carryOver(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  busy: boolean,
): Promise<void> {
  await keepCursor(ctx, thread, state);
  await refreshLastIdle(
    ctx.bb,
    thread,
    busy ? { userTurnAfter: lastIdleFloor(state) } : {},
  );
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
  // Any running turn carries here; the re-check before dispatch in
  // evaluate() carries a running turn only when it is the user's.
  const { busy, queued } = await userTurnQueued(ctx, thread.id);
  if (queued) {
    await carryOver(ctx, thread, state, busy);
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
  workspace: AvailableWorkspace,
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
    await refreshIdleSnapshot(ctx.bb, thread, state, workspace);
    return true;
  }

  // Past the children check, only another thread's review in flight parks
  // this turn — two reviews staging, committing and merging in one working
  // tree at once is the one thing to avoid. Threads that are merely
  // running, including this thread's own advisor or non-child subagents,
  // never do.
  if (await providerReviewInFlight(ctx, thread.providerId, thread.id)) {
    await deferTurn(ctx, thread, state, environmentId, { reason: "sibling-active" });
    // Read afresh, after the snapshot's start time: a write must not fall between the tree read and the quiet window `withoutParked` measures.
    await refreshIdleSnapshot(ctx.bb, thread, state);
    return true;
  }
  return false;
}

/**
 * One code review per user message: once a review was sent, only a turn the user
 * started earns another. Wake-ups and tasks other threads tell this one (child or
 * background-task completions, the review's own fix commits) never do. The cursor
 * and turn stay open, so their work is carried into the review the next user
 * message earns. A failed lookup reviews as before.
 */
async function alreadyReviewed(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  workspace: AvailableWorkspace,
): Promise<boolean> {
  const { bb } = ctx;
  if (state.lastCodeReviewSeq === undefined) {
    return false;
  }
  try {
    if ((await firstUserTurnSince(bb, thread.id, state.lastCodeReviewSeq)) !== null) {
      return false;
    }
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read whether the user wrote since the last review of ${thread.id}; reviewing anyway: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  await keepCursor(ctx, thread, state);
  await refreshIdleSnapshot(bb, thread, state, workspace);
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", "already-reviewed");
  return true;
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
  threadEntries: readonly ThreadListEntry[],
  park: ParkBaseline | undefined,
): Promise<ReviewScope | null> {
  const { bb } = ctx;
  const isWorktree = selfIsWorktree(threadEntries, thread.id);

  const turn = await turnChangedPaths(bb, {
    threadId: thread.id,
    environmentId,
    turnStart,
    workspace,
    threadEntries,
    ...(park === undefined ? {} : { park }),
  });
  if (turn.paths.length === 0) {
    // What changed while the turn waited, and changes none of this thread's family made, are not its to review; nothing changed at all is no authorship.
    const parked = turn.parkedPaths.length > 0 || turn.parkedCommits.length > 0;
    const reason = parked ? "changed-while-parked" : turn.unclaimed.length > 0 ? "unclaimed-changes" : "no-authorship";
    await standDown(ctx, thread, state, reason, {
      ...parkedFire(turn),
      ...(turn.unclaimed.length === 0 ? {} : { unclaimedCount: turn.unclaimed.length }),
    });
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
  if (await alreadyReviewed(ctx, thread, state, workspace)) {
    return;
  }
  if (await deferredBehindOthers(ctx, thread, state, environmentId, workspace)) {
    return;
  }
  const threadEntries = await bb.sdk.threads.list({
    environmentId,
    includeHidden: true,
  });
  const release = await parkRelease(ctx, thread, state);
  const park = parkBaseline(state, release);
  if (await noNewWork(ctx, thread, state, environmentId, workspace, threadEntries, release)) {
    return;
  }
  const reviewed = await reviewScope(ctx, thread, state, turnStart, environmentId, workspace, threadEntries, park);
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
  if (
    await parkStandDown(ctx, thread, state, {
      environmentId,
      workspace,
      turn: reviewed.turn,
      scope: reviewed.scope,
      merge: decision.merge,
      park,
    })
  ) {
    return;
  }
  // Detection can take minutes; a user turn that started or was queued
  // meanwhile still carries the review, as at the start of the idle. A
  // wake-up that started meanwhile carries only what the user queued
  // behind it; with none of theirs, it dispatches as before. A message
  // sent after this check, while dispatchReview prepares the send, can
  // still land beside the review.
  const { busy, userQueued } = await userTurnQueued(ctx, thread.id);
  if (userQueued || (busy && (await userTurnRunning(ctx, thread.id, lastIdleFloor(state))))) {
    await carryOver(ctx, thread, state, busy);
    return;
  }
  await dispatchReview(ctx, {
    thread,
    state,
    environmentId,
    config,
    decision,
    base,
    ...reviewed,
    ...(reviewed.turn.unclaimed.length === 0 ? {} : { unclaimedCount: reviewed.turn.unclaimed.length }),
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
    // after round. A turn of the user's own does not end it: the user can keep
    // working while the reviewers run, and what they changed is reviewed on
    // its own once the hold ends. Only a stop that was not inside such a turn
    // ends it first.
    const held = await noteUserTurn(ctx, thread, state);
    const stopped = await userStoppedReview(bb, thread.id, held);
    if (!stopped && (await reviewContinuationPending(ctx, held, thread.id))) {
      return;
    }
    await recordUnfinishedReview(bb, thread.id, held, "idle");
    await removeReview(bb, thread.id);
    if (stopped || held.userTurnStart === undefined || held.userTurnAuthored !== true) {
      const { set, remove } = resetToIdlePatch();
      await writeState(bb, thread.id, set, remove);
      if (stopped && held.userTurnAuthored === true) {
        // The review was stopped: the user's own work is not reviewed on its own either, and stays as it is.
        await recordFire(ctx, thread.projectId, thread.id, "stood-down", "user-stopped");
      }
      return;
    }
    // The user's own turns changed files: review them from the first one's
    // cursor, parked behind any child still running. A stop pressed inside
    // one of those turns still suppresses it (`eligibleTurnStart`), as it
    // does for any stopped turn.
    await writeState(
      bb,
      thread.id,
      { phase: "idle", turnStart: held.userTurnStart },
      LATCH_KEYS.filter((key) => key !== "turnStart"),
    );
    await evaluate(ctx, thread);
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
