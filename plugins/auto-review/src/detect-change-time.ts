import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { threadMembership, errorClass } from "./detect-attached.js";
import { rowEffect } from "./detect-claim.js";
import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";
import { rowWindow, walkRows } from "./detect-rows.js";
import type { TimeWindow, WorkRow } from "./detect-rows.js";
import { checkoutPath } from "./detect-sibling-credit.js";
import { FAMILY_LOOKBACK_MS, rowsSince } from "./detect-pages.js";
import { withinWindow } from "./detect-timeline.js";
import type { KinEvidence, SiblingEvidence } from "./detect-timeline.js";
import { contentHash, MAX_HASHED_FILES } from "./detect-tree.js";
import type { ThreadListEntry, TimelineRow, WorkingTreeFile } from "./detect-workspace.js";
import { passesThreadGate } from "./gate.js";

/**
 * A path an opaque command of a sibling thread last changed, while nothing of
 * this thread's family that can write was running, is that sibling's to
 * review, not this thread's. A sweep (see `claimOwnChanges`) cannot tell it
 * from the family's own write, since the sibling's command text does not name
 * the path. Without positive evidence a path stays with this thread, as it
 * always did. Regression: thr_8rryqyy9me, a thread that changed no file was
 * reviewed because a sibling thread's script wrote one meanwhile.
 *
 * Known gaps, all documented in the README. Only the last change to a file is
 * seen: a file this thread wrote and a sibling's command rewrote later goes to
 * the sibling, whose review covers the whole diff. A time inside the sibling's
 * window cannot tell the sibling's write from an outside writer's (a hand
 * edit, a formatter) that landed during the same command. A deletion is always
 * kept. A repo whose `diffFile` content is not byte-identical to the file on
 * disk (CRLF conversion, a `.gitattributes` filter) keeps every path.
 */

/** The family's windows are widened by this on both sides, on top of `rowWindow`'s own slack. */
const FAMILY_MARGIN_MS = 1_000;
/** The most paths checked, and the most entries (files and directories) one directory entry is walked through; the rest stays with this thread. */
const MAX_CHECKED = MAX_HASHED_FILES;
/** The most levels of directories a walk goes below the entry. */
const MAX_DEPTH = 32;

/** What the check needs of the file system: injected so a test controls the times. */
export interface ChangeTimeFs {
  lstat: (path: string) => Promise<{ ctimeMs: number; mtimeMs: number; isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean }>;
  realpath: (path: string) => Promise<string>;
  /** Reads a regular file without following a link; rejects when the path is a link or anything else. */
  readRegular: (path: string) => Promise<Uint8Array>;
  readdir: (path: string) => Promise<string[]>;
}

/**
 * Opens without following a link, checks the handle is a regular file, reads
 * it and closes it. Without `O_NOFOLLOW` (a platform that has none) it reads
 * nothing: the path stays with this thread. The flag guards only the last path
 * component.
 */
