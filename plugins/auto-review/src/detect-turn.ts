import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot } from "./state.js";

import { mapLimit, HASH_CONCURRENCY } from "./detect-limit.js";

import { commitPaths, novelCommits, turnCommits } from "./detect-commits.js";

import type { CommitChange, TreeChanges, TurnChangeInput, UpstreamInput } from "./detect-upstream.js";
import { withoutUpstream } from "./detect-upstream.js";
export type { CommitChange, TreeChanges, TurnChangeInput } from "./detect-upstream.js";

import { claimedChanges } from "./detect-attribute.js";

import {
  authoredPathsFromRows,
  kinEvidence,
  ownWindows,
  siblingAuthoredPaths,
  turnTimeline,
  withinWindow,
} from "./detect-timeline.js";
import type { KinEvidence, SiblingEvidence } from "./detect-timeline.js";

import { contentHash, fingerprintsMatch, statPart } from "./detect-tree.js";

import { isHarnessOutput } from "./detect-workspace.js";
import type { AvailableWorkspace, WorkingTreeFile } from "./detect-workspace.js";

/**
 * Paths the working tree shows changed since `before`, however they changed:
 * newly uncommitted, uncommitted with different content, or touched by a
 * commit made during the turn.
 */
export async function treeChangedPaths(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  workspace: AvailableWorkspace,
  startedAt?: number,
): Promise<TreeChanges> {
  const changed = new Set<string>();
  const recheck: Array<{ file: WorkingTreeFile; prior: string }> = [];
  for (const file of workspace.workingTree.files) {
    const prior = before.files[file.path];
    if (prior === undefined) {
      changed.add(file.path);
    } else if (!fingerprintsMatch(prior, `${statPart(file)}|`)) {
      changed.add(file.path);
    } else if (!prior.endsWith("|")) {
      recheck.push({ file, prior });
    }
  }
  await mapLimit(recheck, HASH_CONCURRENCY, async ({ file, prior }) => {
    const now = `${statPart(file)}|${await contentHash(bb, environmentId, file)}`;
    if (!fingerprintsMatch(prior, now)) {
      changed.add(file.path);
    }
  });

  const novel = await novelCommits(
    bb,
    environmentId,
    before,
    await turnCommits(bb, environmentId, before, workspace),
    startedAt,
  );
  const perCommit = await mapLimit(novel, HASH_CONCURRENCY, async ({ sha, authoredAt }) => ({
    sha,
    authoredAt,
    paths: await commitPaths(bb, environmentId, sha),
  }));
  // A commit read fine that touched no path, such as a clean merge from a pull,
  // adds nothing to review; one that could not be read is kept to be safe.
  const kept = perCommit.filter(({ paths }) => paths === null || paths.length > 0);
  const commits = kept.map(({ sha }) => sha);
  const committedPaths = [...new Set(kept.flatMap(({ paths }) => paths ?? []))];
  const uncommittedPaths = [...changed];
  for (const path of committedPaths) {
    changed.add(path);
  }
  return { paths: [...changed], commits, committedPaths, commitChanges: kept, uncommittedPaths };
}

/** A commit made during the turn that another thread made, and which thread. */
export interface ForeignCommit {
  sha: string;
  threadId: string;
}

export interface TurnChanges {
  /** Every path this turn changed. */
  paths: string[];
  /** Commits the turn made; their diff is the turn's work too. */
  commits: string[];
  /** The subset of `paths` those commits touched. */
  committedPaths: string[];
  /** Commits made during the turn that a sibling thread's git made; the sibling's to review. */
  foreignCommits: ForeignCommit[];
  /** Commits that arrived with the remote base, or the checkout branch's own remote-tracking ref, during the turn, merged by someone else; not the turn's work. */
  upstreamCommits: string[];
  /** `exact` claims only the changes this thread's family made or named; `sweep` takes every unattributed change, as when something ran whose writes cannot be listed. */
  mode: "exact" | "sweep";
  /** Uncommitted changes nothing of the family claimed; they are never in `paths`. */
  unclaimed: string[];
}

/** What a review needs of a turn's changes: how they were attributed (`mode`, `unclaimed`) is left out. */
export type TurnScope = Omit<TurnChanges, "mode" | "unclaimed">;

interface ForeignInput {
  bb: BbPluginApi;
  input: TurnChangeInput;
  startedAt: number;
  now: number;
  ownRows: Awaited<ReturnType<typeof turnTimeline>>;
  ownPaths: ReadonlySet<string>;
  commits: readonly CommitChange[];
  sibling: SiblingEvidence;
  /** The kin evidence already read for the upstream check, when there was one. */
  kin: KinEvidence | undefined;
}

/**
 * The commits another thread made: authored while a sibling ran git that
 * writes history, while nothing of this thread's family was running, and
 * touching none of the family's tool-edited files. Any doubt keeps a commit
 * with this thread — a missed review costs more than an extra one. The kin
 * evidence it read comes back too, so it is read once.
 */
