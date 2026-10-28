import { afterEach, expect, test, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

// Provenance for the threads.list quirks pinned below: the SDK bundled-types
// ThreadListArgs doc, node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts:18210-18232
// (threadIds capped at 200 per call, unknown and deleted ids dropped) plus the
// ThreadListArgs fields (archived is a selector, includeHidden gates hidden
// sessions; there is no sort parameter).

type ListArgs = { threadIds?: readonly string[]; archived?: boolean; includeHidden?: boolean; limit?: number; offset?: number };
type ListHandler = (args: ListArgs) => unknown;

const thr = (id: string, overrides: Record<string, unknown> = {}) =>
  makeThreadResponse({ id, projectId: "project-1", title: `Session ${id}`, ...overrides });

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
  const ctx = { list: options.list ?? ((): unknown => []) };
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    settings: options.settings,
    sdk: {
      threads: {
        get: async (args: { threadId: string }) => known.get(args.threadId),
        list: async (args: ListArgs = {}) => ctx.list(args) as any,
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
  const rpc = (method: string, input: unknown = null) =>
    harness.behavior.callRpc(method, input) as Promise<Record<string, any>>;
  const mirror = async (thread: any) => {
    known.set(thread.id, thread);
    await emit("thread.created", { thread });
    await until(() => cardOf(thread.id) !== undefined);
    return cardOf(thread.id);
  };
  const importManual = async (thread: any) => {
    known.set(thread.id, thread);
    return rpc("importThread", { threadId: thread.id });
  };
  return { bb, harness, db, ctx, known, cardOf, cards, eventsOf, notifications, emit, rpc, mirror, importManual };
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
    model: "Default model", run_state: "idle", stage_id: "stage-todo", settled_at: null, request_json: "null",
  });
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
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
  const calls = harness.inspection.sdk.callsTo("threads.list").slice(listCallsBefore) as [ListArgs][];
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
  // Off while cards are being created: the current session finishes, the rest wait.
  let lookups = 0;
  harness.inspection.sdk.stub("projects.get", async (args: { projectId: string }) => {
    lookups += 1;
    if (lookups === 3) await harness.behavior.setSettings({ autoCardThreads: false });
    return { id: args.projectId, name: args.projectId };
  });
  ctx.list = (args) => (args.offset === 0 ? sessions : []);
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cards().length === 3);
  await flush();
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["m-1", "m-2", "m-3"]);
  // On again: the pass resumes and cards only what is still missing.
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => cards().length === 6);
});

test("a second pass requested while one is running is dropped", async () => {
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
  // One pass: the page, then the empty page that ends it.
  expect(harness.inspection.sdk.callsTo("threads.list").length).toBe(2);
});

test("thread.archived settles a mirror card and leaves manual cards and unknown sessions alone", async () => {
  const { cardOf, emit, mirror, importManual, rpc } = await start();
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
  expect(cardOf("a-idle")).toMatchObject({ run_state: "idle" });
  expect(cardOf("a-idle").settled_at).toBeGreaterThan(0);
});

test("thread.unarchived creates a missing mirror card and reopens a settled one", async () => {
  const { harness, cardOf, cards, emit, mirror } = await start();
  await emit("thread.unarchived", { thread: thr("u-new", { status: "active" }) });
  expect(cardOf("u-new")).toMatchObject({ origin: "mirror", settled_at: null });
  await mirror(thr("u-old"));
  await emit("thread.archived", { thread: thr("u-old", { archivedAt: 9 }) });
  expect(cardOf("u-old").settled_at).toBeGreaterThan(0);
  await emit("thread.unarchived", { thread: thr("u-old") });
  expect(cardOf("u-old").settled_at).toBe(null);
  // Sessions Triage spawned itself, and any session while the knob is off, get no new card.
  await emit("thread.unarchived", { thread: thr("u-own", { originPluginId: "triage" }) });
  await harness.behavior.setSettings({ autoCardThreads: false });
  await emit("thread.unarchived", { thread: thr("u-off") });
  expect(cards().map((card) => card.thread_id)).toStrictEqual(["u-new", "u-old"]);
  // An existing mirror card still reopens with the knob off.
  await emit("thread.archived", { thread: thr("u-old", { archivedAt: 9 }) });
  await emit("thread.unarchived", { thread: thr("u-old") });
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
  expect(eventsOf(mirrorCard.id).length).toBe(1);
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

test("agent configuration: mirror cards get nothing, manual cards get the stage tool", async () => {
  const { harness, mirror, importManual } = await start();
  await mirror(thr("c-mirror"));
  await importManual(thr("c-manual"));
  const configFor = (id: string) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id } }));
  expect(await configFor("c-mirror")).toMatchObject({ tools: [], skills: [], instructions: null });
  const manual = await configFor("c-manual");
  expect(JSON.stringify(manual)).toContain("triage_move_task");
  expect(JSON.stringify(manual)).toContain("You own Triage #");
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

