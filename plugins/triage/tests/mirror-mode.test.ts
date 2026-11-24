import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

// Provenance for the threads.list quirks pinned below: the SDK bundled-types
// ThreadListArgs doc, node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:18210-18232
// (threadIds capped at 200 per call, unknown and deleted ids dropped) plus the
// ThreadListArgs fields (archived is a selector, includeHidden gates hidden
// sessions; there is no sort parameter).
//
// Provenance for the liveness quirk: threads.listRunning returns only the threads in
// `starting` or `active` (SDK bundled-types ThreadsArea.listRunning, the ThreadRunningResponse
// array of { id, hostId }), so a running descendant is found without paging a thread tree.

type ListArgs = { threadIds?: readonly string[]; archived?: boolean; includeHidden?: boolean; limit?: number; offset?: number };
type ListHandler = (args: ListArgs) => unknown;
type ChangeEvent = { id?: string; changes: string[]; metadata?: { backgroundActivityChanged?: boolean; eventTypes?: string[] } };
type DescendantArgs = { threadIds: readonly string[] };

const thr = (id: string, overrides: Record<string, unknown> = {}) =>
  ({ ...makeThreadResponse({ id, projectId: "project-1", title: `Session ${id}`, ...overrides }), ...overrides, activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0, ...(overrides.activity as object | undefined) } });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(predicate: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

// A host that serves `all` page by page, honouring offset and limit.
const pagedList = (all: unknown[], pageSize: number): ListHandler => (args) => {
  const offset = args.offset ?? 0;
  return all.slice(offset, offset + Math.min(pageSize, args.limit ?? pageSize));
};

async function setup(options: { settings?: Record<string, boolean>; list?: ListHandler } = {}) {
  const known = new Map<string, any>();
  const ctx = {
    list: options.list ?? ((): unknown => []),
    // threads.listRunning: only threads in starting or active (SDK bundled-types ThreadsArea.listRunning).
    running: ((): unknown => []) as () => unknown,
    events: ((): unknown => []) as (args: any) => unknown,
    readChanged: ((_event: ChangeEvent) => {}) as (event: ChangeEvent) => void,
    unsubscribed: false,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    settings: options.settings,
    sdk: {
      subscribe: ({ callback }: any) => {
        ctx.readChanged = callback;
        return () => { ctx.unsubscribed = true; };
      },
      threads: {
        markRead: async (args: { threadId: string }) => {
          const thread = known.get(args.threadId);
          thread.lastReadAt = Date.now();
          return thread;
        },
        markUnread: async (args: { threadId: string }) => {
          const thread = known.get(args.threadId);
          thread.lastReadAt = 0;
          return thread;
        },
        get: async (args: { threadId: string }) => known.get(args.threadId),
        list: async (args: ListArgs = {}) => ctx.list(args) as any,
        experimental_listDescendants: async ({ threadIds }: { threadIds: readonly string[] }) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }),
        listRunning: async () => ctx.running() as any,
        events: { list: async (args: any) => ctx.events(args) as any },
        interactions: { list: async () => [] },
        spawn: async () => makeThreadResponse({ id: "spawned-1", originPluginId: "triage" }),
        update: async () => makeThreadResponse(),
        stop: async () => ({}),
        defaultExecutionOptions: async () => null,
      },
      projects: {
        list: async () => [],
        get: async (args: { projectId: string }) => ({ id: args.projectId, name: `Project ${args.projectId}` }),
      },
      hosts: {
        list: async () => [],
        get: async (args: { hostId: string }) => ({ id: args.hostId, name: `Host ${args.hostId}`, status: "connected" }),
      },
      providers: { list: async () => [], models: async () => ({ models: [] }) },
      environments: {
        get: async (args: { environmentId: string }) => {
          if (!args.environmentId.startsWith("env-")) throw new Error("Environment unreachable");
          return { hostId: `host-${args.environmentId}`, branchName: "main", isGitRepo: true };
        },
      },
    },
  });
  await plugin(bb);
  const db = bb.storage.database();
  const cardOf = (threadId: string) =>
    db.prepare("SELECT * FROM triage_tasks WHERE thread_id = ?").get(threadId) as any;
  const cards = () => db.prepare("SELECT * FROM triage_tasks ORDER BY number").all() as any[];
  const eventsOf = (taskId: string) =>
    db.prepare("SELECT actor, event FROM triage_events WHERE task_id = ? ORDER BY created_at, rowid").all(taskId) as any[];
  const notifications = () => db.prepare("SELECT * FROM triage_notifications").all() as any[];
  const emit = (event: string, payload: Record<string, unknown>) =>
    (harness.behavior.emitThreadEvent as any)(event, payload);
  const emitNative = (event: string, payload: Record<string, any>) => {
    const status = event === "thread.active" ? "active" : event === "thread.idle" ? "idle" : event === "thread.failed" ? "error" : payload.thread?.status;
    if (payload.thread && ["thread.active", "thread.idle", "thread.failed", "thread.unarchived"].includes(event)) {
      known.set(payload.thread.id, { ...payload.thread, status });
    }
    return emit(event, payload);
  };
  const rpc = (method: string, input: unknown = null) =>
    harness.behavior.callRpc(method, input) as Promise<Record<string, any>>;
  const mirror = async (thread: any) => {
    known.set(thread.id, thread);
    await emit("thread.created", { thread });
    await until(() => cardOf(thread.id) !== undefined);
    await flush();
    return cardOf(thread.id);
  };
  const importManual = async (thread: any) => {
    known.set(thread.id, thread);
    return rpc("importThread", { threadId: thread.id });
  };
  return { bb, harness, db, ctx, known, cardOf, cards, eventsOf, notifications, emit, emitNative, rpc, mirror, importManual };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const open: Setup[] = [];
const start = async (options?: Parameters<typeof setup>[0]) => {
  const context = await setup(options);
  open.push(context);
  return context;
};
afterEach(async () => {
  vi.useRealTimers();
  for (const context of open.splice(0)) await context.harness.lifecycle.dispose();
});

test.each([
  { status: "idle", payload: { kind: "user_question", questions: [{ prompt: "Choose an option" }] } },
  { status: "error", payload: { kind: "plugin", title: "Complete the form" } },
])("review 1: startup exposes existing $status input", async ({ status, payload }) => {
  const { harness, ctx, known, cardOf } = await startQuiet({ settings: { autoCardThreads: false } });
  const thread = thr(`startup-input-${status}`, { status });
  known.set(thread.id, thread);
  ctx.list = worldOf([thread]).handler;
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "input", createdAt: 1, payload }]);
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cardOf(thread.id)?.stage_id === "stage-attention");
  expect(cardOf(thread.id)).toMatchObject({ run_state: "idle", settled_at: null });
});

test("review 1: a pending input older than explicit settlement stays acknowledged", async () => {
  const { db, harness, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr("startup-explicit-ack", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'idle', attention_reason = 'Question', read_at = NULL, settled_at = 150 WHERE id = ?").run(card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run("startup-explicit-ack-event", card.id, 150);
  ctx.list = worldOf([thread]).handler;
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "question", createdAt: 100, payload: { title: "Question" } }]);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", settled_at: 150 });
});

test.each([90, 110])("history settlement compares pending input to explicit acknowledgment at %i", async (ackTime) => {
  const { db, harness, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr(`history-ack-${ackTime}`, { status: "idle", lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET created_at = 150, settled_at = 150, read_at = NULL WHERE id = ?").run(card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run(`ack-${ackTime}`, card.id, ackTime);
  ctx.list = worldOf([thread]).handler;
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "question", createdAt: 100, payload: { title: "Question" } }]);
  await rpc("snapshot");
  expect(cardOf(thread.id).settled_at).toBe(ackTime < 100 ? null : 150);
});

test.each(["thread", "interaction"])("a read event invalidates the final %s lookup", async (delayed) => {
  const { harness, mirror, cardOf, ctx, known, emit } = await startQuiet();
  const active = thr(`final-read-${delayed}`, { status: "active" });
  await mirror(active);
  const idle = { ...active, status: "idle", latestAttentionAt: 100, lastReadAt: 0 };
  known.set(idle.id, idle);
  const gate = deferred<any>();
  let calls = 0;
  let held = false;
  if (delayed === "thread") harness.inspection.sdk.stub("threads.get", async () => {
    if (++calls === 2) { held = true; return gate.promise; }
    return known.get(idle.id);
  });
  else harness.inspection.sdk.stub("threads.interactions.list", async () => {
    if (++calls === 2) { held = true; return gate.promise; }
    return [];
  });
  const completion = emit("thread.idle", { thread: idle });
  await until(() => held);
  known.set(idle.id, { ...idle, lastReadAt: 101 });
  ctx.readChanged({ id: idle.id, changes: ["read-state-changed"] });
  gate.resolve(delayed === "thread" ? idle : []);
  await completion;
  await until(() => cardOf(idle.id).settled_at !== null);
  expect(cardOf(idle.id).read_at).toBe(101);
});

test.each(["interactions-changed", "read-state-changed"])("a %s event without an id retries an in-flight card", async (change) => {
  const { harness, mirror, cardOf, ctx, known, emit } = await startQuiet();
  const active = thr("interaction-without-id", { status: "active" });
  await mirror(active);
  const idle = { ...active, status: "idle" };
  known.set(idle.id, idle);
  const gate = deferred<any>();
  let held = false;
  harness.inspection.sdk.stub("threads.get", async () => {
    if (!held) { held = true; return gate.promise; }
    return idle;
  });
  const completion = emit("thread.idle", { thread: idle });
  await until(() => held);
  ctx.readChanged({ changes: [change] });
  gate.resolve(idle);
  await completion;
  await until(() => cardOf(idle.id).run_state === "completed");
});

test.each(["manual", "mirror"] as const) ("review 2: %s custom card remains open after local and native reads", async (origin) => {
  const { db, mirror, importManual, rpc, cardOf, ctx, known } = await startQuiet();
  const thread = thr(`custom-read-${origin}`, { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = origin === "manual" ? await importManual(thread) : await mirror(thread);
  const custom = await rpc("createStage", { name: "Holding" });
  await rpc("moveTask", { number: card.number, stageId: custom.id });
  await rpc("setTaskRead", { number: card.number, read: true });
  ctx.list = worldOf([thread]).handler;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: custom.id, run_state: "completed", settled_at: null });
  const read = { ...thread, lastReadAt: 101 };
  known.set(thread.id, read);
  ctx.list = worldOf([read]).handler;
  db.prepare("UPDATE triage_tasks SET settled_at = NULL WHERE id = ?").run(card.id);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: custom.id, run_state: "completed", settled_at: null });
});

test.each(["manual", "mirror"] as const)("review 3: %s sidebar read converges without a snapshot", async (origin) => {
  const { mirror, importManual, cardOf, ctx, known, emit } = await startQuiet();
  const active = thr(`read-race-${origin}`, { status: "active", latestAttentionAt: 100, lastReadAt: 0 });
  if (origin === "manual") await importManual(active); else await mirror(active);
  const idle = { ...active, status: "idle" };
  known.set(idle.id, idle);
  const gate = deferred<unknown[]>();
  let calls = 0;
  ctx.running = () => ++calls === 1 ? gate.promise : [];
  const completion = emit("thread.idle", { thread: idle, lastAssistantText: "Done" });
  await until(() => calls === 1);
  known.set(idle.id, { ...idle, lastReadAt: 101 });
  ctx.readChanged({ id: idle.id, changes: ["read-state-changed"] });
  gate.resolve([]);
  await completion;
  await until(() => cardOf(idle.id).run_state === "completed", 500);
  expect(cardOf(idle.id)).toMatchObject({ read_at: 101, settled_at: expect.any(Number) });
});

test("review 4: child activity reads only its affected root", async () => {
  const context = await startQuiet();
  const { harness, mirror, known, ctx, emit } = context;
  const roots = Array.from({ length: 12 }, (_, index) => thr(`fanout-${index}`, { status: "active" }));
  for (const root of roots) await mirror(root);
  const child = kid("fanout-child", roots[0].id);
  known.set(child.id, child);
  ctx.list = worldOf([...roots, child]).handler;
  running(context, child.id);
  const before = harness.inspection.sdk.callsTo("threads.interactions.list").length;
  await emit("thread.active", { thread: child });
  await flush();
  await flush();
  const calls = harness.inspection.sdk.callsTo("threads.interactions.list").slice(before) as [{ threadId: string }][];
  expect(calls.map(([args]) => args.threadId).every((id) => id === roots[0].id)).toBe(true);
});

test("review 4: snapshot bounds concurrent interaction reads", async () => {
  const { harness, mirror, rpc, ctx } = await startQuiet();
  const threads = Array.from({ length: 20 }, (_, index) => thr(`bounded-${index}`, { status: "active" }));
  for (const thread of threads) await mirror(thread);
  ctx.list = worldOf(threads).handler;
  const gate = deferred<void>();
  let active = 0;
  let maximum = 0;
  harness.inspection.sdk.stub("threads.interactions.list", async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate.promise;
    active -= 1;
    return [];
  });
  const snapshot = rpc("snapshot");
  await until(() => maximum > 0);
  await flush();
  gate.resolve();
  await snapshot;
  expect(maximum).toBeLessThanOrEqual(8);
});

test("review 5: delayed child preserves a completed acknowledgment until a newer reply", async () => {
  const context = await startQuiet();
  const { mirror, rpc, cardOf, known, ctx, emit } = context;
  const root = thr("ack-child-root", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(root);
  await rpc("setTaskRead", { number: card.number, read: true });
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const acknowledged = { ...cardOf(root.id) };
  const child = kid("ack-child", root.id);
  known.set(child.id, child);
  ctx.list = worldOf([known.get(root.id), child]).handler;
  running(context, child.id);
  await emit("thread.active", { thread: child });
  await until(() => cardOf(root.id).run_state === "working");
  expect(cardOf(root.id)).toMatchObject({ read_at: acknowledged.read_at, settled_at: acknowledged.settled_at });
  const newer = { ...known.get(root.id), latestAttentionAt: Math.max(Date.now(), acknowledged.settled_at) + 1000 };
  known.set(root.id, newer);
  ctx.list = worldOf([newer, child]).handler;
  await emit("thread.active", { thread: child });
  await until(() => cardOf(root.id).settled_at === null);
  expect(cardOf(root.id).read_at).toBeNull();
});

test("a settled working card keeps its acknowledgment until newer output", async () => {
  const { db, mirror, rpc, cardOf, ctx, known } = await startQuiet();
  const thread = thr("working-ack", { status: "active", latestAttentionAt: 100 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET read_at = 150, settled_at = 150 WHERE id = ?").run(card.id);
  ctx.list = worldOf([thread]).handler;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: 150, settled_at: 150 });
  const withoutOutput = { ...thread, latestAttentionAt: null };
  known.set(thread.id, withoutOutput);
  ctx.list = worldOf([withoutOutput]).handler;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: 150, settled_at: 150 });
  const newer = { ...thread, latestAttentionAt: 151 };
  known.set(thread.id, newer);
  ctx.list = worldOf([newer]).handler;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
});

test("an idle root without explicit settlement follows its live child", async () => {
  const context = await startQuiet();
  const { mirror, cardOf, known, ctx, emit } = context;
  const root = thr("unsettled-child-root", { status: "active" });
  await mirror(root);
  const idle = { ...root, status: "idle" };
  const child = kid("unsettled-child", root.id);
  known.set(root.id, idle);
  known.set(child.id, child);
  ctx.list = worldOf([idle, child]).handler;
  running(context, child.id);
  await emit("thread.active", { thread: child });
  await flush();
  expect(cardOf(root.id)).toMatchObject({ run_state: "working", stage_id: "stage-progress" });
});

test("callbacks after disposal do not start native reconciliation", async () => {
  const { harness, ctx, mirror } = await startQuiet();
  const thread = thr("disposed-thread", { status: "active" });
  await mirror(thread);
  await flush();
  const methods = ["threads.get", "threads.list", "threads.listRunning", "threads.interactions.list"] as const;
  const reads = methods.map((method) => harness.inspection.sdk.callsTo(method).length);
  await harness.lifecycle.dispose();
  ctx.readChanged({ id: thread.id, changes: ["interactions-changed"] });
  ctx.readChanged({ changes: ["interactions-changed"] });
  await flush();
  expect(methods.map((method) => harness.inspection.sdk.callsTo(method).length)).toStrictEqual(reads);
});

test.each(["pending", "finished", "stopped", "settings", "moved-pending", "moved-finished"])("deferred snapshot repairs unrelated cards when child is %s", async (timing) => {
  const { db, harness, mirror, rpc, cardOf, known, ctx, emit } = await startQuiet();
  const root = thr(`snapshot-root-${timing}`, { status: "active" });
  const other = thr(`snapshot-other-${timing}`, { status: "active" });
  await mirror(root);
  const otherCard = await mirror(other);
  const idle = { ...other, status: "idle" };
  known.set(other.id, idle);
  const world = worldOf([root, idle]).handler;
  const ancestry = deferred<any>();
  const metadata = deferred<void>();
  let asked = false;
  let listing = false;
  let holdingAncestry = true;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === root.id && holdingAncestry) { asked = true; return ancestry.promise; }
    return known.get(args.threadId);
  });
  ctx.list = async (args) => {
    if (timing.endsWith("finished") && args.threadIds?.includes(other.id)) { listing = true; await metadata.promise; }
    return world(args);
  };
  const snapshot = timing.endsWith("finished") ? rpc("snapshot") : undefined;
  if (snapshot) await until(() => listing);
  const child = emit("thread.idle", { thread: kid(`snapshot-child-${timing}`, root.id, { status: "idle" }) });
  await until(() => asked);
  if (!timing.endsWith("finished")) {
    await rpc("snapshot");
    expect(cardOf(other.id).run_state).toBe("working");
    if (timing === "stopped") db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(otherCard.id);
    if (timing === "settings") await harness.behavior.setSettings({ autoCardThreads: false });
  }
  if (timing.startsWith("moved")) await rpc("moveTask", { number: otherCard.number, stageId: "stage-attention" });
  holdingAncestry = false;
  ancestry.resolve(root);
  await child;
  if (snapshot) { metadata.resolve(); await snapshot; }
  if (timing === "stopped" || timing === "settings") {
    await flush();
    expect(cardOf(other.id).run_state).toBe(timing === "stopped" ? "stopped" : "working");
  } else if (timing.startsWith("moved")) {
    await flush();
    await flush();
    expect(cardOf(other.id)).toMatchObject({ stage_id: "stage-attention", run_state: "working" });
  } else {
    await until(() => cardOf(other.id).run_state === "completed", 500);
    expect(cardOf(other.id).stage_id).toBe("stage-completed");
  }
});

test.each([false, true, "settings"] as const)("snapshot eligibility survives repeated child interruptions, moved: %s", async (moved) => {
  const { harness, mirror, rpc, cardOf, known, ctx, emit } = await startQuiet();
  const roots = ["a", "b", "c", "d"].map((name) => thr(`retry-${name}-${moved}`, { status: "active" }));
  for (const root of roots) await mirror(root);
  const card = cardOf(roots[1].id);
  const idle = { ...roots[1], status: "idle" };
  known.set(idle.id, idle);
  ctx.list = worldOf([roots[0], idle, roots[2], roots[3]]).handler;
  // Gate unlinked ancestors so a snapshot's card lookups cannot take the gates.
  const parents = [roots[0], roots[2], roots[3]].map((root) => kid(`parent-${root.id}`, root.id));
  const ancestry = [deferred<any>(), deferred<any>(), deferred<any>()];
  const reads = [deferred<any[]>(), deferred<any[]>()];
  const asked = [false, false, false];
  let readCount = 0;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    const index = parents.findIndex((parent) => parent.id === args.threadId);
    if (index >= 0 && !asked[index]) { asked[index] = true; return ancestry[index].promise; }
    return known.get(args.threadId);
  });
  harness.inspection.sdk.stub("threads.interactions.list", async (args: { threadId: string }) => {
    if (args.threadId === idle.id && readCount < 2) return reads[readCount++].promise;
    return [];
  });
  const childA = emit("thread.idle", { thread: kid(`retry-child-a-${moved}`, parents[0].id, { status: "idle" }) });
  await until(() => asked[0]);
  await rpc("snapshot");
  ancestry[0].resolve(parents[0]);
  await childA;
  await until(() => readCount === 1);
  const childC = emit("thread.idle", { thread: kid(`retry-child-c-${moved}`, parents[1].id, { status: "idle" }) });
  await until(() => asked[1]);
  reads[0].resolve([]);
  ancestry[1].resolve(parents[1]);
  await childC;
  await until(() => readCount === 2);
  const childD = emit("thread.idle", { thread: kid(`retry-child-d-${moved}`, parents[2].id, { status: "idle" }) });
  await until(() => asked[2]);
  reads[1].resolve([]);
  if (moved === true) await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  if (moved === "settings") await harness.behavior.setSettings({ autoCardThreads: false });
  ancestry[2].resolve(parents[2]);
  await childD;
  if (moved === true) {
    await flush();
    await flush();
    expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-attention", run_state: "working" });
  } else if (moved === "settings") {
    await flush();
    expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  } else {
    await until(() => cardOf(idle.id).run_state === "completed", 500);
    expect(cardOf(idle.id).stage_id).toBe("stage-completed");
  }
});

test("snapshot skips stale metadata after mirroring settings change", async () => {
  const { harness, mirror, rpc, cardOf, known, ctx } = await startQuiet();
  const active = thr("snapshot-settings-race", { status: "active" });
  await mirror(active);
  const idle = { ...active, status: "idle" };
  known.set(active.id, idle);
  const gate = deferred<any[]>();
  let asked = false;
  ctx.list = () => { asked = true; return gate.promise; };
  const snapshot = rpc("snapshot");
  await until(() => asked);
  await harness.behavior.setSettings({ autoCardThreads: false });
  gate.resolve([idle]);
  await snapshot;
  expect(cardOf(active.id).run_state).toBe("working");
});

test("repeating explicit settlement records an acknowledgment even when nothing changes", async () => {
  const { mirror, rpc, cardOf, eventsOf } = await startQuiet();
  const thread = thr("same-settlement", { status: "idle" });
  const card = await mirror(thread);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    await rpc("setTaskSettled", { number: card.number, settled: true });
    await rpc("setTaskSettled", { number: card.number, settled: true });
    expect(eventsOf(card.id).filter((event) => event.event === "marked settled")).toHaveLength(2);
    expect(cardOf(thread.id).settled_at).toBe(clock());
  } finally { clock.mockRestore(); }
});

test.each([false, true])("review 6: final liveness reflects a descendant starting during another card's read: %s", async (childStarts) => {
  const context = await startQuiet();
  const { harness, mirror, rpc, cardOf, ctx, known } = context;
  const first = thr(`liveness-a-${childStarts}`, { status: "active" });
  const second = thr(`liveness-b-${childStarts}`, { status: "active" });
  await mirror(first);
  await mirror(second);
  const idleA = { ...first, status: "idle" };
  const idleB = { ...second, status: "idle" };
  const child = kid(`liveness-child-${childStarts}`, second.id);
  known.set(first.id, idleA);
  known.set(second.id, idleB);
  known.set(child.id, child);
  ctx.list = worldOf([idleA, idleB, child]).handler;
  const gate = deferred<any[]>();
  let delayed = false;
  harness.inspection.sdk.stub("threads.interactions.list", async (args: { threadId: string }) => {
    if (args.threadId === second.id && !delayed) { delayed = true; return gate.promise; }
    return [];
  });
  const before = runningCalls(context);
  const snapshot = rpc("snapshot");
  await until(() => delayed && runningCalls(context) > before);
  if (childStarts) running(context, child.id);
  gate.resolve([]);
  await snapshot;
  expect(cardOf(first.id).run_state).toBe("completed");
  expect(cardOf(second.id).run_state).toBe(childStarts ? "working" : "completed");
  expect(cardOf(second.id).settled_at).toBeNull();
});

test("2026-11-18: snapshot repairs idle attention without pending input", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("stale-attention-report", { status: "idle" });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'idle', attention_reason = 'Old handoff' WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", attention_reason: null });
});

test.each(["manual", "mirror"] as const)("%s card follows pending native input and its resolution", async (origin) => {
  const { harness, mirror, importManual, rpc, cardOf, ctx, known } = await start();
  const thread = thr(`native-input-${origin}`, { status: "active" });
  if (origin === "manual") await importManual(thread);
  else await mirror(thread);
  ctx.list = () => [thread];
  let pending = true;
  harness.inspection.sdk.stub("threads.interactions.list", async () =>
    pending ? [{ id: "question", payload: { title: "Choose an option" } }] : []);
  ctx.readChanged({ id: thread.id, changes: ["interactions-changed"] });
  await until(() => cardOf(thread.id).stage_id === "stage-attention");
  expect(cardOf(thread.id)).toMatchObject({ run_state: "idle", attention_reason: "Choose an option" });
  pending = false;
  ctx.readChanged({ id: thread.id, changes: ["interactions-changed"] });
  await until(() => cardOf(thread.id).stage_id === "stage-progress");
  expect(cardOf(thread.id)).toMatchObject({ run_state: "working", attention_reason: null });
  known.set(thread.id, { ...thread, status: "idle" });
  ctx.list = () => [known.get(thread.id)];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", attention_reason: null });
});

test.each([
  { kind: "user_question", questions: [{ prompt: "Choose an option" }] },
  { kind: "approval", reason: "Approve the plan" },
  { kind: "plugin", title: "Complete the form" },
])("pending $kind takes priority over a failed thread", async (payload) => {
  const { harness, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr(`native-${payload.kind}`, { status: "error" });
  await mirror(thread);
  ctx.list = () => [thread];
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "input", payload }]);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", attention_reason: expect.any(String) });
});

test("a custom-stage manual completion produces a neutral update", async () => {
  const { importManual, known, rpc, emit, cardOf, notifications } = await start();
  const active = thr("custom-neutral", { status: "active" });
  const card = await importManual(active);
  const custom = await rpc("createStage", { name: "Holding" });
  await rpc("moveTask", { number: card.number, stageId: custom.id });
  const idle = thr(active.id, { status: "idle" });
  known.set(idle.id, idle);
  await emit("thread.idle", { thread: idle, lastAssistantText: "Done" });
  expect(cardOf(idle.id)).toMatchObject({ stage_id: custom.id, run_state: "completed", attention_reason: null });
  expect(notifications().map((notification) => notification.action)).toContain("Update ready");
  expect(notifications().map((notification) => notification.action)).not.toContain("Waiting for you");
});

test("resolving input restores the underlying failure reason", async () => {
  const { db, harness, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("native-failure-resolution", { status: "error" });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'failed', attention_reason = 'Provider crashed' WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  let pending = true;
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "form", payload: { title: "Choose an option" } }] : []);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", attention_reason: "Choose an option" });
  pending = false;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-progress", run_state: "failed", attention_reason: "Provider crashed" });
});

