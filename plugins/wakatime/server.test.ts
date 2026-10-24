import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "./package.json" with { type: "json" };
import plugin from "./server.js";
import { AGENT_TICK_MS } from "./src/tracker.js";

const PROJECT = { id: "prj_1", name: "acme" };

let dir: string;
let cli: string;
let host: FakePluginHost;
let execCalls: { file: string; args: string[]; stdin: string | null }[];
let eventRows: { seq: number; createdAt: number; data: unknown }[];
let pendingInteractions: { turnId: string | null }[] = [];
let projectListCalls = 0;
let repoDir: string;
let thread: ReturnType<typeof makeThreadResponse>;

// Captured before any test fakes timers.
const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise<void>((resolve) => realSetTimeout(resolve, 30));

let versionCalls = 0;
let version: () => Promise<{ currentVersion: string }>;

async function start(settings: Record<string, string | boolean> = {}) {
  versionCalls = 0;
  host = createFakePluginHost({
    pluginId: "wakatime",
    settings: { cliPath: cli, ...settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId !== thread.id) throw new Error("not found");
          return thread;
        },
        listRunning: async () => (thread.status === "active" ? [{ id: thread.id, hostId: null }] : []),
        events: {
          list: async (args: { afterSeq?: string; order: string; limit: string }) => {
            if (args.order === "desc") return eventRows.slice(-1);
            return eventRows.filter((row) => row.seq > Number(args.afterSeq)).slice(0, Number(args.limit));
          },
        },
        interactions: {
          list: async () => pendingInteractions.map((row) => ({ ...row })),
        },
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          if (projectId !== PROJECT.id) throw new Error("not found");
          return PROJECT;
        },
        list: async () => {
          projectListCalls++;
          return [PROJECT];
        },
      },
      system: {
        version: async () => {
          versionCalls++;
          return version();
        },
      },
      environments: {
        get: async () => ({ branchName: "feat/x", path: repoDir }),
        status: async () => ({ outcome: "unavailable" }),
      },
    } as never,
  });
  await plugin(host.bb);
  await flush();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "waka-server-"));
  cli = path.join(dir, "wakatime-cli");
  writeFileSync(cli, "#!/bin/sh\n");
  chmodSync(cli, 0o755);
  execCalls = [];
  eventRows = [];
  pendingInteractions = [];
  projectListCalls = 0;
  repoDir = mkdtempSync(path.join(os.tmpdir(), "waka-repo-"));
  version = async () => ({ currentVersion: "9.8.7" });
  thread = makeThreadResponse({ id: "thr_1", projectId: PROJECT.id, title: "Fix login", status: "idle", environmentId: "env_1" });
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => {
    const call: (typeof execCalls)[number] = { file, args, stdin: null };
    execCalls.push(call);
    const stdin = new PassThrough();
    stdin.setEncoding("utf8");
    stdin.on("data", (text: string) => (call.stdin = (call.stdin ?? "") + text));
    cb(null, "", "");
    return { stdin };
  }) as never);
});

