import { recordFire, type GateThreadLike, type ReviewContext } from "./context.js";
import {
  firstUserTurnSince,
  hasUnhashedEntries,
  turnChangedPaths,
  type AvailableWorkspace,
} from "./detect.js";
import { familyClaims } from "./detect-claim.js";
import type { ThreadListEntry } from "./detect-workspace.js";
import { refreshIdleSnapshot } from "./last-idle.js";
import type { ThreadState, TurnStart } from "./state.js";
import { keepCursor } from "./turn-end.js";

/**
 * Whether a parked turn is being released rather than re-run by a user turn:
 * no user request came after the snapshot taken when it was parked. A failed
 * lookup counts as a release, so the gate is skipped and the turn reviews.
 */
async function releasedFromPark(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  lastIdle: TurnStart,
): Promise<boolean> {
  if (state.phase !== "deferred") {
    return false;
  }
  try {
    return (await firstUserTurnSince(ctx.bb, thread.id, lastIdle.sinceSeq)) === null;
  } catch (error) {
    ctx.bb.log.warn(
      `auto-review: could not read whether the user wrote since ${thread.id} was parked; reviewing anyway: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return true;
  }
}

/**
 * Whether the family ran anything since `startedAt` that could have written a
 * file without a `file-change` row, or its evidence cannot be read in full.
 * Any doubt says yes.
 */
async function familyMayHaveWritten(
  ctx: ReviewContext,
  thread: GateThreadLike,
  startedAt: number,
  threadEntries: readonly ThreadListEntry[],
): Promise<boolean> {
  const read = await familyClaims({
    bb: ctx.bb,
    threadId: thread.id,
    threadEntries,
    startedAt,
    now: Date.now(),
    ownRowsTruncated: false,
    kin: undefined,
  });
  if ("reason" in read) {
    return true;
  }
  const { opaque, writes, scratch, tools, history } = read.claims;
  return opaque !== undefined || writes.length > 0 || scratch.length > 0 || tools.length > 0 || history;
}

/**
 * Whether a shell edit could hide from a snapshot that did not hash every
 * file: a same-size edit to a file with no hash reads as no change, and only
 * something the family ran since the snapshot can have made it. A snapshot that
 * hashed every file has no such edit.
 */
async function hiddenShellEdit(
  ctx: ReviewContext,
  thread: GateThreadLike,
  lastIdle: TurnStart,
  threadEntries: readonly ThreadListEntry[],
): Promise<boolean> {
  if (lastIdle.tree === undefined || !hasUnhashedEntries(lastIdle.tree)) {
    return false;
  }
  const hidden =
    lastIdle.startedAt === undefined ||
    (await familyMayHaveWritten(ctx, thread, lastIdle.startedAt, threadEntries));
  if (hidden) {
    ctx.bb.log.info(
      `auto-review: the carried snapshot of ${thread.id} could not rule out a hidden edit to a file it did not hash; not standing down as no-new-work`,
    );
  }
  return hidden;
}

/**
 * A review fires only at the end of work: a turn that added nothing to the
 * carried cursor since the last idle that kept it (a question, a reply to a
 * steer, a status check) never fires. The carried work waits for the next turn
 * that changes something; a parked turn's release is exempt. Never `standDown`:
 * in the `deferred` phase it would reset the turn and drop the carried work.
 */
export async function noNewWork(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  environmentId: string,
  workspace: AvailableWorkspace,
  threadEntries: readonly ThreadListEntry[],
): Promise<boolean> {
  const { lastIdle } = state;
  if (lastIdle?.tree === undefined || (await releasedFromPark(ctx, thread, state, lastIdle))) {
    return false;
  }
  const turn = await turnChangedPaths(ctx.bb, {
    threadId: thread.id,
    environmentId,
    turnStart: lastIdle,
    workspace,
    threadEntries,
  });
  if (turn.paths.length > 0 || (await hiddenShellEdit(ctx, thread, lastIdle, threadEntries))) {
    return false;
  }
  await keepCursor(ctx, thread, state);
  await refreshIdleSnapshot(ctx.bb, thread, state, workspace);
  await recordFire(ctx, thread.projectId, thread.id, "stood-down", "no-new-work");
  return true;
}
