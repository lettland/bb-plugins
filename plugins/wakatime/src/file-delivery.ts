import type { PluginLogger } from "@get-bb/plugin-sdk";
import type { Job, JobOutcome, Runner } from "./cli.js";
import { fileHeartbeats } from "./file-activity.js";
import type { EventRowLike, FileSpec } from "./file-activity.js";
import { envInfoOf, isExcluded, TtlCache } from "./heartbeat.js";
import type { EnvInfo, EnvironmentSdk, ProjectLike } from "./heartbeat.js";
import { parseExcludeList } from "./settings.js";
import type { FileMode, WakatimeSettings } from "./settings.js";
import type { WakatimeStatus } from "./rpc-contract.js";

/** A read of the same path within this window of the previous one is not sent again. */
export const READ_THROTTLE_MS = 120_000;
export const BUFFER_CAP = 2000;
/** Specs per `wakatime-cli` call, and rows per `events.list` page. */
export const CHUNK_SIZE = 200;
export const EVENTS_TIMEOUT_MS = 30_000;

export interface FileSdk {
  threads: {
    events: {
      list(args: {
        threadId: string;
        afterSeq?: string;
        order: "asc" | "desc";
        limit: string;
        types?: readonly ["item/completed"];
        signal: AbortSignal;
      }): Promise<EventRowLike[]>;
    };
  };
  environments: EnvironmentSdk;
}

export interface FileDeliveryDeps {
  sdk: FileSdk;
  settings: { get(): Promise<WakatimeSettings> };
  runner: Runner;
  log: PluginLogger;
  /** The tracker's environment cache, shared so the folder is read once per minute. */
  environments: TtlCache<EnvInfo>;
}

/** One thread's file pipeline. The state object is also its identity: a link that finds another one in the map, or none, stops. */
interface ThreadFiles {
  id: string;
  project: ProjectLike;
  environmentId: string | null;
  /** Last event row mapped; null until the tip has been read (or after a reset). */
  lastSeq: number | null;
  buffer: FileSpec[];
  /** Path -> `createdAt` of the last read that was kept. */
  reads: Map<string, number>;
  /** Pulls run one after another on this chain; it never rejects. */
  chain: Promise<void>;
  /** At most one flush per thread, so `heartbeat:<id>` has one submitter. */
  flushing: boolean;
  inFlight: Promise<void> | null;
  /** Delete once no flush is in flight: the thread is no longer timed. */
  retire: boolean;
  /** Bumped when the file fields are reset; a batch submitted before that is not re-buffered. */
  epoch: number;
  /** An event read failed since the last success, so only the first failure is logged. */
  failing: boolean;
}

export interface DeliverRequest {
  id: string;
  project: ProjectLike;
  environmentId: string | null;
  /** Final stop: wait for a flush in flight, then send every chunk. */
  final: boolean;
  /** The CLI call for one chunk, or null when the throttle holds the app heartbeat back. */
  build(chunk: FileSpec[], first: boolean): Job | null;
}

type Drops = WakatimeStatus["droppedFiles"];

/**
 * Collects the files agents touched, from bb's own thread events, and sends
 * them with the thread's heartbeats. Methods must be called on the instance.
 */
export class FileDelivery {
  private readonly sdk: FileSdk;
  private readonly settings: FileDeliveryDeps["settings"];
  private readonly runner: Runner;
  private readonly log: PluginLogger;
  private readonly environments: TtlCache<EnvInfo>;
  private readonly states = new Map<string, ThreadFiles>();
  private readonly drops: Drops = { outOfScope: 0, overflow: 0, filtered: 0, failed: 0 };
  private lastFileBatchAt: number | null = null;
  private disposed = false;

  constructor(deps: FileDeliveryDeps) {
    this.sdk = deps.sdk;
    this.settings = deps.settings;
    this.runner = deps.runner;
    this.log = deps.log;
    this.environments = deps.environments;
  }

  /** Create the thread's state, or refresh it when the thread comes back (nothing is replayed or skipped). */
  attach(id: string, project: ProjectLike, environmentId: string | null): void {
    const state = this.states.get(id);
    if (state === undefined) {
      this.states.set(id, {
        id,
        project,
        environmentId,
        lastSeq: null,
        buffer: [],
        reads: new Map(),
        chain: Promise.resolve(),
        flushing: false,
        inFlight: null,
        retire: false,
        epoch: 0,
        failing: false,
      });
      return;
    }
    state.project = project;
    state.environmentId = environmentId;
    state.retire = false;
  }

