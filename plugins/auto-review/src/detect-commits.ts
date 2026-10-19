import { createHash } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot } from "./state.js";

import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";

import { headShaOf } from "./detect-workspace.js";
import type { AvailableWorkspace } from "./detect-workspace.js";

/**
 * Commits made during the turn whose files are read back. A longer run is a
 * rebase or a merge of the base, not work to attribute file by file.
 */
export const MAX_NEW_COMMITS = 20;

/** The paths a commit touched; null when they could not be read, [] when it touched none. */
export async function commitPaths(
  bb: BbPluginApi,
  environmentId: string,
  sha: string,
): Promise<string[] | null> {
  try {
    const result = await bb.sdk.environments.diffFiles({
      environmentId,
      target: "commit",
      sha,
    });
    if (result.outcome !== "available") {
      return null;
    }
    return result.files.flatMap((file) =>
      file.previousPath === null ? [file.path] : [file.path, file.previousPath],
    );
  } catch {
    return null;
  }
}

/** Git changes hunk locations and blob IDs when it replays a patch on a new base. */
function normalizedPatch(patch: string): string {
  return patch
    .replace(/^index [^\n]*\n/gmu, "")
    .replace(/^@@ [^\n]*@@/gmu, "@@");
}

/** A missing or truncated patch cannot prove that a replay is unchanged. */
async function commitPatchFingerprint(
  bb: BbPluginApi,
  environmentId: string,
  sha: string,
): Promise<string | null> {
  try {
    const files = await bb.sdk.environments.diffFiles({
      environmentId,
      target: "commit",
      sha,
    });
    if (
      files.outcome !== "available" ||
      files.truncated ||
      files.files.length === 0 ||
      files.files.some((file) => file.binary)
    ) {
      return null;
    }
    const patches = await bb.sdk.environments.diffPatch({
      environmentId,
      target: { type: "commit", sha },
      paths: files.files.map((file) => file.path),
    });
    if (
      patches.outcome !== "available" ||
      patches.patches.length !== files.files.length ||
      patches.patches.some((patch) => patch.truncated || patch.patch.length === 0)
    ) {
      return null;
    }
    const normalized = patches.patches
      .map((patch) => `${patch.path}\n${normalizedPatch(patch.patch)}`)
      .sort()
      .join("\n");
    return createHash("sha256").update(normalized).digest("hex");
  } catch {
    return null;
  }
}

type RecentCommit = NonNullable<TreeSnapshot["recentCommits"]>[number];

function commitIdentity(commit: RecentCommit): string {
  return JSON.stringify([commit.authorName, commit.authoredAt, commit.subject]);
}

interface MainlineReplayInput {
  bb: BbPluginApi;
  environmentId: string;
  before: TreeSnapshot & { recentCommits: RecentCommit[]; headSha: string };
  commits: readonly string[];
  startedAt: number;
  oldFingerprints: readonly (string | null)[];
  currentFingerprints: readonly (string | null)[];
}

async function mainlineNovelCommits(input: MainlineReplayInput): Promise<string[]> {
  const { bb, environmentId, before, commits, startedAt, oldFingerprints, currentFingerprints } = input;
  let currentMetadata: readonly RecentCommit[];
  let newestFirst = false;
  try {
    const status = await bb.sdk.environments.status({
      environmentId,
      mergeBaseBranch: before.headSha,
    });
    if (status.outcome !== "available" || status.workspace.mergeBase === null) {
      return [...commits];
    }
    currentMetadata = status.workspace.mergeBase.commits;
    newestFirst = currentMetadata[0]?.sha === headShaOf(status.workspace);
  } catch {
    return [...commits];
  }
  const oldByIdentity = new Map<string, Set<string>>();
  for (const [index, commit] of before.recentCommits.entries()) {
    const fingerprint = oldFingerprints[index];
    if (fingerprint === null || fingerprint === undefined) {
      continue;
    }
    const identity = commitIdentity(commit);
    const known = oldByIdentity.get(identity) ?? new Set<string>();
    known.add(fingerprint);
    oldByIdentity.set(identity, known);
  }
  const metadata = commits.map((sha) => currentMetadata.find((commit) => commit.sha === sha));
  const isReplay = (commit: RecentCommit | undefined) =>
    commit !== undefined && oldByIdentity.has(commitIdentity(commit));
  const replayBoundary = newestFirst
    ? metadata.reduce((last, commit, index) => (isReplay(commit) ? index : last), -1)
    : metadata.findIndex(isReplay);
  if (replayBoundary < 0) {
    return [...commits];
  }
  return commits.filter((_, index) => {
    const commit = metadata[index];
    const fingerprint = currentFingerprints[index];
    if (commit === undefined || fingerprint === null || fingerprint === undefined) {
      return true;
    }
    const known = oldByIdentity.get(commitIdentity(commit));
    if (known !== undefined) {
      return !known.has(fingerprint);
    }
    // New base commits precede the replay in history, regardless of API list order.
    const isBaseCommit = newestFirst ? index > replayBoundary : index < replayBoundary;
    return !isBaseCommit || commit.authoredAt >= startedAt;
  });
}

