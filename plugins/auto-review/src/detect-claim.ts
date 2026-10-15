/**
 * What the thread's family (the thread and its bb children and owned threads)
 * ran during a turn, read to claim only the working-tree changes it made. The
 * turn is attributed one of two ways. Exact: every command the family ran is
 * read-only or names every file it writes, so exactly the named files are its
 * own. Sweep: something ran whose writes cannot be listed (a build, a script, a
 * command nobody classified), so every unattributed change is taken to be the
 * turn's, as it always was. Any doubt is a sweep.
 */

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { classifyText } from "./detect-claim-shell.js";
import type { DirectoryStep, NamedWrite } from "./detect-claim-shell.js";
import { globMatcher, isGlob } from "./detect-globs.js";
import { leafStrings, rowWindow, walkRows } from "./detect-rows.js";
import type { OpenRowEnds, TimeWindow, WorkRow } from "./detect-rows.js";
import { checkoutPath } from "./detect-sibling-credit.js";
import { movedTo, segmentsOf } from "./detect-sibling-writes.js";
import { FAMILY_LOOKBACK_MS, kinEvidence, rowsSince, withinWindow } from "./detect-timeline.js";
import type { KinEvidence } from "./detect-timeline.js";
import type { ThreadListEntry, TimelineRow } from "./detect-workspace.js";

/** Rows that only read, look something up or ask, whatever they carry. */
const INERT_KINDS: ReadonlySet<string> = new Set([
  "file-change", "file-read", "search", "web-search", "web-fetch", "image-view", "plan-steps", "approval", "form", "question", "delegation",
]);
/** Tools that only read, look things up or keep their own state, by name as real timelines carry them. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "Read", "fetch", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch", "Skill", "ScheduleWakeup", "TaskOutput",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "advisor_review", "bb_keep_checkout", "ListMcpResourcesTool",
  "ReadMcpResourceTool", "ReadMcpResourceDirTool", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
  "SendMessage", "ListAgents", "CronCreate", "CronDelete", "CronList", "PushNotification",
]);
const READ_ONLY_PREFIXES: readonly string[] = [
  "devkit_", "agent_checklist_", "progressive_skill_", "mcp__bb-bridge__", "mcp__claude-in-chrome__read_",
  "mcp__claude-in-chrome__get_", "mcp__claude-in-chrome__tabs_context", "mcp__claude-in-chrome__find",
];

/** A tool row that is not known to be read-only. */
interface ToolUse {
  tool: string;
  /** Its argument strings. */
  names: string[];
  /** A string of it was read as a shell command that is neither opaque nor a write; it says what it did. */
  shell: boolean;
}

/** A command's writes, with the directory its shell ran in. */
export interface RowWrite extends NamedWrite {
  cwd: string | null;
}

export interface FamilyClaims {
  /** The program of the first row whose writes cannot be listed; undefined when every write is named. */
  opaque: string | undefined;
  /** What the targeted commands write. */
  writes: RowWrite[];
  /** The strings tool rows were given, which name the paths they act on. */
  names: string[];
  /** The tool rows that are not on the read-only list, each of which must claim a changed path or be read as a shell command, or the turn is a sweep. */
  tools: ToolUse[];
  /** When an opaque command or a tool ran: a commit authored then may be the family's. */
  windows: TimeWindow[];
  /** The family ran git that writes history. */
  history: boolean;
  /** Programs of opaque rows that began before the turn and were still open at its end; they claim nothing. */
  stale: string[];
}

const isReadOnlyTool = (toolName: string) =>
  READ_ONLY_TOOLS.has(toolName) || READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));

/** Whether a row had begun before the turn and had recorded no end by its idle. */
function isStale(row: WorkRow, startedAt: number): boolean {
  const open = row.status === "pending" || ("completedAt" in row && row.completedAt === null);
  return open && row.startedAt < startedAt;
}

interface RowReading {
  opaque: string | undefined;
  writes: NamedWrite[];
  names: string[];
  /** The row ran something, so a commit authored while it ran may be the family's. */
  runs: boolean;
  history: boolean;
  tool: ToolUse | undefined;
}

const quiet = (): RowReading => ({ opaque: undefined, writes: [], names: [], runs: false, history: false, tool: undefined });

