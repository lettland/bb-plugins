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
  const ctx = {
    list: options.list ?? ((): unknown => []),
    // threads.listRunning: only threads in starting or active (SDK bundled-types ThreadsArea.listRunning).
    running: ((): unknown => []) as () => unknown,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    settings: options.settings,
    sdk: {
      threads: {
        get: async (args: { threadId: string }) => known.get(args.threadId),
        list: async (args: ListArgs = {}) => ctx.list(args) as any,
        listRunning: async () => ctx.running() as any,
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

test("thread.unarchived creates a missing mirror card and reopens it only when the session is running", async () => {
  const { harness, cardOf, cards, emit, mirror } = await start();
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

test("an idle turn on a mirror card settles it and changes nothing else", async () => {
  const { cardOf, notifications, eventsOf, emit, mirror, rpc } = await start();
  const card = await mirror(thr("i-1", { status: "active" }));
  await rpc("setTaskRead", { number: card.number, read: true });
  const readAt = cardOf("i-1").read_at;
  expect(readAt).toBeGreaterThan(0);
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ run_state: "idle", read_at: readAt });
  expect(cardOf("i-1").settled_at).toBeGreaterThan(0);
  expect(notifications()).toStrictEqual([]);
  expect(eventsOf(card.id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
  // A mirror card the user moved to the done stage keeps its completed state.
  await rpc("moveTask", { number: card.number, stageId: "stage-completed" });
  // It stays visible in the done column: the early return does not settle it.
  await rpc("setTaskSettled", { number: card.number, settled: false });
  await emit("thread.idle", { thread: thr("i-1"), lastAssistantText: "Done" });
  expect(cardOf("i-1")).toMatchObject({ run_state: "completed", settled_at: null });
  // A failure has no done-stage exception: the card still settles.
  await emit("thread.failed", { thread: thr("i-1"), error: "boom" });
  expect(cardOf("i-1").settled_at).toBeGreaterThan(0);
  expect(notifications()).toStrictEqual([]);
});

test("an idle mirror card keeps its first settled time, and reopens when its session is active again", async () => {
  const { db, cardOf, emit, mirror } = await start();
  await mirror(thr("r-1", { status: "active" }));
  await emit("thread.active", { thread: thr("r-1") });
  expect(cardOf("r-1")).toMatchObject({ stage_id: "stage-progress", settled_at: null });
  await emit("thread.idle", { thread: thr("r-1"), lastAssistantText: "Done" });
  expect(cardOf("r-1").settled_at).toBeGreaterThan(0);
  // COALESCE: a second idle turn does not move the settled time.
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

test("a failed turn retains a card's stage and history without an attention notice", async () => {
  const { cardOf, notifications, eventsOf, emit, mirror } = await start();
  const card = await mirror(thr("f-1", { status: "active" }));
  await emit("thread.failed", { thread: thr("f-1"), error: "  Provider crashed  " });
  expect(cardOf("f-1")).toMatchObject({ stage_id: "stage-progress", run_state: "failed", attention_reason: "Provider crashed" });
  expect(cardOf("f-1").settled_at).toBeGreaterThan(0);
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
    { actor: "user", event: "moved session to triage" },
  ]);
  expect(harness.inspection.sdk.callsTo("threads.update").map(([args]: any) => [args.threadId, args.visibility]))
    .toStrictEqual([["h-1", "hidden"]]);
  const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "h-1" } }));
  expect(JSON.stringify(config)).toContain("triage_move_task");
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
  archivedIds.add("b-7");
  await expect(rpc("snapshot")).rejects.toThrow(/Batch failed/);
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

test("a failure that arrives while the card is still being created settles the card and marks it failed", async () => {
  const context = await start();
  const { cardOf, emit } = context;
  const release = gateProjects(context);
  await emit("thread.created", { thread: thr("race-failed", { status: "pending" }) });
  const failing = emit("thread.failed", { thread: thr("race-failed"), error: "boom" });
  await flush();
  expect(cardOf("race-failed")).toBeUndefined();
  release();
  await failing;
  expect(cardOf("race-failed")).toMatchObject({ origin: "mirror", run_state: "failed", attention_reason: "boom" });
  expect(cardOf("race-failed").settled_at).toBeGreaterThan(0);
});

test("a deletion that arrives while the card is still being created leaves no card", async () => {
  const context = await start();
  const { cardOf, cards, emit } = context;
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
  const { cardOf, cards, emit } = context;
  const cases = [
    { event: "thread.active", extra: {}, check: (card: any) => expect(card).toMatchObject({ stage_id: "stage-progress", run_state: "working", settled_at: null }) },
    { event: "thread.idle", extra: { lastAssistantText: "Done" }, check: (card: any) => { expect(card.run_state).toBe("idle"); expect(card.settled_at).toBeGreaterThan(0); } },
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
  const { harness, cardOf, emit } = await start();
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

test("events for a thread with no creation in flight are handled synchronously", async () => {
  const { cardOf, emit, mirror } = await start();
  await mirror(thr("sync-1", { status: "active" }));
  await flush();
  // A top-level idle asks which threads still run, so it settles after that lookup.
  await emit("thread.idle", { thread: thr("sync-1"), lastAssistantText: "Done" });
  expect(cardOf("sync-1")).toMatchObject({ run_state: "idle" });
  expect(cardOf("sync-1").settled_at).toBeGreaterThan(0);
  // No await between the emit and the check: the handler did not defer.
  void emit("thread.failed", { thread: thr("sync-1"), error: "late" });
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
  const { handler } = worldOf([
    thr("rc-softdeleted", { status: "idle", deletedAt: 9 }),
    thr("rc-error", { status: "error" }),
    thr("rc-idle", { status: "idle" }),
    thr("rc-archived", { status: "idle", archivedAt: 9 }),
    thr("rc-active", { status: "active" }),
    thr("rc-starting", { status: "starting" }),
  ]);
  context.ctx.list = handler;
  await runPass(context, 4);
  expect((harness.inspection.sdk.callsTo("threads.get") as [{ threadId: string }][]).map(([args]) => args.threadId).sort())
    .toStrictEqual(["rc-getfails", "rc-gone", "rc-omitted", "rc-unanswered"]);
  expect(cardOf("rc-gone")).toBeUndefined();
  expect(eventCount(db, goneId)).toBe(0);
  expect(cardOf("rc-softdeleted")).toBeUndefined();
  expect(tombstones(db)).toStrictEqual([]);
  // Not confirmed deleted: the card and its history stay, settled off the board.
  for (const id of ["rc-unanswered", "rc-getfails"]) {
    expect(cardOf(id)).toMatchObject({ stage_id: "stage-todo", run_state: "idle" });
    expect(cardOf(id).settled_at).toBeGreaterThan(0);
  }
  expect(eventCount(db, unansweredId)).toBe(1);
  expect(harness.logEntries.some((entry: any) =>
    entry.level === "warn" && entry.message.includes("could not confirm session rc-getfails"))).toBe(true);
  expect(harness.logEntries.some((entry: any) => entry.message.includes("could not confirm session rc-unanswered"))).toBe(false);
  expect(cardOf("rc-error")).toMatchObject({ run_state: "failed", attention_reason: "The assigned BB thread failed.", stage_id: "stage-todo" });
  expect(cardOf("rc-error").settled_at).toBeGreaterThan(0);
  expect(cardOf("rc-idle")).toMatchObject({ run_state: "idle", stage_id: "stage-todo" });
  expect(cardOf("rc-idle").settled_at).toBeGreaterThan(0);
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
  await harness.behavior.setSettings({ autoCardThreads: false });
  await harness.behavior.setSettings({ autoCardThreads: true });
  await until(() => harness.inspection.sdk.callsTo("threads.list").length >= 1);
  // Born while the pass is paging; the host does not list it, so it would look gone.
  await new Promise((resolve) => setTimeout(resolve, 3));
  await mirror(thr("born-during", { status: "pending" }));
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

test("reconcile keeps the stage of a mirror card the user moved out of intake", async () => {
  const context = await start();
  const { cardOf, mirror, rpc } = context;
  for (const id of ["mv-idle", "mv-error", "mv-active"]) {
    const card = await mirror(thr(id, { status: "pending" }));
    await rpc("moveTask", { number: card.number, stageId: "stage-progress" });
  }
  const before = ["mv-idle", "mv-error", "mv-active"].map((id) => ({ ...cardOf(id) }));
  const { handler } = worldOf([
    thr("mv-idle", { status: "idle" }),
    thr("mv-error", { status: "error" }),
    thr("mv-active", { status: "active" }),
  ]);
  context.ctx.list = handler;
  await runPass(context, 4);
  expect(["mv-idle", "mv-error", "mv-active"].map((id) => cardOf(id))).toStrictEqual(before);
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

test("a sub-thread going active reopens its settled top-level card as working, with no card, history or notice of its own", async () => {
  const context = await startQuiet();
  const { db, cards, cardOf, eventsOf, notifications, emit, known, mirror } = context;
  const root = await mirror(thr("root-1", { status: "active" }));
  known.set("kid-1", kid("kid-1", "root-1"));
  running(context);
  await emit("thread.idle", { thread: thr("root-1") });
  expect(cardOf("root-1")).toMatchObject({ run_state: "idle" });
  expect(cardOf("root-1").settled_at).toBeGreaterThan(0);
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-todo', attention_reason = 'needs you' WHERE id = ?").run(root.id);
  const history = eventsOf(root.id);
  await emit("thread.active", { thread: known.get("kid-1") });
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
  await emit("thread.active", { thread: known.get("kid-2") });
  expect(cardOf("root-2")).toMatchObject({ origin: "mirror", stage_id: "stage-progress", run_state: "working", settled_at: null });
  expect(eventsOf(cardOf("root-2").id)).toStrictEqual([{ actor: "bb", event: "mirrored" }]);
  expect(cards().length).toBe(1);
});

test("a grandchild going active reopens the top-level card, and a parent cycle ends the walk without a card", async () => {
  const context = await startQuiet();
  const { cards, cardOf, emit, known, mirror, harness } = context;
  await mirror(thr("root-3", { status: "pending" }));
  known.set("mid-3", thr("mid-3", { parentThreadId: "root-3" }));
  known.set("leaf-3", kid("leaf-3", "mid-3"));
  await emit("thread.active", { thread: known.get("leaf-3") });
  expect(cardOf("root-3")).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  const lookups = harness.inspection.sdk.callsTo("threads.get").length;
  // c -> a -> b -> a: the walk stops at b, which still has a parent, so nothing is carded.
  known.set("cyc-a", thr("cyc-a", { parentThreadId: "cyc-b" }));
  known.set("cyc-b", thr("cyc-b", { parentThreadId: "cyc-a" }));
  const result = await emit("thread.active", { thread: kid("cyc-c", "cyc-a") });
  expect(result.errors).toStrictEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.get").length - lookups).toBe(2);
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
  known.set("kid-stopped", kid("kid-stopped", "root-stopped"));
  await emit("thread.active", { thread: known.get("kid-done") });
  await emit("thread.active", { thread: known.get("kid-stopped") });
  expect(cardOf("root-done")).toStrictEqual(before.done);
  expect(cardOf("root-stopped")).toStrictEqual(before.stopped);
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

test("a sub-thread going idle, failed, archived or deleted settles the top-level card when nothing else runs, adding no attention", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  running(context);
  for (const event of ["thread.idle", "thread.failed", "thread.archived", "thread.deleted"]) {
    const rootId = `root-${event}`;
    await mirror(thr(rootId, { status: "active" }));
    known.set(`kid-${event}`, kid(`kid-${event}`, rootId));
    await emit(event, { thread: known.get(`kid-${event}`), error: "boom" });
    expect(cardOf(rootId)).toMatchObject({ stage_id: "stage-progress", run_state: "idle", attention_reason: null });
    expect(cardOf(rootId).settled_at).toBeGreaterThan(0);
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

test("a thread listRunning names but the host now lists as idle is not live, so the root card settles", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("root-stop", { status: "active" }));
  known.set("kid-stop", kid("kid-stop", "root-stop"));
  running(context, "kid-stop");
  context.ctx.list = worldOf([thr("kid-stop", { parentThreadId: "root-stop", status: "idle" })]).handler;
  await emit("thread.idle", { thread: known.get("kid-stop") });
  expect(cardOf("root-stop")).toMatchObject({ stage_id: "stage-progress", run_state: "idle" });
  expect(cardOf("root-stop").settled_at).toBeGreaterThan(0);
});

test("a child end under a card that is not working, failed, stopped, done, manual or missing makes no lookup", async () => {
  const context = await startQuiet();
  const { db, emit, known, mirror, importManual, cardOf } = context;
  const failed = await mirror(thr("nw-failed", { status: "error" }));
  const stopped = await mirror(thr("nw-stopped", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(stopped.id);
  await mirror(thr("nw-idle", { status: "pending" }));
  const doneWorking = await mirror(thr("nw-done", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET stage_id = 'stage-completed' WHERE id = ?").run(doneWorking.id);
  await importManual(thr("nw-manual", { status: "pending" }));
  known.set("nw-nocard", thr("nw-nocard"));
  const before = ["nw-failed", "nw-stopped", "nw-idle", "nw-done", "nw-manual"].map((id) => ({ ...cardOf(id) }));
  const asked = runningCalls(context);
  for (const id of ["nw-failed", "nw-stopped", "nw-idle", "nw-done", "nw-manual", "nw-nocard"]) {
    known.set(`kid-${id}`, kid(`kid-${id}`, id));
    await emit("thread.idle", { thread: known.get(`kid-${id}`) });
  }
  expect(failed.run_state).toBe("failed");
  expect(["nw-failed", "nw-stopped", "nw-idle", "nw-done", "nw-manual"].map((id) => cardOf(id))).toStrictEqual(before);
  expect(runningCalls(context)).toBe(asked);
});

test("a root's own idle on a failed or stopped card keeps today's path and asks nothing", async () => {
  const context = await startQuiet();
  const { db, cardOf, emit, mirror } = context;
  await mirror(thr("own-failed", { status: "error" }));
  const stopped = await mirror(thr("own-stopped", { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'stopped' WHERE id = ?").run(stopped.id);
  const asked = runningCalls(context);
  await emit("thread.idle", { thread: thr("own-failed") });
  await emit("thread.idle", { thread: thr("own-stopped") });
  expect(cardOf("own-stopped").run_state).toBe("stopped");
  expect(cardOf("own-failed").settled_at).toBeGreaterThan(0);
  expect(runningCalls(context)).toBe(asked);
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

test("a sub-thread's active walk that resolves after its idle settled the card leaves the card settled", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror, harness } = context;
  await mirror(thr("r2-root", { status: "active" }));
  known.set("r2-kid", kid("r2-kid", "r2-root"));
  running(context);
  const gate = deferred<unknown>();
  let walks = 0;
  harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) =>
    args.threadId === "r2-root" && ++walks === 1 ? gate.promise : known.get(args.threadId));
  const active = emit("thread.active", { thread: known.get("r2-kid") });
  await sleep(3);
  await emit("thread.idle", { thread: known.get("r2-kid") });
  expect(cardOf("r2-root").run_state).toBe("idle");
  gate.resolve(known.get("r2-root"));
  await active;
  expect(cardOf("r2-root")).toMatchObject({ run_state: "idle", stage_id: "stage-progress" });
  expect(cardOf("r2-root").settled_at).toBeGreaterThan(0);
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
  expect(cardOf("r4-root")).toMatchObject({ stage_id: "stage-todo", run_state: "idle" });
});

test("sub-thread events wait for their top-level card's creation in flight", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known } = context;
  const release = gateProjects(context);
  known.set("w-root", thr("w-root", { status: "idle" }));
  known.set("w-kid", kid("w-kid", "w-root"));
  void emit("thread.created", { thread: known.get("w-root") });
  await sleep(5);
  const active = emit("thread.active", { thread: known.get("w-kid") });
  await sleep(5);
  expect(cardOf("w-root")).toBeUndefined();
  release();
  await active;
  expect(cardOf("w-root")).toMatchObject({ stage_id: "stage-progress", run_state: "working" });
  // The same wait on a child's end: a creation in flight delays it, then the card settles.
  const gate = gateProjects(context);
  known.set("e-root", thr("e-root", { status: "active" }));
  known.set("e-kid", kid("e-kid", "e-root"));
  void emit("thread.created", { thread: known.get("e-root") });
  await sleep(5);
  const ended = emit("thread.idle", { thread: known.get("e-kid") });
  await sleep(5);
  gate();
  await ended;
  expect(cardOf("e-root")).toMatchObject({ run_state: "idle" });
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

test("a failed running-threads lookup leaves a child end unchanged and settles a root's own idle as before", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("q-root", { status: "active" }));
  await mirror(thr("q-own", { status: "active" }));
  known.set("q-kid", kid("q-kid", "q-root"));
  context.ctx.running = () => { throw new Error("listRunning down"); };
  const before = { ...cardOf("q-root") };
  await emit("thread.idle", { thread: known.get("q-kid") });
  expect(cardOf("q-root")).toStrictEqual(before);
  expect(warned(context, "could not look up running sessions: listRunning down")).toBe(true);
  await emit("thread.idle", { thread: thr("q-own") });
  expect(cardOf("q-own")).toMatchObject({ run_state: "idle" });
  expect(cardOf("q-own").settled_at).toBeGreaterThan(0);
  // A lookup that fails inside the by-id list or the parent walk fails the same way.
  context.ctx.running = () => [{ id: "q-kid", hostId: null }];
  context.ctx.list = () => { throw new Error("list down"); };
  await emit("thread.failed", { thread: known.get("q-kid"), error: "x" });
  expect(cardOf("q-root")).toStrictEqual(before);
  expect(warned(context, "list down")).toBe(true);
});

test("running threads resolve in chunks of 200 with both halves and hidden threads included", async () => {
  const context = await startQuiet();
  const { cardOf, emit, known, mirror } = context;
  await mirror(thr("chunk-root", { status: "active" }));
  known.set("chunk-kid", kid("chunk-kid", "chunk-root"));
  running(context, ...Array.from({ length: 201 }, (_, index) => `run-${index}`));
  await emit("thread.idle", { thread: known.get("chunk-kid") });
  // threads.list takes at most 200 ids per call and archived is a selector (SDK ThreadListArgs).
  const lookups = idLookups(context);
  expect(lookups.map((args) => args.threadIds!.length).sort((left, right) => left - right)).toStrictEqual([1, 1, 200, 200]);
  expect(lookups.filter((args) => args.archived === true).length).toBe(2);
  for (const args of lookups) expect(args).toMatchObject({ includeHidden: true, limit: 200 });
  expect(cardOf("chunk-root").run_state).toBe("idle");
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
  await rerun(context, 2);
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

test("reconcile settles a working active-stage card whose thread is idle with nothing running below it, and only that", async () => {
  const context = await startQuiet();
  const { db, cardOf, known, mirror, rpc } = context;
  const ids = ["rs-settle", "rs-live", "rs-idlecard", "rs-active", "rs-attention"];
  for (const id of ids) await mirror(thr(id, { status: "active" }));
  db.prepare("UPDATE triage_tasks SET run_state = 'idle' WHERE thread_id = 'rs-idlecard'").run();
  await rpc("moveTask", { number: cardOf("rs-attention").number, stageId: "stage-attention" });
  const threads = ids.map((id) => thr(id, { status: id === "rs-active" ? "active" : "idle" }));
  known.set("rs-kid", kid("rs-kid", "rs-live"));
  context.ctx.list = worldOf([...threads, known.get("rs-kid")]).handler;
  running(context, "rs-kid", "rs-active");
  const before = Object.fromEntries(ids.map((id) => [id, { ...cardOf(id) }]));
  await rerun(context, 2);
  expect(cardOf("rs-settle")).toMatchObject({ run_state: "idle", stage_id: "stage-progress" });
  expect(cardOf("rs-settle").settled_at).toBeGreaterThan(0);
  // The running root rs-active is reopened by the backfill like any live root, which only touches updated_at.
  for (const id of ids.filter((id) => id !== "rs-settle" && id !== "rs-live")) {
    expect({ ...cardOf(id), updated_at: 0 }).toStrictEqual({ ...before[id], updated_at: 0 });
  }
  // The live root was reopened by the backfill: still working, still unsettled.
  expect(cardOf("rs-live")).toMatchObject({ run_state: "working", stage_id: "stage-progress", settled_at: null });
});

test("reconcile leaves a card reopened after its candidates were read working", async () => {
  const context = await startQuiet();
  const { ctx, cardOf, emit, known, mirror } = context;
  await mirror(thr("rr-root", { status: "active" }));
  known.set("rr-root", thr("rr-root", { status: "idle" }));
  known.set("rr-kid", kid("rr-kid", "rr-root"));
  ctx.list = worldOf([thr("rr-root", { status: "idle" })]).handler;
  const gate = deferred<unknown[]>();
  let calls = 0;
  // The backfill's own lookup answers at once; reconcile's waits.
  ctx.running = () => (++calls === 2 ? gate.promise : []);
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
