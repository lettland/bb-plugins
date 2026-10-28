import { expect, test } from "vitest";
import { createFakePluginHost, makeThreadResponse, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

async function setup(options: { failUpdate?: boolean; archived?: boolean } = {}) {
  const thread = makeThreadResponse({ id: "session-1", projectId: "project-1", title: "Existing conversation", visibility: "visible", archivedAt: options.archived ? 1 : null });
  let failUpdate = options.failUpdate;
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    sdk: {
      threads: {
        get: async () => thread,
        // The snapshot reads carded sessions through batched list calls; the
        // backfill's unfiltered pass finds nothing so it never mirrors the fixture.
        list: async (args: { threadIds?: readonly string[]; archived?: boolean } = {}) =>
          args.threadIds && !args.archived ? [thread] : [],
        defaultExecutionOptions: async () => null,
        update: async (args) => {
          if (failUpdate) { failUpdate = false; throw new Error("Host disconnected"); }
          thread.visibility = args.visibility ?? thread.visibility;
          return thread;
        },
      },
      projects: { get: async () => ({ id: "project-1", name: "Project" }) },
      environments: { get: async () => { throw new Error("No environment"); } },
    },
  });
  await plugin(bb);
  const importThread = () => harness.behavior.callRpc("importThread", { threadId: thread.id }) as Promise<{ number: number; threadId: string; title: string }>;
  return { harness, thread, importThread };
}

test("import preserves the existing session and concurrent retries create one card", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    const [first, second] = await Promise.all([importThread(), importThread()]);
    expect(first.number).toBe(second.number);
    expect(first.threadId).toBe(thread.id);
    expect(first.title).toBe("Existing conversation");
    expect(thread.visibility).toBe("hidden");
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(0);
    expect(harness.inspection.sdk.callsTo("threads.send").length).toBe(0);
    const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: thread.id } }));
    expect(JSON.stringify(config).includes("triage_move_task")).toBeTruthy();
    await harness.behavior.callRpc("setThreadSidebar", { number: first.number, visible: true });
    expect(thread.visibility).toBe("visible");
    await harness.behavior.callRpc("setThreadSidebar", { number: first.number, visible: false });
    expect(thread.visibility).toBe("hidden");
  } finally { await harness.lifecycle.dispose(); }
});

test("a failed visibility update leaves a reusable card and accessible conversation", async () => {
  const { harness, thread, importThread } = await setup({ failUpdate: true });
  try {
    await expect(importThread()).rejects.toThrow(/Host disconnected/);
    expect(thread.visibility).toBe("visible");
    const retry = await importThread();
    expect(retry.number).toBe(1);
    expect(thread.visibility).toBe("hidden");
  } finally { await harness.lifecycle.dispose(); }
});

test("archived sessions cannot be imported", async () => {
  const { harness, importThread } = await setup({ archived: true });
  try { await expect(importThread()).rejects.toThrow(/unarchived/); }
  finally { await harness.lifecycle.dispose(); }
});

test("global setting defaults off and toggles existing linked sessions", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    await importThread();
    expect(thread.visibility).toBe("hidden");
    await harness.behavior.setSettings({ showThreadsInSidebar: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thread.visibility).toBe("visible");
    await harness.behavior.setSettings({ showThreadsInSidebar: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thread.visibility).toBe("hidden");
  } finally { await harness.lifecycle.dispose(); }
});

test("rapid setting changes and individual actions keep the latest choice", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    const task = await importThread();
    await harness.behavior.setSettings({ showThreadsInSidebar: true });
    await harness.behavior.setSettings({ showThreadsInSidebar: false });
    await harness.behavior.callRpc("setThreadSidebar", { number: task.number, visible: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thread.visibility).toBe("visible");
    await expect(harness.behavior.callRpc("setThreadSidebar", { number: 9999, visible: true })).rejects.toThrow(/not found/);
  } finally { await harness.lifecycle.dispose(); }
});

test("new Triage sessions respect the default-off setting and opt-in", async () => {
  for (const enabled of [false, true]) {
    const { harness, thread } = await setup();
    try {
      harness.inspection.sdk.stub("threads.spawn", async (args: { visibility?: "visible" | "hidden" }) => {
        expect(args.visibility).toBe(enabled ? "visible" : "hidden");
        return { ...thread, visibility: args.visibility };
      });
      if (enabled) await harness.behavior.setSettings({ showThreadsInSidebar: true });
      await harness.behavior.callRpc("createTask", {
        title: "New task", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: true,
        request: {
          projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
          permissionMode: "auto", executionInputSources: {},
          environment: { type: "reuse", environmentId: "environment-1" },
          input: [{ type: "text", text: "Do work" }],
        },
      });
      expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
    } finally { await harness.lifecycle.dispose(); }
  }
});


