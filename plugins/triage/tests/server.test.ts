import { expect, test } from "vitest";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

// Request fixture for created cards; every field is required by the contract.
function request(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "project-1",
    providerId: "codex",
    model: "test-model",
    // SDK 0.6.79 widened reasoning levels to any provider-reported string, so
    // the fixture uses a level outside triage's known eight on purpose.
    reasoningLevel: "adaptive",
    permissionMode: "auto",
    // SDK 0.6.79 widened service tiers to any provider-reported string, so the
    // fixture uses one outside the old default/fast pair on purpose.
    serviceTier: "priority",
    executionInputSources: {},
    environment: { type: "reuse", environmentId: "environment-1" },
    input: [{ type: "text", text: "Do work" }],
    ...overrides,
  };
}

function createTaskInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "New task",
    description: "Do work",
    stageId: "stage-todo",
    scheduledAt: null,
    runNow: false,
    request: request(),
    ...overrides,
  };
}

async function setup() {
  const thread = makeThreadResponse({ id: "session-1", projectId: "project-1", title: "Conversation" });
  let spawnCount = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    sdk: {
      threads: {
        get: async () => thread,
        spawn: async () => makeThreadResponse({ id: `spawned-${(spawnCount += 1)}` }),
        update: async () => thread,
        stop: async () => ({}),
        defaultExecutionOptions: async () => null,
      },
      projects: {
        list: async () => [],
        get: async () => ({ id: "project-1", name: "Project" }),
      },
      hosts: {
        list: async () => [{ id: "machine-1", name: "Machine One", status: "connected" }],
        get: async (args: { hostId: string }) => ({ id: args.hostId, name: `Host ${args.hostId}`, status: "connected" }),
      },
      providers: {
        list: async () => [],
        models: async () => ({ models: [] }),
      },
      environments: {
        get: async () => { throw new Error("Environment unreachable"); },
      },
    },
  });
  await plugin(bb);
  const rpc = (method: string, input: unknown = null) =>
    harness.behavior.callRpc(method, input) as Promise<Record<string, any>>;
  const createTask = async (overrides: Record<string, unknown> = {}) =>
    rpc("createTask", createTaskInput(overrides));
  return { harness, thread, rpc, createTask };
}

// Raw row surgery for defensive branches the RPC surface cannot reach. The
// mutation runs against the persistent fake-host database, then the plugin
// reloads on top of it.
async function withRawDatabase(harness: any, mutate: (db: any) => void) {
  let updated = (await harness.lifecycle.reload(async (bb: any) => {
    mutate(bb.storage.database());
  })).harness;
  updated = (await updated.lifecycle.reload(plugin)).harness;
  return updated;
}

function lastSignal(harness: any): any {
  return harness.realtimeSignals[harness.realtimeSignals.length - 1];
}

test("snapshot shapes projects, machines, stages, and the notification list", async () => {
  const { harness, rpc } = await setup();
  try {
    harness.inspection.sdk.stub("projects.list", async () => [
      { id: "p-standard", kind: "standard", name: "Standard Project", sources: [{ hostId: "machine-1", isDefault: true }] },
      { id: "p-personal", kind: "personal", name: "Home dir", sources: [] },
      { id: "p-standard-2", kind: "standard", name: "Second", sources: [{ hostId: "machine-1", isDefault: false }] },
      { id: "p-personal-2", kind: "personal", name: "Elsewhere" },
      { id: "p-nohost", kind: "standard", name: "No Host Yet", sources: [{ isDefault: true }] },
    ]);
    harness.inspection.sdk.stub("hosts.list", async () => [
      { id: "machine-1", name: "Machine One", status: "connected" },
      { id: "machine-2", name: "Machine Two", status: "disconnected" },
    ]);
    const snapshot = await rpc("snapshot");
    expect(snapshot.projects.map((project: any) => project.id)).toStrictEqual([
      "p-personal", "p-personal-2", "p-standard", "p-standard-2", "p-nohost",
    ]);
    expect(snapshot.projects[0].name).toBe("Personal");
    expect(snapshot.projects[2].defaultMachineId).toBe("machine-1");
    expect(snapshot.projects[3].defaultMachineId).toBe(null);
    // A default source without a host falls back to no default machine.
    expect(snapshot.projects[4].defaultMachineId).toBe(null);
    expect(snapshot.machines).toStrictEqual([
      { id: "machine-1", name: "Machine One", status: "connected" },
      { id: "machine-2", name: "Machine Two", status: "disconnected" },
    ]);
    expect(snapshot.notifications).toStrictEqual([]);
    expect(snapshot.unreadCount).toBe(0);
    expect(snapshot.stages.map((stage: any) => stage.name)).toStrictEqual([
      "To Do", "In Progress", "Human Review", "Completed",
    ]);
  } finally { await harness.lifecycle.dispose(); }
});

test("snapshot reads the linked environment's branch, detached state, and cache", async () => {
  const { harness, rpc } = await setup();
  try {
    const environmentBranches: Record<string, unknown> = {
      "env-feature": { branchName: "feature/one", isGitRepo: true },
      "env-detached": { branchName: "", isGitRepo: true },
      "env-plain": { branchName: "", isGitRepo: false },
    };
    harness.inspection.sdk.stub("environments.get", async (args: { environmentId: string }) => {
      if (!(args.environmentId in environmentBranches)) throw new Error("Environment unreachable");
      return environmentBranches[args.environmentId];
    });
    const linked = new Map<string, any>();
    const serveImported = async (args: { threadId: string }) => {
      const found = linked.get(args.threadId);
      if (!found) throw new Error("Thread vanished");
      return found;
    };
    harness.inspection.sdk.stub("threads.get", serveImported);
    for (const [index, environmentId] of ["env-feature", "env-detached", "env-plain", "env-feature", "env-feature"].entries()) {
      const item = makeThreadResponse({ id: `session-${index}`, projectId: "project-1", environmentId });
      linked.set(item.id, item);
      await rpc("importThread", { threadId: item.id });
    }
    // One card's session can no longer be served; the card stays on the board.
    harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
      if (args.threadId === "session-4") throw new Error("Thread vanished");
      return serveImported(args);
    });
    const snapshot = await rpc("snapshot");
    expect(snapshot.tasks.length).toBe(5);
    const branchByNumber = new Map(snapshot.tasks.map((task: any) => [task.number, task.branchName]));
    expect([...branchByNumber.values()]).toStrictEqual([
      "Default branch", "feature/one", "No branch", "Detached HEAD", "feature/one",
    ]);
    const gone = snapshot.tasks.find((task: any) => task.threadId === "session-4");
    expect(gone.sidebarVisible).toBe(null);
    // The repeated environment resolves through the snapshot's cache only once:
    // five resolveMachine lookups during imports, three unique ones here.
    expect(harness.inspection.sdk.callsTo("environments.get").length).toBe(8);
  } finally { await harness.lifecycle.dispose(); }
});

