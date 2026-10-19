import type { PluginLogger } from "@get-bb/plugin-sdk";
import { createSyncScheduler } from "./ai-sync.js";
import { expandHome, HEARTBEAT_TIMEOUT_MS, SYNC_TIMEOUT_MS } from "./cli.js";
import type { Runner } from "./cli.js";
import {
  buildArgv,
  BRANCH_TTL_MS,
  entityFor,
  isExcluded,
  resolveContext,
  Throttle,
  TtlCache,
  unmatchedEntries,
} from "./heartbeat.js";
import type { ContextSdk, ProjectLike, ResolvedContext, ThreadLike } from "./heartbeat.js";
import type { WakatimeStatus } from "./rpc-contract.js";
import { entityModeOf, parseExcludeList } from "./settings.js";
import type { WakatimeSettings } from "./settings.js";

/** Agent time: one heartbeat per thread about every 2 min while it is active. */
export const AGENT_TICK_MS = 120_000;
const USER_KEY = "user";

export interface TrackerSdk extends ContextSdk {
  threads: ContextSdk["threads"] & {
    listRunning(): Promise<{ id: string }[]>;
  };
  projects: ContextSdk["projects"] & {
    list(args: { includePersonal: boolean }): Promise<ProjectLike[]>;
  };
}

export interface TrackerDeps {
  sdk: TrackerSdk;
  settings: { get(): Promise<WakatimeSettings> };
  runner: Runner;
  log: PluginLogger;
  /** The `--plugin` editor string, read per heartbeat so it can be filled in after load. */
  plugin: () => string;
}

type Timer = ReturnType<typeof setInterval>;

