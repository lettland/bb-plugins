import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TreeSnapshot, TurnStart } from "./state.js";

type StatusResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["status"]>
>;
export type AvailableWorkspace = Extract<
  StatusResult,
  { outcome: "available" }
>["workspace"];

type TimelineResult = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>
>;
type TimelineRow = TimelineResult["rows"][number];

export async function fetchWorkspace(
  bb: BbPluginApi,
  environmentId: string,
): Promise<AvailableWorkspace | null> {
  const result = await bb.sdk.environments.status({ environmentId });
  return result.outcome === "available" ? result.workspace : null;
}

export async function captureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
): Promise<number> {
  const timeline = await bb.sdk.threads.timeline({ threadId });
  return timeline.maxSeq;
}

/**
 * Whether the user stopped the thread after the turn-start cursor. A stop the
 * thread took for any other reason — a daemon restart, the provider-turn
 * watchdog — was not the user's call and does not count.
 */
export async function stoppedByUser(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<boolean> {
  const events = await bb.sdk.threads.events.list({
    threadId,
    afterSeq: String(sinceSeq),
    types: ["system/thread/interrupted"],
  });
  return events.some(
    (event) =>
      event.type === "system/thread/interrupted" &&
      event.data.reason === "manual-stop",
  );
}

function nestedRows(row: TimelineRow): readonly TimelineRow[] {
  if ("childRows" in row && Array.isArray(row.childRows)) {
    return row.childRows;
  }
  if ("children" in row && Array.isArray(row.children)) {
    return row.children;
  }
  return [];
}

function* walkRows(
  rows: readonly TimelineRow[],
): Generator<TimelineRow, void, void> {
  for (const row of rows) {
    yield row;
    yield* walkRows(nestedRows(row));
  }
}

/** The timeline endpoint's own ceiling; asking for more is rejected with a 400. */
export const AUTHORSHIP_SEGMENT_LIMIT = 100;
/** Bounds the walk back through a very long turn: 50 pages of 100 segments. */
export const AUTHORSHIP_MAX_PAGES = 50;

export function authoredPathsFromRows(
  rows: readonly TimelineRow[],
  sinceSeq: number,
): string[] {
  const paths = new Set<string>();
  for (const row of walkRows(rows)) {
    if (
      row.kind === "work" &&
      row.workKind === "file-change" &&
      row.sourceSeqStart > sinceSeq
    ) {
      paths.add(row.change.path);
      if (row.change.movePath !== null) {
        paths.add(row.change.movePath);
      }
    }
  }
  return [...paths];
}

/**
 * Pages back from the latest segment until the page boundary falls at or before
 * the turn-start cursor, so a long turn is not truncated to its last segments.
 */
export async function authoredPaths(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<string[]> {
  const rows = await recentTimelineRows(bb, threadId, (timeline) => {
    const { olderRowsSourceSeqEnd } = timeline.timelinePage;
    return (
      olderRowsSourceSeqEnd === undefined ||
      olderRowsSourceSeqEnd === null ||
      olderRowsSourceSeqEnd > sinceSeq
    );
  });
  return authoredPathsFromRows(rows, sinceSeq);
}

/**
 * Pages a thread's timeline back from the latest segment for as long as
 * `olderMayMatter` says the next older page can still hold relevant rows.
 */
async function recentTimelineRows(
  bb: BbPluginApi,
  threadId: string,
  olderMayMatter: (timeline: TimelineResult) => boolean,
): Promise<TimelineRow[]> {
  const rows: TimelineRow[] = [];
  let before: { anchorId: string; anchorSeq: number } | null = null;
  for (let page = 0; page < AUTHORSHIP_MAX_PAGES; page += 1) {
    const timeline: TimelineResult = await bb.sdk.threads.timeline({
      threadId,
      segmentLimit: String(AUTHORSHIP_SEGMENT_LIMIT),
      includeNestedRows: "true",
      ...(before === null
        ? {}
        : {
            beforeAnchorId: before.anchorId,
            beforeAnchorSeq: String(before.anchorSeq),
          }),
    });
    rows.push(...timeline.rows);
    const { hasOlderRows, olderCursor } = timeline.timelinePage;
    if (!hasOlderRows || olderCursor === null || !olderMayMatter(timeline)) {
      break;
    }
    before = olderCursor;
  }
  return rows;
}

type WorkingTreeFile = AvailableWorkspace["workingTree"]["files"][number];
type ThreadListEntry = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["list"]>
>[number];

/** Content-hash at most this many uncommitted files; the rest compare by line stats alone. */
export const MAX_HASHED_FILES = 200;
const HASH_CONCURRENCY = 8;
/**
 * Commits made during the turn whose files are read back. A longer run is a
 * rebase or a merge of the base, not work to attribute file by file.
 */
export const MAX_NEW_COMMITS = 20;

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

function statPart(file: WorkingTreeFile): string {
  return `${file.status}:${file.insertions ?? "-"}:${file.deletions ?? "-"}`;
}

/** An empty string when the content cannot be read (deleted, binary-too-large, a directory). */
async function contentHash(
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

function headShaOf(workspace: AvailableWorkspace): string | null {
  const { checkout } = workspace;
  return checkout.kind === "branch" || checkout.kind === "detached"
    ? checkout.headSha
    : null;
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
): Promise<TreeSnapshot | undefined> {
  try {
    const workspace = await fetchWorkspace(bb, environmentId);
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

async function commitPaths(
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

async function novelCommits(
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

  const commits = await novelCommits(
    bb,
    environmentId,
    before,
    await turnCommits(bb, environmentId, before, workspace),
    startedAt,
  );
  const perCommit = await mapLimit(commits, HASH_CONCURRENCY, (sha) =>
    commitPaths(bb, environmentId, sha),
  );
  const committedPaths = [...new Set(perCommit.flat())];
  for (const path of committedPaths) {
    changed.add(path);
  }
  return { paths: [...changed], commits, committedPaths };
}

/** This thread plus every thread it spawned or owns, transitively. */
function ownThreadIds(
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
): Set<string> {
  const own = new Set([selfThreadId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      if (own.has(entry.id)) {
        continue;
      }
      const owners = [entry.parentThreadId, entry.lifecycleOwnerThreadId];
      if (owners.some((owner) => owner !== null && own.has(owner))) {
        own.add(entry.id);
        grew = true;
      }
    }
  }
  return own;
}

/**
 * Threads spawned under this one, transitively, excluding plugin-originated
 * helpers (the advisor and similar): those send no wake-up and must never
 * hold a turn. Only `parentThreadId` links are walked — a thread merely
 * `lifecycleOwnerThreadId`-owned gets no wake-up either. A visited set makes
 * the walk cycle-safe. Archived children are walked through, since archiving
 * does not reliably take their children along; deleted ones never come back
 * from `threads.list`, so a grandchild under a deleted child is not seen. One
 * list call per descendant, archived ones included.
 */
async function spawnedDescendants(
  bb: BbPluginApi,
  threadId: string,
): Promise<ThreadListEntry[]> {
  const descendants: ThreadListEntry[] = [];
  const visited = new Set<string>([threadId]);
  const queue: string[] = [threadId];
  for (let index = 0; index < queue.length; index += 1) {
    const parentId = queue[index];
    const children = await bb.sdk.threads.list({
      parentThreadId: parentId,
      includeHidden: true,
    });
    for (const child of children) {
      if (
        visited.has(child.id) ||
        child.originPluginId !== null ||
        // Defence if the list filter is ever ignored: a row that isn't
        // actually this parent's child must not be walked as one.
        child.parentThreadId !== parentId
      ) {
        continue;
      }
      visited.add(child.id);
      queue.push(child.id);
      descendants.push(child);
    }
  }
  return descendants;
}

/**
 * Spawned children (and grandchildren) still running. bb wakes this thread
 * when one of them ends, so a turn that finds any of these should park
 * instead of reviewing a tree snapshot the child is about to overwrite.
 * `pending` counts: a child spawned just before the turn ends still holds it.
 */
export async function runningChildIds(
  bb: BbPluginApi,
  threadId: string,
): Promise<string[]> {
  const descendants = await spawnedDescendants(bb, threadId);
  return descendants
    .filter(
      (entry) =>
        entry.archivedAt === null &&
        entry.deletedAt === null &&
        entry.status !== "idle" &&
        entry.status !== "error",
    )
    .map((entry) => entry.id);
}

function oldestCreatedAt(rows: readonly TimelineRow[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if ("createdAt" in row && typeof row.createdAt === "number") {
      oldest = oldest === null ? row.createdAt : Math.min(oldest, row.createdAt);
    }
  }
  return oldest;
}

/**
 * Paths another thread in the same checkout changed through its own tools
 * since `startedAt`. A thread that has been idle and untouched since before
 * the turn began cannot have, so its timeline is not read.
 */
export async function siblingAuthoredPaths(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
  startedAt: number,
): Promise<Set<string>> {
  const own = ownThreadIds(entries, selfThreadId);
  const siblings = entries.filter(
    (entry) =>
      !own.has(entry.id) &&
      entry.deletedAt === null &&
      (entry.status !== "idle" || entry.updatedAt >= startedAt),
  );
  const paths = new Set<string>();
  for (const sibling of siblings) {
    let rows: TimelineRow[];
    try {
      rows = await recentTimelineRows(bb, sibling.id, (timeline) => {
        const oldest = oldestCreatedAt(timeline.rows);
        return oldest === null || oldest >= startedAt;
      });
    } catch {
      // Gone since it was listed; it has nothing left to review.
      continue;
    }
    for (const row of walkRows(rows)) {
      if (
        row.kind === "work" &&
        row.workKind === "file-change" &&
        row.createdAt >= startedAt
      ) {
        paths.add(row.change.path);
        if (row.change.movePath !== null) {
          paths.add(row.change.movePath);
        }
      }
    }
  }
  return paths;
}

/**
 * Agent-harness state directories. Hooks and harnesses drop untracked files
 * there during every turn (edit backups, logs, memory), so an untracked file
 * the tree alone shows there is harness output, not the turn's work. The
 * thread's own tool edits there still count.
 */
export const HARNESS_STATE_DIRS: readonly string[] = [".claude/", ".codex/", ".bb/"];

function isHarnessOutput(file: WorkingTreeFile): boolean {
  return (
    file.status === "??" &&
    HARNESS_STATE_DIRS.some((dir) => file.path.startsWith(dir))
  );
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

/**
 * Paths with something left to review: uncommitted, ahead of the base, or
 * committed during the turn — on the mainline, where nothing is ever ahead,
 * the last is the only trace a committed change leaves.
 */
export function dirtyOrAheadPaths(
  workspace: AvailableWorkspace,
  committedThisTurn: readonly string[] = [],
): Set<string> {
  const paths = new Set<string>(committedThisTurn);
  for (const file of workspace.workingTree.files) {
    paths.add(file.path);
  }
  if (workspace.mergeBase !== null) {
    for (const file of workspace.mergeBase.files) {
      paths.add(file.path);
    }
  }
  return paths;
}

export function computeScope(
  authored: readonly string[],
  dirtyOrAhead: ReadonlySet<string>,
): string[] {
  return authored.filter((path) => dirtyOrAhead.has(path));
}

export function mainlineBase(workspace: AvailableWorkspace): string {
  return workspace.mergeBase?.mergeBaseBranch ?? workspace.branch.defaultBranch;
}

export function isBranchCheckout(workspace: AvailableWorkspace): boolean {
  return workspace.checkout.kind === "branch";
}
