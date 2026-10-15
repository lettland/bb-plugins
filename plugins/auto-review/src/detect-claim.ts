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

import { classifyText, isScratch, isUnresolved, opaqueProgram } from "./detect-claim-shell.js";
import type { DirectoryStep, NamedWrite } from "./detect-claim-shell.js";
import { leafStrings, nestedRows, rowWindow, shellFields, walkRows } from "./detect-rows.js";
import type { OpenRowEnds, TimeWindow, WorkRow } from "./detect-rows.js";
import { checkoutPath } from "./detect-sibling-credit.js";
import { claimsPath, repoRelative, segmentsOf, shellDirectory } from "./detect-sibling-writes.js";
import { FAMILY_LOOKBACK_MS, kinEvidence, rowsSince, withinWindow } from "./detect-timeline.js";
import type { KinEvidence } from "./detect-timeline.js";
import type { ThreadListEntry, TimelineRow } from "./detect-workspace.js";

/** Rows that only read, look something up or ask, whatever they carry. A delegation is not one: it is read through its nested rows (see `readsDelegation`). */
const INERT_KINDS: ReadonlySet<string> = new Set([
  "file-change", "file-read", "search", "web-search", "web-fetch", "image-view", "plan-steps", "approval", "form", "question",
]);
/** The bridge tools that do not write the checkout: they read, look things up or keep their own state. Registered by the plugins under `plugins/*`; the runtime tools that run commands or git are left out on purpose. */
const BRIDGE_READ_ONLY_TOOLS: readonly string[] = [
  "advisor_review", "devkit_find_skills", "devkit_load_skill", "devkit_docs", "agent_checklist_get", "agent_checklist_update",
  "progressive_skill_list", "progressive_skill_used", "runtime_search", "runtime_thread", "runtime_skill_resource",
  "platform_search", "platform_thread", "platform_plugin_resource", "ReportReview", "PresentPlan",
  "update_environment_directory", "bb_keep_checkout",
];
const BRIDGE_PREFIX = "mcp__bb-bridge__";
/** Tools that only read, look things up or keep their own state, by name as real timelines carry them. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "read", "Read", "fetch", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch", "Skill", "ScheduleWakeup", "TaskOutput",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ListMcpResourcesTool",
  "ReadMcpResourceTool", "ReadMcpResourceDirTool", "TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop",
  "SendMessage", "ListAgents", "CronCreate", "CronDelete", "CronList", "PushNotification",
  ...BRIDGE_READ_ONLY_TOOLS,
  ...BRIDGE_READ_ONLY_TOOLS.map((name) => `${BRIDGE_PREFIX}${name}`),
]);
const READ_ONLY_PREFIXES: readonly string[] = [
  "mcp__claude-in-chrome__read_", "mcp__claude-in-chrome__get_", "mcp__claude-in-chrome__tabs_context", "mcp__claude-in-chrome__find",
];

/** A tool row that is not known to be read-only. */
interface ToolUse {
  tool: string;
  /** Its argument strings. */
  names: string[];
  /** A `command` or `cmd` field of it was read as a shell command that is not opaque; it says what it did. */
  shell: boolean;
}

/** A command's writes, with the directory its shell began in and the changes made before the write. */
export interface RowWrite extends NamedWrite {
  /** Where the shell was when the row began: the row's own cwd, else where the thread's earlier rows left it; empty or null when that is unknown. */
  cwd: string | null;
}

