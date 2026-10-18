import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike } from "./context.js";
import {
  captureTree,
  tryCaptureSinceSeq,
  userTurnRunningSince,
  type AvailableWorkspace,
} from "./detect.js";
import { isBusyStatus } from "./gate.js";
import { writeState, type ThreadState, type TurnStart } from "./state.js";

interface LastIdleOptions {
  /** The workspace the caller already fetched; read afresh when absent. */
  workspace?: AvailableWorkspace;
  /**
   * For a snapshot taken while the next turn is already running: anchors the
   * cursor one before the request that started that turn (the latest after this
   * seq that is not a steer) when the turn is the user's, so it counts as new in
   * the gate and its own edits are not absorbed. A turn is the user's when its
   * start request or a steer into it is; otherwise nothing is recorded. The
   * anchor can still absorb the running turn's earliest shell edits, made before
   * the snapshot; that only delays a review, since the cursor is kept.
   */
  userTurnAfter?: number;
}

/** The seq after which the user's turns and the tool edits since the last snapshot or turn start count. */
export function lastIdleFloor(state: ThreadState): number {
  return Math.max(state.turnStart?.sinceSeq ?? 0, state.lastIdle?.sinceSeq ?? 0);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One before the request that started the running turn after `userTurnAfter` when that turn is the user's; null when it is not or cannot be read. */
async function anchoredCursor(
  bb: BbPluginApi,
  threadId: string,
  userTurnAfter: number,
): Promise<number | null> {
  try {
    const seq = await userTurnRunningSince(bb, threadId, userTurnAfter);
    return seq === null ? null : seq - 1;
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read the latest turn request of ${threadId}; the next turn is not checked for new work: ${describe(error)}`,
    );
    return null;
  }
}

async function snapshotNow(
  bb: BbPluginApi,
  thread: GateThreadLike,
  { workspace, userTurnAfter }: LastIdleOptions,
): Promise<TurnStart | undefined> {
  const { environmentId } = thread;
  if (environmentId === null) {
    return undefined;
  }
  const startedAt = Date.now();
  let anchor: number | undefined;
  if (userTurnAfter !== undefined) {
    const cursor = await anchoredCursor(bb, thread.id, userTurnAfter);
    if (cursor === null) {
      return undefined;
    }
    anchor = cursor;
  }
  const [sinceSeq, tree] = await Promise.all([
    anchor ??
      tryCaptureSinceSeq(
        bb,
        thread.id,
        `the idle snapshot of ${thread.id}; the next turn is not checked for new work`,
      ),
    captureTree(bb, environmentId, workspace),
  ]);
  return sinceSeq === undefined || tree === undefined ? undefined : { sinceSeq, startedAt, tree };
}

/**
 * Records the cursor and tree at an idle that kept the turn cursor without
 * firing, so the next idle can tell a turn that brought new work from one that
 * did not. Fails open: a snapshot that cannot be taken removes the record, and
 * the next idle is judged without it.
 */
export async function refreshLastIdle(
  bb: BbPluginApi,
  thread: GateThreadLike,
  options: LastIdleOptions = {},
): Promise<void> {
  const lastIdle = await snapshotNow(bb, thread, options);
  if (lastIdle === undefined) {
    await writeState(bb, thread.id, {}, ["lastIdle"]);
    return;
  }
  await writeState(bb, thread.id, { lastIdle });
}

/**
 * `refreshLastIdle` for a snapshot taken from an idle that does not know
 * whether the next turn is running. A turn that started by then is anchored, so
 * its idle is judged as a turn of its own and not as a park's release. A user
 * request that lands before the thread reports busy is put before the cursor;
 * for a parked turn, that question's idle counts as a release and reviews.
 * Fails open: a status read that fails removes the record.
 */
export async function refreshIdleSnapshot(
  bb: BbPluginApi,
  thread: GateThreadLike,
  state: ThreadState,
  workspace?: AvailableWorkspace,
): Promise<void> {
  let busy: boolean;
  try {
    busy = isBusyStatus((await bb.sdk.threads.get({ threadId: thread.id })).status);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read the status of ${thread.id} for its idle snapshot; the next turn is not checked for new work: ${describe(error)}`,
    );
    await writeState(bb, thread.id, {}, ["lastIdle"]);
    return;
  }
  await refreshLastIdle(bb, thread, {
    ...(workspace === undefined ? {} : { workspace }),
    ...(busy ? { userTurnAfter: lastIdleFloor(state) } : {}),
  });
}
