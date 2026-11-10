import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { threadMembership, errorClass } from "./detect-attached.js";
import { rowEffect } from "./detect-claim.js";
import { HASH_CONCURRENCY, mapLimit } from "./detect-limit.js";
import { rowWindow, walkRows } from "./detect-rows.js";
import type { TimeWindow, WorkRow } from "./detect-rows.js";
import { checkoutPath } from "./detect-sibling-credit.js";
import { FAMILY_LOOKBACK_MS, rowsSince, withinWindow } from "./detect-timeline.js";
import type { KinEvidence, SiblingEvidence } from "./detect-timeline.js";
import { contentHash, MAX_HASHED_FILES } from "./detect-tree.js";
import type { ThreadListEntry, TimelineRow, WorkingTreeFile } from "./detect-workspace.js";
import { passesThreadGate } from "./gate.js";

/**
 * A path an opaque command of a sibling thread changed, while nothing of this
 * thread's family that can write was running, is that sibling's to review, not
 * this thread's. A sweep (see `claimOwnChanges`) cannot tell it from the
 * family's own write, since the sibling's command text does not name the path.
 * Without positive evidence a path stays with this thread, as it always did.
 * Regression: thr_8rryqyy9me, a thread that changed no file was reviewed
 * because a sibling thread's script wrote one meanwhile.
 */

/** The family's windows are widened by this on both sides, on top of `rowWindow`'s own slack. */
const FAMILY_MARGIN_MS = 1_000;
/** The most paths checked, and the most files one directory entry is expanded to; the rest stays with this thread. */
const MAX_CHECKED = MAX_HASHED_FILES;

/** What the check needs of the file system: injected so a test controls the times. */
export interface ChangeTimeFs {
  lstat: (path: string) => Promise<{ ctimeMs: number; isSymbolicLink: () => boolean; isDirectory: () => boolean; isFile: () => boolean }>;
  realpath: (path: string) => Promise<string>;
  readFile: (path: string) => Promise<Uint8Array>;
  readdir: (path: string) => Promise<string[]>;
}

const nodeFs: ChangeTimeFs = { lstat, realpath, readFile, readdir };

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
  return root.id === sibling.id || (await threadMembership(bb, entries, root.id)).family.has(sibling.id);
}

const workRows = (rows: readonly TimelineRow[]): WorkRow[] =>
  [...walkRows(rows)].filter((row): row is WorkRow => row.kind === "work");

/** The thread ids the rows read, so a delegation is told apart from one that cannot be read through. */
const readableIds = (threads: ReadonlyArray<readonly TimelineRow[]>): Set<string> =>
  new Set(threads.flatMap((rows) => workRows(rows).map((row) => row.threadId)));

/** The windows of the reviewable, completely read siblings' opaque commands. A row with no recorded end gives none, even while it runs: until it ends, nothing of the sibling's own review covers what it writes. */
async function siblingWindows(input: ChangeTimeInput, sibling: SiblingEvidence, startedAt: number): Promise<TimeWindow[]> {
  const byId = new Map(input.threadEntries.map((entry) => [entry.id, entry]));
  const windows: TimeWindow[] = [];
  for (const [threadId, rows] of sibling.rows) {
    if (sibling.complete.get(threadId) !== true || !(await reviewable(input.bb, input.threadEntries, byId, threadId))) {
      continue;
    }
    const open = { pending: null, unended: null };
    const readable = readableIds([rows]);
    for (const row of workRows(rows)) {
      const window = rowEffect(row, readable) === "opaque" ? rowWindow(row, open) : null;
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
  const windows: TimeWindow[] = [];
  for (const row of threads.flatMap(workRows)) {
    if (rowEffect(row, readable) === "none") {
      continue;
    }
    const window = rowWindow(row, { pending: now, unended: now }, true);
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

/** Whether a regular file under the root changed only while a sibling's command ran, and still holds the content the working tree shows. */
async function fileLeftOut(checker: Checker, file: WorkingTreeFile, absolute: string, ctimeMs: number): Promise<boolean> {
  if (!checker.sibling.some((window) => withinWindow(window, ctimeMs)) || checker.family.some((window) => withinWindow(window, ctimeMs))) {
    return false;
  }
  const current = await contentHash(checker.bb, checker.environmentId, file);
  return current !== "" && current === localContentHash(await checker.fs.readFile(absolute));
}

/** Collects the regular files below a directory into `found`; false when it holds a link, something else, or more than the cap. */
async function filesBelow(fs: ChangeTimeFs, absolute: string, relative: string, found: Array<{ absolute: string; relative: string; ctimeMs: number }>): Promise<boolean> {
  for (const name of await fs.readdir(absolute)) {
    const child = join(absolute, name);
    const stat = await fs.lstat(child);
    if (stat.isDirectory()) {
      if (!(await filesBelow(fs, child, `${relative}/${name}`, found))) {
        return false;
      }
    } else if (stat.isFile() && found.length < MAX_CHECKED) {
      found.push({ absolute: child, relative: `${relative}/${name}`, ctimeMs: stat.ctimeMs });
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
    return fileLeftOut(checker, file, absolute, stat.ctimeMs);
  }
  if (!stat.isDirectory()) {
    return false;
  }
  const found: Array<{ absolute: string; relative: string; ctimeMs: number }> = [];
  if (!(await filesBelow(fs, absolute, relative, found)) || found.length === 0) {
    return false;
  }
  const results = await mapLimit(found, HASH_CONCURRENCY, (member) =>
    fileLeftOut(checker, { ...file, path: member.relative }, member.absolute, member.ctimeMs),
  );
  return results.every(Boolean);
}

/**
 * The candidate paths that changed only while an opaque command of a
 * reviewable sibling ran, with none of this thread's family's commands that
 * could write running then (each window widened by a further second), and
 * whose content on disk is the content the working tree shows. Every path
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
  const fs = input.fs ?? nodeFs;
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