export interface FamilyClaims {
  /** The program of the first row whose writes cannot be listed; undefined when every write is named. */
  opaque: string | undefined;
  /** What the targeted commands write. */
  writes: RowWrite[];
  /** What commands wrote to scratch space, which counts only when the checkout lies there. */
  scratch: RowWrite[];
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

/** Where a command row's shell began, and the directory changes since that point. */
interface Origin {
  cwd: string | null;
  steps: DirectoryStep[];
}

interface RowReading {
  opaque: string | undefined;
  writes: RowWrite[];
  scratch: RowWrite[];
  names: string[];
  /** The row ran something, so a commit authored while it ran may be the family's. */
  runs: boolean;
  history: boolean;
  tool: ToolUse | undefined;
  /** Where the row left its shell, for the rows after it; undefined for a row that has no shell of its own. */
  left: Origin | undefined;
}

const quiet = (): RowReading => ({
  opaque: undefined, writes: [], scratch: [], names: [], runs: false, history: false, tool: undefined, left: undefined,
});

/** A write as the row ran it: from where its shell began (`origin`), after the changes made before it. */
const writtenFrom = (write: NamedWrite, origin: Origin): RowWrite => ({
  ...write,
  cwd: origin.cwd,
  steps: [...origin.steps, ...write.steps],
});

/**
 * A tool row: an allowlisted read-only tool claims nothing; any other claims
 * the paths its argument strings name, and a `command` or `cmd` field of it is
 * read as shell, never any other string (a `description` is prose). One with no
 * argument string is opaque, and one that claims no changed path and was not
 * read as a command sweeps the turn (see `resolveClaims`).
 */
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
  const commands = shellFields(toolArgs);
  // Any other string with whitespace is prose or content, unless it opens with a program that is opaque by name.
  for (const text of strings.filter((string) => /\s/u.test(string) && !commands.includes(string))) {
    reading.opaque ??= opaqueProgram(text);
  }
  const origin: Origin = { cwd: null, steps: [] };
  for (const text of commands) {
    const claims = classifyText(text);
    reading.opaque ??= claims.opaque;
    reading.writes.push(...claims.writes.map((write) => writtenFrom(write, origin)));
    reading.scratch.push(...claims.scratch.map((write) => writtenFrom(write, origin)));
    reading.history ||= claims.history;
  }
  return { ...reading, tool: { tool: toolName, names: strings, shell: commands.length > 0 } };
}

/** Where a command row's shell began: its own cwd when it records one, else where the thread's earlier rows left it. */
function originOf(cwd: string | null, left: Origin | undefined): Origin {
  return cwd !== null && cwd !== "" ? { cwd, steps: [] } : (left ?? { cwd, steps: [] });
}

function readCommandRow(command: string, cwd: string | null, left: Origin | undefined): RowReading {
  const claims = classifyText(command);
  const origin = originOf(cwd, left);
  return {
    ...quiet(),
    opaque: claims.opaque,
    writes: claims.writes.map((write) => writtenFrom(write, origin)),
    scratch: claims.scratch.map((write) => writtenFrom(write, origin)),
    history: claims.history,
    runs: claims.opaque !== undefined,
    left: { cwd: origin.cwd, steps: [...origin.steps, ...claims.left] },
  };
}

/** Whether a delegation can be read through: it has nested work rows, or its child is a thread whose rows were read. Otherwise nothing shows what the subagent ran. */
function readsDelegation(row: Extract<WorkRow, { workKind: "delegation" }>, readable: ReadonlySet<string>): boolean {
  return [...walkRows(row.childRows)].some((nested) => nested.kind === "work") || (row.childRef !== null && readable.has(row.childRef));
}

function readRow(row: WorkRow, left: Origin | undefined, readable: ReadonlySet<string>): RowReading {
  switch (row.workKind) {
    case "command":
      return readCommandRow(row.command, row.cwd, left);
    case "tool":
      return readToolRow(row.toolName, row.toolArgs);
    case "delegation":
      return readsDelegation(row, readable) ? quiet() : { ...quiet(), opaque: "delegation", runs: true };
    default:
      return INERT_KINDS.has(row.workKind) ? quiet() : { ...quiet(), opaque: row.workKind, runs: true };
  }
}

interface Pass {
  claims: FamilyClaims;
  startedAt: number;
  open: OpenRowEnds;
  /** The threads whose rows are being read. */
  readable: ReadonlySet<string>;
}

