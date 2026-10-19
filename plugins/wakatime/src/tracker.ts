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

/**
 * Methods must be called on the instance, not detached: they read its fields
 * through `this`.
 */
export class Tracker {
  private readonly sdk: TrackerSdk;
  private readonly runner: Runner;
  private readonly log: PluginLogger;
  private readonly settings: TrackerDeps["settings"];
  private readonly plugin: TrackerDeps["plugin"];
  private readonly sync: ReturnType<typeof createSyncScheduler>;
  private readonly throttle = new Throttle();
  private readonly branches = new TtlCache<string | null>(BRANCH_TTL_MS);
  // Thread id -> its agent-time interval. The registered timer is the only
  // record that a thread is being timed.
  private readonly timers = new Map<string, Timer>();
  // Thread id -> token of the in-flight `experimental_thread.events`
  // confirmation. A stop event deletes it, which voids the confirmation.
  private readonly confirming = new Map<string, symbol>();
  // Threads known not to be timed (tracking off, project excluded, no context),
  // so a stream of events payloads does not re-read them. Cleared per thread on
  // activation and stop, and wholesale when settings change.
  private readonly notTimed = new Set<string>();
  // Bumped when settings change, so a read that was already in flight cannot
  // mark a thread from the old settings.
  private settingsGeneration = 0;
  private checkedExcludes: string | null = null;
  private disposed = false;

  constructor(deps: TrackerDeps) {
    this.sdk = deps.sdk;
    this.runner = deps.runner;
    this.log = deps.log;
    this.settings = deps.settings;
    this.plugin = deps.plugin;
    this.sync = createSyncScheduler(async () => {
      const settings = await this.settings.get();
      if (!settings.syncAiActivity) return;
      await this.runner.submit({
        key: "sync",
        kind: "sync",
        cliPath: settings.cliPath,
        args: ["--sync-ai-activity"],
        timeoutMs: SYNC_TIMEOUT_MS,
      });
    });
  }

  private excluded(settings: WakatimeSettings, project: ProjectLike | null): boolean {
    return project !== null && isExcluded(parseExcludeList(settings.excludeProjects), project);
  }

  /** Queue one heartbeat unless the throttle holds it back. `bypass` skips the throttle. */
  private emit(
    settings: WakatimeSettings,
    ctx: ResolvedContext,
    key: string,
    category: string,
    bypass: boolean,
  ): boolean {
    const entity = entityFor(ctx.thread, entityModeOf(settings.entity));
    const project = ctx.project?.name;
    const timeMs = Date.now();
    if (!this.throttle.allow({ key, category }, entity, project, timeMs, bypass)) return false;
    const args = buildArgv(
      { entity, project, branch: ctx.branch ?? undefined, category, timeMs },
      this.plugin(),
    );
    void this.runner.submit({
      key: `heartbeat:${key}`,
      kind: "heartbeat",
      cliPath: settings.cliPath,
      args,
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    });
    return true;
  }

  async userHeartbeat(ids: { projectId?: string; threadId?: string }): Promise<boolean> {
    const settings = await this.settings.get();
    if (!settings.trackUserActivity) return false;
    const ctx = await resolveContext(this.sdk, this.branches, ids);
    if (ctx === null || this.excluded(settings, ctx.project)) return false;
    return this.emit(settings, ctx, USER_KEY, settings.userCategory, false);
  }

  private release(id: string, own: Timer): void {
    if (this.timers.get(id) !== own) return;
    clearInterval(own);
    this.timers.delete(id);
    this.throttle.forget(id);
  }

  /**
   * Release a timer for a thread that should not be timed (tracking off or
   * project excluded), and remember that unless settings changed since
   * `generation` was read. Anything else, such as an unresolved context, only
   * releases: the next payload may succeed.
   */
  private skip(id: string, own: Timer, generation: number): void {
    if (this.timers.get(id) !== own) return;
    this.release(id, own);
    if (generation === this.settingsGeneration) this.notTimed.add(id);
  }

  private stopLocal(id: string): void {
    this.notTimed.delete(id);
    const timer = this.timers.get(id);
    if (timer !== undefined) clearInterval(timer);
    this.timers.delete(id);
    this.confirming.delete(id);
    this.throttle.forget(id);
  }

  /**
   * Re-read the thread; it is returned only if it is still active and, after
   * the await, `expected` is still the registered timer (undefined meaning no
   * timer) and `valid()` holds. A thread that is no longer active, or whose
   * read fails, clears `expected`.
   */
  private async confirmActive(
    id: string,
    expected: Timer | undefined,
    valid: () => boolean,
  ): Promise<ThreadLike | null> {
    let thread: ThreadLike | null = null;
    try {
      thread = await this.sdk.threads.get({ threadId: id });
    } catch {
      thread = null;
    }
    if (!valid() || this.timers.get(id) !== expected) return null;
    if (thread === null || thread.status !== "active") {
      if (expected !== undefined) this.release(id, expected);
      return null;
    }
    return thread;
  }

  private async beginAgentTime(thread: ThreadLike, own: Timer): Promise<void> {
    const generation = this.settingsGeneration;
    try {
      const settings = await this.settings.get();
      if (!settings.trackAgentActivity) return this.skip(thread.id, own, generation);
      const ctx = await resolveContext(this.sdk, this.branches, { threadId: thread.id }, thread);
      if (ctx === null) return this.release(thread.id, own);
      if (this.excluded(settings, ctx.project)) return this.skip(thread.id, own, generation);
      // An idle that landed during the awaits already cleared this timer.
      if (this.timers.get(thread.id) !== own) return;
      this.emit(settings, ctx, thread.id, settings.agentCategory, false);
    } catch {
      this.release(thread.id, own);
    }
  }

