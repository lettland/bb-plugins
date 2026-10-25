import type {
  BbPluginApi,
  MessageDispatchHookContext,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { MAX_REASON_LENGTH, rpcContract } from "./server.js";
import {
  DEFAULT_LIMIT,
  INTERACTION_TTL_MS,
  KEEPER_INTERVAL_MS,
  LIMITS_KEY,
  QUEUE_KEY,
  type ProviderSummary,
} from "./src/shared.js";

type RunningThread = Awaited<
  ReturnType<BbPluginApi["sdk"]["threads"]["listRunning"]>
>[number];
type ThreadRecord = Parameters<typeof makeThreadResponse>[0];
type QueueEntry = ReturnType<typeof makeQueueEntry>;
type InteractionPending =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];
type Snapshot = {
  providers: ProviderSummary[];
};

const PLUGIN_ID = "provider-queue";
const PROVIDER = "test-provider";
const KEEPER_INTERVAL = KEEPER_INTERVAL_MS;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function running(id: string): RunningThread {
  return { id, hostId: null };
}

function provider(id: string, displayName: string): {
  id: string;
  displayName: string;
} {
  return { id, displayName };
}

function interaction(): InteractionPending {
  return { id: "int_1" } as unknown as InteractionPending;
}

interface DispatchOverrides {
  threadId?: string;
  status?: MessageDispatchHookContext["thread"]["status"];
  parentThreadId?: string | null;
  providerId?: string;
  attempt?: MessageDispatchHookContext["attempt"];
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
    ...(overrides.providerId === undefined
      ? {}
      : { requestedExecution: { providerId: overrides.providerId } }),
    ...(overrides.attempt === undefined ? {} : { attempt: overrides.attempt }),
    experimental_submission: overrides.submission ?? null,
  });
}

interface SetupOptions {
  storedEntries?: unknown;
  storedLimits?: unknown;
  running?: RunningThread[];
  threads?: Record<string, ThreadRecord | Error>;
  interactions?: Record<string, unknown[] | Error>;
  providers?: { id: string; displayName: string }[];
  queuedMessages?: Record<string, QueueEntry[]>;
  spawnStatus?: MessageDispatchHookContext["thread"]["status"];
}

async function setup(options: SetupOptions = {}) {
  const state = {
    running: options.running ?? [],
    threads: options.threads ?? {},
    interactions: options.interactions ?? {},
    providers: options.providers ?? [],
    queuedMessages: options.queuedMessages ?? {},
    spawnStatus: options.spawnStatus ?? ("pending" as const),
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
        interactions: {
          list: async ({ threadId }: { threadId: string }) => {
            const pending = state.interactions[threadId];
            if (pending instanceof Error) throw pending;
            return pending ?? [];
          },
        },
        spawn: async (args: { projectId: string }) =>
          makeThreadResponse({
            id: "thr_spawned",
            projectId: args.projectId,
            status: state.spawnStatus,
          }),
      },
      providers: {
        list: async () => state.providers,
      },
    },
  });
  if (options.storedEntries !== undefined) {
    await fake.bb.storage.kv.set(QUEUE_KEY, options.storedEntries);
  }
  if (options.storedLimits !== undefined) {
    await fake.bb.storage.kv.set(LIMITS_KEY, options.storedLimits);
  }
  await plugin(fake.bb);
  const hook = fake.harness.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch was not registered");
  return { ...fake, hook, state };
}

async function storedEntries(
  fake: Awaited<ReturnType<typeof setup>>,
): Promise<unknown> {
  return fake.bb.storage.kv.get<unknown>(QUEUE_KEY);
}

async function storedLimits(
  fake: Awaited<ReturnType<typeof setup>>,
): Promise<unknown> {
  return fake.bb.storage.kv.get<unknown>(LIMITS_KEY);
}