/** A tool row: an allowlisted read-only tool claims nothing; any other claims the paths its argument strings name and is read as shell where a string has whitespace; one with no argument string is opaque, and one that claims no changed path and is not read as a command sweeps the turn (see `resolveClaims`). */
function readToolRow(toolName: string, toolArgs: unknown): RowReading {
  const reading: RowReading = { ...quiet(), runs: true };
  if (isReadOnlyTool(toolName)) {
    return reading;
  }
  const strings = leafStrings(toolArgs);
  if (strings.length === 0) {
    return { ...reading, opaque: toolName };
  }
  reading.names = strings;
  let shell = false;
  for (const text of strings.filter((string) => /\s/u.test(string))) {
    const claims = classifyText(text);
    reading.opaque ??= claims.opaque;
    reading.writes.push(...claims.writes);
    reading.history ||= claims.history;
    shell ||= claims.opaque === undefined;
  }
  return { ...reading, tool: { tool: toolName, names: strings, shell } };
}

function readRow(row: WorkRow): RowReading & { cwd: string | null } {
  if (row.workKind === "command") {
    const claims = classifyText(row.command);
    return { ...quiet(), ...claims, cwd: row.cwd, runs: claims.opaque !== undefined };
  }
  if (row.workKind === "tool") {
    return { ...readToolRow(row.toolName, row.toolArgs), cwd: null };
  }
  const reading = INERT_KINDS.has(row.workKind) ? quiet() : { ...quiet(), opaque: row.workKind, runs: true };
  return { ...reading, cwd: null };
}

/**
 * Classifies the work rows that ran during the turn, which began at
 * `startedAt`: rows that never ran (denied, waiting for approval) are left out,
 * and a row that recorded no end is taken to have run until `now`.
 */
export function classifyRows(rows: readonly TimelineRow[], startedAt: number, now: number): FamilyClaims {
  const open: OpenRowEnds = { pending: now, unended: now };
  const claims: FamilyClaims = { opaque: undefined, writes: [], names: [], tools: [], windows: [], history: false, stale: [] };
  for (const row of walkRows(rows)) {
    const window = row.kind === "work" ? rowWindow(row, open) : null;
    if (row.kind !== "work" || window === null || window.end < startedAt) {
      continue;
    }
    const reading = readRow(row);
    claims.history ||= reading.history;
    if (reading.opaque !== undefined && isStale(row, startedAt)) {
      claims.stale.push(reading.opaque);
      continue;
    }
    claims.opaque ??= reading.opaque;
    claims.names.push(...reading.names);
    if (reading.tool !== undefined && !isStale(row, startedAt)) {
      claims.tools.push(reading.tool);
    }
    claims.writes.push(...reading.writes.map((write) => ({ ...write, cwd: reading.cwd })));
    if (reading.runs) {
      claims.windows.push(window);
    }
  }
  return claims;
}

interface FamilyInput {
  bb: BbPluginApi;
  threadId: string;
  threadEntries: readonly ThreadListEntry[];
  startedAt: number;
  now: number;
  ownRowsTruncated: boolean;
  /** The kin evidence already read for the turn, when there was one. */
  kin: KinEvidence | undefined;
}

/** What the family ran during the turn, or why that could not be read in full (which makes the turn a sweep). */
export async function familyClaims(input: FamilyInput): Promise<{ claims: FamilyClaims; kin: KinEvidence } | { reason: string }> {
  const { bb, threadId, startedAt, now } = input;
  if (input.ownRowsTruncated) {
    return { reason: `the timeline of thread ${threadId} is truncated` };
  }
  const own = await rowsSince(bb, threadId, startedAt - FAMILY_LOOKBACK_MS);
  if (typeof own === "string") {
    return { reason: `thread ${threadId}: ${own}` };
  }
  const kin = input.kin ?? (await kinEvidence(bb, input.threadEntries, threadId, startedAt, now));
  if (!kin.complete) {
    return { reason: "a thread this one spawned or owns could not be read in full" };
  }
  return { claims: classifyRows([...own, ...kin.rows], startedAt, now), kin };
}

/** Whether a tool's argument string names a changed path: it is the path, or ends in `/` and the path (an absolute path to it). */
const namesPath = (name: string, path: string) =>
  name === path || name === `./${path}` || (name.length > path.length && name.endsWith(`/${path}`));

