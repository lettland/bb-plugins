import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { rowTexts, rowWindow, shellText, walkRows } from "./detect-rows.js";
import type { OpenRowEnds, RowText, TimeWindow, WorkRow } from "./detect-rows.js";
import { isHistoryWritingGit } from "./detect-shell.js";
import { AUTO_REVIEW_MARKER } from "./prompt.js";
import type {
  ThreadListEntry,
  TimelineResult,
  TimelineRow,
} from "./detect-workspace.js";

export type { TimeWindow };

export async function captureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
): Promise<number> {
  const timeline = await bb.sdk.threads.timeline({ threadId });
  return timeline.maxSeq;
}

/**
 * `captureSinceSeq` for callers that can do without the cursor: a failure is
 * logged, naming what the cursor was for (`purpose`, which also says what is
 * lost without it), and yields undefined instead of throwing.
 */
export async function tryCaptureSinceSeq(
  bb: BbPluginApi,
  threadId: string,
  purpose: string,
): Promise<number | undefined> {
  try {
    return await captureSinceSeq(bb, threadId);
  } catch (error) {
    bb.log.warn(
      `auto-review: could not capture a timeline cursor for ${purpose}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
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

/** The most events one `threads.events.list` page may request; the server rejects a larger `limit`. */
export const EVENT_PAGE_MAX = 100;
/** Bounds the walk through a thread with a very long run of turn requests: 50 pages of 100. */
const TURN_REQUEST_MAX_PAGES = 50;

type TurnRequestData = Extract<
  Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number],
  { type: "client/turn/requested" }
>["data"];

/**
 * The seq of the first (or, with `latest`, the last) turn request after the
 * cursor that `counts` accepts, or null when there is none. The event log is
 * paged, so a long run of wake-up requests could push the one that counts past
 * the first page; this walks the pages, oldest first, and throws if the walk
 * hits its cap rather than answer "none" for a log it did not finish reading.
 */
async function turnRequestSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
  counts: (data: TurnRequestData) => boolean | Promise<boolean>,
  latest = false,
): Promise<number | null> {
  let afterSeq = sinceSeq;
  let found: number | null = null;
  for (let page = 0; page < TURN_REQUEST_MAX_PAGES; page += 1) {
    const events = await bb.sdk.threads.events.list({
      threadId,
      afterSeq: String(afterSeq),
      types: ["client/turn/requested"],
      order: "asc",
      limit: String(EVENT_PAGE_MAX),
    });
    for (const event of events) {
      if (event.type === "client/turn/requested" && (await counts(event.data))) {
        if (!latest) {
          return event.seq;
        }
        found = event.seq;
      }
    }
    const last = events.at(-1);
    if (last === undefined || events.length < EVENT_PAGE_MAX) {
      return found;
    }
    afterSeq = last.seq;
  }
  throw new Error(`more than ${TURN_REQUEST_MAX_PAGES * EVENT_PAGE_MAX} turn requests since seq ${sinceSeq}`);
}

function isUserRequest(data: TurnRequestData): boolean {
  return (
    data.initiator === "user" &&
    !data.input.some((part) => part.type === "text" && part.text.startsWith(AUTO_REVIEW_MARKER))
  );
}

/**
 * The seq of the first turn request the user made after the cursor, or null
 * when there is none. Turns auto-review sent itself carry the user's initiator
 * too, so a request whose text opens with the auto-review marker does not count.
 */
export async function firstUserTurnSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<number | null> {
  return turnRequestSince(bb, threadId, sinceSeq, isUserRequest);
}

/**
 * The seq of the request that started the turn running now, when that turn is
 * the user's: the latest request after the cursor that is not a steer, the
 * user's own or with a steer of the user's after it. Null when there is no such
 * request or the turn is neither. A steer joins the running turn, so it never
 * names the turn's start; nor does an `auto` request of the user's that expects
 * a turn (it steers that turn if it is active, else starts one), which reads as
 * a steer so the anchor stays at the earlier start. A non-user `auto` request is
 * bb's own wake-up in the same shape, and starts a turn once the expected one
 * has ended, so it reads as a turn start.
 */
export async function userTurnRunningSince(
  bb: BbPluginApi,
  threadId: string,
  sinceSeq: number,
): Promise<number | null> {
  let users = false;
  const seq = await turnRequestSince(
    bb,
    threadId,
    sinceSeq,
    (data) => {
      const user = isUserRequest(data);
      if (
        data.target.kind === "steer" ||
        (user && data.target.kind === "auto" && data.target.expectedTurnId !== null)
      ) {
        users ||= user;
        return false;
      }
      users = user;
      return true;
    },
    true,
  );
  return users ? seq : null;
}

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
