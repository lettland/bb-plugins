import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunner, HEARTBEAT_TIMEOUT_MS, MAX_CONCURRENT } from "./cli.js";
import type { Exec, ExecResult, Job, JobOutcome, Runner, RunnerHealth } from "./cli.js";
import { THROTTLE_MS } from "./heartbeat.js";
import type { ThreadLike } from "./heartbeat.js";
import { AGENT_TICK_MS, createTracker } from "./tracker.js";
import type { TrackerSdk } from "./tracker.js";
import type { WakatimeSettings } from "./settings.js";

const T0 = 1_700_000_000_000;
const PROJECT = { id: "prj_1", name: "acme" };
const PLUGIN = "bb/unknown bb-wakatime/0.1.0";
const OK: ExecResult = { exitCode: 0, signal: null, spawnError: null };

function thread(id: string, overrides: Partial<ThreadLike> = {}): ThreadLike {
  return {
    id,
    projectId: PROJECT.id,
    status: "active",
    title: `Title ${id}`,
    titleFallback: null,
    environmentId: "env_1",
    ...overrides,
  };
}

function defaultSettings(overrides: Partial<WakatimeSettings> = {}): WakatimeSettings {
  return {
    cliPath: "/opt/wakatime-cli",
    trackUserActivity: true,
    userCategory: "coding",
    trackAgentActivity: true,
    agentCategory: "building",
    entity: "title",
    fileActivity: "edits-and-reads",
    excludeProjects: "",
    ...overrides,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

// Captured before any test fakes timers: file scope checks wait on real I/O.
const realSetTimeout = globalThis.setTimeout;

interface EventRow {
  seq: number;
  createdAt: number;
  data: unknown;
}

/** The environment folder the fake `environments.get` reports; a real directory, so scope checks hit the filesystem. */
let repoDir: string;

function arg(job: Job, flag: string): string | undefined {
  return job.args.find((value) => value.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

interface Options {
  settings?: Partial<WakatimeSettings>;
  threads?: ThreadLike[];
  projects?: { id: string; name: string }[];
  runner?: Runner;
}

function harness(options: Options = {}) {
  const settings = defaultSettings(options.settings);
  const threads = new Map((options.threads ?? []).map((t) => [t.id, t]));
  const projects = options.projects ?? [PROJECT];
  const jobs: Job[] = [];
  // Each entry answers one waiting job; like the real runner it asks the job's guard first.
  const held: ((outcome: JobOutcome) => void)[] = [];
  const answer = (job: Job, outcome: JobOutcome): Promise<JobOutcome> =>
    job.guard === undefined
      ? Promise.resolve(outcome)
      : job.guard().then(
          (allowed) => (allowed ? outcome : "skipped"),
          () => "skipped",
        );
  const rows: EventRow[] = [];
  const eventCalls: Record<string, unknown>[] = [];
  const state = {
    hold: false,
    outcome: "ok" as JobOutcome,
    eventsError: false as boolean | "string",
    eventsGate: null as Promise<void> | null,
    seedFailures: 0,
    envPath: repoDir as string | null,
    envGetFailures: 0,
    envStatusError: false,
    envBranchNull: false,
    getCalls: 0,
    getError: false,
    gate: null as Promise<void> | null,
    settingsDelayMs: 0,
    settingsError: false,
    threadsListError: false,
    listRunningCalls: 0,
    runningIds: null as string[] | null,
    projectGetCalls: 0,
    projectGetFailures: 0,
    verified: [] as string[],
    onVerify: null as (() => void) | null,
    projectsListError: false,
    projectsListCalls: 0,
  };
  const health: RunnerHealth = { lastHeartbeatAt: null, lastError: null };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const fakeRunner: Runner = {
    submit(job) {
      jobs.push(job);
      if (state.hold) {
        return new Promise((resolve) => held.push((outcome) => void answer(job, outcome).then(resolve)));
      }
      return answer(job, state.outcome);
    },
    health: () => ({ ...health }),
    verify: async (cliPath) => {
      state.verified.push(cliPath);
      state.onVerify?.();
    },
    dispose: () => undefined,
  };

  const sdk: TrackerSdk = {
    threads: {
      async get({ threadId }) {
        state.getCalls++;
        const gate = state.gate;
        if (gate !== null) await gate;
        const found = threads.get(threadId);
        if (state.getError || found === undefined) throw new Error("not found");
        return { ...found };
      },
      events: {
        async list(args) {
          eventCalls.push({ ...args, signal: args.signal instanceof AbortSignal ? "AbortSignal" : args.signal });
          if (state.eventsGate !== null) await state.eventsGate;
          if (state.eventsError === "string") throw "events down";
          if (state.eventsError) throw new Error("events down");
          if (args.order === "desc") {
            if (state.seedFailures > 0) {
              state.seedFailures--;
              throw new Error("seed failed");
            }
            return rows.slice(-1);
          }
          return rows.filter((row) => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit));
        },
      },
      async listRunning() {
        state.listRunningCalls++;
        if (state.threadsListError) throw new Error("down");
        const ids = state.runningIds ?? [...threads.values()].filter((t) => t.status === "active").map((t) => t.id);
        return ids.map((id) => ({ id }));
      },
    },
    projects: {
      async get({ projectId }) {
        state.projectGetCalls++;
        if (state.projectGetFailures > 0) {
          state.projectGetFailures--;
          throw new Error("transient");
        }
        const found = projects.find((p) => p.id === projectId);
        if (found === undefined) throw new Error("not found");
        return found;
      },
      async list() {
        state.projectsListCalls++;
        if (state.projectsListError) throw new Error("down");
        return projects;
      },
    },
    environments: {
      async get() {
        if (state.envGetFailures > 0) {
          state.envGetFailures--;
          throw new Error("environment down");
        }
        return { branchName: state.envBranchNull ? null : "feat/x", path: state.envPath };
      },
      async status() {
        if (state.envStatusError) throw new Error("git down");
        return { outcome: "unavailable" };
      },
    },
  };

  const tracker = createTracker({
    sdk,
    settings: {
      get: async () => {
        if (state.settingsError) throw new Error("settings unavailable");
        if (state.settingsDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.settingsDelayMs));
        return { ...settings };
      },
    },
    runner: options.runner ?? fakeRunner,
    log,
    plugin: () => PLUGIN,
  });

  return {
    tracker,
    settings,
    threads,
    jobs,
    held,
    rows,
    eventCalls,
    state,
    health,
    log,
    heartbeats: () => jobs.filter((job) => job.key.startsWith("heartbeat:")),
    idle(id: string) {
      const t = threads.get(id)!;
      threads.set(id, { ...t, status: "idle" });
      return tracker.onStop({ ...t, status: "idle" });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
  repoDir = mkdtempSync(path.join(os.tmpdir(), "waka-env-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(repoDir, { recursive: true, force: true });
});

describe("agent time", () => {
  it("starts a 2-min interval on thread.active that runs through a silent 20-min stretch", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    expect(h.heartbeats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(h.heartbeats()).toHaveLength(11);
    const first = h.heartbeats()[0]!;
    expect(first.args).toEqual([
      "--entity-type=app",
      "--entity=Title thr_1",
      "--project=acme",
      "--alternate-branch=feat/x",
      "--category=building",
      `--time=${(T0 / 1000).toFixed(3)}`,
      `--plugin=${PLUGIN}`,
      "--sync-ai-disabled",
    ]);
    expect(first.timeoutMs).toBe(HEARTBEAT_TIMEOUT_MS);
    expect(first.cliPath).toBe("/opt/wakatime-cli");
  });

  it("stops on idle and failed, sending a final heartbeat and no more after it", async () => {
    for (const _case of ["idle", "failed"]) {
      const h = harness({ threads: [thread("thr_1")] });
      h.tracker.onActive(h.threads.get("thr_1")!);
      await settle();
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      expect(h.heartbeats()).toHaveLength(2);
      await h.idle("thr_1");
      expect(h.heartbeats()).toHaveLength(3);
      expect(h.jobs.some((job) => job.args.includes("--sync-ai-activity"))).toBe(false);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(h.heartbeats()).toHaveLength(3);
    }
  });

  it("uses the same stop path for a failed thread", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    await h.tracker.onStop({ ...h.threads.get("thr_1")!, status: "error" });
    expect(h.heartbeats()).toHaveLength(2);
    expect(h.tracker.stateSize().timers).toBe(0);
  });

  it("ignores an events payload whose status is not active", async () => {
    const h = harness({ threads: [thread("thr_1", { status: "idle" })] });
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await settle();
    expect(h.state.getCalls).toBe(0);
    expect(h.jobs).toHaveLength(0);
  });

  it("starts nothing for a stale active payload after idle, even if no earlier payload was seen", async () => {
    const h = harness({ threads: [thread("thr_1", { status: "idle" })] });
    h.tracker.onEvents({ thread: thread("thr_1", { status: "active" }) });
    await settle();
    expect(h.state.getCalls).toBe(1);
    expect(h.tracker.stateSize().timers).toBe(0);
    expect(h.jobs).toHaveLength(0);
  });

  it("starts a timer from an active payload that threads.get confirms (plugin loaded mid-turn)", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await settle();
    expect(h.tracker.stateSize().timers).toBe(1);
    expect(h.heartbeats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.heartbeats()).toHaveLength(2);
  });

  it("skips the live read for a payload when agent time is off, the project is excluded by id, or settings fail", async () => {
    const off = harness({ threads: [thread("thr_1")], settings: { trackAgentActivity: false } });
    off.tracker.onEvents({ thread: off.threads.get("thr_1")! });
    const excluded = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "prj_1" } });
    excluded.tracker.onEvents({ thread: excluded.threads.get("thr_1")! });
    const broken = harness({ threads: [thread("thr_1")] });
    broken.state.settingsError = true;
    broken.tracker.onEvents({ thread: broken.threads.get("thr_1")! });
    await settle();
    for (const h of [off, excluded, broken]) {
      expect(h.state.getCalls).toBe(0);
      expect(h.tracker.stateSize()).toMatchObject({ timers: 0, confirming: 0 });
    }
  });

  it("clears the timer when a tick finds the thread idle, sending nothing", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.threads.set("thr_1", thread("thr_1", { status: "idle" }));
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.heartbeats()).toHaveLength(1);
    expect(h.tracker.stateSize().timers).toBe(0);
  });

  it("clears the timer when a tick's threads.get rejects, and re-arms from the next active payload", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.state.getError = true;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.tracker.stateSize().timers).toBe(0);
    h.state.getError = false;
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await settle();
    expect(h.tracker.stateSize().timers).toBe(1);
  });

  it("sends nothing from a tick whose threads.get resolves active after idle cleared its timer", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    let open!: () => void;
    h.state.gate = new Promise<void>((resolve) => (open = resolve));
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    const before = h.heartbeats().length;
    await h.idle("thr_1");
    const afterIdle = h.heartbeats().length;
    expect(afterIdle).toBe(before + 1);
    // The gated read still reports the old status.
    h.threads.set("thr_1", thread("thr_1", { status: "active" }));
    open();
    await settle();
    expect(h.heartbeats()).toHaveLength(afterIdle);
    expect(h.tracker.stateSize().timers).toBe(0);
  });

  it("does not start a second timer on a second thread.active", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    expect(h.tracker.stateSize().timers).toBe(1);
    expect(h.heartbeats()).toHaveLength(1);
  });

  it("starts no second timer or start heartbeat when a payload's read resolves after thread.active", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    let open!: () => void;
    h.state.gate = new Promise<void>((resolve) => (open = resolve));
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await settle();
    expect(h.state.getCalls).toBe(1);
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    expect(h.heartbeats()).toHaveLength(1);
    open();
    await settle();
    expect(h.tracker.stateSize()).toMatchObject({ timers: 1, confirming: 0 });
    expect(h.heartbeats()).toHaveLength(1);
  });

  it("voids a payload confirmation when the thread stops during its read", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    let open!: () => void;
    h.state.gate = new Promise<void>((resolve) => (open = resolve));
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await h.tracker.onStop({ ...h.threads.get("thr_1")!, status: "idle" });
    const sent = h.heartbeats().length;
    open();
    await settle();
    expect(h.tracker.stateSize().timers).toBe(0);
    expect(h.heartbeats()).toHaveLength(sent);
  });

  it("sends the first tick even though the start heartbeat went out 1 ms after the timer started", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.settingsDelayMs = 1;
    h.tracker.onActive(h.threads.get("thr_1")!);
    // Two settings reads of 1 ms each (start, then the send) precede the start heartbeat.
    await vi.advanceTimersByTimeAsync(2);
    expect(h.heartbeats()).toHaveLength(1);
    h.state.settingsDelayMs = 0;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS - 2);
    // The tick landed 119 998 ms after the start heartbeat, inside the throttle window.
    expect(AGENT_TICK_MS - 2).toBeLessThan(THROTTLE_MS);
    expect(h.heartbeats()).toHaveLength(2);
  });

  it("leaves no per-thread state after idle, archive, delete or dispose", async () => {
    const h = harness({ threads: [thread("thr_1"), thread("thr_2"), thread("thr_3"), thread("thr_4")] });
    for (const id of ["thr_1", "thr_2", "thr_3", "thr_4"]) h.tracker.onActive(h.threads.get(id)!);
    await settle();
    h.tracker.onEvents({ thread: thread("thr_5") });
    expect(h.tracker.stateSize()).toMatchObject({ timers: 4, throttle: 4 });
    await h.idle("thr_1");
    h.tracker.onGone("thr_2");
    h.tracker.onGone("thr_3");
    expect(h.tracker.stateSize()).toMatchObject({ timers: 1, throttle: 1 });
    h.tracker.dispose();
    expect(h.tracker.stateSize()).toEqual({
      timers: 0,
      confirming: 0,
      notTimed: 0,
      throttle: 0,
      branches: 0,
      files: { threads: 0, buffered: 0, reads: 0 },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.heartbeats().length).toBeLessThanOrEqual(5);
    const count = h.heartbeats().length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.heartbeats()).toHaveLength(count);
  });

  it("does not start timers after dispose", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.dispose();
    h.tracker.onActive(h.threads.get("thr_1")!);
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    await settle();
    expect(h.jobs).toHaveLength(0);
  });

  it("uses the thread id only in threadId mode, and reads a retitled thread fresh", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.threads.set("thr_1", thread("thr_1", { title: "Renamed" }));
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.heartbeats().map((job) => arg(job, "--entity"))).toEqual(["Title thr_1", "Renamed"]);
    h.settings.entity = "threadId";
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(arg(h.heartbeats()[2]!, "--entity")).toBe("thr_1");
  });
});

