import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GateThreadLike } from "./context.js";
import {
  captureTree,
  lastUserTurnSince,
  tryCaptureSinceSeq,
  type AvailableWorkspace,
} from "./detect.js";
import { isBusyStatus } from "./gate.js";
import { writeState, type ThreadState, type TurnStart } from "./state.js";

interface LastIdleOptions {
  /** The workspace the caller already fetched; read afresh when absent. */
  workspace?: AvailableWorkspace;
  /**
   * For a snapshot taken while the user's next turn is already running: anchors
   * the cursor one before the latest user turn request after this seq, so that
   * turn counts as new in the gate and its own edits are not absorbed. No such
   * request means the running turn is not the user's, and nothing is recorded.
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

/** One before the user's latest turn request after `userTurnAfter`; null when there is none or it cannot be read. */
async function anchoredCursor(
  bb: BbPluginApi,
  threadId: string,
  userTurnAfter: number,
): Promise<number | null> {
  try {
    const seq = await lastUserTurnSince(bb, threadId, userTurnAfter);
    return seq === null ? null : seq - 1;
  } catch (error) {
    bb.log.warn(
      `auto-review: could not read the user's latest turn request of ${threadId}; the next turn is not checked for new work: ${describe(error)}`,
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
 * `refreshLastIdle` for a turn parked behind others. A turn that started while
 * the park was being decided (a reply of the user's landing in that gap) is
 * anchored, so its idle is judged as a turn of its own and not as the park's
 * release.
 */
export async function refreshParkedIdle(
  bb: BbPluginApi,
  thread: GateThreadLike,
  state: ThreadState,
  workspace?: AvailableWorkspace,
): Promise<void> {
  const { status } = await bb.sdk.threads.get({ threadId: thread.id });
  await refreshLastIdle(bb, thread, {
    ...(workspace === undefined ? {} : { workspace }),
    ...(isBusyStatus(status) ? { userTurnAfter: lastIdleFloor(state) } : {}),
  });
}
