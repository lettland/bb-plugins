import { recordFire, type GateThreadLike, type ReviewContext } from "./context.js";
import {
  firstUserTurnSince,
  hasUnhashedEntries,
  turnChangedPaths,
  type AvailableWorkspace,
} from "./detect.js";
import { familyClaims } from "./detect-claim.js";
import type { ParkBaseline } from "./detect-upstream.js";
import type { ThreadListEntry } from "./detect-workspace.js";
import { refreshIdleSnapshot } from "./last-idle.js";
import { STALE_PARK_MS, type ThreadState, type TurnStart } from "./state.js";
import { keepCursor } from "./turn-end.js";

/**
 * How a turn that was parked comes to be evaluated: `released` when no user
 * request came after the snapshot taken when it was parked, `unreadable` when
 * that could not be read, and `none` when it was not parked, has no snapshot,
 * or a user's turn re-ran it.
 */
export type ParkRelease = "none" | "released" | "unreadable";

export async function parkRelease(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
): Promise<ParkRelease> {
  const { lastIdle } = state;
  if (state.phase !== "deferred" || lastIdle?.tree === undefined) {
    return "none";
  }
  try {
    return (await firstUserTurnSince(ctx.bb, thread.id, lastIdle.sinceSeq)) === null ? "released" : "none";
  } catch (error) {
    ctx.bb.log.warn(
      `auto-review: could not read whether the user wrote since ${thread.id} was parked; reviewing anyway: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "unreadable";
  }
}

/**
 * The park snapshot a released turn is measured against: only for a provider
 * park (a child-held turn waits on more than a queue), a release the read
 * could vouch for, and a snapshot with a tree and a time. Any doubt, none.
 */
export function parkBaseline(state: ThreadState, release: ParkRelease): ParkBaseline | undefined {
  const { lastIdle, turnStart } = state;
  if (
    release !== "released" ||
    state.heldBy !== undefined ||
    turnStart?.tree === undefined ||
    lastIdle?.tree === undefined ||
    lastIdle.startedAt === undefined
  ) {
    return undefined;
  }
  return { startedAt: lastIdle.startedAt, tree: lastIdle.tree };
}

/**
 * Whether a released provider park waited `STALE_PARK_MS` or more since its
 * last park snapshot and nothing has run on the thread since (`quiet`): its
 * review no longer follows the work. Pure; `now` is the caller's clock.
 */
export function staleRelease(park: ParkBaseline | undefined, quiet: boolean, now: number): boolean {
  return park !== undefined && quiet && now - park.startedAt >= STALE_PARK_MS;
}

interface PushedReleaseInput {
  park: ParkBaseline | undefined;
  quiet: boolean;
  /** The paths the turn changed. */
  turnPaths: readonly string[];
  /** The paths dirty in the working tree now. */
  dirty: readonly string[];
  /** Whether a local merge would run for this turn. */
  merge: boolean;
  /** Whether `origin/<branch>` already holds HEAD. */
  headHeld: boolean;
}

/**
 * Whether a released provider park has nothing left to review: the remote
 * holds HEAD, none of the turn's own paths is dirty again, and no local merge
 * would run. Dirty paths outside the turn do not count.
 */
export function pushedRelease({ park, quiet, turnPaths, dirty, merge, headHeld }: PushedReleaseInput): boolean {
  if (park === undefined || !quiet || merge || !headHeld) {
    return false;
  }
  const dirtySet = new Set(dirty);
  return !turnPaths.some((path) => dirtySet.has(path));
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
 * that changes something; a parked turn's release (`release`, from
 * `parkRelease`, read once) is exempt, an unreadable one included. Never `standDown`:
 * in the `deferred` phase it would reset the turn and drop the carried work.
 */
export async function noNewWork(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  environmentId: string,
  workspace: AvailableWorkspace,
  threadEntries: readonly ThreadListEntry[],
  release: ParkRelease,
): Promise<boolean> {
  const { lastIdle } = state;
  if (lastIdle?.tree === undefined || release !== "none") {
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