test("renamed system stages still follow pending input and idle state", async () => {
  const { harness, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("native-renamed", { status: "idle" });
  await mirror(thread);
  ctx.list = () => [thread];
  await rpc("renameStage", { id: "stage-attention", name: "Needs input" });
  await rpc("renameStage", { id: "stage-completed", name: "Shipped" });
  let pending = true;
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "plan", payload: { reason: "Approve the plan" } }] : []);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle" });
  pending = false;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", attention_reason: null });
});

test("custom placement keeps its column while native input comes and goes", async () => {
  const { harness, importManual, rpc, cardOf, ctx } = await start();
  const thread = thr("custom-input", { status: "active" });
  const card = await importManual(thread);
  const custom = await rpc("createStage", { name: "Holding" });
  await rpc("moveTask", { number: card.number, stageId: custom.id });
  ctx.list = () => [thread];
  let pending = true;
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "form", payload: { title: "Complete the form" } }] : []);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: custom.id, run_state: "idle", attention_reason: "Complete the form" });
  pending = false;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: custom.id, run_state: "working", attention_reason: null });
});

test("a newer pending interaction reopens an acknowledged card with the same reason", async () => {
  const { db, harness, mirror, rpc, cardOf, ctx, notifications } = await start();
  const thread = thr("same-input-reason", { status: "active" });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'idle', attention_reason = 'Question', settled_at = 100 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  let createdAt = 99;
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "question", createdAt, payload: { title: "Question" } }]);
  await rpc("snapshot");
  expect(cardOf(thread.id).settled_at).toBe(100);
  expect(notifications()).toStrictEqual([]);
  createdAt = 101;
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", settled_at: null });
  expect(notifications().map((notification) => notification.action)).toContain("Waiting for you");
});

test.each(["manual", "mirror"] as const)("%s snapshot compares pending input time with the read acknowledgment", async (origin) => {
  const { db, harness, mirror, importManual, rpc, emit, cardOf, ctx, notifications } = await startQuiet();
  const thread = thr(`input-read-${origin}`, { status: "active", latestAttentionAt: 100, lastReadAt: 50 });
  const card = origin === "manual" ? await importManual(thread) : await mirror(thread);
  db.prepare("UPDATE triage_tasks SET run_state = 'idle', attention_reason = 'Same question', read_at = 50, settled_at = NULL, updated_at = 60 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "question-b", createdAt: 100, payload: { kind: "plugin", title: "Same question" } }]);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", attention_reason: "Same question", read_at: null });
  db.prepare("UPDATE triage_tasks SET read_at = 150 WHERE id = ?").run(card.id);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", attention_reason: "Same question", read_at: 150 });
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', run_state = 'working' WHERE id = ?").run(card.id);
  await emit("interaction.pending", { thread, interaction: { id: "question-b" } });
  await until(() => cardOf(thread.id).stage_id === "stage-attention");
  expect(cardOf(thread.id)).toMatchObject({ run_state: "idle", read_at: 150 });
  const notices = notifications().length;
  db.prepare("UPDATE triage_tasks SET read_at = 50, settled_at = 150 WHERE id = ?").run(card.id);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: 150 });
  expect(notifications()).toHaveLength(notices);
});

test("an approval without a reason still shows pending input", async () => {
  const { harness, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr("approval-no-reason", { status: "active" });
  await mirror(thread);
  ctx.list = () => [thread];
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "approval", payload: { kind: "approval", reason: null } }]);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", run_state: "idle", attention_reason: "Waiting for you" });
});

test("explicit settlement after a native reply survives reconciliation", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr("settled-after-reply", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET read_at = 10, settled_at = 101 WHERE id = ?").run(card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run("settled-after-reply-event", card.id, 101);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", read_at: 10, settled_at: 101 });
});

test("an older reopen does not acknowledge a newer native reply", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr("reopened-before-reply", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET read_at = 10, settled_at = 42 WHERE id = ?").run(card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'reopened', ?)").run("reopened-before-reply-event", card.id, 99);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", read_at: null, settled_at: null });
});

test("a reopened idle card stays open when native attention has no timestamp", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await startQuiet();
  const thread = thr("reopened-null-attention", { status: "idle", latestAttentionAt: null, lastReadAt: null });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET read_at = NULL, settled_at = 42 WHERE id = ?").run(card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'reopened', ?)").run("reopened-null-event", card.id, 100);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", read_at: null, settled_at: null });
});

test("a missing final native thread read preserves the card and logs the lookup", async () => {
  const context = await startQuiet();
  const { harness, mirror, rpc, emit, cardOf } = context;
  const thread = thr("missing-final-native", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const before = { ...cardOf(thread.id) };
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => ++calls === 1 ? thread : undefined);
  await emit("thread.active", { thread });
  expect(cardOf(thread.id)).toStrictEqual(before);
  expect(warned(context, "session missing-final-native was not found")).toBe(true);
});

test.each(["manual", "mirror"] as const)("%s active reconciliation survives a timeline append", async (origin) => {
  const { harness, mirror, importManual, emit, cardOf, ctx, known } = await startQuiet();
  const idle = thr(`append-active-${origin}`, { status: "idle" });
  if (origin === "manual") await importManual(idle);
  else await mirror(idle);
  expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed" });
  const activeThread = thr(idle.id, { status: "active" });
  known.set(idle.id, activeThread);
  const gate = deferred<any>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => ++calls === 1 ? gate.promise : { ...activeThread });
  const active = emit("thread.active", { thread: activeThread });
  await until(() => calls === 1);
  ctx.readChanged({ id: idle.id, changes: ["events-appended"] });
  gate.resolve({ ...activeThread });
  await active;
  expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
});

test.each([true, false])("a benign timeline append does not start a native lookup with id=%s", async (hasId) => {
  const { harness, mirror, cardOf, ctx } = await startQuiet();
  const thread = thr(`append-noop-${hasId}`, { status: "idle" });
  await mirror(thread);
  const before = { ...cardOf(thread.id) };
  const calls = harness.inspection.sdk.callsTo("threads.get").length;
  ctx.readChanged({ ...(hasId ? { id: thread.id } : {}), changes: ["events-appended"] });
  await flush();
  expect(harness.inspection.sdk.callsTo("threads.get")).toHaveLength(calls);
  expect(cardOf(thread.id)).toStrictEqual(before);
});

test("a native status change during lookup prevents stale completion", async () => {
  const { harness, mirror, emit, cardOf, known, ctx } = await startQuiet();
  const activeThread = thr("append-status-race", { status: "active", latestAttentionAt: 200 });
  await mirror(activeThread);
  const idle = thr(activeThread.id, { status: "idle", latestAttentionAt: 100 });
  const gate = deferred<any>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => ++calls === 1 ? gate.promise : known.get(activeThread.id));
  const completion = emit("thread.idle", { thread: idle });
  await until(() => calls === 1);
  ctx.readChanged({ id: activeThread.id, changes: ["events-appended"] });
  gate.resolve(idle);
  await completion;
  expect(cardOf(activeThread.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
});

test("an id-less interaction change refreshes linked cards", async () => {
  const { harness, mirror, cardOf, ctx } = await startQuiet();
  const thread = thr("broad-input", { status: "active" });
  await mirror(thread);
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "input", payload: { title: "Question" } }]);
  ctx.readChanged({ changes: ["interactions-changed"] });
  await until(() => cardOf(thread.id).stage_id === "stage-attention");
  expect(cardOf(thread.id)).toMatchObject({ run_state: "idle", attention_reason: "Question" });
});

test.each(["thread.active", "thread.idle", "thread.failed", "thread.archived", "thread.deleted"])("disposal cancels %s while a child parent lookup is pending", async (event) => {
  const { harness, mirror, emit } = await startQuiet();
  const root = thr("disposed-child-root", { status: "active" });
  await mirror(root);
  const parent = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.get", async () => { asked = true; return parent.promise; });
  const active = emit(event, { thread: kid("disposed-child", root.id), lastAssistantText: null, error: "failure" });
  await until(() => asked);
  await harness.lifecycle.dispose();
  parent.resolve(root);
  expect((await active).errors).toStrictEqual([]);
});

test("disposal cancels creation and unarchive while project lookup is pending", async () => {
  const context = await startQuiet();
  const { harness, emit } = context;
  const release = gateProjects(context);
  const thread = thr("disposed-creation", { status: "idle" });
  await emit("thread.created", { thread });
  await until(() => harness.inspection.sdk.callsTo("projects.get").length > 0);
  const unarchive = emit("thread.unarchived", { thread });
  await harness.lifecycle.dispose();
  release();
  expect((await unarchive).errors).toStrictEqual([]);
});

test.each(["thread.active", "thread.idle"])("%s native lookup rejected after disposal cannot update a card", async (event) => {
  const { harness, mirror, emit } = await startQuiet();
  const thread = thr("disposed-lookup", { status: "active" });
  await mirror(thread);
  let reject!: (error: Error) => void;
  const pending = new Promise<any[]>((_, rejectPromise) => { reject = rejectPromise; });
  let asked = false;
  harness.inspection.sdk.stub("threads.interactions.list", async () => { asked = true; return pending; });
  const active = emit(event, { thread, lastAssistantText: null });
  await until(() => asked);
  await harness.lifecycle.dispose();
  reject(new Error("unavailable"));
  expect((await active).errors).toStrictEqual([]);
});

test("disposal cancels unarchive while its own creation is pending", async () => {
  const context = await startQuiet();
  const { harness, emit } = context;
  const release = gateProjects(context);
  const thread = thr("disposed-unarchive", { status: "idle" });
  const unarchive = emit("thread.unarchived", { thread });
  await until(() => harness.inspection.sdk.callsTo("projects.get").length > 0);
  await harness.lifecycle.dispose();
  release();
  expect((await unarchive).errors).toStrictEqual([]);
});

test("a failed event for a hidden mirror cannot change its card", async () => {
  const { mirror, emit, cardOf } = await startQuiet();
  const thread = thr("hidden-failure", { status: "active" });
  await mirror(thread);
  const before = { ...cardOf(thread.id) };
  await emit("thread.failed", { thread: thr(thread.id, { status: "error", visibility: "hidden" }), error: "failure" });
  expect(cardOf(thread.id)).toStrictEqual(before);
});

test("a later failure invalidates pending active-session metadata", async () => {
  const { harness, mirror, emitNative: emit, cardOf } = await startQuiet();
  const thread = thr("metadata-failure-race", { status: "active" });
  await mirror(thread);
  const gate = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("environments.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread: thr(thread.id, { status: "active", title: "Old title", environmentId: "env-race" }) });
  await until(() => asked);
  await emit("thread.failed", { thread: thr(thread.id, { status: "error" }), error: "failure" });
  gate.resolve({ hostId: "host-race", branchName: "main", isGitRepo: true });
  await active;
  expect(cardOf(thread.id)).toMatchObject({ run_state: "failed", attention_reason: "failure" });
  expect(cardOf(thread.id).title).not.toBe("Old title");
});

test("a later rename wins over a pending active-session metadata lookup", async () => {
  const { harness, mirror, rpc, emit, cardOf } = await startQuiet();
  const thread = thr("metadata-rename-race", { status: "active" });
  const card = await mirror(thread);
  const gate = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("environments.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread: thr(thread.id, { status: "active", title: "Old title", environmentId: "env-race" }) });
  await until(() => asked);
  await rpc("renameTask", { number: card.number, title: "New title" });
  gate.resolve({ hostId: "host-race", branchName: "main", isGitRepo: true });
  await active;
  expect(cardOf(thread.id).title).toBe("New title");
});

test("a broad interaction change during child and backfill work defers reconciliation", async () => {
  const { harness, ctx, emit, known } = await startQuiet();
  const root = thr("broad-child-root", { status: "active" });
  known.set(root.id, root);
  const parent = deferred<any>();
  let parentAsked = false;
  harness.inspection.sdk.stub("threads.get", async () => { parentAsked = true; return parent.promise; });
  const child = emit("thread.idle", { thread: kid("broad-child", root.id), lastAssistantText: null });
  await until(() => parentAsked);
  const page = deferred<any[]>();
  let pageAsked = false;
  ctx.list = () => { pageAsked = true; return page.promise; };
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => pageAsked);
  ctx.readChanged({ changes: ["interactions-changed"] });
  page.resolve([]);
  parent.resolve(root);
  expect((await child).errors).toStrictEqual([]);
});

test("backfill does not recapture a card created and moved during its project lookup", async () => {
  const context = await startQuiet();
  const { harness, ctx, known, cardOf, emit, rpc } = context;
  const thread = thr("backfill-created-race", { status: "active" });
  known.set(thread.id, thread);
  ctx.list = worldOf([thread]).handler;
  const custom = await rpc("createStage", { name: "Holding" });
  const gate = deferred<any>();
  let lookups = 0;
  harness.inspection.sdk.stub("projects.get", async () => ++lookups === 1 ? gate.promise : { id: thread.projectId, name: "Project" });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => lookups === 1);
  await emit("thread.created", { thread });
  await until(() => cardOf(thread.id) !== undefined);
  await rpc("moveTask", { number: cardOf(thread.id).number, stageId: custom.id });
  gate.resolve({ id: thread.projectId, name: "Project" });
  await flush();
  await flush();
  expect(cardOf(thread.id).stage_id).toBe(custom.id);
});

test.each(["settings", "child"])("backfill revalidates %s changes during live-root creation", async (change) => {
  const context = await startQuiet();
  const { harness, ctx, known, cards, cardOf, emit } = context;
  const roots = [thr(`live-root-${change}-1`, { status: "idle" }), thr(`live-root-${change}-2`, { status: "idle" })];
  const children = roots.map((root) => kid(`child-${root.id}`, root.id));
  for (const thread of [...roots, ...children]) known.set(thread.id, thread);
  ctx.list = worldOf(children).handler;
  running(context, ...children.map((child) => child.id));
  const gate = deferred<any>();
  let lookups = 0;
  harness.inspection.sdk.stub("projects.get", async () => ++lookups === 1 ? gate.promise : { id: "project-1", name: "Project" });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => lookups === 1);
  if (change === "settings") await harness.behavior.setSettings({ autoCardThreads: false });
  else {
    running(context, children[0].id);
    await emit("thread.idle", { thread: children[1], lastAssistantText: null });
  }
  gate.resolve({ id: "project-1", name: "Project" });
  if (change === "settings") {
    await flush();
    await flush();
    expect(cards()).toStrictEqual([]);
  } else {
    await until(() => cardOf(roots[0].id)?.run_state === "working");
    expect(cardOf(roots[0].id)).toMatchObject({ stage_id: "stage-progress", settled_at: null });
  }
});

test("reading a completed card removes it without manual settlement", async () => {
  const { db, mirror, rpc, cardOf } = await start();
  const card = await mirror(thr("read-completed", { status: "idle" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  await rpc("setTaskRead", { number: card.number, read: true });
  expect(cardOf("read-completed").settled_at).not.toBeNull();
});

test("snapshot acknowledges a completed native read", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("native-read", { status: "idle", latestAttentionAt: 100, lastReadAt: 101 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = NULL, settled_at = NULL WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf("native-read")).toMatchObject({ read_at: expect.any(Number), settled_at: expect.any(Number) });
});

test("reload reopens a completed card when native unread has a null timestamp", async () => {
  const { db, mirror, ctx, harness } = await startQuiet();
  const thread = thr("reload-null", { latestAttentionAt: 100, lastReadAt: null });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 101, settled_at = 101 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  const reloaded = await harness.lifecycle.reload(plugin);
  await reloaded.harness.behavior.callRpc("snapshot", null);
  const row = reloaded.bb.storage.database().prepare("SELECT read_at, settled_at FROM triage_tasks WHERE id = ?").get(card.id);
  expect(row).toMatchObject({ read_at: null, settled_at: null });
  await reloaded.harness.lifecycle.dispose();
});

test("an id-less read change reconciles native unread with a null timestamp", async () => {
  const { db, mirror, ctx, rpc, cardOf } = await startQuiet();
  const thread = thr("broad-null", { latestAttentionAt: 100, lastReadAt: null });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 101, settled_at = 101 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  ctx.readChanged({ changes: ["read-state-changed"] });
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
});

test("an unanswered reconciliation lookup preserves an unread card", async () => {
  const context = await startQuiet();
  const { db, mirror, cardOf, known, ctx } = context;
  const card = await mirror(thr("unanswered-regression", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  known.delete("unanswered-regression");
  ctx.list = () => [];
  const before = { ...cardOf("unanswered-regression") };
  await runPass(context, 3);
  expect(cardOf("unanswered-regression")).toStrictEqual(before);
});

test.each(["batch", "confirmation"])("reconciliation preserves a root during %s metadata lookup while child parent confirmation is pending", async (lookup) => {
  const context = await startQuiet();
  const { db, mirror, cardOf, known, ctx, harness, emit } = context;
  const root = thr("confirm-race", { status: "idle" });
  const card = await mirror(thr(root.id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  const metadata = deferred<unknown[]>();
  const confirmation = deferred<any>();
  const parent = deferred<any>();
  let metadataAsked = false;
  let parentAsked = false;
  ctx.list = (args) => {
    if (!args.threadIds) return [];
    if (lookup === "batch") { metadataAsked = true; return metadata.promise; }
    return [];
  };
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === root.id) {
      if (lookup === "confirmation" && !metadataAsked) { metadataAsked = true; return confirmation.promise; }
      parentAsked = true;
      return parent.promise;
    }
    return known.get(args.threadId);
  });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => metadataAsked);
  const child = emit("thread.active", { thread: kid("confirm-child", root.id) });
  await until(() => parentAsked);
  metadata.resolve([root]);
  confirmation.resolve(root);
  await flush();
  await flush();
  const during = { ...cardOf(root.id) };
  parent.resolve(root);
  await child;
  expect(during).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("idle completion preserves a root while child parent confirmation is pending", async () => {
  const { mirror, cardOf, known, harness, emit } = await startQuiet();
  const root = thr("idle-confirm-race", { status: "idle" });
  await mirror(thr(root.id, { status: "active" }));
  const confirmation = deferred<any>();
  const parent = deferred<any>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId !== root.id) return known.get(args.threadId);
    calls += 1;
    return calls === 1 ? confirmation.promise : parent.promise;
  });
  const idle = emit("thread.idle", { thread: root });
  await until(() => calls === 1);
  const child = emit("thread.active", { thread: kid("idle-confirm-child", root.id) });
  await until(() => calls === 2);
  confirmation.resolve(root);
  await idle;
  const during = { ...cardOf(root.id) };
  parent.resolve(root);
  await child;
  expect(during).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("idle completion preserves a root when child activity starts during liveness lookup", async () => {
  const { mirror, cardOf, ctx, harness, emit } = await startQuiet();
  const root = thr("live-race", { status: "idle" });
  await mirror(thr(root.id, { status: "active" }));
  const live = deferred<unknown[]>();
  const parent = deferred<any>();
  let runningAsked = false;
  let parentAsked = false;
  let lookups = 0;
  ctx.running = () => { runningAsked = true; return live.promise; };
  harness.inspection.sdk.stub("threads.get", async () => {
    if (++lookups === 1) return root;
    parentAsked = true;
    return parent.promise;
  });
  const idle = emit("thread.idle", { thread: root });
  await until(() => runningAsked);
  const child = emit("thread.active", { thread: kid("live-race-child", root.id) });
  await until(() => parentAsked);
  live.resolve([]);
  await idle;
  const during = { ...cardOf(root.id) };
  parent.resolve(root);
  await child;
  expect(during).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test.each([false, true])("unrelated child activity retries event completion with read=%s", async (read) => {
  const context = await startQuiet();
  const { db, mirror, cardOf, ctx, known, harness, emit } = context;
  const root = thr(`retry-event-${read}`, { status: "idle", latestAttentionAt: 100, lastReadAt: read ? 101 : 0 });
  const other = thr(`other-event-${read}`, { status: "active" });
  const card = await mirror(thr(root.id, { status: "active" }));
  known.set(root.id, root);
  await mirror(other);
  if (!read) db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  const confirmation = deferred<any>();
  const ancestry = deferred<any>();
  let rootAsked = false;
  let parentAsked = false;
  ctx.list = worldOf([root, other]).handler;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === root.id && !rootAsked) { rootAsked = true; return confirmation.promise; }
    if (args.threadId === other.id && !parentAsked) { parentAsked = true; return ancestry.promise; }
    return known.get(args.threadId);
  });
  const idle = emit("thread.idle", { thread: root });
  await until(() => rootAsked);
  const child = emit("thread.active", { thread: kid(`other-child-${read}`, other.id) });
  await until(() => parentAsked);
  confirmation.resolve(root);
  await idle;
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  const clock = read ? vi.spyOn(Date, "now").mockReturnValue(card.created_at) : null;
  try {
    ancestry.resolve(other);
    await child;
  } finally {
    clock?.mockRestore();
  }
  await until(() => cardOf(root.id).stage_id === "stage-completed");
  expect(cardOf(root.id)).toMatchObject({ run_state: "completed", read_at: read ? 101 : null, settled_at: read ? expect.any(Number) : null });
});

test("unrelated child activity retries reconciliation after an active backfill", async () => {
  const context = await startQuiet();
  const { db, mirror, cardOf, ctx, known, harness, emit } = context;
  const root = thr("retry-backfill-root", { status: "idle", latestAttentionAt: 100, lastReadAt: 101 });
  const other = thr("retry-backfill-other", { status: "active" });
  const card = await mirror(thr(root.id, { status: "active" }));
  known.set(root.id, root);
  await mirror(other);
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  const liveness = deferred<unknown[]>();
  const ancestry = deferred<any>();
  let runningCount = 0;
  let parentAsked = false;
  let childStarted = false;
  ctx.running = () => (++runningCount === 2 ? liveness.promise : []);
  ctx.list = worldOf([root, other]).handler;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === other.id && childStarted && !parentAsked) { parentAsked = true; return ancestry.promise; }
    return known.get(args.threadId);
  });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => runningCount >= 2);
  childStarted = true;
  const child = emit("thread.active", { thread: kid("retry-backfill-child", other.id) });
  await until(() => parentAsked);
  await emit("thread.idle", { thread: root });
  await emit("thread.idle", { thread: root });
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  ancestry.resolve(other);
  await child;
  liveness.resolve([]);
  await until(() => cardOf(root.id).stage_id === "stage-completed");
  await flush();
  expect(cardOf(root.id)).toMatchObject({ run_state: "completed", read_at: 101, settled_at: expect.any(Number) });
});

test("a retry keeps a root working while its own child is active", async () => {
  const context = await startQuiet();
  const { db, mirror, cardOf, ctx, known, harness, emit } = context;
  const root = thr("retry-own-root", { status: "idle", latestAttentionAt: 100, lastReadAt: 101 });
  const childThread = kid("retry-own-child", root.id);
  const card = await mirror(thr(root.id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  known.set(root.id, root);
  known.set(childThread.id, childThread);
  ctx.list = worldOf([root, childThread]).handler;
  const ancestry = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === root.id && !asked) { asked = true; return ancestry.promise; }
    return known.get(args.threadId);
  });
  const child = emit("thread.active", { thread: childThread });
  await until(() => asked);
  await emit("thread.idle", { thread: root });
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  const before = runningCalls(context);
  running(context, childThread.id);
  ancestry.resolve(root);
  await child;
  await until(() => runningCalls(context) >= before + 2);
  await flush();
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("a backfill waits for a child handler already pending at reconciliation", async () => {
  const context = await startQuiet();
  const { db, mirror, cardOf, ctx, known, harness, emit } = context;
  const root = thr("retry-pending-root", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const other = thr("retry-pending-other", { status: "active" });
  const card = await mirror(thr(root.id, { status: "active" }));
  known.set(root.id, root);
  await mirror(other);
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  ctx.list = worldOf([root, other]).handler;
  const ancestry = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === other.id && !asked) { asked = true; return ancestry.promise; }
    return known.get(args.threadId);
  });
  const child = emit("thread.active", { thread: kid("retry-pending-child", other.id) });
  await until(() => asked);
  const before = runningCalls(context);
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await flush();
  await flush();
  ctx.readChanged({ changes: ["interactions-changed"] });
  expect(runningCalls(context)).toBe(before);
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  ancestry.resolve(other);
  await child;
  await until(() => cardOf(root.id).stage_id === "stage-completed");
  expect(cardOf(root.id)).toMatchObject({ run_state: "completed", read_at: null, settled_at: null });
});

test.each(["same", "unrelated"])("child activity invalidates a legacy restoration for a %s root", async (relation) => {
  const context = await startQuiet();
  const { db, mirror, cardOf, ctx, known, harness, emit, rpc } = context;
  const legacy = thr(`legacy-race-${relation}`, { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const other = thr(`other-race-${relation}`, { status: "active" });
  const card = await mirror(thr(legacy.id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', run_state = 'idle', read_at = NULL, settled_at = 42 WHERE id = ?").run(card.id);
  known.set(legacy.id, legacy);
  known.set(other.id, other);
  const target = relation === "same" ? legacy : other;
  const child = kid(`legacy-race-child-${relation}`, target.id);
  known.set(child.id, child);
  ctx.list = worldOf([legacy, other, child]).handler;
  const live = deferred<unknown[]>();
  const parent = deferred<any>();
  let liveAsked = false;
  let parentAsked = false;
  let childLive = false;
  ctx.running = () => { if (!liveAsked) { liveAsked = true; return live.promise; } return childLive ? [{ id: child.id, hostId: null }] : []; };
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === target.id && !parentAsked) { parentAsked = true; return parent.promise; }
    return known.get(args.threadId);
  });
  const snapshot = rpc("snapshot");
  await until(() => liveAsked);
  const active = emit("thread.active", { thread: child });
  await until(() => parentAsked);
  live.resolve([]);
  await snapshot;
  expect(cardOf(legacy.id)).toMatchObject({ stage_id: "stage-progress", run_state: "idle", settled_at: 42 });
  childLive = true;
  parent.resolve(target);
  await active;
  await until(() => cardOf(legacy.id).run_state === (relation === "same" ? "working" : "completed"));
  expect(cardOf(legacy.id)).toMatchObject({ stage_id: relation === "same" ? "stage-progress" : "stage-completed", settled_at: null });
});

test("native read invalidation refreshes completed cards and disposes its subscription", async () => {
  const context = await start();
  const { db, mirror, rpc, cardOf, ctx, harness } = context;
  const thread = thr("sidebar-read", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id).settled_at).toBeNull();
  vi.useFakeTimers();
  ctx.readChanged({ id: thread.id, changes: ["read-state-changed"] });
  await vi.advanceTimersByTimeAsync(250);
  const signals = harness.realtimeSignals.length;
  ctx.readChanged({ id: "unknown", changes: ["read-state-changed"] });
  ctx.readChanged({ id: thread.id, changes: ["title-changed"] });
  await vi.advanceTimersByTimeAsync(250);
  expect(harness.realtimeSignals.length).toBe(signals);
  thread.lastReadAt = 101;
  ctx.readChanged({ id: thread.id, changes: ["read-state-changed"] });
  await vi.advanceTimersByTimeAsync(249);
  expect(harness.realtimeSignals.length).toBe(signals);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.realtimeSignals.length).toBe(signals + 1);
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: 101, settled_at: expect.any(Number) });
  thread.lastReadAt = 0;
  ctx.readChanged({ changes: ["read-state-changed"] });
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
  await harness.lifecycle.dispose();
  expect(ctx.unsubscribed).toBe(true);
});

