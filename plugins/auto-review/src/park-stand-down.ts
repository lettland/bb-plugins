import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { GateThreadLike, ReviewContext } from "./context.js";
import { branchHeadPushed, quietSincePark } from "./detect.js";
import type { ParkBaseline } from "./detect-upstream.js";
import { headShaOf, type AvailableWorkspace } from "./detect-workspace.js";
import { pushedRelease, staleRelease } from "./no-new-work.js";
import type { ThreadState } from "./state.js";
import { standDown } from "./turn-end.js";

/** Whether no turn of any kind ran since a released provider park; false for any other turn, without a read. */
export async function quietPark(
  bb: BbPluginApi,
  threadId: string,
  state: ThreadState,
  park: ParkBaseline | undefined,
): Promise<boolean> {
  const { lastIdle } = state;
  return park !== undefined && lastIdle !== undefined && (await quietSincePark(bb, threadId, lastIdle.sinceSeq));
}

/** Stands a quiet released provider park down once it waited too long; true when it did. */
export async function staleStandDown(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  park: ParkBaseline | undefined,
  quiet: boolean,
): Promise<boolean> {
  const now = Date.now();
  if (park === undefined || !staleRelease(park, quiet, now)) {
    return false;
  }
  // The turn's commits lose their review and pre-push secret scan, hence a warning.
  ctx.bb.log.warn(
    `auto-review: standing ${thread.id} down as stale-park; it waited ${Math.round((now - park.startedAt) / 60_000)} min since it was parked`,
  );
  await standDown(ctx, thread, state, "stale-park");
  return true;
}

interface PushedInput {
  environmentId: string;
  workspace: AvailableWorkspace;
  turnPaths: readonly string[];
  merge: boolean;
  park: ParkBaseline | undefined;
  quiet: boolean;
}

/**
 * Stands a quiet released provider park down when its work is already on the
 * remote: HEAD is held by `origin/<branch>`, none of the turn's own paths is
 * dirty again, and no local merge would run. True when it did.
 */
export async function pushedStandDown(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  { environmentId, workspace, turnPaths, merge, park, quiet }: PushedInput,
): Promise<boolean> {
  const { bb } = ctx;
  const branch = workspace.branch.currentBranch;
  const head = headShaOf(workspace);
  const pushed =
    park !== undefined && quiet && branch !== null && head !== null && (await branchHeadPushed(bb, environmentId, branch, head));
  if (
    head === null ||
    !pushedRelease({
      park,
      quiet,
      turnPaths,
      dirty: workspace.workingTree.files.map((file) => file.path),
      merge,
      headHeld: pushed,
    })
  ) {
    return false;
  }
  bb.log.info(`auto-review: standing ${thread.id} down as already-pushed; ${head} is on the remote branch`);
  await standDown(ctx, thread, state, "already-pushed");
  return true;
}