export async function readRegularFile(path: string, platform: { O_RDONLY: number; O_NOFOLLOW?: number } = constants): Promise<Uint8Array> {
  if (platform.O_NOFOLLOW === undefined) {
    throw new TypeError("this platform cannot open a file without following a link");
  }
  const handle = await open(path, platform.O_RDONLY | platform.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new TypeError("not a regular file");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export const nodeChangeTimeFs: ChangeTimeFs = { lstat, realpath, readRegular: (path) => readRegularFile(path), readdir };

export interface ChangeTimeInput {
  bb: BbPluginApi;
  threadId: string;
  environmentId: string;
  threadEntries: readonly ThreadListEntry[];
  startedAt: number | undefined;
  now: number;
  ownRowsTruncated: boolean;
  /** The kin evidence already read; none leaves every path with this thread. */
  kin: KinEvidence | undefined;
  sibling: SiblingEvidence | undefined;
  /** The working tree's files, to hash a candidate's current content the way the turn-start snapshot does. */
  files: readonly WorkingTreeFile[];
  /** Uncommitted paths nothing else accounts for. */
  candidates: readonly string[];
  fs?: ChangeTimeFs;
}

/** The first 16 hex characters of the sha256 of the bytes, as `contentHash` takes them. */
export function localContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Whether a sibling's opaque commands count as evidence: it, and the root of its family, could be reviewed, and that root's review reads its commands. */
async function reviewable(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  byId: ReadonlyMap<string, ThreadListEntry>,
  families: Map<string, Promise<Set<string>>>,
  threadId: string,
): Promise<boolean> {
  const sibling = byId.get(threadId);
  if (sibling === undefined || sibling.archivedAt !== null || sibling.originPluginId !== null || sibling.visibility !== "visible") {
    return false;
  }
  const seen = new Set([sibling.id]);
  let root = sibling;
  while (root.parentThreadId !== null) {
    const parent = byId.get(root.parentThreadId);
    if (parent === undefined || seen.has(parent.id)) {
      return false;
    }
    seen.add(parent.id);
    root = parent;
  }
  if (!passesThreadGate(root)) {
    return false;
  }
  if (root.id === sibling.id) {
    return true;
  }
  // One membership per root for the whole check, however many of its threads are siblings.
  const known = families.get(root.id) ?? threadMembership(bb, entries, root.id).then(({ family }) => family);
  families.set(root.id, known);
  return (await known).has(sibling.id);
}

const workRows = (rows: readonly TimelineRow[]): WorkRow[] =>
  [...walkRows(rows)].filter((row): row is WorkRow => row.kind === "work");

/** The thread ids the rows read, so a delegation is told apart from one that cannot be read through. */
const readableIds = (threads: ReadonlyArray<readonly TimelineRow[]>): Set<string> =>
  new Set(threads.flatMap((rows) => workRows(rows).map((row) => row.threadId)));

/**
 * For each work row of the thread rows given, when the next row of the same
 * thread began. Upstream quirk: a `file-change` row records a start and a
 * status but no `completedAt` at all, and a `tool` row's `completedAt` can be
 * null even once it is done (`bb-plugin-sdk.d.ts`, `timelineFileChangeWorkRowSchema`
 * and `timelineToolWorkRowSchema`), so such a row's end is read as the start of
 * the next row of its thread.
 */
function nextStarts(rows: readonly WorkRow[]): Map<WorkRow, number> {
  const byThread = new Map<string, WorkRow[]>();
  for (const row of rows) {
    byThread.set(row.threadId, [...(byThread.get(row.threadId) ?? []), row]);
  }
  const next = new Map<WorkRow, number>();
  for (const thread of byThread.values()) {
    // Sorted once; walking back, the next later start of a row is its follower's start, or what the follower's was when they began together.
    const sorted = [...thread].sort((a, b) => a.startedAt - b.startedAt);
    let after: number | undefined;
    for (let at = sorted.length - 1; at >= 0; at -= 1) {
      const row = sorted[at] as WorkRow;
      const following = sorted[at + 1];
      after = following === undefined ? undefined : following.startedAt > row.startedAt ? following.startedAt : after;
      if (after !== undefined) {
        next.set(row, after);
      }
    }
  }
  return next;
}

/**
 * The row as the windows read it: a done row of one of `kinds` that records no
 * end ends when the next row of its thread began, and with none keeps no
 * recorded end. A parallel row can start before a tool row's work is over, so
 * the family side bounds only `file-change` rows this way, and a family tool
 * row with a null `completedAt` runs until now; the sibling side bounds both,
 * which only narrows its evidence.
 */
function withEnd(row: WorkRow, next: ReadonlyMap<WorkRow, number>, kinds: readonly string[]): WorkRow {
  const recorded = "completedAt" in row ? row.completedAt : null;
  if (row.status === "pending" || !kinds.includes(row.workKind) || typeof recorded === "number") {
    return row;
  }
  return { ...row, completedAt: next.get(row) ?? null } as WorkRow;
}

/** The turn id of the newest work row of the sibling's own thread, or undefined when none carries one. */
function currentTurnId(work: readonly WorkRow[], threadId: string): string | undefined {
  let newest: WorkRow | undefined;
  for (const row of work) {
    if (row.threadId === threadId && row.turnId !== null && (newest === undefined || row.startedAt > newest.startedAt)) {
      newest = row;
    }
  }
  return newest?.turnId ?? undefined;
}

/** When the sibling's current turn began, as its newest turn row says; undefined when its rows show none. */
function currentTurnStart(rows: readonly TimelineRow[]): number | undefined {
  const starts = rows.flatMap((row) => (row.kind === "turn" ? [row.createdAt] : []));
  return starts.length === 0 ? undefined : Math.max(...starts);
}

/**
 * The windows of the reviewable, completely read siblings' opaque commands. A
 * row with no recorded end gives none, even while it runs: until it ends,
 * nothing of the sibling's own review covers what it writes. A row of another
 * turn than the sibling's newest work row's is stale, and the sibling's own
 * review claims nothing from it. When no row carries a turn id, a row that
 * began before the sibling's newest turn row is stale, and with no turn row
 * either, one that began before this thread's own turn.
 */
async function siblingWindows(input: ChangeTimeInput, sibling: SiblingEvidence, startedAt: number): Promise<TimeWindow[]> {
  const byId = new Map(input.threadEntries.map((entry) => [entry.id, entry]));
  const families = new Map<string, Promise<Set<string>>>();
  const windows: TimeWindow[] = [];
  for (const [threadId, rows] of sibling.rows) {
    if (sibling.complete.get(threadId) !== true || !(await reviewable(input.bb, input.threadEntries, byId, families, threadId))) {
      continue;
    }
    const open = { pending: null, unended: null };
    const readable = readableIds([rows]);
    const work = workRows(rows);
    const next = nextStarts(work);
    const turnId = currentTurnId(work, threadId);
    const floor = currentTurnStart(rows) ?? startedAt;
    for (const row of work) {
      const current = turnId === undefined ? row.startedAt >= floor : row.turnId === turnId;
      const window = rowEffect(row, readable) === "opaque" && current ? rowWindow(withEnd(row, next, ["tool", "file-change"]), open) : null;
      if (window !== null && window.end >= startedAt) {
        windows.push(window);
      }
    }
  }
  return windows;
}

/** The windows of every row of the family that could write, each widened by the margin; undefined when one has no window. */
function familyWindows(threads: ReadonlyArray<readonly TimelineRow[]>, now: number): TimeWindow[] | undefined {
  const readable = readableIds(threads);
  const work = threads.flatMap(workRows);
  const next = nextStarts(work);
  const windows: TimeWindow[] = [];
  for (const row of work) {
    if (rowEffect(row, readable) === "none") {
      continue;
    }
    const window = rowWindow(withEnd(row, next, ["file-change"]), { pending: now, unended: now }, true);
    if (window === null) {
      return undefined;
    }
    windows.push({ start: window.start - FAMILY_MARGIN_MS, end: window.end + FAMILY_MARGIN_MS });
  }
  return windows;
}

interface Checker {
  bb: BbPluginApi;
  environmentId: string;
  fs: ChangeTimeFs;
  root: string;
  realRoot: string;
  sibling: readonly TimeWindow[];
  family: readonly TimeWindow[];
}

/** The times a file's last change left, which both have to fall in a sibling's window. */
interface FileTimes {
  ctimeMs: number;
  mtimeMs: number;
}

/**
 * Whether a regular file under the root last changed only while a sibling's
 * command ran, and still holds the content the working tree shows. Both its
 * change time and its modification time must lie inside a sibling window and
 * outside every family window: a `chmod` moves the change time alone, and
 * `touch` can set the modification time to anything.
 */
async function fileLeftOut(checker: Checker, file: WorkingTreeFile, absolute: string, times: FileTimes): Promise<boolean> {
  const stamps = [times.ctimeMs, times.mtimeMs];
  if (
    !stamps.every((time) => checker.sibling.some((window) => withinWindow(window, time))) ||
    stamps.some((time) => checker.family.some((window) => withinWindow(window, time)))
  ) {
    return false;
  }
  const current = await contentHash(checker.bb, checker.environmentId, file);
  return current !== "" && current === localContentHash(await checker.fs.readRegular(absolute));
}

interface Walk {
  /** Entries seen so far, files and directories alike. */
  visited: number;
  found: Array<FileTimes & { absolute: string; relative: string }>;
}

/** Collects the regular files below a directory into `walk`; false when it holds a link or something else, goes more than 32 levels of directories below the entry, or holds more entries than the cap. */
async function filesBelow(fs: ChangeTimeFs, absolute: string, relative: string, walk: Walk, depth: number): Promise<boolean> {
  if (depth > MAX_DEPTH) {
    return false;
  }
  for (const name of await fs.readdir(absolute)) {
    walk.visited += 1;
    if (walk.visited > MAX_CHECKED) {
      return false;
    }
    const child = join(absolute, name);
    const stat = await fs.lstat(child);
    if (stat.isDirectory()) {
      if (!(await filesBelow(fs, child, `${relative}/${name}`, walk, depth + 1))) {
        return false;
      }
    } else if (stat.isFile()) {
      walk.found.push({ absolute: child, relative: `${relative}/${name}`, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs });
    } else {
      return false;
    }
  }
  return true;
}

/** Whether a changed path, or every file under a changed directory, was changed only while a sibling's command ran. Kept on any doubt. */
async function leftOut(checker: Checker, file: WorkingTreeFile): Promise<boolean> {
  if (file.status === "D") {
    return false;
  }
  const { fs } = checker;
  const relative = file.path.replace(/\/+$/u, "");
  const absolute = join(checker.root, relative);
  const stat = await fs.lstat(absolute);
  const parent = await fs.realpath(dirname(absolute));
  if (stat.isSymbolicLink() || (parent !== checker.realRoot && !parent.startsWith(`${checker.realRoot}${sep}`))) {
    return false;
  }
  if (stat.isFile()) {
    return fileLeftOut(checker, file, absolute, stat);
  }
  if (!stat.isDirectory()) {
    return false;
  }
  const walk: Walk = { visited: 0, found: [] };
  if (!(await filesBelow(fs, absolute, relative, walk, 0)) || walk.found.length === 0) {
    return false;
  }
  const results = await mapLimit(walk.found, HASH_CONCURRENCY, (member) =>
    fileLeftOut(checker, { ...file, path: member.relative }, member.absolute, member),
  );
  return results.every(Boolean);
}

/**
 * The candidate paths that last changed only while an opaque command of a
 * reviewable sibling ran (both the change time and the modification time),
 * with none of this thread's family's commands that could write running then
 * (each window widened by a further second), and whose content on disk is the
 * content the working tree shows. Every path
 * stays with this thread when the evidence is not complete: the turn's start
 * is unknown, the family's timelines or the sibling's could not be read in
 * full, a family row that could write has no end, or the checkout path is
 * unknown. A path also stays when its time or content cannot be read, it is a
 * link or lies outside the checkout, and past the first 200 paths. Logs paths
 * and the class of a read failure, never a command.
 */
export async function pathsLeftToSiblingCommands(input: ChangeTimeInput): Promise<string[]> {
  const { bb, kin, sibling, startedAt } = input;
  if (startedAt === undefined || kin === undefined || !kin.complete || input.ownRowsTruncated || sibling === undefined || input.candidates.length === 0) {
    return [];
  }
  const windows = await siblingWindows(input, sibling, startedAt);
  if (windows.length === 0) {
    return [];
  }
  const root = await checkoutPath(bb, input.environmentId);
  const own = await rowsSince(bb, input.threadId, startedAt - FAMILY_LOOKBACK_MS);
  if (root === null || typeof own === "string") {
    return [];
  }
  const family = familyWindows([own, ...kin.threads], input.now);
  if (family === undefined) {
    return [];
  }
  const fs = input.fs ?? nodeChangeTimeFs;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch (error) {
    bb.log.info(`auto-review: could not place the changes in time: the checkout path cannot be resolved: ${errorClass(error)}`);
    return [];
  }
  const checker: Checker = { bb, environmentId: input.environmentId, fs, root, realRoot, sibling: windows, family };
  const byPath = new Map(input.files.map((file) => [file.path, file]));
  const left: string[] = [];
  await mapLimit(input.candidates.slice(0, MAX_CHECKED), HASH_CONCURRENCY, async (path) => {
    const file = byPath.get(path);
    if (file === undefined) {
      return;
    }
    try {
      if (await leftOut(checker, file)) {
        left.push(path);
      }
    } catch (error) {
      bb.log.info(`auto-review: could not place the change to ${path} in time: ${errorClass(error)}`);
    }
  });
  return input.candidates.filter((path) => left.includes(path));
}