describe("settings read failures", () => {
  it("releases the timer when the start heartbeat cannot read settings", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.settingsError = true;
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    expect(h.tracker.stateSize().timers).toBe(0);
    expect(h.jobs).toHaveLength(0);
  });

  it("releases the timer when a tick cannot read settings", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.state.settingsError = true;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.tracker.stateSize().timers).toBe(0);
    expect(h.heartbeats()).toHaveLength(1);
  });

  it("logs the error name only when a stop cannot read settings", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.settingsError = true;
    await h.idle("thr_1");
    expect(h.log.warn).toHaveBeenCalledWith("could not finish thread time: Error");
    expect(String(h.log.warn.mock.calls[0]![0])).not.toContain("settings unavailable");
  });
});

describe("startup reconciliation", () => {
  it("starts timers for running threads that threads.get confirms active", async () => {
    const h = harness({
      threads: [
        thread("thr_a", { status: "active" }),
        thread("thr_s", { status: "idle" }),
        thread("thr_e", { status: "error" }),
      ],
    });
    // A starting thread is listed as running but is not active yet.
    h.state.runningIds = ["thr_a", "thr_s", "thr_gone"];
    await h.tracker.reconcile();
    await settle();
    expect(h.state.listRunningCalls).toBe(1);
    expect(h.tracker.stateSize().timers).toBe(1);
    expect(h.heartbeats()).toHaveLength(1);
    expect(arg(h.heartbeats()[0]!, "--entity")).toBe("Title thr_a");
  });

  it("logs and carries on when the list fails", async () => {
    const h = harness();
    h.state.threadsListError = true;
    await h.tracker.reconcile();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("toggles and exclusion", () => {
  it("starts no timers with trackAgentActivity off, and stops one when it is switched off", async () => {
    const off = harness({ threads: [thread("thr_1")], settings: { trackAgentActivity: false } });
    off.tracker.onActive(off.threads.get("thr_1")!);
    await settle();
    expect(off.tracker.stateSize().timers).toBe(0);
    expect(off.jobs).toHaveLength(0);

    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.settings.trackAgentActivity = false;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.heartbeats()).toHaveLength(1);
    expect(h.tracker.stateSize().timers).toBe(0);
  });

  it("sends nothing from the user RPC with trackUserActivity off", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { trackUserActivity: false } });
    expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(false);
    expect(h.jobs).toHaveLength(0);
  });

  it.each([["id", "prj_1"], ["name", "acme"]])(
    "an excluded project (%s) gets no timer, no heartbeats, and its idle sends nothing",
    async (_label, entry) => {
      const h = harness({ threads: [thread("thr_1")], settings: { excludeProjects: `other\n${entry}` } });
      h.tracker.onActive(h.threads.get("thr_1")!);
      await settle();
      expect(h.tracker.stateSize().timers).toBe(0);
      await h.idle("thr_1");
      expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(false);
      expect(await h.tracker.userHeartbeat({ projectId: "prj_1" })).toBe(false);
      expect(h.jobs).toHaveLength(0);
    },
  );

  it("stops a running timer when its project becomes excluded", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.settings.excludeProjects = "prj_1";
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.heartbeats()).toHaveLength(1);
    expect(h.tracker.stateSize().timers).toBe(0);
  });

  it("sends nothing at idle when the thread's project cannot be resolved", async () => {
    const h = harness({ threads: [thread("thr_1", { projectId: "prj_gone" })] });
    await h.idle("thr_1");
    expect(h.jobs).toHaveLength(0);
  });
});

