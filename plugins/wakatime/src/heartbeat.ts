import type { EntityMode } from "./settings.js";

export const THROTTLE_MS = 120_000;
export const BRANCH_TTL_MS = 60_000;
/** Entity for a view with no thread (home, settings, a project page). */
export const APP_ENTITY = "bb";

export interface HeartbeatSpec {
  entity: string;
  /** Omitted when the view has no project. */
  project?: string;
  branch?: string;
  category: string;
  /** Epoch milliseconds; the argv carries seconds. */
  timeMs: number;
}

export interface ThreadLike {
  id: string;
  projectId: string;
  status: string;
  title: string | null;
  titleFallback: string | null;
  environmentId: string | null;
}

// Control characters (newlines included) would split a dashboard row or corrupt
// argv; format characters (bidi, zero-width) would disguise it. U+200D stays so
// emoji sequences survive.
function clean(value: string | null | undefined): string | null {
  const text = Array.from(value ?? "")
    .filter((char) => char === "\u200D" || !/\p{Cf}/u.test(char))
    .join("")
    .replace(/\p{Cc}+/gu, " ")
    .trim();
  return text.length > 0 ? text : null;
}

export function entityFor(thread: ThreadLike | null, mode: EntityMode): string {
  if (thread === null) return APP_ENTITY;
  if (mode === "threadId") return thread.id;
  return clean(thread.title) ?? clean(thread.titleFallback) ?? thread.id;
}

/** `--flag=value` form throughout, so a value starting with `-` is never read as a flag. */
export function buildArgv(spec: HeartbeatSpec, plugin: string): string[] {
  const argv = [`--entity-type=app`, `--entity=${clean(spec.entity) ?? APP_ENTITY}`];
  const project = clean(spec.project);
  if (project !== null) argv.push(`--project=${project}`);
  const branch = clean(spec.branch);
  if (branch !== null) argv.push(`--alternate-branch=${branch}`);
  argv.push(
    `--category=${clean(spec.category) ?? "coding"}`,
    `--time=${(spec.timeMs / 1000).toFixed(3)}`,
    `--plugin=${clean(plugin) ?? "bb"}`,
    "--sync-ai-disabled",
  );
  return argv;
}

export function isExcluded(entries: readonly string[], project: { id: string; name: string }): boolean {
  return entries.some((entry) => entry === project.id || entry === project.name);
}

export function unmatchedEntries(
  entries: readonly string[],
  projects: readonly { id: string; name: string }[],
): string[] {
  return entries.filter((entry) => !projects.some((project) => project.id === entry || project.name === entry));
}

export interface ThrottleKey {
  /** `user`, or a thread id. */
  key: string;
  category: string;
}

/** At most one heartbeat per key and category every 120 s. */
export class Throttle {
  private readonly sent = new Map<string, Map<string, { at: number; entity: string; project: string | undefined }>>();

  /**
   * True when a heartbeat should go out now, recording it. An entity or project
   * change always passes; `bypass` (agent ticks, final heartbeats) passes
   * without being recorded.
   */
  allow(id: ThrottleKey, entity: string, project: string | undefined, now: number, bypass = false): boolean {
    if (bypass) return true;
    const byCategory = this.sent.get(id.key) ?? new Map();
    const previous = byCategory.get(id.category);
    const pass =
      previous === undefined ||
      previous.entity !== entity ||
      previous.project !== project ||
      now - previous.at >= THROTTLE_MS;
    if (pass) {
      byCategory.set(id.category, { at: now, entity, project });
      this.sent.set(id.key, byCategory);
    }
    return pass;
  }

  forget(key: string): void {
    this.sent.delete(key);
  }

  clear(): void {
    this.sent.clear();
  }

  get size(): number {
    return this.sent.size;
  }
}

/** A TTL map that drops expired entries on every write, so it stays bounded. */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined || entry.expiresAt <= now) return undefined;
    return entry.value;
  }

  set(key: string, value: V, now: number): void {
    for (const [existing, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(existing);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface EnvironmentSdk {
  get(args: { environmentId: string }): Promise<{ branchName: string | null }>;
  status(args: { environmentId: string }): Promise<{
    outcome: string;
    workspace?: { branch: { currentBranch: string | null } };
  }>;
}

export interface ProjectLike {
  id: string;
  name: string;
}

export interface ContextSdk {
  threads: { get(args: { threadId: string }): Promise<ThreadLike> };
  projects: { get(args: { projectId: string }): Promise<ProjectLike> };
  environments: EnvironmentSdk;
}

export interface ResolvedContext {
  thread: ThreadLike | null;
  project: ProjectLike | null;
  branch: string | null;
}

/**
 * Resolve what a heartbeat describes through `sdk`. Null when an id was given
 * but cannot be resolved, so nothing is sent for it. The thread is always read
 * fresh; only the branch is cached.
 */
export async function resolveContext(
  sdk: ContextSdk,
  branches: TtlCache<string | null>,
  ids: { projectId?: string; threadId?: string },
  knownThread?: ThreadLike,
): Promise<ResolvedContext | null> {
  let thread: ThreadLike | null = null;
  if (ids.threadId !== undefined) {
    try {
      thread = knownThread ?? (await sdk.threads.get({ threadId: ids.threadId }));
    } catch {
      return null;
    }
  }
  const projectId = thread?.projectId ?? ids.projectId;
  let project: ProjectLike | null = null;
  if (projectId !== undefined) {
    try {
      project = await sdk.projects.get({ projectId });
    } catch {
      return null;
    }
  }
  const branch = thread?.environmentId ? await branchOf(sdk.environments, branches, thread.environmentId) : null;
  return { thread, project, branch };
}

async function branchOf(
  environments: EnvironmentSdk,
  cache: TtlCache<string | null>,
  environmentId: string,
): Promise<string | null> {
  const cached = cache.get(environmentId, Date.now());
  if (cached !== undefined) return cached;
  try {
    let branch = (await environments.get({ environmentId })).branchName;
    if (branch === null) {
      const status = await environments.status({ environmentId });
      branch = status.outcome === "available" ? (status.workspace?.branch.currentBranch ?? null) : null;
    }
    cache.set(environmentId, branch, Date.now());
    return branch;
  } catch {
    // Not cached: the next heartbeat tries again.
    return null;
  }
}
