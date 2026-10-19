import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYNC_WINDOW_MS } from "./ai-sync.js";
import { createRunner, HEARTBEAT_TIMEOUT_MS, MAX_CONCURRENT, SYNC_TIMEOUT_MS } from "./cli.js";
import type { Exec, ExecResult, Job, JobOutcome, Runner, RunnerHealth } from "./cli.js";
import { THROTTLE_MS } from "./heartbeat.js";
import type { ThreadLike } from "./heartbeat.js";
import { AGENT_TICK_MS, createTracker } from "./tracker.js";
import type { TrackerSdk } from "./tracker.js";
import type { WakatimeSettings } from "./settings.js";

const T0 = 1_700_000_000_000;
const PROJECT = { id: "prj_1", name: "acme" };
const PLUGIN = "bb/unknown bb-wakatime/0.1.0";
const OK: ExecResult = { exitCode: 0, signal: null, spawnError: null, stderr: "" };

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
    agentCategory: "ai coding",
    syncAiActivity: true,
    entity: "title",
    excludeProjects: "",
    ...overrides,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

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
  const heldSync: ((outcome: JobOutcome) => void)[] = [];
  let holdSync = false;
  const state = {
    getCalls: 0,
    getError: false,
    gate: null as Promise<void> | null,
    settingsDelayMs: 0,
    settingsError: false,
    threadsListError: false,
    listCalls: 0,
    listIgnoresOffset: false,
    projectsListError: false,
    projectsListCalls: 0,
  };
  const health: RunnerHealth = { cliPath: null, lastSuccessAt: null, lastError: null };
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const fakeRunner: Runner = {
    submit(job) {
      jobs.push(job);
      if (job.key === "sync" && holdSync) return new Promise((resolve) => heldSync.push(resolve));
      return Promise.resolve("ok");
    },
    health: () => ({ ...health }),
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
      async list({ offset, limit }) {
        state.listCalls++;
        if (state.threadsListError) throw new Error("down");
        const all = [...threads.values()];
        if (state.listIgnoresOffset) return all.slice(0, 3);
        return all.slice(offset, offset + limit);
      },
    },
    projects: {
      async get({ projectId }) {
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
        return { branchName: "feat/x" };
      },
      async status() {
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
    plugin: PLUGIN,
  });

  return {
    tracker,
    settings,
    threads,
    jobs,
    heldSync,
    state,
    health,
    log,
    holdSync: (value: boolean) => (holdSync = value),
    heartbeats: () => jobs.filter((job) => job.key.startsWith("heartbeat:")),
    syncs: () => jobs.filter((job) => job.key === "sync"),
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
});

