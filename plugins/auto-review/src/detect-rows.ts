import type { TimelineRow } from "./detect-workspace.js";

export type WorkRow = Extract<TimelineRow, { kind: "work" }>;

export interface TimeWindow {
  start: number;
  end: number;
}

/** Git truncates `authoredAt` to whole seconds, so a window is widened by one on both sides. */
const WINDOW_SLACK_MS = 1_000;

/** The rows a row holds: a delegation's `childRows`, a turn's `children`. */
export function nestedRows(row: TimelineRow): readonly TimelineRow[] {
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
  /** The text is shell the row ran, or a tool string with whitespace; any other text only names things. */
  shell: boolean;
}

const MAX_ARGUMENT_DEPTH = 32;

/** The strings anywhere in a tool's arguments, which are what the tool acts on: its string values and its object keys (`{files: {"src/a.ts": "…"}}`). */
export function leafStrings(value: unknown, depth = 0): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (depth >= MAX_ARGUMENT_DEPTH || typeof value !== "object" || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((member) => leafStrings(member, depth + 1));
  }
  return Object.entries(value).flatMap(([key, member]) => [key, ...leafStrings(member, depth + 1)]);
}

/** The fields a tool that runs a shell is given its command in. */
const SHELL_KEYS: ReadonlySet<string> = new Set(["command", "cmd", "script", "code"]);

/** A word of an argument vector as a shell line takes it: quoted unless it is plain. */
const quoted = (word: string) => (/^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/** The shell lines of a tool's arguments: each `command`, `cmd`, `script` or `code` field anywhere in them, an array of words (`["bash", "-lc", "npm run codegen"]`) joined into one line. */
export function shellFields(value: unknown, depth = 0): string[] {
  if (depth >= MAX_ARGUMENT_DEPTH || typeof value !== "object" || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((member) => shellFields(member, depth + 1));
  }
  return Object.entries(value).flatMap(([key, member]) => {
    if (!SHELL_KEYS.has(key)) {
      return shellFields(member, depth + 1);
    }
    const words = Array.isArray(member) && member.length > 0 && member.every((word) => typeof word === "string");
    return typeof member === "string" ? [member] : words ? [(member as string[]).map(quoted).join(" ")] : shellFields(member, depth + 1);
  });
}

/** What a row names besides its shell text: a read's or search's path, a search's query, a tool's string arguments. A tool argument with whitespace is read as shell as well; a single token only names. */
function namedTexts(row: WorkRow): Array<{ text: string; shell: boolean }> {
  const names = (texts: readonly string[]) => texts.map((text) => ({ text, shell: false }));
  switch (row.workKind) {
    case "file-read":
      return names([row.path]);
    case "search":
      return names(row.path === null ? [row.query] : [row.path, row.query]);
    case "tool":
      return leafStrings(row.toolArgs).flatMap((text) => [{ text, shell: false }, ...(/\s/u.test(text) ? [{ text, shell: true }] : [])]);
    default:
      return [];
  }
}

/**
 * The texts of the work rows that overlap the turn, which began at
 * `startedAt`: their shell text and its working directory. With
 * `includeUnapproved`, the family side's reading, denied rows count and so do
 * the paths and arguments a row names outside its shell text, which only name
 * things (`shell` is false); a tool argument with whitespace is also listed as shell.
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
      texts.push({ text: shell, cwd: row.workKind === "command" ? row.cwd : null, shell: true });
    }
    if (includeUnapproved) {
      texts.push(...namedTexts(row).map((named) => ({ ...named, cwd: null })));
    }
  }
  return texts;
}