async function foreignCommitsOf(
  foreign: ForeignInput,
): Promise<{ commits: ForeignCommit[]; kin: KinEvidence | undefined }> {
  const { bb, input, startedAt, now, ownRows, ownPaths, commits, sibling } = foreign;
  const candidates = commits.flatMap((commit) => {
    const { authoredAt } = commit;
    const window =
      authoredAt === null
        ? undefined
        : sibling.commitWindows.find((candidate) => withinWindow(candidate, authoredAt));
    return window === undefined ? [] : [{ commit, threadId: window.threadId }];
  });
  if (candidates.length === 0 || ownRows.truncated) {
    return { commits: [], kin: foreign.kin };
  }
  const kin = foreign.kin ?? (await kinEvidence(bb, input.threadEntries, input.threadId, startedAt, now));
  if (!kin.complete) {
    return { commits: [], kin };
  }
  const windows = [...ownWindows(ownRows.rows, startedAt, now), ...kin.windows];
  const familyPaths = new Set([...ownPaths, ...kin.paths]);
  const made = candidates.flatMap(({ commit: { sha, paths, authoredAt }, threadId }) =>
    paths !== null &&
    authoredAt !== null &&
    !windows.some((window) => withinWindow(window, authoredAt)) &&
    !paths.some((path) => familyPaths.has(path))
      ? [{ sha, threadId }]
      : [],
  );
  return { commits: made, kin };
}

interface SiblingReading {
  /** Undefined when nothing needed it read. */
  sibling: SiblingEvidence | undefined;
  foreignCommits: ForeignCommit[];
  /** The kin evidence read along the way, when there was one. */
  kin: KinEvidence | undefined;
}

/**
 * What the sibling threads did, read only when the tree shows something this
 * thread's own tool edits do not account for, and the commits of theirs that
 * are left to them, which are logged.
 */
async function readSiblings(
  context: Omit<UpstreamInput, "startedAt" | "commits">,
  tree: TreeChanges,
  hasUnattributed: boolean,
  upstreamKin: KinEvidence | undefined,
): Promise<SiblingReading> {
  const { bb, input } = context;
  const { startedAt } = input.turnStart;
  if (startedAt === undefined || (!hasUnattributed && tree.commits.length === 0)) {
    return { sibling: undefined, foreignCommits: [], kin: upstreamKin };
  }
  const sibling = await siblingAuthoredPaths(bb, input.threadEntries, input.threadId, startedAt);
  const { commits, kin } = await foreignCommitsOf({
    ...context,
    startedAt,
    commits: tree.commitChanges,
    sibling,
    kin: upstreamKin,
  });
  for (const { sha, threadId } of commits) {
    bb.log.info(`auto-review: commit ${sha} was made by thread ${threadId} during the turn; left to that thread`);
  }
  return { sibling, foreignCommits: commits, kin };
}

/**
 * Every path this turn changed. The thread's own `file-change` rows always
 * count. On top of them, the working tree's changes since turn start count
 * (edits from shell commands, scripts and commits leave no such row) when this
 * thread's family (itself, its bb children and owned threads) made them. That
 * is exact when everything the family ran was read-only or named what it wrote:
 * then only the paths it named count, and the other changes come back as
 * `unclaimed`. When the family ran something whose writes cannot be listed, or
 * its evidence cannot be read in full, every change counts instead, except
 * paths a sibling thread in the same checkout changed through its own tools
 * during the turn, and commits it made with git, which are the sibling's to
 * review. So are uncommitted paths a sibling's shell command wrote to by name,
 * when nothing of the family names them. Commits that merely arrived with the
 * remote base or the checkout branch's own remote-tracking ref are no one's to
 * review here, and their paths do not count either, unless the family may have
 * pushed meanwhile; nor do commits nothing of the family could have made (see
 * `claimOwnChanges`).
 */
export async function turnChangedPaths(
  bb: BbPluginApi,
  input: TurnChangeInput,
): Promise<TurnChanges> {
  const { threadId, environmentId, turnStart, workspace } = input;
  const ownRows = await turnTimeline(bb, threadId, turnStart.sinceSeq);
  const own = authoredPathsFromRows(ownRows.rows, turnStart.sinceSeq);
  if (turnStart.tree === undefined) {
    return { paths: own, commits: [], committedPaths: [], foreignCommits: [], upstreamCommits: [], mode: "exact", unclaimed: [] };
  }
  const ownSet = new Set(own);
  const harnessOutput = new Set(
    workspace.workingTree.files.filter(isHarnessOutput).map((file) => file.path),
  );
  const fetched = await treeChangedPaths(bb, environmentId, turnStart.tree, workspace, turnStart.startedAt);
  const now = Date.now();
  const upstream = await withoutUpstream({ bb, input, now, ownRows, ownPaths: ownSet }, fetched);
  const { tree } = upstream;
  const unattributed = (paths: readonly string[]) =>
    paths.filter((path) => !ownSet.has(path) && !harnessOutput.has(path));
  const { sibling, foreignCommits, kin } = await readSiblings(
    { bb, input, now, ownRows, ownPaths: ownSet },
    tree,
    unattributed(tree.paths).length > 0,
    upstream.kin,
  );
  return claimedChanges({
    bb,
    input,
    now,
    ownRows,
    own,
    tree,
    sibling,
    foreignCommits,
    upstreamCommits: upstream.shas,
    kin,
    unattributed,
  });
}
