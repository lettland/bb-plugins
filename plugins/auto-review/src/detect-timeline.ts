import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rowTexts, rowWindow, shellText, walkRows } from "./detect-rows.js";
import type { OpenRowEnds, RowText, TimeWindow, WorkRow } from "./detect-rows.js";
import { isHistoryWritingGit, mayMoveRemoteRef } from "./detect-shell.js";
import type {
  ThreadListEntry,
  TimelineResult,
  TimelineRow,
} from "./detect-workspace.js";

export type { TimeWindow };

/** The timeline endpoint's own ceiling; asking for more is rejected with a 400. */
export const AUTHORSHIP_SEGMENT_LIMIT = 100;
/** Bounds the walk back through a very long turn: 50 pages of 100 segments. */
export const AUTHORSHIP_MAX_PAGES = 50;

type FileChangeRow = Extract<TimelineRow, { kind: "work"; workKind: "file-change" }>;

/** Collects both sides of a move for every `file-change` row the filter keeps. */
function addChangedPaths(
  rows: readonly TimelineRow[],
  keep: (row: FileChangeRow) => boolean,
  paths: Set<string>,
): void {
  for (const row of walkRows(rows)) {
    if (row.kind === "work" && row.workKind === "file-change" && keep(row)) {
      paths.add(row.change.path);
      if (row.change.movePath !== null) {
        paths.add(row.change.movePath);
      }
    }
  }
}

export function authoredPathsFromRows(
  rows: readonly TimelineRow[],
  sinceSeq: number,
): string[] {
  const paths = new Set<string>();
  addChangedPaths(rows, (row) => row.sourceSeqStart > sinceSeq, paths);
  return [...paths];
}

interface PagedRows {
  rows: TimelineRow[];
  /** Paging stopped at the page cap while older rows could still matter. */
  truncated: boolean;
}

/**
 * Pages back from the latest segment until the page boundary falls at or before
 * the turn-start cursor, so a long turn is not truncated to its last segments.
 */
