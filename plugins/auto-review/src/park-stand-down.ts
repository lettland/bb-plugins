import type { GateThreadLike, ReviewContext } from "./context.js";
import { branchHeadPushed, mainlineBase, quietSincePark, type TurnChanges } from "./detect.js";
import type { ParkBaseline } from "./detect-upstream.js";
import { headShaOf, type AvailableWorkspace } from "./detect-workspace.js";
import { pushedRelease, staleRelease } from "./no-new-work.js";
import type { ThreadState } from "./state.js";
import { standDown } from "./turn-end.js";

/** The most skipped commits a stale-park warning names. */
const WARNED_COMMITS = 5;

interface ParkStandDownInput {
  environmentId: string;
  workspace: AvailableWorkspace;
  turn: TurnChanges;
  scope: string[];
  merge: boolean;
  park: ParkBaseline | undefined;
}

/**
 * Stands a released provider park down when nothing ran on the thread since it
 * was parked (read here, after the scope is known) and its review no longer
 * follows the work: it waited too long (`stale-park`), or the remote already
 * holds HEAD, none of the turn's own paths is dirty again and no local merge
 * would run (`already-pushed`). Any other turn reads nothing. True when it
 * stood the turn down.
 */
export async function parkStandDown(
  ctx: ReviewContext,
  thread: GateThreadLike,
  state: ThreadState,
  { environmentId, workspace, turn, scope, merge, park }: ParkStandDownInput,
): Promise<boolean> {
  const { bb } = ctx;
  const { lastIdle } = state;
  if (park === undefined || lastIdle === undefined || !(await quietSincePark(bb, thread.id, lastIdle.sinceSeq))) {
    return false;
  }
  const skipped = { skippedCommits: turn.commits, scopePaths: scope };
  const now = Date.now();
  if (staleRelease(park, now)) {
    const shas = turn.commits.slice(0, WARNED_COMMITS).map((sha) => sha.slice(0, 7)).join(", ");
    // The turn's commits lose their review and pre-push secret scan, hence a warning.
    bb.log.warn(
      `auto-review: standing ${thread.id} down as stale-park after ${Math.round((now - park.startedAt) / 60_000)} min` +
        (turn.commits.length === 0 ? "" : `; ${turn.commits.length} commit(s) not reviewed or secret-scanned: ${shas}`) +
        (merge ? `; merge into ${mainlineBase(workspace)} skipped` : ""),
    );
    await standDown(ctx, thread, state, "stale-park", { ...skipped, merge });
    return true;
  }
  const branch = workspace.branch.currentBranch;
  const head = headShaOf(workspace);
  if (merge || branch === null || head === null) {
    return false;
  }
  const dirty = await branchHeadPushed(bb, environmentId, branch, head);
  if (dirty === null || !pushedRelease(turn.paths, dirty)) {
    return false;
  }
  bb.log.info(`auto-review: standing ${thread.id} down as already-pushed; ${head} is on the remote branch`);
  await standDown(ctx, thread, state, "already-pushed", skipped);
  return true;
}