test("stored workspace shapes decide the card's branch label", async () => {
  const { harness, rpc } = await setup();
  try {
    const cases: [Record<string, unknown>, string, string][] = [
      [
        { type: "git", hostId: "machine-5", workspace: { type: "git", branch: { kind: "existing", name: "feature-x" } } },
        "feature-x", "Host machine-5",
      ],
      [
        { type: "git", workspace: { type: "git", branch: { kind: "new", baseBranch: "main" } } },
        "new from main", "Project default",
      ],
      [
        { type: "git", workspace: { type: "git", branch: { kind: "new" }, baseBranch: { kind: "named", name: "develop" } } },
        "new from develop", "Project default",
      ],
      [{ type: "reuse", environmentId: "environment-1" }, "Reused workspace", "Project default"],
      [{ type: "workspace", workspace: { type: "personal" } }, "No branch", "Project default"],
      [{ type: "git" }, "Default branch", "Project default"],
    ];
    for (const [environment, branchName, machineName] of cases) {
      const task = await rpc("createTask", createTaskInput({ title: `Case ${branchName}`, request: request({ environment }) }));
      expect(task.branchName).toBe(branchName);
      expect(task.machineName).toBe(machineName);
    }
    // An unreachable host falls back to naming the card by its machine id.
    harness.inspection.sdk.stub("hosts.get", async () => { throw new Error("Host unreachable"); });
    const task = await rpc("createTask", createTaskInput({
      request: request({ environment: { type: "git", hostId: "machine-lost" } }),
    }));
    expect(task.machineName).toBe("machine-lost");
    expect(task.machineId).toBe("machine-lost");
  } finally { await harness.lifecycle.dispose(); }
});

test("importing threads reflects their run state and titles", async () => {
  const { harness, rpc } = await setup();
  try {
    harness.inspection.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "exec-model" }));
    const cases: {
      id: string; status: "active" | "starting" | "error" | "idle";
      title: string | null; titleFallback: string | null;
      runState: string; stageId: string; expectedTitle: string;
    }[] = [
      { id: "session-active", status: "active", title: "Active chat", titleFallback: null, runState: "working", stageId: "stage-progress", expectedTitle: "Active chat" },
      { id: "session-starting", status: "starting", title: null, titleFallback: "Fallback title", runState: "working", stageId: "stage-progress", expectedTitle: "Fallback title" },
      { id: "session-error", status: "error", title: "Broken chat", titleFallback: null, runState: "failed", stageId: "stage-todo", expectedTitle: "Broken chat" },
      { id: "session-idle", status: "idle", title: null, titleFallback: null, runState: "idle", stageId: "stage-todo", expectedTitle: "Untitled session" },
    ];
    for (const item of cases) {
      const itemThread = makeThreadResponse({
        id: item.id, projectId: "project-1", status: item.status, title: item.title, titleFallback: item.titleFallback,
      });
      harness.inspection.sdk.stub("threads.get", async (args: { threadId: string }) => {
        if (args.threadId === item.id) return itemThread;
        throw new Error("No such thread");
      });
      const task = await rpc("importThread", { threadId: item.id });
      expect(task.runState).toBe(item.runState);
      expect(task.stageId).toBe(item.stageId);
      expect(task.model).toBe("exec-model");
      expect(task.title).toBe(item.expectedTitle);
    }
    const deleted = makeThreadResponse({ id: "session-gone", deletedAt: 123 });
    harness.inspection.sdk.stub("threads.get", async () => deleted);
    await expect(rpc("importThread", { threadId: "session-gone" })).rejects.toThrow(/unarchived/);
  } finally { await harness.lifecycle.dispose(); }
});

test("import resolves the machine from the thread's environment", async () => {
  const { harness, rpc } = await setup();
  try {
    const importWith = async (resolve: () => unknown, hostLookup: (args: { hostId: string }) => unknown) => {
      harness.inspection.sdk.stub("environments.get", resolve);
      harness.inspection.sdk.stub("hosts.get", hostLookup);
      const item = makeThreadResponse({
        id: `session-machine-${Math.random().toString(36).slice(2, 8)}`,
        projectId: "project-1",
        environmentId: "environment-9",
      });
      harness.inspection.sdk.stub("threads.get", async () => item);
      const task = await rpc("importThread", { threadId: item.id });
      return task;
    };
    const named = await importWith(
      async () => ({ hostId: "machine-2" }),
      async (args) => ({ id: args.hostId, name: "Named host", status: "connected" }),
    );
    expect(named.machineId).toBe("machine-2");
    expect(named.machineName).toBe("Named host");
    const numeric = await importWith(
      async () => ({ hostId: "machine-3" }),
      async () => { throw new Error("Host unreachable"); },
    );
    expect(numeric.machineName).toBe("machine-3");
    const fallback = await importWith(
      async () => { throw new Error("Environment unreachable"); },
      async () => { throw new Error("unreachable"); },
    );
    expect(fallback.machineId).toBe(null);
    expect(fallback.machineName).toBe("Project default");
  } finally { await harness.lifecycle.dispose(); }
});

