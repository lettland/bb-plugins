import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot, TurnStart } from "./state.js";

import { mapLimit, HASH_CONCURRENCY } from "./detect-limit.js";

import { commitPaths, novelCommits, turnCommits } from "./detect-commits.js";

import {
  authoredPathsFromRows,
  kinEvidence,
  ownWindows,
  siblingAuthoredPaths,
  turnTimeline,
  withinWindow,
} from "./detect-timeline.js";
import type { SiblingEvidence } from "./detect-timeline.js";

import { contentHash, fingerprintsMatch, statPart } from "./detect-tree.js";

import { isHarnessOutput } from "./detect-workspace.js";
import type {
  AvailableWorkspace,
  ThreadListEntry,
  WorkingTreeFile,
} from "./detect-workspace.js";

/** A commit made during the turn, with the paths it touched; null when they could not be read. */
export interface CommitChange {
  sha: string;
  paths: string[] | null;
  authoredAt: number | null;
}

export interface TreeChanges {
  /** Every changed path, committed ones included. */
  paths: string[];
  /** Commits made during the turn. */
  commits: string[];
  /** Paths those commits touched. */
  committedPaths: string[];
  /** Each of those commits with its own paths and time. */
  commitChanges: CommitChange[];
  /** The changed paths the working tree shows, committed ones left out. */
  uncommittedPaths: string[];
}

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

export interface TurnChangeInput {
  threadId: string;
  environmentId: string;
  turnStart: TurnStart;
  workspace: AvailableWorkspace;
  threadEntries: readonly ThreadListEntry[];
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
}

interface ForeignInput {
  bb: BbPluginApi;
  input: TurnChangeInput;
  startedAt: number;
  now: number;
  ownRows: Awaited<ReturnType<typeof turnTimeline>>;
  ownPaths: ReadonlySet<string>;
  commits: readonly CommitChange[];
  sibling: SiblingEvidence;
}

/**
 * The commits another thread made: authored while a sibling ran git that
 * writes history, while nothing of this thread's family was running, and
 * touching none of the family's tool-edited files. Any doubt keeps a commit
 * with this thread — a missed review costs more than an extra one.
 */
async function foreignCommitsOf(foreign: ForeignInput): Promise<ForeignCommit[]> {
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
    return [];
  }
  const kin = await kinEvidence(bb, input.threadEntries, input.threadId, startedAt, now);
  if (!kin.complete) {
    return [];
  }
  const windows = [...ownWindows(ownRows.rows, startedAt, now), ...kin.windows];
  const familyPaths = new Set([...ownPaths, ...kin.paths]);
  return candidates.flatMap(({ commit: { sha, paths, authoredAt }, threadId }) =>
    paths !== null &&
    authoredAt !== null &&
    !windows.some((window) => withinWindow(window, authoredAt)) &&
    !paths.some((path) => familyPaths.has(path))
      ? [{ sha, threadId }]
      : [],
  );
}

/**
 * Every path this turn changed. The thread's own `file-change` rows always
 * count. On top of them, whatever the working tree shows changed since turn
 * start counts too — edits from shell commands, scripts and commits leave no
 * such row — except paths a sibling thread in the same checkout changed
 * through its own tools during the turn, and commits it made with git, which
 * are the sibling's to review.
 */
export async function turnChangedPaths(
  bb: BbPluginApi,
  input: TurnChangeInput,
): Promise<TurnChanges> {
  const { threadId, environmentId, turnStart, workspace } = input;
  const ownRows = await turnTimeline(bb, threadId, turnStart.sinceSeq);
  const own = authoredPathsFromRows(ownRows.rows, turnStart.sinceSeq);
  if (turnStart.tree === undefined) {
    return { paths: own, commits: [], committedPaths: [], foreignCommits: [] };
  }
  const ownSet = new Set(own);
  const harnessOutput = new Set(
    workspace.workingTree.files.filter(isHarnessOutput).map((file) => file.path),
  );
  const tree = await treeChangedPaths(bb, environmentId, turnStart.tree, workspace, turnStart.startedAt);
  const unattributed = (paths: readonly string[]) =>
    paths.filter((path) => !ownSet.has(path) && !harnessOutput.has(path));
  const { startedAt } = turnStart;
  const sibling =
    startedAt === undefined ||
    (unattributed(tree.paths).length === 0 && tree.commits.length === 0)
      ? undefined
      : await siblingAuthoredPaths(bb, input.threadEntries, threadId, startedAt);
  const foreignCommits =
    startedAt === undefined || sibling === undefined
      ? []
      : await foreignCommitsOf({
          bb,
          input,
          startedAt,
          now: Date.now(),
          ownRows,
          ownPaths: ownSet,
          commits: tree.commitChanges,
          sibling,
        });
  for (const { sha, threadId: siblingId } of foreignCommits) {
    bb.log.info(`auto-review: commit ${sha} was made by thread ${siblingId} during the turn; left to that thread`);
  }
  const foreignShas = new Set(foreignCommits.map(({ sha }) => sha));
  const kept = tree.commitChanges.filter(({ sha }) => !foreignShas.has(sha));
  const keptPaths = [...new Set(kept.flatMap(({ paths }) => paths ?? []))];
  const ours = (path: string) => ownSet.has(path) || !sibling?.paths.has(path);
  return {
    paths: [...own, ...unattributed([...new Set([...tree.uncommittedPaths, ...keptPaths])]).filter(ours)],
    commits: kept.map(({ sha }) => sha),
    committedPaths: keptPaths.filter(ours),
    foreignCommits,
  };
}
