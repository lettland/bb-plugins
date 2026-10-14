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
  /** The text is shell the row ran, or a string that reads as a command line; any other text only names things. */
  shell: boolean;
}

/** Commands whose name at the start of a tool argument with blanks makes it a command line. */
const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "bunx", "npx", "make", "cargo", "go", "uv", "uvx", "poetry", "pipenv",
  "python", "python3", "node", "deno", "ruby", "perl", "php", "tsx", "ts-node", "bash", "sh", "zsh", "dash", "ksh",
  "env", "cross-env", "sudo", "time", "timeout", "nohup", "exec", "eval", "xargs", "find", "fd", "sed", "rm", "mv",
  "cp", "tee", "install", "patch", "rsync", "tar", "unzip", "prettier", "eslint", "jest", "vitest", "black", "isort",
  "ruff", "gofmt",
]);

/** A tool argument that holds a command line: it has a blank and starts with a known command. A single token never does. */
function readsAsCommand(text: string): boolean {
  const [first, second] = text.trimStart().split(/\s+/u, 2);
  return second !== undefined && first !== undefined && COMMAND_WORDS.has(first.replace(/^.*\//u, ""));
}

const MAX_ARGUMENT_DEPTH = 32;

/** The strings anywhere in a tool's arguments, which are what the tool acts on: its string values and its object keys (`{files: {"src/a.ts": "…"}}`). */
function leafStrings(value: unknown, depth = 0): string[] {
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

/** What a row names besides its shell text: a read's or search's path, a search's query, a tool's string arguments. Only a tool argument that reads as a command line is shell. */
function namedTexts(row: WorkRow): Array<{ text: string; shell: boolean }> {
  const names = (texts: readonly string[]) => texts.map((text) => ({ text, shell: false }));
  switch (row.workKind) {
    case "file-read":
      return names([row.path]);
    case "search":
      return names(row.path === null ? [row.query] : [row.path, row.query]);
    case "tool":
      return leafStrings(row.toolArgs).map((text) => ({ text, shell: readsAsCommand(text) }));
    default:
      return [];
  }
}

/**
 * The texts of the work rows that overlap the turn, which began at
 * `startedAt`: their shell text and its working directory. With
 * `includeUnapproved`, the family side's reading, denied rows count and so do
 * the paths and arguments a row names outside its shell text, which only name
 * things (`shell` is false) unless a tool argument reads as a command line.
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