/** Adds what a row ran during the turn to the claims. */
function record(pass: Pass, row: WorkRow, window: TimeWindow, reading: RowReading): void {
  const { claims, startedAt } = pass;
  claims.history ||= reading.history;
  if (reading.opaque !== undefined && isStale(row, startedAt)) {
    claims.stale.push(reading.opaque);
    return;
  }
  claims.opaque ??= reading.opaque;
  claims.names.push(...reading.names);
  if (reading.tool !== undefined && !isStale(row, startedAt)) {
    claims.tools.push(reading.tool);
  }
  claims.writes.push(...reading.writes);
  claims.scratch.push(...reading.scratch);
  if (reading.runs) {
    claims.windows.push(window);
  }
}

/** The work rows of one shell, and the rows a delegation holds, which are another shell's. A turn's rows belong to the thread's shell. */
function gather(rows: readonly TimelineRow[], work: WorkRow[], apart: TimelineRow[][]): void {
  for (const row of rows) {
    if (row.kind === "work") {
      work.push(row);
    }
    const inner = nestedRows(row);
    if (row.kind === "work" && row.workKind === "delegation") {
      apart.push([...inner]);
    } else {
      gather(inner, work, apart);
    }
  }
}

/** Reads one shell's rows in the order they ran, so a `cd` carries to the rows after it, back to before the turn. */
function readShell(rows: readonly TimelineRow[], pass: Pass): void {
  const work: WorkRow[] = [];
  const apart: TimelineRow[][] = [];
  gather(rows, work, apart);
  let left: Origin | undefined;
  for (const row of work.sort((a, b) => a.startedAt - b.startedAt)) {
    const window = rowWindow(row, pass.open);
    if (window === null) {
      continue;
    }
    const reading = readRow(row, left, pass.readable);
    // A `cd` from before the lookback is not carried: where the shell is then is a guess again.
    left = row.startedAt < pass.startedAt - FAMILY_LOOKBACK_MS ? left : (reading.left ?? left);
    if (window.end >= pass.startedAt) {
      record(pass, row, window, reading);
    }
  }
  apart.forEach((inner) => readShell(inner, pass));
}

/**
 * Classifies the work rows that ran during the turn, which began at
 * `startedAt`, one thread's rows at a time (each thread has its own shell,
 * which keeps its directory from row to row, and so does a delegation): rows
 * that never ran (denied, waiting for approval) are left out, and a row that
 * recorded no end is taken to have run until `now`. The rows before the turn
 * only tell where the shell was.
 */
export function classifyRows(threads: ReadonlyArray<readonly TimelineRow[]>, startedAt: number, now: number): FamilyClaims {
  const claims: FamilyClaims = { opaque: undefined, writes: [], scratch: [], names: [], tools: [], windows: [], history: false, stale: [] };
  const readable = new Set(
    threads.flatMap((rows) => [...walkRows(rows)].flatMap((row) => (row.kind === "work" ? [row.threadId] : []))),
  );
  const pass: Pass = { claims, startedAt, open: { pending: now, unended: now }, readable };
  threads.forEach((rows) => readShell(rows, pass));
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
  return { claims: classifyRows([own, ...kin.threads], startedAt, now), kin };
}

/** Whether a tool's argument string names a changed path: it is the path, or ends in `/` and the path (an absolute path to it). */
const namesPath = (name: string, path: string) =>
  name === path || name === `./${path}` || (name.length > path.length && name.endsWith(`/${path}`));

/** A write target resolved against where its shell was. */
interface Located {
  token: string;
  /** The path relative to the checkout; null when it is outside it. */
  target: string | null;
  tree: boolean;
  /** The token is relative and its base is a guess, so any path that ends in it counts too. */
  loose: boolean;
}

/** Whether a located target claims a path: as resolved, or (loose) by a run of the path's last segments. */
function reaches(located: Located, path: string, tree: boolean): boolean {
  if (located.target !== null && claimsPath(located.target, path, tree)) {
    return true;
  }
  if (!located.loose) {
    return false;
  }
  const segments = path.split("/");
  const token = segmentsOf(located.token).join("/");
  return segments.some((_segment, at) => claimsPath(token, segments.slice(at).join("/"), tree));
}