export async function turnTimeline(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<PagedRows> {
  return recentTimelineRows(bb, threadId, (timeline) => {
    const { olderRowsSourceSeqEnd } = timeline.timelinePage;
    return (
      olderRowsSourceSeqEnd === undefined ||
      olderRowsSourceSeqEnd === null ||
      olderRowsSourceSeqEnd > sinceSeq
    );
  });
}

export async function authoredPaths(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<string[]> {
  return authoredPathsFromRows((await turnTimeline(bb, threadId, sinceSeq)).rows, sinceSeq);
}

/**
 * Pages a thread's timeline back from the latest segment for as long as
 * `olderMayMatter` says the next older page can still hold relevant rows.
 */
export async function recentTimelineRows(
  bb: BbPluginApi,
  threadId: string,
  olderMayMatter: (timeline: TimelineResult) => boolean,
): Promise<PagedRows> {
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
      return { rows, truncated: false };
    }
    before = olderCursor;
  }
  return { rows, truncated: true };
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

function oldestCreatedAt(rows: readonly TimelineRow[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    if ("createdAt" in row && typeof row.createdAt === "number") {
      oldest = oldest === null ? row.createdAt : Math.min(oldest, row.createdAt);
    }
  }
  return oldest;
}

/** Whether a page can still hold rows from the turn: its oldest row is inside it, or no row carries a time. */
export function pageInTurn(startedAt: number): (timeline: TimelineResult) => boolean {
  return (timeline) => {
    const oldest = oldestCreatedAt(timeline.rows);
    return oldest === null || oldest >= startedAt;
  };
}

export interface SiblingWindow extends TimeWindow {
  threadId: string;
}

/** Whether a time falls inside a window. */
export function withinWindow(window: TimeWindow, time: number): boolean {
  return time >= window.start && time <= window.end;
}

function runsHistoryGit(row: WorkRow): boolean {
  const text = shellText(row);
  return text !== null && isHistoryWritingGit(text);
}

function movesRemoteRef(row: WorkRow): boolean {
  const text = shellText(row);
  return text !== null && mayMoveRemoteRef(text);
}

/** The windows of the wanted rows that overlap the turn, which began at `startedAt`. */
function overlappingWindows(
  rows: readonly TimelineRow[],
  startedAt: number,
  open: OpenRowEnds,
  wanted: (row: WorkRow) => boolean,
): TimeWindow[] {
  const windows: TimeWindow[] = [];
  for (const row of walkRows(rows)) {
    if (row.kind !== "work" || !wanted(row)) {
      continue;
    }
    const window = rowWindow(row, open);
    if (window !== null && window.end >= startedAt) {
      windows.push(window);
    }
  }
  return windows;
}

/**
 * Every window this thread's own work rows of any kind overlapped the turn. A
 * row that never recorded an end is taken to be running until `now`.
 */
export function ownWindows(
  rows: readonly TimelineRow[],
  startedAt: number,
  now: number,
): TimeWindow[] {
  return overlappingWindows(rows, startedAt, { pending: now, unended: now }, () => true);
}

/**
 * Whether any of these rows ran shell that may have moved a remote-tracking
 * ref between `since` and `now`. A row that never recorded an end is taken to
 * be running until `now`; one that was denied or is waiting for approval never
 * ran.
 */
export function mayHaveMovedRemoteRef(rows: readonly TimelineRow[], since: number, now: number): boolean {
  return overlappingWindows(rows, since, { pending: now, unended: now }, movesRemoteRef).length > 0;
}

export interface SiblingEvidence {
  /** Paths siblings changed through their own tools. */
  paths: Set<string>;
  /** When a sibling ran git that writes history. */
  commitWindows: SiblingWindow[];
  /** The shell text of the sibling rows that ran during the turn. */
  texts: Array<RowText & { threadId: string }>;
  /** Per sibling, whether its timeline was read in full; a sibling that was not credits nothing. */
  complete: Map<string, boolean>;
}

/**
 * What other threads in the same checkout did since `startedAt`: the paths
 * they changed through their own tools, when they ran git that writes
 * history, and the shell text of the rows that ran. A thread that has been
 * idle and untouched since before the turn began cannot have done any of it,
 * so its timeline is not read.
 */
export async function siblingAuthoredPaths(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
  startedAt: number,
): Promise<SiblingEvidence> {
  const own = ownThreadIds(entries, selfThreadId);
  const siblings = entries.filter(
    (entry) =>
      !own.has(entry.id) &&
      entry.deletedAt === null &&
      (entry.status !== "idle" || entry.updatedAt >= startedAt),
  );
  const now = Date.now();
  const paths = new Set<string>();
  const commitWindows: SiblingWindow[] = [];
  const texts: SiblingEvidence["texts"] = [];
  const complete = new Map<string, boolean>();
  for (const sibling of siblings) {
    let rows: TimelineRow[];
    try {
      const paged = await recentTimelineRows(bb, sibling.id, pageInTurn(startedAt));
      rows = paged.rows;
      complete.set(sibling.id, !paged.truncated);
    } catch {
      // Gone since it was listed; it has nothing left to review.
      complete.set(sibling.id, false);
      continue;
    }
    addChangedPaths(rows, (row) => row.createdAt >= startedAt, paths);
    // A pending row of an idle thread is left over from a crash or a restart.
    const open = { pending: sibling.status === "idle" ? null : now, unended: null };
    for (const window of overlappingWindows(rows, startedAt, open, runsHistoryGit)) {
      commitWindows.push({ threadId: sibling.id, ...window });
    }
    for (const text of rowTexts(rows, startedAt, open, { includeUnapproved: false })) {
      texts.push({ threadId: sibling.id, ...text });
    }
  }
  return { paths, commitWindows, texts, complete };
}

/** How far before the turn a family timeline is paged, so a row that began earlier and still runs is seen. */
export const FAMILY_LOOKBACK_MS = 30 * 60 * 1_000;

export interface KinEvidence {
  /** Paths this thread's bb children and owned threads changed through their own tools. */
  paths: Set<string>;
  windows: TimeWindow[];
  /** The text of the rows that overlapped the turn, as the family side reads them. */
  texts: RowText[];
  /** The rows of each of those threads back to the lookback, for the claim side to classify; a thread's shell keeps its directory across its own rows only. */
  threads: TimelineRow[][];
  /** False when a thread could not be read in full; nothing it did can be ruled out. */
  complete: boolean;
}

/**
 * What this thread's bb children and owned threads, transitively, did since
 * `startedAt`. Deleted ones are read too: their work is this thread's.
 */
export async function kinEvidence(
  bb: BbPluginApi,
  entries: readonly ThreadListEntry[],
  selfThreadId: string,
  startedAt: number,
  now: number,
): Promise<KinEvidence> {
  const own = ownThreadIds(entries, selfThreadId);
  const kin = entries.filter(
    (entry) =>
      entry.id !== selfThreadId &&
      own.has(entry.id) &&
      (entry.status !== "idle" || entry.updatedAt >= startedAt),
  );
  const evidence: KinEvidence = { paths: new Set(), windows: [], texts: [], threads: [], complete: true };
  for (const thread of kin) {
    try {
      const { rows, truncated } = await recentTimelineRows(
        bb,
        thread.id,
        pageInTurn(startedAt - FAMILY_LOOKBACK_MS),
      );
      evidence.complete &&= !truncated;
      evidence.threads.push(rows);
      addChangedPaths(rows, (row) => row.createdAt >= startedAt, evidence.paths);
      evidence.windows.push(...ownWindows(rows, startedAt, now));
      evidence.texts.push(
        ...rowTexts(rows, startedAt, { pending: now, unended: now }, { includeUnapproved: true }),
      );
    } catch {
      evidence.complete = false;
    }
  }
  return evidence;
}

/** The thread's rows back to `since`, or why they cannot be had. */
export async function rowsSince(
  bb: BbPluginApi,
  threadId: string,
  since: number,
): Promise<TimelineRow[] | string> {
  try {
    const { rows, truncated } = await recentTimelineRows(bb, threadId, pageInTurn(since));
    return truncated ? "the thread's timeline back to the earliest commit is truncated" : rows;
  } catch {
    return "the thread's earlier timeline could not be read";
  }
}
