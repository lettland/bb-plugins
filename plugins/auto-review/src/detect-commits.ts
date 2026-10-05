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

export async function commitPaths(
  bb: BbPluginApi,
  environmentId: string,
  sha: string,
): Promise<string[]> {
  try {
    const result = await bb.sdk.environments.diffFiles({
      environmentId,
      target: "commit",
      sha,
    });
    if (result.outcome !== "available") {
      return [];
    }
    return result.files.flatMap((file) =>
      file.previousPath === null ? [file.path] : [file.path, file.previousPath],
    );
  } catch {
    return [];
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

export async function novelCommits(
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
        return [...commits];
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
): Promise<string[]> {
  if (headShaOf(workspace) === before.headSha) {
    return [];
  }
  let commits: readonly { sha: string }[] = [];
  if (workspace.mergeBase !== null) {
    const known = new Set(before.commits);
    commits = workspace.mergeBase.commits.filter((commit) => !known.has(commit.sha));
  } else if (before.headSha !== null) {
    try {
      const since = await bb.sdk.environments.status({
        environmentId,
        mergeBaseBranch: before.headSha,
      });
      commits =
        since.outcome === "available" ? (since.workspace.mergeBase?.commits ?? []) : [];
    } catch {
      commits = [];
    }
  }
  return commits.slice(0, MAX_NEW_COMMITS).map((commit) => commit.sha);
}
