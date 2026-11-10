import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { TimelineResult, TimelineRow } from "./detect-workspace.js";

/** The timeline endpoint's own ceiling; asking for more is rejected with a 400. */
export const AUTHORSHIP_SEGMENT_LIMIT = 100;
/** Bounds the walk back through a very long turn: 50 pages of 100 segments. */
export const AUTHORSHIP_MAX_PAGES = 50;

export interface PagedRows {
  rows: TimelineRow[];
  /** Paging stopped at the page cap while older rows could still matter. */
  truncated: boolean;
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
    const { olderCursor } = timeline.timelinePage;
    if (olderCursor === null || !olderMayMatter(timeline)) {
      return { rows, truncated: false };
    }
    before = olderCursor;
  }
  return { rows, truncated: true };
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

/** How far before the turn a family timeline is paged, so a row that began earlier and still runs is seen. */
export const FAMILY_LOOKBACK_MS = 30 * 60 * 1_000;

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