test("a no-op sidebar setting change writes nothing", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("must not be called"); });
    await harness.behavior.setSettings({ showThreadsInSidebar: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
  } finally { await harness.lifecycle.dispose(); }
});

test("a settings change that leaves the sidebar preference alone writes nothing", async () => {
  let harness: any = (await setup()).harness;
  try {
    const task = await harness.behavior.callRpc("createTask", createTaskInput()) as { number: number };
    await harness.behavior.callRpc("runTask", { number: task.number });
    // The fake host filters same-value writes before listeners run, so a
    // no-op for the sidebar preference can only reach the plugin as a change
    // to another key. The linked session guarantees a broken guard would
    // attempt a sidebar write.
    harness = (await harness.lifecycle.reload(async (bb: any) => {
      bb.settings.define({
        unrelatedSetting: { type: "boolean", label: "A setting owned by another plugin", default: false },
      });
      await plugin(bb);
    })).harness;
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("must not be called"); });
    await harness.behavior.setSettings({ unrelatedSetting: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
  } finally { await harness.lifecycle.dispose(); }
});

test("setThreadSidebar refuses cards that have no session yet", async () => {
  const { harness, createTask } = await setup();
  try {
    const task = await createTask();
    await expect(harness.behavior.callRpc("setThreadSidebar", { number: task.number, visible: true }))
      .rejects.toThrow(/Start this task/);
  } finally { await harness.lifecycle.dispose(); }
});

test("running a card dispatches once with a normalized prompt and announces the start", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask({
      request: request({
        input: [
          { type: "text", text: "Keep private", visibility: "agent-only" },
          { type: "text", text: "Do the work", visibility: "user" },
          { type: "text", text: "Untouched" },
        ],
      }),
    });
    await rpc("setTaskRead", { number: task.number, read: true });
    const started = await rpc("runTask", { number: task.number });
    expect(started.threadId).toBe("spawned-1");
    expect(started.runState).toBe("starting");
    expect(started.stageId).toBe("stage-progress");
    const [spawnArgs] = harness.inspection.sdk.callsTo("threads.spawn")[0] as [Record<string, any>];
    expect(spawnArgs.title).toBe(`Triage #${task.number}: New task`);
    expect(spawnArgs.visibility).toBe("hidden");
    // The widened wire values ride through to thread creation untouched.
    expect(spawnArgs.reasoningLevel).toBe("adaptive");
    expect(spawnArgs.serviceTier).toBe("priority");
    expect(spawnArgs.input.filter((part: any) => part.visibility !== "agent-only")).toStrictEqual([
      { type: "text", text: "Do the work" },
      { type: "text", text: "Untouched" },
    ]);
    const instruction = spawnArgs.input.at(-1);
    expect(instruction.visibility).toBe("agent-only");
    expect(instruction.text).toContain(`You are assigned to Triage #${task.number}.`);
    expect(instruction.text).toContain("triage_move_task");
    // The read marker survives the dispatch; an idle turn clears it instead.
    expect(started.readAt).toBeGreaterThan(0);
    const startedSignal = lastSignal(harness);
    expect(startedSignal.channel).toBe("triage");
    expect(startedSignal.payload.kind).toBe("changed");
    expect(startedSignal.payload.notification.action).toBe("Agent started");
    expect(startedSignal.payload.notification.level).toBe("info");
    // A second run is a no-op: the card already owns a thread.
    const again = await rpc("runTask", { number: task.number });
    expect(again.threadId).toBe("spawned-1");
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("a failed dispatch parks the card for attention and announces the failure", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Provider offline"); });
    // runNow surfaces the dispatch failure to the caller as well.
    await expect(createTask({ runNow: true })).rejects.toThrow(/Provider offline/);
    const snapshot = await rpc("snapshot");
    const task = snapshot.tasks[0];
    expect(task.runState).toBe("failed");
    expect(task.stageId).toBe("stage-attention");
    expect(task.attentionReason).toBe("Provider offline");
    expect(task.readAt).toBe(null);
    const signal = lastSignal(harness);
    expect(signal.payload.notification).toMatchObject({
      action: "Needs attention", taskTitle: "New task", body: "Provider offline", level: "attention",
    });
    expect(snapshot.unreadCount).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("a completed card does not dispatch again", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("moveTask", { number: task.number, stageId: "stage-completed" });
    const settled = await rpc("runTask", { number: task.number });
    expect(settled.runState).toBe("completed");
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(0);
  } finally { await harness.lifecycle.dispose(); }
});

test("a card whose thread was deleted runs again; a stopped linked card does not", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    const started = await rpc("runTask", { number: task.number });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: started.threadId }) });
    const detached = await rpc("snapshot");
    expect(detached.tasks[0].threadId).toBe(null);
    expect(detached.tasks[0].runState).toBe("stopped");
    // Running the detached card claims it and spawns a fresh thread.
    const rerun = await rpc("runTask", { number: task.number });
    expect(rerun.threadId).toBeTruthy();
    expect(rerun.threadId).not.toBe(started.threadId);
    expect(rerun.runState).toBe("starting");
    expect(rerun.attentionReason).toBe(null);
    // A stopped card that still owns its thread is left alone.
    const linked = await createTask({ title: "Stopped with thread" });
    const linkedStart = await rpc("runTask", { number: linked.number });
    await rpc("stopTask", { number: linked.number });
    const spawnsBefore = harness.inspection.sdk.callsTo("threads.spawn").length;
    const refused = await rpc("runTask", { number: linked.number });
    expect(refused.threadId).toBe(linkedStart.threadId);
    expect(refused.runState).toBe("stopped");
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(spawnsBefore);
  } finally { await harness.lifecycle.dispose(); }
});