test("a native unread snapshot clears a read marker when lastReadAt becomes null", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("null-unread", { latestAttentionAt: 100, lastReadAt: null });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 101, settled_at = 101 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
  ctx.readChanged({ id: thread.id, changes: ["read-state-changed"] });
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
});

// User report, 2026-11-17: settle must re-detect the linked thread's stage.
test.each([
  { status: "active", stage: "stage-progress", state: "working", settled: false },
  { status: "idle", stage: "stage-completed", state: "completed", settled: true },
])("settle re-detects a linked $status thread", async ({ status, stage, state, settled }) => {
  const { db, mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr(`settle-${status}`, { status }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'idle' WHERE id = ?").run(card.id);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(`settle-${status}`)).toMatchObject({ stage_id: stage, run_state: state, settled_at: settled ? expect.any(Number) : null });
  expect(harness.inspection.sdk.callsTo("threads.markRead")).toHaveLength(0);
});

test.each([
  { name: "pending interaction", pending: true, answer: false, expected: "stage-attention" },
  { name: "unanswered handoff", pending: false, answer: false, expected: "stage-completed" },
  { name: "answered handoff", pending: false, answer: true, expected: "stage-completed" },
])("settle detects $name", async ({ name, pending, answer, expected }) => {
  const { mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr(name, { status: "idle" }));
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "question", payload: { title: "Question" } }] : []);
  harness.inspection.sdk.stub("threads.events.list", async () => answer ? [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }] : []);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(name)).toMatchObject({ stage_id: expected, settled_at: expected === "stage-completed" ? expect.any(Number) : null });
});

test("settle leaves the card unchanged when liveness lookup fails", async () => {
  const { mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr("settle-lookup-failure", { status: "idle" }));
  harness.inspection.sdk.stub("threads.listRunning", async () => { throw new Error("unavailable"); });
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-lookup-failure")).toStrictEqual(card);
});

test("settle detects a running descendant", async () => {
  const context = await startQuiet();
  const root = thr("settle-root", { status: "idle" });
  const child = kid("settle-child", root.id);
  const card = await context.mirror(root);
  context.known.set(child.id, child);
  context.ctx.list = worldOf([root, child]).handler;
  running(context, child.id);
  await context.rpc("setTaskSettled", { number: card.number, settled: true });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test.each([false, true])("settle preserves the card when descendant liveness changes from %s during the final read", async (initiallyLive) => {
  const context = await startQuiet();
  const root = thr(`settle-liveness-${initiallyLive}`, { status: "idle" });
  const child = kid(`settle-liveness-child-${initiallyLive}`, root.id);
  const card = await context.mirror(root);
  context.known.set(child.id, child);
  context.ctx.list = worldOf([root, child]).handler;
  running(context, ...(initiallyLive ? [child.id] : []));
  const gate = deferred<unknown>();
  let calls = 0;
  context.harness.inspection.sdk.stub("threads.get", async () => ++calls === 2 ? gate.promise : root);
  const before = { ...context.cardOf(root.id) };
  const history = context.eventsOf(card.id);
  const settling = context.rpc("setTaskSettled", { number: card.number, settled: true });
  await until(() => calls >= 2);
  running(context, ...(initiallyLive ? [] : [child.id]));
  gate.resolve(root);
  await settling;
  expect(context.cardOf(root.id)).toStrictEqual(before);
  expect(context.eventsOf(card.id)).toStrictEqual(history);
});

test("settle preserves the card when the final liveness lookup fails", async () => {
  const context = await startQuiet();
  const card = await context.mirror(thr("settle-final-liveness-fails", { status: "idle" }));
  const before = { ...context.cardOf("settle-final-liveness-fails") };
  const history = context.eventsOf(card.id);
  let calls = 0;
  context.ctx.running = () => { if (++calls === 2) throw new Error("unavailable"); return []; };
  await context.rpc("setTaskSettled", { number: card.number, settled: true });
  expect(context.cardOf("settle-final-liveness-fails")).toStrictEqual(before);
  expect(context.eventsOf(card.id)).toStrictEqual(history);
});

test.each(["move", "child"])("settle preserves a concurrent %s during final liveness lookup", async (change) => {
  const context = await startQuiet();
  const root = thr(`settle-final-live-${change}`, { status: "idle" });
  const card = await context.mirror(root);
  const gate = deferred<unknown[]>();
  let calls = 0;
  context.ctx.running = () => ++calls === 2 ? gate.promise : [];
  const settling = context.rpc("setTaskSettled", { number: card.number, settled: true });
  await until(() => calls === 2);
  if (change === "move") await context.rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  else await context.emit("thread.active", { thread: kid("settle-final-live-child", root.id) });
  const before = { ...context.cardOf(root.id) };
  const history = context.eventsOf(card.id);
  gate.resolve([]);
  await settling;
  expect(context.cardOf(root.id)).toStrictEqual(before);
  expect(context.eventsOf(card.id)).toStrictEqual(history);
});

test("an unrelated running root does not prevent settlement", async () => {
  const context = await startQuiet();
  const root = thr("settle-unrelated-root", { status: "idle" });
  const other = thr("settle-unrelated-other", { status: "active" });
  const card = await context.mirror(root);
  context.ctx.list = worldOf([root, other]).handler;
  let calls = 0;
  context.ctx.running = () => ++calls === 1 ? [] : [{ id: other.id, hostId: null }];
  await context.rpc("setTaskSettled", { number: card.number, settled: true });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: expect.any(Number) });
});

test("pending input takes priority while a root is running", async () => {
  const { mirror, rpc, cardOf, harness } = await startQuiet();
  const card = await mirror(thr("settle-running-question", { status: "active" }));
  harness.inspection.sdk.stub("threads.interactions.list", async () => [{ id: "question", payload: { title: "Question" } }]);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-running-question")).toMatchObject({ stage_id: "stage-attention", run_state: "idle", settled_at: null });
});

test("a later reply lets child activity reopen an explicitly settled completion", async () => {
  const context = await startQuiet();
  const { mirror, rpc, cardOf, known, emit, db, ctx } = context;
  const root = thr("settle-later-root", { status: "idle", latestAttentionAt: 100 });
  const card = await mirror(root);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const event = db.prepare("SELECT created_at FROM triage_events WHERE task_id = ? AND event = 'marked settled'").get(card.id) as { created_at: number };
  known.set(root.id, thr(root.id, { status: "idle", latestAttentionAt: event.created_at + 1 }));
  const child = kid("settle-later-child", root.id);
  known.set(child.id, child);
  ctx.list = worldOf([known.get(root.id), child]).handler;
  running(context, child.id);
  await emit("thread.active", { thread: child });
  await until(() => cardOf(root.id).run_state === "working");
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test.each(["error", "stopped"])("settle preserves %s terminal state", async (state) => {
  const { db, mirror, rpc, cardOf } = await startQuiet();
  const card = await mirror(thr(`settle-terminal-${state}`, { status: state === "error" ? "error" : "idle" }));
  db.prepare("UPDATE triage_tasks SET run_state = ?, stage_id = 'stage-attention' WHERE id = ?").run(state === "error" ? "failed" : "stopped", card.id);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(`settle-terminal-${state}`)).toMatchObject({ stage_id: state === "error" ? "stage-progress" : "stage-attention", run_state: state === "error" ? "failed" : "stopped", settled_at: expect.any(Number) });
});

test.each(["pending", "stopping", "missing", "archived", "deleted"])("settle leaves %s threads unchanged", async (state) => {
  const { mirror, rpc, cardOf, known } = await startQuiet();
  const card = await mirror(thr(`settle-${state}`, { status: "idle" }));
  if (state === "missing") known.delete(`settle-${state}`);
  else known.set(`settle-${state}`, thr(`settle-${state}`, { status: state === "pending" || state === "stopping" ? state : "idle", archivedAt: state === "archived" ? 1 : null, deletedAt: state === "deleted" ? 1 : null }));
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(`settle-${state}`)).toStrictEqual(card);
});

test.each(["move", "interaction", "child"])("settle does not overwrite a concurrent %s", async (change) => {
  const context = await startQuiet();
  const { mirror, rpc, cardOf, ctx, emit, known } = context;
  const root = thr(`settle-race-${change}`, { status: "idle" });
  const card = await mirror(root);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.running = () => { asked = true; return gate.promise; };
  const settling = rpc("setTaskSettled", { number: card.number, settled: true });
  await until(() => asked);
  if (change === "move") await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  else if (change === "interaction") await emit("interaction.pending", { thread: root });
  else {
    const child = kid("settle-race-child", root.id);
    known.set(child.id, child);
    await emit("thread.active", { thread: child });
  }
  const before = { ...cardOf(root.id) };
  gate.resolve([]);
  await settling;
  expect(cardOf(root.id)).toStrictEqual(before);
});

test("a late interaction prevents a no-human-input completion", async () => {
  const { mirror, rpc, cardOf, harness } = await startQuiet();
  const card = await mirror(thr("settle-late-interaction", { status: "idle" }));
  let calls = 0;
  harness.inspection.sdk.stub("threads.interactions.list", async () => ++calls === 1 ? [] : [{ id: "late" }]);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-late-interaction")).toStrictEqual(card);
});

test("native unread synchronization preserves explicit settlement", async () => {
  const { mirror, rpc, cardOf, ctx, db } = await startQuiet();
  const thread = thr("settle-native-unread", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET read_at = 101 WHERE id = ?").run(card.id);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const settledAt = cardOf(thread.id).settled_at;
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", read_at: 101, settled_at: settledAt });
  expect(settledAt).not.toBeNull();
});

test("settle does not treat an earlier Human Review placement as the latest handoff", async () => {
  const { mirror, rpc, cardOf } = await startQuiet();
  const card = await mirror(thr("settle-old-handoff", { status: "idle" }));
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  await rpc("moveTask", { number: card.number, stageId: "stage-progress" });
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-old-handoff")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: expect.any(Number) });
});

test("a renamed Human Review stage clears when no input is pending", async () => {
  const { mirror, rpc, cardOf } = await startQuiet();
  const card = await mirror(thr("settle-renamed-handoff", { status: "idle" }));
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  await rpc("renameStage", { id: "stage-attention", name: "Review renamed" });
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-renamed-handoff")).toMatchObject({ stage_id: "stage-completed", settled_at: expect.any(Number) });
  const snapshot = await rpc("snapshot");
  expect(snapshot.stages).toContainEqual(expect.objectContaining({ id: "stage-attention", name: "Review renamed" }));
  expect(snapshot.tasks).toContainEqual(expect.objectContaining({ number: card.number, stageId: "stage-completed", settledAt: expect.any(Number) }));
});

test.each(["threads.get", "threads.interactions.list"])("settle leaves the card unchanged when %s fails", async (method) => {
  const { mirror, rpc, cardOf, harness } = await startQuiet();
  const card = await mirror(thr(`settle-failure-${method}`, { status: "idle" }));
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const before = { ...cardOf(`settle-failure-${method}`) };
  harness.inspection.sdk.stub(method, async () => { throw new Error("unavailable"); });
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(`settle-failure-${method}`)).toStrictEqual(before);
});

test("settle records a native error when the card is not failed", async () => {
  const { mirror, rpc, cardOf, known } = await startQuiet();
  const card = await mirror(thr("settle-native-error", { status: "idle" }));
  known.set("settle-native-error", thr("settle-native-error", { status: "error" }));
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-native-error")).toMatchObject({ stage_id: "stage-progress", run_state: "failed", settled_at: expect.any(Number) });
});

test("a rejected settlement update does not add transition events", async () => {
  const { mirror, rpc, cardOf, db, eventsOf } = await startQuiet();
  const card = await mirror(thr("settle-cas", { status: "idle" }));
  const before = eventsOf(card.id);
  db.exec("CREATE TRIGGER reject_settlement BEFORE UPDATE ON triage_tasks WHEN NEW.stage_id = 'stage-completed' BEGIN SELECT RAISE(IGNORE); END");
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf("settle-cas")).toStrictEqual(card);
  expect(eventsOf(card.id)).toStrictEqual(before);
});

test("a failed settlement update rejects without changing the card", async () => {
  const { mirror, rpc, cardOf, db, eventsOf, harness } = await startQuiet();
  const card = await mirror(thr("settle-update-failure", { status: "idle" }));
  const history = eventsOf(card.id);
  const signals = harness.realtimeSignals.length;
  db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE ON triage_tasks WHEN NEW.stage_id = 'stage-completed' BEGIN SELECT RAISE(ABORT, 'update failure'); END");
  await expect(rpc("setTaskSettled", { number: card.number, settled: true })).rejects.toThrow("update failure");
  expect(cardOf("settle-update-failure")).toStrictEqual(card);
  expect(eventsOf(card.id)).toStrictEqual(history);
  expect(harness.realtimeSignals.length).toBe(signals);
});