interface Resolution {
  /** The candidates the family's tool rows and targeted commands claim. */
  claimed: Set<string>;
  /** The candidates its targeted commands (not its tool rows' names) claim. */
  written: Set<string>;
  /** Why the writes could not be resolved, which makes the turn a sweep. */
  sweep: string | undefined;
}

/**
 * The candidates one command writes: each token as the path itself, or with
 * everything beneath it for a tree. A move's destination is a tree too unless
 * every source is a changed file itself: a source that no changed path equals
 * is a directory, or something nothing knows (it was made by this turn's
 * file-change rows, or by a command, and moved), and its files are now at the
 * destination.
 */
function writtenBy(write: RowWrite, where: { dir: string; loose: boolean }, root: string, candidates: readonly string[]): string[] {
  const located = write.tokens.map((token): Located => ({
    token,
    target: repoRelative(token, where.dir, root),
    tree: write.trees.includes(token),
    loose: where.loose && !token.startsWith("/"),
  }));
  const moved = write.moves && located.some((target) => target.tree && !candidates.some((path) => reaches(target, path, false)));
  return candidates.filter((path) => located.some((target) => reaches(target, path, target.tree || moved)));
}

/** The first tool row that is not read-only, names no changed path and was not read as a command: it could have written anything. */
function unlistedTool(tools: readonly ToolUse[], candidates: readonly string[]): ToolUse | undefined {
  return tools.find(({ names, shell }) => !shell && !candidates.some((path) => names.some((name) => namesPath(name, path))));
}

/** Adds the candidates `writes` claim to `written`; why they cannot be resolved, which makes the turn a sweep, or undefined. */
function resolveWrites(writes: readonly RowWrite[], root: string, candidates: readonly string[], written: Set<string>): string | undefined {
  for (const write of writes) {
    const where = shellDirectory(write, root);
    if (where === null) {
      return "a command wrote after a cd that left the checkout root";
    }
    if (write.tokens.some(isUnresolved)) {
      return "a command wrote to scratch space, where the checkout lies, through a path it builds";
    }
    writtenBy(write, where, root, candidates).forEach((path) => written.add(path));
  }
  return undefined;
}

/**
 * Which of `candidates` (paths relative to the checkout) the family claims:
 * those a tool row's argument names, and those a targeted command writes (see
 * `writtenBy`). A relative token whose directory is a guess, because nothing
 * says where the shell was or it is not under the checkout, claims every
 * candidate that ends in it. A tool that is not read-only, names no changed
 * path and was not read as a command could have written anything, so it is a
 * sweep, naming the tool. The checkout root is read only when a command wrote
 * something by name or to scratch space; it is a sweep when it is unknown and
 * something was named, when a command wrote after a `cd` that did not return
 * to the root, and when a checkout in scratch space is written through a path
 * built from a variable.
 */
export async function resolveClaims(
  bb: BbPluginApi,
  environmentId: string,
  family: FamilyClaims,
  candidates: readonly string[],
): Promise<Resolution> {
  const claimed = new Set(candidates.filter((path) => family.names.some((name) => namesPath(name, path))));
  const written = new Set<string>();
  const resolution = (sweep?: string): Resolution => ({ claimed: new Set([...claimed, ...written]), written, sweep });
  const unlisted = unlistedTool(family.tools, candidates);
  if (unlisted !== undefined && candidates.length > 0) {
    return resolution(`the ${unlisted.tool} tool named no changed path`);
  }
  if ((family.writes.length === 0 && family.scratch.length === 0) || candidates.length === 0) {
    return resolution();
  }
  const root = await checkoutPath(bb, environmentId);
  if (root === null) {
    return resolution(family.writes.length === 0 ? undefined : "the checkout path is unknown");
  }
  const base = root.replace(/\/+$/u, "");
  // A path in scratch space is the checkout's only when the checkout lies there.
  const writes = [...family.writes, ...(isScratch(base) ? family.scratch : [])];
  return resolution(resolveWrites(writes, base, candidates, written));
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
