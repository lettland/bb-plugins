import { createHash } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TreeSnapshot } from "./state.js";

import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";

import {
  fetchWorkspace,
  headShaOf,
  isHarnessOutput,
} from "./detect-workspace.js";
import type {
  AvailableWorkspace,
  WorkingTreeFile,
} from "./detect-workspace.js";

/** Content-hash at most this many uncommitted files; the rest compare by line stats alone. */
export const MAX_HASHED_FILES = 200;

/**
 * Whether a snapshot holds a file that is not a deletion yet carries no content
 * hash (past the hash limit, or its content could not be read), so it compares
 * by line stats alone.
 */
export function hasUnhashedEntries(tree: TreeSnapshot): boolean {
  return Object.values(tree.files).some((fingerprint) => {
    const [stat = "", hash = ""] = fingerprint.split("|");
    return hash === "" && !stat.startsWith("D:");
  });
}

export function statPart(file: WorkingTreeFile): string {
  return `${file.status}:${file.insertions ?? "-"}:${file.deletions ?? "-"}`;
}

/** An empty string when the content cannot be read (deleted, binary-too-large, a directory). */
export async function contentHash(
  bb: BbPluginApi,
  environmentId: string,
  file: WorkingTreeFile,
): Promise<string> {
  if (file.status === "D") {
    return "";
  }
  try {
    const result = await bb.sdk.environments.diffFile({
      environmentId,
      target: "uncommitted",
      path: file.path,
      side: "new",
    });
    return createHash("sha256").update(result.content).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * Same content unless the line stats differ, or both sides carry a content hash
 * and those differ. A side whose content could not be read compares by stats.
 */
export function fingerprintsMatch(before: string, after: string): boolean {
  const [statBefore, hashBefore = ""] = before.split("|");
  const [statAfter, hashAfter = ""] = after.split("|");
  if (statBefore !== statAfter) {
    return false;
  }
  return hashBefore === "" || hashAfter === "" || hashBefore === hashAfter;
}

/**
 * The uncommitted paths of `workspace` that differ from `before`: new ones, and
 * ones whose line stats or, where both sides carry a hash, content changed.
 * Only the paths in `only` are looked at when it is given.
 */
export async function changedFiles(
  bb: BbPluginApi,
  environmentId: string,
  before: TreeSnapshot,
  workspace: AvailableWorkspace,
  only?: ReadonlySet<string>,
): Promise<Set<string>> {
  const changed = new Set<string>();
  const recheck: Array<{ file: WorkingTreeFile; prior: string }> = [];
  for (const file of workspace.workingTree.files) {
    if (only !== undefined && !only.has(file.path)) {
      continue;
    }
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
  return changed;
}

/**
 * Untracked harness output is left out: it is never attributed anyway, and a
 * checkout full of edit backups would otherwise spend the hash budget on them.
 * Files without line stats (untracked) are hashed first, since for them the
 * hash is the only way to see a rewrite.
 */
export async function snapshotTree(
  bb: BbPluginApi,
  environmentId: string,
  workspace: AvailableWorkspace,
): Promise<TreeSnapshot> {
  const files = workspace.workingTree.files
    .filter((file) => !isHarnessOutput(file))
    .sort(
      (a, b) => Number(a.insertions !== null) - Number(b.insertions !== null),
    );
  const hashes = await mapLimit(
    files.slice(0, MAX_HASHED_FILES),
    HASH_CONCURRENCY,
    (file) => contentHash(bb, environmentId, file),
  );
  let recentCommits: TreeSnapshot["recentCommits"];
  if (workspace.mergeBase === null && headShaOf(workspace) !== null) {
    for (const depth of [20, 10, 5, 1]) {
      try {
        const recent = await bb.sdk.environments.status({
          environmentId,
          mergeBaseBranch: `HEAD~${depth}`,
        });
        if (recent.outcome === "available" && recent.workspace.mergeBase !== null) {
          recentCommits = recent.workspace.mergeBase.commits.map((commit) => ({
            sha: commit.sha,
            authorName: commit.authorName,
            authoredAt: commit.authoredAt,
            subject: commit.subject,
          }));
          break;
        }
      } catch {
        // A short history may not have this ancestor; try a shallower one.
      }
    }
  }
  return {
    headSha: headShaOf(workspace),
    files: Object.fromEntries(
      files.map((file, index) => [
        file.path,
        `${statPart(file)}|${hashes[index] ?? ""}`,
      ]),
    ),
    commits: workspace.mergeBase?.commits.map((commit) => commit.sha) ?? [],
    ...(recentCommits === undefined ? {} : { recentCommits }),
  };
}

/** Turn-start tree capture that never throws: a failure leaves the timeline to decide alone. */
export async function captureTree(
  bb: BbPluginApi,
  environmentId: string,
  fetched?: AvailableWorkspace,
): Promise<TreeSnapshot | undefined> {
  try {
    const workspace = fetched ?? (await fetchWorkspace(bb, environmentId));
    return workspace === null
      ? undefined
      : await snapshotTree(bb, environmentId, workspace);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not snapshot the working tree of ${environmentId}; this turn is attributed by its timeline alone: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