test.each([
  { status: "active", event: "moved to In Progress" },
  { status: "idle", event: "turn completed" },
])("settle rolls back when $event history fails", async ({ status, event }) => {
  const { mirror, rpc, cardOf, db, harness } = await startQuiet();
  const thread = thr(`settle-history-${status}`, { status });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention', run_state = 'idle', settled_at = NULL WHERE id = ?").run(card.id);
  const before = { ...cardOf(thread.id) };
  const history = db.prepare("SELECT * FROM triage_events WHERE task_id = ? ORDER BY rowid").all(card.id);
  const signals = harness.realtimeSignals.length;
  db.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON triage_events WHEN NEW.event = '${event}' BEGIN SELECT RAISE(ABORT, 'history failure'); END`);
  const result = await Promise.allSettled([rpc("setTaskSettled", { number: card.number, settled: true })]);
  expect(result[0]).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("history failure") }) });
  expect(cardOf(thread.id)).toStrictEqual(before);
  expect(db.prepare("SELECT * FROM triage_events WHERE task_id = ? ORDER BY rowid").all(card.id)).toStrictEqual(history);
  expect(harness.realtimeSignals.length).toBe(signals);
});

test.each(["threads.get", "threads.interactions.list"])("a move during the final %s read wins over settle", async (method) => {
  const { mirror, rpc, cardOf, harness, eventsOf } = await startQuiet();
  const thread = thr(`settle-final-${method}`, { status: "idle" });
  const card = await mirror(thread);
  const gate = deferred<unknown>();
  let calls = 0;
  harness.inspection.sdk.stub(method, async () => ++calls === 2 ? gate.promise : method === "threads.get" ? thread : []);
  const settling = rpc("setTaskSettled", { number: card.number, settled: true });
  await until(() => calls === 2);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const moved = { ...cardOf(thread.id) };
  const history = eventsOf(card.id);
  gate.resolve(method === "threads.get" ? thread : []);
  await settling;
  expect(cardOf(thread.id)).toStrictEqual(moved);
  expect(eventsOf(card.id)).toStrictEqual(history);
});

test("overlapping settle checks preserve the newer result", async () => {
  const { mirror, rpc, cardOf, harness } = await startQuiet();
  const thread = thr("settle-overlap", { status: "idle" });
  const card = await mirror(thread);
  const gate = deferred<unknown>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => ++calls === 1 ? gate.promise : thread);
  const first = rpc("setTaskSettled", { number: card.number, settled: true });
  await until(() => calls === 1);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const completed = { ...cardOf(thread.id) };
  gate.resolve(thread);
  await first;
  expect(completed).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: expect.any(Number) });
  expect(cardOf(thread.id)).toStrictEqual(completed);
});

test.each([false, true])("settle leaves a card unchanged when root activity changes during lookup, pending=%s", async (pending) => {
  const { mirror, rpc, cardOf, harness } = await startQuiet();
  const card = await mirror(thr(`settle-root-race-${pending}`, { status: "idle" }));
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => thr(`settle-root-race-${pending}`, { status: ++calls === 1 ? "idle" : "active" }));
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "question", payload: { title: "Question" } }] : []);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  expect(cardOf(`settle-root-race-${pending}`)).toStrictEqual(card);
});

test("reopening a read completed card marks the native thread unread", async () => {
  const { db, mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr("reopen-read", { status: "idle" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 10, settled_at = 10 WHERE id = ?").run(card.id);
  await rpc("setTaskSettled", { number: card.number, settled: false });
  expect(harness.inspection.sdk.callsTo("threads.markUnread")).toHaveLength(1);
  expect(cardOf("reopen-read")).toMatchObject({ read_at: null, settled_at: null });
});

test("a native read failure leaves a completed card unread", async () => {
  const { db, mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr("read-fails"));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = NULL, settled_at = NULL WHERE id = ?").run(card.id);
  harness.inspection.sdk.stub("threads.markRead", async () => { throw new Error("native read failed"); });
  await expect(rpc("setTaskRead", { number: card.number, read: true })).rejects.toThrow("native read failed");
  expect(cardOf("read-fails")).toMatchObject({ read_at: null, settled_at: null });
});

test("marking a completed card unread clears both markers and calls the native thread", async () => {
  const { db, mirror, rpc, cardOf, harness, known } = await start();
  const card = await mirror(thr("mark-unread", { lastReadAt: 100 }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 10, settled_at = 10 WHERE id = ?").run(card.id);
  await rpc("setTaskRead", { number: card.number, read: false });
  expect(harness.inspection.sdk.callsTo("threads.markUnread")).toHaveLength(1);
  expect(known.get("mark-unread").lastReadAt).toBe(0);
  expect(cardOf("mark-unread")).toMatchObject({ read_at: null, settled_at: null });
});

test("a later move wins over a pending native read", async () => {
  const { db, mirror, rpc, cardOf, harness } = await start();
  const card = await mirror(thr("mark-race"));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  const gate = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.markRead", () => { asked = true; return gate.promise; });
  const pending = rpc("setTaskRead", { number: card.number, read: true });
  await until(() => asked);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  gate.resolve(thr("mark-race"));
  expect(await pending).toMatchObject({ stageId: "stage-attention", readAt: null, settledAt: null });
  expect(cardOf("mark-race")).toMatchObject({ stage_id: "stage-attention", read_at: null, settled_at: null });
});

test("a later move wins over a pending reopen", async () => {
  const { db, mirror, rpc, harness } = await start();
  const card = await mirror(thr("reopen-race"));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 10, settled_at = 10 WHERE id = ?").run(card.id);
  const gate = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.markUnread", () => { asked = true; return gate.promise; });
  const pending = rpc("setTaskSettled", { number: card.number, settled: false });
  await until(() => asked);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  gate.resolve(thr("reopen-race"));
  expect(await pending).toMatchObject({ stageId: "stage-attention", readAt: 10, settledAt: 10 });
});

test("reading a working, review, or custom card leaves it visible", async () => {
  const { db, mirror, rpc, cardOf, harness } = await start();
  const custom = await rpc("createStage", { name: "Custom" });
  for (const stage of ["stage-progress", "stage-attention", custom.id]) {
    const card = await mirror(thr(`role-${stage}`, { status: "active" }));
    db.prepare("UPDATE triage_tasks SET stage_id = ?, run_state = 'completed' WHERE id = ?").run(stage, card.id);
    await rpc("setTaskRead", { number: card.number, read: true });
    expect(cardOf(`role-${stage}`)).toMatchObject({ stage_id: stage, read_at: expect.any(Number), settled_at: null });
  }
  expect(harness.inspection.sdk.callsTo("threads.markRead")).toHaveLength(0);
});

test("a stale native snapshot cannot undo a later move", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("snapshot-race", { latestAttentionAt: 100, lastReadAt: 101 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = NULL, settled_at = NULL WHERE id = ?").run(card.id);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.list = () => { asked = true; return gate.promise; };
  const pending = rpc("snapshot");
  await until(() => asked);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  gate.resolve([thread]);
  const snapshot = await pending;
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-attention", read_at: null, settled_at: null });
  expect(snapshot.tasks.find((task: any) => task.number === card.number).stageId).toBe("stage-attention");
});

test("a read event invalidates native metadata captured by an in-flight snapshot", async () => {
  const { db, mirror, rpc, cardOf, ctx, known } = await start();
  const thread = thr("stale-native", { latestAttentionAt: 100, lastReadAt: 101 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = NULL, settled_at = NULL WHERE id = ?").run(card.id);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.list = () => { asked = true; return gate.promise; };
  const pending = rpc("snapshot");
  await until(() => asked);
  known.set(thread.id, { ...thread, lastReadAt: 0 });
  ctx.readChanged({ id: thread.id, changes: ["read-state-changed"] });
  gate.resolve([thread]);
  await pending;
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
});

test.each(["read", "settle", "failure", "activity"])("a stale snapshot preserves later %s", async (action) => {
  const { db, mirror, rpc, cardOf, ctx, known, emitNative } = await start();
  const thread = thr(`stale-${action}`, { latestAttentionAt: 100, lastReadAt: 101 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.list = (args) => { if (!asked) { asked = true; return gate.promise; } return args.archived ? [] : [...known.values()]; };
  const pending = rpc("snapshot");
  await until(() => asked);
  if (action === "read") await rpc("setTaskRead", { number: card.number, read: true });
  else if (action === "settle") await rpc("setTaskSettled", { number: card.number, settled: true });
  else if (action === "failure") await emitNative("thread.failed", { thread: thr(thread.id, { status: "error" }), error: "failed" });
  else await emitNative("thread.active", { thread: thr(thread.id, { status: "active" }) });
  if (action === "failure" || action === "activity") {
    await until(() => cardOf(thread.id).run_state === (action === "failure" ? "failed" : "working"));
    expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-progress", run_state: action === "failure" ? "failed" : "working" });
  }
  const later = { ...cardOf(thread.id) };
  gate.resolve([thread]);
  const result = await pending;
  expect(cardOf(thread.id)).toStrictEqual(later);
  expect(result.tasks.find((task: any) => task.number === card.number)).toMatchObject({ stageId: later.stage_id, runState: later.run_state, readAt: later.read_at, settledAt: later.settled_at });
});

test("a failed native snapshot lookup does not acknowledge a card", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const card = await mirror(thr("lookup-failed"));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  ctx.list = () => { throw new Error("lookup failed"); };
  await expect(rpc("snapshot")).rejects.toThrow("lookup failed");
  expect(cardOf("lookup-failed")).toMatchObject({ read_at: null, settled_at: null });
});

test("an explicitly settled unread card stays settled on an unchanged native snapshot", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("manual-settle", { latestAttentionAt: 100, lastReadAt: 0 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: expect.any(Number) });
});

test.each([0, null])("native unread timestamp %s does not reverse a later manual settlement", async (lastReadAt) => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("manual-after-read", { latestAttentionAt: 100, lastReadAt });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 101, settled_at = 102 WHERE id = ?").run(card.id);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: 101, settled_at: expect.any(Number) });
});

test("snapshot settles a completed card with an existing read marker", async () => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const thread = thr("read-marker-only", { latestAttentionAt: 100, lastReadAt: 101 });
  const card = await mirror(thread);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 101 WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: 101, settled_at: expect.any(Number) });
});

test.each(["archivedAt", "deletedAt"])("snapshot leaves a %s completed card unchanged", async (field) => {
  const { db, mirror, rpc, cardOf, ctx } = await start();
  const card = await mirror(thr(`hidden-${field}`));
  const thread = thr(`hidden-${field}`, { [field]: 1, latestAttentionAt: 100, lastReadAt: 101 });
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed' WHERE id = ?").run(card.id);
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ read_at: null, settled_at: null });
});

test("a deleted card stays absent when a snapshot completes", async () => {
  const { mirror, rpc, ctx } = await start();
  const thread = thr("snapshot-deleted");
  const card = await mirror(thread);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.list = () => { asked = true; return gate.promise; };
  const pending = rpc("snapshot");
  await until(() => asked);
  await rpc("deleteTask", { number: card.number });
  gate.resolve([thread]);
  expect((await pending).tasks).toStrictEqual([]);
});

test("completion and reconciliation settle an already read reply", async () => {
  const context = await startQuiet();
  const { db, mirror, emit, cardOf, ctx, known, rpc } = context;
  const first = await mirror(thr("read-at-idle", { status: "active" }));
  const idle = thr("read-at-idle", { status: "idle", latestAttentionAt: 100, lastReadAt: 0 });
  known.set(idle.id, idle);
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.running = () => { asked = true; return gate.promise; };
  const completion = emit("thread.idle", { thread: idle });
  await until(() => asked);
  known.set(idle.id, thr(idle.id, { status: "idle", latestAttentionAt: 100, lastReadAt: 101 }));
  gate.resolve([]);
  await completion;
  ctx.running = () => [];
  expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-progress", read_at: null, settled_at: null });
  ctx.list = () => [known.get(idle.id)];
  await rpc("snapshot");
  expect(cardOf(idle.id)).toMatchObject({ stage_id: "stage-completed", read_at: 101, settled_at: expect.any(Number) });
  const second = await mirror(thr("read-at-reconcile", { status: "active" }));
  const missed = thr("read-at-reconcile", { status: "idle", latestAttentionAt: 200, lastReadAt: 201 });
  known.set(missed.id, missed);
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id IN (?, ?)").run(first.id, second.id);
  ctx.list = worldOf([known.get(idle.id), missed]).handler;
  await rerun(context, 1);
  expect(cardOf(missed.id)).toMatchObject({ stage_id: "stage-completed", read_at: 201, settled_at: expect.any(Number) });
});

test("a newer native reply prevents stale completion", async () => {
  const { mirror, known, emit, cardOf } = await startQuiet();
  await mirror(thr("newer-native", { status: "active" }));
  known.set("newer-native", thr("newer-native", { status: "active", latestAttentionAt: 200, lastReadAt: 100 }));
  await emit("thread.idle", { thread: thr("newer-native", { status: "idle", latestAttentionAt: 100, lastReadAt: 100 }) });
  expect(cardOf("newer-native")).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("a failed native lookup cannot acknowledge a completed reply", async () => {
  const { mirror, harness, emit, cardOf } = await startQuiet();
  await mirror(thr("idle-lookup-fails", { status: "active" }));
  harness.inspection.sdk.stub("threads.get", async () => { throw new Error("lookup failed"); });
  await emit("thread.idle", { thread: thr("idle-lookup-fails", { status: "idle", latestAttentionAt: 100, lastReadAt: 101 }) });
  expect(cardOf("idle-lookup-fails")).toMatchObject({ stage_id: "stage-progress", read_at: null, settled_at: null });
});

test("settling a running thread leaves it open for completion", async () => {
  const { mirror, rpc, emitNative: emit, cardOf } = await startQuiet();
  const card = await mirror(thr("prior-settlement", { status: "active" }));
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const settledAt = cardOf("prior-settlement").settled_at;
  await emit("thread.idle", { thread: thr("prior-settlement", { status: "idle" }) });
  expect(settledAt).toBeNull();
  expect(cardOf("prior-settlement")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
});

test("completion retains a legacy settlement on a running card", async () => {
  const { mirror, emitNative: emit, cardOf, db } = await startQuiet();
  const card = await mirror(thr("legacy-prior-settlement", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET settled_at = 42 WHERE id = ?").run(card.id);
  await emit("thread.idle", { thread: thr("legacy-prior-settlement", { status: "idle" }) });
  expect(cardOf("legacy-prior-settlement")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: 42 });
});

test("completion leaves a concurrent Human Review read intact", async () => {
  const { mirror, rpc, emit, cardOf, ctx } = await startQuiet();
  const card = await mirror(thr("review-read-race", { status: "active" }));
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.running = () => { asked = true; return gate.promise; };
  const idle = emit("thread.idle", { thread: thr("review-read-race", { status: "idle" }) });
  await until(() => asked);
  await rpc("setTaskRead", { number: card.number, read: true });
  const current = { ...cardOf("review-read-race") };
  gate.resolve([]);
  await idle;
  expect(cardOf("review-read-race")).toStrictEqual(current);
});

test("an older native read does not dismiss a new reply", async () => {
  const { db, mirror, rpc, cardOf, ctx, emit, known } = await start();
  const thread = thr("new-reply", { status: "idle", latestAttentionAt: 200, lastReadAt: 100 });
  const card = await mirror(thr(thread.id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', read_at = 100, settled_at = 100 WHERE id = ?").run(card.id);
  await emit("thread.active", { thread: thr(thread.id, { status: "active" }) });
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  known.set(thread.id, thread);
  await emit("thread.idle", { thread });
  ctx.list = () => [thread];
  await rpc("snapshot");
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", read_at: null, settled_at: null });
  expect(db.prepare("SELECT 1 FROM triage_tasks WHERE id = ?").get(card.id)).toBeTruthy();
});

test("the origin column defaults to manual and createTask writes manual cards", async () => {
  const { db, rpc } = await start();
  const columns = db.prepare("PRAGMA table_info(triage_tasks)").all() as any[];
  expect(columns.find((column) => column.name === "origin")).toMatchObject({ notnull: 1, dflt_value: "'manual'" });
  const task = await rpc("createTask", {
    title: "Composer task", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: false,
    request: {
      projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
      permissionMode: "auto", executionInputSources: {},
      environment: { type: "reuse", environmentId: "environment-1" },
      input: [{ type: "text", text: "Do work" }],
    },
  });
  expect((db.prepare("SELECT origin FROM triage_tasks WHERE number = ?").get(task.number) as any).origin).toBe("manual");
});

test("thread.created mirrors the session as a view-only card and never writes to the sidebar", async () => {
  const { harness, cardOf, eventsOf, notifications, mirror } = await start();
  const card = await mirror(thr("s1", { title: "Hello", environmentId: "env-1", providerId: "claude-code", status: "idle" }));
  expect(card).toMatchObject({
    origin: "mirror", title: "Hello", project_id: "project-1", project_name: "Project project-1",
    machine_id: "host-env-1", machine_name: "Host host-env-1", provider_id: "claude-code",
    model: "Default model", run_state: "completed", stage_id: "stage-completed", settled_at: null, request_json: "null",
  });
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }, { actor: "bb", event: "turn completed" }]);
  expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
  expect(notifications()).toStrictEqual([]);
  // A repeated announcement converges on the same card.
  await harness.behavior.emitThreadEvent("thread.created", { thread: thr("s1") });
  await flush();
  expect(cardOf("s1").number).toBe(card.number);
});

test("an active or starting session mirrors into In Progress as working", async () => {
  const { mirror } = await start();
  for (const status of ["active", "starting"] as const) {
    const card = await mirror(thr(`live-${status}`, { status }));
    expect(card).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  }
  const failed = await mirror(thr("broke", { status: "error", titleFallback: "Fallback", title: null }));
  expect(failed).toMatchObject({ run_state: "failed", title: "Fallback" });
  const untitled = await mirror(thr("plain", { title: null }));
  expect(untitled.title).toBe("Untitled session");
});

test("thread.created ignores sessions Triage spawned itself", async () => {
  const { cards, emit } = await start();
  await emit("thread.created", { thread: thr("dispatched", { originPluginId: "triage" }) });
  await flush();
  expect(cards()).toStrictEqual([]);
});

test("with automatic carding off, new sessions are not mirrored", async () => {
  const { harness, cards, emit } = await start();
  await harness.behavior.setSettings({ autoCardThreads: false });
  await emit("thread.created", { thread: thr("quiet") });
  await flush();
  expect(cards()).toStrictEqual([]);
});

test("deleted and archived sessions get no card", async () => {
  const { cards, emit } = await start();
  await emit("thread.created", { thread: thr("archived", { archivedAt: 5 }) });
  await emit("thread.created", { thread: thr("deleted", { deletedAt: 5 }) });
  await flush();
  expect(cards()).toStrictEqual([]);
});

test("a failure while carding a new session is logged, not thrown", async () => {
  const { harness, db, cards, emit } = await start();
  db.prepare("DELETE FROM triage_stages WHERE system_role = 'intake'").run();
  const result = await emit("thread.created", { thread: thr("unlucky") });
  await flush();
  expect(result.errors).toStrictEqual([]);
  expect(cards()).toStrictEqual([]);
  expect(harness.logEntries.some((entry: any) =>
    entry.level === "warn" && entry.message.includes("could not card session unlucky"))).toBe(true);
});

test("a dispatch whose thread was already mirrored adopts it: one manual card, the mirror card gone with its events", async () => {
  const context = await start();
  const { harness, db, cardOf, cards, eventsOf, emit, rpc } = context;
  let mirrorId = "";
  // Race: the host announces the spawned thread (with no plugin attribution,
  // as an older host would) and the mirror card lands before the dispatch
  // links its own card to the thread id.
  harness.inspection.sdk.stub("threads.spawn", async () => {
    await emit("thread.created", { thread: thr("spawned-1") });
    await until(() => cardOf("spawned-1") !== undefined);
    mirrorId = cardOf("spawned-1").id;
    expect(cardOf("spawned-1").origin).toBe("mirror");
    return thr("spawned-1");
  });
  const task = await rpc("createTask", {
    title: "Composer task", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: true,
    request: {
      projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
      permissionMode: "auto", executionInputSources: {},
      environment: { type: "reuse", environmentId: "environment-1" },
      input: [{ type: "text", text: "Do work" }],
    },
  });
  expect(task).toMatchObject({ threadId: "spawned-1", runState: "starting" });
  expect(cards().length).toBe(1);
  expect(cardOf("spawned-1")).toMatchObject({ number: task.number, origin: "manual" });
  expect(db.prepare("SELECT COUNT(*) AS count FROM triage_tasks WHERE id = ?").get(mirrorId)).toStrictEqual({ count: 0 });
  expect(eventsOf(mirrorId)).toStrictEqual([]);
});

test("a normal dispatch leaves exactly one manual card for its session", async () => {
  const { cards, emit, rpc, cardOf } = await start();
  const task = await rpc("createTask", {
    title: "Composer task", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: true,
    request: {
      projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
      permissionMode: "auto", executionInputSources: {},
      environment: { type: "reuse", environmentId: "environment-1" },
      input: [{ type: "text", text: "Do work" }],
    },
  });
  // The announcement for Triage's own spawn is ignored.
  await emit("thread.created", { thread: thr("spawned-1", { originPluginId: "triage" }) });
  await flush();
  expect(cards().length).toBe(1);
  expect(cardOf("spawned-1")).toMatchObject({ number: task.number, origin: "manual" });
});

test("the backfill cards every session oldest-first, settles dormant history, and caches lookups", async () => {
  // 300 sessions come back as 150 + 150 + an empty page, newest page first and
  // shuffled inside each page, because threads.list has no sort parameter.
  const all = Array.from({ length: 300 }, (_, index) => {
    const createdAt = index + 1;
    const status = createdAt % 50 === 0 ? "error" : createdAt === 7 ? "active" : createdAt === 8 ? "starting" : createdAt === 9 ? "pending" : "idle";
    return thr(`t-${createdAt}`, { createdAt, status, projectId: `project-${createdAt % 3}`, environmentId: `env-${createdAt % 4}` });
  });
  const pageA = all.slice(150).reverse();
  const pageB = all.slice(0, 150).reverse();
  const { harness, ctx, db, cards, cardOf, eventsOf, importManual } = await start();
  const existing = await importManual(all[4]!);
  const before = { card: { ...cardOf("t-5") }, events: eventsOf(cardOf("t-5").id) };
  const lookupsBefore = {
    projects: harness.inspection.sdk.callsTo("projects.get").length,
    environments: harness.inspection.sdk.callsTo("environments.get").length,
    hosts: harness.inspection.sdk.callsTo("hosts.get").length,
  };
  const listCallsBefore = harness.inspection.sdk.callsTo("threads.list").length;
  ctx.list = (args) => (args.offset === 0 ? pageA : args.offset === 150 ? pageB : []);
  // Switching the knob off and on again re-runs the pass.
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cards().length === 300);
  expect(existing.number).toBe(1);
  // Every list call asks for the unarchived half and includes hidden sessions
  // (SDK ThreadListArgs: includeHidden is required or plugin-spawned workers are
  // left out; archived:false selects the unarchived half).
  const calls = (harness.inspection.sdk.callsTo("threads.list").slice(listCallsBefore) as [ListArgs][]).filter(([args]) => !args.threadIds);
  expect(calls.map(([args]) => args.offset)).toStrictEqual([0, 150, 300]);
  for (const [args] of calls) expect(args).toMatchObject({ archived: false, includeHidden: true, limit: 200 });
  // Numbers follow createdAt ascending whatever the page order was; the manual
  // card kept number 1 and was neither duplicated nor mutated.
  const created = cards().filter((card) => card.number !== 1);
  expect(created.map((card) => Number(card.thread_id.slice(2)))).toStrictEqual(
    all.map((_, index) => index + 1).filter((createdAt) => createdAt !== 5),
  );
  expect(cards().filter((card) => card.thread_id === "t-5").length).toBe(1);
  expect(cardOf("t-5")).toStrictEqual(before.card);
  expect(eventsOf(cardOf("t-5").id)).toStrictEqual(before.events);
  // Dormant history starts settled; live sessions stay on the board.
  expect(cardOf("t-1")).toMatchObject({ origin: "mirror", run_state: "idle" });
  expect(cardOf("t-1").settled_at).toBeGreaterThan(0);
  expect(cardOf("t-50")).toMatchObject({ run_state: "failed" });
  expect(cardOf("t-50").settled_at).toBeGreaterThan(0);
  expect(cardOf("t-7")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
  expect(cardOf("t-8")).toMatchObject({ run_state: "working", settled_at: null });
  expect(cardOf("t-9")).toMatchObject({ run_state: "idle", settled_at: null });
  expect(eventsOf(cardOf("t-1").id)).toStrictEqual([{ actor: "bb", event: "backfilled" }]);
  // Three projects, four environments and four hosts: each is looked up once for the pass.
  const lookups = {
    projects: harness.inspection.sdk.callsTo("projects.get").length - lookupsBefore.projects,
    environments: harness.inspection.sdk.callsTo("environments.get").length - lookupsBefore.environments,
    hosts: harness.inspection.sdk.callsTo("hosts.get").length - lookupsBefore.hosts,
  };
  expect(lookups).toStrictEqual({ projects: 3, environments: 4, hosts: 4 });
  expect(db.prepare("SELECT MAX(number) AS max FROM triage_tasks").get()).toStrictEqual({ max: 300 });
});

test("the backfill at plugin start pages until a page adds nothing new", async () => {
  // A host that ignores offset keeps answering with the same rows; the pass ends anyway.
  // Both sessions share a createdAt, so the id breaks the tie deterministically.
  const same = [thr("loop-2", { createdAt: 1 }), thr("loop-1", { createdAt: 1 })];
  const { harness, cards } = await start({ list: () => same });
  await until(() => cards().length === 2);
  await flush();
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBe(2);
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["loop-1", "loop-2"]);
});

test("with automatic carding off at plugin start nothing is listed until it is switched on", async () => {
  const { harness, ctx, cards } = await start({ settings: { autoCardThreads: false } });
  ctx.list = (args) => (args.offset === 0 ? [thr("late", { createdAt: 1 })] : []);
  await flush();
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBe(0);
  expect(cards()).toStrictEqual([]);
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cards().length === 1);
  expect(cards()[0].origin).toBe("mirror");
});

test("a rejected page aborts the pass: nothing is carded, later pages are not fetched, and it warns", async () => {
  let calls = 0;
  const { harness, cards } = await start({
    list: (args) => {
      calls += 1;
      if (args.offset === 0) return [thr("p1-a", { createdAt: 1 }), thr("p1-b", { createdAt: 2 })];
      if (args.offset === 2) throw new Error("Host busy");
      return [thr("p3-a", { createdAt: 3 })];
    },
  });
  await until(() => harness.logEntries.some((entry: any) => entry.level === "warn" && entry.message.includes("Host busy")));
  await flush();
  expect(calls).toBe(2);
  expect(cards()).toStrictEqual([]);
  // A later switch-on can retry: the in-flight guard was released.
  const retried = harness.inspection.sdk.callsTo("threads.list").length;
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length > retried);
});

test("a session whose project cannot be read still gets a card named by its project id", async () => {
  const { harness, ctx, cardOf } = await start();
  harness.inspection.sdk.stub("projects.get", async () => { throw new Error("Project removed"); });
  ctx.list = (args) => (args.offset === 0 ? [thr("orphan", { projectId: "project-gone", createdAt: 1 })] : []);
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cardOf("orphan") !== undefined);
  expect(cardOf("orphan")).toMatchObject({ project_id: "project-gone", project_name: "project-gone" });
});

test("a session that fails to card is logged and skipped while the rest are carded", async () => {
  const sessions = [thr("bad", { createdAt: 1, status: "idle" }), thr("good", { createdAt: 2, status: "active" })];
  const { harness, ctx, db, cardOf, cards } = await start();
  // With the intake stage missing the idle session fails to card; the active one lands.
  db.prepare("DELETE FROM triage_stages WHERE system_role = 'intake'").run();
  ctx.list = (args) => (args.offset === 0 ? sessions : []);
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cardOf("good") !== undefined);
  expect(cardOf("bad")).toBeUndefined();
  expect(cards().length).toBe(1);
  expect(harness.logEntries.some((entry: any) =>
    entry.level === "warn" && entry.message.includes("could not card session bad"))).toBe(true);
});

test("switching the knob off mid-pass stops the pass, and switching it back on finishes the job", async () => {
  const sessions = Array.from({ length: 6 }, (_, index) => thr(`m-${index + 1}`, { createdAt: index + 1, projectId: `project-${index + 1}` }));
  const { harness, ctx, cards } = await start();
  const callsBefore = harness.inspection.sdk.callsTo("threads.list").length;
  // Off while the second page is still being fetched: that page completes, the
  // next check sees the knob off, and nothing is carded.
  ctx.list = async (args: ListArgs) => {
    if (args.offset === 0) return sessions.slice(0, 3);
    await harness.behavior.setSettings({ autoCardThreads: false });
    return sessions.slice(3);
  };
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length === callsBefore + 2);
  await flush();
  expect(cards()).toStrictEqual([]);
  // Off while a card is being created: the stale creation is discarded.
  let lookups = 0;
  harness.inspection.sdk.stub("projects.get", async (args: { projectId: string }) => {
    lookups += 1;
    if (lookups === 3) await harness.behavior.setSettings({ autoCardThreads: false });
    return { id: args.projectId, name: args.projectId };
  });
  ctx.list = (args) => (args.offset === 0 ? sessions : []);
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => lookups === 3);
  await flush();
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["m-1", "m-2"]);
  // On again: the pass resumes and cards only what is still missing.
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cards().length === 6);
});

test("a second pass requested while one is running resumes after the stale pass", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { harness, cards } = await start({
    list: async (args) => {
      if (args.offset === 0) {
        await gate;
        return [thr("g-1", { createdAt: 1 })];
      }
      return [];
    },
  });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length === 1);
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await flush();
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBe(1);
  release();
  await until(() => cards().length === 1);
  await flush();
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThanOrEqual(3);
});

test("thread.archived settles a mirror card and leaves manual cards and unknown sessions alone", async () => {
  const { cardOf, emitNative: emit, mirror, importManual, rpc } = await start();
  await mirror(thr("a-mirror", { status: "active" }));
  expect(cardOf("a-mirror")).toMatchObject({ run_state: "working", settled_at: null });
  await emit("thread.archived", { thread: thr("a-mirror", { archivedAt: 9 }) });
  expect(cardOf("a-mirror")).toMatchObject({ run_state: "idle" });
  expect(cardOf("a-mirror").settled_at).toBeGreaterThan(0);
  const manual = await importManual(thr("a-manual"));
  await rpc("setTaskRead", { number: manual.number, read: true });
  const before = { ...cardOf("a-manual") };
  await emit("thread.archived", { thread: thr("a-manual", { archivedAt: 9 }) });
  expect(cardOf("a-manual")).toStrictEqual(before);
  await emit("thread.archived", { thread: thr("a-nobody", { archivedAt: 9 }) });
  expect(cardOf("a-nobody")).toBeUndefined();
  // An archive of an already idle mirror card keeps its run state.
  await mirror(thr("a-idle", { status: "idle" }));
  await emit("thread.archived", { thread: thr("a-idle", { archivedAt: 9 }) });
  expect(cardOf("a-idle")).toMatchObject({ run_state: "completed" });
  expect(cardOf("a-idle").settled_at).toBeGreaterThan(0);
});

test("thread.unarchived creates a missing mirror card and reopens it only when the session is running", async () => {
  const { harness, cardOf, cards, emitNative: emit, mirror } = await start();
  await emit("thread.unarchived", { thread: thr("u-new", { status: "active" }) });
  expect(cardOf("u-new")).toMatchObject({ origin: "mirror", settled_at: null });
  // With no card yet, an idle or failed session gets one that starts settled.
  await emit("thread.unarchived", { thread: thr("u-dormant", { status: "idle" }) });
  expect(cardOf("u-dormant")).toMatchObject({ origin: "mirror" });
  expect(cardOf("u-dormant").settled_at).toBeGreaterThan(0);
  await emit("thread.unarchived", { thread: thr("u-crashed", { status: "error" }) });
  expect(cardOf("u-crashed")).toMatchObject({ origin: "mirror" });
  expect(cardOf("u-crashed").settled_at).toBeGreaterThan(0);
  await mirror(thr("u-old"));
  await emit("thread.archived", { thread: thr("u-old", { archivedAt: 9 }) });
  expect(cardOf("u-old").settled_at).toBeGreaterThan(0);
  // An idle session that is unarchived stays settled.
  await emit("thread.unarchived", { thread: thr("u-old", { status: "idle" }) });
  expect(cardOf("u-old").settled_at).toBeGreaterThan(0);
  // A failed session stays settled too.
  await emit("thread.unarchived", { thread: thr("u-old", { status: "error" }) });
  expect(cardOf("u-old").settled_at).toBeGreaterThan(0);
  // An active session that is unarchived comes back to the board.
  await emit("thread.unarchived", { thread: thr("u-old", { status: "active" }) });
  expect(cardOf("u-old").settled_at).toBe(null);
  // Sessions Triage spawned itself, and any session while the knob is off, get no new card.
  await emit("thread.unarchived", { thread: thr("u-own", { originPluginId: "triage" }) });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await emit("thread.unarchived", { thread: thr("u-off") });
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["u-new", "u-dormant", "u-crashed", "u-old"]);
  // An existing mirror card still reopens with the knob off, once its session runs.
  await emit("thread.archived", { thread: thr("u-old", { archivedAt: 9 }) });
  await emit("thread.unarchived", { thread: thr("u-old", { status: "starting" }) });
  expect(cardOf("u-old").settled_at).toBe(null);
});

test("thread.unarchived never rewrites a manual card", async () => {
  const { cardOf, emit, importManual, rpc } = await start();
  const manual = await importManual(thr("u-manual"));
  await rpc("setTaskSettled", { number: manual.number, settled: true });
  const before = { ...cardOf("u-manual") };
  await emit("thread.unarchived", { thread: thr("u-manual") });
  expect(cardOf("u-manual")).toStrictEqual(before);
});

test("deleting a session removes its mirror card and history but keeps the manual unlink-and-notify path", async () => {
  const { cards, cardOf, db, eventsOf, notifications, emit, mirror, importManual } = await start();
  const mirrorCard = await mirror(thr("d-mirror"));
  expect(eventsOf(mirrorCard.id).length).toBe(2);
  await emit("thread.deleted", { thread: thr("d-mirror") });
  expect(cardOf("d-mirror")).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS count FROM triage_events WHERE task_id = ?").get(mirrorCard.id)).toStrictEqual({ count: 0 });
  expect(notifications()).toStrictEqual([]);
  const manual = await importManual(thr("d-manual"));
  await emit("thread.deleted", { thread: thr("d-manual") });
  const row = cards().find((card) => card.number === manual.number);
  expect(row).toMatchObject({ origin: "manual", thread_id: null, run_state: "stopped" });
  expect(row.attention_reason).toContain("deleted");
  expect(notifications().map((entry) => entry.title)).toStrictEqual([`Triage #${manual.number} · Lost its thread`]);
});

test("agent configuration has no stage tool for mirror and manual cards", async () => {
  const { harness, mirror, importManual } = await start();
  await mirror(thr("c-mirror"));
  await importManual(thr("c-manual"));
  for (const id of ["c-mirror", "c-manual"]) {
    const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id } }));
    expect(JSON.stringify(config)).not.toContain("triage_move_task");
  }
  expect(harness.inspection.registrations.agentTools.some((entry) => entry.name === "triage_move_task")).toBe(false);
});

test("the sidebar setting sweeps manual cards' sessions only", async () => {
  const { harness, mirror, importManual } = await start();
  await mirror(thr("v-mirror"));
  await importManual(thr("v-manual"));
  const writesBefore = harness.inspection.sdk.callsTo("threads.update").length;
  await harness.behavior.setSettings({ showThreadsInSidebar: true });
  await flush();
  const written = (harness.inspection.sdk.callsTo("threads.update").slice(writesBefore) as [{ threadId: string; visibility: string }][])
    .map(([args]) => [args.threadId, args.visibility]);
  expect(written).toStrictEqual([["v-manual", "visible"]]);
  expect(harness.inspection.sdk.callsTo("threads.update").some(([args]: any) => args.threadId === "v-mirror")).toBe(false);
});

test("finished mirror settles when read", async () => {
  const { cardOf, emitNative: emit, mirror, rpc } = await start();
  const card = await mirror(thr("finished-unread", { status: "active" }));
  await emit("thread.idle", { thread: thr("finished-unread", { status: "idle" }) });
  expect(cardOf("finished-unread")).toMatchObject({
    stage_id: "stage-completed", run_state: "completed", settled_at: null, read_at: null,
  });
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("finished-unread").read_at;
  await emit("thread.idle", { thread: thr("finished-unread", { status: "idle" }) });
  expect(cardOf("finished-unread")).toMatchObject({ read_at: readAt, settled_at: expect.any(Number) });
  const settledAt = cardOf("finished-unread").settled_at;
  expect(settledAt).toBeGreaterThan(0);
  await emit("thread.idle", { thread: thr("finished-unread", { status: "idle" }) });
  expect(cardOf("finished-unread")).toMatchObject({ settled_at: settledAt, read_at: readAt });
});

test("an idle turn completes a mirror card and resets its read marker", async () => {
  const { cardOf, notifications, eventsOf, emitNative: emit, mirror, rpc } = await start();
  const card = await mirror(thr("i-1", { status: "active" }));
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("i-1").read_at;
  expect(readAt).toBeGreaterThan(0);
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", read_at: null, settled_at: null });
  expect(notifications()).toStrictEqual([]);
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }, { actor: "bb", event: "turn completed" }]);
  // A mirror card the user moved to the done stage keeps its completed state.
  await rpc("moveTask", { number: card.number, stageId: "stage-completed" });
  // It stays visible in the done column: the early return does not settle it.
  await rpc("setTaskSettled", { number: card.number, settled: false });
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ run_state: "completed", settled_at: null });
  // A failure remains visible in the active stage.
  await emit("thread.failed", { thread: thr("i-1"), error: "boom" });
  expect(cardOf("i-1")).toMatchObject({ stage_id: "stage-progress", run_state: "failed", settled_at: null });
  expect(notifications()).toStrictEqual([]);
});

test("a completed mirror keeps settlement on repeated idle and reopens on activity", async () => {
  const { db, cardOf, emitNative: emit, mirror } = await start();
  await mirror(thr("r-1", { status: "active" }));
  await emit("thread.active", { thread: thr("r-1") });
  expect(cardOf("r-1")).toMatchObject({ stage_id: "stage-progress", settled_at: null });
  await emit("thread.idle", { thread: thr("r-1"), lastAssistantText: "Done" });
  expect(cardOf("r-1")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  // A second idle event does not change an explicitly set settlement time.
  db.prepare("UPDATE triage_tasks SET settled_at = 41 WHERE thread_id = ?").run("r-1");
  await emit("thread.idle", { thread: thr("r-1"), lastAssistantText: "Done" });
  expect(cardOf("r-1").settled_at).toBe(41);
  await emit("thread.active", { thread: thr("r-1") });
  expect(cardOf("r-1")).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  // A failure on an already settled card keeps the earlier settled time as well.
  db.prepare("UPDATE triage_tasks SET settled_at = 42 WHERE thread_id = ?").run("r-1");
  await emit("thread.failed", { thread: thr("r-1"), error: "boom" });
  expect(cardOf("r-1")).toMatchObject({ run_state: "failed", settled_at: 42 });
});

test("an active turn refreshes a mirror card's title, provider and machine without history or notices", async () => {
  const { harness, cardOf, notifications, eventsOf, emitNative: emit, mirror } = await start();
  const card = await mirror(thr("w-1", { title: null, titleFallback: null, providerId: "codex", environmentId: null }));
  expect(card).toMatchObject({ title: "Untitled session", machine_name: "Project default" });
  await emit("thread.archived", { thread: thr("w-1", { archivedAt: 9 }) });
  expect(cardOf("w-1").settled_at).toBeGreaterThan(0);
  await emit("thread.active", { thread: thr("w-1", { title: "A real title", providerId: "claude-code", environmentId: "env-9" }) });
  expect(cardOf("w-1")).toMatchObject({
    title: "A real title", provider_id: "claude-code", machine_id: "host-env-9", machine_name: "Host host-env-9",
    run_state: "working", stage_id: "stage-progress", settled_at: null,
  });
  // Without a title the fallback applies; without either the stored title stays.
  await emit("thread.active", { thread: thr("w-1", { title: null, titleFallback: "Derived", environmentId: "env-9" }) });
  expect(cardOf("w-1").title).toBe("Derived");
  await emit("thread.active", { thread: thr("w-1", { title: null, titleFallback: null, environmentId: "env-9" }) });
  expect(cardOf("w-1").title).toBe("Derived");
  await emit("thread.active", { thread: thr("w-1", { title: "x".repeat(300), environmentId: "env-9" }) });
  expect(cardOf("w-1").title).toBe("x".repeat(160));
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }, { actor: "bb", event: "turn completed" }]);
  expect(notifications()).toStrictEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
});