  /** Chain a pull of the thread's new events; resolves when it and every earlier pull are done. */
  pull(id: string): Promise<void> {
    const state = this.states.get(id);
    if (state === undefined || this.disposed) return Promise.resolve();
    state.chain = state.chain.then(() => this.pullOnce(state));
    return state.chain;
  }

  private alive(state: ThreadFiles): boolean {
    return !this.disposed && this.states.get(state.id) === state;
  }

  /** Files to send under these settings: nothing unless the thread is timed, named by id, and file activity is on. */
  private modeOf(settings: WakatimeSettings, project: ProjectLike): FileMode {
    if (!this.timed(settings, project) || settings.entity === "threadId") return "off";
    return settings.fileActivity as FileMode;
  }

  private timed(settings: WakatimeSettings, project: ProjectLike): boolean {
    return settings.trackAgentActivity && !isExcluded(parseExcludeList(settings.excludeProjects), project);
  }

  /** Stop file activity for the thread: what is buffered is dropped, and the next start is the tip. */
  private reset(state: ThreadFiles): void {
    this.drops.filtered += state.buffer.length;
    state.buffer = [];
    state.lastSeq = null;
    state.reads.clear();
    state.epoch += 1;
  }

  private retire(state: ThreadFiles): void {
    if (state.flushing) state.retire = true;
    else this.states.delete(state.id);
  }

  /** Apply the current settings to a state: reset it, retire it, or drop the reads. */
  private applyPrivacy(state: ThreadFiles, settings: WakatimeSettings): FileMode {
    const mode = this.modeOf(settings, state.project);
    if (mode === "off" && (state.lastSeq !== null || state.buffer.length > 0)) this.reset(state);
    if (!this.timed(settings, state.project)) this.retire(state);
    if (mode === "edits") {
      const kept = state.buffer.filter((spec) => spec.write);
      this.drops.filtered += state.buffer.length - kept.length;
      state.buffer = kept;
    }
    return mode;
  }

  /** A settings change: privacy takes effect now for everything already buffered. */
  async applySettings(): Promise<void> {
    try {
      const settings = await this.settings.get();
      for (const state of this.states.values()) this.applyPrivacy(state, settings);
    } catch {
      // The next pull or flush applies the settings it reads.
    }
  }

  private async pullOnce(state: ThreadFiles): Promise<void> {
    try {
      const settings = await this.settings.get();
      if (!this.alive(state)) return;
      const mode = this.applyPrivacy(state, settings);
      if (mode === "off" || !this.alive(state)) return;
      if (state.lastSeq === null && !(await this.seed(state))) return;
      await this.readPages(state, mode);
      state.failing = false;
    } catch (error) {
      if (!state.failing) {
        this.log.warn(`could not read thread events: ${error instanceof Error ? error.name : "error"}`);
      }
      state.failing = true;
    }
  }

  /** Start from the tip, so history is never replayed. Rows landing before a retry are not sent. */
  private async seed(state: ThreadFiles): Promise<boolean> {
    const rows = await this.sdk.threads.events.list({
      threadId: state.id,
      order: "desc",
      limit: "1",
      signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
    });
    if (!this.alive(state)) return false;
    state.lastSeq = rows[0]?.seq ?? 0;
    return true;
  }

  private async readPages(state: ThreadFiles, mode: FileMode): Promise<void> {
    for (;;) {
      if (state.lastSeq === null) return;
      const rows = await this.sdk.threads.events.list({
        threadId: state.id,
        afterSeq: String(state.lastSeq),
        order: "asc",
        types: ["item/completed"],
        limit: String(CHUNK_SIZE),
        signal: AbortSignal.timeout(EVENTS_TIMEOUT_MS),
      });
      if (!this.alive(state) || state.lastSeq === null || rows.length === 0) return;
      const env = state.environmentId === null ? null : await envInfoOf(this.sdk.environments, this.environments, state.environmentId);
      const scan = await fileHeartbeats(rows, { path: env?.path ?? null }, mode);
      if (!this.alive(state) || state.lastSeq === null) return;
      this.drops.outOfScope += scan.outOfScope;
      this.enqueue(state, scan.specs);
      state.lastSeq = rows[rows.length - 1]!.seq;
      if (rows.length < CHUNK_SIZE) return;
    }
  }