describe("user heartbeats", () => {
  it("resolves the project from a thread-only call and sends the user category", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(true);
    const job = h.jobs[0]!;
    expect(arg(job, "--project")).toBe("acme");
    expect(arg(job, "--category")).toBe("coding");
    expect(arg(job, "--entity")).toBe("Title thr_1");
    expect(job.key).toBe("heartbeat:user");
  });

  it("sends entity bb and no project for a view with no ids", async () => {
    const h = harness();
    expect(await h.tracker.userHeartbeat({})).toBe(true);
    expect(arg(h.jobs[0]!, "--entity")).toBe("bb");
    expect(h.jobs[0]!.args.some((value) => value.startsWith("--project"))).toBe(false);
  });

  it("sends nothing for an id that cannot be resolved", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    expect(await h.tracker.userHeartbeat({ threadId: "thr_missing" })).toBe(false);
    expect(await h.tracker.userHeartbeat({ projectId: "prj_missing" })).toBe(false);
    expect(h.jobs).toHaveLength(0);
  });

  it("throttles to one per 120 s but lets a change of entity through", async () => {
    const h = harness({ threads: [thread("thr_1"), thread("thr_2")] });
    expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(true);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS - 1);
    expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(false);
    expect(await h.tracker.userHeartbeat({ threadId: "thr_2" })).toBe(true);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(await h.tracker.userHeartbeat({ threadId: "thr_2" })).toBe(true);
    expect(h.jobs).toHaveLength(3);
  });
});

describe("with the real runner", () => {
  let dir: string;
  let cli: string;
  let calls: { args: string[]; settle: (result: ExecResult) => void }[];
  let exec: Exec;

  // Real turns: the runner's path check goes through the real filesystem.
  async function until(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !condition(); i++) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(condition()).toBe(true);
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "waka-tracker-"));
    cli = path.join(dir, "wakatime-cli");
    writeFileSync(cli, "#!/bin/sh\n");
    chmodSync(cli, 0o755);
    calls = [];
    exec = (_file, args) =>
      new Promise((resolve) => {
        calls.push({ args, settle: resolve });
      });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function realHarness(options: Options = {}) {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = createRunner({ exec, log });
    return harness({ ...options, runner, settings: { cliPath: cli, ...options.settings } });
  }

  it("queues a final heartbeat behind an in-flight one instead of dropping it", async () => {
    const h = realHarness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await until(() => calls.length === 1);
    // The final stop waits for the start heartbeat's flush, then sends its own.
    const stopping = h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    calls[0]!.settle(OK);
    await until(() => calls.length === 2);
    calls[1]!.settle(OK);
    await stopping;
    expect(calls[1]!.args).toContain("--category=building");
  });

  it("counts a batch as failed, and does not re-buffer it, when the spawn fails after a verified path", async () => {
    const h = realHarness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await until(() => calls.length === 1);
    calls[0]!.settle(OK);
    await vi.advanceTimersByTimeAsync(0);
    h.rows.push({
      seq: 1,
      createdAt: T0,
      data: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [{ kind: "update", path: path.join(repoDir, "a.ts"), diff: "@@ -1 +1 @@\n-a\n+b\n" }],
        },
      },
    });
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    await until(() => calls.length === 2);
    expect(calls[1]!.args).toContain("--extra-heartbeats");
    calls[1]!.settle({ exitCode: null, signal: null, spawnError: "ENOENT" });
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const status = await h.tracker.status();
    expect(status.droppedFiles.failed).toBe(1);
    expect(status.pendingFiles).toBe(0);
  });

  it("resolves the final stop with files still buffered when the cli path is missing", async () => {
    const h = realHarness({ threads: [thread("thr_1")], settings: { cliPath: path.join(dir, "missing-cli") } });
    h.tracker.onActive(h.threads.get("thr_1")!);
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    h.rows.push({
      seq: 1,
      createdAt: T0,
      data: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [{ kind: "update", path: path.join(repoDir, "a.ts"), diff: "@@ -1 +1 @@\n-a\n+b\n" }],
        },
      },
    });
    h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
    for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    await h.idle("thr_1");
    expect(calls).toHaveLength(0);
    expect((await h.tracker.status()).pendingFiles).toBe(1);
  });

  it("caps 6 simultaneous ticks at 4 processes and keeps each heartbeat's creation time", async () => {
    const ids = ["thr_1", "thr_2", "thr_3", "thr_4", "thr_5", "thr_6"];
    const h = realHarness({ threads: ids.map((id) => thread(id)) });
    for (const id of ids) h.tracker.onActive(h.threads.get(id)!);
    // Drain the six start heartbeats.
    let served = 0;
    while (served < 6) {
      await until(() => calls.length > served);
      calls[served]!.settle(OK);
      served++;
    }
    await until(() => calls.length === 6);
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    const tickTime = ((T0 + AGENT_TICK_MS) / 1000).toFixed(3);
    await until(() => calls.length === before + MAX_CONCURRENT);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(before + MAX_CONCURRENT);
    // Slots free a while later; the queued two spawn with the time they were created.
    vi.setSystemTime(T0 + AGENT_TICK_MS + 30_000);
    calls[before]!.settle(OK);
    calls[before + 1]!.settle(OK);
    await until(() => calls.length === before + 6);
    const ticks = calls.slice(before);
    expect(ticks.map((call) => call.args.find((a) => a.startsWith("--time=")))).toEqual(
      Array(6).fill(`--time=${tickTime}`),
    );
  });
});