test("failure keeps custom placement and clears obsolete system attention", async () => {
  const { db, cardOf, emitNative: emit, mirror, importManual, rpc } = await start();
  const custom = await rpc("createStage", { name: "Holding" });
  for (const [index, stageId] of ["stage-attention", custom.id, "stage-todo", "stage-progress", "stage-completed"].entries()) {
    const id = `failure-stage-${index}`;
    const card = await mirror(thr(id, { status: "active" }));
    await rpc("moveTask", { number: card.number, stageId });
    await rpc("setTaskSettled", { number: card.number, settled: false });
    await emit("thread.failed", { thread: thr(id), error: "Provider crashed" });
    expect(cardOf(id)).toMatchObject({ stage_id: stageId === custom.id ? custom.id : "stage-progress", run_state: "failed", attention_reason: "Provider crashed", settled_at: null });
    const acknowledged = Date.now();
    db.prepare("UPDATE triage_tasks SET settled_at = ? WHERE thread_id = ?").run(acknowledged, id);
    db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run(`failure-ack-${index}`, card.id, acknowledged);
    await emit("thread.failed", { thread: thr(id), error: "Provider crashed" });
    expect(cardOf(id).settled_at).toBe(acknowledged);
  }
  await importManual(thr("failure-manual"));
  await emit("thread.failed", { thread: thr("failure-manual"), error: "Manual failure" });
  expect(cardOf("failure-manual")).toMatchObject({ run_state: "failed", attention_reason: "Manual failure", settled_at: null });
});

test("a failed turn retains a card's stage and history without an attention notice", async () => {
  const { cardOf, notifications, eventsOf, emitNative: emit, mirror } = await start();
  const card = await mirror(thr("f-1", { status: "active" }));
  await emit("thread.failed", { thread: thr("f-1"), error: "  Provider crashed  " });
  expect(cardOf("f-1")).toMatchObject({ stage_id: "stage-progress", run_state: "failed", attention_reason: "Provider crashed" });
  expect(cardOf("f-1").settled_at).toBeNull();
  expect(notifications()).toStrictEqual([]);
  expect(eventsOf(card.id)).toStrictEqual([
    { actor: "bb", event: "mirrored" },
    { actor: "bb", event: "agent failed" },
  ]);
});

test("moving a session to Triage by hand adopts its mirror card as a manual one", async () => {
  const { harness, cardOf, eventsOf, mirror, emit, rpc, known } = await start();
  const card = await mirror(thr("h-1", { status: "idle" }));
  await emit("thread.archived", { thread: thr("h-1", { archivedAt: 9 }) });
  expect(cardOf("h-1").settled_at).toBeGreaterThan(0);
  known.set("h-1", thr("h-1"));
  const task = await rpc("importThread", { threadId: "h-1" });
  expect(task).toMatchObject({ number: card.number, settledAt: null });
  expect(cardOf("h-1")).toMatchObject({ origin: "manual", settled_at: null });
  expect(eventsOf(card.id)).toStrictEqual([
    { actor: "bb", event: "mirrored" },
    { actor: "bb", event: "turn completed" },
    { actor: "user", event: "moved session to triage" },
  ]);
  expect(harness.inspection.sdk.callsTo("threads.update").map(([args]: any) => [args.threadId, args.visibility]))
    .toStrictEqual([["h-1", "hidden"]]);
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "h-1" } }));
  expect(JSON.stringify(config)).not.toContain("triage_move_task");
});

test("a failed snapshot lookup rejects instead of hiding cards from the failed batch", async () => {
  const sessions = Array.from({ length: 250 }, (_, index) =>
    thr(`b-${index + 1}`, { createdAt: index + 1, visibility: "hidden", environmentId: null }));
  const archivedIds = new Set<string>();
  const handler: ListHandler = (args) => {
    if (args.threadIds) {
      // The smaller chunk's live call fails; the other chunk and every
      // companion call must still answer.
      if (!args.archived && args.threadIds.length === 50) {
        throw new Error("Batch failed");
      }
      return sessions
        .filter((session) => args.threadIds!.includes(session.id))
        .filter((session) => archivedIds.has(session.id) === Boolean(args.archived))
        .map((session) => (session.id === "b-7" ? { ...session, visibility: "visible" } : session));
    }
    // Hidden sessions get no card, so the paged backfill sees them as visible.
    const offset = args.offset ?? 0;
    return sessions.slice(offset, offset + 200).map((session) => ({ ...session, visibility: "visible" }));
  };
  const { harness, cards, rpc } = await start({ list: handler });
  await until(() => cards().length === 250);
  await flush();
  harness.inspection.sdk.stub("projects.list", async () => []);
  harness.inspection.sdk.stub("hosts.list", async () => []);
  const before = harness.inspection.sdk.callsTo("threads.list").length;
  const beforeGets = harness.inspection.sdk.callsTo("threads.get").length;
  archivedIds.add("b-7");
  await expect(rpc("snapshot")).rejects.toThrow(/Batch failed/);
  expect(harness.logEntries.some((entry: any) => entry.level === "warn" && entry.message.includes("Batch failed"))).toBe(true);
  // Quirks (SDK ThreadListArgs doc, bundled-types d.ts:18210-18232): at most 200
  // ids per call, so 250 cards need two chunks; archived is a selector, so each
  // chunk gets a companion archived:true call; includeHidden is on every call
  // or hidden sessions vanish.
  const calls = (harness.inspection.sdk.callsTo("threads.list").slice(before) as [ListArgs][]).map(([args]) => args);
  expect(calls.length).toBe(4);
  expect(calls.filter((args) => args.archived === true).length).toBe(2);
  expect(calls.map((args) => args.threadIds!.length).sort((left, right) => left - right)).toStrictEqual([50, 50, 200, 200]);
  for (const args of calls) {
    expect(args.includeHidden).toBe(true);
    expect(args.threadIds!.length).toBeLessThanOrEqual(200);
  }
  expect(harness.inspection.sdk.callsTo("threads.get").length).toBe(beforeGets);
});

test("snapshot omits confirmed archived manual and mirror cards without rewriting their settled state", async () => {
  const archived = new Set<string>();
  const { cardOf, ctx, importManual, mirror, rpc } = await start();
  const manual = await importManual(thr("snapshot-manual"));
  const mirrorCard = await mirror(thr("snapshot-mirror"));
  ctx.list = (args) => (args.threadIds ?? [])
    .filter((threadId) => archived.has(threadId) === Boolean(args.archived))
    .map((threadId) => thr(threadId, { archivedAt: archived.has(threadId) ? 10 : null }));

  await rpc("setTaskSettled", { number: manual.number, settled: true });
  expect((await rpc("snapshot")).tasks.map((task: any) => task.threadId).sort())
    .toStrictEqual(["snapshot-manual", "snapshot-mirror"]);

  // No archive event arrives; the successful refresh alone must hide both cards.
  archived.add("snapshot-manual");
  archived.add("snapshot-mirror");
  expect((await rpc("snapshot")).tasks).toStrictEqual([]);
  expect(cardOf("snapshot-manual").settled_at).toBeGreaterThan(0);
  expect(cardOf("snapshot-mirror").settled_at).toBe(null);

  // A settled manual card retains that state on unarchive; the unsettled mirror reappears.
  archived.delete("snapshot-manual");
  let snapshot = await rpc("snapshot");
  expect(snapshot.tasks).toHaveLength(1);
  expect(snapshot.tasks[0]).toMatchObject({ threadId: "snapshot-manual", settledAt: expect.any(Number) });
  archived.delete("snapshot-mirror");
  snapshot = await rpc("snapshot");
  expect(snapshot.tasks.map((task: any) => task.threadId).sort())
    .toStrictEqual(["snapshot-manual", "snapshot-mirror"]);
  expect(snapshot.tasks.find((task: any) => task.threadId === mirrorCard.thread_id).settledAt).toBe(null);
});

test("a board without sessions asks the host for none", async () => {
  const { harness, rpc } = await start();
  harness.inspection.sdk.stub("projects.list", async () => []);
  harness.inspection.sdk.stub("hosts.list", async () => []);
  const before = harness.inspection.sdk.callsTo("threads.list").length;
  expect((await rpc("snapshot")).tasks).toStrictEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBe(before);
});

test("rapid thread events on a mirror card publish once after the debounce", async () => {
  const { harness, emitNative: emit, mirror } = await start();
  await mirror(thr("r-1", { status: "idle", environmentId: "env-1" }));
  // Let the creation's own debounced publish go out on the real clock first.
  await new Promise((resolve) => setTimeout(resolve, 300));
  vi.useFakeTimers();
  const published = () => harness.realtimeSignals.length;
  const baseline = published();
  await emit("thread.active", { thread: thr("r-1", { environmentId: "env-1" }) });
  await emit("thread.active", { thread: thr("r-1", { environmentId: "env-1" }) });
  expect(published()).toBe(baseline);
  await vi.advanceTimersByTimeAsync(249);
  expect(published()).toBe(baseline);
  await vi.advanceTimersByTimeAsync(1);
  expect(published()).toBe(baseline + 1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(published()).toBe(baseline + 1);
});

test("a pending debounced publish is dropped when the plugin is disposed", async () => {
  const { harness, emit, mirror } = await start();
  await mirror(thr("x-1", { status: "idle" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  vi.useFakeTimers();
  await emit("thread.idle", { thread: thr("x-1"), lastAssistantText: "Done" });
  const published = harness.realtimeSignals.length;
  await harness.lifecycle.dispose();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(harness.realtimeSignals.length).toBe(published);
});

const tombstones = (db: any) =>
  (db.prepare("SELECT thread_id FROM triage_mirror_tombstones ORDER BY thread_id").all() as any[]).map((row) => row.thread_id);

test("deleting a mirror card opts its session out: a later backfill does not recreate it", async () => {
  const { harness, ctx, db, cardOf, cards, mirror, importManual, rpc } = await start();
  const optedOut = await mirror(thr("opt-out", { createdAt: 1 }));
  await rpc("deleteTask", { number: optedOut.number });
  expect(cardOf("opt-out")).toBeUndefined();
  expect(tombstones(db)).toStrictEqual(["opt-out"]);
  // Deleting a manual card is not an opt-out: no tombstone, so it can be mirrored again.
  const manual = await importManual(thr("was-manual", { createdAt: 2 }));
  await rpc("deleteTask", { number: manual.number });
  expect(tombstones(db)).toStrictEqual(["opt-out"]);
  const sessions = [thr("opt-out", { createdAt: 1 }), thr("was-manual", { createdAt: 2 }), thr("control", { createdAt: 3 })];
  ctx.list = (args) => (args.offset === 0 ? sessions : []);
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cardOf("control") !== undefined && cardOf("was-manual") !== undefined);
  await flush();
  expect(cardOf("opt-out")).toBeUndefined();
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["was-manual", "control"]);
});

test("a session deleted in bb leaves no tombstone", async () => {
  const { db, emit, mirror } = await start();
  await mirror(thr("gone"));
  await emit("thread.deleted", { thread: thr("gone") });
  expect(tombstones(db)).toStrictEqual([]);
});

test("created and unarchived events for an opted-out session create nothing", async () => {
  const { db, cards, emit, mirror, rpc } = await start();
  const card = await mirror(thr("opted"));
  await rpc("deleteTask", { number: card.number });
  expect(tombstones(db)).toStrictEqual(["opted"]);
  await emit("thread.created", { thread: thr("opted") });
  await emit("thread.unarchived", { thread: thr("opted") });
  await flush();
  expect(cards()).toStrictEqual([]);
});

test("a manual Move to Triage clears an old opt-out, creates or promotes the manual card, and is not duplicated later", async () => {
  const { harness, ctx, db, cardOf, cards, mirror, importManual, rpc } = await start();
  // Created fresh: the opt-out is cleared and the manual card is made.
  const first = await mirror(thr("fresh", { createdAt: 1 }));
  await rpc("deleteTask", { number: first.number });
  expect(tombstones(db)).toStrictEqual(["fresh"]);
  await importManual(thr("fresh", { createdAt: 1 }));
  expect(tombstones(db)).toStrictEqual([]);
  expect(cardOf("fresh")).toMatchObject({ origin: "manual" });
  // Promoted: a mirror card exists next to a stale opt-out row, and the move clears the row.
  const second = await mirror(thr("stale", { createdAt: 2 }));
  db.prepare("INSERT INTO triage_mirror_tombstones (thread_id, created_at) VALUES ('stale', 1)").run();
  await importManual(thr("stale", { createdAt: 2 }));
  expect(second.number).toBe(cardOf("stale").number);
  expect(cardOf("stale")).toMatchObject({ origin: "manual" });
  expect(tombstones(db)).toStrictEqual([]);
  // A later pass finds both sessions already carded and adds nothing.
  ctx.list = (args) => (args.offset === 0 ? [thr("fresh", { createdAt: 1 }), thr("stale", { createdAt: 2 })] : []);
  const callsBefore = harness.inspection.sdk.callsTo("threads.list").length;
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length >= callsBefore + 2);
  await flush();
  expect(cards().map((card) => [card.thread_id, card.origin])).toStrictEqual([["fresh", "manual"], ["stale", "manual"]]);
});

// --- Stale and sub-thread cards stay out of To-do -------------------------------------------

const eventCount = (db: any, taskId: string) =>
  (db.prepare("SELECT COUNT(*) AS count FROM triage_events WHERE task_id = ?").get(taskId) as any).count as number;

// A host that knows `threads`: by-id lookups answer the half asked for, and a paged list answers the live threads once.
const worldOf = (threads: any[]) => {
  const map = new Map<string, any>(threads.map((thread) => [thread.id, thread]));
  const handler: ListHandler = (args) => {
    const all = [...map.values()];
    if (args.threadIds) {
      return all.filter((thread) => args.threadIds!.includes(thread.id) && (thread.archivedAt !== null) === Boolean(args.archived));
    }
    return (args.offset ?? 0) === 0 ? all.filter((thread) => thread.archivedAt === null) : [];
  };
  return { map, handler };
};

// Run one backfill pass (knob off, then on) and wait until it has made `expectedCalls` list calls and settled.
async function runPass(context: Setup, expectedCalls: number) {
  const { harness } = context;
  // Reconcile only judges cards created before the pass began, so let the clock move on.
  await new Promise((resolve) => setTimeout(resolve, 3));
  const before = harness.inspection.sdk.callsTo("threads.list").length;
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length >= before + expectedCalls);
  await flush();
  await flush();
}

const idLookups = (context: Setup) =>
  (context.harness.inspection.sdk.callsTo("threads.list") as [ListArgs][]).map(([args]) => args).filter((args) => args.threadIds);

// Regression provenance: reported card #3055 was idle and auto-settled despite an unread native reply.
test.each(["failed", "stopped", "queued", "scheduled", "completed"])("backfill reconciles a settled %s card", async (state) => {
  const context = await start();
  const thread = thr(`legacy-${state}`, { status: "idle", latestAttentionAt: Date.now() - 1000, lastReadAt: 0 });
  const card = await context.mirror(thread);
  context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', run_state = ?, settled_at = 42 WHERE id = ?").run(state, card.id);
  context.ctx.list = worldOf([thread]).handler;
  await runPass(context, 2);
  if (state === "failed" || state === "completed") {
    expect(context.cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  } else {
    expect(context.cardOf(thread.id)).toMatchObject({ stage_id: "stage-progress", run_state: state, settled_at: 42 });
  }
});

test("backfill restores the reported unread auto-settled mirror", async () => {
  const context = await start();
  const thread = thr("thr_9bp6k4usyd", {
    status: "idle", latestAttentionAt: 1794822963043, lastReadAt: 1794822909135,
  });
  await context.mirror(thread);
  context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', run_state = 'idle', read_at = NULL, settled_at = ? WHERE thread_id = ?")
    .run(1794822963075, thread.id);
  context.ctx.list = worldOf([thread]).handler;
  await runPass(context, 2);
  expect(context.cardOf(thread.id)).toMatchObject({
    stage_id: "stage-completed", run_state: "completed", read_at: null, settled_at: null,
  });
  await context.rpc("setTaskSettled", { number: context.cardOf(thread.id).number, settled: true });
  await runPass(context, 2);
  expect(context.cardOf(thread.id).settled_at).not.toBeNull();
});

test.each([-1, 0, 1])("legacy restoration respects Triage read time relative to reply: %s", async (offset) => {
  const context = await start();
  const attention = Date.now() - 1000;
  const thread = thr(`legacy-read-${offset}`, { status: "idle", latestAttentionAt: attention, lastReadAt: 0 });
  const card = await context.mirror(thread);
  context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', settled_at = 42, read_at = ? WHERE id = ?").run(attention + offset, card.id);
  context.ctx.list = worldOf([thread]).handler;
  await runPass(context, 2);
  if (offset < 0) expect(context.cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null, read_at: null });
  else expect(context.cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: 42, read_at: attention + offset });
});

test("backfill protects acknowledged and ineligible legacy cards", async () => {
  const context = await start();
  const attention = Date.now() - 1000;
  const ids = ["legacy-settled", "legacy-read", "legacy-custom", "legacy-attention", "legacy-hidden", "legacy-child", "legacy-archived", "legacy-deleted", "legacy-optout", "legacy-moved", "legacy-old-action", "legacy-reopened"];
  for (const id of ids) {
    const card = await context.mirror(thr(id, { status: "idle" }));
    context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', settled_at = 42 WHERE id = ?").run(card.id);
  }
  await context.rpc("setTaskSettled", { number: context.cardOf("legacy-settled").number, settled: true });
  await context.rpc("moveTask", { number: context.cardOf("legacy-moved").number, stageId: "stage-progress" });
  const reopened = context.cardOf("legacy-reopened");
  context.db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?), (?, ?, 'user', 'reopened', ?)")
    .run("legacy-settle-event", reopened.id, Date.now(), "legacy-reopen-event", reopened.id, Date.now());
  context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-attention' WHERE thread_id = 'legacy-attention'").run();
  const stage = await context.rpc("createStage", { name: "Holding" });
  context.db.prepare("UPDATE triage_tasks SET stage_id = ? WHERE thread_id = 'legacy-custom'").run(stage.id);
  context.db.prepare("INSERT INTO triage_mirror_tombstones (thread_id, created_at) VALUES ('legacy-optout', 1)").run();
  const old = context.cardOf("legacy-old-action");
  context.db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run("old-event", old.id, attention - 1);
  const threads = ids.map((id) => thr(id, {
    status: "idle", latestAttentionAt: attention, lastReadAt: id === "legacy-read" ? attention : 0,
    visibility: id === "legacy-hidden" ? "hidden" : "visible",
    parentThreadId: id === "legacy-child" ? "parent" : null,
    archivedAt: id === "legacy-archived" ? 1 : null,
    deletedAt: id === "legacy-deleted" ? 1 : null,
  }));
  for (const thread of threads) context.known.set(thread.id, thread);
  context.ctx.list = worldOf(threads).handler;
  await runPass(context, 2);
  for (const id of ["legacy-settled", "legacy-read", "legacy-hidden", "legacy-child", "legacy-archived", "legacy-deleted", "legacy-optout"]) {
    expect(context.cardOf(id).settled_at, id).not.toBeNull();
  }
  expect(context.cardOf("legacy-custom")).toMatchObject({ stage_id: stage.id, run_state: "completed", settled_at: null });
  for (const id of ["legacy-attention", "legacy-moved"]) {
    expect(context.cardOf(id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  }
  expect(context.cardOf("legacy-old-action")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  expect(context.cardOf("legacy-reopened")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
});

test("backfill does not overwrite a read or movement during liveness lookup", async () => {
  const context = await start();
  const attention = Date.now() - 1000;
  const threads = ["restore-race-settle", "restore-race-move"].map((id) => thr(id, { status: "idle", latestAttentionAt: attention, lastReadAt: 0 }));
  for (const thread of threads) {
    const card = await context.mirror(thread);
    context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-progress', settled_at = 42 WHERE id = ?").run(card.id);
  }
  context.ctx.list = worldOf(threads).handler;
  const gate = deferred<unknown[]>();
  let asked = false;
  context.ctx.running = () => { asked = true; return gate.promise; };
  await context.harness.behavior.setSettings({ autoCardThreads: false });
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => asked);
  await context.rpc("setTaskRead", { number: context.cardOf(threads[0].id).number, read: true });
  await context.rpc("moveTask", { number: context.cardOf(threads[1].id).number, stageId: "stage-attention" });
  gate.resolve([]);
  await flush();
  await flush();
  expect(context.cardOf(threads[0].id)).toMatchObject({ settled_at: 42, read_at: expect.any(Number) });
  expect(context.cardOf(threads[1].id)).toMatchObject({ stage_id: "stage-attention", settled_at: 42 });
});

// A project lookup that blocks until released, so a card creation stays in flight.
function gateProjects(context: Setup) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  context.harness.inspection.sdk.stub("projects.get", async (args: { projectId: string }) => {
    await gate;
    return { id: args.projectId, name: `Project ${args.projectId}` };
  });
  return release;
}

test("configuration waits for a linked row without waiting for pending creation", async () => {
  const context = await start();
  const { harness, emit, cardOf } = context;
  const release = gateProjects(context);
  const config = () => harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { id: "config-pending" } }),
  );
  expect(await config()).toMatchObject({ tools: [], instructions: null });
  await emit("thread.created", { thread: thr("config-pending") });
  expect(await config()).toMatchObject({ tools: [], instructions: null });
  release();
  await until(() => cardOf("config-pending") !== undefined);
  expect(JSON.stringify(await config())).not.toContain("triage_move_task");
  expect(harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
});

test("configuration excludes unlinked disabled, tombstoned and child threads", async () => {
  const { harness, db, emit } = await start();
  db.prepare("INSERT INTO triage_mirror_tombstones (thread_id, created_at) VALUES ('config-tomb', 1)").run();
  await emit("thread.created", { thread: thr("config-tomb") });
  await emit("thread.created", { thread: thr("config-child", { parentThreadId: "root", visibility: "hidden" }) });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await emit("thread.created", { thread: thr("config-disabled") });
  for (const id of ["config-tomb", "config-child", "config-disabled"]) {
    expect(await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id } }),
    )).toMatchObject({ tools: [], instructions: null });
  }
});

test("a mirrored session completes and resumes from native state", async () => {
  const { mirror, emit, cardOf, known } = await start();
  const thread = thr("agent-complete", { status: "active" });
  await mirror(thread);
  const idle = thr(thread.id, { status: "idle" });
  known.set(thread.id, idle);
  await emit("thread.idle", { thread: idle });
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  known.set(thread.id, thread);
  await emit("thread.active", { thread });
  expect(cardOf(thread.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("a failure that arrives while the card is still being created marks it failed", async () => {
  const context = await start();
  const { cardOf, emitNative: emit } = context;
  const release = gateProjects(context);
  await emit("thread.created", { thread: thr("race-failed", { status: "pending" }) });
  const failing = emit("thread.failed", { thread: thr("race-failed"), error: "boom" });
  await flush();
  expect(cardOf("race-failed")).toBeUndefined();
  release();
  await failing;
  expect(cardOf("race-failed")).toMatchObject({ origin: "mirror", run_state: "failed", attention_reason: "boom" });
  expect(cardOf("race-failed").settled_at).toBeNull();
});

test("a deletion that arrives while the card is still being created leaves no card", async () => {
  const context = await start();
  const { cardOf, cards, emitNative: emit } = context;
  const release = gateProjects(context);
  await emit("thread.created", { thread: thr("race-deleted", { status: "pending" }) });
  const deleting = emit("thread.deleted", { thread: thr("race-deleted") });
  await flush();
  release();
  await deleting;
  await flush();
  expect(cardOf("race-deleted")).toBeUndefined();
  expect(cards()).toStrictEqual([]);
});

test("active, idle, archived and unarchived events wait for the card creation in flight, then apply", async () => {
  const context = await start();
  const { cardOf, cards, emitNative: emit } = context;
  const cases = [
    { event: "thread.active", extra: {}, check: (card: any) => expect(card).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null }) },
    { event: "thread.idle", extra: { lastAssistantText: "Done" }, check: (card: any) => expect(card).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null }) },
    { event: "thread.archived", extra: {}, check: (card: any) => expect(card.settled_at).toBeGreaterThan(0) },
    { event: "thread.unarchived", extra: {}, check: (card: any) => expect(card.origin).toBe("mirror") },
  ];
  for (const { event, extra, check } of cases) {
    const id = `wait-${event}`;
    const release = gateProjects(context);
    await emit("thread.created", { thread: thr(id, { status: "pending" }) });
    const later = emit(event, { thread: thr(id, { status: "pending" }), ...extra });
    await flush();
    expect(cardOf(id)).toBeUndefined();
    release();
    await later;
    check(cardOf(id));
    expect(cards().filter((card) => card.thread_id === id).length).toBe(1);
  }
});

test("a second creation announcement keeps later events waiting until the newer creation ends", async () => {
  const { harness, cardOf, emitNative: emit } = await start();
  const releases: (() => void)[] = [];
  harness.inspection.sdk.stub("projects.get", async (args: { projectId: string }) => {
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return { id: args.projectId, name: args.projectId };
  });
  await emit("thread.created", { thread: thr("twice", { status: "pending" }) });
  await until(() => releases.length === 1);
  await emit("thread.created", { thread: thr("twice", { status: "pending" }) });
  await until(() => releases.length === 2);
  const failing = emit("thread.failed", { thread: thr("twice"), error: "boom" });
  // The first creation ends and writes the card; the newer one is still in flight.
  releases[0]!();
  await until(() => cardOf("twice") !== undefined);
  await flush();
  expect(cardOf("twice").run_state).toBe("idle");
  releases[1]!();
  await failing;
  expect(cardOf("twice")).toMatchObject({ run_state: "failed", attention_reason: "boom" });
});

