import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkg from "./package.json" with { type: "json" };
import plugin from "./server.js";

const PROJECT = { id: "prj_1", name: "acme" };

let dir: string;
let cli: string;
let host: FakePluginHost;
let execCalls: { file: string; args: string[] }[];
let thread: ReturnType<typeof makeThreadResponse>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

async function start(settings: Record<string, string | boolean> = {}) {
  host = createFakePluginHost({
    pluginId: "wakatime",
    settings: { cliPath: cli, ...settings },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId !== thread.id) throw new Error("not found");
          return thread;
        },
        list: async ({ offset }: { offset?: number }) => ((offset ?? 0) === 0 ? [thread] : []),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          if (projectId !== PROJECT.id) throw new Error("not found");
          return PROJECT;
        },
        list: async () => [PROJECT],
      },
      environments: {
        get: async () => ({ branchName: "feat/x" }),
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
  thread = makeThreadResponse({ id: "thr_1", projectId: PROJECT.id, title: "Fix login", status: "idle", environmentId: "env_1" });
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], _o: unknown, cb: (e: null, o: string, s: string) => void) => {
    execCalls.push({ file, args });
    cb(null, "", "");
  }) as never);
});

afterEach(async () => {
  await host.harness.dispose();
  vi.mocked(execFile).mockImplementation(() => {
    throw new Error("real execFile called under vitest");
  });
  rmSync(dir, { recursive: true, force: true });
});

describe("wakatime plugin", () => {
  it("declares settings with the documented defaults", async () => {
    await start();
    const d = host.harness.registrations.settingsDescriptors;
    expect(Object.keys(d).sort()).toEqual(
      ["agentCategory", "cliPath", "entity", "excludeProjects", "syncAiActivity", "trackAgentActivity", "trackUserActivity", "userCategory"],
    );
    expect(d.cliPath).toMatchObject({ default: "~/.wakatime/wakatime-cli" });
    expect(d.entity).toMatchObject({ default: "title", options: ["title", "threadId"] });
    expect(d.agentCategory).toMatchObject({ default: "ai coding" });
  });

  it("serves a heartbeat RPC that spawns the cli with the plugin string", async () => {
    await start();
    expect(await host.harness.callRpc("heartbeat", { threadId: "thr_1" })).toEqual({ sent: true });
    await flush();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]!.file).toBe(cli);
    expect(execCalls[0]!.args).toContain("--entity=Fix login");
    expect(execCalls[0]!.args).toContain("--project=acme");
    expect(execCalls[0]!.args).toContain(`--plugin=bb/unknown bb-wakatime/${pkg.version}`);
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

  it("times an active thread from thread.active to thread.idle and syncs once", async () => {
    await start();
    thread = { ...thread, status: "active" };
    await host.harness.emitThreadEvent("thread.active", { thread });
    await flush();
    thread = { ...thread, status: "idle" };
    await host.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await flush();
    const heartbeats = execCalls.filter((call) => !call.args.includes("--sync-ai-activity"));
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(execCalls.filter((call) => call.args.includes("--sync-ai-activity"))).toHaveLength(1);
    for (const call of heartbeats) expect(call.args).toContain("--category=ai coding");
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

  it("starts a timer from an experimental_thread.events payload and ends it on thread.failed", async () => {
    thread = { ...thread, status: "active" };
    await start();
    expect(execCalls).toHaveLength(1);
    await host.harness.emitThreadEvent("thread.failed", { thread: { ...thread, status: "error" }, error: null });
    await flush();
    expect(execCalls.filter((call) => !call.args.includes("--sync-ai-activity"))).toHaveLength(2);
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
});
