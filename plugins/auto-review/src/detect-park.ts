/**
 * Leaves out of a released turn what changed while it waited in the review
 * queue. A parked turn's idle snapshot (`lastIdle`) is the baseline: what the
 * live tree shows beyond it, and that the turn had not touched before, was not
 * made by the turn. Any doubt keeps the work with the turn.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { examples } from "./detect-attribute.js";

import { shellText, walkRows } from "./detect-rows.js";
import { mayDetach } from "./detect-shell.js";

import { FAMILY_LOOKBACK_MS, kinEvidence, ownWindows, rowsSince } from "./detect-timeline.js";

import { changedFiles, fingerprintsMatch } from "./detect-tree.js";

import type { TreeChanges, TurnChangeInput, UpstreamInput } from "./detect-upstream.js";
import { withoutCommits } from "./detect-upstream.js";

import { headShaOf } from "./detect-workspace.js";
import type { AvailableWorkspace, TimelineRow } from "./detect-workspace.js";

/** What was left out of a turn as made while it was parked. */
export interface ParkedOut {
  tree: TreeChanges;
  commits: string[];
  paths: string[];
}

/**
 * The commits made after the park head, or why the checkout cannot be trusted
 * to descend from it: an amend, a rebase or a reset leaves another head, and
 * the status answer is trusted only when it is for that head, whole, and read
 * at the checkout's head.
 */
async function commitsAfterPark(
  bb: BbPluginApi,
  input: TurnChangeInput,
  parkHead: string | null,
): Promise<Set<string> | string> {
  const head = headShaOf(input.workspace);
  if (parkHead === null || head === null) {
    return "the park snapshot or the checkout has no head commit";
  }
  if (head === parkHead) {
    return new Set();
  }
  let mergeBase: AvailableWorkspace["mergeBase"] = null;
  let answeredAt: string | null = null;
  try {
    const status = await bb.sdk.environments.status({
      environmentId: input.environmentId,
      mergeBaseBranch: parkHead,
    });
    if (status.outcome === "available") {
      mergeBase = status.workspace.mergeBase;
      answeredAt = headShaOf(status.workspace);
    }
  } catch {
    return "the status call failed";
  }
  if (mergeBase === null) {
    return "no answer to compare the park head against";
  }
  if (mergeBase.mergeBaseBranch !== parkHead || mergeBase.baseRef !== parkHead) {
    return "the checkout does not descend from the park head";
  }
  if (answeredAt !== head) {
    return "the checkout moved while the park head was checked";
  }
  if (mergeBase.aheadCount !== mergeBase.commits.length) {
    return "the list of commits after the park is incomplete";
  }
  return new Set(mergeBase.commits.map(({ sha }) => sha));
}

/** Whether rows ran something that may keep writing after it returned: shell that detaches, or a background delegation. */
function detachesWork(rows: readonly TimelineRow[]): boolean {
  for (const row of walkRows(rows)) {
    if (row.kind !== "work") {
      continue;
    }
    const text = shellText(row);
    if ((row.workKind === "delegation" && row.background) || (text !== null && mayDetach(text))) {
      return true;
    }
  }
  return false;
}

/**
 * The paths the family's kin changed through their tools since the turn start
 * when neither the thread nor its kin did anything since the park, or why they
 * cannot be told to have been quiet: a row that began before the park may
 * still run, and detached work may still write. The thread's own rows are paged
 * by time, back past the turn start, so a row opened in an earlier turn that is
 * still open is seen.
 */
async function quietKinPaths(
  context: Omit<UpstreamInput, "startedAt" | "commits">,
  parkedAt: number,
  startedAt: number,
): Promise<Set<string> | string> {
  const { bb, input, now } = context;
  const rows = await rowsSince(bb, input.threadId, startedAt - FAMILY_LOOKBACK_MS);
  if (typeof rows === "string") {
    return rows;
  }
  const kin = await kinEvidence(bb, input.threadEntries, input.threadId, startedAt, now);
  if (!kin.complete) {
    return "a related thread could not be read in full";
  }
  if ([rows, ...kin.threads].some(detachesWork)) {
    return "the thread's family ran work that may have kept writing after it returned";
  }
  if (ownWindows(rows, parkedAt, now).length > 0 || kin.windows.some(({ end }) => end >= parkedAt)) {
    return "the thread's family was active since the park";
  }
  return kin.paths;
}