test("a failed unarchive creation still rejects its own handler, and later events do not wait on it", async () => {
  const { db, cardOf, emit } = await start();
  db.prepare("DELETE FROM triage_stages WHERE system_role = 'intake'").run();
  const result = await emit("thread.unarchived", { thread: thr("ua-fail") });
  expect(result.errors.length).toBe(1);
  expect(cardOf("ua-fail")).toBeUndefined();
  expect((await emit("thread.idle", { thread: thr("ua-fail") })).errors).toStrictEqual([]);
});

test("events for a thread with no creation in flight reconcile native state", async () => {
  const { cardOf, emitNative: emit, mirror } = await start();
  await mirror(thr("sync-1", { status: "active" }));
  await flush();
  // A top-level idle asks which threads still run, then completes after that lookup.
  await emit("thread.idle", { thread: thr("sync-1"), lastAssistantText: "Done" });
  expect(cardOf("sync-1")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  await emit("thread.failed", { thread: thr("sync-1"), error: "late" });
  expect(cardOf("sync-1")).toMatchObject({ run_state: "failed", attention_reason: "late" });
});

test("child and hidden threads get no card from thread.created or thread.unarchived, and the backfill skips them", async () => {
  const context = await start();
  const { cards, emit, ctx, harness } = context;
  await emit("thread.created", { thread: thr("kid", { parentThreadId: "parent-1" }) });
  await emit("thread.created", { thread: thr("worker", { visibility: "hidden" }) });
  await emit("thread.unarchived", { thread: thr("kid", { parentThreadId: "parent-1" }) });
  await emit("thread.unarchived", { thread: thr("worker", { visibility: "hidden" }) });
  await flush();
  expect(cards()).toStrictEqual([]);
  const { handler } = worldOf([
    thr("kid", { createdAt: 1, parentThreadId: "parent-1" }),
    thr("worker", { createdAt: 2, visibility: "hidden" }),
    thr("top", { createdAt: 3 }),
  ]);
  ctx.list = handler;
  await runPass(context, 2);
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["top"]);
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBeGreaterThan(0);
});

test("reconcile repairs open intake cards: a confirmed-deleted thread loses its card, others follow their thread's state", async () => {
  const context = await start();
  const { db, cardOf, cards, eventsOf, harness, known, mirror } = context;
  const ids = ["rc-gone", "rc-softdeleted", "rc-unanswered", "rc-getfails", "rc-omitted", "rc-error", "rc-idle", "rc-archived", "rc-active", "rc-starting"];
  for (const id of ids) await mirror(thr(id, { status: "pending" }));
  const goneId = cardOf("rc-gone").id;
  const unansweredId = cardOf("rc-unanswered").id;
  expect(eventsOf(goneId).length).toBe(1);
  // The list leaves out rc-gone, rc-unanswered, rc-getfails and rc-omitted;
  // threads.get then answers: rc-gone deleted, rc-omitted live and active,
  // rc-unanswered with nothing, rc-getfails with an error.
  known.set("rc-gone", thr("rc-gone", { deletedAt: 9 }));
  known.set("rc-omitted", thr("rc-omitted", { status: "active" }));
  known.delete("rc-unanswered");
  const realGet = known.get.bind(known);
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
    if (args.threadId === "rc-getfails") throw new Error("Host unavailable");
    return realGet(args.threadId);
  });
  const listed = [
    thr("rc-softdeleted", { status: "idle", deletedAt: 9 }),
    thr("rc-error", { status: "error" }),
    thr("rc-idle", { status: "idle" }),
    thr("rc-archived", { status: "idle", archivedAt: 9 }),
    thr("rc-active", { status: "active" }),
    thr("rc-starting", { status: "starting" }),
  ];
  for (const thread of listed) known.set(thread.id, thread);
  const { handler } = worldOf(listed);
  context.ctx.list = handler;
  await runPass(context, 4);
  expect((harness.inspection.sdk.callsTo("threads.get") as [{ threadId: string }][]).map(([args]) => args.threadId))
    .toEqual(expect.arrayContaining(["rc-getfails", "rc-gone", "rc-omitted", "rc-unanswered"]));
  expect(cardOf("rc-gone")).toBeUndefined();
  expect(eventCount(db, goneId)).toBe(0);
  expect(cardOf("rc-softdeleted")).toBeUndefined();
  expect(tombstones(db)).toStrictEqual([]);
  // Unanswered and failed lookups leave cards unchanged.
  expect(cardOf("rc-unanswered")).toMatchObject({ stage_id: "stage-todo", run_state: "idle", settled_at: null });
  expect(cardOf("rc-getfails")).toMatchObject({ stage_id: "stage-todo", run_state: "idle", settled_at: null });
  expect(eventCount(db, unansweredId)).toBe(1);
  expect(harness.logEntries.some((entry: any) =>
    entry.level === "warn" && entry.message.includes("could not confirm session rc-getfails"))).toBe(true);
  expect(harness.logEntries.some((entry: any) => entry.message.includes("could not confirm session rc-unanswered"))).toBe(false);
  expect(cardOf("rc-error")).toMatchObject({ run_state: "failed", attention_reason: "The assigned BB thread failed.", stage_id: "stage-progress", settled_at: null });
  expect(cardOf("rc-idle")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
  expect(cardOf("rc-archived")).toMatchObject({ run_state: "idle", stage_id: "stage-todo" });
  expect(cardOf("rc-archived").settled_at).toBeGreaterThan(0);
  for (const id of ["rc-active", "rc-starting", "rc-omitted"]) {
    expect(cardOf(id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", attention_reason: null, settled_at: null });
  }
  expect(cards().length).toBe(8);
});

test("reconcile settles an open sub-thread or hidden-thread card in any stage, and a later thread.active does not reopen it", async () => {
  const context = await start();
  const { cardOf, emit, mirror, rpc } = context;
  const intake = await mirror(thr("sub-intake", { status: "pending" }));
  await mirror(thr("sub-progress", { status: "active" }));
  const done = await mirror(thr("sub-done", { status: "pending" }));
  await rpc("moveTask", { number: done.number, stageId: "stage-completed" });
  await rpc("setTaskSettled", { number: done.number, settled: false });
  expect(intake.settled_at).toBe(null);
  const { handler } = worldOf([
    thr("sub-intake", { parentThreadId: "parent-1" }),
    thr("sub-progress", { visibility: "hidden", status: "active" }),
    thr("sub-done", { parentThreadId: "parent-1" }),
  ]);
  context.ctx.list = handler;
  await runPass(context, 4);
  for (const id of ["sub-intake", "sub-progress", "sub-done"]) {
    expect(cardOf(id).settled_at).toBeGreaterThan(0);
    expect(cardOf(id).run_state).not.toBe("working");
  }
  expect(cardOf("sub-progress").stage_id).toBe("stage-progress");
  expect(cardOf("sub-done").stage_id).toBe("stage-completed");
  const before = { ...cardOf("sub-progress") };
  await emit("thread.active", { thread: thr("sub-progress", { visibility: "hidden", status: "active", title: "Changed" }) });
  await emit("thread.active", { thread: thr("sub-intake", { parentThreadId: "parent-1", status: "active" }) });
  expect(cardOf("sub-progress")).toStrictEqual(before);
  expect(cardOf("sub-intake").settled_at).toBeGreaterThan(0);
  // thread.unarchived does not reopen it either.
  await emit("thread.unarchived", { thread: thr("sub-intake", { parentThreadId: "parent-1", status: "active" }) });
  await emit("thread.unarchived", { thread: thr("sub-progress", { visibility: "hidden", status: "active" }) });
  expect(cardOf("sub-intake").settled_at).toBeGreaterThan(0);
  expect(cardOf("sub-progress")).toStrictEqual(before);
});

test("reconcile looks threads up in chunks of 200 with both halves and hidden threads included", async () => {
  const context = await start();
  const { cards, cardOf } = context;
  const sessions = Array.from({ length: 250 }, (_, index) => thr(`big-${index + 1}`, { createdAt: index + 1, status: "pending" }));
  const { handler } = worldOf(sessions);
  context.ctx.list = handler;
  // First pass cards them (no candidates yet: 250 cards are created after it began).
  await runPass(context, 2);
  expect(cards().length).toBe(250);
  expect(idLookups(context)).toStrictEqual([]);
  await runPass(context, 6);
  const lookups = idLookups(context);
  expect(lookups.map((args) => args.threadIds!.length).sort((left, right) => left - right)).toStrictEqual([50, 50, 200, 200]);
  expect(lookups.filter((args) => args.archived === true).length).toBe(2);
  for (const args of lookups) expect(args).toMatchObject({ includeHidden: true, limit: 200 });
  expect(cardOf("big-1")).toMatchObject({ stage_id: "stage-todo", settled_at: null });
  expect(cards().length).toBe(250);
});

test("reconcile leaves a card created after the pass began alone", async () => {
  const context = await start();
  const { harness, cardOf, known, mirror } = context;
  await mirror(thr("old-gone", { status: "pending" }));
  known.set("old-gone", thr("old-gone", { deletedAt: 9 }));
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { handler } = worldOf([]);
  context.ctx.list = async (args) => {
    if (!args.threadIds && (args.offset ?? 0) === 0) await gate;
    return handler(args) as any;
  };
  await new Promise((resolve) => setTimeout(resolve, 3));
  const clock = vi.spyOn(Date, "now").mockReturnValue(cardOf("old-gone").created_at + 5);
  try {
    await harness.behavior.setSettings({ autoCardThreads: false });
    await harness.behavior.setSettings({ autoCardThreads: true });
    await until(() => harness.inspection.sdk.callsTo("threads.list").length >= 1);
    // This card has the same creation timestamp as the pass but did not exist at its start.
    await mirror(thr("born-during", { status: "pending" }));
  } finally {
    clock.mockRestore();
  }
  release();
  await until(() => cardOf("old-gone") === undefined);
  expect(cardOf("born-during")).toMatchObject({ origin: "mirror", settled_at: null });
});

test("a failed by-id lookup changes nothing and warns", async () => {
  const context = await start();
  const { harness, cardOf, mirror } = context;
  await mirror(thr("lk-gone", { status: "pending" }));
  context.known.set("lk-gone", thr("lk-gone", { deletedAt: 9 }));
  await mirror(thr("lk-idle", { status: "pending" }));
  const before = { gone: { ...cardOf("lk-gone") }, idle: { ...cardOf("lk-idle") } };
  const { handler } = worldOf([thr("lk-idle", { status: "idle" })]);
  context.ctx.list = (args) => {
    if (args.threadIds && !args.archived) throw new Error("Lookup down");
    return handler(args);
  };
  await runPass(context, 4);
  expect(harness.logEntries.some((entry: any) => entry.level === "warn" && entry.message.includes("Lookup down"))).toBe(true);
  expect(cardOf("lk-gone")).toStrictEqual(before.gone);
  expect(cardOf("lk-idle")).toStrictEqual(before.idle);
});

test("a pass that ended on a failed page does not reconcile", async () => {
  const context = await start();
  const { harness, cardOf, mirror } = context;
  await mirror(thr("pg-gone", { status: "pending" }));
  context.known.set("pg-gone", thr("pg-gone", { deletedAt: 9 }));
  context.ctx.list = (args) => {
    if (args.offset === 0) return [thr("pg-a", { createdAt: 1 })];
    throw new Error("Host busy");
  };
  await runPass(context, 2);
  await until(() => harness.logEntries.some((entry: any) => entry.level === "warn" && entry.message.includes("Host busy")));
  await flush();
  expect(idLookups(context)).toStrictEqual([]);
  expect(cardOf("pg-gone")).toMatchObject({ settled_at: null });
});

test("turning the knob off during the pass, in the page or in the lookup, stops reconcile before any write", async () => {
  const context = await start();
  const { harness, cardOf, mirror } = context;
  await mirror(thr("ko-gone", { status: "pending" }));
  context.known.set("ko-gone", thr("ko-gone", { deletedAt: 9 }));
  // Off while the page is fetched: the pass ends without a lookup.
  context.ctx.list = async (args) => {
    if (args.offset === 0) await harness.behavior.setSettings({ autoCardThreads: false });
    return [];
  };
  await new Promise((resolve) => setTimeout(resolve, 3));
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length >= 1);
  await flush();
  expect(idLookups(context)).toStrictEqual([]);
  expect(cardOf("ko-gone")).toBeDefined();
  // Off while the by-id lookup runs: the lookup happened, but nothing is written.
  context.ctx.list = async (args) => {
    if (args.threadIds && !args.archived) await harness.behavior.setSettings({ autoCardThreads: false });
    return [];
  };
  await harness.behavior.setSettings({ autoCardThreads: false });
  await runPass(context, 3);
  expect(idLookups(context).length).toBe(2);
  expect(cardOf("ko-gone")).toMatchObject({ origin: "mirror", settled_at: null });
});

test("reconcile leaves a card alone when an event changed it after it was read", async () => {
  const context = await start();
  const { db, cardOf, mirror } = context;
  await mirror(thr("cas-gone", { status: "pending" }));
  context.known.set("cas-gone", thr("cas-gone", { deletedAt: 9 }));
  await mirror(thr("cas-idle", { status: "pending" }));
  const { handler } = worldOf([thr("cas-idle", { status: "idle" })]);
  context.ctx.list = (args) => {
    // An event lands between the read of the candidates and the writes.
    if (args.threadIds && !args.archived) db.prepare("UPDATE triage_tasks SET updated_at = updated_at + 1").run();
    return handler(args);
  };
  const before = { gone: { ...cardOf("cas-gone") }, idle: { ...cardOf("cas-idle") } };
  await runPass(context, 4);
  expect(cardOf("cas-gone")).toStrictEqual({ ...before.gone, updated_at: before.gone.updated_at + 1 });
  expect(cardOf("cas-idle")).toStrictEqual({ ...before.idle, updated_at: before.idle.updated_at + 1 });
  expect(eventCount(db, before.gone.id)).toBe(1);
});

test("reconcile derives idle, error and active cards moved to active", async () => {
  const context = await start();
  const { cardOf, mirror, rpc } = context;
  for (const id of ["mv-idle", "mv-error", "mv-active"]) {
    const card = await mirror(thr(id, { status: "pending" }));
    await rpc("moveTask", { number: card.number, stageId: "stage-progress" });
  }
  const threads = [
    thr("mv-idle", { status: "idle" }),
    thr("mv-error", { status: "error" }),
    thr("mv-active", { status: "active" }),
  ];
  for (const thread of threads) context.known.set(thread.id, thread);
  context.ctx.list = worldOf(threads).handler;
  await runPass(context, 4);
  expect(cardOf("mv-idle")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  expect(cardOf("mv-error")).toMatchObject({ stage_id: "stage-progress", run_state: "failed", settled_at: null });
  expect(cardOf("mv-active")).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("reconcile never touches manual cards, queued, scheduled or imported", async () => {
  const context = await start();
  const { cardOf, cards, known, mirror, importManual, rpc } = context;
  const request = {
    projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
    permissionMode: "auto", executionInputSources: {},
    environment: { type: "reuse", environmentId: "environment-1" },
    input: [{ type: "text", text: "Do work" }],
  };
  await rpc("createTask", { title: "Queued", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: false, request });
  await rpc("createTask", { title: "Scheduled", description: "Do work", stageId: "stage-todo", scheduledAt: Date.now() + 3_600_000, runNow: false, request });
  await importManual(thr("man-gone", { status: "idle" }));
  await mirror(thr("man-mirror-gone", { status: "pending" }));
  known.set("man-mirror-gone", thr("man-mirror-gone", { deletedAt: 9 }));
  const manualBefore = cards().filter((card) => card.origin === "manual").map((card) => ({ ...card }));
  expect(manualBefore.length).toBe(3);
  const { handler } = worldOf([]);
  context.ctx.list = handler;
  await runPass(context, 3);
  expect(cardOf("man-mirror-gone")).toBeUndefined();
  expect(cards().filter((card) => card.origin === "manual")).toStrictEqual(manualBefore);
});

test("reconcile leaves the card of a pending or stopping thread alone", async () => {
  const context = await start();
  const { cardOf, mirror } = context;
  await mirror(thr("ps-pending", { status: "pending" }));
  await mirror(thr("ps-stopping", { status: "pending" }));
  const before = [{ ...cardOf("ps-pending") }, { ...cardOf("ps-stopping") }];
  const { handler } = worldOf([thr("ps-pending", { status: "pending" }), thr("ps-stopping", { status: "stopping" })]);
  context.ctx.list = handler;
  await runPass(context, 4);
  expect([cardOf("ps-pending"), cardOf("ps-stopping")]).toStrictEqual(before);
});

// ---- Sub-threads keep their top-level card live ------------------------------------------------
// A sub-thread never gets a card of its own (isMirrorable). While one runs, its top-level
// thread's mirror card is working; when nothing below that thread runs any more, it settles.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const deferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
// The plugin's own start-up backfill must be over before a test swaps the fake host's answers.
const startQuiet = async (options?: Parameters<typeof setup>[0]) => {
  const context = await start(options);
  await flush();
  return context;
};
const running = (context: Setup, ...ids: string[]) => {
  context.ctx.running = () => ids.map((id) => ({ id, hostId: null }));
};

// BB 0.50.1 / Triage 0.6.2 card #3251: listRunning only returns active or
// starting turns; threads.list activity counts also include background work.
test("background work keeps an idle root command in progress", async () => {
  const context = await startQuiet();
  const root = thr("background-command", { status: "idle", activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  await context.mirror(root);
  context.ctx.list = worldOf([root]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }));
  await context.rpc("snapshot");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

// BB 0.50.1 / Triage 0.8.0 card #3426: an idle Claude thread reported one
// active workflow and zero background commands or agents in threads.list.
test("a background workflow keeps its idle thread in progress until completion", async () => {
  const context = await startQuiet();
  const active = thr("background-workflow", { status: "active" });
  const idle = thr(active.id, { status: "idle", activity: { activeWorkflowCount: 1 } });
  const world = worldOf([active]);
  context.ctx.list = world.handler;
  await context.mirror(active);
  expect(context.cardOf(active.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });

  world.map.set(idle.id, idle);
  await context.emitNative("thread.idle", { thread: idle });
  expect(context.cardOf(idle.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  await context.rpc("snapshot");
  expect(context.cardOf(idle.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });

  world.map.set(idle.id, thr(idle.id, { status: "idle" }));
  context.ctx.readChanged({ id: idle.id, changes: [], metadata: { eventTypes: ["item/backgroundTask/completed"] } });
  await until(() => context.cardOf(idle.id).run_state === "completed");
  expect(context.cardOf(idle.id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed" });
});

test("background work on a hidden idle descendant lasts until the last job finishes", async () => {
  const context = await startQuiet();
  const root = thr("background-root", { status: "idle" });
  const child = thr("background-child", { parentThreadId: root.id, status: "idle", visibility: "hidden", activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 1 } });
  await context.mirror(root);
  context.known.set(child.id, child);
  const world = worldOf([root, child]);
  context.ctx.list = world.handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: threadId === root.id ? [child.id] : [] })) }));
  const changed = (type: string) => context.ctx.readChanged({ id: child.id, changes: [], metadata: { eventTypes: [type] } });
  await context.rpc("snapshot");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  world.map.set(child.id, { ...child, activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 1 } });
  changed("item/backgroundTask/completed");
  await flush();
  expect(context.cardOf(root.id).run_state).toBe("working");
  world.map.set(child.id, { ...child, activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 0 } });
  changed("item/backgroundTask/completed");
  await until(() => context.cardOf(root.id).run_state === "completed");
});

test.each(["archivedAt", "deletedAt"])("background work ignores a %s descendant", async (field) => {
  const context = await startQuiet();
  const root = thr(`background-ignore-${field}`, { status: "idle" });
  const child = thr(`background-ignore-child-${field}`, { parentThreadId: root.id, status: "idle", [field]: 1, activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  await context.mirror(root);
  context.ctx.list = worldOf([root, child]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [child.id] })) }));
  await context.rpc("snapshot");
  expect(context.cardOf(root.id).run_state).toBe("completed");
});

test("background work below an archived intermediate keeps its root active", async () => {
  const context = await startQuiet();
  const root = thr("background-archived-parent-root", { status: "idle" });
  const parent = thr("background-archived-parent", { parentThreadId: root.id, status: "idle", archivedAt: 1 });
  const child = thr("background-archived-parent-child", { parentThreadId: parent.id, status: "idle", visibility: "hidden", activity: { activeBackgroundCommandCount: 0, activeBackgroundAgentCount: 1 } });
  await context.mirror(root);
  context.known.set(parent.id, parent);
  context.known.set(child.id, child);
  context.ctx.list = worldOf([root, parent, child]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [child.id] })) }));
  await context.rpc("snapshot");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
});

test("background work events reconcile a manual intermediate card", async () => {
  const context = await startQuiet({ settings: { autoCardThreads: false } });
  const root = thr("background-manual-root", { status: "idle" });
  const parent = thr("background-manual-parent", { parentThreadId: root.id, status: "idle" });
  const child = thr("background-manual-child", { parentThreadId: parent.id, status: "idle", visibility: "hidden", activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  context.known.set(root.id, root);
  context.known.set(child.id, child);
  await context.importManual(parent);
  context.ctx.list = worldOf([root, parent, child]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [child.id] })) }));
  context.ctx.readChanged({ id: child.id, changes: [], metadata: { backgroundActivityChanged: true, eventTypes: ["item/started"] } });
  await until(() => context.cardOf(parent.id)?.run_state === "working");
  expect(context.cardOf(root.id)).toBeUndefined();
});

test("background work completes the parent when the last active child is deleted", async () => {
  const context = await startQuiet();
  const root = thr("background-delete-root", { status: "idle" });
  const child = thr("background-delete-child", { parentThreadId: root.id, status: "active" });
  await context.mirror(root);
  context.known.set(child.id, child);
  const world = worldOf([root, child]);
  context.ctx.list = world.handler;
  running(context, child.id);
  await context.rpc("snapshot");
  expect(context.cardOf(root.id).run_state).toBe("working");
  context.known.delete(child.id);
  world.map.delete(child.id);
  running(context);
  await context.emit("thread.deleted", { thread: child });
  await until(() => context.cardOf(root.id).run_state === "completed");
});

test("background work reopens an automatically settled card on refresh", async () => {
  const context = await startQuiet();
  const root = thr("background-reopen", { status: "idle", activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  const card = await context.mirror(root);
  context.db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed', run_state = 'completed', settled_at = 1 WHERE id = ?").run(card.id);
  context.ctx.list = worldOf([root]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }));
  await context.rpc("snapshot");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("background work is found by startup backfill", async () => {
  const context = await startQuiet({ settings: { autoCardThreads: false } });
  const root = thr("background-backfill", { status: "idle", activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  context.known.set(root.id, root);
  context.ctx.list = worldOf([root]).handler;
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => context.cardOf(root.id)?.run_state === "working");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", settled_at: null });
});

test("background work read failure preserves the card", async () => {
  const context = await startQuiet();
  const root = thr("background-failure", { status: "active" });
  await context.mirror(root);
  const idle = { ...root, status: "idle" };
  context.known.set(root.id, idle);
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async () => { throw new Error("activity unavailable"); });
  await context.emit("thread.idle", { thread: idle });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
});

test("background work starts on the SDK activity flag with item/started", async () => {
  const context = await startQuiet();
  const root = thr("background-started", { status: "idle" });
  await context.mirror(root);
  const world = worldOf([root]);
  context.ctx.list = world.handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }));
  await context.rpc("snapshot");
  world.map.set(root.id, { ...root, activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  context.ctx.readChanged({ id: root.id, changes: [], metadata: { backgroundActivityChanged: true, eventTypes: ["item/started"] } });
  await until(() => context.cardOf(root.id).run_state === "working");
});

test("background work starting overtakes a completion check", async () => {
  const context = await startQuiet();
  const root = thr("background-overtake", { status: "active" });
  const card = await context.mirror(root);
  const idle = { ...root, status: "idle" };
  context.known.set(root.id, idle);
  const world = worldOf([idle]);
  const gate = deferred<ReturnType<typeof thr>[]>();
  let reads = 0;
  let stale: ReturnType<typeof thr>[] = [];
  context.ctx.list = (args) => {
    const rows = world.handler(args) as ReturnType<typeof thr>[];
    if (args.threadIds && !args.archived && ++reads === 2) { stale = rows; return gate.promise; }
    return rows;
  };
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) }));
  const completedBefore = context.eventsOf(card.id).filter((event) => event.event === "turn completed").length;
  context.ctx.readChanged({ id: root.id, changes: [], metadata: { eventTypes: ["item/backgroundTask/completed"] } });
  await until(() => reads >= 2);
  expect(stale[0].activity.activeBackgroundAgentCount).toBe(0);
  world.map.set(root.id, { ...idle, activity: { ...idle.activity, activeBackgroundAgentCount: 1 } });
  context.ctx.readChanged({ id: root.id, changes: [], metadata: { backgroundActivityChanged: true, eventTypes: ["item/started"] } });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  gate.resolve(stale);
  await until(() => reads >= 4);
  await until(() => context.cardOf(root.id).run_state === "working");
  expect(context.eventsOf(card.id).filter((event) => event.event === "turn completed")).toHaveLength(completedBefore);
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("snapshot shares a final liveness read after every card reaches it or returns", async () => {
  const context = await startQuiet();
  const roots = ["batch-fast", "batch-slow", "batch-early"].map((id) => thr(id, { status: "idle" }));
  for (const root of roots) await context.mirror(root);
  const early = { ...context.cardOf("batch-early") };
  const world = worldOf(roots);
  context.ctx.list = world.handler;
  const gate = deferred<void>();
  const interactionReads = new Map<string, number>();
  const treeReads: { ids: string[]; slowReady: boolean }[] = [];
  let slowWaiting = false;
  let slowReady = false;
  context.harness.inspection.sdk.stub("threads.interactions.list", async ({ threadId }: { threadId: string }) => {
    const count = (interactionReads.get(threadId) ?? 0) + 1;
    interactionReads.set(threadId, count);
    if (threadId === "batch-early") throw new Error("preflight failed");
    if (threadId === "batch-slow" && count === 2) {
      slowWaiting = true;
      await gate.promise;
      slowReady = true;
    }
    return [];
  });
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => {
    treeReads.push({ ids: [...threadIds], slowReady });
    return { threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) };
  });
  const pending = context.rpc("snapshot");
  await until(() => slowWaiting);
  await flush();
  gate.resolve();
  await pending;
  expect(treeReads).toEqual([
    { ids: ["batch-fast", "batch-slow", "batch-early"], slowReady: false },
    { ids: ["batch-fast", "batch-slow"], slowReady: true },
  ]);
  expect(context.cardOf("batch-fast").run_state).toBe("completed");
  expect(context.cardOf("batch-slow").run_state).toBe("completed");
  expect(context.cardOf("batch-early")).toStrictEqual(early);
});

