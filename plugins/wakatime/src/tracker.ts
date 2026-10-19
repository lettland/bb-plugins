import type { PluginLogger } from "@get-bb/plugin-sdk";
import { expandHome, HEARTBEAT_TIMEOUT_MS } from "./cli.js";
import type { Job, Runner } from "./cli.js";
import { toExtraHeartbeat } from "./file-activity.js";
import type { FileSpec } from "./file-activity.js";
import { FileDelivery } from "./file-delivery.js";
import type { FileSdk } from "./file-delivery.js";
import {
  buildArgv,
  BRANCH_TTL_MS,
  clean,
  entityFor,
  isExcluded,
  resolveContext,
  Throttle,
  TtlCache,
  unmatchedEntries,
} from "./heartbeat.js";
import type { ContextSdk, EnvInfo, ProjectLike, ResolvedContext, ThreadLike } from "./heartbeat.js";
import type { WakatimeStatus } from "./rpc-contract.js";
import { entityModeOf, parseExcludeList } from "./settings.js";
import type { WakatimeSettings } from "./settings.js";

/** Agent time: one heartbeat per thread about every 2 min while it is active. */
export const AGENT_TICK_MS = 120_000;
const USER_KEY = "user";

export interface TrackerSdk extends ContextSdk {
  threads: ContextSdk["threads"] &
    FileSdk["threads"] & {
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
  private readonly files: FileDelivery;
  private readonly throttle = new Throttle();
  private readonly branches = new TtlCache<EnvInfo>(BRANCH_TTL_MS);
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
  // Thread id -> token of a final stop still resolving; archiving the thread
  // deletes it, so the stop does not bring the thread's file state back.
  private readonly stopping = new Map<string, symbol>();
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
    this.files = new FileDelivery({
      sdk: deps.sdk,
      settings: deps.settings,
      runner: deps.runner,
      log: deps.log,
      environments: this.branches,
    });
  }

  private excluded(settings: WakatimeSettings, project: ProjectLike | null): boolean {
    return project !== null && isExcluded(parseExcludeList(settings.excludeProjects), project);
  }

  /**
   * The CLI call for one heartbeat, with `chunk` as its file entries; null when
   * the throttle holds it back. `bypass` skips the throttle, and only the first
   * call of a send consults it.
   */
  private heartbeatJob(
    settings: WakatimeSettings,
    ctx: ResolvedContext,
    key: string,
    category: string,
    bypass: boolean,
    chunk: FileSpec[] = [],
    first = true,
  ): Job | null {
    const entity = entityFor(ctx.thread, entityModeOf(settings.entity));
    // The same cleaned name goes to the argv and to every file entry.
    const project = clean(ctx.project?.name) ?? undefined;
    const timeMs = Date.now();
    if (first && !this.throttle.allow({ key, category }, entity, project, timeMs, bypass)) return null;
    const args = buildArgv(
      { entity, project, branch: ctx.branch ?? undefined, category, timeMs },
      this.plugin(),
      chunk.length > 0,
    );
    const extras = chunk.map((spec) => toExtraHeartbeat(spec, { project, branch: ctx.branch, category }));
    return {
      key: `heartbeat:${key}`,
      cliPath: settings.cliPath,
      args,
      ...(chunk.length > 0 ? { stdin: JSON.stringify(extras) } : {}),
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
    };
  }

  /** Send a thread's heartbeat through the file pipeline, the only submitter for its key. */
  private deliver(
    ctx: ResolvedContext & { thread: ThreadLike },
    bypass: boolean,
    final: boolean,
  ): Promise<void> {
    const { thread } = ctx;
    return this.files.deliver({
      id: thread.id,
      // A context resolved from a thread always carries its project: `resolveContext` returns null otherwise.
      project: ctx.project!,
      environmentId: thread.environmentId,
      final,
      // Built from the settings the send just read, not from any read before a pull.
      build: (chunk, first, fresh) =>
        this.heartbeatJob(fresh, ctx, thread.id, fresh.agentCategory, bypass, chunk, first),
    });
  }

  async userHeartbeat(ids: { projectId?: string; threadId?: string }): Promise<boolean> {
    const settings = await this.settings.get();
    if (!settings.trackUserActivity) return false;
    const ctx = await resolveContext(this.sdk, this.branches, ids);
    if (ctx === null || this.excluded(settings, ctx.project)) return false;
    const job = this.heartbeatJob(settings, ctx, USER_KEY, settings.userCategory, false);
    if (job === null) return false;
    void this.runner.submit(job);
    return true;
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
    this.files.untime(id);
    if (generation === this.settingsGeneration) this.notTimed.add(id);
  }

  /** The thread's interval timer and its marks; the file pipeline is kept for its next turn. */
  private clearTimer(id: string): void {
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
      this.files.attach(thread.id, ctx.project!, thread.environmentId);
      void this.files.pull(thread.id);
      await this.deliver({ ...ctx, thread }, false, false);
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
      this.files.attach(id, ctx.project!, thread.environmentId);
      await this.files.pull(id);
      if (this.timers.get(id) !== own) return;
      // Already paced at the throttle window, so a tick that fires a
      // millisecond early must not be dropped.
      await this.deliver({ ...ctx, thread }, true, false);
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
    this.clearTimer(thread.id);
    const token = Symbol(thread.id);
    this.stopping.set(thread.id, token);
    try {
      const settings = await this.settings.get();
      const ctx = await resolveContext(this.sdk, this.branches, { threadId: thread.id }, thread);
      if (this.disposed || ctx === null) return;
      if (this.excluded(settings, ctx.project) || !settings.trackAgentActivity) {
        // Not timed any more: no old read position may survive to a later turn.
        this.files.untime(thread.id);
        return;
      }
      if (this.stopping.get(thread.id) !== token) return;
      // Chained behind every earlier pull, so a thread that starts again meanwhile never re-seeds.
      this.files.attach(thread.id, ctx.project!, thread.environmentId);
      await this.files.pull(thread.id);
      await this.deliver({ ...ctx, thread }, true, true);
    } catch (error) {
      this.log.warn(`could not finish thread time: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      if (this.stopping.get(thread.id) === token) this.stopping.delete(thread.id);
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
    void this.files.applySettings();
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
      lastError: health.lastError,
      ...this.files.stats(),
      unmatchedExcludes: unmatched,
    };
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.confirming.clear();
    this.notTimed.clear();
    this.stopping.clear();
    this.throttle.clear();
    this.branches.clear();
    this.files.dispose();
  }

  onActive(thread: ThreadLike): void {
    this.notTimed.delete(thread.id);
    this.startTimer(thread);
  }

  onStop(thread: ThreadLike): Promise<void> {
    return this.stop(thread);
  }

  onEvents(payload: { thread: ThreadLike; sequence?: number }): void {
    // A timed thread's new events are pulled into its buffer; others may start a timer.
    if (this.timers.has(payload.thread.id)) void this.files.pull(payload.thread.id, payload.sequence);
    else void this.adopt(payload.thread);
  }

  onGone(id: string): void {
    this.clearTimer(id);
    this.stopping.delete(id);
    this.files.drop(id);
  }

  /** Test hooks: sizes of the per-thread state. */
  stateSize() {
    return {
      timers: this.timers.size,
      confirming: this.confirming.size,
      notTimed: this.notTimed.size,
      throttle: this.throttle.size,
      branches: this.branches.size,
      files: this.files.size(),
    };
  }
}

export function createTracker(deps: TrackerDeps) {
  return new Tracker(deps);
}