/**
 * Every commit in a fast-forward range descends from the turn-start head, so
 * one authored before the turn began was brought in (pull, merge,
 * cherry-pick), not written this turn. A commit with no metadata is kept:
 * nothing proves it came from elsewhere. One authored after the turn began that
 * the remote base already holds is caught later, by `remoteReachableShas`.
 */
function authoredDuringTurn(
  commits: readonly string[],
  metadata: readonly RecentCommit[],
  startedAt?: number,
): string[] {
  if (startedAt === undefined) {
    return [...commits];
  }
  return commits.filter((sha) => {
    const commit = metadata.find((candidate) => candidate.sha === sha);
    return commit === undefined || commit.authoredAt >= startedAt;
  });
}

/** A commit made during the turn, with the time git recorded for it; null when that is unknown. */
export interface TurnCommit {
  sha: string;
  authoredAt: number | null;
}

/** The shas of `commits` this turn authored; see `novelCommits`. */
async function novelShas(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  commits: readonly string[],
  startedAt?: number,
): Promise<string[]> {
  const originals = before.commits.length > 0
    ? before.commits
    : before.recentCommits?.map((commit) => commit.sha) ?? [];
  if (originals.length === 0 || commits.length === 0) {
    return [...commits];
  }
  if (before.headSha !== null) {
    try {
      const ancestry = await bb.sdk.environments.status({
        environmentId,
        mergeBaseBranch: before.headSha,
      });
      if (
        ancestry.outcome === "available" &&
        ancestry.workspace.mergeBase?.baseRef === before.headSha
      ) {
        return authoredDuringTurn(commits, ancestry.workspace.mergeBase.commits, startedAt);
      }
    } catch {
      // An inaccessible old head cannot prove that this was a fast forward.
    }
  }
  const oldFingerprints = await mapLimit(
    originals.slice(0, MAX_NEW_COMMITS),
    HASH_CONCURRENCY,
    (sha) => commitPatchFingerprint(bb, environmentId, sha),
  );
  const currentFingerprints = await mapLimit(commits, HASH_CONCURRENCY, (sha) =>
    commitPatchFingerprint(bb, environmentId, sha),
  );
  if (before.commits.length > 0) {
    const known = new Set(
      oldFingerprints.filter((fingerprint): fingerprint is string => fingerprint !== null),
    );
    return commits.filter((_, index) => {
      const fingerprint = currentFingerprints[index];
      return fingerprint === null || fingerprint === undefined || !known.has(fingerprint);
    });
  }
  if (before.headSha === null || startedAt === undefined || before.recentCommits === undefined) {
    return [...commits];
  }
  return mainlineNovelCommits({
    bb,
    environmentId,
    before: { ...before, headSha: before.headSha, recentCommits: before.recentCommits },
    commits,
    startedAt,
    oldFingerprints,
    currentFingerprints,
  });
}

/**
 * The commits of `commits` this turn authored. After a fast forward from the
 * turn-start head, those authored at or after `startedAt`; commits pulled in
 * from upstream predate the turn. Otherwise, those whose patch is not one that
 * was already there at turn start, so a rebase replay is not claimed. A commit
 * teammates merged into the remote base while the thread was idle is not
 * dropped here, whatever its date; `remoteReachableShas` finds those.
 */
export async function novelCommits(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  commits: readonly TurnCommit[],
  startedAt?: number,
): Promise<TurnCommit[]> {
  const novel = new Set(
    await novelShas(bb, environmentId, before, commits.map(({ sha }) => sha), startedAt),
  );
  return commits.filter(({ sha }) => novel.has(sha));
}

/** The commits made during the turn, and whether the list is cut short: it hit `MAX_NEW_COMMITS` or the host listed fewer commits than are ahead. */
export interface TurnCommits {
  commits: TurnCommit[];
  capped: boolean;
}

/**
 * Commits made during the turn: the head moved off `before.headSha`. On a
 * branch ahead of its base they are the commits ahead that were not ahead at
 * turn start. On the mainline itself there is no base to be ahead of, so the
 * turn-start head serves as one — otherwise every commit made straight onto
 * the mainline would go unseen.
 */
export async function turnCommits(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  workspace: AvailableWorkspace,
): Promise<TurnCommits> {
  if (headShaOf(workspace) === before.headSha) {
    return { commits: [], capped: false };
  }
  let commits: readonly { sha: string; authoredAt?: number }[] = [];
  let incomplete = false;
  if (workspace.mergeBase !== null) {
    const known = new Set(before.commits);
    commits = workspace.mergeBase.commits.filter((commit) => !known.has(commit.sha));
    incomplete = workspace.mergeBase.aheadCount > workspace.mergeBase.commits.length;
  } else if (before.headSha !== null) {
    try {
      const since = await bb.sdk.environments.status({
        environmentId,
        mergeBaseBranch: before.headSha,
      });
      if (since.outcome === "available" && since.workspace.mergeBase !== null) {
        commits = since.workspace.mergeBase.commits;
        incomplete = since.workspace.mergeBase.aheadCount > commits.length;
      }
    } catch {
      commits = [];
    }
  }
  return {
    commits: commits.slice(0, MAX_NEW_COMMITS).map((commit) => ({
      sha: commit.sha,
      authoredAt: typeof commit.authoredAt === "number" ? commit.authoredAt : null,
    })),
    capped: incomplete || commits.length >= MAX_NEW_COMMITS,
  };
}