afterEach(() => {
  vi.useRealTimers();
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
      "--category=ai coding",
      `--time=${(T0 / 1000).toFixed(3)}`,
      `--plugin=${PLUGIN}`,
      "--sync-ai-disabled",
    ]);
    expect(first.timeoutMs).toBe(HEARTBEAT_TIMEOUT_MS);
    expect(first.cliPath).toBe("/opt/wakatime-cli");
  });

  it("stops on idle and failed, sending a final heartbeat and requesting a sync", async () => {
    for (const _case of ["idle", "failed"]) {
      const h = harness({ threads: [thread("thr_1")] });
      h.tracker.onActive(h.threads.get("thr_1")!);
      await settle();
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      expect(h.heartbeats()).toHaveLength(2);
      await h.idle("thr_1");
      expect(h.heartbeats()).toHaveLength(3);
      expect(h.syncs()).toHaveLength(1);
      expect(h.syncs()[0]!.args).toEqual(["--sync-ai-activity"]);
      expect(h.syncs()[0]!.timeoutMs).toBe(SYNC_TIMEOUT_MS);
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
    await vi.advanceTimersByTimeAsync(1);
    expect(h.heartbeats()).toHaveLength(1);
    h.state.settingsDelayMs = 0;
    await vi.advanceTimersByTimeAsync(AGENT_TICK_MS - 1);
    // The tick landed 119 999 ms after the start heartbeat, inside the throttle window.
    expect(AGENT_TICK_MS - 1).toBeLessThan(THROTTLE_MS);
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
    expect(h.tracker.stateSize()).toEqual({ timers: 0, confirming: 0, throttle: 0, branches: 0 });
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
  it("pages through threads.list and starts timers only for active threads", async () => {
    const idle = Array.from({ length: 120 }, (_, i) => thread(`thr_i${i}`, { status: "idle" }));
    const h = harness({
      threads: [...idle, thread("thr_a", { status: "active" }), thread("thr_e", { status: "error" })],
    });
    await h.tracker.reconcile();
    await settle();
    expect(h.state.listCalls).toBe(2);
    expect(h.tracker.stateSize().timers).toBe(1);
    expect(h.heartbeats()).toHaveLength(1);
    expect(arg(h.heartbeats()[0]!, "--entity")).toBe("Title thr_a");
  });

  it("ends the loop when the host keeps returning the same short page", async () => {
    const h = harness({ threads: [thread("thr_1", { status: "idle" }), thread("thr_2", { status: "active" })] });
    h.state.listIgnoresOffset = true;
    await h.tracker.reconcile();
    expect(h.state.listCalls).toBe(1);
    expect(h.tracker.stateSize().timers).toBe(1);
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

  it("still syncs after a turn when only trackAgentActivity is off", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { trackAgentActivity: false } });
    await h.idle("thr_1");
    expect(h.heartbeats()).toHaveLength(0);
    expect(h.syncs()).toHaveLength(1);
  });

  it("sends nothing from the user RPC with trackUserActivity off", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { trackUserActivity: false } });
    expect(await h.tracker.userHeartbeat({ threadId: "thr_1" })).toBe(false);
    expect(h.jobs).toHaveLength(0);
  });

  it("runs no sync with syncAiActivity off", async () => {
    const h = harness({ threads: [thread("thr_1")], settings: { syncAiActivity: false } });
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS * 2);
    expect(h.heartbeats()).toHaveLength(1);
    expect(h.syncs()).toHaveLength(0);
  });

  it("skips a sync already scheduled when the setting is switched off before it fires", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    await h.idle("thr_1");
    await h.idle("thr_1");
    expect(h.syncs()).toHaveLength(1);
    h.settings.syncAiActivity = false;
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    expect(h.syncs()).toHaveLength(1);
  });

  it.each([["id", "prj_1"], ["name", "acme"]])(
    "an excluded project (%s) gets no timer, no heartbeats, and its idle triggers no sync",
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
    await h.idle("thr_1");
    // The idle also starts a sync, which has its own key; the final heartbeat waits.
    await until(() => calls.length === 2);
    const heartbeatCalls = () => calls.filter((call) => !call.args.includes("--sync-ai-activity"));
    expect(heartbeatCalls()).toHaveLength(1);
    calls[0]!.settle(OK);
    await until(() => heartbeatCalls().length === 2);
    expect(heartbeatCalls()[1]!.args).toContain("--category=ai coding");
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

describe("AI sync", () => {
  it("runs one sync at once and one trailing sync after the last idle of a burst", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    await h.idle("thr_1");
    expect(h.syncs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(60_000);
    await h.idle("thr_1");
    expect(h.syncs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    expect(h.syncs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS * 3);
    expect(h.syncs()).toHaveLength(2);
  });

  it("defers a request made right after the trailing run to the end of the new window", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(1000);
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    expect(h.syncs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await h.idle("thr_1");
    expect(h.syncs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS - 3000);
    expect(h.syncs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.syncs()).toHaveLength(3);
  });

  it("queues at most one follow-up while a run is in flight", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    h.holdSync(true);
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(60_000);
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    await h.idle("thr_1");
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS);
    expect(h.syncs()).toHaveLength(1);
    h.holdSync(false);
    h.heldSync[0]!("ok");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncs()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.syncs()).toHaveLength(2);
  });

  it("stops scheduling after dispose", async () => {
    const h = harness({ threads: [thread("thr_1")] });
    await h.idle("thr_1");
    await h.idle("thr_1");
    h.tracker.dispose();
    await vi.advanceTimersByTimeAsync(SYNC_WINDOW_MS * 2);
    expect(h.syncs()).toHaveLength(1);
  });
});

describe("status and exclude check", () => {
  it("reports the resolved path, last success, last error kind and unmatched excludes", async () => {
    const h = harness({ settings: { excludeProjects: "prj_1, ghost\nacme,missing-too", cliPath: "/opt/wakatime-cli" } });
    expect(await h.tracker.status()).toEqual({
      cliPath: "/opt/wakatime-cli",
      lastSuccessAt: null,
      lastError: null,
      unmatchedExcludes: ["ghost", "missing-too"],
    });
    h.health.cliPath = "/resolved/cli";
    h.health.lastSuccessAt = 5;
    h.health.lastError = { kind: "auth", exitCode: 104, at: 7 };
    expect(await h.tracker.status()).toMatchObject({
      cliPath: "/resolved/cli",
      lastSuccessAt: 5,
      lastError: { kind: "auth", exitCode: 104, at: 7 },
    });
  });

  it("expands ~ in the reported path before the cli has been used", async () => {
    const h = harness({ settings: { cliPath: "~/.wakatime/wakatime-cli" } });
    expect((await h.tracker.status()).cliPath).toBe(path.join(os.homedir(), ".wakatime/wakatime-cli"));
  });

  it("still reports the rest of the status when the project list fails", async () => {
    const h = harness({ settings: { excludeProjects: "ghost" } });
    h.state.projectsListError = true;
    h.health.lastSuccessAt = 9;
    expect(await h.tracker.status()).toMatchObject({ lastSuccessAt: 9, unmatchedExcludes: [] });
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