test("snapshot reports actual sidebar visibility", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const task = await importThread();
    const visible = async () => {
      const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { sidebarVisible: boolean }[] };
      return snapshot.tasks[0]!.sidebarVisible;
    };
    expect(await visible()).toBe(false);
    await harness.behavior.callRpc("setThreadSidebar", { number: task.number, visible: true });
    expect(await visible()).toBe(true);
    thread.visibility = "hidden";
    expect(await visible()).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});

test("drag reorder moves a stage across multiple positions and preserves the others", async () => {
  const { harness } = await setup();
  try {
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { stages: { id: string }[] };
    const ids = snapshot.stages.map(stage => stage.id);
    const result = await harness.behavior.callRpc("reorderStage", { id: ids[0], targetId: ids[3] }) as { stages: { id: string; position: number }[] };
    expect(result.stages.map(stage => stage.id)).toStrictEqual([...ids.slice(1, 4), ids[0], ...ids.slice(4)]);
    expect(result.stages.map(stage => stage.position)).toStrictEqual(ids.map((_, index) => index));
  } finally { await harness.lifecycle.dispose(); }
});


test("project options expose the configured default machine and Personal label", async () => {
  const { harness } = await setup();
  try {
    harness.inspection.sdk.stub("projects.list", async () => [
      { id: "p1", kind: "standard", name: "Project", sources: [
        { hostId: "other", isDefault: false }, { hostId: "chosen", isDefault: true },
      ] },
      { id: "personal", kind: "personal", name: "Home", sources: [] },
    ]);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { projects: { id: string; name: string; defaultMachineId: string | null }[] };
    expect(snapshot.projects[0]!.name).toBe("Personal");
    expect(snapshot.projects[0]!.defaultMachineId).toBe(null);
    expect(snapshot.projects[1]!.defaultMachineId).toBe("chosen");
  } finally { await harness.lifecycle.dispose(); }
});

test("title renaming synchronizes the thread without changing workflow state", async () => {
  const { harness, importThread } = await setup();
  try {
    const task = await importThread();
    const renamed = await harness.behavior.callRpc("renameTask", { number: task.number, title: "  Revised title  " }) as any;
    expect(renamed.title).toBe("Revised title");
    expect(renamed.stageId).toBe("stage-todo");
    expect(renamed.runState).toBe("idle");
    expect(harness.inspection.sdk.callsTo("threads.update").some((call) => JSON.stringify(call).includes("Triage #1: Revised title"))).toBeTruthy();
    await expect(harness.behavior.callRpc("renameTask", { number: task.number, title: " " })).rejects.toBeDefined();
  } finally { await harness.lifecycle.dispose(); }
});

test("agent instructions explain completion and attention using current stage names", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    await importThread();
    await harness.behavior.callRpc("renameStage", { id: "stage-completed", name: "Shipped" });
    const config = await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: thread.id } }));
    const instructions = JSON.stringify(config);
    expect(instructions).toMatch(/Before your final response/);
    expect(instructions).toMatch(/call triage_move_task with Shipped/);
    expect(instructions).toMatch(/Do not leave finished work/);
    expect(instructions).toMatch(/approve, decide, provide access/);
  } finally { await harness.lifecycle.dispose(); }
});

test("idle preserves completion and new work returns to In Progress", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    const task = await importThread();
    await harness.behavior.emitThreadEvent("thread.active", { thread });
    await harness.behavior.callRpc("moveTask", { number: task.number, stageId: "stage-completed" });
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Done" });
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const read = async () => (await harness.behavior.callRpc("snapshot", null) as { tasks: { stageId: string; runState: string }[] }).tasks[0]!;
    const completed = await read();
    expect(completed.stageId).toBe("stage-completed");
    expect(completed.runState).toBe("completed");
    await harness.behavior.emitThreadEvent("thread.active", { thread });
    const resumed = await read();
    expect(resumed.stageId).toBe("stage-progress");
    expect(resumed.runState).toBe("working");
  } finally { await harness.lifecycle.dispose(); }
});