test("updateTask rejects impossible edits", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    const future = Date.now() + 3_600_000;
    await expect(rpc("updateTask", {
      number: task.number, title: "Edited", description: "d", stageId: "stage-todo",
      scheduledAt: Date.now() - 1_000,
    })).rejects.toThrow(/future date/);
    await rpc("updateTask", {
      number: task.number, title: "Edited", description: "d", stageId: "stage-todo", scheduledAt: future,
    });
    await rpc("runTask", { number: task.number });
    await expect(rpc("updateTask", {
      number: task.number, title: "Edited", description: "d", stageId: "stage-todo", scheduledAt: future,
    })).rejects.toThrow(/rescheduled after/);
    await expect(rpc("updateTask", {
      number: task.number, title: "Edited", description: "d", stageId: "stage-todo", scheduledAt: null,
      providerId: "claude-code",
    })).rejects.toThrow(/change agent after/);
  } finally { await harness.lifecycle.dispose(); }
});

test("updateTask retargeting records explicit sources field by field", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    const sources = async () => {
      const snapshot = await rpc("snapshot");
      return snapshot.tasks[0].request.executionInputSources;
    };
    const edit = (fields: Record<string, unknown>) => rpc("updateTask", {
      number: task.number, title: "New task", description: "Do work", stageId: "stage-todo", scheduledAt: null,
      ...fields,
    });
    await edit({ providerId: "claude-code" });
    expect(await sources()).toMatchObject({ providerId: "explicit" });
    await edit({ model: "next-model" });
    expect(await sources()).toMatchObject({ model: "explicit" });
    await edit({ reasoningLevel: "adaptive" });
    expect(await sources()).toMatchObject({ reasoningLevel: "explicit" });
    const edited = await edit({ providerId: "codex", model: "test-model", reasoningLevel: "none" });
    expect(edited.providerId).toBe("codex");
    expect(edited.model).toBe("test-model");
    expect(edited.reasoningLevel).toBe("none");
    expect(edited.request.executionInputSources).toStrictEqual({
      providerId: "explicit", model: "explicit", reasoningLevel: "explicit",
    });
  } finally { await harness.lifecycle.dispose(); }
});

test("updateTask replaces the whole request, or just the visible prompt", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const replaced = await createTask();
    const freshRequest = request({
      providerId: "claude-code",
      model: "claude-sonnet",
      input: [{ type: "text", text: "Fresh prompt" }],
    });
    harness.inspection.sdk.stub("projects.get", async () => ({ id: "project-1", name: "Renamed Project" }));
    const updated = await rpc("updateTask", {
      number: replaced.number, title: "Replaced", description: "Fresh prompt", stageId: "stage-todo",
      scheduledAt: null, request: freshRequest,
    });
    expect(updated.request.input).toStrictEqual([{ type: "text", text: "Fresh prompt" }]);
    expect(updated.projectName).toBe("Renamed Project");
    expect(updated.providerId).toBe("claude-code");
    // A card whose prompt is agent-only only gets the description spliced in front.
    const agentOnly = await createTask({
      request: request({ input: [{ type: "text", text: "context", visibility: "agent-only" }] }),
    });
    const spliced = await rpc("updateTask", {
      number: agentOnly.number, title: "New task", description: "Visible intent", stageId: "stage-todo", scheduledAt: null,
    });
    expect(spliced.request.input).toStrictEqual([
      { type: "text", text: "Visible intent", mentions: [] },
      { type: "text", text: "context", visibility: "agent-only" },
    ]);
  } finally { await harness.lifecycle.dispose(); }
});

test("updateTask keeps the run state on a live thread and syncs the title", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    const edited = await rpc("updateTask", {
      number: task.number, title: "Renamed card", description: "Do work", stageId: "stage-todo", scheduledAt: null,
    });
    expect(edited.runState).toBe("starting");
    expect(edited.title).toBe("Renamed card");
    const [updateArgs] = harness.inspection.sdk.callsTo("threads.update")[0] as [Record<string, any>];
    expect(updateArgs.title).toBe(`Triage #${task.number}: Renamed card`);
    // A failing sync warns but keeps the edit.
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Host disconnected"); });
    const retried = await rpc("updateTask", {
      number: task.number, title: "Renamed again", description: "Do work", stageId: "stage-todo", scheduledAt: null,
    });
    expect(retried.title).toBe("Renamed again");
    expect(harness.logEntries.some((entry: any) =>
      entry.level === "warn" && entry.message.includes("could not be synced"))).toBe(true);
    // Moving a live card to the done stage completes it.
    const done = await rpc("updateTask", {
      number: task.number, title: "Renamed again", description: "Do work", stageId: "stage-completed", scheduledAt: null,
    });
    expect(done.runState).toBe("completed");
  } finally { await harness.lifecycle.dispose(); }
});

test("renameTask renames in place and syncs only linked threads", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const plain = await createTask();
    const renamed = await rpc("renameTask", { number: plain.number, title: "Renamed" });
    expect(renamed.title).toBe("Renamed");
    expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(0);
    const linked = await createTask({ title: "Linked" });
    await rpc("runTask", { number: linked.number });
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Host disconnected"); });
    await expect(rpc("renameTask", { number: linked.number, title: "Broken sync" })).rejects.toThrow(/Host disconnected/);
  } finally { await harness.lifecycle.dispose(); }
});

test("setTaskSettled archives a resolved card without losing its stage", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    const settled = await rpc("setTaskSettled", { number: task.number, settled: true });
    expect(settled.settledAt).toBeGreaterThan(0);
    expect(settled.stageId).toBe("stage-todo");
    const snapshot = await rpc("snapshot");
    // Settled cards stay queryable but leave the active board views.
    expect(snapshot.tasks[0].settledAt).toBe(settled.settledAt);
    const reopened = await rpc("setTaskSettled", { number: task.number, settled: false });
    expect(reopened.settledAt).toBe(null);
    // The read marker clears forward and back.
    await rpc("setTaskRead", { number: task.number, read: true });
    const unread = await rpc("setTaskRead", { number: task.number, read: false });
    expect(unread.readAt).toBe(null);
    await expect(rpc("setTaskSettled", { number: 999, settled: true })).rejects.toThrow(/was not found/);
  } finally { await harness.lifecycle.dispose(); }
});