test("background work uses a fresh tree read after the batched snapshot read", async () => {
  const context = await startQuiet();
  const root = thr("background-bulk-fresh", { status: "active" });
  await context.mirror(root);
  const idle = { ...root, status: "idle" };
  context.known.set(root.id, idle);
  const world = worldOf([idle]);
  let treeReads = 0;
  let changed = false;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => {
    treeReads++;
    return { threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) };
  });
  context.ctx.list = (args) => {
    const rows = world.handler(args);
    if (!changed && treeReads === 1 && args.threadIds && !args.archived) {
      changed = true;
      world.map.set(root.id, { ...idle, activity: { ...idle.activity, activeBackgroundCommandCount: 1 } });
    }
    return rows;
  };
  await context.rpc("snapshot");
  expect(treeReads).toBeGreaterThanOrEqual(2);
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  await context.rpc("snapshot");
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test.each([[false, false], [true, false], [false, true], [true, true]])("background work starting during a stale check (descendant=%s, settlement=%s)", async (descendant, settle) => {
  const context = await startQuiet();
  const root = thr(`background-race-${descendant}`, { status: "active" });
  const child = thr(`background-race-child-${descendant}`, { parentThreadId: root.id, status: "idle", visibility: "hidden" });
  const card = await context.mirror(root);
  const idle = { ...root, status: "idle" };
  context.known.set(root.id, idle);
  context.known.set(child.id, child);
  const world = worldOf([idle, child]);
  const gate = deferred<ReturnType<typeof thr>[]>();
  let reads = 0;
  let stale: ReturnType<typeof thr>[] = [];
  context.ctx.list = (args) => {
    const rows = world.handler(args) as ReturnType<typeof thr>[];
    if (args.threadIds && !args.archived && ++reads === 2) { stale = rows; return gate.promise; }
    return rows;
  };
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: descendant ? [child.id] : [] })) }));
  const completedBefore = context.eventsOf(card.id).filter((event) => event.event === "turn completed").length;
  const completion = settle ? context.rpc("setTaskSettled", { number: card.number, settled: true }) : context.emit("thread.idle", { thread: idle });
  await until(() => reads >= 2);
  expect(stale.every((row) => row.activity.activeBackgroundCommandCount === 0)).toBe(true);
  const source = descendant ? child : idle;
  world.map.set(source.id, { ...source, activity: { ...source.activity, activeBackgroundCommandCount: 1 } });
  context.ctx.readChanged({ id: source.id, changes: [], metadata: { eventTypes: ["item/backgroundTask/progress"] } });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  gate.resolve(stale);
  await completion;
  await until(() => reads >= 4);
  await until(() => context.cardOf(root.id).run_state === "working");
  expect(context.eventsOf(card.id).filter((event) => event.event === "turn completed")).toHaveLength(completedBefore);
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});
const kid = (id: string, parentThreadId: string, overrides: Record<string, unknown> = {}) =>
  thr(id, { parentThreadId, status: "active", ...overrides });
const runningCalls = (context: Setup) => context.harness.inspection.sdk.callsTo("threads.listRunning").length;
const warned = (context: Setup, text: string) =>
  context.harness.logEntries.some((entry: any) => entry.level === "warn" && entry.message.includes(text));
// Run one backfill pass and wait for its `lookups` listRunning calls (backfill, then reconcile).
async function rerun(context: Setup, lookups: number) {
  const before = runningCalls(context);
  await sleep(3);
  await context.harness.behavior.setSettings({ autoCardThreads: false });
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => runningCalls(context) >= before + lookups);
  await flush();
  await flush();
}

test("a sub-thread going active reopens its completed top-level card without its own card or notice", async () => {
  const context = await startQuiet();
  const { db, cards, cardOf, eventsOf, notifications, emit, known, mirror } = context;
  const root = await mirror(thr("root-1", { status: "active" }));
  known.set("kid-1", kid("kid-1", "root-1"));
  running(context);
  known.set("root-1", thr("root-1", { status: "idle" }));
  await emit("thread.idle", { thread: thr("root-1") });
  expect(cardOf("root-1")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
  const history = eventsOf(root.id);
  context.ctx.list = worldOf([known.get("root-1"), known.get("kid-1")]).handler;
  running(context, "kid-1");
  await emit("thread.active", { thread: known.get("kid-1") });
  await until(() => cardOf("root-1").run_state === "working");
  expect(cardOf("root-1")).toMatchObject({ stage_id: "stage-progress", run_state: "working", attention_reason: null, settled_at: null });
  expect(eventsOf(root.id)).toStrictEqual(history);
  expect(notifications()).toStrictEqual([]);
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["root-1"]);
});

test("a sub-thread going active under a top-level thread with no card creates that card, then marks it working", async () => {
  const context = await startQuiet();
  const { cards, cardOf, eventsOf, emit, known } = context;
  known.set("root-2", thr("root-2", { status: "idle" }));
  known.set("kid-2", kid("kid-2", "root-2"));
  context.ctx.list = worldOf([known.get("root-2"), known.get("kid-2")]).handler;
  running(context, "kid-2");
  await emit("thread.active", { thread: known.get("kid-2") });
  await until(() => cardOf("root-2")?.run_state === "working");
  expect(cardOf("root-2")).toMatchObject({ origin: "mirror", stage_id: "stage-progress", run_state: "working", settled_at: null });
  expect(eventsOf(cardOf("root-2").id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
  expect(cards().length).toBe(1);
});

test("a grandchild going active reopens the top-level card, and a parent cycle ends the walk without a card", async () => {
  const context = await startQuiet();
  const { cards, cardOf, emit, known, mirror, harness } = context;
  await mirror(thr("root-3", { status: "pending" }));
  known.set("root-3", thr("root-3", { status: "idle" }));
  known.set("mid-3", thr("mid-3", { parentThreadId: "root-3" }));
  known.set("leaf-3", kid("leaf-3", "mid-3"));
  context.ctx.list = worldOf([known.get("root-3"), known.get("mid-3"), known.get("leaf-3")]).handler;
  running(context, "leaf-3");
  await emit("thread.active", { thread: known.get("leaf-3") });
  await until(() => cardOf("root-3").run_state === "working");
  expect(cardOf("root-3")).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  const lookups = harness.inspection.sdk.callsTo("threads.get").length;
  // c -> a -> b -> a: the walk stops at b, which still has a parent, so nothing is carded.
  known.set("cyc-a", thr("cyc-a", { parentThreadId: "cyc-b" }));
  known.set("cyc-b", thr("cyc-b", { parentThreadId: "cyc-a" }));
  const result = await emit("thread.active", { thread: kid("cyc-c", "cyc-a") });
  expect(result.errors).toStrictEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.get").length - lookups).toBeLessThanOrEqual(6);
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["root-3"]);
});

test("a done or stopped top-level card is not reopened by a running sub-thread", async () => {
  const context = await startQuiet();
  const { db, cardOf, emit, known, mirror, rpc } = context;
  const done = await mirror(thr("root-done", { status: "pending" }));
  await rpc("moveTask", { number: done.number, stageId: "stage-completed" });
  const stopped = await mirror(thr("root-stopped", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(stopped.id);
  const before = { done: { ...cardOf("root-done") }, stopped: { ...cardOf("root-stopped") } };
  known.set("kid-done", kid("kid-done", "root-done"));
  known.set("root-done", thr("root-done", { status: "idle" }));
  known.set("kid-stopped", kid("kid-stopped", "root-stopped"));
  await emit("thread.active", { thread: known.get("kid-done") });
  await emit("thread.active", { thread: known.get("kid-stopped") });
  expect(cardOf("root-done")).toStrictEqual(before.done);
  expect(cardOf("root-stopped")).toStrictEqual(before.stopped);
});

test("a child cannot reopen explicit settlement for the current reply", async () => {
  const context = await startQuiet();
  const { cardOf, db, emit, known, mirror, ctx } = context;
  const card = await mirror(thr("settled-root", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET settled_at = ? WHERE id = ?").run(Date.now(), card.id);
  db.prepare("INSERT INTO triage_events (id, task_id, actor, event, created_at) VALUES (?, ?, 'user', 'marked settled', ?)").run("settled-root-event", card.id, Date.now());
  const settledEvent = db.prepare("SELECT created_at FROM triage_events WHERE task_id = ? AND event = 'marked settled'").get(card.id) as { created_at: number };
  known.set("settled-root", thr("settled-root", { status: "idle", latestAttentionAt: settledEvent.created_at - 1 }));
  const firstChild = kid("settled-child", "settled-root");
  known.set(firstChild.id, firstChild);
  ctx.list = worldOf([known.get("settled-root"), firstChild]).handler;
  running(context, firstChild.id);
  const before = { ...cardOf("settled-root") };
  await emit("thread.active", { thread: firstChild });
  await flush();
  expect(cardOf("settled-root")).toStrictEqual(before);
  known.set("settled-root", thr("settled-root", { status: "idle", latestAttentionAt: null }));
  ctx.list = worldOf([known.get("settled-root"), firstChild]).handler;
  await emit("thread.active", { thread: firstChild });
  await flush();
  expect(cardOf("settled-root")).toStrictEqual(before);
  known.set("settled-root", thr("settled-root", { status: "idle", latestAttentionAt: settledEvent.created_at + 1 }));
  ctx.list = worldOf([known.get("settled-root"), firstChild]).handler;
  await emit("thread.active", { thread: firstChild });
  await until(() => cardOf("settled-root").settled_at === null);
  expect(cardOf("settled-root")).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("child activity wins when settlement starts during its root lookup", async () => {
  const context = await startQuiet();
  const { cardOf, emit, harness, known, mirror, rpc } = context;
  const root = thr("settlement-race-root", { status: "idle" });
  const card = await mirror(root);
  const child = kid("settlement-race-child", root.id);
  known.set(child.id, child);
  context.ctx.list = worldOf([root, child]).handler;
  running(context, child.id);
  const gate = deferred<unknown>();
  let asked = false;
  harness.inspection.sdk.stub("threads.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread: child });
  await until(() => asked);
  await rpc("setTaskSettled", { number: card.number, settled: true });
  const settledAt = cardOf(root.id).settled_at;
  gate.resolve(known.get(root.id));
  await active;
  await until(() => cardOf(root.id).run_state === "working");
  expect(settledAt).toBeNull();
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
});

test("a user reply returns Human Review to In Progress on activity", async () => {
  const { mirror, rpc, emit, cardOf, harness } = await startQuiet();
  const thread = thr("reply-root", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.events.list", async () => [{
    seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested",
    data: { initiator: "user", originPluginId: null, senderThreadId: null },
  }]);
  harness.inspection.sdk.stub("threads.interactions.list", async () => []);
  await emit("thread.active", { thread });
  expect(cardOf(thread.id).stage_id).toBe("stage-progress");
});

test.each(["realtime", "pending"])("new interaction during thread lookup preserves handoff via %s", async (source) => {
  const { mirror, rpc, emit, cardOf, harness, ctx } = await startQuiet();
  const thread = thr("pending-race", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.events.list", async () => [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }]);
  const gate = deferred<any>();
  let asked = false;
  let pending = false;
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "question-2", payload: { title: "Question" } }] : []);
  harness.inspection.sdk.stub("threads.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread });
  await until(() => asked);
  pending = true;
  if (source === "realtime") ctx.readChanged({ id: thread.id, changes: ["interactions-changed"] });
  else await emit("interaction.pending", { thread, interaction: { id: "question-2", payload: { title: "Question" } } });
  gate.resolve(thread);
  await active;
  expect(cardOf(thread.id).stage_id).toBe("stage-attention");
});

test("a pending interaction discovered after thread lookup preserves the handoff without a notification", async () => {
  const { mirror, rpc, emit, cardOf, harness } = await startQuiet();
  const thread = thr("pending-unannounced", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.events.list", async () => [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }]);
  const gate = deferred<any>();
  let asked = false;
  let pending = false;
  harness.inspection.sdk.stub("threads.interactions.list", async () => pending ? [{ id: "question-2", payload: { title: "Question" } }] : []);
  harness.inspection.sdk.stub("threads.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread });
  await until(() => asked);
  pending = true;
  gate.resolve(thread);
  await active;
  expect(cardOf(thread.id).stage_id).toBe("stage-attention");
});

test.each(["realtime", "pending"])("another thread's interaction does not cancel a response check via %s", async (source) => {
  const { mirror, rpc, emit, cardOf, harness, ctx } = await startQuiet();
  const thread = thr("unrelated-race", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.events.list", async () => [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }]);
  const gate = deferred<any>();
  let asked = false;
  harness.inspection.sdk.stub("threads.get", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread });
  await until(() => asked);
  if (source === "realtime") ctx.readChanged({ id: "other-root", changes: ["interactions-changed"] });
  else await emit("interaction.pending", { thread: thr("other-root"), interaction: { id: "question", payload: { title: "Question" } } });
  gate.resolve(thread);
  await active;
  expect(cardOf(thread.id).stage_id).toBe("stage-progress");
});

test("a new interaction invalidates concurrent response checks for the same thread", async () => {
  const { mirror, rpc, emit, cardOf, harness, ctx } = await startQuiet();
  const thread = thr("concurrent-responses", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  harness.inspection.sdk.stub("threads.events.list", async () => [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }]);
  const first = deferred<any>();
  const second = deferred<any>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.get", async () => (++calls === 1 ? first.promise : second.promise));
  const active1 = emit("thread.active", { thread });
  await until(() => calls === 1);
  const active2 = emit("thread.active", { thread });
  await until(() => calls === 2);
  ctx.readChanged({ id: thread.id, changes: ["interactions-changed"] });
  first.resolve(thread);
  await active1;
  second.resolve(thread);
  await active2;
  expect(cardOf(thread.id).stage_id).toBe("stage-attention");
});

test("a stage move during the final pending check wins over a found response", async () => {
  const { mirror, rpc, emit, cardOf, harness, ctx } = await startQuiet();
  const thread = thr("final-check-move", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  ctx.events = () => [{ seq: 1, createdAt: Date.now() + 1000, type: "client/turn/requested", data: { initiator: "user", originPluginId: null, senderThreadId: null } }];
  const gate = deferred<any[]>();
  let calls = 0;
  harness.inspection.sdk.stub("threads.interactions.list", async () => (++calls === 2 ? gate.promise : []));
  const active = emit("thread.active", { thread });
  await until(() => calls === 2);
  await rpc("moveTask", { number: card.number, stageId: "stage-todo" });
  gate.resolve([]);
  await active;
  expect(cardOf(thread.id).stage_id).toBe("stage-todo");
});

test.each(["stop", "archive", "delete", "move"])("%s during native lookup preserves the newer change", async (action) => {
  const { mirror, rpc, emit, cardOf, harness, db } = await startQuiet();
  const thread = thr("native-race", { status: "active" });
  const card = await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const gate = deferred<any[]>();
  let asked = false;
  harness.inspection.sdk.stub("threads.interactions.list", async () => { asked = true; return gate.promise; });
  const active = emit("thread.active", { thread });
  await until(() => asked);
  if (action === "stop") db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(card.id);
  if (action === "archive") await emit("thread.archived", { thread: thr(thread.id, { archivedAt: Date.now() }) });
  if (action === "delete") await emit("thread.deleted", { thread });
  if (action === "move") await rpc("moveTask", { number: card.number, stageId: "stage-todo" });
  gate.resolve([]);
  await active;
  if (action === "delete") expect(cardOf(thread.id)).toBeUndefined();
  else if (action === "move") expect(cardOf(thread.id).stage_id).toBe("stage-todo");
  else if (action === "stop") expect(cardOf(thread.id).run_state).toBe("stopped");
  else expect(cardOf(thread.id).settled_at).not.toBeNull();
});

test.each(["manual", "mirror"] as const)("%s native lookup failure leaves the card unchanged", async (origin) => {
  const { mirror, importManual, rpc, emit, cardOf, harness } = await startQuiet();
  const thread = thr(`native-failure-${origin}`, { status: "active" });
  const card = origin === "manual" ? await importManual(thread) : await mirror(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
  const before = { ...cardOf(thread.id) };
  harness.inspection.sdk.stub("threads.interactions.list", async () => { throw new Error("unavailable"); });
  await emit("thread.active", { thread });
  expect(cardOf(thread.id)).toStrictEqual(before);
});

test("activity clears stale attention, preserves custom placement, and skips invalid roots", async () => {
  const context = await startQuiet();
  const { cardOf, db, emit, known, mirror, rpc } = context;
  const custom = await rpc("createStage", { name: "Holding" });
  for (const [id, stageId] of [["keep-attention", "stage-attention"], ["keep-custom", custom.id]]) {
    const card = await mirror(thr(id, { status: "active" }));
    await rpc("moveTask", { number: card.number, stageId });
    db.prepare("UPDATE triage_tasks SET run_state = 'idle' WHERE id = ?").run(card.id);
    await emit("thread.active", { thread: thr(id, { status: "active" }) });
    const expectedStage = stageId === custom.id ? custom.id : "stage-progress";
    expect(cardOf(id)).toMatchObject({ stage_id: expectedStage, run_state: "working", settled_at: null });
    db.prepare("UPDATE triage_tasks SET run_state = 'idle' WHERE id = ?").run(card.id);
    known.set(id, thr(id, { status: "idle" }));
    const child = kid(`${id}-child`, id);
    known.set(child.id, child);
    context.ctx.list = worldOf([known.get(id), child]).handler;
    running(context, child.id);
    await emit("thread.active", { thread: child });
    await until(() => cardOf(id).run_state === "working");
    expect(cardOf(id)).toMatchObject({ stage_id: expectedStage, run_state: "working", settled_at: null });
  }
  for (const [id, overrides] of [["idle-hidden", { visibility: "hidden" }], ["idle-archived", { archivedAt: 1 }], ["idle-deleted", { deletedAt: 1 }]] as const) {
    await mirror(thr(id, { status: "active" }));
    const before = { ...cardOf(id) };
    await emit("thread.idle", { thread: thr(id, { status: "idle", ...overrides }) });
    expect(cardOf(id)).toStrictEqual(before);
  }
});

test("a tombstoned, hidden or archived top-level thread gets no card from a running sub-thread", async () => {
  const context = await startQuiet();
  const { db, cards, emit, known } = context;
  db.prepare("INSERT INTO triage_mirror_tombstones (thread_id, created_at) VALUES ('root-tomb', 1)").run();
  known.set("root-tomb", thr("root-tomb"));
  known.set("root-hidden", thr("root-hidden", { visibility: "hidden" }));
  known.set("root-archived", thr("root-archived", { archivedAt: 5 }));
  for (const parent of ["root-tomb", "root-hidden", "root-archived"]) {
    await emit("thread.active", { thread: kid(`kid-of-${parent}`, parent) });
  }
  expect(cards()).toStrictEqual([]);
});

test("an existing card of a hidden top-level thread, and a manual card, do not reopen when a sub-thread goes active", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror, importManual } = context;
  await mirror(thr("root-hid", { status: "pending" }));
  known.set("root-hid", thr("root-hid", { visibility: "hidden" }));
  const manual = await importManual(thr("root-man", { status: "pending" }));
  const before = { hidden: { ...cardOf("root-hid") }, manual: { ...cardOf("root-man") } };
  await emit("thread.active", { thread: kid("kid-hid", "root-hid") });
  await emit("thread.active", { thread: kid("kid-man", "root-man") });
  expect(cardOf("root-hid")).toStrictEqual(before.hidden);
  expect(cardOf("root-man")).toStrictEqual(before.manual);
  expect(manual.number).toBe(cardOf("root-man").number);
  expect(cardOf("root-man").origin).toBe("manual");
});

test("a sub-thread ending completes the idle top-level card when nothing else runs", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  running(context);
  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"]) {
    const rootId = `root-${event}`;
    await mirror(thr(rootId, { status: "active" }));
    known.set(rootId, thr(rootId, { status: "idle" }));
    known.set(`kid-${event}`, kid(`kid-${event}`, rootId));
    await emit(event, { thread: known.get(`kid-${event}`), error: "boom" });
    await until(() => cardOf(rootId).run_state === "completed");
    expect(cardOf(rootId)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", attention_reason: null, settled_at: null });
  }
});

test("the card stays working while the top-level thread or another sub-thread still runs, including a root's own idle", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  for (const id of ["live-self", "live-other", "live-deep"]) await mirror(thr(id, { status: "active" }));
  known.set("kid-self", kid("kid-self", "live-self"));
  known.set("kid-other-a", kid("kid-other-a", "live-other"));
  known.set("kid-other-b", kid("kid-other-b", "live-other"));
  known.set("mid-deep", kid("mid-deep", "live-deep"));
  known.set("leaf-deep", kid("leaf-deep", "mid-deep"));
  // listRunning names the same thread twice and a thread the host no longer lists: both are harmless.
  running(context, "live-self", "kid-other-b", "kid-other-b", "leaf-deep", "vanished");
  context.ctx.list = worldOf([thr("live-self", { status: "active" }), known.get("kid-other-b"), known.get("leaf-deep")]).handler;
  await emit("thread.idle", { thread: known.get("kid-self") });
  await emit("thread.idle", { thread: known.get("kid-other-a") });
  await emit("thread.failed", { thread: known.get("mid-deep"), error: "boom" });
  // A top-level thread's own idle: a running sub-thread keeps it working.
  await emit("thread.idle", { thread: thr("live-other") });
  for (const id of ["live-self", "live-other", "live-deep"]) {
    expect(cardOf(id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null });
  }
});

test("a thread listRunning names but the host now lists as idle is not live, so the root card completes", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("root-stop", { status: "active" }));
  known.set("root-stop", thr("root-stop", { status: "idle" }));
  known.set("kid-stop", kid("kid-stop", "root-stop"));
  running(context, "kid-stop");
  context.ctx.list = worldOf([thr("kid-stop", { parentThreadId: "root-stop", status: "idle" })]).handler;
  await emit("thread.idle", { thread: known.get("kid-stop") });
  await until(() => cardOf("root-stop").run_state === "completed");
  expect(cardOf("root-stop")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
});

test("a child ending does not complete a root that is active or failed", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  for (const status of ["active", "error"]) {
    const id = `root-current-${status}`;
    await mirror(thr(id, { status: "active" }));
    known.set(id, thr(id, { status }));
    const before = { ...cardOf(id) };
    await emit("thread.idle", { thread: kid(`child-${status}`, id, { status: "idle" }) });
    if (status === "active") expect(cardOf(id)).toStrictEqual(before);
    else {
      await until(() => cardOf(id).run_state === "failed");
      expect(cardOf(id).stage_id).toBe("stage-progress");
    }
  }
});

test.each(["event", "backfill"])("failed root stays failed during child activity through %s until root resumes", async (path) => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  const root = thr(`failed-root-${path}`, { status: "error" });
  await mirror(thr(root.id, { status: "active" }));
  known.set(root.id, root);
  await emit("thread.failed", { thread: root, error: "failure" });
  const child = kid(`failed-child-${path}`, root.id);
  known.set(child.id, child);
  const before = { ...cardOf(root.id) };
  if (path === "event") await emit("thread.active", { thread: child });
  else {
    context.ctx.list = worldOf([root, child]).handler;
    running(context, child.id);
    await rerun(context, 1);
  }
  expect(cardOf(root.id)).toStrictEqual(before);
  const resumed = thr(root.id, { status: "active" });
  known.set(root.id, resumed);
  await emit("thread.active", { thread: resumed });
  expect(cardOf(root.id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", attention_reason: null, settled_at: null });
});

test.each(["idle", "active", "starting"])("child activity follows a resumed root with status %s", async (status) => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  const id = `failed-card-${status}`;
  await mirror(thr(id, { status: "active" }));
  known.set(id, thr(id, { status: "error" }));
  await emit("thread.failed", { thread: thr(id, { status: "error" }), error: "failure" });
  known.set(id, thr(id, { status }));
  const child = kid(`child-${id}`, id);
  known.set(child.id, child);
  context.ctx.list = worldOf([known.get(id), child]).handler;
  running(context, child.id);
  await emit("thread.active", { thread: child });
  await until(() => cardOf(id).run_state === "working");
  expect(cardOf(id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", attention_reason: null, settled_at: null });
});

test("completion preserves a concurrent read and respects concurrent settlement", async () => {
  const context = await startQuiet();
  const { cardOf, ctx, emit, mirror, rpc, known } = context;
  for (const action of ["read", "settle"]) {
    const id = `during-${action}`;
    const card = await mirror(thr(id, { status: "active" }));
    const gate = deferred<unknown[]>();
    let asked = false;
    let calls = 0;
    ctx.running = () => { calls += 1; asked = true; return calls === 1 ? gate.promise : []; };
    const thread = thr(id, { status: "idle", latestAttentionAt: Date.now() - 1000, lastReadAt: 0 });
    known.set(id, thread);
    const idle = emit("thread.idle", { thread });
    await until(() => asked);
    if (action === "read") await rpc("setTaskRead", { number: card.number, read: true });
    else await rpc("setTaskSettled", { number: card.number, settled: true });
    const readAt = cardOf(id).read_at;
    gate.resolve([]);
    await idle;
    if (action === "read") {
      expect(cardOf(id)).toMatchObject({ stage_id: "stage-progress", run_state: "working", read_at: readAt });
      ctx.list = worldOf([thread]).handler;
      await rpc("snapshot");
      expect(cardOf(id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", read_at: readAt, settled_at: expect.any(Number) });
    }
    else {
      expect(cardOf(id)).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: expect.any(Number) });
    }
  }
});

test("reconciliation completes while preserving a concurrent read", async () => {
  const context = await startQuiet();
  const { ctx, cardOf, mirror, rpc, known } = context;
  const card = await mirror(thr("reconcile-read", { status: "active" }));
  const thread = thr("reconcile-read", { status: "idle", latestAttentionAt: Date.now() - 1000, lastReadAt: 0 });
  known.set(thread.id, thread);
  ctx.list = worldOf([thread]).handler;
  const gate = deferred<unknown[]>();
  let calls = 0;
  ctx.running = () => (++calls === 2 ? gate.promise : []);
  context.db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE id = ?").run(card.id);
  await context.harness.behavior.setSettings({ autoCardThreads: false });
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => calls === 2);
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("reconcile-read").read_at;
  gate.resolve([]);
  await flush();
  await flush();
  expect(cardOf("reconcile-read")).toMatchObject({ stage_id: "stage-progress", run_state: "working", read_at: readAt });
  await rpc("snapshot");
  expect(cardOf("reconcile-read")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", read_at: readAt, settled_at: expect.any(Number) });
});

test("a concurrent read is retained when liveness lookup fails", async () => {
  const context = await startQuiet();
  const { cardOf, ctx, emit, mirror, rpc } = context;
  const card = await mirror(thr("read-failed-lookup", { status: "active" }));
  const gate = deferred<unknown[]>();
  let asked = false;
  ctx.running = async () => { asked = true; await gate.promise; throw new Error("lookup failed"); };
  const idle = emit("thread.idle", { thread: thr("read-failed-lookup", { status: "idle" }) });
  await until(() => asked);
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("read-failed-lookup").read_at;
  gate.resolve([]);
  await idle;
  expect(cardOf("read-failed-lookup")).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null, read_at: readAt });
});

test("child completion preserves stops and uncertain states while reconciling linked cards", async () => {
  const context = await startQuiet();
  const { db, emit, known, mirror, importManual, cardOf } = context;
  const failed = await mirror(thr("nw-failed", { status: "error" }));
  const stopped = await mirror(thr("nw-stopped", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(stopped.id);
  await mirror(thr("nw-idle", { status: "pending" }));
  const doneWorking = await mirror(thr("nw-done", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed' WHERE id = ?").run(doneWorking.id);
  known.set("nw-done", thr("nw-done", { status: "idle" }));
  await importManual(thr("nw-manual", { status: "pending" }));
  known.set("nw-nocard", thr("nw-nocard"));
  const before = Object.fromEntries(["nw-failed", "nw-stopped", "nw-idle", "nw-manual"].map((id) => [id, { ...cardOf(id) }]));
  for (const id of ["nw-failed", "nw-stopped", "nw-idle", "nw-done", "nw-manual", "nw-nocard"]) {
    known.set(`kid-${id}`, kid(`kid-${id}`, id));
    await emit("thread.idle", { thread: known.get(`kid-${id}`) });
  }
  await until(() => cardOf("nw-done").run_state === "completed");
  expect(failed.run_state).toBe("failed");
  for (const id of Object.keys(before)) expect(cardOf(id)).toStrictEqual(before[id]);
  expect(cardOf("nw-nocard")).toBeUndefined();
});

test("a root's own idle preserves native failure and an explicit stop", async () => {
  const context = await startQuiet();
  const { db, cardOf, emit, mirror } = context;
  await mirror(thr("own-failed", { status: "error" }));
  const stopped = await mirror(thr("own-stopped", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(stopped.id);
  await emit("thread.idle", { thread: thr("own-failed") });
  await emit("thread.idle", { thread: thr("own-stopped") });
  expect(cardOf("own-stopped").run_state).toBe("stopped");
  expect(cardOf("own-failed")).toMatchObject({ run_state: "failed", settled_at: null });
});

test("queued mirror cards do not become completed during reconciliation", async () => {
  const context = await startQuiet();
  const { db, mirror, cardOf, emit, rpc } = context;
  const card = await mirror(thr("queued-reconcile", { status: "pending" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'queued' WHERE id = ?").run(card.id);
  context.ctx.list = worldOf([thr("queued-reconcile", { status: "idle" })]).handler;
  await runPass(context, 4);
  expect(cardOf("queued-reconcile")).toMatchObject({ stage_id: "stage-todo", run_state: "queued", settled_at: null });
  await emit("thread.idle", { thread: thr("queued-reconcile", { status: "idle" }) });
  expect(cardOf("queued-reconcile")).toMatchObject({ run_state: "queued", settled_at: null });
  const custom = await rpc("createStage", { name: "Holding" });
  await rpc("moveTask", { number: card.number, stageId: custom.id });
  db.prepare("UPDATE triage_tasks SET run_state = 'queued', settled_at = NULL WHERE id = ?").run(card.id);
  await emit("thread.idle", { thread: thr("queued-reconcile", { status: "idle" }) });
  expect(cardOf("queued-reconcile")).toMatchObject({ stage_id: custom.id, run_state: "queued", settled_at: null });
});

test("a root's idle lookup that resolves after a sub-thread went active leaves the card working", async () => {
  const context = await startQuiet();
  const { ctx, cardOf, emit, known, mirror } = context;
  await mirror(thr("r1-root", { status: "active" }));
  known.set("r1-kid", kid("r1-kid", "r1-root"));
  const gate = deferred<unknown[]>();
  ctx.running = () => gate.promise;
  await sleep(3);
  const idle = emit("thread.idle", { thread: thr("r1-root") });
  await sleep(3);
  // The reopen touches the card after the idle handler read it.
  await emit("thread.active", { thread: known.get("r1-kid") });
  gate.resolve([]);
  await idle;
  expect(cardOf("r1-root")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
});

test("root idle tolerates a moved or deleted card while its old stage is deleted", async () => {
  const context = await startQuiet();
  const { ctx, cardOf, emit, mirror, rpc } = context;
  for (const action of ["move", "delete"]) {
    const id = `stale-idle-${action}`;
    const card = await mirror(thr(id, { status: "active" }));
    const stage = await rpc("createStage", { name: `Old ${action}` });
    await rpc("moveTask", { number: card.number, stageId: stage.id });
    const gate = deferred<unknown[]>();
    let asked = false;
    ctx.running = () => { asked = true; return gate.promise; };
    const idle = emit("thread.idle", { thread: thr(id) });
    await until(() => asked);
    if (action === "move") await rpc("moveTask", { number: card.number, stageId: "stage-attention" });
    else await rpc("deleteTask", { number: card.number });
    await rpc("deleteStage", { id: stage.id });
    gate.resolve([]);
    expect((await idle).errors).toStrictEqual([]);
    if (action === "move") expect(cardOf(id)).toMatchObject({ stage_id: "stage-attention", run_state: "working", settled_at: null });
    else expect(cardOf(id)).toBeUndefined();
  }
});

test("a sub-thread's active walk overtaken by idle completes after the walk finishes", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror, harness } = context;
  await mirror(thr("r2-root", { status: "active" }));
  known.set("r2-root", thr("r2-root", { status: "idle" }));
  known.set("r2-kid", kid("r2-kid", "r2-root"));
  context.ctx.list = worldOf([known.get("r2-root")]).handler;
  running(context);
  const gate = deferred<unknown>();
  let walks = 0;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) =>
    args.threadId === "r2-root" && ++walks === 1 ? gate.promise : known.get(args.threadId));
  const active = emit("thread.active", { thread: known.get("r2-kid") });
  await sleep(3);
  await emit("thread.idle", { thread: known.get("r2-kid") });
  expect(cardOf("r2-root").run_state).toBe("working");
  gate.resolve(known.get("r2-root"));
  await active;
  await until(() => cardOf("r2-root").run_state === "completed");
  expect(cardOf("r2-root")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
});

test("a sub-thread's active that is overtaken while its top-level card is being created leaves the new card unopened", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known } = context;
  known.set("r4-root", thr("r4-root", { status: "idle" }));
  known.set("r4-kid", kid("r4-kid", "r4-root"));
  const release = gateProjects(context);
  const active = emit("thread.active", { thread: known.get("r4-kid") });
  await sleep(5);
  const idle = emit("thread.idle", { thread: known.get("r4-kid") });
  await sleep(5);
  release();
  await active;
  await idle;
  await until(() => cardOf("r4-root").run_state === "completed");
  expect(cardOf("r4-root")).toMatchObject({ stage_id: "stage-completed", run_state: "completed" });
});

test("sub-thread events wait for their top-level card's creation in flight", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known } = context;
  const release = gateProjects(context);
  known.set("w-root", thr("w-root", { status: "idle" }));
  known.set("w-kid", kid("w-kid", "w-root"));
  context.ctx.list = worldOf([known.get("w-root"), known.get("w-kid")]).handler;
  running(context, "w-kid");
  void emit("thread.created", { thread: known.get("w-root") });
  await sleep(5);
  const active = emit("thread.active", { thread: known.get("w-kid") });
  await sleep(5);
  expect(cardOf("w-root")).toBeUndefined();
  release();
  await active;
  await until(() => cardOf("w-root")?.run_state === "working");
  expect(cardOf("w-root")).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  // The same wait on a child's end: creation delays completion of the card.
  const gate = gateProjects(context);
  known.set("e-root", thr("e-root", { status: "active" }));
  known.set("e-kid", kid("e-kid", "e-root"));
  void emit("thread.created", { thread: known.get("e-root") });
  await sleep(5);
  known.set("e-root", thr("e-root", { status: "idle" }));
  context.ctx.list = worldOf([known.get("w-root"), known.get("w-kid"), known.get("e-root")]).handler;
  running(context, "w-kid");
  const ended = emit("thread.idle", { thread: known.get("e-kid") });
  await sleep(5);
  gate();
  await ended;
  await until(() => cardOf("e-root")?.run_state === "completed");
  expect(cardOf("e-root")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
});

test("a failed card creation for a running sub-thread's top-level thread is logged, not thrown", async () => {
  const context = await startQuiet();
  const { db, cards, emit, known } = context;
  db.prepare("DELETE FROM triage_stages WHERE system_role = 'intake'").run();
  known.set("f-root", thr("f-root", { status: "idle" }));
  const result = await emit("thread.active", { thread: kid("f-kid", "f-root") });
  expect(result.errors).toStrictEqual([]);
  expect(cards()).toStrictEqual([]);
  expect(warned(context, "could not card session f-root")).toBe(true);
});

test("a top-level lookup that fails or finds nothing changes no card and warns", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror, harness } = context;
  await mirror(thr("l-root", { status: "active" }));
  const before = { ...cardOf("l-root") };
  running(context);
  // The parent is unknown to the host: threads.get answers nothing.
  await emit("thread.active", { thread: kid("l-kid", "ghost-parent") });
  await emit("thread.idle", { thread: kid("l-kid", "ghost-parent") });
  expect(warned(context, "could not find the top-level session of l-kid")).toBe(true);
  expect(warned(context, "session ghost-parent was not found")).toBe(true);
  harness.inspection.sdk.stub("threads.get", async () => { throw new Error("host down"); });
  known.set("l-kid2", kid("l-kid2", "l-root"));
  await emit("thread.active", { thread: known.get("l-kid2") });
  await emit("thread.archived", { thread: known.get("l-kid2") });
  expect(warned(context, "host down")).toBe(true);
  expect(cardOf("l-root")).toStrictEqual(before);
});

test("a failed running-threads lookup leaves child and root cards unchanged", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("q-root", { status: "active" }));
  known.set("q-root", thr("q-root", { status: "idle" }));
  await mirror(thr("q-own", { status: "active" }));
  known.set("q-kid", kid("q-kid", "q-root"));
  context.ctx.running = () => { throw new Error("listRunning down"); };
  const before = { ...cardOf("q-root") };
  await emit("thread.idle", { thread: known.get("q-kid") });
  expect(cardOf("q-root")).toStrictEqual(before);
  await until(() => warned(context, "could not look up running sessions: listRunning down"));
  expect(warned(context, "could not look up running sessions: listRunning down")).toBe(true);
  await emit("thread.idle", { thread: thr("q-own") });
  expect(cardOf("q-own")).toMatchObject({ run_state: "working", settled_at: null });
  // A lookup that fails inside the by-id list or the parent walk fails the same way.
  context.ctx.running = () => [{ id: "q-kid", hostId: null }];
  context.ctx.list = () => { throw new Error("list down"); };
  await emit("thread.failed", { thread: known.get("q-kid"), error: "x" });
  expect(cardOf("q-root")).toStrictEqual(before);
  await until(() => warned(context, "list down"));
  expect(warned(context, "list down")).toBe(true);
});

test("running threads resolve in chunks of 200 with both halves and hidden threads included", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("chunk-root", { status: "active" }));
  known.set("chunk-root", thr("chunk-root", { status: "idle" }));
  known.set("chunk-kid", kid("chunk-kid", "chunk-root"));
  running(context, ...Array.from({ length: 201 }, (_, index) => `run-${index}`));
  await emit("thread.idle", { thread: known.get("chunk-kid") });
  await until(() => cardOf("chunk-root").run_state === "completed");
  // threads.list takes at most 200 ids per call and archived is a selector (SDK ThreadListArgs).
  const lookups = idLookups(context).filter((args) => args.threadIds!.every((id) => id.startsWith("run-"))).slice(-8);
  expect(lookups.map((args) => args.threadIds!.length).sort((left, right) => left - right)).toStrictEqual([1, 1, 1, 1, 200, 200, 200, 200]);
  expect(lookups.filter((args) => args.archived === true).length).toBe(4);
  for (const args of lookups) expect(args).toMatchObject({ includeHidden: true, limit: 200 });
  expect(cardOf("chunk-root").run_state).toBe("completed");
});

test("the backfill gives a root with a running sub-thread the active stage and working, for an existing and a new card", async () => {
  const context = await startQuiet();
  const { cardOf, cards, eventsOf, known, mirror } = context;
  await mirror(thr("bf-existing", { status: "idle" }));
  known.set("bf-new", thr("bf-new", { status: "idle" }));
  known.set("bf-kid-a", kid("bf-kid-a", "bf-existing"));
  known.set("bf-kid-b", kid("bf-kid-b", "bf-new"));
  context.ctx.list = worldOf([thr("bf-existing"), known.get("bf-kid-a"), known.get("bf-kid-b")]).handler;
  running(context, "bf-kid-a", "bf-kid-b");
  await rerun(context, 2);
  for (const id of ["bf-existing", "bf-new"]) {
    expect(cardOf(id)).toMatchObject({ origin: "mirror", stage_id: "stage-progress", run_state: "working", settled_at: null });
  }
  expect(eventsOf(cardOf("bf-new").id)).toStrictEqual([{ actor: "bb", event: "backfilled" }]);
  expect(cards().map((card) => card.thread_id).sort()).toStrictEqual(["bf-existing", "bf-new"]);
});

test("the backfill skips a tombstoned or archived live root, and warns when a live root cannot be carded", async () => {
  const context = await startQuiet();
  const { db, cards, known } = context;
  db.prepare("INSERT INTO triage_mirror_tombstones (thread_id, created_at) VALUES ('bt-tomb', 1)").run();
  known.set("bt-tomb", thr("bt-tomb"));
  known.set("bt-archived", thr("bt-archived", { archivedAt: 5 }));
  known.set("bt-broken", thr("bt-broken"));
  const threads = [kid("bt-kid-1", "bt-tomb"), kid("bt-kid-2", "bt-archived"), kid("bt-kid-3", "bt-broken")];
  for (const thread of threads) known.set(thread.id, thread);
  context.ctx.list = worldOf(threads).handler;
  running(context, "bt-kid-1", "bt-kid-2", "bt-kid-3", "bt-archived");
  db.prepare("DELETE FROM triage_stages WHERE system_role = 'intake'").run();
  await rerun(context, 1);
  expect(cards()).toStrictEqual([]);
  expect(warned(context, "could not card session bt-broken")).toBe(true);
});

test("a failed running-threads lookup in the backfill and in reconcile writes nothing", async () => {
  const context = await startQuiet();
  const { cardOf, cards, known, mirror } = context;
  await mirror(thr("bl-root", { status: "active" }));
  known.set("bl-root", thr("bl-root", { status: "idle" }));
  known.set("bl-kid", kid("bl-kid", "bl-root"));
  context.ctx.list = worldOf([thr("bl-root"), known.get("bl-kid")]).handler;
  context.ctx.running = () => { throw new Error("listRunning down"); };
  const before = cards().map((card) => ({ ...card }));
  await rerun(context, 1);
  expect(cards()).toStrictEqual(before);
  expect(cardOf("bl-root")).toMatchObject({ run_state: "working", settled_at: null });
});

test("a pass that is switched off while it looks up running threads cards no live root", async () => {
  const context = await startQuiet();
  const { cards, known, harness } = context;
  known.set("bo-root", thr("bo-root"));
  known.set("bo-kid", kid("bo-kid", "bo-root"));
  context.ctx.list = worldOf([known.get("bo-kid")]).handler;
  const gate = deferred<unknown[]>();
  let asked = false;
  context.ctx.running = () => { asked = true; return gate.promise; };
  await harness.behavior.setSettings({ autoCardThreads: false });
  await sleep(3);
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => asked);
  await harness.behavior.setSettings({ autoCardThreads: false });
  gate.resolve([{ id: "bo-kid", hostId: null }]);
  await flush();
  await flush();
  expect(cards()).toStrictEqual([]);
});

