import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FileMode } from "./settings.js";

/** One file an agent touched, already checked to lie inside its environment folder. */
export interface FileSpec {
  /** Absolute, under the environment's resolved root. */
  path: string;
  write: boolean;
  /** Changed lines, for an edit whose diff could be counted. */
  aiLineChanges?: number;
  timeMs: number;
  /** True unless the file exists as a regular file on this host. */
  unsaved: boolean;
}

/** The part of a thread event row this module reads. */
export interface EventRowLike {
  seq: number;
  createdAt: number;
  data: unknown;
}

export interface FileScan {
  specs: FileSpec[];
  /** Specs dropped because their path is outside the environment folder (or there is none). */
  outOfScope: number;
}

interface RawSpec {
  path: string;
  write: boolean;
  aiLineChanges?: number;
  timeMs: number;
}

/**
 * Lines added and removed in a unified diff, counted after the first `@@`.
 * File headers sit before it and are never counted; a removed line that itself
 * starts with `--` is. Undefined when there is no diff or it has no `@@`, so
 * the count is omitted rather than sent as 0.
 */
export function diffLineCount(diff: string | undefined): number | undefined {
  if (diff === undefined) return undefined;
  const lines = diff.split("\n");
  const first = lines.findIndex((line) => line.startsWith("@@"));
  if (first === -1) return undefined;
  let count = 0;
  for (const line of lines.slice(first)) {
    if (line.startsWith("@@")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function rawSpecs(row: EventRowLike, mode: FileMode): RawSpec[] {
  const item = record(record(row.data)?.item);
  if (item === null || item.status !== "completed") return [];
  const timeMs = row.createdAt;
  if (item.type === "fileRead") {
    return mode === "edits-and-reads" && typeof item.path === "string" ? [{ path: item.path, write: false, timeMs }] : [];
  }
  if (item.type !== "fileChange" || !Array.isArray(item.changes)) return [];
  const specs: RawSpec[] = [];
  for (const entry of item.changes) {
    const change = record(entry);
    if (change === null || typeof change.path !== "string") continue;
    const diff = typeof change.diff === "string" ? change.diff : undefined;
    const aiLineChanges = change.kind === "delete" ? undefined : diffLineCount(diff);
    const moved = typeof change.movePath === "string" ? change.movePath : undefined;
    // A move writes both ends; the lines belong to the file that now holds them.
    if (moved !== undefined) specs.push({ path: change.path, write: true, timeMs });
    specs.push({ path: moved ?? change.path, write: true, aiLineChanges, timeMs });
  }
  return specs;
}

interface Scope {
  /** `env.path` normalised, as the agent sees it. */
  lexical: string;
  /** Its real path when it is a local directory, else the same as `lexical`. */
  root: string;
  local: boolean;
}

async function resolveScope(envPath: string): Promise<Scope> {
  const lexical = path.resolve(envPath);
  try {
    const root = await realpath(lexical);
    if ((await stat(root)).isDirectory()) return { lexical, root, local: true };
  } catch {
    // Not on this host: the environment is remote, or its folder is gone.
  }
  return { lexical, root: lexical, local: false };
}

/** Inside by path segment, so `/a/proj` does not contain `/a/project2/x`. */
function isInside(relative: string): boolean {
  return (
    relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

/** Real path of the deepest existing ancestor, with the missing tail put back. */
async function realpathDeepest(target: string): Promise<string> {
  const tail: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** The path as it should be reported, or null when it is not a file inside the environment folder. */
async function scoped(raw: string, scope: Scope): Promise<string | null> {
  const absolute = path.resolve(scope.lexical, raw);
  const below = path.relative(scope.lexical, absolute);
  // Re-base onto the real root so a symlinked environment folder reports one prefix.
  let candidate = isInside(below) ? path.join(scope.root, below) : absolute;
  if (scope.local) candidate = await realpathDeepest(candidate);
  const inRoot = path.relative(scope.root, candidate);
  if (!isInside(inRoot)) return null;
  if (inRoot.split(path.sep).some((segment) => segment === "node_modules" || segment === ".git")) return null;
  return candidate;
}

async function isUnsaved(file: string, scope: Scope): Promise<boolean> {
  if (!scope.local) return true;
  try {
    return !(await stat(file)).isFile();
  } catch {
    return true;
  }
}

/**
 * Turn completed `fileChange` and `fileRead` items into file specs. Items that
 * did not complete are skipped; reads only count in `edits-and-reads` mode.
 */
export async function fileHeartbeats(
  rows: readonly EventRowLike[],
  env: { path: string | null },
  mode: FileMode,
): Promise<FileScan> {
  const raw = mode === "off" ? [] : rows.flatMap((row) => rawSpecs(row, mode));
  if (raw.length === 0) return { specs: [], outOfScope: 0 };
  if (env.path === null || env.path === "") return { specs: [], outOfScope: raw.length };
  const scope = await resolveScope(env.path);
  const specs: FileSpec[] = [];
  let outOfScope = 0;
  for (const item of raw) {
    const file = await scoped(item.path, scope);
    if (file === null) outOfScope += 1;
    else specs.push({ ...item, path: file, unsaved: await isUnsaved(file, scope) });
  }
  return { specs, outOfScope };
}

/** The JSON object `wakatime-cli --extra-heartbeats` reads for one file: never a diff, command or key. */
export function toExtraHeartbeat(
  spec: FileSpec,
  ctx: { project?: string; branch: string | null; category: string },
): Record<string, unknown> {
  return {
    entity: spec.path,
    type: "file",
    category: ctx.category,
    time: spec.timeMs / 1000,
    is_write: spec.write,
    ...(ctx.project === undefined ? {} : { project: ctx.project }),
    ...(ctx.branch === null ? {} : { alternate_branch: ctx.branch }),
    ...(spec.aiLineChanges === undefined ? {} : { ai_line_changes: spec.aiLineChanges }),
    ...(spec.unsaved ? { is_unsaved_entity: true } : {}),
  };
}

/** At send time: a file that was a regular file when it was read but is not now (swapped for a symlink, say, or deleted) goes out as unsaved. */
export function recheckSaved(chunk: FileSpec[]): Promise<FileSpec[]> {
  return Promise.all(
    chunk.map(async (spec) => {
      if (spec.unsaved) return spec;
      try {
        return (await lstat(spec.path)).isFile() ? spec : { ...spec, unsaved: true };
      } catch {
        return { ...spec, unsaved: true };
      }
    }),
  );
}

/** A file that still exists but is no longer a regular file (a symlink, a directory, a FIFO). A missing one is not: the CLI simply cannot read through it. */
export async function anyTurnedSpecial(chunk: FileSpec[]): Promise<boolean> {
  const checks = await Promise.all(
    chunk.map(async (spec) => {
      if (spec.unsaved) return false;
      try {
        return !(await lstat(spec.path)).isFile();
      } catch {
        return false;
      }
    }),
  );
  return checks.some(Boolean);
}