test("stopTask requires a running thread", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const plain = await createTask();
    await expect(rpc("stopTask", { number: plain.number })).rejects.toThrow(/no agent thread to stop/);
    const linked = await createTask({ title: "Linked" });
    await rpc("runTask", { number: linked.number });
    const stopped = await rpc("stopTask", { number: linked.number });
    expect(stopped.runState).toBe("stopped");
    expect(harness.inspection.sdk.callsTo("threads.stop").length).toBe(1);
    await expect(rpc("stopTask", { number: linked.number })).rejects.toThrow(/not currently running/);
  } finally { await harness.lifecycle.dispose(); }
});

test("deleteTask removes the card, its history, and any queued sidebar write", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    await rpc("setThreadSidebar", { number: task.number, visible: true });
    const result = await rpc("deleteTask", { number: task.number });
    expect(result).toStrictEqual({ ok: true });
    expect((await rpc("snapshot")).tasks).toStrictEqual([]);
    const plain = await createTask();
    await rpc("deleteTask", { number: plain.number });
    expect((await rpc("snapshot")).tasks).toStrictEqual([]);
  } finally { await harness.lifecycle.dispose(); }
});

test("stage administration creates, renames, reorders, and deletes user stages", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const created = await rpc("createStage", { name: "  In Review  " });
    expect(created.name).toBe("In Review");
    expect(created.systemRole).toBe(null);
    expect(created.position).toBe(500);
    const renamed = await rpc("renameStage", { id: created.id, name: "In Review by humans" });
    expect(renamed.name).toBe("In Review by humans");
    await expect(rpc("renameStage", { id: "stage-missing", name: "X" })).rejects.toThrow(/Stage was not found/);
    const idList = async () => (await rpc("snapshot")).stages.map((stage: any) => stage.id);
    const before = await idList();
    const moved = await rpc("reorderStage", { id: created.id, direction: "left" });
    expect(moved.stages.map((stage: any) => stage.id)).toStrictEqual([...before.slice(0, 3), created.id, before[3]]);
    const restored = await rpc("reorderStage", { id: created.id, direction: "right" });
    expect(restored.stages.map((stage: any) => stage.id)).toStrictEqual(before);
    // Reordering off either edge of the board leaves the order alone.
    const first = before[0];
    const untouched = await rpc("reorderStage", { id: first, direction: "left" });
    expect(untouched.stages.map((stage: any) => stage.id)).toStrictEqual(before);
    const stillUntouched = await rpc("reorderStage", { id: created.id, direction: "right" });
    expect(stillUntouched.stages.map((stage: any) => stage.id)).toStrictEqual(before);
    await expect(rpc("reorderStage", { id: first })).rejects.toThrow(/Provide a direction or target stage/);
    await expect(rpc("reorderStage", { id: "stage-missing", targetId: first })).rejects.toThrow(/Stage was not found/);
    // Deleting needs an empty, user-made stage.
    await expect(rpc("deleteStage", { id: "stage-todo" })).rejects.toThrow(/Core workflow stages/);
    const occupant = await createTask({ title: "Stage occupant" });
    await rpc("moveTask", { number: occupant.number, stageId: created.id });
    await expect(rpc("deleteStage", { id: created.id })).rejects.toThrow(/Move every card out/);
    await rpc("deleteTask", { number: occupant.number });
    expect(await rpc("deleteStage", { id: created.id })).toStrictEqual({ ok: true });
    expect((await idList()).includes(created.id)).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});

test("notification read and delete calls act on the stored rows", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Provider offline"); });
    await expect(createTask({ runNow: true })).rejects.toThrow(/Provider offline/);
    let snapshot = await rpc("snapshot");
    expect(snapshot.notifications.length).toBe(1);
    expect(snapshot.unreadCount).toBe(1);
    const first = snapshot.notifications[0];
    // An empty id list is a valid no-op snapshot from the popover.
    await rpc("markNotificationsRead", { ids: [] });
    expect((await rpc("snapshot")).unreadCount).toBe(1);
    await rpc("markNotificationsRead", { ids: [first.id] });
    snapshot = await rpc("snapshot");
    expect(snapshot.unreadCount).toBe(0);
    expect(snapshot.notifications[0].readAt).toBeGreaterThan(0);
    // A fresh failure plus mark-all clears everything.
    await expect(createTask({ title: "Second", runNow: true })).rejects.toThrow(/Provider offline/);
    expect((await rpc("snapshot")).unreadCount).toBe(1);
    await rpc("markNotificationsRead", { ids: null });
    expect((await rpc("snapshot")).unreadCount).toBe(0);
    await rpc("deleteNotifications", { ids: [first.id] });
    snapshot = await rpc("snapshot");
    expect(snapshot.notifications.length).toBe(1);
    expect(snapshot.notifications[0].taskTitle).toBe("Second");
  } finally { await harness.lifecycle.dispose(); }
});