async function snapshotOf(
  fake: Awaited<ReturnType<typeof setup>>,
): Promise<Snapshot> {
  return (await fake.harness.callRpc("snapshot", null)) as Snapshot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hold decisions", () => {
  it("proceeds on a join-turn without queuing", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      fake.hook(
        dispatchContext({
          attempt: "join-turn",
          submission: queueIntent(),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedEntries(fake)).toBeUndefined();
  });

  it("lets a thread without the queue intent proceed", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
  });

  it("holds a queued thread while its provider is at its limit", async () => {
    const { hook } = await setup({
      storedLimits: { [PROVIDER]: 1 },
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: `1 thread running on ${PROVIDER}, limit 1`,
    });
  });

  it("pluralizes the running count", async () => {
    const { hook } = await setup({
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit ${DEFAULT_LIMIT}`,
    });
  });

  it("proceeds while a slot is free", async () => {
    const { hook } = await setup({
      storedLimits: { [PROVIDER]: 3 },
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("proceeds when the running thread belongs to another provider", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: "other" } },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("never lets an ancestor block its queued child", async () => {
    const { hook } = await setup({
      running: [running("thr_parent"), running("thr_grandparent")],
      threads: {
        thr_parent: { providerId: PROVIDER, parentThreadId: "thr_grandparent" },
        thr_grandparent: { providerId: PROVIDER, parentThreadId: null },
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

  it("frees the slot of a running thread that awaits the user", async () => {
    const { hook } = await setup({
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
      interactions: { thr_b: [interaction()] },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("waits at the limit with the exact reason", async () => {
    const { hook } = await setup({
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit ${DEFAULT_LIMIT}`,
    });
  });

  it("waits with the paused reason when the limit is 0", async () => {
    const { hook } = await setup({
      storedLimits: { [PROVIDER]: 0 },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: `${PROVIDER} is paused (limit 0)`,
    });
  });

  it("holds a later row even while a slot is free", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_first", providerId: PROVIDER },
        { threadId: "thr_second", providerId: PROVIDER },
      ],
      storedLimits: { [PROVIDER]: 3 },
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    await expect(
      fake.hook(dispatchContext({ threadId: "thr_second" })),
    ).resolves.toEqual({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit 3`,
    });
    await expect(
      fake.hook(dispatchContext({ threadId: "thr_first" })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("lets a moved-up row win the next free slot", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_first", providerId: PROVIDER },
        { threadId: "thr_second", providerId: PROVIDER },
      ],
      storedLimits: { [PROVIDER]: 3 },
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });
    await expect(
      fake.hook(dispatchContext({ threadId: "thr_second" })),
    ).resolves.toMatchObject({ action: "wait" });

    await fake.harness.callRpc("move", {
      threadId: "thr_second",
      direction: "up",
    });

    await expect(
      fake.hook(dispatchContext({ threadId: "thr_second" })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("refreshes the entry's provider from the dispatch", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: "old" }],
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
  });

  it("skips the provider refresh when it already matches", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
  });

  it("excludes a running thread whose cached provider differs without reading it", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
    });
    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_busy",
        providerId: "other",
        status: "active",
      }),
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(fake.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("remembers a thread's provider from thread.created", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
    });

    await fake.harness.emitThreadEvent("thread.created", {
      thread: makeThreadResponse({
        id: "thr_busy",
        providerId: "other",
        status: "pending",
      }),
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(fake.harness.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it("moves a running thread between providers when its payload switches", async () => {
    // Regression: the provider cache must follow the newest payload's providerId, since a thread can switch providers between turns (PLUGIN_OVERVIEW "Provider switches"; payload shape: PluginThreadEventPayloads in @get-bb/plugin-sdk's bundled-types/bb-plugin-sdk.d.ts).
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_new", providerId: "p1" },
        { threadId: "thr_p2", providerId: "p2" },
      ],
      storedLimits: { p1: 1, p2: 1 },
      running: [running("thr_mover")],
      threads: { thr_mover: { providerId: "p1" } },
    });
    await expect(
      fake.hook(dispatchContext({ threadId: "thr_new", providerId: "p1" })),
    ).resolves.toEqual({
      action: "wait",
      reason: "1 thread running on p1, limit 1",
    });

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_mover",
        providerId: "p2",
        status: "active",
      }),
    });
    fake.state.threads.thr_mover = { providerId: "p2" };

    await expect(
      fake.hook(dispatchContext({ threadId: "thr_new", providerId: "p1" })),
    ).resolves.toEqual({ action: "proceed" });
    await expect(
      fake.hook(dispatchContext({ threadId: "thr_p2", providerId: "p2" })),
    ).resolves.toEqual({
      action: "wait",
      reason: "1 thread running on p2, limit 1",
    });
  });

  it("keeps a reason within the limit for a very long provider label", async () => {
    const { hook } = await setup({
      storedLimits: { [PROVIDER]: 1 },
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      providers: [provider(PROVIDER, "x".repeat(500))],
    });

    const decision = await hook(
      dispatchContext({ submission: queueIntent() }),
    );

    if (decision.action !== "wait") throw new Error("expected a wait");
    expect(decision.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
    expect(decision.reason.endsWith("…")).toBe(true);
  });

  it("truncates without splitting a surrogate pair", async () => {
    const { hook } = await setup({
      storedLimits: { [PROVIDER]: 1 },
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      providers: [provider(PROVIDER, "x".repeat(178) + "🚀" + "y".repeat(10))],
    });
    const prefix = "1 thread running on ";

    const decision = await hook(
      dispatchContext({ submission: queueIntent() }),
    );

    if (decision.action !== "wait") throw new Error("expected a wait");
    expect(decision.reason).toBe(
      `${prefix}${"x".repeat(178)}…`,
    );
    expect(decision.reason.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });

  it("evicts the provider cache when it reaches its cap", async () => {
    const runningIds = Array.from(
      { length: 5_001 },
      (_, index) => `thr_run_${index}`,
    );
    const threads: Record<string, ThreadRecord | Error> = {};
    for (const id of runningIds) threads[id] = { providerId: PROVIDER };
    const { hook } = await setup({
      running: runningIds.map(running),
      threads,
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({ action: "wait" });
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
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent(data) })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedEntries(fake)).toBeUndefined();
  });

  it("ignores a submission addressed to another plugin", async () => {
    const { hook } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      hook(
        dispatchContext({
          submission: queueIntent({ queue: true }, "scheduled-send"),
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("persists the queued entry with its provider", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await fake.hook(dispatchContext({ submission: queueIntent() }));

    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
    expect(fake.harness.realtimeSignals).toContainEqual({
      channel: "provider-queue",
      payload: { kind: "state" },
    });
  });

  it("does not duplicate an entry that is already queued", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      storedLimits: { [PROVIDER]: 1 },
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({ action: "wait" });
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
  });

  it("falls back to the provider id when the label lookup fails and retries later", async () => {
    const fake = await setup({
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });
    fake.harness.sdk.stub("providers.list", async () => {
      throw new Error("providers offline");
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit ${DEFAULT_LIMIT}`,
    });
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not read the providers: providers offline",
    });

    fake.state.providers = [provider(PROVIDER, "Codex")];
    fake.harness.sdk.stub(
      "providers.list",
      async () => fake.state.providers,
    );
    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({
      action: "wait",
      reason: `2 threads running on Codex, limit ${DEFAULT_LIMIT}`,
    });
    expect(fake.harness.sdk.callsTo("providers.list")).toHaveLength(2);
  });
});