test("snapshot displays the linked environment's actual branch", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    thread.environmentId = "environment-branch";
    await importThread();
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    harness.inspection.sdk.stub("environments.get", async () => ({ branchName: "feature/notifications", isGitRepo: true }));
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { branchName: string }[] };
    expect(snapshot.tasks[0]?.branchName).toBe("feature/notifications");
  } finally { await harness.lifecycle.dispose(); }
});

test("stage tool rejects another thread and preserves the owner's card", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    const task = await importThread();
    await expect(harness.behavior.callAgentTool("triage_move_task", {
      number: task.number, stage: "Completed", summary: "Done",
    }, { threadId: "unrelated-thread" })).rejects.toThrow(/not assigned/);
    await harness.behavior.callAgentTool("triage_move_task", {
      number: task.number, stage: "Completed", summary: "Verified and complete",
    }, { threadId: thread.id });
    await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "Done" });
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { stageId: string; runState: string }[] };
    expect(snapshot.tasks[0]?.stageId).toBe("stage-completed");
    expect(snapshot.tasks[0]?.runState).toBe("completed");
  } finally { await harness.lifecycle.dispose(); }
});

test("an unavailable environment does not break the board snapshot", async () => {
  const { harness, thread, importThread } = await setup();
  try {
    thread.environmentId = "offline-environment";
    await importThread();
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const snapshot = await harness.behavior.callRpc("snapshot", null) as { tasks: { number: number; sidebarVisible: boolean }[] };
    expect(snapshot.tasks.length).toBe(1);
    expect(snapshot.tasks[0]?.sidebarVisible).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
});

test("reload discards queued sidebar writes from the disposed plugin", async () => {
  const { harness, importThread } = await setup();
  let release: () => void = () => {};
  try {
    await importThread();
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    harness.inspection.sdk.stub("threads.update", async () => {
      writes += 1;
      await blocked;
      return makeThreadResponse();
    });
    await harness.behavior.setSettings({ showThreadsInSidebar: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.behavior.setSettings({ showThreadsInSidebar: false });
    await harness.lifecycle.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(1);
  } finally { release(); await harness.lifecycle.dispose(); }
});

test("editing persists the prompt and schedule across reload and runs the updated request", async () => {
  let { harness, thread } = await setup();
  try {
    const request = {
      projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
      permissionMode: "auto", executionInputSources: {},
      environment: { type: "reuse", environmentId: "environment-1" },
      input: [{ type: "text", text: "Original prompt" }],
    };
    const created = await harness.behavior.callRpc("createTask", {
      title: "Editable task", description: "Original prompt", stageId: "stage-todo",
      scheduledAt: null, runNow: false, request,
    }) as { number: number };
    const scheduledAt = Date.now() + 3_600_000;
    const changes = {
      number: created.number, title: "Edited task", description: "Updated prompt",
      stageId: "stage-todo", scheduledAt,
      request: { ...request, input: [{ type: "text", text: "Updated prompt" }] },
    };
    const updated = await harness.behavior.callRpc("updateTask", changes) as {
      description: string; scheduledAt: number | null; runState: string;
    };
    expect(updated.description).toBe("Updated prompt");
    expect(updated.scheduledAt).toBe(scheduledAt);
    expect(updated.runState).toBe("scheduled");
    ({ harness } = await harness.lifecycle.reload(plugin));
    harness.inspection.sdk.stub("projects.list", async () => []);
    harness.inspection.sdk.stub("hosts.list", async () => []);
    const snapshot = await harness.behavior.callRpc("snapshot", null) as {
      tasks: { description: string; scheduledAt: number | null }[];
    };
    expect(snapshot.tasks[0]!.description).toBe("Updated prompt");
    expect(snapshot.tasks[0]!.scheduledAt).toBe(scheduledAt);
    const manual = await harness.behavior.callRpc("updateTask", { ...changes, scheduledAt: null }) as {
      scheduledAt: number | null; runState: string;
    };
    expect(manual.scheduledAt).toBe(null);
    expect(manual.runState).toBe("queued");
    harness.inspection.sdk.stub("threads.spawn", async (args: { input: { type: string; text?: string; visibility?: string }[] }) => {
      expect(args.input.filter((part) => part.visibility !== "agent-only")).toStrictEqual([{ type: "text", text: "Updated prompt" }]);
      return thread;
    });
    await harness.behavior.callRpc("runTask", { number: created.number });
    expect(harness.inspection.sdk.callsTo("threads.spawn").length).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});
