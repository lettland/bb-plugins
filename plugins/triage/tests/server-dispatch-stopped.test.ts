import { expect, test } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

function makeRequest() {
  return {
    projectId: "project-1", providerId: "codex", model: "test-model", reasoningLevel: "none",
    permissionMode: "auto", executionInputSources: {},
    environment: { type: "reuse", environmentId: "environment-1" },
    input: [{ type: "text", text: "Do work" }],
  };
}

async function setup() {
  const thread = makeThreadResponse({ id: "session-1", projectId: "project-1", title: "Existing conversation", visibility: "visible", archivedAt: null });
  const { bb, harness } = createFakePluginHost({
    pluginId: "triage",
    sdk: {
      threads: {
        get: async () => thread,
        defaultExecutionOptions: async () => null,
        update: async (args) => {
          thread.visibility = args.visibility ?? thread.visibility;
          return thread;
        },
        stop: async () => thread,
      },
      projects: { get: async () => ({ id: "project-1", name: "Project" }) },
      environments: { get: async () => { throw new Error("No environment"); } },
    },
  });
  await plugin(bb);
  let spawns = 0;
  harness.inspection.sdk.stub("threads.spawn", async () => {
    spawns += 1;
    return makeThreadResponse({ id: `dispatch-${spawns}`, projectId: "project-1" });
  });
  const createDispatchedTask = async () => {
    return await harness.behavior.callRpc("createTask", {
      title: "Dispatched task", description: "Do work", stageId: "stage-todo", scheduledAt: null, runNow: true,
      request: makeRequest(),
    }) as { number: number; threadId: string | null; runState: string };
  };
  return { harness, spawns: () => spawns, createDispatchedTask };
}

test("a deleted thread frees its card and runTask re-dispatches the stopped card", async () => {
  const { harness, spawns, createDispatchedTask } = await setup();
  try {
    const created = await createDispatchedTask();
    expect(created.threadId).toBe("dispatch-1");
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "dispatch-1", projectId: "project-1" }),
    });
    const rerun = await harness.behavior.callRpc("runTask", { number: created.number }) as {
      threadId: string | null; runState: string;
    };
    expect(rerun.runState).toBe("starting");
    expect(rerun.threadId).toBe("dispatch-2");
    expect(spawns()).toBe(2);
  } finally { await harness.lifecycle.dispose(); }
});

test("a stopped card that still has a thread is not re-dispatched", async () => {
  const { harness, spawns, createDispatchedTask } = await setup();
  try {
    const created = await createDispatchedTask();
    const stopped = await harness.behavior.callRpc("stopTask", { number: created.number }) as {
      threadId: string | null; runState: string;
    };
    expect(stopped.runState).toBe("stopped");
    expect(stopped.threadId).toBe("dispatch-1");
    const rerun = await harness.behavior.callRpc("runTask", { number: created.number }) as {
      threadId: string | null; runState: string;
    };
    expect(rerun.runState).toBe("stopped");
    expect(rerun.threadId).toBe("dispatch-1");
    expect(spawns()).toBe(1);
  } finally { await harness.lifecycle.dispose(); }
});