describe("removal", () => {
  it("releases a queued row whose thread is no longer pending", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });

    await expect(
      fake.hook(dispatchContext({ status: "idle" })),
    ).resolves.toEqual({ action: "proceed" });
    expect(await storedEntries(fake)).toEqual([]);
  });

  it("drops the entry when the thread becomes active and remembers its provider", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });
    await fake.hook(dispatchContext({ submission: queueIntent() }));

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_new",
        providerId: PROVIDER,
        status: "active",
      }),
    });

    expect(await storedEntries(fake)).toEqual([]);
    await expect(fake.hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
  });

  it("ignores an active event for a thread it never queued", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_kept", providerId: PROVIDER }],
      threads: { thr_kept: { status: "pending" } },
    });

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_unknown", status: "active" }),
    });

    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_kept", providerId: PROVIDER },
    ]);
  });

  it.each(["thread.archived", "thread.deleted"] as const)(
    "drops the entry on %s and rechecks held dispatches",
    async (event) => {
      const fake = await setup({
        storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
        running: [running("thr_busy")],
        threads: { thr_busy: { providerId: PROVIDER } },
      });
      const rechecksBefore = fake.harness.recheckCount;

      await fake.harness.emitThreadEvent(event, {
        thread: makeThreadResponse({ id: "thr_new" }),
      });

      expect(await storedEntries(fake)).toEqual([]);
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

  it("keeps the entry on a cancelled message while rows remain", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
      queuedMessages: { thr_new: [makeQueueEntry({ threadId: "thr_new" })] },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
  });

  it("drops the entry on a cancelled message once no rows remain", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedEntries(fake)).toEqual([]);
  });

  it("drops the entry on a cancelled message when the thread is no longer pending", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "active" } },
      queuedMessages: { thr_new: [makeQueueEntry({ threadId: "thr_new" })] },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedEntries(fake)).toEqual([]);
  });

  it("keeps the entry on a cancelled message when the lookup fails", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: new Error("daemon unreachable") },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_new", providerId: PROVIDER },
    ]);
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message:
        "Could not check thr_new after a cancelled message: daemon unreachable",
    });
  });

  it("ignores a cancelled message for a thread it never queued", async () => {
    const fake = await setup();

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_other" }),
    });

    expect(fake.harness.sdk.callsTo("threads.get")).toHaveLength(0);
    expect(await storedEntries(fake)).toBeUndefined();
  });

  it("drops the entry on a cancelled message when the thread is gone", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: new HttpError(404) },
    });

    await fake.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_new" }),
    });

    expect(await storedEntries(fake)).toEqual([]);
  });
});

describe("failures never throw", () => {
  it("proceeds when listing running threads throws", async () => {
    const fake = await setup();
    fake.harness.sdk.stub("threads.listRunning", async () => {
      throw new Error("server busy");
    });

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(fake.harness.logEntries).toContainEqual({
      level: "error",
      message:
        "Could not decide thr_new, letting it proceed: server busy",
    });
  });

  it("treats a running thread it cannot read as not on the provider", async () => {
    const { hook, harness } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: new Error("lookup failed") },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not read the provider of thr_busy: lookup failed",
    });
  });

  it("frees the slot when the interaction lookup fails", async () => {
    const { hook, harness } = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      interactions: { thr_busy: new Error("interactions offline") },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message:
        "Could not read the pending interactions of thr_busy: interactions offline",
    });
  });

  it("logs and continues when a recheck fails", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
    });
    vi.spyOn(fake.bb.experimental_hooks, "recheck").mockRejectedValue(
      new Error("recheck failed"),
    );

    await fake.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse(),
      lastAssistantText: null,
    });

    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not recheck held dispatches: recheck failed",
    });
  });

  it("keeps state in memory when saving fails and saves it with the next write", async () => {
    const fake = await setup({
      storedLimits: { [PROVIDER]: 1 },
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
    });
    vi.spyOn(fake.bb.storage.kv, "set").mockRejectedValueOnce(
      new Error("disk full"),
    );

    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({ action: "wait" });
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not save the queue state: disk full",
    });

    const result = await fake.harness.runCli(["release", "thr_new"]);

    expect(result.exitCode).toBe(0);
    expect(await storedEntries(fake)).toEqual([]);
  });
});

describe("state reload", () => {
  it("keeps queue order and limits across a reload and holds rows under a 0 limit", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_a", providerId: PROVIDER },
        { threadId: "thr_b", providerId: PROVIDER },
      ],
      storedLimits: { [PROVIDER]: 0 },
    });

    const reloaded = await fake.harness.lifecycle.reload((bb) => plugin(bb));

    const snap = (await reloaded.harness.callRpc(
      "snapshot",
      null,
    )) as Snapshot;
    expect(snap.providers).toEqual([
      {
        providerId: PROVIDER,
        label: PROVIDER,
        limit: 0,
        running: [],
        awaiting: [],
        queue: [
          {
            threadId: "thr_a",
            title: "(untitled)",
            providerId: PROVIDER,
          },
          {
            threadId: "thr_b",
            title: "(untitled)",
            providerId: PROVIDER,
          },
        ],
      },
    ]);

    const hook = reloaded.harness.registrations.hooks["message.dispatch"];
    if (hook === null) throw new Error("message.dispatch was not registered");
    await expect(hook(dispatchContext({ threadId: "thr_a" }))).resolves.toEqual(
      {
        action: "wait",
        reason: `${PROVIDER} is paused (limit 0)`,
      },
    );
  });
});

