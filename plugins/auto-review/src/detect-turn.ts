import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot, TurnStart } from "./state.js";

import { mapLimit, HASH_CONCURRENCY } from "./detect-limit.js";

import { commitPaths, novelCommits, turnCommits } from "./detect-commits.js";

import { authoredPaths, siblingAuthoredPaths } from "./detect-timeline.js";

import { contentHash, fingerprintsMatch, statPart } from "./detect-tree.js";

import { isHarnessOutput } from "./detect-workspace.js";
import type {
  AvailableWorkspace,
  ThreadListEntry,
  WorkingTreeFile,
} from "./detect-workspace.js";

export interface TreeChanges {
  /** Every changed path, committed ones included. */
  paths: string[];
  /** Commits made during the turn. */
  commits: string[];
  /** Paths those commits touched. */
  committedPaths: string[];
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
  const perCommit = await mapLimit(novel, HASH_CONCURRENCY, async (sha) => ({
    sha,
    paths: await commitPaths(bb, environmentId, sha),
  }));
  // A commit read fine that touched no path, such as a clean merge from a pull,
  // adds nothing to review; one that could not be read is kept to be safe.
  const kept = perCommit.filter(({ paths }) => paths === null || paths.length > 0);
  const commits = kept.map(({ sha }) => sha);
  const committedPaths = [...new Set(kept.flatMap(({ paths }) => paths ?? []))];
  for (const path of committedPaths) {
    changed.add(path);
  }
  return { paths: [...changed], commits, committedPaths };
}

export interface TurnChangeInput {
  threadId: string;
  environmentId: string;
  turnStart: TurnStart;
  workspace: AvailableWorkspace;
  threadEntries: readonly ThreadListEntry[];
}

export interface TurnChanges {
  /** Every path this turn changed. */
  paths: string[];
  /** Commits the turn made; their diff is the turn's work too. */
  commits: string[];
  /** The subset of `paths` those commits touched. */
  committedPaths: string[];
}

/**
 * Every path this turn changed. The thread's own `file-change` rows always
 * count. On top of them, whatever the working tree shows changed since turn
 * start counts too — edits from shell commands, scripts and commits leave no
 * such row — except paths a sibling thread in the same checkout changed
 * through its own tools during the turn, which are the sibling's to review.
 */
export async function turnChangedPaths(
  bb: BbPluginApi,
  input: TurnChangeInput,
): Promise<TurnChanges> {
  const { threadId, environmentId, turnStart, workspace } = input;
  const own = await authoredPaths(bb, threadId, turnStart.sinceSeq);
  if (turnStart.tree === undefined) {
    return { paths: own, commits: [], committedPaths: [] };
  }
  const ownSet = new Set(own);
  const harnessOutput = new Set(
    workspace.workingTree.files.filter(isHarnessOutput).map((file) => file.path),
  );
  const tree = await treeChangedPaths(bb, environmentId, turnStart.tree, workspace, turnStart.startedAt);
  const unattributed = tree.paths.filter(
    (path) => !ownSet.has(path) && !harnessOutput.has(path),
  );
  const foreign =
    unattributed.length === 0 || turnStart.startedAt === undefined
      ? new Set<string>()
      : await siblingAuthoredPaths(
          bb,
          input.threadEntries,
          threadId,
          turnStart.startedAt,
        );
  const ours = (path: string) => ownSet.has(path) || !foreign.has(path);
  return {
    paths: [...own, ...unattributed.filter(ours)],
    commits: tree.commits,
    committedPaths: tree.committedPaths.filter(ours),
  };
}