/** Where a command's relative tokens resolve: its own cwd, else the checkout root; null once a `cd` left somewhere that is not the root. */
function baseOf(cwd: string | null, steps: readonly DirectoryStep[], root: string): string | null {
  let dir: string | null = cwd === null || cwd === "" ? root : cwd.startsWith("/") ? cwd : `${root}/${cwd}`;
  for (const { name, target } of steps) {
    dir = name === "popd" ? null : movedTo(dir, target, root);
  }
  return dir;
}

/** A write target as a path relative to the checkout: "" for the checkout itself, null outside it. */
function repoRelative(token: string, base: string, root: string): string | null {
  const segments = segmentsOf(token.startsWith("/") ? token : `${base}/${token}`);
  const rootSegments = segmentsOf(root);
  return rootSegments.every((segment, at) => segments[at] === segment) ? segments.slice(rootSegments.length).join("/") : null;
}

/** Whether a path is a claimed target, lies under it (a directory), or a glob matches it or a directory above it. */
function claimsPath(target: string, path: string): boolean {
  if (target === "") {
    return true;
  }
  if (!isGlob(target)) {
    return path === target || path.startsWith(`${target}/`);
  }
  const matches = globMatcher(target);
  const segments = path.split("/");
  return segments.some((_segment, at) => matches(segments.slice(0, at + 1).join("/")));
}

interface Resolution {
  /** The candidates the family's tool rows and targeted commands claim. */
  claimed: Set<string>;
  /** Why the writes could not be resolved, which makes the turn a sweep. */
  sweep: string | undefined;
}

/**
 * Which of `candidates` (paths relative to the checkout) the family claims:
 * those a tool row's argument names, and those a targeted command writes, a
 * directory it names claiming everything under it. A tool that is not read-only,
 * names no changed path and was not read as a command could have written
 * anything, so it is a sweep, naming the tool. The checkout root is read
 * only when a command wrote something by name; it is a sweep when it is
 * unknown, or when a command wrote after a `cd` that did not return to the root.
 */
export async function resolveClaims(
  bb: BbPluginApi,
  environmentId: string,
  family: FamilyClaims,
  candidates: readonly string[],
): Promise<Resolution> {
  const claimed = new Set(candidates.filter((path) => family.names.some((name) => namesPath(name, path))));
  const unlisted = family.tools.find(
    ({ names, shell }) => !shell && !candidates.some((path) => names.some((name) => namesPath(name, path))),
  );
  if (unlisted !== undefined && candidates.length > 0) {
    return { claimed, sweep: `the ${unlisted.tool} tool named no changed path` };
  }
  if (family.writes.length === 0 || candidates.length === 0) {
    return { claimed, sweep: undefined };
  }
  const root = await checkoutPath(bb, environmentId);
  if (root === null) {
    return { claimed, sweep: "the checkout path is unknown" };
  }
  const base = root.replace(/\/+$/u, "");
  for (const { tokens, steps, cwd } of family.writes) {
    const dir = baseOf(cwd, steps, base);
    if (dir === null) {
      return { claimed, sweep: "a command wrote after a cd that left the checkout root" };
    }
    for (const target of tokens.flatMap((token) => repoRelative(token, dir, base) ?? [])) {
      candidates.filter((path) => claimsPath(target, path)).forEach((path) => claimed.add(path));
    }
  }
  return { claimed, sweep: undefined };
}

/** A commit made during the turn, as `turnChangedPaths` reads it. */
export interface CommitFacts {
  sha: string;
  paths: string[] | null;
  authoredAt: number | null;
}

/**
 * Why a commit is not the family's, or null when it is, or may be. It is the
 * family's when the family ran git that writes history, when it was authored
 * while an opaque command or a tool ran, when its date or paths are unknown,
 * or when it touches a path the family claims.
 */
export function strayCommitReason(commit: CommitFacts, family: FamilyClaims, familyPaths: ReadonlySet<string>): string | null {
  const { authoredAt, paths } = commit;
  if (
    family.history ||
    authoredAt === null ||
    paths === null ||
    family.windows.some((window) => withinWindow(window, authoredAt)) ||
    paths.some((path) => familyPaths.has(path))
  ) {
    return null;
  }
  return "the family ran no git that writes history, and no command or tool of theirs was running then";
}