describe("limit handling", () => {
  it("warns and starts empty when the stored queue is malformed", async () => {
    const fake = await setup({
      storedEntries: { not: "a list" },
    });

    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Stored queue-entries is malformed; starting empty",
    });
    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toEqual({ action: "proceed" });
  });

  it("warns and starts empty when the stored limits are malformed", async () => {
    const fake = await setup({
      storedLimits: { p1: -1 },
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Stored provider-limits is malformed; starting empty",
    });
    await expect(
      fake.hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit ${DEFAULT_LIMIT}`,
    });
  });

  it("does not warn when storage is absent", async () => {
    const fake = await setup();

    expect(
      fake.harness.logEntries.some((entry) =>
        entry.message.includes("is malformed"),
      ),
    ).toBe(false);
  });

  it("uses the default for an unlisted provider", async () => {
    const { hook } = await setup({
      storedLimits: { other: 9 },
      running: [running("thr_a"), running("thr_b")],
      threads: {
        thr_a: { providerId: PROVIDER },
        thr_b: { providerId: PROVIDER },
      },
    });

    await expect(
      hook(dispatchContext({ submission: queueIntent() })),
    ).resolves.toMatchObject({
      action: "wait",
      reason: `2 threads running on ${PROVIDER}, limit ${DEFAULT_LIMIT}`,
    });
  });

  it("persists a limit set over rpc and rechecks", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
      providers: [provider(PROVIDER, "Codex")],
    });
    const rechecksBefore = fake.harness.recheckCount;
    const signalsBefore = fake.harness.realtimeSignals.length;

    await expect(
      fake.harness.callRpc("setLimit", { providerId: PROVIDER, limit: 0 }),
    ).resolves.toEqual({ ok: true });

    expect(await storedLimits(fake)).toEqual({ [PROVIDER]: 0 });
    expect(fake.harness.recheckCount).toBe(rechecksBefore + 1);
    expect(fake.harness.realtimeSignals).toHaveLength(signalsBefore + 1);
  });

  it("rejects a limit for a provider the directory does not know", async () => {
    const fake = await setup({
      storedLimits: { p1: 3 },
      providers: [provider("p1", "Codex")],
    });

    await expect(
      fake.harness.callRpc("setLimit", { providerId: "ghost", limit: 5 }),
    ).rejects.toThrow("Unknown provider ghost");
    expect(await storedLimits(fake)).toEqual({ p1: 3 });
    expect(fake.harness.realtimeSignals).toHaveLength(0);
  });

  it("still sets a limit when the provider directory is unavailable", async () => {
    const fake = await setup();
    fake.harness.sdk.stub("providers.list", async () => {
      throw new Error("directory offline");
    });

    await expect(
      fake.harness.callRpc("setLimit", { providerId: "ghost", limit: 3 }),
    ).resolves.toEqual({ ok: true });
    expect(await storedLimits(fake)).toEqual({ ghost: 3 });
  });

  it("rejects an invalid rpc input", async () => {
    const { harness } = await setup();

    await expect(
      harness.callRpc("move", { threadId: "thr_new", direction: "sideways" }),
    ).rejects.toThrow();
    await expect(harness.callRpc("setLimit", { providerId: "p1", limit: -1 }))
      .rejects.toThrow();
  });
});

describe("queue-keeper", () => {
  it("purges missing and non-pending threads and keeps entries it cannot check", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_gone", providerId: PROVIDER },
        { threadId: "thr_active", providerId: PROVIDER },
        { threadId: "thr_pending", providerId: PROVIDER },
        { threadId: "thr_flaky", providerId: PROVIDER },
      ],
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

    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_pending", providerId: PROVIDER },
      { threadId: "thr_flaky", providerId: PROVIDER },
    ]);
  });

  it("rechecks every 30 seconds while rows are queued and stops once none are", async () => {
    vi.useFakeTimers();
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
    });

    const service = fake.harness.runService("queue-keeper");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.harness.recheckCount).toBe(1);

    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL);
    expect(fake.harness.recheckCount).toBe(2);
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL);
    expect(fake.harness.recheckCount).toBe(3);

    await fake.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thr_new", status: "active" }),
    });
    await vi.advanceTimersByTimeAsync(KEEPER_INTERVAL * 3);
    expect(fake.harness.recheckCount).toBe(3);

    service.controller.abort();
    await service.done;
  });
});

describe("rpc snapshot", () => {
  it("summarizes every provider with anything configured, queued or running", async () => {
    const fake = await setup({
      storedLimits: { p_lim: 5 },
      storedEntries: [
        { threadId: "thr_q1", providerId: "p1" },
        { threadId: "thr_q2", providerId: "p1" },
        { threadId: "thr_q3", providerId: "p2" },
      ],
      running: [running("thr_run1"), running("thr_run2"), running("thr_gone")],
      threads: {
        thr_run1: {
          providerId: "p1",
          status: "active",
          title: "Running one",
        },
        thr_run2: {
          providerId: "p1",
          status: "active",
          titleFallback: "Fallback two",
        },
        thr_gone: new Error("boom"),
        thr_q1: { providerId: "p1", status: "pending", title: "Queued one" },
      },
      interactions: { thr_run1: [interaction()] },
      providers: [provider("p1", "Codex"), provider("p2", "Droid")],
    });

    const snap = await snapshotOf(fake);

    expect(snap.providers).toEqual([
      {
        providerId: "p_lim",
        label: "p_lim",
        limit: 5,
        running: [],
        awaiting: [],
        queue: [],
      },
      {
        providerId: "p1",
        label: "Codex",
        limit: 2,
        running: [{ threadId: "thr_run2", title: "Fallback two" }],
        awaiting: [{ threadId: "thr_run1", title: "Running one" }],
        queue: [
          { threadId: "thr_q1", title: "Queued one", providerId: "p1" },
          { threadId: "thr_q2", title: "(untitled)", providerId: "p1" },
        ],
      },
      {
        providerId: "p2",
        label: "Droid",
        limit: 2,
        running: [],
        awaiting: [],
        queue: [{ threadId: "thr_q3", title: "(untitled)", providerId: "p2" }],
      },
    ]);
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not read the provider of thr_gone: boom",
    });
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message: "Could not read thr_q2: HTTP 404",
    });
  });

  it("serves repeated snapshots from the display cache within its ttl", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      interactions: { thr_busy: [interaction()] },
    });

    await snapshotOf(fake);
    const lookups = fake.harness.sdk.callsTo(
      "threads.interactions.list",
    ).length;
    await snapshotOf(fake);

    expect(
      fake.harness.sdk.callsTo("threads.interactions.list"),
    ).toHaveLength(lookups);
  });

  it("refreshes a display-cache entry older than its ttl", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      interactions: { thr_busy: [interaction()] },
    });

    await snapshotOf(fake);
    const lookups = fake.harness.sdk.callsTo(
      "threads.interactions.list",
    ).length;
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.now() + INTERACTION_TTL_MS + 1);

    await snapshotOf(fake);
    now.mockRestore();

    expect(
      fake.harness.sdk.callsTo("threads.interactions.list"),
    ).toHaveLength(lookups + 1);
  });

  it("treats an interaction lookup it cannot read as not awaiting", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER } },
      interactions: { thr_busy: new Error("interactions offline") },
    });

    const snap = await snapshotOf(fake);

    expect(snap.providers).toEqual([
      {
        providerId: PROVIDER,
        label: PROVIDER,
        limit: DEFAULT_LIMIT,
        running: [{ threadId: "thr_busy", title: "(untitled)" }],
        awaiting: [],
        queue: [],
      },
    ]);
    expect(fake.harness.logEntries).toContainEqual({
      level: "warn",
      message:
        "Could not read the pending interactions of thr_busy: interactions offline",
    });
  });

  it("clears the display-cache entry when an interaction turns pending", async () => {
    const fake = await setup({
      running: [running("thr_busy")],
      threads: { thr_busy: { providerId: PROVIDER, status: "active" } },
      interactions: { thr_busy: [] },
    });
    await snapshotOf(fake);

    await fake.harness.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({
        id: "thr_busy",
        providerId: PROVIDER,
        status: "active",
      }),
      interaction: interaction(),
    });
    fake.state.interactions.thr_busy = [interaction()];

    const snap = await snapshotOf(fake);

    expect(
      fake.harness.sdk.callsTo("threads.interactions.list"),
    ).toHaveLength(2);
    expect(snap.providers[0]?.awaiting).toEqual([
      { threadId: "thr_busy", title: "(untitled)" },
    ]);
    expect(fake.harness.recheckCount).toBe(1);
  });

  it("clears the display cache when it reaches its cap", async () => {
    const ids = Array.from({ length: 5_001 }, (_, index) => `thr_run_${index}`);
    const threads: Record<string, ThreadRecord | Error> = {};
    for (const id of ids) threads[id] = { providerId: PROVIDER };
    const fake = await setup({
      running: ids.map(running),
      threads,
    });

    await snapshotOf(fake);
    const firstPass = fake.harness.sdk.callsTo(
      "threads.interactions.list",
    ).length;
    await snapshotOf(fake);
    const total = fake.harness.sdk.callsTo(
      "threads.interactions.list",
    ).length;

    expect(firstPass).toBe(5_001);
    // Pass 2 refreshes thr_run_0..4999; thr_run_4999's insert hits the cap
    // (pass 1's leftover entry makes 5000) and clears, so thr_run_5000 is
    // re-queried too: 5001 + 5001.
    expect(total).toBe(10_002);
  });
});

describe("rpc move and release", () => {
  it.each([
    ["up", ["thr_b", "thr_a", "thr_c"]],
    ["top", ["thr_b", "thr_a", "thr_c"]],
  ] as const)(
    "moves a queued row %s within its provider",
    async (direction, expectedOrder) => {
      const entries = [
        { threadId: "thr_a", providerId: PROVIDER },
        { threadId: "thr_b", providerId: PROVIDER },
        { threadId: "thr_c", providerId: "p2" },
      ];
      const fake = await setup({ storedEntries: entries });
      const signalsBefore = fake.harness.realtimeSignals.length;
      const rechecksBefore = fake.harness.recheckCount;

      await expect(
        fake.harness.callRpc("move", { threadId: "thr_b", direction }),
      ).resolves.toEqual({ ok: true });

      expect(await storedEntries(fake)).toEqual(
        expectedOrder.map((threadId) =>
          entries.find((entry) => entry.threadId === threadId),
        ),
      );
      expect(fake.harness.realtimeSignals).toHaveLength(signalsBefore + 1);
      expect(fake.harness.recheckCount).toBe(rechecksBefore + 1);
    },
  );

  it("moves rows within their provider only", async () => {
    const entries = [
      { threadId: "thr_a1", providerId: "p1" },
      { threadId: "thr_g1", providerId: "p2" },
      { threadId: "thr_a2", providerId: "p1" },
      { threadId: "thr_g2", providerId: "p2" },
    ];
    const cases = [
      { direction: "up", threadId: "thr_g2", expected: ["thr_a1", "thr_g2", "thr_a2", "thr_g1"] },
      {
        direction: "down",
        threadId: "thr_a1",
        expected: ["thr_a2", "thr_g1", "thr_a1", "thr_g2"],
      },
      {
        direction: "top",
        threadId: "thr_g2",
        expected: ["thr_a1", "thr_g2", "thr_g1", "thr_a2"],
      },
      {
        direction: "bottom",
        threadId: "thr_g1",
        expected: ["thr_a1", "thr_a2", "thr_g2", "thr_g1"],
      },
    ] as const;
    for (const { direction, threadId, expected } of cases) {
      const fake = await setup({ storedEntries: entries });
      await expect(
        fake.harness.callRpc("move", { threadId, direction }),
      ).resolves.toEqual({ ok: true });
      expect(await storedEntries(fake)).toEqual(
        expected.map((threadId) =>
          entries.find((entry) => entry.threadId === threadId),
        ),
      );
    }
  });

  it("leaves the order alone when a row has no same-provider neighbor", async () => {
    const entries = [
      { threadId: "thr_a", providerId: PROVIDER },
      { threadId: "thr_b", providerId: PROVIDER },
    ];
    for (const direction of ["up", "down", "top", "bottom"] as const) {
      const fake = await setup({ storedEntries: entries });
      const signalsBefore = fake.harness.realtimeSignals.length;
      await expect(
        fake.harness.callRpc("move", {
          threadId: direction === "up" || direction === "top" ? "thr_a" : "thr_b",
          direction,
        }),
      ).resolves.toEqual({ ok: true });
      expect(await storedEntries(fake)).toEqual(entries);
      expect(fake.harness.realtimeSignals).toHaveLength(signalsBefore);
    }
  });

  it("rejects a row that is not queued", async () => {
    const { harness } = await setup();

    await expect(
      harness.callRpc("move", { threadId: "thr_ghost", direction: "up" }),
    ).rejects.toThrow("thr_ghost is not queued");
  });

  it("releases a queued row over rpc", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
      threads: { thr_new: { status: "pending" } },
    });
    const signalsBefore = fake.harness.realtimeSignals.length;

    await expect(
      fake.harness.callRpc("release", { threadId: "thr_new" }),
    ).resolves.toEqual({ ok: true });

    expect(await storedEntries(fake)).toEqual([]);
    expect(fake.harness.recheckCount).toBe(1);
    expect(fake.harness.realtimeSignals).toHaveLength(signalsBefore + 1);
  });
});

describe("cli", () => {
  it("rejects releasing a thread that is not queued", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["release", "thr_unknown", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not_queued");
    expect(harness.recheckCount).toBe(0);
  });

  it("releases a queued thread and rechecks", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
    });

    const result = await fake.harness.runCli(["release", "thr_new"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "Released thr_new; it starts once other plugins and core allow it.",
    );
    expect(await storedEntries(fake)).toEqual([]);
    expect(fake.harness.recheckCount).toBe(1);
  });

  it("reports a release as JSON when asked", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_new", providerId: PROVIDER }],
    });

    const result = await fake.harness.runCli(["release", "thr_new", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      threadId: "thr_new",
      released: true,
    });
    expect(await storedEntries(fake)).toEqual([]);
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
    expect(result.stdout).toBe("Thread thr_spawned spawned (pending).");
  });

  it("reports a held spawn in plain text and as JSON", async () => {
    const held = await setup({
      storedEntries: [{ threadId: "thr_spawned", providerId: PROVIDER }],
    });
    const heldResult = await held.harness.runCli(
      ["spawn", "--prompt", "go"],
      { projectId: "proj_ctx" },
    );
    expect(heldResult.stdout).toBe(
      "Thread thr_spawned queued; it starts when its provider has a free slot.",
    );

    const jsonResult = await held.harness.runCli(
      ["spawn", "--prompt", "go", "--json"],
      { projectId: "proj_ctx" },
    );
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      queued: true,
      thread: { id: "thr_spawned" },
    });
  });

  it("reports a spawned thread as spawned once it is no longer pending", async () => {
    const started = await setup({
      storedEntries: [{ threadId: "thr_spawned", providerId: PROVIDER }],
      spawnStatus: "starting",
    });

    const result = await started.harness.runCli(
      ["spawn", "--prompt", "go"],
      { projectId: "proj_ctx" },
    );

    expect(result.stdout).toBe("Thread thr_spawned spawned (starting).");
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

  it("rejects a whitespace-only prompt", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["spawn", "--prompt", "   ", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("invalid_value");
    expect(result.stdout).toContain("The prompt is empty");
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("links the parent only when asked and rejects --parent-self without a calling thread", async () => {
    const { harness } = await setup();

    const rejected = await harness.runCli(
      ["spawn", "--prompt", "go", "--parent-self", "--json"],
      { projectId: "proj_ctx" },
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toContain("missing_thread");

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

  it("passes provider, model, level, mode, and environment to the spawn", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(
      [
        "spawn",
        "--prompt",
        "go",
        "--provider",
        "codex",
        "--model",
        "gpt-5.3",
        "--reasoning-level",
        "high",
        "--permission-mode",
        "auto",
        "--environment",
        "env_1",
      ],
      { projectId: "proj_ctx" },
    );

    expect(result.exitCode).toBe(0);
    expect(harness.sdk.callsTo("threads.spawn")).toEqual([
      [
        expect.objectContaining({
          providerId: "codex",
          model: "gpt-5.3",
          reasoningLevel: "high",
          permissionMode: "auto",
          environment: { type: "reuse", environmentId: "env_1" },
        }),
      ],
    ]);
  });

  it("queues an existing pending thread", async () => {
    const fake = await setup({
      threads: { thr_existing: { providerId: "codex", status: "pending" } },
    });

    const result = await fake.harness.runCli(
      ["add", "thr_existing", "--json"],
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      threadId: "thr_existing",
      providerId: "codex",
      queued: true,
    });
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_existing", providerId: "codex" },
    ]);
    expect(fake.harness.recheckCount).toBe(1);
  });

  it("adds a pending thread with the plain success text", async () => {
    const fake = await setup({
      threads: { thr_existing: { providerId: "codex", status: "pending" } },
    });

    const result = await fake.harness.runCli(["add", "thr_existing"]);

    expect(result.stdout).toBe(
      "Added thr_existing to the queue; it starts when its provider has a free slot.",
    );
  });

  it("refuses to add a thread that is not pending", async () => {
    const { harness } = await setup({
      threads: { thr_existing: { providerId: "codex", status: "active" } },
    });

    const result = await harness.runCli(["add", "thr_existing", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not_pending");
    expect(result.stdout).toContain("Only a pending thread can be queued.");
  });

  it("refuses to add a thread that is already queued", async () => {
    const { harness } = await setup({
      storedEntries: [{ threadId: "thr_existing", providerId: "codex" }],
      threads: { thr_existing: { providerId: "codex", status: "pending" } },
    });

    const result = await harness.runCli(["add", "thr_existing", "--json"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("already_queued");
  });

  it("lists queued threads, stale rows, and the per-provider summary", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_wait1", providerId: "p1" },
        { threadId: "thr_start", providerId: "p1" },
        { threadId: "thr_stale", providerId: "p1" },
        { threadId: "thr_gone", providerId: "p1" },
        { threadId: "thr_unknown", providerId: "p1" },
      ],
      storedLimits: { p1: 2 },
      running: [running("thr_busy"), running("thr_wait_user")],
      threads: {
        thr_wait1: { providerId: "p1", status: "pending", title: "Plan" },
        thr_start: { providerId: "p1", status: "pending" },
        thr_stale: { providerId: "p1", status: "active" },
        thr_unknown: new Error("boom"),
        thr_busy: { providerId: "p1", status: "active", title: "Busy" },
        thr_wait_user: { providerId: "p1", status: "active" },
      },
      interactions: { thr_wait_user: [interaction()] },
      providers: [provider("p1", "Codex")],
    });

    const result = await fake.harness.runCli(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        "1. thr_wait1  Plan  Codex  starts on the next recheck",
        "2. thr_start  (untitled)  Codex  waiting: 1 thread running on Codex, limit 2",
        "thr_stale  stale (thread is active), removed from the queue",
        "thr_gone  stale (thread not found), removed from the queue",
        "thr_unknown  could not be read: boom",
        "",
        "Codex: 1 running + 1 awaiting you, limit 2",
      ].join("\n"),
    );
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_wait1", providerId: "p1" },
      { threadId: "thr_start", providerId: "p1" },
      { threadId: "thr_unknown", providerId: "p1" },
    ]);
  });

  it("lists as JSON with the provider summaries", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_wait1", providerId: "p1" }],
      storedLimits: { p1: 1 },
      running: [running("thr_busy")],
      threads: {
        thr_wait1: { providerId: "p1", status: "pending", title: "Plan" },
        thr_busy: { providerId: "p1", status: "active", title: "Busy" },
      },
      providers: [provider("p1", "Codex")],
    });

    const result = await fake.harness.runCli(["list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      queued: [
        {
          threadId: "thr_wait1",
          state: "queued",
          title: "Plan",
          providerId: "p1",
          provider: "Codex",
          waiting: "1 thread running on Codex, limit 1",
        },
      ],
      providers: [
        {
          providerId: "p1",
          label: "Codex",
          limit: 1,
          running: [{ threadId: "thr_busy", title: "Busy" }],
          awaiting: [],
          queue: [
            { threadId: "thr_wait1", title: "Plan", providerId: "p1" },
          ],
        },
      ],
    });
  });

  it("says the queue is empty", async () => {
    const { harness } = await setup();

    const result = await harness.runCli(["list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("No queued threads.");
  });

  it("filters the list and its summaries by provider", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_p1", providerId: "p1" },
        { threadId: "thr_p2", providerId: "p2" },
      ],
      storedLimits: { p2: 1 },
      running: [running("thr_run2")],
      threads: {
        thr_p1: { providerId: "p1", status: "pending" },
        thr_p2: { providerId: "p2", status: "pending" },
        thr_run2: { providerId: "p2", status: "active" },
      },
      providers: [provider("p1", "Codex"), provider("p2", "Droid")],
    });

    const result = await fake.harness.runCli(["list", "--provider", "p2"]);

    expect(result.stdout).toBe(
      [
        "1. thr_p2  (untitled)  Droid  waiting: 1 thread running on Droid, limit 1",
        "",
        "Droid: 1 running + 0 awaiting you, limit 1",
      ].join("\n"),
    );
  });

  it("numbers rows within their provider", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_a1", providerId: "p1" },
        { threadId: "thr_g1", providerId: "p2" },
        { threadId: "thr_a2", providerId: "p1" },
      ],
      threads: {
        thr_a1: { providerId: "p1", status: "pending" },
        thr_g1: { providerId: "p2", status: "pending" },
        thr_a2: { providerId: "p1", status: "pending" },
      },
      providers: [provider("p1", "Codex"), provider("p2", "Droid")],
    });

    const result = await fake.harness.runCli(["list"]);

    expect(result.stdout).toBe(
      [
        "1. thr_a1  (untitled)  Codex  starts on the next recheck",
        "1. thr_g1  (untitled)  Droid  starts on the next recheck",
        "2. thr_a2  (untitled)  Codex  starts on the next recheck",
        "",
        "Codex: 0 running + 0 awaiting you, limit 2",
        "Droid: 0 running + 0 awaiting you, limit 2",
      ].join("\n"),
    );
  });

  it("strips control and bidi characters from the text list", async () => {
    const { harness } = await setup({
      storedEntries: [{ threadId: "thr_wait1", providerId: "p1" }],
      threads: {
        thr_wait1: {
          providerId: "p1",
          status: "pending",
          title: "Plan\u001b[31m\nnext\u202e",
        },
      },
      providers: [provider("p1", "Codex")],
    });

    const result = await harness.runCli(["list"]);

    expect(result.stdout).toBe(
      [
        "1. thr_wait1  Plan [31m next   Codex  starts on the next recheck",
        "",
        "Codex: 0 running + 0 awaiting you, limit 2",
      ].join("\n"),
    );
  });

  it("lists the paused reason for a provider with limit 0", async () => {
    const fake = await setup({
      storedEntries: [{ threadId: "thr_wait1", providerId: "p1" }],
      storedLimits: { p1: 0 },
      threads: { thr_wait1: { providerId: "p1", status: "pending" } },
      providers: [provider("p1", "Codex")],
    });

    const result = await fake.harness.runCli(["list"]);

    expect(result.stdout).toBe(
      [
        "1. thr_wait1  (untitled)  Codex  waiting: Codex is paused (limit 0)",
        "",
        "Codex: 0 running + 0 awaiting you, limit 0",
      ].join("\n"),
    );
  });

  it("moves a queued thread and rejects bad moves", async () => {
    const fake = await setup({
      storedEntries: [
        { threadId: "thr_a", providerId: PROVIDER },
        { threadId: "thr_b", providerId: PROVIDER },
      ],
    });

    const moved = await fake.harness.runCli(["move", "thr_b", "up"]);
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toBe("Moved thr_b up.");
    expect(await storedEntries(fake)).toEqual([
      { threadId: "thr_b", providerId: PROVIDER },
      { threadId: "thr_a", providerId: PROVIDER },
    ]);

    const notQueued = await fake.harness.runCli(
      ["move", "thr_ghost", "up", "--json"],
    );
    expect(notQueued.exitCode).toBe(1);
    expect(notQueued.stdout).toContain("not_queued");

    const badDirection = await fake.harness.runCli(
      ["move", "thr_b", "sideways"],
    );
    expect(badDirection.exitCode).toBe(1);
    expect(badDirection.stderr).toContain("Unknown direction sideways");

    const jsonMoved = await fake.harness.runCli([
      "move",
      "thr_b",
      "bottom",
      "--json",
    ]);
    expect(JSON.parse(jsonMoved.stdout)).toEqual({
      threadId: "thr_b",
      direction: "bottom",
      moved: true,
    });
  });

  it("shows and sets provider limits", async () => {
    const fake = await setup({
      storedLimits: { p1: 3 },
      providers: [provider("p1", "Codex"), provider("p2", "Droid")],
    });

    const all = await fake.harness.runCli(["limit"]);
    expect(all.stdout).toBe("p1: 3\n(default 2 for every other provider)");

    const one = await fake.harness.runCli(["limit", "p1"]);
    expect(one.stdout).toBe("p1: 3");

    const unset = await fake.harness.runCli(["limit", "p9"]);
    expect(unset.stdout).toBe("p9: default 2");

    const set = await fake.harness.runCli(["limit", "p2", "5"]);
    expect(set.stdout).toBe("Set p2 limit to 5.");
    expect(await storedLimits(fake)).toEqual({ p1: 3, p2: 5 });
    expect(fake.harness.recheckCount).toBe(1);

    const unknown = await fake.harness.runCli(["limit", "ghost", "5"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown provider ghost");
  });

  it("announces a paused provider when the limit is set to 0", async () => {
    const fake = await setup({
      providers: [provider("p1", "Codex")],
    });

    const result = await fake.harness.runCli(["limit", "p1", "0"]);

    expect(result.stdout).toBe(
      [
        "Set p1 limit to 0.",
        "p1 is now paused: every queued thread on it is held until the limit is raised.",
      ].join("\n"),
    );
    expect(await storedLimits(fake)).toEqual({ p1: 0 });
  });

  it("rejects an invalid limit", async () => {
    const { harness } = await setup();

    const notANumber = await harness.runCli(["limit", "p1", "abc"]);
    expect(notANumber.exitCode).toBe(1);
    expect(notANumber.stderr).toContain(
      "The limit must be a whole number of 0 or more, not abc",
    );

    const fractional = await harness.runCli(["limit", "p1", "1.5"]);
    expect(fractional.exitCode).toBe(1);
    expect(fractional.stderr).toContain(
      "The limit must be a whole number of 0 or more, not 1.5",
    );

    for (const empty of ["", "  "]) {
      const result = await harness.runCli(["limit", "p1", empty]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "The limit must be a whole number of 0 or more; got an empty value",
      );
    }
  });

  it("emits limits as JSON", async () => {
    const fake = await setup({
      storedLimits: { p1: 3 },
      providers: [provider("p1", "Codex"), provider("p2", "Droid")],
    });

    const all = await fake.harness.runCli(["limit", "--json"]);
    expect(JSON.parse(all.stdout)).toEqual({ limits: { p1: 3 }, defaultLimit: 2 });

    const one = await fake.harness.runCli(["limit", "p1", "--json"]);
    expect(JSON.parse(one.stdout)).toEqual({
      providerId: "p1",
      limit: 3,
      default: false,
    });

    const unset = await fake.harness.runCli(["limit", "p9", "--json"]);
    expect(JSON.parse(unset.stdout)).toEqual({
      providerId: "p9",
      limit: 2,
      default: true,
    });

    const set = await fake.harness.runCli(["limit", "p2", "1", "--json"]);
    expect(JSON.parse(set.stdout)).toEqual({ providerId: "p2", limit: 1 });
  });
});

describe("rpc contract", () => {
  it("declares the four methods", () => {
    expect(Object.keys(rpcContract).sort()).toEqual([
      "move",
      "release",
      "setLimit",
      "snapshot",
    ]);
  });
});