export function createTracker(deps: TrackerDeps) {
  const { sdk, runner, log } = deps;
  const throttle = new Throttle();
  const branches = new TtlCache<string | null>(BRANCH_TTL_MS);
  // Thread id -> its agent-time interval. The registered timer is the only
  // record that a thread is being timed.
  const timers = new Map<string, Timer>();
  // Thread id -> token of the in-flight `experimental_thread.events`
  // confirmation. A stop event deletes it, which voids the confirmation.
  const confirming = new Map<string, symbol>();
  // Threads known not to be timed (tracking off, project excluded, no context),
  // so a stream of events payloads does not re-read them. Cleared per thread on
  // activation and stop, and wholesale when settings change.
  const notTimed = new Set<string>();
  // Bumped when settings change, so a read that was already in flight cannot
  // mark a thread from the old settings.
  let settingsGeneration = 0;
  let checkedExcludes: string | null = null;
  let disposed = false;

  const sync = createSyncScheduler(async () => {
    const settings = await deps.settings.get();
    if (!settings.syncAiActivity) return;
    await runner.submit({
      key: "sync",
      kind: "sync",
      cliPath: settings.cliPath,
      args: ["--sync-ai-activity"],
      timeoutMs: SYNC_TIMEOUT_MS,
    });
  });

  function excluded(settings: WakatimeSettings, project: ProjectLike | null): boolean {
    return project !== null && isExcluded(parseExcludeList(settings.excludeProjects), project);
  }

  /** Queue one heartbeat unless the throttle holds it back. `bypass` skips the throttle. */
  function emit(
    settings: WakatimeSettings,
    ctx: ResolvedContext,
    key: string,
    category: string,
    bypass: boolean,
  ): boolean {
    const entity = entityFor(ctx.thread, entityModeOf(settings.entity));
    const project = ctx.project?.name;
    const timeMs = Date.now();
    if (!throttle.allow({ key, category }, entity, project, timeMs, bypass)) return false;
    const args = buildArgv(
      { entity, project, branch: ctx.branch ?? undefined, category, timeMs },
      deps.plugin(),
    );
    void runner.submit({
      key: `heartbeat:${key}`,
      kind: "heartbeat",
      cliPath: settings.cliPath,
      args,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    });
    return true;
  }

  async function userHeartbeat(ids: { projectId?: string; threadId?: string }): Promise<boolean> {
    const settings = await deps.settings.get();
    if (!settings.trackUserActivity) return false;
    const ctx = await resolveContext(sdk, branches, ids);
    if (ctx === null || excluded(settings, ctx.project)) return false;
    return emit(settings, ctx, USER_KEY, settings.userCategory, false);
  }

  function release(id: string, own: Timer): void {
    if (timers.get(id) !== own) return;
    clearInterval(own);
    timers.delete(id);
    throttle.forget(id);
  }

  /**
   * Release a timer for a thread that should not be timed (tracking off or
   * project excluded), and remember that unless settings changed since
   * `generation` was read. Anything else, such as an unresolved context, only
   * releases: the next payload may succeed.
   */
  function skip(id: string, own: Timer, generation: number): void {
    if (timers.get(id) !== own) return;
    release(id, own);
    if (generation === settingsGeneration) notTimed.add(id);
  }

  function stopLocal(id: string): void {
    notTimed.delete(id);
    const timer = timers.get(id);
    if (timer !== undefined) clearInterval(timer);
    timers.delete(id);
    confirming.delete(id);
    throttle.forget(id);
  }

  /**
   * Re-read the thread; it is returned only if it is still active and, after
   * the await, `expected` is still the registered timer (undefined meaning no
   * timer) and `valid()` holds. A thread that is no longer active, or whose
   * read fails, clears `expected`.
   */
  async function confirmActive(
    id: string,
    expected: Timer | undefined,
    valid: () => boolean,
  ): Promise<ThreadLike | null> {
    let thread: ThreadLike | null = null;
    try {
      thread = await sdk.threads.get({ threadId: id });
    } catch {
      thread = null;
    }
    if (!valid() || timers.get(id) !== expected) return null;
    if (thread === null || thread.status !== "active") {
      if (expected !== undefined) release(id, expected);
      return null;
    }
    return thread;
  }

  async function beginAgentTime(thread: ThreadLike, own: Timer): Promise<void> {
    const generation = settingsGeneration;
    try {
      const settings = await deps.settings.get();
      if (!settings.trackAgentActivity) return skip(thread.id, own, generation);
      const ctx = await resolveContext(sdk, branches, { threadId: thread.id }, thread);
      if (ctx === null) return release(thread.id, own);
      if (excluded(settings, ctx.project)) return skip(thread.id, own, generation);
      // An idle that landed during the awaits already cleared this timer.
      if (timers.get(thread.id) !== own) return;
      emit(settings, ctx, thread.id, settings.agentCategory, false);
    } catch {
      release(thread.id, own);
    }
  }

  async function tick(id: string, own: Timer): Promise<void> {
    try {
      const thread = await confirmActive(id, own, () => true);
      if (thread === null) return;
      const generation = settingsGeneration;
      const settings = await deps.settings.get();
      if (!settings.trackAgentActivity) return skip(id, own, generation);
      const ctx = await resolveContext(sdk, branches, { threadId: id }, thread);
      if (ctx === null) return release(id, own);
      if (excluded(settings, ctx.project)) return skip(id, own, generation);
      if (timers.get(id) !== own) return;
      // Already paced at the throttle window, so a tick that fires a
      // millisecond early must not be dropped.
      emit(settings, ctx, id, settings.agentCategory, true);
    } catch {
      release(id, own);
    }
  }

  function startTimer(thread: ThreadLike): void {
    if (disposed || timers.has(thread.id)) return;
    // Registered before any await so a racing start or events payload sees it.
    const own: Timer = setInterval(() => void tick(thread.id, own), AGENT_TICK_MS);
    timers.set(thread.id, own);
    void beginAgentTime(thread, own);
  }

  async function stop(thread: ThreadLike): Promise<void> {
    stopLocal(thread.id);
    try {
      const settings = await deps.settings.get();
      const ctx = await resolveContext(sdk, branches, { threadId: thread.id }, thread);
      if (disposed || ctx === null || excluded(settings, ctx.project)) return;
      if (settings.trackAgentActivity) emit(settings, ctx, thread.id, settings.agentCategory, true);
      if (settings.syncAiActivity) sync.request();
    } catch (error) {
      log.warn(`could not finish thread time: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  async function adopt(thread: ThreadLike): Promise<void> {
    if (
      disposed ||
      thread.status !== "active" ||
      timers.has(thread.id) ||
      confirming.has(thread.id) ||
      notTimed.has(thread.id)
    ) {
      return;
    }
    const token = Symbol(thread.id);
    confirming.set(thread.id, token);
    const isCurrent = () => confirming.get(thread.id) === token;
    const generation = settingsGeneration;
    try {
      // Payloads keep coming while a thread runs; skip the live read when nothing would be timed.
      const settings = await deps.settings.get();
      if (!settings.trackAgentActivity || parseExcludeList(settings.excludeProjects).includes(thread.projectId)) {
        if (isCurrent() && generation === settingsGeneration) notTimed.add(thread.id);
        return;
      }
      const live = await confirmActive(thread.id, undefined, isCurrent);
      if (live !== null && isCurrent()) startTimer(live);
    } catch {
      // A settings read that fails is retried by the next payload.
    } finally {
      if (isCurrent()) confirming.delete(thread.id);
    }
  }

  /** Threads running now, each confirmed active, get a timer; used at startup. */
  async function reconcile(): Promise<void> {
    try {
      const running = await sdk.threads.listRunning();
      await Promise.all(
        running.map(async ({ id }) => {
          try {
            const thread = await sdk.threads.get({ threadId: id });
            if (thread.status === "active") startTimer(thread);
          } catch {
            // A thread that vanished between the two calls is not running.
          }
        }),
      );
    } catch (error) {
      log.warn(`could not list running threads: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  async function unmatchedExcludes(settings: WakatimeSettings): Promise<string[]> {
    const entries = parseExcludeList(settings.excludeProjects);
    if (entries.length === 0) return [];
    return unmatchedEntries(entries, await sdk.projects.list({ includePersonal: true }));
  }

  /** Warn once per distinct `excludeProjects` value, by entry position only. */
  async function checkExcludes(): Promise<void> {
    try {
      const settings = await deps.settings.get();
      if (settings.excludeProjects === checkedExcludes) return;
      checkedExcludes = settings.excludeProjects;
      const unmatched = await unmatchedExcludes(settings);
      parseExcludeList(settings.excludeProjects).forEach((entry, index) => {
        if (unmatched.includes(entry)) log.warn(`excludeProjects entry #${index + 1} matches no project`);
      });
    } catch {
      checkedExcludes = null;
    }
  }

  /** Settings changed: a thread skipped under the old ones may now be timed. */
  function onSettingsChanged(): void {
    settingsGeneration += 1;
    notTimed.clear();
  }

  async function status(): Promise<WakatimeStatus> {
    const settings = await deps.settings.get();
    // Check the path in the setting now, so the error shown is about it and not an older path.
    await runner.verify(settings.cliPath);
    const health = runner.health();
    let unmatched: string[] = [];
    try {
      unmatched = await unmatchedExcludes(settings);
    } catch {
      // The status page still shows the rest.
    }
    return {
      cliPath: expandHome(settings.cliPath),
      lastHeartbeatAt: health.lastHeartbeatAt,
      lastSyncAt: health.lastSyncAt,
      lastError: health.lastError,
      unmatchedExcludes: unmatched,
    };
  }

  function dispose(): void {
    disposed = true;
    for (const timer of timers.values()) clearInterval(timer);
    timers.clear();
    confirming.clear();
    notTimed.clear();
    throttle.clear();
    branches.clear();
    sync.dispose();
  }

  return {
    userHeartbeat,
    status,
    checkExcludes,
    reconcile,
    dispose,
    onActive(thread: ThreadLike) {
      notTimed.delete(thread.id);
      startTimer(thread);
    },
    onSettingsChanged,
    onStop: stop,
    onEvents: (payload: { thread: ThreadLike }) => void adopt(payload.thread),
    onGone: stopLocal,
    /** Test hooks: sizes of the per-thread state. */
    stateSize: () => ({
      timers: timers.size,
      confirming: confirming.size,
      notTimed: notTimed.size,
      throttle: throttle.size,
      branches: branches.size,
    }),
  };
}

export type Tracker = ReturnType<typeof createTracker>;