afterEach(async () => {
  await host.harness.dispose();
  vi.mocked(execFile).mockImplementation(() => {
    throw new Error("real execFile called under vitest");
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("wakatime plugin", () => {
  it("declares settings with the documented defaults", async () => {
    await start();
    const d = host.harness.registrations.settingsDescriptors;
    expect(Object.keys(d).sort()).toEqual(
      ["agentCategory", "cliPath", "entity", "excludeProjects", "fileActivity", "trackAgentActivity", "trackUserActivity", "userCategory"],
    );
    expect(d.cliPath).toMatchObject({ default: "~/.wakatime/wakatime-cli" });
    expect(d.entity).toMatchObject({ default: "title", options: ["title", "threadId"] });
    expect(d.fileActivity).toMatchObject({ type: "select", default: "edits-and-reads", options: ["edits-and-reads", "edits", "off"] });
    expect(d.agentCategory).toMatchObject({ type: "select", default: "building" });
    expect(d.userCategory).toMatchObject({ type: "select", default: "coding" });
    for (const key of ["userCategory", "agentCategory"]) {
      const options = (d[key] as { options: string[] }).options;
      expect(options).toHaveLength(20);
      expect(options).not.toContain("ai coding");
    }
  });

  it("serves a heartbeat RPC that spawns the cli with the plugin string", async () => {
    await start();
    expect(await host.harness.callRpc("heartbeat", { threadId: "thr_1" })).toEqual({ sent: true });
    await flush();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.file).toBe(cli);
    expect(execCalls[0]!.args).toContain("--entity=Fix login");
    expect(execCalls[0]!.args).toContain("--project=acme");
    expect(execCalls[0]!.args).toContain(`--plugin=bb/9.8.7 bb-wakatime/${pkg.version}`);
  });

  it("reads the host version once at startup, not per heartbeat", async () => {
    await start();
    await host.harness.callRpc("heartbeat", { threadId: "thr_1" });
    await host.harness.callRpc("heartbeat", { projectId: "prj_1" });
    await flush();
    expect(versionCalls).toBe(1);
  });

  it("falls back to bb/unknown when the version cannot be read", async () => {
    version = async () => {
      throw new Error("offline");
    };
    await start();
    await host.harness.callRpc("heartbeat", { threadId: "thr_1" });
    await flush();
    expect(execCalls[0]!.args).toContain(`--plugin=bb/unknown bb-wakatime/${pkg.version}`);
  });

  it("handles RPC calls and events while version() is still pending, then uses the version once it answers", async () => {
    let answer!: (value: { currentVersion: string }) => void;
    version = () => new Promise((resolve) => (answer = resolve));
    await start();
    // start() returned although version() has not answered.
    expect(await host.harness.callRpc("heartbeat", { threadId: "thr_1" })).toEqual({ sent: true });
    thread = { ...thread, status: "active" };
    await host.harness.emitThreadEvent("thread.active", { thread });
    await flush();
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of execCalls) expect(call.args).toContain(`--plugin=bb/unknown bb-wakatime/${pkg.version}`);
    answer({ currentVersion: "9.8.7" });
    await flush();
    execCalls.length = 0;
    // A different entity passes the throttle.
    await host.harness.callRpc("heartbeat", {});
    await flush();
    expect(execCalls[0]!.args).toContain(`--plugin=bb/9.8.7 bb-wakatime/${pkg.version}`);
    expect(versionCalls).toBe(1);
  });

  it("says bb/unknown when the host reports an empty version", async () => {
    version = async () => ({ currentVersion: "" });
    await start();
    await host.harness.callRpc("heartbeat", { threadId: "thr_1" });
    await flush();
    expect(execCalls[0]!.args).toContain(`--plugin=bb/unknown bb-wakatime/${pkg.version}`);
  });

  it("aborts the version call after 5000 ms", async () => {
    let seen: AbortSignal | undefined;
    host = createFakePluginHost({
      pluginId: "wakatime",
      settings: { cliPath: cli },
      sdk: {
        threads: { listRunning: async () => [] },
        projects: { list: async () => [] },
        system: {
          version: (args?: { signal?: AbortSignal }) => {
            seen = args?.signal;
            return new Promise(() => undefined);
          },
        },
      } as never,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await plugin(host.bb);
      expect(seen).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(4999);
      expect(seen!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawns nothing after the plugin is disposed", async () => {
    await start();
    await host.harness.callRpc("heartbeat", { threadId: "thr_1" });
    await flush();
    expect(execCalls).toHaveLength(1);
    await host.harness.dispose();
    await flush();
    expect(execCalls).toHaveLength(1);
  });

  it("rejects a malformed or oversized id without sending anything", async () => {
    await start();
    for (const input of [{ threadId: "--key=x" }, { projectId: "a b" }, { threadId: "x".repeat(200) }, { threadId: "" }]) {
      await expect(host.harness.callRpc("heartbeat", input)).rejects.toThrow();
    }
    expect(await host.harness.callRpc("heartbeat", { threadId: "thr_unknown" })).toEqual({ sent: false });
    await flush();
    expect(execCalls).toHaveLength(0);
  });

  it("resolves the project from a thread-only call", async () => {
    await start();
    await host.harness.callRpc("heartbeat", { threadId: "thr_1" });
    await flush();
    expect(execCalls[0]!.args).toContain("--project=acme");
  });

  it("serves status", async () => {
    await start({ excludeProjects: "ghost" });
    await host.harness.callRpc("heartbeat", {});
    await flush();
    const status = (await host.harness.callRpc("status", null)) as { cliPath: string; lastSuccessAt: number | null; unmatchedExcludes: string[] };
    expect(status.cliPath).toBe(cli);
    expect(status.lastSuccessAt).not.toBeNull();
    expect(status.unmatchedExcludes).toEqual(["ghost"]);
  });

  it("times an active thread from thread.active to thread.idle, with no transcript sync", async () => {
    await start();
    thread = { ...thread, status: "active" };
    await host.harness.emitThreadEvent("thread.active", { thread });
    await flush();
    thread = { ...thread, status: "idle" };
    await host.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await flush();
    expect(execCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of execCalls) {
      expect(call.args).toContain("--category=building");
      expect(call.args).toContain("--sync-ai-disabled");
      expect(call.args).not.toContain("--sync-ai-activity");
    }
  });

  it("sends the files an agent edited with the final heartbeat, as extras on stdin", async () => {
    await start();
    thread = { ...thread, status: "active" };
    await host.harness.emitThreadEvent("thread.active", { thread });
    await flush();
    writeFileSync(path.join(repoDir, "a.ts"), "x");
    eventRows = [
      {
        seq: 7,
        createdAt: 1_700_000_000_500,
        data: {
          item: {
            type: "fileChange",
            status: "completed",
            changes: [
              { kind: "update", path: path.join(repoDir, "a.ts"), diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n" },
              { kind: "update", path: "/elsewhere/secret.txt", diff: "@@ -1 +1 @@\n-a\n+b\n" },
            ],
          },
        },
      },
    ];
    thread = { ...thread, status: "idle" };
    await host.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await flush();
    const withFiles = execCalls.filter((call) => call.args.includes("--extra-heartbeats"));
    expect(withFiles).toHaveLength(1);
    const extras = JSON.parse(withFiles[0]!.stdin!) as Record<string, unknown>[];
    expect(extras).toEqual([
      {
        entity: path.join(realpathSync(repoDir), "a.ts"),
        type: "file",
        category: "building",
        time: 1_700_000_000.5,
        project: "acme",
        alternate_branch: "feat/x",
        is_write: true,
        ai_line_changes: 2,
      },
    ]);
    expect(withFiles[0]!.stdin!.endsWith("\n")).toBe(true);
    expect(JSON.stringify(extras)).not.toContain("secret");
  });

  it("ignores a stored value for the removed syncAiActivity setting", async () => {
    await start({ syncAiActivity: true });
    expect(await host.harness.callRpc("heartbeat", {})).toEqual({ sent: true });
    const settings = host.harness.registrations.settingsDescriptors;
    expect(Object.keys(settings)).not.toContain("syncAiActivity");
    await flush();
    for (const call of execCalls) expect(call.args).not.toContain("--sync-ai-activity");
  });

  it("starts timers for threads already active when the plugin loads", async () => {
    thread = makeThreadResponse({ id: "thr_1", projectId: PROJECT.id, title: "Fix login", status: "active", environmentId: "env_1" });
    await start();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.args).toContain("--entity=Fix login");
  });

  it("clears its timers when the plugin is disposed", async () => {
    thread = makeThreadResponse({ id: "thr_1", projectId: PROJECT.id, title: "Fix login", status: "active", environmentId: "env_1" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await start();
      expect(vi.getTimerCount()).toBe(1);
      await host.harness.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no cli calls while an active thread's turn waits on an interaction", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await start();
      pendingInteractions = [{ turnId: "turn_1" }];
      thread = {
        ...thread,
        status: "active",
        runtime: { displayStatus: "active", hostReconnectGraceExpiresAt: null },
      };
      await host.harness.emitThreadEvent("thread.active", { thread });
      await flush();
      expect(execCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(AGENT_TICK_MS);
      await flush();
      expect(execCalls).toHaveLength(0);
      // The timer is kept while the thread waits.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a timer from an experimental_thread.events payload and ends it on thread.failed", async () => {
    thread = { ...thread, status: "active" };
    await start();
    expect(execCalls).toHaveLength(1);
    await host.harness.emitThreadEvent("thread.failed", { thread: { ...thread, status: "error" }, error: null });
    await flush();
    expect(execCalls).toHaveLength(2);
  });

  it("consumes experimental_thread.events payloads", async () => {
    await start();
    thread = { ...thread, status: "active" };
    await host.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 1 });
    await flush();
    expect(execCalls).toHaveLength(1);
  });

  it.each(["thread.archived", "thread.deleted"] as const)("clears the timer on %s", async (event) => {
    thread = makeThreadResponse({ id: "thr_1", projectId: PROJECT.id, title: "Fix login", status: "active", environmentId: "env_1" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await start();
      expect(vi.getTimerCount()).toBe(1);
      await host.harness.emitThreadEvent(event, { thread });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the thread lifecycle listeners", async () => {
    await start();
    const handlers = host.harness.registrations.threadEventHandlers;
    for (const event of ["thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.deleted", "experimental_thread.events"] as const) {
      expect(handlers[event]).toBe(1);
    }
  });

  it("checks excludeProjects again when the setting changes", async () => {
    await start({ excludeProjects: "ghost" });
    await host.harness.setSettings({ excludeProjects: "ghost\nother" });
    await flush();
    const lines = host.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(lines).toContain("excludeProjects entry #1 matches no project");
    expect(lines).toContain("excludeProjects entry #2 matches no project");
    expect(lines.join("\n")).not.toContain("ghost");
  });

  it("does not re-check excludeProjects when another setting changes", async () => {
    await start({ excludeProjects: "ghost" });
    expect(projectListCalls).toBe(1);
    await host.harness.setSettings({ userCategory: "debugging" });
    await flush();
    expect(projectListCalls).toBe(1);
  });
});