/**
 * The remote-tracking ref of a base branch; a base that already names one is
 * used as it is. Only a remote named `origin` is checked: with any other name
 * the ref does not resolve and every commit is kept.
 */
export function remoteRef(base: string): string {
  return base.startsWith("origin/") ? base : `origin/${base}`;
}

type MergeBase = NonNullable<AvailableWorkspace["mergeBase"]>;

/**
 * The comparison of the checkout against `ref` that both remote checks need,
 * trusted only when the ref resolved, the answer was for it, and the checkout
 * is still at `expectedHead`; otherwise why not. Never logs: each caller words
 * its own line.
 */
async function readRemoteComparison(
  bb: BbPluginApi,
  environmentId: string,
  ref: string,
  expectedHead: string | null,
): Promise<{ mergeBase: MergeBase; head: string } | { reason: string }> {
  let status: Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["status"]>>;
  try {
    status = await bb.sdk.environments.status({ environmentId, mergeBaseBranch: ref });
  } catch {
    return { reason: "the status call failed" };
  }
  if (status.outcome !== "available" || status.workspace.mergeBase === null) {
    return { reason: `no ${ref} to compare against` };
  }
  const { mergeBase } = status.workspace;
  if (mergeBase.mergeBaseBranch !== ref || mergeBase.baseRef === null) {
    return { reason: "the answer was not for that ref" };
  }
  const head = headShaOf(status.workspace);
  if (head === null || head !== expectedHead) {
    return { reason: "the checkout moved while the remote base was checked" };
  }
  return { mergeBase, head };
}

/**
 * The shas of `shas` the remote base already holds. Asks for the commits
 * ahead of `origin/<base>`: a turn commit missing from that list is reachable
 * from the remote or patch-equivalent to a commit it holds (the host lists the
 * commits ahead with `git log --cherry-pick`), so someone else's merged work is
 * among them. The answer is trusted only when the ref resolved, the ahead list
 * is complete, and the checkout is still at `expectedHead`. An empty list is
 * trusted only when HEAD is the merge base, so a squash merge the host
 * detected cannot mark every commit as held. Any doubt gives an empty set,
 * which keeps every commit with the turn.
 */
export async function remoteReachableShas(
  bb: BbPluginApi,
  environmentId: string,
  base: string,
  shas: readonly string[],
  expectedHead: string | null,
): Promise<Set<string>> {
  const ref = remoteRef(base);
  const skip = (reason: string) => {
    bb.log.info(`auto-review: not checking whether the turn's commits came from ${ref}: ${reason}`);
    return new Set<string>();
  };
  const read = await readRemoteComparison(bb, environmentId, ref, expectedHead);
  if ("reason" in read) {
    return skip(read.reason);
  }
  const { mergeBase, head } = read;
  if (mergeBase.aheadCount !== mergeBase.commits.length) {
    return skip("the list of commits ahead is incomplete");
  }
  if (mergeBase.commits.length === 0 && mergeBase.baseRef !== head) {
    return skip("an empty list of commits ahead may be a squash merge, not HEAD held by the remote");
  }
  const ahead = new Set(mergeBase.commits.map(({ sha }) => sha));
  return new Set(shas.filter((sha) => !ahead.has(sha)));
}

/**
 * Whether `origin/<branch>` already holds `expectedHead`: nothing is ahead of
 * it and it is itself the merge base, so HEAD is an ancestor of the remote
 * branch. "HEAD is missing from the ahead list" is not enough, since the host
 * lists the commits ahead with `--cherry-pick`, which can leave HEAD out as
 * patch-equivalent while older local commits are still unpushed. Any doubt is
 * false.
 */
export async function branchHeadPushed(
  bb: BbPluginApi,
  environmentId: string,
  branch: string,
  expectedHead: string,
): Promise<boolean> {
  const ref = remoteRef(branch);
  const read = await readRemoteComparison(bb, environmentId, ref, expectedHead);
  if ("reason" in read) {
    bb.log.info(`auto-review: not treating HEAD as pushed to ${ref}: ${read.reason}`);
    return false;
  }
  const { mergeBase, head } = read;
  if (mergeBase.aheadCount !== 0) {
    bb.log.info(`auto-review: not treating HEAD as pushed to ${ref}: ${mergeBase.aheadCount} commits are still ahead of it`);
    return false;
  }
  if (mergeBase.baseRef !== head) {
    bb.log.info(`auto-review: not treating HEAD as pushed to ${ref}: HEAD is not an ancestor of it`);
    return false;
  }
  return true;
}