  /** Add specs to the buffer: a repeated read is dropped, and the oldest specs go past the cap. */
  private enqueue(state: ThreadFiles, specs: FileSpec[]): void {
    for (const spec of specs) {
      if (!spec.write) {
        const last = state.reads.get(spec.path);
        if (last !== undefined && spec.timeMs - last < READ_THROTTLE_MS) continue;
        state.reads.set(spec.path, spec.timeMs);
      }
      state.buffer.push(spec);
    }
    this.trim(state);
  }

  private trim(state: ThreadFiles): void {
    const excess = state.buffer.length - BUFFER_CAP;
    if (excess <= 0) return;
    state.buffer.splice(0, excess);
    this.drops.overflow += excess;
  }

  /**
   * Send the thread's heartbeat, with buffered files as extras. A second call
   * while one is in flight sends nothing, so nothing ever supersedes a waiting
   * batch. A final call waits for the flush in flight, then sends every chunk.
   */
  async deliver(req: DeliverRequest): Promise<void> {
    // A final stop only uses state that is there: archiving meanwhile must not bring it back.
    if (!req.final) this.attach(req.id, req.project, req.environmentId);
    let state = this.states.get(req.id);
    while (req.final && state?.inFlight) {
      await state.inFlight;
      state = this.states.get(req.id);
    }
    if (state === undefined || state.flushing || !this.alive(state)) return;
    state.flushing = true;
    state.inFlight = this.flush(state, req).finally(() => {
      state.flushing = false;
      state.inFlight = null;
      if (state.retire && this.states.get(state.id) === state) this.states.delete(state.id);
    });
    await state.inFlight;
  }

  private async flush(state: ThreadFiles, req: DeliverRequest): Promise<void> {
    for (let first = true; ; first = false) {
      const settings = await this.settings.get().catch(() => null);
      if (settings === null || !this.alive(state)) return;
      this.applyPrivacy(state, settings);
      if (!this.timed(settings, state.project)) return;
      const chunk = state.buffer.splice(0, CHUNK_SIZE);
      if (!first && chunk.length === 0) return;
      const job = req.build(chunk, first);
      // Held back by the throttle. Not reachable for a thread today (its entry is
      // forgotten whenever its timer ends), kept because only the first call consults it.
      if (job === null) {
        state.buffer.unshift(...chunk);
        return;
      }
      const epoch = state.epoch;
      const outcome = await this.runner.submit(job);
      this.settle(state, chunk, outcome, epoch);
      if (outcome !== "ok" || !req.final) return;
    }
  }

  /** Account for a chunk after the runner answered. */
  private settle(state: ThreadFiles, chunk: FileSpec[], outcome: JobOutcome, epoch: number): void {
    if (outcome === "ok") {
      if (chunk.length > 0) this.lastFileBatchAt = Date.now();
    } else if (outcome === "failed") {
      this.drops.failed += chunk.length;
    } else if (this.alive(state)) {
      // Skipped or superseded: the CLI never saw it. After a reset it must not come back.
      if (state.epoch !== epoch) {
        this.drops.filtered += chunk.length;
      } else {
        state.buffer.unshift(...chunk);
        this.trim(state);
      }
    }
  }

  /** The thread is no longer timed (tracking off or excluded): drop its files and forget it once idle. */
  untime(id: string): void {
    const state = this.states.get(id);
    if (state === undefined) return;
    this.reset(state);
    this.retire(state);
  }

  /** Archive or delete: forget the thread now; a late link finds no state and stops. */
  drop(id: string): void {
    this.states.delete(id);
  }

  /** Pending specs are discarded. */
  dispose(): void {
    this.disposed = true;
    this.states.clear();
  }

  stats() {
    let pending = 0;
    for (const state of this.states.values()) pending += state.buffer.length;
    return { lastFileBatchAt: this.lastFileBatchAt, pendingFiles: pending, droppedFiles: { ...this.drops } };
  }

  /** Test hook: how many threads have state, and how much they hold. */
  size() {
    let buffered = 0;
    let reads = 0;
    for (const state of this.states.values()) {
      buffered += state.buffer.length;
      reads += state.reads.size;
    }
    return { threads: this.states.size, buffered, reads };
  }
}
