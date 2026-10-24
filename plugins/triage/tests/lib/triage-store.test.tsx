// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import React, { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

installTestPluginRuntime();

// The store captures the host's plugin-sdk/app bindings at import time, so it
// must load after the test runtime is installed.
const store = await import("../../lib/triage-store.ts");
const { loadAgentOptions, patchTaskRead, patchTaskStage, refreshTriage, requestOpenTask } = store;
type TriageRpc = Parameters<typeof refreshTriage>[0];
import type { Snapshot, Task } from "../../lib/triage-types.ts";

// The board mounts in this file too: it shares the store instance above, and
// the fresh module registry here is the only place its failed-first-load view
// is still reachable (a later success would keep the board forever).
const boardSlot = (await loadPluginApp(() => import("../../app.tsx"))).navPanels[0]!;

function task(overrides: Partial<Task> & Pick<Task, "number">): Task {
  return {
    id: `t-${overrides.number}`,
    title: `Task ${overrides.number}`,
    description: "",
    stageId: "stage-todo",
    projectId: "p",
    projectName: "Project",
    machineId: null,
    machineName: "Default",
    branchName: "main",
    providerId: "claude-code",
    model: "test-model",
    reasoningLevel: "none",
    scheduledAt: null,
    threadId: null,
    runState: "idle",
    attentionReason: null,
    request: null,
    readAt: null,
    settledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const SNAPSHOT: Snapshot = {
  stages: [
    { id: "stage-todo", name: "To Do", position: 100, systemRole: "intake" },
    { id: "stage-progress", name: "In Progress", position: 200, systemRole: "active" },
  ],
  tasks: [task({ number: 1 }), task({ number: 2, stageId: "stage-progress", readAt: 5 })],
  projects: [{ id: "p", kind: "standard", name: "Project", defaultMachineId: null }],
  machines: [{ id: "m", name: "Machine", status: "connected" }],
  notifications: [],
  unreadCount: 0,
};

function fakeRpc(handlers: Partial<Record<string, (input: unknown) => unknown>>) {
  const calls: { method: string; input: unknown }[] = [];
  return {
    calls,
    call: async (method: string, input: unknown) => {
      calls.push({ method, input });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected rpc ${method}`);
      return handler(input);
    },
  };
}

const snapshotRpc = () => fakeRpc({ snapshot: () => SNAPSHOT }) as unknown as TriageRpc;

// Renders the shared store so tests can assert on it the way the board does.
function StoreProbe() {
  const { snapshot, error, loading } = store.useTriage();
  return (
    <div data-testid="store" data-loading={String(loading)} data-error={error ?? ""}>
      {snapshot
        ? snapshot.tasks.map((taskItem) => (
            <span
              key={taskItem.number}
              data-number={taskItem.number}
              data-stage={taskItem.stageId}
              data-read={taskItem.readAt === null ? "unread" : "read"}
            >
              #{taskItem.number}
            </span>
          ))
        : null}
    </div>
  );
}

function renderStoreProbe(rpcHandlers: Partial<Record<string, (input: unknown) => unknown>>) {
  return renderSlot({ component: StoreProbe }, {}, { rpc: rpcHandlers as never });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useTriage and refreshTriage", () => {
  // Runs first: the store module starts pristine (loading, no snapshot), and
  // this is the only point where the board's failed-first-load view exists.
  test("a failed first load explains itself and Try again keeps asking", async () => {
    let calls = 0;
    const view = renderSlot(boardSlot!, {} as never, {
      rpc: {
        snapshot: () => {
          calls += 1;
          throw new Error("host unreachable");
        },
      },
    });
    expect(await screen.findByText("Triage could not load")).toBeTruthy();
    expect(screen.getByText("host unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    // The handler still fails, so the board stays on the error view.
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByText("Triage could not load")).toBeTruthy();
    view.unmount();
  });

  // Runs second: the first load failed, so the store still holds no snapshot.
  test("patches with no snapshot yet are dropped quietly, then the first load lands", async () => {
    let release: () => void = () => {};
    renderStoreProbe({
      snapshot: () => new Promise<Snapshot>((resolve) => { release = () => resolve(SNAPSHOT); }),
    });
    const probe = (await screen.findByTestId("store")) as HTMLElement;
    expect(probe.dataset.error).toBe("host unreachable");
    expect(probe.querySelectorAll("[data-number]").length).toBe(0);
    act(() => {
      patchTaskStage(1, "stage-progress");
      patchTaskRead(1, true);
    });
    expect(probe.querySelectorAll("[data-number]").length).toBe(0);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(probe.querySelectorAll("[data-number]").length).toBe(2));
    expect(probe.querySelector<HTMLElement>('[data-number="1"]')?.dataset.stage).toBe("stage-todo");
  });

  test("a failed load surfaces the error and keeps any previous cards", async () => {
    renderStoreProbe({
      snapshot: () => {
        throw new Error("host gone");
      },
    });
    const probe = (await screen.findByTestId("store")) as HTMLElement;
    await waitFor(() => expect(probe.dataset.error).toBe("host gone"));
    expect(probe.querySelectorAll("[data-number]").length).toBe(2);
    cleanup();
    // A rejection that is not an Error still surfaces as readable text.
    renderStoreProbe({
      snapshot: () => {
        throw "bare string failure";
      },
    });
    await waitFor(() => expect((screen.getByTestId("store") as HTMLElement).dataset.error).toBe("bare string failure"));
    cleanup();
    renderStoreProbe({ snapshot: () => SNAPSHOT });
    await waitFor(() => expect((screen.getByTestId("store") as HTMLElement).dataset.error).toBe(""));
  });

  test("a realtime race during a fetch refetches once after it lands", async () => {
    let release: () => void = () => {};
    let fetches = 0;
    const rpc = fakeRpc({
      snapshot: () => {
        fetches += 1;
        if (fetches === 1) {
          return new Promise<Snapshot>((resolve) => { release = () => resolve({ ...SNAPSHOT, unreadCount: 7 }); });
        }
        return { ...SNAPSHOT, unreadCount: 8 };
      },
    });
    const first = refreshTriage(rpc as unknown as TriageRpc);
    // A realtime event during the in-flight fetch asks for the same refresh;
    // the store folds it into the in-flight fetch instead of doubling up.
    const folded = refreshTriage(rpc as unknown as TriageRpc);
    expect(fetches).toBe(1);
    await act(async () => {
      release();
      await Promise.all([first, folded]);
    });
    // Once the stale-marked fetch lands, the store fetches once more itself.
    await waitFor(() => expect(fetches).toBe(2));
    // Leave the store in a clean, loaded state for the following tests.
    await refreshTriage(snapshotRpc());
  });
});

describe("optimistic patches", () => {
  test("patches rewrite the matching card for every subscriber at once", async () => {
    await refreshTriage(snapshotRpc());
    renderStoreProbe({ snapshot: () => SNAPSHOT });
    await waitFor(() => expect((screen.getByTestId("store") as HTMLElement).dataset.error).toBe(""));
    const probe = screen.getByTestId("store") as HTMLElement;
    expect(probe.querySelector<HTMLElement>('[data-number="1"]')?.dataset.stage).toBe("stage-todo");
    act(() => {
      patchTaskStage(1, "stage-progress");
      patchTaskRead(1, true);
    });
    expect(probe.querySelector<HTMLElement>('[data-number="1"]')?.dataset.stage).toBe("stage-progress");
    expect(probe.querySelector<HTMLElement>('[data-number="1"]')?.dataset.read).toBe("read");
    expect(probe.querySelector<HTMLElement>('[data-number="2"]')?.dataset.read).toBe("read");
    await refreshTriage(snapshotRpc());
  });
});

describe("loadAgentOptions", () => {
  test("a failed catalogue is not cached; a good one loads exactly once", async () => {
    const failing = fakeRpc({});
    await expect(loadAgentOptions(failing as unknown as TriageRpc)).rejects.toThrow("unexpected rpc agentOptions");
    let loads = 0;
    const rpc = fakeRpc({
      agentOptions: () => {
        loads += 1;
        return { providers: [], models: [] };
      },
    });
    const [first, second] = await Promise.all([
      loadAgentOptions(rpc as unknown as TriageRpc),
      loadAgentOptions(rpc as unknown as TriageRpc),
    ]);
    expect(loads).toBe(1);
    expect(first).toStrictEqual({ providers: [], models: [] });
    expect(second).toBe(first);
    await expect(loadAgentOptions(rpc as unknown as TriageRpc)).resolves.toBe(first);
    expect(loads).toBe(1);
  });
});

describe("task open requests", () => {
  test("mounted surfaces hear the request; unmounted ones do not", async () => {
    const seen: number[] = [];
    function ListenerProbe() {
      const [latest, setLatest] = useState<number | null>(null);
      store.useOpenTaskRequests((taskNumber: number) => {
        seen.push(taskNumber);
        setLatest(taskNumber);
      });
      return <div data-testid="listener">{latest === null ? "idle" : `#${latest}`}</div>;
    }
    const probe = renderSlot({ component: ListenerProbe }, {}, { rpc: {} as never });
    expect(probe.getByTestId("listener").textContent).toBe("idle");
    await act(async () => {
      requestOpenTask(5);
    });
    expect(probe.getByTestId("listener").textContent).toBe("#5");
    expect(seen).toStrictEqual([5]);
    probe.unmount();
    expect(() => requestOpenTask(6)).not.toThrow();
    expect(seen).toStrictEqual([5]);
  });
});