test("the agent tool moves only its own card and explains unknown stages", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    const started = await rpc("runTask", { number: task.number });
    const owner = started.threadId;
    await expect(harness.behavior.callAgentTool("triage_move_task", {
      number: task.number, stage: "Nowhere", summary: "Done",
    }, { threadId: owner })).rejects.toThrow(/Unknown stage “Nowhere”. Available stages: To Do, In Progress, Human Review, Completed/);
    await expect(harness.behavior.callAgentTool("triage_move_task", {
      number: task.number, stage: "Completed", summary: "Done",
    }, { threadId: "someone-else" })).rejects.toThrow(/not assigned to this thread/);
    await rpc("setTaskRead", { number: task.number, read: true });
    const result = await harness.behavior.callAgentTool("triage_move_task", {
      number: task.number, stage: "completed", summary: "Verified and finished",
    }, { threadId: owner });
    expect(result).toBe(`Moved Triage #${task.number} to Completed.`);
    const snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].stageId).toBe("stage-completed");
    expect(snapshot.tasks[0].runState).toBe("completed");
    // The agent's move clears the card's read marker.
    expect(snapshot.tasks[0].readAt).toBe(null);
    const movedSignal = lastSignal(harness);
    expect(movedSignal.payload.notification).toMatchObject({
      action: "Moved to Completed", body: "Verified and finished", level: "success",
    });
    // The attention stage notifies at the attention level instead.
    const blocked = await createTask({ title: "Blocked" });
    const blockedStart = await rpc("runTask", { number: blocked.number });
    await harness.behavior.callAgentTool("triage_move_task", {
      number: blocked.number, stage: "Human Review", summary: "Need credentials",
    }, { threadId: blockedStart.threadId });
    const attentionSignal = lastSignal(harness);
    expect(attentionSignal.payload.notification.level).toBe("attention");
    expect(attentionSignal.payload.notification.body).toBe("Need credentials");
  } finally { await harness.lifecycle.dispose(); }
});

test("agent options skip unavailable providers and survive catalogue failures", async () => {
  const { harness, rpc } = await setup();
  try {
    harness.inspection.sdk.stub("providers.list", async () => [
      { id: "codex", displayName: "Codex", available: true },
      { id: "sleepy", displayName: "Sleepy", available: false },
      { id: "broken", displayName: "Broken", available: true },
    ]);
    harness.inspection.sdk.stub("providers.models", async (args: { providerId: string }) => {
      if (args.providerId === "broken") throw new Error("Catalogue unreachable");
      return {
        models: [{
          id: "m1", model: "test-model", displayName: "Test Model", description: "A model",
          // SDK 0.6.79 widened reasoning efforts to any provider-reported string;
          // "adaptive" pins that unknown efforts pass through untouched.
          supportedReasoningEfforts: [{ reasoningEffort: "none" }, { reasoningEffort: "adaptive" }],
          defaultReasoningEffort: "medium",
        }],
      };
    });
    const options = await rpc("agentOptions");
    expect(options.providers).toStrictEqual([
      { id: "codex", name: "Codex", available: true },
      { id: "sleepy", name: "Sleepy", available: false },
      { id: "broken", name: "Broken", available: true },
    ]);
    expect(options.models).toStrictEqual([{
      id: "codex:m1", providerId: "codex", model: "test-model", displayName: "Test Model", description: "A model",
      supportedReasoningEfforts: ["none", "adaptive"], defaultReasoningEffort: "medium",
    }]);
    expect(harness.logEntries.some((entry: any) =>
      entry.level === "warn" && entry.message.includes("broken"))).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

test("agent configuration is empty for threads without a card", async () => {
  const { harness } = await setup();
  try {
    const config = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "unlinked-thread" } }),
    );
    expect(config).toMatchObject({ tools: [], skills: [], instructions: null });
  } finally { await harness.lifecycle.dispose(); }
});

test("thread events move cards through the board", async () => {
  const { harness, thread, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "unknown-thread" }) });
    // Idle and failure turns for unlinked threads are ignored too.
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "unknown-thread" }), lastAssistantText: "Done" });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "unknown-thread" }), error: "no card" });
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "spawned-1" }) });
    let snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].runState).toBe("working");
    expect(snapshot.tasks[0].stageId).toBe("stage-progress");
    // Going idle in the active stage asks for a person and clears the read mark.
    await rpc("setTaskRead", { number: task.number, read: true });
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "spawned-1" }), lastAssistantText: "Done" });
    snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].runState).toBe("idle");
    expect(snapshot.tasks[0].readAt).toBe(null);
    const waiting = lastSignal(harness);
    expect(waiting.payload.notification.action).toBe("Waiting for you");
    // An idle card in a user stage stays quiet.
    const custom = await rpc("createStage", { name: "Holding" });
    await rpc("moveTask", { number: task.number, stageId: custom.id });
    const quietSignals = harness.realtimeSignals.length;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "spawned-1" }), lastAssistantText: "Done" });
    snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].runState).toBe("idle");
    expect(harness.realtimeSignals.length).toBe(quietSignals + 1);
    expect(lastSignal(harness).payload.notification).toBeUndefined();
    // A stopped card ignores idle turns; bring the card back to working first.
    await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "spawned-1" }) });
    await rpc("stopTask", { number: task.number });
    const stoppedSignals = harness.realtimeSignals.length;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "spawned-1" }), lastAssistantText: "Done" });
    expect(harness.realtimeSignals.length).toBe(stoppedSignals + 1);
    expect(lastSignal(harness).payload.notification).toBeUndefined();
    // A finished card ignores idle turns as well.
    await rpc("moveTask", { number: task.number, stageId: "stage-completed" });
    const finishedSignals = harness.realtimeSignals.length;
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "spawned-1" }), lastAssistantText: "Done" });
    expect(harness.realtimeSignals.length).toBe(finishedSignals + 1);
    expect(lastSignal(harness).payload.notification).toBeUndefined();
    // Failures land in the attention stage with the provided reason.
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "spawned-1" }), error: "  Provider crashed  " });
    snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].stageId).toBe("stage-attention");
    expect(snapshot.tasks[0].attentionReason).toBe("Provider crashed");
    expect(lastSignal(harness).payload.notification.action).toBe("Needs attention");
    // Deleting the linked thread detaches the card and keeps it on the board.
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "unrelated" }) });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "spawned-1" }) });
    snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].threadId).toBe(null);
    expect(snapshot.tasks[0].runState).toBe("stopped");
    expect(snapshot.tasks[0].attentionReason).toContain("deleted");
  } finally { await harness.lifecycle.dispose(); }
});

