import type {
  BbPluginApi,
  MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { MAX_REASON_LENGTH } from "./server.js";

type RunningThread = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>
>[number];
type ThreadRecord = Parameters<typeof makeThreadResponse>[0];
type QueueEntry = ReturnType<typeof makeQueueEntry>;

const PLUGIN_ID = "project-queue";
const QUEUED_KEY = "queued-thread-ids";
const KEEPER_INTERVAL_MS = 30_000;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function running(id: string): RunningThread {
  return { id, hostId: null };
}

interface DispatchOverrides {
  threadId?: string;
  status?: MessageDispatchHookContext["thread"]["status"];
  parentThreadId?: string | null;
  projectId?: string;
  projectName?: string;
  projectKind?: MessageDispatchHookContext["project"]["kind"];
  submission?: MessageDispatchHookContext["experimental_submission"];
}

type SubmissionData = NonNullable<
  MessageDispatchHookContext["experimental_submission"]
>["data"];

function queueIntent(
  data: SubmissionData = { queue: true },
  pluginId = PLUGIN_ID,
): MessageDispatchHookContext["experimental_submission"] {
  return { pluginId, data };
}

function dispatchContext(overrides: DispatchOverrides = {}) {
  return makeMessageDispatchHookContext({
    thread: {
      id: overrides.threadId ?? "thr_new",
      status: overrides.status ?? "pending",
      parentThreadId: overrides.parentThreadId ?? null,
    },
    project: {
      id: overrides.projectId ?? "proj_1",
      name: overrides.projectName ?? "Alpha",
      kind: overrides.projectKind ?? "standard",
    },
    experimental_submission: overrides.submission ?? null,
  });
}

interface SetupOptions {
  stored?: unknown;
  running?: RunningThread[];
  threads?: Record<string, ThreadRecord | Error>;
  queuedMessages?: Record<string, QueueEntry[]>;
  spawnStatus?: MessageDispatchHookContext["thread"]["status"];
}

async function setup(options: SetupOptions = {}) {
  const state = {
    running: options.running ?? [],
    threads: options.threads ?? {},
    queuedMessages: options.queuedMessages ?? {},
    spawnStatus: options.spawnStatus ?? "pending",
  };
  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      threads: {
        listRunning: async () => state.running,
        get: async ({ threadId }: { threadId: string }) => {
          const record = state.threads[threadId];
          if (record === undefined) throw new HttpError(404);
          if (record instanceof Error) throw record;
          return makeThreadResponse({ id: threadId, ...record });
        },
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) =>
            state.queuedMessages[threadId] ?? [],
        },
        spawn: async (args: { projectId: string }) =>
          makeThreadResponse({
            id: "thr_spawned",
            projectId: args.projectId,
            status: state.spawnStatus,
          }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: `Project ${projectId}`,
        }),
      },
    },
  });
  if (options.stored !== undefined) {
    await fake.bb.storage.kv.set(QUEUED_KEY, options.stored);
  }
  await plugin(fake.bb);
  const hook = fake.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch was not registered");
  return { ...fake, hook, state };
}