test("an idle turn on a mirror card changes its run state and nothing else", async () => {
  const { cardOf, notifications, eventsOf, emit, mirror, rpc } = await start();
  const card = await mirror(thr("i-1", { status: "active" }));
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("i-1").read_at;
  expect(readAt).toBeGreaterThan(0);
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ run_state: "idle", read_at: readAt });
  expect(notifications()).toStrictEqual([]);
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
  // A mirror card the user moved to the done stage keeps its completed state.
  await rpc("moveTask", { number: card.number, stageId: "stage-completed" });
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ run_state: "completed" });
  expect(notifications()).toStrictEqual([]);
});

test("an active turn refreshes a mirror card's title, provider and machine without history or notices", async () => {
  const { harness, cardOf, notifications, eventsOf, emit, mirror } = await start();
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
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
  expect(notifications()).toStrictEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
});

test("a failed turn on a mirror card lands in attention silently", async () => {
  const { cardOf, notifications, eventsOf, emit, mirror } = await start();
  const card = await mirror(thr("f-1", { status: "active" }));
  await emit("thread.failed", { thread: thr("f-1"), error: "  Provider crashed  " });
  expect(cardOf("f-1")).toMatchObject({ stage_id: "stage-attention", run_state: "failed", attention_reason: "Provider crashed" });
  expect(notifications()).toStrictEqual([]);
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
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
    { actor: "user", event: "moved session to triage" },
  ]);
  expect(harness.inspection.sdk.callsTo("threads.update").map(([args]: any) => [args.threadId, args.visibility]))
    .toStrictEqual([["h-1", "hidden"]]);
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "h-1" } }));
  expect(JSON.stringify(config)).toContain("triage_move_task");
});

test("the snapshot reads sessions in chunked list calls with an archived companion, never threads.get", async () => {
  const sessions = Array.from({ length: 250 }, (_, index) =>
    thr(`b-${index + 1}`, { createdAt: index + 1, visibility: "hidden", environmentId: null }));
  const archivedIds = new Set<string>();
  let rejected: readonly string[] = [];
  const handler: ListHandler = (args) => {
    if (args.threadIds) {
      // The smaller chunk's live call fails; the other chunk and every
      // companion call must still answer.
      if (!args.archived && args.threadIds.length === 50) {
        rejected = args.threadIds;
        throw new Error("Batch failed");
      }
      return sessions
        .filter((session) => args.threadIds!.includes(session.id))
        .filter((session) => archivedIds.has(session.id) === Boolean(args.archived))
        .map((session) => (session.id === "b-7" ? { ...session, visibility: "visible" } : session));
    }
    const offset = args.offset ?? 0;
    return sessions.slice(offset, offset + 200);
  };
  const { harness, cards, rpc } = await start({ list: handler });
  await until(() => cards().length === 250);
  await flush();
  harness.inspection.sdk.stub("projects.list", async () => []);
  harness.inspection.sdk.stub("hosts.list", async () => []);
  const before = harness.inspection.sdk.callsTo("threads.list").length;
  archivedIds.add("b-7");
  const snapshot = await rpc("snapshot");
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
  expect(harness.inspection.sdk.callsTo("threads.get").length).toBe(0);
  // One chunk rejecting degrades only its own cards; the other chunk still renders.
  const visibility = new Map<string, boolean | null>(snapshot.tasks.map((task: any) => [task.threadId, task.sidebarVisible]));
  const unknown = [...visibility].filter(([, visible]) => visible === null).map(([id]) => id).sort();
  expect(unknown).toStrictEqual(rejected.filter((id) => id !== "b-7").sort());
  expect(unknown.length).toBe(49);
  expect([...visibility.values()].filter((visible) => visible === false).length).toBe(200);
  // The archived id only exists in its companion call's results and is merged in.
  expect(visibility.get("b-7")).toBe(true);
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
  const { harness, emit, mirror } = await start();
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