/** Whether a path's fingerprint differs between two snapshots; a side with no content hash cannot rule it out. */
function fingerprintsDiffer(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined) {
    return before !== after;
  }
  return before.endsWith("|") || after.endsWith("|") || !fingerprintsMatch(before, after);
}

/**
 * `fetched` without the changes made after the park: commits that arrived
 * while the turn waited, and uncommitted paths that changed since the park
 * snapshot, when the turn had not touched them before it. A path or commit the
 * turn touched before the park stays, whoever changed it again. Nothing is
 * left out unless this is a release no user request interrupted, the checkout
 * descends from the park head, the commit list is whole, and the thread and its
 * kin are known to have done nothing since the park and left no work running.
 */
export async function withoutParked(
  context: Omit<UpstreamInput, "startedAt" | "commits">,
  fetched: TreeChanges,
): Promise<ParkedOut> {
  const { bb, input, ownRows, ownPaths } = context;
  const { park, turnStart } = input;
  const none = { tree: fetched, commits: [], paths: [] };
  if (
    park === undefined ||
    turnStart.tree === undefined ||
    turnStart.startedAt === undefined ||
    (fetched.uncommittedPaths.length === 0 && fetched.commitChanges.length === 0)
  ) {
    return none;
  }
  const skip = (reason: string) => {
    bb.log.info(`auto-review: not leaving out what changed while the turn was parked: ${reason}`);
    return none;
  };
  if (fetched.capped === true || ownRows.truncated) {
    return skip("the turn's commits or timeline may be incomplete");
  }
  const after = await commitsAfterPark(bb, input, park.tree.headSha);
  if (typeof after === "string") {
    return skip(after);
  }
  const kinPaths = await quietKinPaths(context, park.startedAt, turnStart.startedAt);
  if (typeof kinPaths === "string") {
    return skip(kinPaths);
  }
  const arrived = fetched.commitChanges.filter(({ sha }) => after.has(sha));
  const touched = new Set([...ownPaths, ...kinPaths]);
  for (const { sha, paths } of fetched.commitChanges) {
    if (after.has(sha)) {
      continue;
    }
    if (paths === null) {
      return skip("a commit made before the park has paths that could not be read");
    }
    paths.forEach((path) => touched.add(path));
  }
  const touchedBefore = (path: string) =>
    touched.has(path) || fingerprintsDiffer(turnStart.tree?.files[path], park.tree.files[path]);
  const sincePark = await changedFiles(bb, input.environmentId, park.tree, input.workspace);
  const leftOut = new Set(
    fetched.uncommittedPaths.filter((path) => sincePark.has(path) && !touchedBefore(path)),
  );
  const droppedCommits = new Set(
    arrived.flatMap(({ sha, paths }) => (paths !== null && !paths.some(touchedBefore) ? [sha] : [])),
  );
  const tree = withoutCommits(
    { ...fetched, uncommittedPaths: fetched.uncommittedPaths.filter((path) => !leftOut.has(path)) },
    droppedCommits,
  );
  const paths = fetched.paths.filter((path) => !tree.paths.includes(path));
  const commits = [...droppedCommits];
  if (paths.length > 0 || commits.length > 0) {
    bb.log.info(
      `auto-review: left out of the turn what changed while it was parked since ${new Date(park.startedAt).toISOString()}: commits [${commits.join(", ")}]; paths [${examples(paths)}]`,
    );
  }
  return { tree, commits, paths };
}

/** The most example paths a fire record keeps of those left out. */
const FIRE_EXAMPLES = 5;

/** What a fire records of the changes left out as made while the turn waited; nothing when none were. */
export function parkedFire(turn: { parkedPaths: readonly string[]; parkedCommits: readonly string[] }): {
  parkedCount?: number;
  parkedCommits?: string[];
  parkedPaths?: string[];
} {
  const { parkedPaths, parkedCommits } = turn;
  return parkedPaths.length === 0 && parkedCommits.length === 0
    ? {}
    : { parkedCount: parkedPaths.length, parkedCommits: [...parkedCommits], parkedPaths: parkedPaths.slice(0, FIRE_EXAMPLES) };
}