test("reconcile completes idle system cards and retains custom placement", async () => {
  const context = await startQuiet();
  const { db, cardOf, known, mirror, rpc } = context;
  const ids = ["rs-settle", "rs-live", "rs-idlecard", "rs-active", "rs-attention", "rs-custom", "rs-done"];
  for (const id of ids) await mirror(thr(id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'idle' WHERE thread_id = 'rs-idlecard'").run();
  await rpc("moveTask", { number: cardOf("rs-attention").number, stageId: "stage-attention" });
  const custom = await rpc("createStage", { name: "Holding" });
  await rpc("moveTask", { number: cardOf("rs-custom").number, stageId: custom.id });
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed' WHERE thread_id = 'rs-done'").run();
  const threads = ids.map((id) => thr(id, { status: id === "rs-active" ? "active" : "idle" }));
  for (const thread of threads) known.set(thread.id, thread);
  known.set("rs-kid", kid("rs-kid", "rs-live"));
  context.ctx.list = worldOf([...threads, known.get("rs-kid")]).handler;
  running(context, "rs-kid", "rs-active");
  await rerun(context, 2);
  expect(cardOf("rs-settle")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
  expect(cardOf("rs-idlecard")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
  expect(cardOf("rs-attention")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
  expect(cardOf("rs-custom")).toMatchObject({ run_state: "completed", stage_id: custom.id, settled_at: null });
  expect(cardOf("rs-active")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
  expect(cardOf("rs-done")).toMatchObject({ run_state: "completed", stage_id: "stage-completed", settled_at: null });
  // The live root was reopened by the backfill: still working, still unsettled.
  expect(cardOf("rs-live")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
});

test("child completion follows native state while preserving custom placement", async () => {
  const context = await startQuiet();
  const { cardOf, known, emit, mirror, rpc, ctx } = context;
  const custom = await rpc("createStage", { name: "Holding" });
  for (const stageId of ["stage-attention", custom.id, "stage-progress"]) {
    const id = `child-end-${stageId}`;
    const card = await mirror(thr(id, { status: "active" }));
    await rpc("moveTask", { number: card.number, stageId });
    const root = thr(id, { status: "idle" });
    const child = kid(`${id}-child`, id, { status: "idle" });
    known.set(id, root);
    known.set(child.id, child);
    ctx.list = worldOf([root, child]).handler;
    await emit("thread.idle", { thread: child });
    await until(() => cardOf(id).run_state === "completed");
    expect(cardOf(id)).toMatchObject({ stage_id: stageId === custom.id ? custom.id : "stage-completed", attention_reason: null });
  }
});

test("reconcile leaves a card reopened after its candidates were read working", async () => {
  const context = await startQuiet();
  const { ctx, cardOf, emit, known, mirror } = context;
  await mirror(thr("rr-root", { status: "active" }));
  known.set("rr-root", thr("rr-root", { status: "idle" }));
  known.set("rr-kid", kid("rr-kid", "rr-root"));
  ctx.list = worldOf([thr("rr-root", { status: "idle" }), known.get("rr-kid")]).handler;
  const gate = deferred<unknown[]>();
  let calls = 0;
  // The backfill's own lookup answers at once; reconcile's waits.
  ctx.running = () => (++calls === 2 ? gate.promise : calls > 2 ? [{ id: "rr-kid", hostId: null }] : []);
  await sleep(3);
  await context.harness.behavior.setSettings({ autoCardThreads: false });
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => calls === 2);
  await sleep(3);
  await emit("thread.active", { thread: known.get("rr-kid") });
  gate.resolve([]);
  await flush();
  await flush();
  expect(cardOf("rr-root")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
});

test.each(["move", "delete"])("reconcile skips a %s card's removed stage and still completes later cards", async (action) => {
  const context = await startQuiet();
  const { ctx, cardOf, mirror, rpc, harness, db, known } = context;
  const stale = await mirror(thr("stale-reconcile", { status: "active" }));
  await mirror(thr("later-reconcile", { status: "active" }));
  const stage = await rpc("createStage", { name: "Old reconcile" });
  await rpc("moveTask", { number: stale.number, stageId: stage.id });
  const threads = [thr("stale-reconcile", { status: "idle" }), thr("later-reconcile", { status: "idle" })];
  for (const thread of threads) known.set(thread.id, thread);
  ctx.list = worldOf(threads).handler;
  const gate = deferred<unknown[]>();
  let calls = 0;
  ctx.running = () => (++calls === 2 ? gate.promise : []);
  db.prepare("UPDATE triage_tasks SET created_at = 1 WHERE thread_id IN (?, ?)").run("stale-reconcile", "later-reconcile");
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => calls >= 2);
  if (action === "move") await rpc("moveTask", { number: stale.number, stageId: "stage-attention" });
  else await rpc("deleteTask", { number: stale.number });
  await rpc("deleteStage", { id: stage.id });
  gate.resolve([]);
  await until(() => cardOf("later-reconcile").run_state === "completed");
  if (action === "move") expect(cardOf("stale-reconcile")).toMatchObject({ stage_id: "stage-attention", run_state: "working", settled_at: null });
  else expect(cardOf("stale-reconcile")).toBeUndefined();
  expect(cardOf("later-reconcile")).toMatchObject({ stage_id: "stage-completed", run_state: "completed", settled_at: null });
});

test.each(["manual", "mirror"] as const)("Reminder preserves %s placement across lifecycle and archive", async (origin) => {
  const { mirror, importManual, rpc, cardOf, cards, ctx, known, emit, emitNative } = await startQuiet();
  const thread = thr(`reminder-${origin}`, { status: "idle" });
  const card = origin === "manual" ? await importManual(thread) : await mirror(thread);
  ctx.list = worldOf([thread]).handler;
  await emitNative("thread.idle", { thread });
  expect(cardOf(thread.id).stage_id).not.toBe("stage-reminder");
  await rpc("moveTask", { number: card.number, stageId: "stage-reminder" });
  await emitNative("thread.idle", { thread });
  expect(cardOf(thread.id).stage_id).toBe("stage-reminder");
  expect((await rpc("snapshot")).tasks.some((task: any) => task.number === card.number)).toBe(true);
  const archived = { ...thread, archivedAt: 1 };
  known.set(thread.id, archived);
  ctx.list = worldOf([archived]).handler;
  await emit("thread.archived", { thread: archived });
  expect((await rpc("snapshot")).tasks.some((task: any) => task.number === card.number)).toBe(false);
  known.set(thread.id, thread);
  ctx.list = worldOf([thread]).handler;
  await emitNative("thread.unarchived", { thread });
  expect((await rpc("snapshot")).tasks.find((task: any) => task.number === card.number)?.stageId).toBe("stage-reminder");
  await emit("thread.deleted", { thread: { ...thread, deletedAt: 1 } });
  if (origin === "manual") expect(cards().find((row: any) => row.id === card.id)).toMatchObject({ thread_id: null, stage_id: "stage-todo", run_state: "stopped" });
  else expect(cards().find((row: any) => row.id === card.id)).toBeUndefined();
});

test("Reminder snapshot excludes unlinked and unknown threads", async () => {
  const { db, importManual, rpc, ctx } = await startQuiet();
  const thread = thr("missing-reminder");
  const card = await importManual(thread);
  await rpc("moveTask", { number: card.number, stageId: "stage-reminder" });
  ctx.list = worldOf([]).handler;
  expect((await rpc("snapshot")).tasks.some((task: any) => task.id === card.id)).toBe(false);
  db.prepare("UPDATE triage_tasks SET thread_id = NULL WHERE id = ?").run(card.id);
  expect((await rpc("snapshot")).tasks.some((task: any) => task.id === card.id)).toBe(false);
});

test.each(["moveTask", "updateTask"])("Reminder %s rejects a thread unlinked during lookup", async (method) => {
  const { db, harness, importManual, rpc } = await startQuiet();
  const thread = thr("reminder-race");
  const card = await importManual(thread);
  const gate = deferred<any>();
  let lookupStarted = false;
  harness.inspection.sdk.stub("threads.get", async () => { lookupStarted = true; return gate.promise; });
  const before = db.prepare("SELECT stage_id FROM triage_tasks WHERE id = ?").get(card.id) as { stage_id: string };
  const pending = rpc(method, method === "moveTask"
    ? { number: card.number, stageId: "stage-reminder" }
    : { number: card.number, stageId: "stage-reminder", title: card.title, description: card.description, scheduledAt: null });
  await until(() => lookupStarted);
  db.prepare("UPDATE triage_tasks SET thread_id = NULL WHERE id = ?").run(card.id);
  gate.resolve(thread);
  await expect(pending).rejects.toThrow("Only unarchived threads can move to Reminder");
  expect(db.prepare("SELECT stage_id FROM triage_tasks WHERE id = ?").get(card.id)).toEqual(before);
});

test("a no-ID background event updates Reminder when the descendant response omits the root", async () => {
  const context = await startQuiet();
  const root = thr("reminder-background-missing-tree", { status: "idle" });
  const card = await context.importManual(root);
  await context.rpc("moveTask", { number: card.number, stageId: "stage-reminder" });
  const active = { ...root, activity: { ...root.activity, activeBackgroundCommandCount: 1 } };
  context.known.set(root.id, active);
  context.ctx.list = worldOf([active]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async () => ({ threads: [] }));
  context.ctx.readChanged({ changes: [], metadata: { backgroundActivityChanged: true } });
  await until(() => context.cardOf(root.id).run_state === "working");
  expect(context.cardOf(root.id).stage_id).toBe("stage-reminder");
});

test("background descendant keeps Reminder active when the root is absent from list", async () => {
  const context = await startQuiet();
  const root = thr("reminder-background-unlisted-root", { status: "idle" });
  const child = thr("reminder-background-unlisted-child", { status: "idle", parentThreadId: root.id, activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  const card = await context.importManual(root);
  await context.rpc("moveTask", { number: card.number, stageId: "stage-reminder" });
  context.known.set(child.id, child);
  context.ctx.list = worldOf([child]).handler;
  context.harness.inspection.sdk.stub("threads.experimental_listDescendants", async ({ threadIds }: DescendantArgs) => ({ threads: threadIds.map((threadId) => ({ threadId, descendantIds: [child.id] })) }));
  await context.emit("thread.idle", { thread: root });
  expect(context.cardOf(root.id)).toMatchObject({ stage_id: "stage-reminder", run_state: "working" });
});

test("backfill keeps a Reminder child active without marking its untracked ancestor", async () => {
  const context = await startQuiet({ settings: { autoCardThreads: false } });
  const root = thr("reminder-untracked-parent", { status: "idle" });
  const child = thr("reminder-tracked-child", { status: "idle", parentThreadId: root.id, activity: { activeBackgroundCommandCount: 1, activeBackgroundAgentCount: 0 } });
  context.known.set(root.id, root);
  const card = await context.importManual(child);
  await context.rpc("moveTask", { number: card.number, stageId: "stage-reminder" });
  context.ctx.list = worldOf([child]).handler;
  await context.harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => context.cardOf(child.id).run_state === "working");
  expect(context.cardOf(child.id)).toMatchObject({ stage_id: "stage-reminder", run_state: "working" });
  expect(context.cardOf(root.id)).toBeUndefined();
});