async function storedIds(
  fake: Awaited<ReturnType<typeof setup>>,
): Promise<unknown> {
  return fake.bb.storage.kv.get<unknown>(QUEUED_KEY);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hold decisions", () => {
  it("lets a thread without the queue intent proceed", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
  });

  it("holds a queued thread while another thread in its project runs", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1", visibility: "hidden" } },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: "1 other thread running in Alpha",
    });
  });

  it("pluralizes the blocker count", async () => {
    const { hook } = await setup({
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { projectId: "proj_1" },
        thr_b: { projectId: "proj_1" },
      },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: "2 other threads running in Alpha",
    });
  });

  it("proceeds when the running thread belongs to another project", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_2" } },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("never lets an ancestor block its queued child", async () => {
    const { hook } = await setup({
      running: [running("thr_parent"), running("thr_grandparent")],
      threads: {
        thr_parent: { projectId: "proj_1", parentThreadId: "thr_grandparent" },
        thr_grandparent: { projectId: "proj_1", parentThreadId: null },
      },
    });

    await expect(
      hook(
        dispatchContext({
          parentThreadId: "thr_parent",
          submission: queueIntent(),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("proceeds for the personal project without queuing", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_personal" } },
    });

    await expect(
      fake.hook(
        dispatchContext({
          projectId: "proj_personal",
          projectKind: "personal",
          submission: queueIntent(),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedIds(fake)).toBeUndefined();
  });

  it("keeps a reason within the limit for a very long project name", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    const decision = await hook(
      dispatchContext({
        projectName: "x".repeat(500),
        submission: queueIntent(),
      }),
    );

    if (decision.action !== "wait") throw new Error("expected a wait");
    expect(decision.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    expect(decision.reason.endsWith("…")).toBe(true);
  });

  it("truncates without splitting a surrogate pair", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });
    const prefix = "1 other thread running in ";
    const projectName =
      "x".repeat(MAX_REASON_LENGTH - prefix.length - 2) +
      "🚀" +
      "y".repeat(10);

    const decision = await hook(
      dispatchContext({
        projectName,
        submission: queueIntent(),
      }),
    );

    if (decision.action !== "wait") throw new Error("expected a wait");
    expect(decision.reason).toBe(prefix + "x".repeat(MAX_REASON_LENGTH - prefix.length - 2) + "…");
    expect(decision.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });

  it("loads persisted ids before the hook is registered", async () => {
    const { hook } = await setup({
      stored: ["thr_new"],
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(hook(dispatchContext())).resolves.toMatchObject({
      action: "wait",
    });
  });

  it("ignores a malformed persisted value", async () => {
    const { hook } = await setup({
      stored: { not: "a list" },
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
  });
});

describe("queue intent", () => {
  it.each([
    ["null", null],
    ["an array", [{ queue: true }]],
    ["a string flag", { queue: "true" }],
    ["a missing flag", { other: true }],
    ["a false flag", { queue: false }],
  ])("does not queue for %s data", async (_label, data) => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent(data) })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedIds(fake)).toBeUndefined();
  });

  it("ignores a submission addressed to another plugin", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(
      hook(
        dispatchContext({
          submission: queueIntent({ queue: true }, "scheduled-send"),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("persists the queued id", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await fake.hook(dispatchContext({ submission: queueIntent() }));

    expect(await storedIds(fake)).toEqual(["thr_new"]);
  });
});

describe("removal", () => {
  it("keeps the id after a proceed because another wait may still hold the row", async () => {
    const fake = await setup({
      threads: { thr_busy: { projectId: "proj_1" } },
    });
    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });

    fake.state.running = [running("thr_busy")];

    await expect(fake.hook(dispatchContext())).resolves.toMatchObject({
      action: "wait",
    });
    expect(await storedIds(fake)).toEqual(["thr_new"]);
  });

  it("drops the id when the thread becomes active", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });
    await fake.hook(dispatchContext({ submission: queueIntent() }));

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_new", status: "active" }),
    });

    expect(await storedIds(fake)).toEqual([]);
    await expect(fake.hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
  });

  it.each(["thread.archived", "thread.deleted"] as const)(
    "drops the id on %s and rechecks held dispatches",
    async (event) => {
      const fake = await setup({
        running: [running("thr_busy")],
        threads: { thr_busy: { projectId: "proj_1" } },
      });
      await fake.hook(dispatchContext({ submission: queueIntent() }));
      const rechecksBefore = fake.harness.recheckCount;

      await fake.harness.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "thr_new" }),
      });

      expect(await storedIds(fake)).toEqual([]);
      expect(fake.harness.recheckCount).toBe(rechecksBefore + 1);
    },
  );

  it.each(["thread.idle", "thread.failed"] as const)(
    "rechecks held dispatches on %s",
    async (event) => {
      const fake = await setup();

      if (event === "thread.idle") {
        await fake.harness.emitThreadEvent(event, {
          thread: makeThreadResponse(),
          lastAssistantText: null,
        });
      } else {
        await fake.harness.emitThreadEvent(event, {
          thread: makeThreadResponse(),
          error: null,
        });
      }

      expect(fake.harness.recheckCount).toBe(1);
    },
  );

  it("purges a queued id whose thread is no longer pending and proceeds", async () => {
    const fake = await setup({
      stored: ["thr_new"],
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });

    await expect(
      fake.hook(dispatchContext({ status: "idle" })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedIds(fake)).toEqual([]);
  });

  it("keeps the id on a cancelled message while rows remain", async () => {
    const fake = await setup({
      stored: ["thr_new"],
      threads: { thr_new: { status: "pending" } },
      queuedMessages: { thr_new: [makeQueueEntry({ threadId: "thr_new" })] },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedIds(fake)).toEqual(["thr_new"]);
  });

  it("drops the id on a cancelled message once no rows remain", async () => {
    const fake = await setup({
      stored: ["thr_new"],
      threads: { thr_new: { status: "pending" } },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedIds(fake)).toEqual([]);
  });

  it("drops the id on a cancelled message when the thread is no longer pending", async () => {
    const fake = await setup({
      stored: ["thr_new"],
      threads: { thr_new: { status: "active" } },
      queuedMessages: { thr_new: [makeQueueEntry({ threadId: "thr_new" })] },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedIds(fake)).toEqual([]);
  });

  it("keeps the id on a cancelled message when the lookup fails", async () => {
    const fake = await setup({
      stored: ["thr_new"],
      threads: { thr_new: new Error("daemon unreachable") },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedIds(fake)).toEqual(["thr_new"]);
  });
});

describe("failures never throw", () => {
  it("proceeds when a project lookup throws", async () => {
    const { hook, harness } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: new Error("lookup failed") },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries.some((entry) => entry.level === "warn")).toBe(
      true,
    );
  });

  it("treats an ancestor it cannot read as an ancestor", async () => {
    const { hook } = await setup({
      running: [running("thr_parent")],
      threads: { thr_parent: new Error("lookup failed") },
    });

    await expect(
      hook(
        dispatchContext({
          parentThreadId: "thr_parent",
          submission: queueIntent(),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("proceeds when listing running threads throws", async () => {
    const fake = await setup();
    fake.harness.sdk.stub("threads.listRunning", async () => {
      throw new Error("server busy");
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });
});

describe("queue-keeper", () => {
  it("purges missing and non-pending threads and keeps ids it cannot check", async () => {
    const fake = await setup({
      stored: ["thr_gone", "thr_active", "thr_pending", "thr_flaky"],
      threads: {
        thr_active: { status: "active" },
        thr_pending: { status: "pending" },
        thr_flaky: new Error("daemon unreachable"),
      },
    });

    const service = fake.harness.runService("queue-keeper");
    await vi.waitFor(() => expect(fake.harness.recheckCount).toBe(1));
    service.controller.abort();
    await service.done;

    expect(await storedIds(fake)).toEqual(["thr_pending", "thr_flaky"]);
  });

  it("rechecks every 30 seconds while ids are queued and stops once none are", async () => {
    vi.useFakeTimers();
    const fake = await setup({
      stored: ["thr_new"],
      threads: { thr_new: { status: "pending" } },
    });

    const service = fake.harness.runService("queue-keeper");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.harness.recheckCount).toBe(1);

    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
    expect(fake.harness.recheckCount).toBe(2);
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS);
    expect(fake.harness.recheckCount).toBe(3);

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_new", status: "active" }),
    });
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL_MS * 3);
    expect(fake.harness.recheckCount).toBe(3);

    service.controller.abort();
    await service.done;
  });
});

describe("cli", () => {
  it("rejects releasing an id that is not queued", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["release", "thr_unknown", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not_queued");
    expect(harness.recheckCount).toBe(0);
  });

  it("releases a queued id and rechecks", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { projectId: "proj_1" } },
    });
    await fake.hook(dispatchContext({ submission: queueIntent() }));

    const result = await fake.harness.runCli(["release", "thr_new"]);

    expect(result.exitCode).toBe(0);
    expect(await storedIds(fake)).toEqual([]);
    expect(fake.harness.recheckCount).toBe(1);
  });

  it("refuses to spawn without a project", async () => {
    const { harness } = await setup();

    const result = await harness.runCli([
      "spawn",
      "--prompt",
      "do the thing",
      "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("missing_project");
    expect(result.stdout).toContain("pass --project <id>");
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("spawns into the calling project with the queue intent", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(
      ["spawn", "--prompt", "do the thing", "--title", "Report"],
      { projectId: "proj_ctx", threadId: "thr_caller" },
    );

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          projectId: "proj_ctx",
          prompt: "do the thing",
          title: "Report",
          environment: { type: "project-default" },
          pluginSubmission: { pluginId: PLUGIN_ID, data: { queue: true } },
        }),
      ],
    ]);
    const [[args]] = harness.sdk.callsTo("threads.spawn");
    expect(args).not.toHaveProperty("parentThreadId");
  });

  it("reports a spawned thread as queued only while it is still pending", async () => {
    const held = await setup({ stored: ["thr_spawned"] });
    const heldResult = await held.harness.runCli(
      ["spawn", "--prompt", "go", "--json"],
      { projectId: "proj_ctx" },
    );
    expect(JSON.parse(heldResult.stdout)).toMatchObject({ queued: true });

    const started = await setup({
      stored: ["thr_spawned"],
      spawnStatus: "starting",
    });
    const startedResult = await started.harness.runCli(
      ["spawn", "--prompt", "go"],
      { projectId: "proj_ctx" },
    );
    expect(startedResult.stdout).toBe("Thread thr_spawned spawned (starting).");
  });

  it("reports a pending thread the hook did not queue as spawned", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["spawn", "--prompt", "go"], {
      projectId: "proj_ctx",
    });

    expect(result.stdout).toBe("Thread thr_spawned spawned (pending).");
  });

  it("requires a prompt", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["spawn", "--json"], {
      projectId: "proj_ctx",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("missing_required");
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("links the parent only when asked", async () => {
    const { harness } = await setup();

    await harness.runCli(["spawn", "--prompt", "go", "--parent-self"], {
      projectId: "proj_ctx",
      threadId: "thr_caller",
    });
    await harness.runCli(
      ["spawn", "--prompt", "go", "--parent-thread", "thr_other"],
      { projectId: "proj_ctx" },
    );

    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [expect.objectContaining({ parentThreadId: "thr_caller" })],
      [expect.objectContaining({ parentThreadId: "thr_other" })],
    ]);
  });

  it("rejects --parent-self without a calling thread", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(
      ["spawn", "--prompt", "go", "--parent-self", "--json"],
      { projectId: "proj_ctx" },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("missing_thread");
  });

  it("lists each queued thread with its blockers and purges stale ids", async () => {
    const fake = await setup({
      stored: ["thr_waiting", "thr_gone", "thr_started"],
      running: [running("thr_busy")],
      threads: {
        thr_waiting: { projectId: "proj_1", status: "pending", title: "Plan" },
        thr_started: { projectId: "proj_1", status: "active" },
        thr_busy: { projectId: "proj_1" },
      },
    });

    const result = await fake.harness.runCli(["list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      queued: [
        {
          id: "thr_waiting",
          state: "queued",
          title: "Plan",
          projectId: "proj_1",
          project: "Project proj_1",
          blockers: ["thr_busy"],
        },
        { id: "thr_gone", state: "stale", reason: "thread not found" },
        { id: "thr_started", state: "stale", reason: "thread is active" },
      ],
    });
    expect(await storedIds(fake)).toEqual(["thr_waiting"]);
  });

  it("strips control and bidi characters from the text list", async () => {
    const { harness } = await setup({
      stored: ["thr_waiting"],
      threads: {
        thr_waiting: {
          projectId: "proj_1",
          status: "pending",
          title: "Plan\u001b[31m\nnext\u202e",
        },
      },
    });

    const result = await harness.runCli(["list"]);

    expect(result.stdout).toBe(
      "thr_waiting  Plan [31m next   Project proj_1  no blockers, starts on the next recheck",
    );
  });

  it("filters the list by project", async () => {
    const { harness } = await setup({
      stored: ["thr_a", "thr_b"],
      threads: {
        thr_a: { projectId: "proj_1", status: "pending" },
        thr_b: { projectId: "proj_2", status: "pending" },
      },
    });

    const result = await harness.runCli([
      "list",
      "--project",
      "proj_2",
      "--json",
    ]);

    expect(JSON.parse(result.stdout).queued).toMatchObject([
      { id: "thr_b", projectId: "proj_2" },
    ]);
  });

  it("does not report another project's stale threads", async () => {
    const fake = await setup({
      stored: ["thr_stale", "thr_b", "thr_gone"],
      threads: {
        thr_stale: { projectId: "proj_1", status: "active" },
        thr_b: { projectId: "proj_2", status: "pending" },
        thr_gone: { projectId: "proj_2", status: "active" },
      },
    });

    const result = await fake.harness.runCli([
      "list",
      "--project",
      "proj_2",
      "--json",
    ]);

    expect(JSON.parse(result.stdout).queued).toMatchObject([
      { id: "thr_b", projectId: "proj_2" },
      { id: "thr_gone", state: "stale", reason: "thread is active" },
    ]);
    expect(await storedIds(fake)).toEqual(["thr_stale", "thr_b"]);
  });
});