describe("status and exclude check", () => {
  it("reports the current cli path, the last heartbeat, the last error and unmatched excludes", async () => {
    const h = harness({ settings: { excludeProjects: "prj_1, ghost\nacme,missing-too", cliPath: "/opt/wakatime-cli" } });
    expect(await h.tracker.status()).toEqual({
      cliPath: "/opt/wakatime-cli",
      lastHeartbeatAt: null,
      lastError: null,
      lastFileBatchAt: null,
      pendingFiles: 0,
      droppedFiles: { outOfScope: 0, overflow: 0, filtered: 0, failed: 0 },
      waitingOnEnvironment: 0,
      unmatchedExcludes: ["ghost", "missing-too"],
    });
    h.health.lastHeartbeatAt = 5;
    h.health.lastError = { kind: "auth", exitCode: 104, at: 7 };
    h.settings.cliPath = "/opt/other-cli";
    expect(await h.tracker.status()).toMatchObject({
      cliPath: "/opt/other-cli",
      lastHeartbeatAt: 5,
      lastError: { kind: "auth", exitCode: 104, at: 7 },
    });
  });

  it("checks the current cli path before reading the health state", async () => {
    const h = harness({ settings: { cliPath: "/opt/new-cli" } });
    h.health.lastError = { kind: "missing-cli", exitCode: null, at: 1, problem: "not-found" };
    h.state.onVerify = () => {
      // The check of the fixed path clears the old path's error before status reads it.
      h.health.lastError = null;
    };
    const status = await h.tracker.status();
    expect(h.state.verified).toEqual(["/opt/new-cli"]);
    expect(status.lastError).toBeNull();
  });

  it("expands ~ in the reported path", async () => {
    const h = harness({ settings: { cliPath: "~/.wakatime/wakatime-cli" } });
    expect((await h.tracker.status()).cliPath).toBe(path.join(os.homedir(), ".wakatime/wakatime-cli"));
  });

  it("still reports the rest of the status when the project list fails", async () => {
    const h = harness({ settings: { excludeProjects: "ghost" } });
    h.state.projectsListError = true;
    h.health.lastHeartbeatAt = 9;
    expect(await h.tracker.status()).toMatchObject({ lastHeartbeatAt: 9, unmatchedExcludes: [] });
  });

  it("warns once per distinct excludeProjects value, by entry position and never by name", async () => {
    const h = harness({ settings: { excludeProjects: "prj_1\nsecret-client-name, other-ghost" } });
    await h.tracker.checkExcludes();
    await h.tracker.checkExcludes();
    const lines = h.log.warn.mock.calls.map((call) => String(call[0]));
    expect(lines).toEqual([
      "excludeProjects entry #2 matches no project",
      "excludeProjects entry #3 matches no project",
    ]);
    expect(lines.join("\n")).not.toContain("secret-client-name");
    h.settings.excludeProjects = "gone-again";
    await h.tracker.checkExcludes();
    expect(h.log.warn).toHaveBeenCalledTimes(3);
    expect(String(h.log.warn.mock.calls[2]![0])).toBe("excludeProjects entry #1 matches no project");
  });

  it("lists no projects when there is nothing to check", async () => {
    const h = harness({ settings: { excludeProjects: " , \n" } });
    await h.tracker.checkExcludes();
    expect(h.state.projectsListCalls).toBe(0);
    expect(h.log.warn).not.toHaveBeenCalled();
  });

  it("retries the check after the project list failed", async () => {
    const h = harness({ settings: { excludeProjects: "ghost" } });
    h.state.projectsListError = true;
    await h.tracker.checkExcludes();
    expect(h.log.warn).not.toHaveBeenCalled();
    h.state.projectsListError = false;
    await h.tracker.checkExcludes();
    expect(h.log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("threads that are not timed", () => {
  async function payloads(h: ReturnType<typeof harness>, count: number) {
    for (let i = 0; i < count; i++) {
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await vi.advanceTimersByTimeAsync(1000);
    }
  }

  it("reads a name-excluded active thread once, however many payloads arrive", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "acme" } });
    await payloads(h, 1);
    const reads = { get: h.state.getCalls, project: h.state.projectGetCalls, timers: h.tracker.stateSize().timers };
    expect(reads).toEqual({ get: 1, project: 1, timers: 0 });
    await payloads(h, 6);
    expect(h.state.getCalls).toBe(reads.get);
    expect(h.state.projectGetCalls).toBe(reads.project);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 0, confirming: 0, notTimed: 1 });
    expect(h.jobs).toHaveLength(0);
  });

  it("also stops re-reading when tracking is off", async () => {
    const off = harness({ threads: [thread("thr_1")], settings: { trackAgentActivity: false } });
    await payloads(off, 4);
    expect(off.state.getCalls).toBe(0);
    expect(off.tracker.stateSize().notTimed).toBe(1);
  });

  it("does not mark a thread whose context cannot be resolved, so a later payload times it", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.projectGetFailures = 1;
    await payloads(h, 1);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 0, notTimed: 0 });
    await payloads(h, 1);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 1, notTimed: 0 });
    expect(h.heartbeats()).toHaveLength(1);
  });

  it("does not mark a thread when a tick cannot resolve its context", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.state.projectGetFailures = 1;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 0, notTimed: 0 });
    await payloads(h, 1);
    expect(h.tracker.stateSize().timers).toBe(1);
  });

  it("does not mark a thread from settings that changed while a tick's read was pending", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.settings.trackAgentActivity = false;
    h.state.settingsDelayMs = 10;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    // The tick has confirmed the thread and is waiting on its settings read.
    expect(h.tracker.stateSize().timers).toBe(1);
    h.tracker.onSettingsChanged();
    await vi.advanceTimersByTimeAsync(20);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 0, notTimed: 0 });
    expect(h.heartbeats()).toHaveLength(1);
  });

  it("does not mark a thread from settings that changed while the read was pending", async () => {
    const adopting = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "prj_1" } });
    adopting.state.settingsDelayMs = 10;
    adopting.tracker.onEvents({ thread: adopting.threads.get("thr_1")! });
    await vi.advanceTimersByTimeAsync(1);
    adopting.settings.excludeProjects = "";
    adopting.tracker.onSettingsChanged();
    await vi.advanceTimersByTimeAsync(20);
    // The read saw the old exclusion, but it is stale, so nothing is remembered.
    expect(adopting.tracker.stateSize().notTimed).toBe(0);

    const starting = harness({ threads: [thread("thr_1")], settings: { trackAgentActivity: false } });
    starting.state.settingsDelayMs = 10;
    starting.tracker.onActive(starting.threads.get("thr_1")!);
    await vi.advanceTimersByTimeAsync(1);
    starting.tracker.onSettingsChanged();
    await vi.advanceTimersByTimeAsync(20);
    expect(starting.tracker.stateSize()).toMatchObject({ timers: 0, notTimed: 0 });
  });

  it("marks a running timer's thread as not timed when a tick finds it excluded", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.tracker.onActive(h.threads.get("thr_1")!);
    await settle();
    h.settings.excludeProjects = "acme";
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    expect(h.tracker.stateSize()).toMatchObject({ timers: 0, notTimed: 1 });
  });

  it("does not mark a thread whose read merely failed", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.getError = true;
    await payloads(h, 1);
    expect(h.tracker.stateSize().notTimed).toBe(0);
  });

  it.each(["thread.active", "idle", "gone", "settings", "dispose"])("is cleared by %s", async (how) => {
    const h = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "acme" } });
    await payloads(h, 1);
    expect(h.tracker.stateSize().notTimed).toBe(1);
    if (how === "thread.active") {
      // No settings-change signal here: only the activation can clear the mark.
      h.settings.excludeProjects = "";
      h.tracker.onActive(h.threads.get("thr_1")!);
      await settle();
      expect(h.tracker.stateSize()).toMatchObject({ timers: 1, notTimed: 0 });
      return;
    }
    if (how === "idle") await h.idle("thr_1");
    if (how === "gone") h.tracker.onGone("thr_1");
    if (how === "settings") h.tracker.onSettingsChanged();
    if (how === "dispose") h.tracker.dispose();
    expect(h.tracker.stateSize().notTimed).toBe(0);
  });

  it("times the thread again after the exclusion is removed and settings change", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "acme" } });
    await payloads(h, 1);
    h.settings.excludeProjects = "";
    h.tracker.onSettingsChanged();
    await payloads(h, 1);
    expect(h.tracker.stateSize().timers).toBe(1);
    expect(h.heartbeats()).toHaveLength(1);
  });
});

describe("failures at the edges", () => {
  it("checkExcludes swallows a failing settings read and retries later", async () => {
    const h = harness({ settings: { excludeProjects: "ghost" } });
    h.state.settingsError = true;
    await expect(h.tracker.checkExcludes()).resolves.toBeUndefined();
    expect(h.log.warn).not.toHaveBeenCalled();
    h.state.settingsError = false;
    await h.tracker.checkExcludes();
    expect(h.log.warn).toHaveBeenCalledWith("excludeProjects entry #1 matches no project");
  });

  it("sends no final heartbeat or sync when disposed while a stop is resolving", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.state.settingsDelayMs = 10;
    const stopping = h.idle("thr_1");
    h.tracker.dispose();
    await vi.advanceTimersByTimeAsync(50);
    await stopping;
    expect(h.jobs).toHaveLength(0);
  });

  it("keeps going when one running thread cannot be read at startup", async () => {
    const h = harness({ threads: [thread("thr_a")] });
    h.state.runningIds = ["thr_missing", "thr_a"];
    await h.tracker.reconcile();
    await settle();
    expect(h.tracker.stateSize().timers).toBe(1);
  });
});

