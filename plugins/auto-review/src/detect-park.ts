/**
 * Leaves out of a released turn what changed while it waited in the review
 * queue. A parked turn's idle snapshot (`lastIdle`) is the baseline: what the
 * live tree shows beyond it, and that the turn had not touched before, was not
 * made by the turn. Any doubt keeps the work with the turn.
 *
 * Known race: the checks that the thread and its kin were quiet read their
 * timelines twice, once before and once after the file contents are hashed, but
 * a row the host has not yet written to a timeline when it is read is not seen.
 * A write from such a row that lands in a hashed file is then taken for a change
 * made while the turn waited.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { examples } from "./detect-attribute.js";

import { isReadOnlyTool } from "./detect-claim.js";
import { commitPaths, MAX_NEW_COMMITS } from "./detect-commits.js";
import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";
import { shellText, walkRows } from "./detect-rows.js";
import type { WorkRow } from "./detect-rows.js";
import { mayDetach } from "./detect-shell.js";

import { FAMILY_LOOKBACK_MS, kinEvidence, ownWindows, rowsSince } from "./detect-timeline.js";

import { changedFiles, fingerprintsMatch } from "./detect-tree.js";

import type { ParkBaseline, TreeChanges, TurnChangeInput, UpstreamInput } from "./detect-upstream.js";
import { withoutCommits } from "./detect-upstream.js";

import { headShaOf, isHarnessOutput } from "./detect-workspace.js";
import type { AvailableWorkspace, TimelineRow } from "./detect-workspace.js";
import type { TreeSnapshot } from "./state.js";

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

/**
 * Whether a row may write files the timeline does not show, or keep writing
 * after it returned: a background delegation, a workflow task that is not
 * finished or finished at or after the park (or at an unknown time), an
 * extension call, and a tool that is not known to be read-only (the same
 * classification the family's claims use).
 */
function mayStillWrite(row: WorkRow, parkedAt: number): boolean {
  switch (row.workKind) {
    case "delegation":
      return row.background;
    case "workflow":
      return ["pending", "running", "paused"].includes(row.taskStatus) || row.completedAt === null || row.completedAt >= parkedAt;
    case "extension":
      return true;
    case "tool":
      return !isReadOnlyTool(row.toolName);
    default:
      return false;
  }
}

/** Whether rows ran something that may keep writing: see `mayStillWrite`, or shell that detaches. */
function detachesWork(rows: readonly TimelineRow[], parkedAt: number): boolean {
  for (const row of walkRows(rows)) {
    if (row.kind !== "work") {
      continue;
    }
    const text = shellText(row);
    if (mayStillWrite(row, parkedAt) || (text !== null && mayDetach(text))) {
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
  now: number,
): Promise<Set<string> | string> {
  const { bb, input } = context;
  const rows = await rowsSince(bb, input.threadId, startedAt - FAMILY_LOOKBACK_MS);
  if (typeof rows === "string") {
    return rows;
  }
  const kin = await kinEvidence(bb, input.threadEntries, input.threadId, startedAt, now);
  if (!kin.complete) {
    return "a related thread could not be read in full";
  }
  if ([rows, ...kin.threads].some((thread) => detachesWork(thread, parkedAt))) {
    return "the thread's family ran work that may have kept writing after it returned";
  }
  if (ownWindows(rows, parkedAt, now).length > 0 || kin.windows.some(({ end }) => end >= parkedAt)) {
    return "the thread's family was active since the park";
  }
  return kin.paths;
}

/**
 * The paths of the commits made before the park that `fetched` does not list
 * (the turn's own list drops, say, a commit that kept an old author date), from
 * the park snapshot's commits that the turn-start snapshot did not hold, or why
 * they cannot be told: a head that moved with no such commit named, too many
 * of them, or paths that could not be read.
 */
async function unlistedParkPaths(
  bb: BbPluginApi,
  input: TurnChangeInput,
  start: TreeSnapshot,
  park: ParkBaseline,
  listed: ReadonlySet<string>,
): Promise<string[] | string> {
  const known = new Set([...start.commits, ...(start.recentCommits ?? []).map(({ sha }) => sha)]);
  const made = [...park.tree.commits, ...(park.tree.recentCommits ?? []).map(({ sha }) => sha)].filter((sha) => !known.has(sha));
  if (made.length === 0 && park.tree.headSha !== start.headSha) {
    return "the commits made before the park cannot be told from the snapshots";
  }
  const unlisted = [...new Set(made)].filter((sha) => !listed.has(sha));
  if (unlisted.length > MAX_NEW_COMMITS) {
    return "too many commits were made before the park to read";
  }
  const read = await mapLimit(unlisted, HASH_CONCURRENCY, (sha) => commitPaths(bb, input.environmentId, sha));
  const paths: string[] = [];
  for (const one of read) {
    if (one === null) {
      return "a commit made before the park has paths that could not be read";
    }
    paths.push(...one);
  }
  return paths;
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
  const startTree = turnStart.tree;
  if (
    park === undefined ||
    startTree === undefined ||
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
  const kinPaths = await quietKinPaths(context, park.startedAt, turnStart.startedAt, context.now);
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
  const unlisted = await unlistedParkPaths(bb, input, startTree, park, new Set(fetched.commitChanges.map(({ sha }) => sha)));
  if (typeof unlisted === "string") {
    return skip(unlisted);
  }
  unlisted.forEach((path) => touched.add(path));
  const touchedBefore = (path: string) =>
    touched.has(path) || fingerprintsDiffer(startTree.files[path], park.tree.files[path]);
  const harness = new Set(input.workspace.workingTree.files.filter(isHarnessOutput).map((file) => file.path));
  const candidates = new Set(fetched.uncommittedPaths.filter((path) => !harness.has(path) && !touchedBefore(path)));
  const sincePark = await changedFiles(bb, input.environmentId, park.tree, input.workspace, candidates);
  // The family may have started something while the files were hashed: look again.
  const stillQuiet = await quietKinPaths(context, park.startedAt, turnStart.startedAt, Date.now());
  if (typeof stillQuiet === "string") {
    return skip(stillQuiet);
  }
  const leftOut = new Set([...candidates].filter((path) => sincePark.has(path)));
  const droppedCommits = new Set(
    arrived.flatMap(({ sha, paths }) => (paths !== null && !paths.some(touchedBefore) ? [sha] : [])),
  );
  const tree = withoutCommits(
    { ...fetched, uncommittedPaths: fetched.uncommittedPaths.filter((path) => !leftOut.has(path)) },
    droppedCommits,
  );
  const kept = new Set(tree.paths);
  const paths = fetched.paths.filter((path) => !kept.has(path));
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
