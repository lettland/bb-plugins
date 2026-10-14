import type { TimelineRow } from "./detect-workspace.js";

export type WorkRow = Extract<TimelineRow, { kind: "work" }>;

export interface TimeWindow {
  start: number;
  end: number;
}

/** Git truncates `authoredAt` to whole seconds, so a window is widened by one on both sides. */
const WINDOW_SLACK_MS = 1_000;

function nestedRows(row: TimelineRow): readonly TimelineRow[] {
  if ("childRows" in row && Array.isArray(row.childRows)) {
    return row.childRows;
  }
  if ("children" in row && Array.isArray(row.children)) {
    return row.children;
  }
  return [];
}

export function* walkRows(
  rows: readonly TimelineRow[],
): Generator<TimelineRow, void, void> {
  for (const row of rows) {
    yield row;
    yield* walkRows(nestedRows(row));
  }
}

/** The shell text of a row that ran one: `command` rows carry it in `command`, search and file-read rows in a nullable `cmd`. */
export function shellText(row: WorkRow): string | null {
  switch (row.workKind) {
    case "command":
      return row.command;
    case "search":
    case "file-read":
      return row.cmd;
    default:
      return null;
  }
}

/** Until when a row with no recorded end is taken to be running; null skips it. */
export interface OpenRowEnds {
  /** A pending row. */
  pending: number | null;
  /** A finished row whose end was not recorded. */
  unended: number | null;
}

/**
 * When a row could have been running, or null when it never ran or no end is
 * known. A row that was denied or is waiting for approval never ran, unless
 * `includeUnapproved` asks for the generous reading the family side takes.
 */
export function rowWindow(
  row: WorkRow,
  open: OpenRowEnds,
  includeUnapproved = false,
): TimeWindow | null {
  if (!includeUnapproved && "approvalStatus" in row && row.approvalStatus !== null) {
    return null;
  }
  let end: number | null = null;
  if (row.status === "pending") {
    end = open.pending;
  } else if ("completedAt" in row) {
    end = row.completedAt ?? open.unended;
  }
  return end === null
    ? null
    : { start: row.startedAt - WINDOW_SLACK_MS, end: end + WINDOW_SLACK_MS };
}

export interface RowText {
  text: string;
  /** Where the row's shell ran; null when the row does not say. */
  cwd: string | null;
}

const MAX_ARGUMENT_DEPTH = 32;

/** The string values anywhere in a tool's arguments, which are what the tool acts on. */
function leafStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (depth >= MAX_ARGUMENT_DEPTH || typeof value !== "object" || value === null) {
    return [];
  }
  return Object.values(value).flatMap((member) => leafStrings(member, depth + 1));
}

/** A path as shell text: itself, and, when it has a blank, once more quoted so it stays one word. */
function pathTexts(path: string): string[] {
  return /[ \t]/u.test(path) && !path.includes("\n") ? [path, `"${path.replace(/["\\$`]/gu, "\\$&")}"`] : [path];
}

/** What a row names besides its shell text: a read's or search's path, a search's query, a tool's string arguments. */
function namedTexts(row: WorkRow): string[] {
  switch (row.workKind) {
    case "file-read":
      return pathTexts(row.path);
    case "search":
      return row.path === null ? [row.query] : [...pathTexts(row.path), row.query];
    case "tool":
      return leafStrings(row.toolArgs).flatMap(pathTexts);
    default:
      return [];
  }
}

/**
 * The texts of the work rows that overlap the turn, which began at
 * `startedAt`: their shell text and its working directory. With
 * `includeUnapproved`, the family side's reading, denied rows count and so do
 * the paths and arguments a row names outside its shell text.
 */
export function rowTexts(
  rows: readonly TimelineRow[],
  startedAt: number,
  open: OpenRowEnds,
  { includeUnapproved }: { includeUnapproved: boolean },
): RowText[] {
  const texts: RowText[] = [];
  for (const row of walkRows(rows)) {
    const window = row.kind === "work" ? rowWindow(row, open, includeUnapproved) : null;
    if (row.kind !== "work" || window === null || window.end < startedAt) {
      continue;
    }
    const shell = shellText(row);
    if (shell !== null) {
      texts.push({ text: shell, cwd: row.workKind === "command" ? row.cwd : null });
    }
    if (includeUnapproved) {
      texts.push(...namedTexts(row).map((text) => ({ text, cwd: null })));
    }
  }
  return texts;
}