describe("file delivery", () => {
  /** Real filesystem I/O sits behind the scope checks, so give the event loop real turns. */
  async function drain(done?: () => boolean) {
    for (let i = 0; i < (done === undefined ? 25 : 3000); i++) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => (done === undefined ? setImmediate(resolve) : realSetTimeout(resolve, 1)));
      if (done?.()) return;
    }
  }

  async function drainUntil(done: () => Promise<boolean>) {
    for (let i = 0; i < 5000; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
      if (await done()) return;
    }
  }

  const DIFF = "@@ -1 +1 @@\n-a\n+b\n";

  function nextSeq(h: ReturnType<typeof harness>): number {
    return (h.rows[h.rows.length - 1]?.seq ?? 0) + 1;
  }

  function edit(h: ReturnType<typeof harness>, file: string, createdAt = T0 + 1) {
    h.rows.push({
      seq: nextSeq(h),
      createdAt,
      data: {
        item: {
          type: "fileChange",
          status: "completed",
          changes: [{ kind: "update", path: path.join(repoDir, file), diff: DIFF }],
        },
      },
    });
  }

  function read(h: ReturnType<typeof harness>, file: string, createdAt: number) {
    h.rows.push({
      seq: nextSeq(h),
      createdAt,
      data: { item: { type: "fileRead", status: "completed", path: path.join(repoDir, file) } },
    });
  }

  function extras(job: Job): Record<string, unknown>[] {
    return job.stdin === undefined ? [] : (JSON.parse(job.stdin) as Record<string, unknown>[]);
  }

  /** The files a job carries, relative to the environment folder. */
  function files(job: Job): string[] {
    return extras(job).map((extra) => path.relative(realpathSync(repoDir), String(extra.entity)));
  }

  const sentFiles = (h: ReturnType<typeof harness>) => h.heartbeats().flatMap(files);

  async function start(h: ReturnType<typeof harness>, id = "thr_1") {
    h.tracker.onActive(h.threads.get(id)!);
    await drain();
  }

  async function tick() {
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
    await drain();
  }

  const asc = (h: ReturnType<typeof harness>) => h.eventCalls.filter((call) => call.order === "asc");
  const desc = (h: ReturnType<typeof harness>) => h.eventCalls.filter((call) => call.order === "desc");

  describe("pulling", () => {
    it("starts at the tip with a string afterSeq, never omitted, and does not replay history", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      edit(h, "old1.ts");
      edit(h, "old2.ts");
      await start(h);
      edit(h, "new.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(desc(h)).toEqual([expect.objectContaining({ threadId: "thr_1", order: "desc", limit: "1" })]);
      expect(asc(h).length).toBeGreaterThan(0);
      for (const call of asc(h)) {
        expect(typeof call.afterSeq).toBe("string");
        expect(call.types).toEqual(["item/completed"]);
        expect(call.limit).toBe("200");
        expect(call.signal).toBe("AbortSignal");
      }
      expect(asc(h)[0]!.afterSeq).toBe("2");
      await tick();
      expect(sentFiles(h)).toEqual(["new.ts"]);
    });

    it("does not replay history for a thread adopted mid-turn from an events payload", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      edit(h, "before.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      edit(h, "after.ts");
      await tick();
      expect(sentFiles(h)).toEqual(["after.ts"]);
      expect(desc(h)).toHaveLength(1);
    });

    it("stops paging on a short page", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      for (let i = 0; i < 450; i++) edit(h, `f${i}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain(() => h.tracker.stateSize().files.buffered === 450);
      await drain();
      expect(asc(h).map((call) => call.afterSeq)).toEqual(["0", "0", "200", "400"]);
      expect(h.tracker.stateSize().files.buffered).toBe(450);
    });

    it("makes no CLI call when it pulls", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const before = h.jobs.length;
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.jobs).toHaveLength(before);
      expect(h.tracker.stateSize().files.buffered).toBe(1);
    });

    it("sends an empty buffer as the app heartbeat alone", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      await tick();
      const last = h.heartbeats()[h.heartbeats().length - 1]!;
      expect(last.stdin).toBeUndefined();
      expect(last.args).not.toContain("--extra-heartbeats");
    });

    it("retries a failed seed on the next payload, pulling nothing before it, and does not send what landed in between", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      h.state.seedFailures = 1;
      await start(h);
      expect(desc(h)).toHaveLength(1);
      expect(asc(h)).toHaveLength(0);
      expect(h.log.warn).toHaveBeenCalledWith("could not read thread events (thr_1): Error");
      edit(h, "gap.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(desc(h)).toHaveLength(2);
      edit(h, "later.ts");
      await tick();
      expect(sentFiles(h)).toEqual(["later.ts"]);
      expect((await h.tracker.status()).droppedFiles).toEqual({ outOfScope: 0, overflow: 0, filtered: 0, failed: 0 });
    });

    it("logs a failing events read once by error name, and keeps the chain going", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      h.state.eventsError = true;
      for (let i = 0; i < 3; i++) {
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
      }
      expect(h.log.warn).toHaveBeenCalledTimes(1);
      expect(String(h.log.warn.mock.calls[0]![0])).toBe("could not read thread events (thr_1): Error");
      h.state.eventsError = false;
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.tracker.stateSize().files.buffered).toBe(1);
    });
  });

  describe("reads", () => {
    it("throttles a repeated read of one path by createdAt, never a write", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      read(h, "a.ts", T0);
      read(h, "a.ts", T0 + 119_999);
      read(h, "a.ts", T0 + 120_000);
      read(h, "b.ts", T0 + 1);
      edit(h, "a.ts", T0 + 2);
      edit(h, "a.ts", T0 + 3);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      const sent = extras(h.heartbeats()[h.heartbeats().length - 1]!);
      expect(sent.map((e) => [path.basename(String(e.entity)), e.is_write, e.time])).toEqual([
        ["a.ts", false, T0 / 1000],
        ["a.ts", false, (T0 + 120_000) / 1000],
        ["b.ts", false, (T0 + 1) / 1000],
        ["a.ts", true, (T0 + 2) / 1000],
        ["a.ts", true, (T0 + 3) / 1000],
      ]);
    });

    it("sends no reads in edits mode, and counts the buffered ones as filtered when the mode changes", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      read(h, "r.ts", T0);
      edit(h, "w.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.tracker.stateSize().files.buffered).toBe(2);
      h.settings.fileActivity = "edits";
      await tick();
      expect(sentFiles(h)).toEqual(["w.ts"]);
      expect((await h.tracker.status()).droppedFiles.filtered).toBe(1);
    });
  });

  describe("flushing", () => {
    it("sends more than 200 specs in chunks of 200, in order, each awaited, at the final stop", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      for (let i = 0; i < 450; i++) edit(h, `f${String(i).padStart(3, "0")}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain(() => h.tracker.stateSize().files.buffered === 450);
      const before = h.jobs.length;
      expect(before).toBe(1);
      h.state.hold = true;
      const stopping = h.idle("thr_1");
      for (let chunk = 0; chunk < 3; chunk++) {
        for (let i = 0; i < 30 && h.jobs.length < before + chunk + 1; i++) await drain();
        expect(h.jobs).toHaveLength(before + chunk + 1);
        h.held[chunk]!("ok");
      }
      await stopping;
      const final = h.jobs.slice(before);
      expect(final.map((job) => files(job).length)).toEqual([200, 200, 50]);
      expect(final.flatMap(files)).toEqual(Array.from({ length: 450 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`));
      expect(h.jobs).toHaveLength(before + 3);
    });

    it("re-buffers a batch the runner skipped or superseded, in order, and sends it next time", async () => {
      for (const outcome of ["skipped", "superseded"] as const) {
        const h = harness({ threads: [thread("thr_1")] });
        await start(h);
        edit(h, "a.ts");
        edit(h, "b.ts");
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
        h.state.outcome = outcome;
        await tick();
        expect(h.tracker.stateSize().files.buffered).toBe(2);
        edit(h, "c.ts");
        h.state.outcome = "ok";
        await tick();
        expect(files(h.heartbeats()[h.heartbeats().length - 1]!)).toEqual(["a.ts", "b.ts", "c.ts"]);
        expect((await h.tracker.status()).pendingFiles).toBe(0);
      }
    });

    it("counts a failed batch under failed and does not re-buffer it", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.outcome = "failed";
      await tick();
      const status = await h.tracker.status();
      expect(status.droppedFiles.failed).toBe(1);
      expect(status.pendingFiles).toBe(0);
      expect(status.lastFileBatchAt).toBeNull();
    });

    it("records the time of the last batch the CLI accepted", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      expect((await h.tracker.status()).lastFileBatchAt).toBe(T0 + AGENT_TICK_MS);
    });

    it("submits nothing from a tick that finds a flush still in flight, and never has two submitters", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      h.state.hold = true;
      h.tracker.onActive(h.threads.get("thr_1")!);
      await drain();
      expect(h.held).toHaveLength(1);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      await tick();
      expect(h.jobs).toHaveLength(1);
      expect(h.tracker.stateSize().files.buffered).toBeGreaterThanOrEqual(0);
      h.state.hold = false;
      h.held[0]!("ok");
      await drain();
      edit(h, "b.ts");
      await tick();
      expect(h.jobs).toHaveLength(2);
      expect(sentFiles(h)).toEqual(["a.ts", "b.ts"]);
    });

    it("sends the activation and the final heartbeats through the same path, one in flight at a time", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      h.state.hold = true;
      h.tracker.onActive(h.threads.get("thr_1")!);
      await drain();
      const stopping = h.idle("thr_1");
      await drain();
      // The activation heartbeat is still waiting on the runner, so the final one has not been submitted.
      expect(h.jobs).toHaveLength(1);
      h.state.hold = false;
      h.held[0]!("ok");
      await stopping;
      expect(h.jobs).toHaveLength(2);
      expect(new Set(h.jobs.map((job) => job.key))).toEqual(new Set(["heartbeat:thr_1"]));
    });
  });
  describe("lifecycle", () => {
    it("frees the pull state, buffer and read throttle on archive and on dispose", async () => {
      for (const how of ["archive", "dispose"] as const) {
        const h = harness({ threads: [thread("thr_1")] });
        await start(h);
        read(h, "a.ts", T0);
        edit(h, "b.ts");
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
        expect(h.tracker.stateSize().files).toEqual({ threads: 1, buffered: 2, reads: 1 });
        if (how === "archive") h.tracker.onGone("thr_1");
        else h.tracker.dispose();
        expect(h.tracker.stateSize().files).toEqual({ threads: 0, buffered: 0, reads: 0 });
      }
    });

    it("keeps its state across idle, so idle then active replays and skips nothing", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      await h.idle("thr_1");
      edit(h, "while-idle.ts");
      h.threads.set("thr_1", thread("thr_1"));
      await start(h);
      edit(h, "b.ts");
      await tick();
      expect(sentFiles(h)).toEqual(["a.ts", "while-idle.ts", "b.ts"]);
      expect(desc(h)).toHaveLength(1);
      expect(h.tracker.stateSize().files.threads).toBe(1);
    });

    it("loses and replays nothing when the thread goes active again while its final pull is pending", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      edit(h, "b.ts");
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      const stopping = h.idle("thr_1");
      h.tracker.onActive(h.threads.get("thr_1")!);
      await drain();
      open();
      await stopping;
      await drain();
      expect(sentFiles(h).sort()).toEqual(["a.ts", "b.ts"]);
      expect(desc(h)).toHaveLength(1);
    });

    it("loses and replays nothing when the thread goes active again while its final flush is pending", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      const stopping = h.idle("thr_1");
      await drain();
      expect(h.held).toHaveLength(1);
      h.tracker.onActive(h.threads.get("thr_1")!);
      await drain();
      expect(h.jobs).toHaveLength(2);
      h.state.hold = false;
      h.held[0]!("ok");
      await stopping;
      await drain();
      expect(sentFiles(h)).toEqual(["a.ts"]);
      expect(desc(h)).toHaveLength(1);
    });

    it("resolves the final stop and still sends the app heartbeat when the final pull is rejected", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      h.state.eventsError = true;
      const before = h.jobs.length;
      await h.idle("thr_1");
      expect(h.jobs).toHaveLength(before + 1);
    });

    it("resolves the final stop with files left buffered when the runner skips (a missing cli)", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      for (let i = 0; i < 450; i++) edit(h, `f${i}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain(() => h.tracker.stateSize().files.buffered === 450);
      const before = h.jobs.length;
      h.state.outcome = "skipped";
      await h.idle("thr_1");
      expect(h.jobs).toHaveLength(before + 1);
      expect(h.tracker.stateSize().files.buffered).toBe(450);
    });

    it("resolves the final stop when the plugin is disposed while a chunk is in flight", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      const stopping = h.idle("thr_1");
      await drain();
      h.tracker.dispose();
      h.held[0]!("skipped");
      await stopping;
      expect(h.jobs).toHaveLength(2);
      expect(h.tracker.stateSize().files.buffered).toBe(0);
    });

    it("leaves nothing behind when the thread is archived while its final pull or flush is in flight", async () => {
      for (const stage of ["pull", "flush"] as const) {
        const h = harness({ threads: [thread("thr_1")] });
        await start(h);
        edit(h, "a.ts");
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
        edit(h, "b.ts");
        let open!: () => void;
        if (stage === "pull") h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
        else h.state.hold = true;
        const stopping = h.idle("thr_1");
        await drain();
        h.tracker.onGone("thr_1");
        if (stage === "pull") open();
        else h.held[0]!("skipped");
        await stopping;
        await drain();
        expect(h.tracker.stateSize().files).toEqual({ threads: 0, buffered: 0, reads: 0 });
        expect((await h.tracker.status()).pendingFiles).toBe(0);
      }
    });
  });

  describe("privacy", () => {
    it.each([
      ["the project is excluded", { excludeProjects: "prj_1" }],
      ["agent tracking is turned off", { trackAgentActivity: false }],
      ["file activity is turned off", { fileActivity: "off" }],
      ["the entity becomes the thread id", { entity: "threadId" }],
    ] as const)("discards what is buffered when %s, and starts at the new tip when it is turned back on", async (_label, change) => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "buffered.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.tracker.stateSize().files.buffered).toBe(1);
      const restore = Object.fromEntries(Object.keys(change).map((key) => [key, h.settings[key as keyof WakatimeSettings]]));
      Object.assign(h.settings, change);
      h.tracker.onSettingsChanged();
      await drain();
      expect(h.tracker.stateSize().files.buffered).toBe(0);
      expect((await h.tracker.status()).droppedFiles.filtered).toBe(1);
      edit(h, "untracked.ts");
      Object.assign(h.settings, restore);
      h.tracker.onSettingsChanged();
      // The first send after re-enabling reads the tip; only what lands after it is sent.
      await tick();
      edit(h, "tracked.ts");
      await tick();
      const sent = sentFiles(h);
      expect(sent).not.toContain("buffered.ts");
      expect(sent).not.toContain("untracked.ts");
      expect(sent).toContain("tracked.ts");
    });

    it("applies a privacy change at the next flush even when the settings-change signal was missed", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      read(h, "b.ts", T0);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.settings.fileActivity = "off";
      await tick();
      expect(sentFiles(h)).toEqual([]);
      expect((await h.tracker.status()).droppedFiles.filtered).toBe(2);
    });

    it("keeps the app heartbeat flowing, through the flush path, with file activity off or the entity a thread id", async () => {
      for (const change of [{ fileActivity: "off" }, { entity: "threadId" }] as const) {
        const h = harness({ threads: [thread("thr_1")], settings: change });
        await start(h);
        edit(h, "a.ts");
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await tick();
        await tick();
        expect(h.heartbeats()).toHaveLength(3);
        expect(sentFiles(h)).toEqual([]);
        expect(h.eventCalls).toHaveLength(0);
        expect(h.tracker.stateSize().files.buffered).toBe(0);
      }
    });

    it("sends no file specs for an excluded thread, and reads no events", async () => {
      const h = harness({ threads: [thread("thr_1")], settings: { excludeProjects: "acme" } });
      edit(h, "a.ts");
      h.tracker.onActive(h.threads.get("thr_1")!);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await tick();
      expect(h.jobs).toHaveLength(0);
      expect(h.eventCalls).toHaveLength(0);
      expect(h.tracker.stateSize().files.threads).toBe(0);
    });

    it("does not let a batch in flight come back after file activity was switched off", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual(["a.ts"]);
      h.settings.fileActivity = "off";
      h.tracker.onSettingsChanged();
      await drain();
      // The next tick finds the flush still in flight: nothing is submitted, so nothing is superseded.
      const submitted = h.jobs.length;
      await tick();
      expect(h.jobs).toHaveLength(submitted);
      h.state.hold = false;
      h.held[0]!("skipped");
      await drain();
      const status = await h.tracker.status();
      expect(status.droppedFiles.filtered).toBe(1);
      expect(status.pendingFiles).toBe(0);
      await tick();
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual([]);
    });

    it("keeps pulling without a replay when excludeProjects changes for another project mid-turn", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.settings.excludeProjects = "prj_other";
      h.tracker.onSettingsChanged();
      await drain();
      edit(h, "b.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      expect(sentFiles(h)).toEqual(["a.ts", "b.ts"]);
      expect(desc(h)).toHaveLength(1);
    });
  });

  describe("limits", () => {
    it("caps the buffer at 2000, dropping the oldest and counting them as overflow", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      for (let i = 0; i < 2100; i++) edit(h, `f${i}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drainUntil(async () => (await h.tracker.status()).droppedFiles.overflow === 100);
      const status = await h.tracker.status();
      expect(status.pendingFiles).toBe(2000);
      expect(status.droppedFiles.overflow).toBe(100);
    });

    it("counts the excess as overflow when a skipped batch is put back on a buffer that grew meanwhile", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      for (let i = 0; i < 300; i++) edit(h, `f${i}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain(() => h.tracker.stateSize().files.buffered === 300);
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      expect(h.tracker.stateSize().files.buffered).toBe(100);
      for (let i = 0; i < 1950; i++) edit(h, `g${i}.ts`);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drainUntil(async () => (await h.tracker.status()).droppedFiles.overflow === 50);
      expect(h.tracker.stateSize().files.buffered).toBe(2000);
      h.state.hold = false;
      h.held[0]!("skipped");
      await drain();
      const status = await h.tracker.status();
      expect(status.pendingFiles).toBe(2000);
      // 50 over the cap while pulling, then 200 more when the skipped batch goes back.
      expect(status.droppedFiles.overflow).toBe(250);
    });
  });
  describe("races", () => {
    it("sends nothing from a tick whose thread stopped while it was pulling", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      h.tracker.onGone("thr_1");
      open();
      await drain();
      expect(h.jobs).toHaveLength(1);
    });

    it("sends nothing at the final stop when the thread is archived while it resolves", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const stopping = h.idle("thr_1");
      h.tracker.onGone("thr_1");
      await stopping;
      await drain();
      expect(h.jobs).toHaveLength(1);
      expect(h.tracker.stateSize().files.threads).toBe(0);
    });

    it("keeps a retired state until its flush settles, then forgets it", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      h.settings.excludeProjects = "prj_1";
      h.tracker.onSettingsChanged();
      await drain();
      expect(h.tracker.stateSize().files.threads).toBe(1);
      h.state.hold = false;
      h.held[0]!("ok");
      await drain();
      expect(h.tracker.stateSize().files.threads).toBe(0);
    });

    it("stops a send whose thread stopped being timed while the tick was pulling", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      h.settings.trackAgentActivity = false;
      open();
      await drain();
      expect(h.jobs).toHaveLength(1);
      expect(h.tracker.stateSize().files.threads).toBe(0);
    });

    it("counts files of a thread with no environment folder as out of scope", async () => {
      const h = harness({ threads: [thread("thr_1", { environmentId: null })] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      const status = await h.tracker.status();
      expect(status.droppedFiles.outOfScope).toBe(1);
      expect(status.pendingFiles).toBe(0);
    });

    it("forgets a thread archived while its first read of the tip is pending", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      h.tracker.onActive(h.threads.get("thr_1")!);
      await drain();
      h.tracker.onGone("thr_1");
      open();
      await drain();
      expect(h.tracker.stateSize().files.threads).toBe(0);
      edit(h, "a.ts");
      expect(asc(h)).toHaveLength(0);
    });

    it("forgets a thread archived while a pull is reading settings", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const reads = asc(h).length;
      h.state.settingsDelayMs = 10;
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await vi.advanceTimersByTimeAsync(1);
      h.tracker.onGone("thr_1");
      await vi.advanceTimersByTimeAsync(20);
      await drain();
      expect(h.tracker.stateSize().files.threads).toBe(0);
      expect(asc(h)).toHaveLength(reads);
    });

    it("logs a rejected events read that is not an Error by the generic name", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      h.state.eventsError = "string";
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.log.warn).toHaveBeenCalledWith("could not read thread events (thr_1): error");
    });
  });
  describe("environment lookup", () => {
    it("keeps the rows of a page and sends them later when the environment cannot be read once", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      // Let the cached environment expire so the next pull has to read it again.
      await vi.advanceTimersByTimeAsync(61_000);
      h.state.envGetFailures = 1;
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect((await h.tracker.status()).droppedFiles.outOfScope).toBe(0);
      expect(h.tracker.stateSize().files.buffered).toBe(0);
      expect(h.log.warn).toHaveBeenCalledTimes(1);
      expect(h.log.warn).toHaveBeenCalledWith("could not read the thread's environment (thr_1)");
      // The next pull reads the same rows again.
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.tracker.stateSize().files.buffered).toBe(1);
      await tick();
      expect(sentFiles(h)).toEqual(["a.ts"]);
    });

    it("keeps the folder when only the branch fallback fails, so the specs are in scope", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      h.state.envBranchNull = true;
      h.state.envStatusError = true;
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      expect(sentFiles(h)).toEqual(["a.ts"]);
      expect((await h.tracker.status()).droppedFiles.outOfScope).toBe(0);
    });

    it("still counts a thread with no environment folder, or an empty one, as out of scope", async () => {
      for (const envPath of [null, ""] as const) {
        const h = harness({ threads: [thread("thr_1")] });
        h.state.envPath = envPath;
        await start(h);
        edit(h, "a.ts");
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
        expect((await h.tracker.status()).droppedFiles.outOfScope).toBe(1);
      }
    });
  });

  describe("the pull queue", () => {
    it("keeps at most one pull running and one waiting, however many payloads arrive", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const before = asc(h).length;
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      for (let i = 0; i < 25; i++) h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(asc(h).length - before).toBe(1);
      open();
      await drain();
      expect(asc(h).length - before).toBe(2);
    });

    it("does not make a tick or a stop wait behind a backlog", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      for (let i = 0; i < 25; i++) h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      const stopping = h.idle("thr_1");
      await drain();
      open();
      await stopping;
      await drain();
      // The running pull, the one waiting, and nothing queued for the 25 payloads or the stop.
      expect(asc(h).length).toBeLessThanOrEqual(4);
      expect(h.jobs).toHaveLength(2);
    });

    it("skips a pull whose payload sequence is not past what was read", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      edit(h, "old.ts");
      await start(h);
      const before = asc(h).length;
      h.tracker.onEvents({ thread: h.threads.get("thr_1")!, sequence: 1 });
      await drain();
      expect(asc(h).length).toBe(before);
      edit(h, "new.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")!, sequence: 2 });
      await drain();
      expect(asc(h).length).toBe(before + 1);
      expect(h.tracker.stateSize().files.buffered).toBe(1);
    });
  });

  describe("a job that waited", () => {
    it("is skipped, not spawned, and counted as filtered when file activity was switched off while it waited", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      expect(h.jobs[h.jobs.length - 1]!.guard).toBeTypeOf("function");
      // The change lands without the settings-change signal; the guard reads the settings itself.
      h.settings.fileActivity = "off";
      h.state.hold = false;
      h.held[0]!("ok");
      await drain();
      const status = await h.tracker.status();
      expect(status.droppedFiles.filtered).toBe(1);
      expect(status.pendingFiles).toBe(0);
      expect(status.lastFileBatchAt).toBeNull();
    });

    it("is allowed through when nothing changed, and an app heartbeat without files carries no guard", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      expect(h.jobs[0]!.guard).toBeUndefined();
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      h.state.hold = false;
      h.held[0]!("ok");
      await drain();
      expect((await h.tracker.status()).lastFileBatchAt).not.toBeNull();
    });
  });

  describe("fail closed", () => {
    it("sends and reads nothing when the stored fileActivity value is unknown", async () => {
      const h = harness({ threads: [thread("thr_1")], settings: { fileActivity: "everything" } });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await tick();
      expect(sentFiles(h)).toEqual([]);
      expect(h.eventCalls).toHaveLength(0);
    });
  });

  describe("at send time", () => {
    it("sends a file that has since become a symlink, or vanished, as unsaved", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const outside = path.join(repoDir, "..", `waka-outside-${path.basename(repoDir)}`);
      writeFileSync(outside, "x");
      try {
      writeFileSync(path.join(repoDir, "swapped.ts"), "x");
      writeFileSync(path.join(repoDir, "vanished.ts"), "x");
      writeFileSync(path.join(repoDir, "steady.ts"), "x");
      edit(h, "swapped.ts");
      edit(h, "vanished.ts");
      edit(h, "steady.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      // Between the read and the send: one file becomes a symlink, one disappears.
      rmSync(path.join(repoDir, "swapped.ts"));
      symlinkSync(outside, path.join(repoDir, "swapped.ts"));
      rmSync(path.join(repoDir, "vanished.ts"));
      await tick();
      const sent = extras(h.jobs[h.jobs.length - 1]!);
      expect(sent.map((e) => [path.basename(String(e.entity)), e.is_unsaved_entity ?? false])).toEqual([
        ["swapped.ts", true],
        ["vanished.ts", true],
        ["steady.ts", false],
      ]);
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it("builds the app heartbeat from the settings the send read, not from before a pull", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      let open!: () => void;
      h.state.eventsGate = new Promise<void>((resolve) => (open = resolve));
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      h.settings.entity = "threadId";
      open();
      await drain();
      const last = h.jobs[h.jobs.length - 1]!;
      expect(arg(last, "--entity")).toBe("thr_1");
      expect(last.stdin).toBeUndefined();
    });

    it("uses the cleaned project name in the argv and in every file entry", async () => {
      const h = harness({ threads: [thread("thr_1")], projects: [{ id: "prj_1", name: "ac\u202Eme\n" }] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await tick();
      const last = h.jobs[h.jobs.length - 1]!;
      expect(arg(last, "--project")).toBe("acme");
      expect(extras(last).map((extra) => extra.project)).toEqual(["acme"]);
    });
  });

  describe("at the final stop", () => {
    it.each([
      ["agent tracking is off", { trackAgentActivity: false }],
      ["the project is excluded", { excludeProjects: "prj_1" }],
    ] as const)("forgets the thread's read position when %s", async (_label, change) => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.tracker.stateSize().files.threads).toBe(1);
      Object.assign(h.settings, change);
      await h.idle("thr_1");
      expect(h.tracker.stateSize().files).toEqual({ threads: 0, buffered: 0, reads: 0 });
    });
  });
  describe("the send-time guard", () => {
    async function waitingJob(h: ReturnType<typeof harness>) {
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      h.state.hold = false;
    }

    it("sends the writes later but never the reads when the mode narrows to edits while the job waits", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      read(h, "r.ts", T0);
      edit(h, "w.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await waitingJob(h);
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual(["r.ts", "w.ts"]);
      h.settings.fileActivity = "edits";
      h.held[0]!("ok");
      await drain();
      // The call was skipped, so the chunk went back; the reads are not in it any more.
      expect(sentFiles(h)).toEqual(["r.ts", "w.ts"]);
      expect((await h.tracker.status()).lastFileBatchAt).toBeNull();
      await tick();
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual(["w.ts"]);
      const status = await h.tracker.status();
      expect(status.droppedFiles.filtered).toBe(1);
      expect(status.pendingFiles).toBe(0);
    });

    it("skips the call when a file became a symlink during the wait, and the next flush marks it unsaved", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      const target = path.join(repoDir, "..", `waka-target-${path.basename(repoDir)}`);
      writeFileSync(target, "x");
      try {
      writeFileSync(path.join(repoDir, "a.ts"), "x");
      edit(h, "a.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      await waitingJob(h);
      expect(extras(h.jobs[h.jobs.length - 1]!)[0]!.is_unsaved_entity).toBeUndefined();
      rmSync(path.join(repoDir, "a.ts"));
      symlinkSync(target, path.join(repoDir, "a.ts"));
      h.held[0]!("ok");
      await drain();
      expect((await h.tracker.status()).lastFileBatchAt).toBeNull();
      expect((await h.tracker.status()).pendingFiles).toBe(1);
      await tick();
      const last = h.jobs[h.jobs.length - 1]!;
      expect(extras(last).map((e) => [path.basename(String(e.entity)), e.is_unsaved_entity])).toEqual([["a.ts", true]]);
      expect((await h.tracker.status()).lastFileBatchAt).not.toBeNull();
      } finally {
        rmSync(target, { force: true });
      }
    });
  });

  describe("the send-time guard, further", () => {
    it("does not refuse a file that was deleted during the wait, and the heartbeat still goes", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      writeFileSync(path.join(repoDir, "gone.ts"), "x");
      edit(h, "gone.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await drain();
      expect(h.held).toHaveLength(1);
      h.state.hold = false;
      rmSync(path.join(repoDir, "gone.ts"));
      h.held[0]!("ok");
      await drain();
      expect((await h.tracker.status()).lastFileBatchAt).not.toBeNull();
      expect((await h.tracker.status()).pendingFiles).toBe(0);
    });

    it("keeps the writes and counts the reads as filtered when the final stop is refused under an edits narrowing", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      read(h, "r.ts", T0);
      edit(h, "w.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.state.hold = true;
      const stopping = h.idle("thr_1");
      await drain();
      expect(h.held).toHaveLength(1);
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual(["r.ts", "w.ts"]);
      h.settings.fileActivity = "edits";
      h.state.hold = false;
      h.held[0]!("ok");
      await stopping;
      await drain();
      // The final call was skipped: nothing was sent, the chunk went back, the loop stopped.
      expect(h.jobs).toHaveLength(2);
      expect((await h.tracker.status()).pendingFiles).toBe(2);
      expect((await h.tracker.status()).lastFileBatchAt).toBeNull();
      // Next turn: the reads are dropped as filtered and the writes go out.
      h.threads.set("thr_1", thread("thr_1"));
      await start(h);
      expect(files(h.jobs[h.jobs.length - 1]!)).toEqual(["w.ts"]);
      const status = await h.tracker.status();
      expect(status.droppedFiles.filtered).toBe(1);
      expect(status.pendingFiles).toBe(0);
    });
  });

  describe("an unreadable environment, then file activity off", () => {
    it("stops counting the thread as waiting once nothing is held", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      await vi.advanceTimersByTimeAsync(61_000);
      h.state.envGetFailures = 1;
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect((await h.tracker.status()).waitingOnEnvironment).toBe(1);
      h.settings.fileActivity = "off";
      h.tracker.onSettingsChanged();
      await drain();
      expect((await h.tracker.status()).waitingOnEnvironment).toBe(0);
    });

    it("clears it on a pull that finds file activity off, even without the settings-change signal", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      await vi.advanceTimersByTimeAsync(61_000);
      h.state.envGetFailures = 1;
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      h.settings.fileActivity = "off";
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect((await h.tracker.status()).waitingOnEnvironment).toBe(0);
    });
  });

  describe("an unreadable environment", () => {
    it("holds the read position across repeated failures, logs the first one, and shows the count in status", async () => {
      const h = harness({ threads: [thread("thr_1")] });
      await start(h);
      edit(h, "a.ts");
      await vi.advanceTimersByTimeAsync(61_000);
      h.state.envGetFailures = 3;
      for (let i = 0; i < 3; i++) {
        h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
        await drain();
        expect((await h.tracker.status()).waitingOnEnvironment).toBe(1);
      }
      const warnings = h.log.warn.mock.calls.map((call) => String(call[0]));
      expect(warnings).toEqual(["could not read the thread's environment (thr_1)"]);
      // The read position never moved: every pull asked for the same rows.
      const afterSeqs = asc(h).slice(-3).map((call) => call.afterSeq);
      expect(afterSeqs).toEqual([afterSeqs[0], afterSeqs[0], afterSeqs[0]]);
      expect((await h.tracker.status()).droppedFiles.outOfScope).toBe(0);
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      const status = await h.tracker.status();
      expect(status.waitingOnEnvironment).toBe(0);
      expect(status.pendingFiles).toBe(1);
      // After recovering, a later failure is logged again.
      await vi.advanceTimersByTimeAsync(61_000);
      h.state.envGetFailures = 1;
      edit(h, "b.ts");
      h.tracker.onEvents({ thread: h.threads.get("thr_1")! });
      await drain();
      expect(h.log.warn).toHaveBeenCalledTimes(2);
    });
  });
});