test("a failed turn without a reason still explains itself", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    await harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "spawned-1" }), error: "   " });
    const snapshot = await rpc("snapshot");
    expect(snapshot.tasks[0].attentionReason).toBe("The assigned BB thread failed.");
  } finally { await harness.lifecycle.dispose(); }
});

test("the CLI answers help, listings, and card commands", async () => {
  const { harness, createTask } = await setup();
  try {
    const empty = await harness.behavior.runCli(["list"]);
    expect(empty).toMatchObject({ exitCode: 0, stdout: "No Triage cards." });
    expect((await harness.behavior.runCli(["--help"])).stdout).toContain("Usage: bb triage");
    expect((await harness.behavior.runCli(["help"])).stdout).toContain("bb triage show 42");
    const task = await createTask();
    const listing = await harness.behavior.runCli(["list"]);
    expect(listing.stdout).toContain(`Triage #${task.number}\tTo Do\tNew task`);
    expect(JSON.parse((await harness.behavior.runCli(["list", "--json"])).stdout).tasks.length).toBe(1);
    const stages = await harness.behavior.runCli(["stages"]);
    expect(stages.stdout).toBe("To Do\nIn Progress\nHuman Review\nCompleted");
    expect(JSON.parse((await harness.behavior.runCli(["stages", "--json"])).stdout).stages.length).toBe(4);
    expect((await harness.behavior.runCli(["show"])).stderr).toContain("Provide a positive Triage number");
    expect((await harness.behavior.runCli(["show", "0"])).stderr).toContain("Provide a positive Triage number");
    expect((await harness.behavior.runCli(["show", "abc"])).stderr).toContain("Provide a positive Triage number");
    const shown = await harness.behavior.runCli(["show", String(task.number)]);
    expect(shown.stdout).toContain(`Triage #${task.number}: New task`);
    expect(shown.stdout).toContain("Stage: To Do");
    expect(shown.stdout).toContain("Run: queued");
    const shownJson = JSON.parse((await harness.behavior.runCli(["show", String(task.number), "--json"])).stdout);
    expect(shownJson.task.title).toBe("New task");
    const moved = await harness.behavior.runCli(["move", String(task.number), "In", "Progress", "--summary", "handing over"]);
    expect(moved.stdout).toBe(`Moved Triage #${task.number} to In Progress.`);
    const movedJson = JSON.parse((await harness.behavior.runCli(["move", String(task.number), "To Do", "--json"])).stdout);
    expect(movedJson.task.stageId).toBe("stage-todo");
    expect((await harness.behavior.runCli(["move", String(task.number), "Nowhere"])).stderr).toContain("Unknown stage");
    expect((await harness.behavior.runCli(["frobnicate", "5"])).stderr).toContain("Unknown command");
    expect((await harness.behavior.runCli(["run", "999"])).stderr).toContain("was not found");
    const run = await harness.behavior.runCli(["run", String(task.number)]);
    expect(run.stdout).toBe(`Started Triage #${task.number}.`);
    // Running an already-linked card starts nothing new.
    const rerun = JSON.parse((await harness.behavior.runCli(["run", String(task.number), "--json"])).stdout);
    expect(rerun.task.threadId).toBeTruthy();
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("the CLI surfaces dispatch failures as exit code 1", async () => {
  const { harness, createTask } = await setup();
  try {
    const task = await createTask();
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Provider offline"); });
    const failed = await harness.behavior.runCli(["run", String(task.number)]);
    expect(failed).toMatchObject({ exitCode: 1 });
    expect(failed.stderr).toContain("Provider offline");
    // A thrown non-Error still becomes readable stderr text.
    const second = await createTask({ title: "String failure" });
    harness.inspection.sdk.stub("threads.spawn", async () => { throw "bare string failure"; });
    const failedString = await harness.behavior.runCli(["run", String(second.number)]);
    expect(failedString).toMatchObject({ exitCode: 1 });
    expect(failedString.stderr).toContain("bare string failure");
  } finally { await harness.lifecycle.dispose(); }
});

test("a superseded sidebar write is abandoned without touching the host", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    const entryResolvers: (() => void)[] = [];
    const nextEntry = () => new Promise<void>((resolve) => { entryResolvers.push(resolve); });
    const firstEntry = nextEntry();
    const secondEntry = nextEntry();
    let releaseUpdate: () => void = () => {};
    harness.inspection.sdk.stub("threads.update", async () => {
      entryResolvers.shift()?.();
      await new Promise<void>((resolve) => { releaseUpdate = resolve; });
      return makeThreadResponse({ id: "spawned-1" });
    });
    // The first write blocks; the second supersedes it before it lands.
    const first = rpc("setThreadSidebar", { number: task.number, visible: false });
    await firstEntry;
    const second = rpc("setThreadSidebar", { number: task.number, visible: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseUpdate();
    await secondEntry;
    releaseUpdate();
    await Promise.all([first, second]);
    // Only the surviving write reached the host.
    expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(2);
  } finally { await harness.lifecycle.dispose(); }
});

test("disposing during a failing sidebar sync skips the warning log", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    let releaseUpdate: () => void = () => {};
    let updateEntered: () => void = () => {};
    const firstEntry = new Promise<void>((resolve) => { updateEntered = resolve; });
    harness.inspection.sdk.stub("threads.update", async () => {
      updateEntered();
      await new Promise<void>((resolve) => { releaseUpdate = resolve; });
      throw new Error("Host disconnected");
    });
    // The setting change kicks off an unawaited sidebar sync that blocks in
    // the host; disposing while it is mid-flight must silence its warning.
    await harness.behavior.setSettings({ showThreadsInSidebar: true });
    await firstEntry;
    await harness.lifecycle.dispose();
    releaseUpdate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.logEntries.some((entry: any) =>
      entry.level === "warn" && entry.message.includes("Could not update sidebar visibility"))).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});

test("the scheduler dispatches due cards and stops promptly on abort", async () => {
  const { harness, createTask } = await setup();
  try {
    let releaseSpawn: () => void = () => {};
    let spawnEntered: () => void = () => {};
    const firstSpawnEntered = new Promise<void>((resolve) => { spawnEntered = resolve; });
    harness.inspection.sdk.stub("threads.spawn", async () => {
      spawnEntered();
      await new Promise<void>((resolve) => { releaseSpawn = resolve; });
      return makeThreadResponse({ id: "spawned-slow" });
    });
    const dueAt = Date.now() - 1_000;
    await createTask({ title: "Due first", scheduledAt: dueAt });
    await createTask({ title: "Due second", scheduledAt: dueAt });
    const { controller, done } = harness.behavior.runService("scheduler");
    await firstSpawnEntered;
    controller.abort();
    releaseSpawn();
    await done;
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { title: string; runState: string }[] };
    const runStateByTitle = new Map(snapshot.tasks.map((taskItem) => [taskItem.title, taskItem.runState]));
    expect(runStateByTitle.get("Due first")).toBe("starting");
    expect(runStateByTitle.get("Due second")).toBe("scheduled");
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("the scheduler survives a failed dispatch of a due card", async () => {
  const { harness, createTask } = await setup();
  try {
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Provider offline"); });
    await createTask({ title: "Doomed", scheduledAt: Date.now() - 1_000 });
    const { controller, done } = harness.behavior.runService("scheduler");
    await waitForCondition(async () => {
      const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { runState: string }[] };
      return snapshot.tasks[0]?.runState === "failed";
    });
    controller.abort();
    await done;
  } finally { await harness.lifecycle.dispose(); }
});

test("the scheduler leaves an empty board promptly when aborted", async () => {
  const { harness } = await setup();
  try {
    const { controller, done } = harness.behavior.runService("scheduler");
    controller.abort();
    await done;
  } finally { await harness.lifecycle.dispose(); }
});

test("a sidebar sync running under the scheduler respects a mid-flight abort", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    let updateEntered: () => void = () => {};
    const firstEntry = new Promise<void>((resolve) => { updateEntered = resolve; });
    let releaseUpdate: () => void = () => {};
    harness.inspection.sdk.stub("threads.update", async () => {
      updateEntered();
      await new Promise<void>((resolve) => { releaseUpdate = resolve; });
      return makeThreadResponse({ id: "spawned-1" });
    });
    // The visibility write blocks inside the host, so the scheduler's own sync
    // queues behind it.
    const pendingRpc = rpc("setThreadSidebar", { number: task.number, visible: false });
    await firstEntry;
    const { controller, done } = harness.behavior.runService("scheduler");
    controller.abort();
    releaseUpdate();
    await done;
    await pendingRpc;
    // Only the RPC's write reached the host; the scheduler's queued sync was
    // abandoned when it found the entry gone.
    expect(harness.inspection.sdk.callsTo("threads.update").length).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("a failing sidebar write during a setting change is logged, not fatal", async () => {
  const { harness, rpc, createTask } = await setup();
  try {
    const task = await createTask();
    await rpc("runTask", { number: task.number });
    harness.inspection.sdk.stub("threads.update", async () => { throw new Error("Host disconnected"); });
    await harness.behavior.setSettings({ showThreadsInSidebar: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.logEntries.some((entry: any) =>
      entry.level === "warn" && entry.message.includes("Could not update sidebar visibility"))).toBe(true);
  } finally { await harness.lifecycle.dispose(); }
});

test("legacy notification rows recover their action phrase from the title", async () => {
  let harness: any = (await setup()).harness;
  try {
    harness = await withRawDatabase(harness, (db) => {
      const insert = db.prepare(
        "INSERT INTO triage_notifications (id, task_number, action, task_title, title, body, level, read_at, created_at) VALUES (?, ?, NULL, ?, ?, ?, 'attention', NULL, 100)",
      );
      insert.run("legacy-split", 7, "Legacy card", "Triage #7 started", "The agent began the work");
      insert.run("legacy-unrelated", 7, "Legacy card", "Unrelated note", "Body text");
      insert.run("legacy-broadcast", null, "Legacy card", "Broadcast", "Something happened");
    });
    const snapshot = await harness.behavior.callRpc("snapshot", null) as {
      notifications: { id: string; action: string }[];
    };
    const actions = new Map(snapshot.notifications.map((row) => [row.id, row.action]));
    expect(actions.get("legacy-split")).toBe("Started");
    expect(actions.get("legacy-unrelated")).toBe("Unrelated note");
    expect(actions.get("legacy-broadcast")).toBe("Broadcast");
  } finally { await harness.lifecycle.dispose(); }
});

test("a missing task counter explains itself instead of corrupting numbers", async () => {
  let harness: any = (await setup()).harness;
  try {
    harness = await withRawDatabase(harness, (db) => {
      db.prepare("DELETE FROM triage_meta WHERE key = 'next_task_number'").run();
    });
    await expect(harness.behavior.callRpc("createTask", createTaskInput())).rejects.toThrow(/number counter is unavailable/);
  } finally { await harness.lifecycle.dispose(); }
});

test("a missing system stage fails loudly when a dispatch needs it", async () => {
  let harness: any = (await setup()).harness;
  try {
    harness = await withRawDatabase(harness, (db) => {
      db.prepare("DELETE FROM triage_stages WHERE system_role = 'attention'").run();
    });
    harness.inspection.sdk.stub("threads.spawn", async () => { throw new Error("Provider offline"); });
    await expect(harness.behavior.callRpc("createTask", createTaskInput({ runNow: true })))
      .rejects.toThrow(/attention stage is not configured/);
  } finally { await harness.lifecycle.dispose(); }
});

async function waitForCondition(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}