  private async tick(id: string, own: Timer): Promise<void> {
    try {
      const thread = await this.confirmActive(id, own, () => true);
      if (thread === null) return;
      const generation = this.settingsGeneration;
      const settings = await this.settings.get();
      if (!settings.trackAgentActivity) return this.skip(id, own, generation);
      const ctx = await resolveContext(this.sdk, this.branches, { threadId: id }, thread);
      if (ctx === null) return this.release(id, own);
      if (this.excluded(settings, ctx.project)) return this.skip(id, own, generation);
      if (this.timers.get(id) !== own) return;
      // Already paced at the throttle window, so a tick that fires a
      // millisecond early must not be dropped.
      this.emit(settings, ctx, id, settings.agentCategory, true);
    } catch {
      this.release(id, own);
    }
  }

  private startTimer(thread: ThreadLike): void {
    if (this.disposed || this.timers.has(thread.id)) return;
    // Registered before any await so a racing start or events payload sees it.
    const own: Timer = setInterval(() => void this.tick(thread.id, own), AGENT_TICK_MS);
    this.timers.set(thread.id, own);
    void this.beginAgentTime(thread, own);
  }

  private async stop(thread: ThreadLike): Promise<void> {
    this.stopLocal(thread.id);
    try {
      const settings = await this.settings.get();
      const ctx = await resolveContext(this.sdk, this.branches, { threadId: thread.id }, thread);
      if (this.disposed || ctx === null || this.excluded(settings, ctx.project)) return;
      if (settings.trackAgentActivity) this.emit(settings, ctx, thread.id, settings.agentCategory, true);
      if (settings.syncAiActivity) this.sync.request();
    } catch (error) {
      this.log.warn(`could not finish thread time: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  private async adopt(thread: ThreadLike): Promise<void> {
    if (
      this.disposed ||
      thread.status !== "active" ||
      this.timers.has(thread.id) ||
      this.confirming.has(thread.id) ||
      this.notTimed.has(thread.id)
    ) {
      return;
    }
    const token = Symbol(thread.id);
    this.confirming.set(thread.id, token);
    const isCurrent = () => this.confirming.get(thread.id) === token;
    const generation = this.settingsGeneration;
    try {
      // Payloads keep coming while a thread runs; skip the live read when nothing would be timed.
      const settings = await this.settings.get();
      if (!settings.trackAgentActivity || parseExcludeList(settings.excludeProjects).includes(thread.projectId)) {
        if (isCurrent() && generation === this.settingsGeneration) this.notTimed.add(thread.id);
        return;
      }
      const live = await this.confirmActive(thread.id, undefined, isCurrent);
      if (live !== null && isCurrent()) this.startTimer(live);
    } catch {
      // A settings read that fails is retried by the next payload.
    } finally {
      if (isCurrent()) this.confirming.delete(thread.id);
    }
  }

  /** Threads running now, each confirmed active, get a timer; used at startup. */
  async reconcile(): Promise<void> {
    try {
      const running = await this.sdk.threads.listRunning();
      await Promise.all(
        running.map(async ({ id }) => {
          try {
            const thread = await this.sdk.threads.get({ threadId: id });
            if (thread.status === "active") this.startTimer(thread);
          } catch {
            // A thread that vanished between the two calls is not running.
          }
        }),
      );
    } catch (error) {
      this.log.warn(`could not list running threads: ${error instanceof Error ? error.name : "error"}`);
    }
  }

  private async unmatchedExcludes(settings: WakatimeSettings): Promise<string[]> {
    const entries = parseExcludeList(settings.excludeProjects);
    if (entries.length === 0) return [];
    return unmatchedEntries(entries, await this.sdk.projects.list({ includePersonal: true }));
  }

  /** Warn once per distinct `excludeProjects` value, by entry position only. */
  async checkExcludes(): Promise<void> {
    try {
      const settings = await this.settings.get();
      if (settings.excludeProjects === this.checkedExcludes) return;
      this.checkedExcludes = settings.excludeProjects;
      const unmatched = await this.unmatchedExcludes(settings);
      parseExcludeList(settings.excludeProjects).forEach((entry, index) => {
        if (unmatched.includes(entry)) this.log.warn(`excludeProjects entry #${index + 1} matches no project`);
      });
    } catch {
      this.checkedExcludes = null;
    }
  }

  /** Settings changed: a thread skipped under the old ones may now be timed. */
  onSettingsChanged(): void {
    this.settingsGeneration += 1;
    this.notTimed.clear();
  }

  async status(): Promise<WakatimeStatus> {
    const settings = await this.settings.get();
    // Check the path in the setting now, so the error shown is about it and not an older path.
    await this.runner.verify(settings.cliPath);
    const health = this.runner.health();
    let unmatched: string[] = [];
    try {
      unmatched = await this.unmatchedExcludes(settings);
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

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.confirming.clear();
    this.notTimed.clear();
    this.throttle.clear();
    this.branches.clear();
    this.sync.dispose();
  }

  onActive(thread: ThreadLike): void {
    this.notTimed.delete(thread.id);
    this.startTimer(thread);
  }

  onStop(thread: ThreadLike): Promise<void> {
    return this.stop(thread);
  }

  onEvents(payload: { thread: ThreadLike }): void {
    void this.adopt(payload.thread);
  }

  onGone(id: string): void {
    this.stopLocal(id);
  }

  /** Test hooks: sizes of the per-thread state. */
  stateSize() {
    return {
      timers: this.timers.size,
      confirming: this.confirming.size,
      notTimed: this.notTimed.size,
      throttle: this.throttle.size,
      branches: this.branches.size,
    };
  }
}

export function createTracker(deps: TrackerDeps) {
  return new Tracker(deps);
}
