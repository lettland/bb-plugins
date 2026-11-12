// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";

// The draft hook is real unless a test switches it: `missing` is a host that lacks it, `throws` one where it breaks.
const draftHook = vi.hoisted(() => ({ mode: "real" as "real" | "missing" | "throws" }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const mocked: Record<string, unknown> = { ...actual };
  Object.defineProperty(mocked, "useSidebarThreadDraftIds", {
    enumerable: true,
    get: () => draftHook.mode === "missing"
      ? undefined
      : draftHook.mode === "throws"
        ? () => { throw new Error("draft hook broke"); }
        : actual.useSidebarThreadDraftIds,
  });
  return mocked;
});

installTestPluginRuntime();

const app = await loadPluginApp(() => import("../app"));
const boardSlot = app.navPanels.find((panel) => panel.id === "triage-board")!;

const NOW = 1_700_000_000_000;

function task(overrides: Record<string, unknown> & { number: number; title: string }) {
  return {
    id: `t-${overrides.number}`,
    description: "",
    stageId: "stage-todo",
    projectId: "p1",
    projectName: "Project One",
    machineId: "machine-1",
    machineName: "Machine One",
    branchName: "main",
    providerId: "claude-code",
    model: "test-model",
    reasoningLevel: "none",
    request: null,
    scheduledAt: null,
    threadId: null,
    runState: "idle",
    attentionReason: null,
    readAt: null,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const TASKS = [
  task({ number: 1, title: "Live task", stageId: "stage-progress", runState: "working", threadId: "thr-live", readAt: NOW - 100, sidebarVisible: true }),
  task({ number: 2, title: "Unread idle", stageId: "stage-attention", runState: "idle", threadId: "thr-idle", attentionReason: "Need a decision", sidebarVisible: false }),
  task({ number: 3, title: "Queued card", stageId: "stage-todo", runState: "queued", projectId: "p2", machineId: null }),
  task({ number: 4, title: "Settled card", stageId: "stage-completed", runState: "completed", threadId: "thr-done", readAt: 50, settledAt: 999, projectId: "p2", machineId: "machine-2", machineName: "Machine Two" }),
  task({ number: 5, title: "Scheduled card", runState: "scheduled", scheduledAt: NOW + 3_600_000 }),
  task({ number: 6, title: "Fallback machine card", stageId: "stage-progress", runState: "working", threadId: "thr-fallback", readAt: 10, machineId: null }),
  task({ number: 7, title: "Legacy failed attention", stageId: "stage-attention", runState: "failed", attentionReason: "Provider failed", settledAt: 777 }),
];

const SNAPSHOT = {
  stages: [
    { id: "stage-todo", name: "To Do", position: 100, systemRole: "intake" },
    { id: "stage-progress", name: "In Progress", position: 200, systemRole: "active" },
    { id: "stage-attention", name: "Human Review", position: 300, systemRole: "attention" },
    { id: "stage-completed", name: "Completed", position: 400, systemRole: "done" },
    { id: "stage-holding", name: "Holding", position: 500, systemRole: null },
  ],
  tasks: TASKS,
  projects: [
    { id: "p1", kind: "standard", name: "Project One", defaultMachineId: "machine-1" },
    { id: "p2", kind: "personal", name: "Personal", defaultMachineId: null },
  ],
  machines: [
    { id: "machine-1", name: "Machine One", status: "connected" },
    { id: "machine-2", name: "Machine Two", status: "disconnected" },
  ],
  notifications: [],
  unreadCount: 0,
};

const cloneSnapshot = () => JSON.parse(JSON.stringify(SNAPSHOT));

type Handler = (input: unknown) => unknown;

function renderBoard(
  handlers: Record<string, Handler> = {},
  context?: { projectId: string | null },
  host: { sidebarDraftThreadIds?: string[]; sidebarThreads?: Record<string, unknown> } = {},
) {
  return renderSlot(boardSlot, {} as never, {
    rpc: { snapshot: cloneSnapshot, ...handlers } as never,
    context: context ?? { projectId: "p-route" },
    ...(host as object),
  });
}

function deferred<T>() {
  let release: (value: T) => void = () => {};
  let entered: () => void = () => {};
  const wasEntered = new Promise<void>((resolve) => { entered = resolve; });
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release, wasEntered, entered };
}

// The test runtime wraps every rpc rejection in an Error before the board sees
// it, so the board's String(error) toast arm is unreachable through handlers.
// A probe rides along in the slot tree to capture the rpc client, and a test
// then points one method at a raw non-Error rejection. Quirk learned under
// @get-bb/plugin-sdk 0.6.79 (dist/testing/app.js).
type RawRpcClient = { call: (method: string, input: unknown) => Promise<unknown> };
let rawRpcClient: RawRpcClient | null = null;

function CaptureRpcClient() {
  rawRpcClient = useRpc() as unknown as RawRpcClient;
  return null;
}

const Board = (boardSlot as unknown as { component: () => ReactElement }).component;

function BoardWithCapturedRpc() {
  return (
    <>
      <CaptureRpcClient />
      <Board />
    </>
  );
}

function renderBoardWithCapturedRpc(handlers: Record<string, Handler> = {}) {
  rawRpcClient = null;
  const view = renderSlot(
    { component: BoardWithCapturedRpc } as never,
    {} as never,
    { rpc: { snapshot: cloneSnapshot, ...handlers } as never, context: { projectId: "p-route" } },
  );
  if (rawRpcClient === null) throw new Error("rpc client was not captured");
  return view;
}

/** Routes one method to a raw non-Error rejection; everything else passes through. */
function rejectRaw(rpc: RawRpcClient, method: string, rejection: unknown): void {
  const passthrough = rpc.call.bind(rpc);
  rpc.call = (called, input) => called === method ? Promise.reject(rejection) : passthrough(called, input);
}

function columnOf(stageName: string): HTMLElement {
  const header = screen.getByText(stageName);
  const section = header.closest<HTMLElement>("section");
  if (!section) throw new Error(`no column section for ${stageName}`);
  return section;
}

function cardElement(title: string): HTMLElement {
  const titleButton = screen.getByRole("button", { name: title });
  const card = titleButton.closest<HTMLElement>("div.triage-card");
  if (!card) throw new Error(`no card for ${title}`);
  return card;
}

function dragTransfer() {
  return { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
}

// jsdom has no DragEvent, so relatedTarget has to be attached by hand.
function dragEvent(type: string, relatedTarget: EventTarget | null): Event {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
  return event;
}

async function openCardMenu(taskNumber: number) {
  const trigger = screen.getByRole("button", { name: `Actions for Triage #${taskNumber}` });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(trigger);
  try {
    await screen.findByRole("menu", {}, { timeout: 500 });
  } catch {
    fireEvent.keyDown(trigger, { key: "Enter" });
    await screen.findByRole("menu");
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registration", () => {
  test("the plugin registers the board and the thread action", () => {
    expect(app.navPanels.map((panel: any) => panel.id)).toStrictEqual(["triage-board"]);
    expect(boardSlot.path).toBe("triage");
    expect((boardSlot as any).headerContent).toBeTypeOf("function");
    expect(app.threadHeaderActions.map((action: any) => action.id)).toStrictEqual(["triage-thread-action"]);
    // The sidebar list retirement left no thread-list registration behind.
    expect(app.threadLists).toStrictEqual([]);
  });
});

describe("board rendering", () => {
  // Runs first: the store module starts pristine, and the skeleton is the only
  // view that exists before any snapshot has landed.
  test("a load in flight shows the skeleton, then the board lands", async () => {
    const pending = deferred<unknown>();
    const view = renderBoard({ snapshot: () => pending.promise });
    await waitFor(() => expect(view.inspection.rpcCalls.length).toBe(1));
    // The skeleton shows column shapes but no named columns and no lens.
    expect(view.container.querySelector(".triage-column-name")).toBe(null);
    expect(screen.queryByRole("button", { name: "All 5" })).toBe(null);
    pending.release(cloneSnapshot());
    await screen.findByText("In Progress");
    expect(screen.getByText("Live task")).toBeTruthy();
    expect(view.container.querySelector(".triage-column-name")).not.toBe(null);
  });

  test("counts and cards land in their columns", async () => {
    renderBoard();
    await screen.findByText("Live task");
    expect(screen.getByRole("button", { name: /^All\s*5$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Running\s*2$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Unread\s*1$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Settled\s*1$/ })).toBeTruthy();
    expect(within(columnOf("In Progress")).getByText("Live task")).toBeTruthy();
    expect(within(columnOf("In Progress")).getByText("Fallback machine card")).toBeTruthy();
    expect(within(columnOf("Human Review")).getByText("Unread idle")).toBeTruthy();
    expect(within(columnOf("To Do")).getByText("Queued card")).toBeTruthy();
    expect(within(columnOf("To Do")).getByText("Scheduled card")).toBeTruthy();
    // The default lens hides settled cards, so the done column is empty here.
    expect(within(columnOf("Completed")).getByText("No cards yet")).toBeTruthy();
    expect(within(columnOf("Holding")).getByText("No cards yet")).toBeTruthy();
    expect(within(columnOf("Human Review")).getByText("Need a decision")).toBeTruthy();
  });

});

describe("opening cards", () => {
  test("an unread card is marked read and its thread opens", async () => {
    const view = renderBoard({ setTaskRead: () => ({ ok: true }) });
    await screen.findByText("Unread idle");
    fireEvent.click(screen.getByRole("button", { name: "Unread idle" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setTaskRead", input: { number: 2, read: true },
    }));
    expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-idle" });
  });

  test("a read card opens without another read call", async () => {
    const view = renderBoard();
    await screen.findByText("Live task");
    fireEvent.click(screen.getByRole("button", { name: "Live task" }));
    await waitFor(() => expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-live" }));
    expect(view.inspection.rpcCalls.filter((call) => call.method === "setTaskRead")).toHaveLength(0);
  });

  test("a card without a thread opens the editor instead, and closing clears it", async () => {
    const view = renderBoard();
    await screen.findByText("Queued card");
    fireEvent.click(screen.getByRole("button", { name: "Queued card" }));
    expect(await screen.findByText("Edit Triage #3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByText("Edit Triage #3")).toBe(null));
    expect(view.inspection.rpcCalls.filter((call) => call.method === "setTaskRead")).toHaveLength(0);
  });

  test("open requests arrive through the store, and unknown cards are ignored", async () => {
    const view = renderBoard({ setTaskRead: () => ({ ok: true }) });
    await screen.findByText("Unread idle");
    await act(async () => {
      const store = await import("../lib/triage-store.ts");
      store.requestOpenTask(99);
      store.requestOpenTask(2);
    });
    await waitFor(() => expect(view.inspection.navigateCalls).toContainEqual({ method: "toThread", threadId: "thr-idle" }));
    expect(view.inspection.rpcCalls.filter((call) => call.method === "setTaskRead")).toHaveLength(1);
  });
});

describe("filters", () => {
  test("the lens buttons narrow the board", async () => {
    renderBoard();
    await screen.findByText("Live task");
    fireEvent.click(screen.getByRole("button", { name: /^Running\d*$/ }));
    expect(screen.getByText("Live task")).toBeTruthy();
    expect(screen.queryByText("Unread idle")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /^Unread\d*$/ }));
    expect(screen.getByText("Unread idle")).toBeTruthy();
    // Queued and scheduled cards offer nothing to read, so they are not unread.
    expect(screen.queryByText("Queued card")).toBe(null);
    expect(screen.queryByText("Scheduled card")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /^Settled\d*$/ }));
    expect(screen.getByText("Settled card")).toBeTruthy();
    expect(screen.queryByText("Legacy failed attention")).toBe(null);
    expect(within(columnOf("To Do")).getByText("Nothing matches this filter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^All\d*$/ }));
    expect(screen.getByText("Queued card")).toBeTruthy();
  });

  test("dragging over an empty column invites the drop", async () => {
    renderBoard();
    await screen.findByText("Live task");
    fireEvent.click(screen.getByRole("button", { name: "Settled1" }));
    expect(within(columnOf("To Do")).getByText("Nothing matches this filter")).toBeTruthy();
    fireEvent.dragStart(cardElement("Settled card"), { dataTransfer: dragTransfer() });
    expect(within(columnOf("To Do")).getByText("Drop in To Do")).toBeTruthy();
    expect(within(columnOf("Holding")).getByText("Drop in Holding")).toBeTruthy();
    fireEvent.dragEnd(cardElement("Settled card"));
    expect(within(columnOf("To Do")).getByText("Nothing matches this filter")).toBeTruthy();
  });

  test("the project picker also scopes the machine filter", async () => {
    renderBoard();
    await screen.findByText("Live task");
    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    const listbox = screen.getByRole("listbox", { name: "Projects" });
    fireEvent.click(within(listbox).getByRole("option", { name: "Project One" }));
    // p1's default machine exists, so the machine scope follows the project;
    // a p1 card without a machine of its own rides that default.
    expect(screen.queryByText("Queued card")).toBe(null);
    expect(screen.getByText("Live task")).toBeTruthy();
    expect(screen.getByText("Scheduled card")).toBeTruthy();
    expect(screen.getByText("Fallback machine card")).toBeTruthy();
    expect(screen.queryByText("Settled card")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
    fireEvent.click(within(screen.getByRole("listbox", { name: "Projects" })).getByRole("option", { name: "All projects" }));
    await waitFor(() => expect(screen.getByText("Queued card")).toBeTruthy());
  });
});

describe("drag and drop", () => {
  test("dropping a card moves it optimistically, then confirms", async () => {
    const move = deferred<unknown>();
    const view = renderBoard({ moveTask: () => move.promise });
    await screen.findByText("Queued card");
    const todo = columnOf("To Do");
    const progress = columnOf("In Progress");
    // Dragging over a column without a card does nothing.
    fireEvent.dragOver(progress, { dataTransfer: dragTransfer() });
    expect(progress.getAttribute("data-dropping")).toBe(null);
    fireEvent.dragStart(cardElement("Queued card"), { dataTransfer: dragTransfer() });
    fireEvent.dragOver(progress, { dataTransfer: dragTransfer() });
    expect(progress.getAttribute("data-dropping")).toBe("");
    // Crossing into a child keeps the highlight; leaving the column clears it.
    fireEvent(progress, dragEvent("dragleave", within(progress).getByText("Live task")));
    expect(progress.getAttribute("data-dropping")).toBe("");
    fireEvent.dragOver(progress, { dataTransfer: dragTransfer() });
    fireEvent.dragLeave(progress, { relatedTarget: null });
    expect(progress.getAttribute("data-dropping")).toBe(null);
    fireEvent.dragOver(progress, { dataTransfer: dragTransfer() });
    fireEvent.drop(progress, { dataTransfer: dragTransfer() });
    expect(view.inspection.rpcCalls).toContainEqual({ method: "moveTask", input: { number: 3, stageId: "stage-progress" } });
    // The optimistic patch lands the card before the server answers; columns
    // re-render, so query them fresh instead of holding old nodes.
    await waitFor(() => expect(within(columnOf("In Progress")).getByText("Queued card")).toBeTruthy());
    expect(within(columnOf("To Do")).queryByText("Queued card")).toBe(null);
    move.release({ ok: true });
    await waitFor(() => expect(view.inspection.rpcCalls.filter((call) => call.method === "snapshot").length).toBeGreaterThan(1));
    // The mocked server never moved the card, so the refresh reconciles it back.
    expect(within(columnOf("To Do")).getByText("Queued card")).toBeTruthy();
    void todo;
  });

  test("dropping on the same column is a no-op and a bare drop does nothing", async () => {
    const view = renderBoard();
    await screen.findByText("Live task");
    const progress = columnOf("In Progress");
    fireEvent.drop(progress, { dataTransfer: dragTransfer() });
    fireEvent.dragStart(cardElement("Live task"), { dataTransfer: dragTransfer() });
    fireEvent.drop(progress, { dataTransfer: dragTransfer() });
    expect(view.inspection.rpcCalls.filter((call) => call.method === "moveTask")).toHaveLength(0);
  });

  test("a failed move warns and snaps the card back", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("toast");
    renderBoard({ moveTask: () => { throw new Error("Stage is locked"); } });
    await screen.findByText("Queued card");
    fireEvent.dragStart(cardElement("Queued card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("In Progress"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("Stage is locked"));
    await waitFor(() => expect(within(columnOf("To Do")).getByText("Queued card")).toBeTruthy());
  });
});

describe("realtime notifications", () => {
  test("notifications toast by level and claim exactly one refresh per event", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    const successSpy = vi.spyOn(toast, "success").mockReturnValue("t");
    const infoSpy = vi.spyOn(toast, "info").mockReturnValue("t");
    const view = renderBoard();
    await screen.findByText("Live task");
    const snapshotCalls = () => view.inspection.rpcCalls.filter((call) => call.method === "snapshot").length;
    const base = snapshotCalls();
    await view.behavior.emitRealtime("triage", {
      at: 100,
      notification: { taskNumber: 2, action: "Needs attention", taskTitle: "Unread idle", title: "t", body: "boom", level: "attention" },
    });
    expect(errorSpy).toHaveBeenCalledWith("Needs attention", { description: "#2 · Unread idle" });
    await waitFor(() => expect(snapshotCalls()).toBe(base + 1));
    // The same event heard again still toasts but does not refetch.
    await view.behavior.emitRealtime("triage", {
      at: 100,
      notification: { taskNumber: 2, action: "Moved", taskTitle: null, title: "t", body: "", level: "success" },
    });
    expect(successSpy).toHaveBeenCalled();
    expect(snapshotCalls()).toBe(base + 1);
    // An event without a stamp always claims, and carries no toast of its own.
    await view.behavior.emitRealtime("triage", { at: 101 });
    await waitFor(() => expect(snapshotCalls()).toBe(base + 2));
    expect(infoSpy).not.toHaveBeenCalled();
    // A broadcast without a card names its body instead of a number.
    await view.behavior.emitRealtime("triage", {
      at: 102,
      notification: { taskNumber: null, action: "Heads up", taskTitle: null, title: "t", body: "Plain body", level: "info" },
    });
    expect(infoSpy).toHaveBeenCalledWith("Heads up", { description: "Plain body" });
    // A card number without a stored title still names its number.
    await view.behavior.emitRealtime("triage", {
      at: 103,
      notification: { taskNumber: 9, action: "Agent started", taskTitle: null, title: "t", body: "b", level: "info" },
    });
    expect(infoSpy).toHaveBeenCalledWith("Agent started", { description: "#9" });
  });

  test("a hidden window surfaces a browser notification with a stable tag", async () => {
    const infoSpy = vi.spyOn(toast, "info").mockReturnValue("t");
    const sent: { title: string; options?: NotificationOptions }[] = [];
    class NotificationStub {
      static permission = "granted";
      constructor(title: string, options?: NotificationOptions) {
        sent.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", NotificationStub);
    // jsdom keeps visibilityState as a prototype getter; shadow it for the test
    // and drop the own property afterwards so the getter shows through again.
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      const view = renderBoard();
      await screen.findByText("Live task");
      await view.behavior.emitRealtime("triage", {
        at: 200,
        notification: { taskNumber: 7, action: "Agent started", taskTitle: "Deep task", title: "t", body: "b", level: "info" },
      });
      await view.behavior.emitRealtime("triage", {
        at: 201,
        notification: { taskNumber: null, action: "Broadcast", taskTitle: null, title: "t", body: "b", level: "info" },
      });
      expect(sent.map((entry) => entry.options?.tag)).toStrictEqual(["triage-7", "triage-general"]);
      expect(infoSpy).toHaveBeenCalledTimes(2);
    } finally {
      delete (document as any).visibilityState;
    }
  });

  test("a visible window never issues browser notifications", async () => {
    class NotificationStub {
      static permission = "granted";
    }
    const constructed: unknown[] = [];
    vi.stubGlobal("Notification", class {
      constructor() { constructed.push(this); }
      static permission = "granted";
    });
    const view = renderBoard();
    await screen.findByText("Live task");
    await view.behavior.emitRealtime("triage", {
      at: 300,
      notification: { taskNumber: 1, action: "Agent started", taskTitle: "Live task", title: "t", body: "b", level: "info" },
    });
    expect(constructed).toHaveLength(0);
  });
});

describe("card actions", () => {
  test("the settle button settles, and the settled lens offers the reopen", async () => {
    const view = renderBoard();
    await screen.findByText("Queued card");
    fireEvent.click(screen.getByRole("button", { name: "Mark Triage #3 settled" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setTaskSettled", input: { number: 3, settled: true },
    }));
    // Settled cards live behind the Settled lens; the mocked snapshot keeps
    // card 4 there, and its button now reopens.
    fireEvent.click(screen.getByRole("button", { name: "Settled1" }));
    await screen.findByText("Settled card");
    fireEvent.click(screen.getByRole("button", { name: "Reopen Triage #4" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setTaskSettled", input: { number: 4, settled: false },
    }));
  });

  test("the card menu runs, stops, retags reads, toggles the sidebar, and moves", async () => {
    const view = renderBoard({ runTask: () => ({ ok: true }), stopTask: () => ({ ok: true }) });
    await screen.findByText("Live task");

    await openCardMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop agent" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({ method: "stopTask", input: { number: 1 } }));

    await openCardMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide session from sidebar" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setThreadSidebar", input: { number: 1, visible: false },
    }));

    await openCardMenu(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show session in sidebar" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setThreadSidebar", input: { number: 2, visible: true },
    }));

    await openCardMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "setTaskRead", input: { number: 1, read: false },
    }));

    await openCardMenu(1);
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Move to" }), { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Completed" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({
      method: "moveTask", input: { number: 1, stageId: "stage-completed" },
    }));

    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({ method: "runTask", input: { number: 3 } }));
  });

  test("deleting asks first, then removes the card", async () => {
    const view = renderBoard({ deleteTask: () => ({ ok: true }) });
    await screen.findByText("Queued card");
    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Delete Triage #3?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete card" }));
    await waitFor(() => expect(view.inspection.rpcCalls).toContainEqual({ method: "deleteTask", input: { number: 3 } }));
  });

  test("a failed action toasts the reason and keeps the board", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    renderBoard({ runTask: () => { throw new Error("Host is offline"); } });
    await screen.findByText("Queued card");
    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("Host is offline"));
  });

  test("non-Error failures still produce readable toasts, on actions and moves", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    renderBoard({
      runTask: () => { throw "plain string refusal"; },
      moveTask: () => { throw "plain string move refusal"; },
    });
    await screen.findByText("Queued card");
    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("plain string refusal"));
    fireEvent.dragStart(cardElement("Queued card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("In Progress"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("plain string move refusal"));
  });

  test("a raw non-Error rejection still produces a readable toast after an action", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    renderBoardWithCapturedRpc({ runTask: () => ({ ok: true }) });
    await screen.findByText("Queued card");
    rejectRaw(rawRpcClient!, "runTask", "boom-not-an-error");
    await openCardMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("boom-not-an-error"));
  });

  test("a raw non-Error rejection still produces a readable toast after a move", async () => {
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    renderBoardWithCapturedRpc({ moveTask: () => ({ ok: true }) });
    await screen.findByText("Queued card");
    rejectRaw(rawRpcClient!, "moveTask", "boom-not-an-error");
    fireEvent.dragStart(cardElement("Queued card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("In Progress"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(errorSpy).toHaveBeenCalledWith("boom-not-an-error"));
  });
});

// drag highlight tests.
describe("board drag highlight", () => {
  test("drag leave keeps another column's highlight and clears its own", async () => {
    renderBoard();
    await screen.findByText("Live task");
    fireEvent.dragStart(cardElement("Live task"), { dataTransfer: dragTransfer() });
    const todo = columnOf("To Do");
    fireEvent.dragOver(todo, { dataTransfer: dragTransfer() });
    expect(todo.getAttribute("data-dropping")).toBe("");
    // A leave bound for outside while another column holds the highlight
    // reaches the keep arm: the highlight stays on the hovered column.
    fireEvent.dragLeave(columnOf("In Progress"), { relatedTarget: document.body });
    expect(todo.getAttribute("data-dropping")).toBe("");
    // Leaving the hovered column itself clears it.
    fireEvent.dragLeave(todo, { relatedTarget: document.body });
    expect(todo.getAttribute("data-dropping")).toBe(null);
  });
});

// Drafts: useSidebarThreadDraftIds() reports the thread ids that hold an unsent draft (SDK
// bundled-types PluginSdkApp.useSidebarThreadDraftIds, @get-bb/plugin-sdk 0.6.90). The board
// reads ids only and shows a drafted card the board would otherwise hide as an open To Do card.
describe("sidebar drafts", () => {
  const snapshotOf = (tasks: unknown[]) => () => ({ ...cloneSnapshot(), tasks });
  const mirrorCard = (overrides: Record<string, unknown> & { number: number; title: string }) =>
    task({ stageId: "stage-progress", runState: "idle", ...overrides });
  const drafted = (ids: string[], extra: Record<string, unknown> = {}) => ({ sidebarDraftThreadIds: ids, ...extra });
  const rpcMethods = (view: ReturnType<typeof renderBoard>, method: string) =>
    view.inspection.rpcCalls.filter((call: any) => call.method === method);

  test("a settled mirror card with a draft shows in To Do and counts as open; without the draft it stays settled", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Draft card", threadId: "thr-d1", settledAt: 500, readAt: 5 }),
      mirrorCard({ number: 11, title: "Plain settled", threadId: "thr-d2", settledAt: 600, readAt: 5 }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1"]));
    await screen.findByText("Draft card");
    expect(within(columnOf("To Do")).getByText("Draft card")).toBeTruthy();
    expect(within(columnOf("In Progress")).queryByText("Draft card")).toBe(null);
    expect(screen.queryByText("Plain settled")).toBe(null);
    expect(screen.getByRole("button", { name: "All1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settled1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settled1" }));
    expect(screen.getByText("Plain settled")).toBeTruthy();
    expect(screen.queryByText("Draft card")).toBe(null);
    cleanup();
    renderBoard({ snapshot: snapshotOf(tasks) });
    await screen.findByText("In Progress");
    expect(screen.queryByText("Draft card")).toBe(null);
    expect(screen.getByRole("button", { name: "All0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settled2" })).toBeTruthy();
  });

  test("a drafted unread card counts as unread and one with no read state does not", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Unread draft", threadId: "thr-d1", settledAt: 500 }),
      mirrorCard({ number: 12, title: "Queued draft", threadId: "thr-d3", runState: "queued", readAt: null }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1", "thr-d3"]));
    await screen.findByText("Unread draft");
    fireEvent.click(screen.getByRole("button", { name: "Unread1" }));
    expect(screen.getByText("Unread draft")).toBeTruthy();
    expect(screen.queryByText("Queued draft")).toBe(null);
    fireEvent.click(screen.getByRole("button", { name: /^Running\d*$/ }));
    expect(screen.queryByText("Unread draft")).toBe(null);
  });

  test("a drafted settled card offers Reopen, and its Move-to menu marks the stored stage", async () => {
    const tasks = [mirrorCard({ number: 10, title: "Draft card", threadId: "thr-d1", settledAt: 500, readAt: 5 })];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1"]));
    await screen.findByText("Draft card");
    expect(screen.getByRole("button", { name: "Reopen Triage #10" })).toBeTruthy();
    await openCardMenu(10);
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Move to" }), { pointerType: "mouse" });
    const stored = await screen.findByRole("menuitemradio", { name: "In Progress" });
    expect(stored.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "To Do" }).getAttribute("aria-checked")).toBe("false");
  });

  test("a draft with no card, and one on a deleted thread's absent card, renders nothing and counts nothing", async () => {
    const tasks = [mirrorCard({ number: 10, title: "Other card", threadId: "thr-d1", settledAt: 500 })];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-ghost", "thr-tombstoned"]));
    await screen.findByText("In Progress");
    expect(screen.queryByText("Other card")).toBe(null);
    expect(screen.getByRole("button", { name: "All0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Settled1" })).toBeTruthy();
  });

  test("a failed mirror card and a done-stage mirror card with drafts both show in To Do", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Failed draft", threadId: "thr-d1", runState: "failed", settledAt: 500, attentionReason: "boom" }),
      mirrorCard({ number: 11, title: "Done draft", threadId: "thr-d2", stageId: "stage-completed", runState: "completed", settledAt: 600 }),
      mirrorCard({ number: 12, title: "Failed plain", threadId: "thr-d3", runState: "failed", settledAt: 700 }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1", "thr-d2"]));
    await screen.findByText("Failed draft");
    const todo = within(columnOf("To Do"));
    expect(todo.getByText("Failed draft")).toBeTruthy();
    expect(todo.getByText("Done draft")).toBeTruthy();
    expect(screen.queryByText("Failed plain")).toBe(null);
    expect(screen.getByRole("button", { name: "All2" })).toBeTruthy();
  });

  test("a visible manual card and a running card with drafts stay in their own columns", async () => {
    const tasks = [
      task({ number: 10, title: "Manual draft", stageId: "stage-attention", runState: "idle", threadId: "thr-d1" }),
      mirrorCard({ number: 11, title: "Running draft", threadId: "thr-d2", runState: "working" }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1", "thr-d2"]));
    await screen.findByText("Manual draft");
    expect(within(columnOf("Human Review")).getByText("Manual draft")).toBeTruthy();
    expect(within(columnOf("In Progress")).getByText("Running draft")).toBeTruthy();
    expect(within(columnOf("To Do")).queryByText("Manual draft")).toBe(null);
    expect(within(columnOf("To Do")).queryByText("Running draft")).toBe(null);
  });

  test("a visible card with a draft stays in its stored column, even in the done stage, and a hidden manual card shows in To Do", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Done open draft", threadId: "thr-d1", stageId: "stage-completed", runState: "completed" }),
      task({ number: 11, title: "Manual hidden draft", stageId: "stage-attention", runState: "idle", threadId: "thr-d2", settledAt: 500 }),
      task({ number: 12, title: "Manual visible draft", stageId: "stage-attention", runState: "idle", threadId: "thr-d3" }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1", "thr-d2", "thr-d3"]));
    await screen.findByText("Done open draft");
    expect(within(columnOf("Completed")).getByText("Done open draft")).toBeTruthy();
    expect(within(columnOf("To Do")).queryByText("Done open draft")).toBe(null);
    expect(within(columnOf("To Do")).getByText("Manual hidden draft")).toBeTruthy();
    expect(within(columnOf("Human Review")).getByText("Manual visible draft")).toBeTruthy();
    expect(within(columnOf("To Do")).queryByText("Manual visible draft")).toBe(null);
  });

  test("four drafted threads in mixed hidden states all show in To Do beside an open working card", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Settled active", threadId: "thr-d1", settledAt: 500 }),
      mirrorCard({ number: 11, title: "Settled intake", threadId: "thr-d2", stageId: "stage-todo", settledAt: 600 }),
      mirrorCard({ number: 12, title: "Failed card", threadId: "thr-d3", runState: "failed", attentionReason: "boom" }),
      mirrorCard({ number: 13, title: "Settled done", threadId: "thr-d4", stageId: "stage-completed", runState: "completed", settledAt: 700 }),
      mirrorCard({ number: 14, title: "Working card", threadId: "thr-w1", runState: "working" }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1", "thr-d2", "thr-d3", "thr-d4"]));
    await screen.findByText("Working card");
    const todo = within(columnOf("To Do"));
    for (const title of ["Settled active", "Settled intake", "Failed card", "Settled done"]) {
      expect(todo.getByText(title)).toBeTruthy();
    }
    expect(within(columnOf("In Progress")).getByText("Working card")).toBeTruthy();
    expect(within(columnOf("In Progress")).queryByText("Settled active")).toBe(null);
    expect(within(columnOf("Completed")).queryByText("Settled done")).toBe(null);
    expect(screen.getByRole("button", { name: "All5" })).toBeTruthy();
  });

  test("a draft on a sub-thread shows its top-level thread's card, and a parent cycle ends the walk", async () => {
    const sidebarThreads = { threads: [
      { id: "thr-sub", parentThreadId: "thr-mid" },
      { id: "thr-mid", parentThreadId: "thr-top" },
      { id: "thr-top", parentThreadId: null },
      { id: "cyc-a", parentThreadId: "cyc-b" },
      { id: "cyc-b", parentThreadId: "cyc-a" },
    ] };
    const tasks = [
      mirrorCard({ number: 10, title: "Parent card", threadId: "thr-top", settledAt: 500 }),
      mirrorCard({ number: 11, title: "Cycle card", threadId: "cyc-c", settledAt: 600 }),
    ];
    renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-sub", "cyc-a"], { sidebarThreads }));
    await screen.findByText("Parent card");
    expect(within(columnOf("To Do")).getByText("Parent card")).toBeTruthy();
    expect(screen.queryByText("Cycle card")).toBe(null);
  });

  test("dragging a drafted card out of To Do moves it, even to its stored stage, and reopens a settled one", async () => {
    const tasks = [
      mirrorCard({ number: 10, title: "Settled draft", threadId: "thr-d1", settledAt: 500, readAt: 5 }),
      mirrorCard({ number: 11, title: "Failed draft card", threadId: "thr-d2", runState: "failed", readAt: 5 }),
    ];
    const view = renderBoard({ snapshot: snapshotOf(tasks), moveTask: () => ({ ok: true }), setTaskSettled: () => ({ ok: true }) }, undefined, drafted(["thr-d1", "thr-d2"]));
    await screen.findByText("Settled draft");
    fireEvent.dragStart(cardElement("Settled draft"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("In Progress"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(rpcMethods(view, "setTaskSettled")).toStrictEqual([
      { method: "setTaskSettled", input: { number: 10, settled: false } },
    ]));
    expect(rpcMethods(view, "moveTask")).toStrictEqual([
      { method: "moveTask", input: { number: 10, stageId: "stage-progress" } },
    ]);
    // A failed drafted card would stay failed and land back in To Do, so a move outside Completed is refused.
    const errorSpy = vi.spyOn(toast, "error").mockReturnValue("t");
    fireEvent.dragStart(cardElement("Failed draft card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("Human Review"), { dataTransfer: dragTransfer() });
    await flushBoard();
    expect(rpcMethods(view, "moveTask")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("stays in To Do while its session has an unsent draft"));
    expect(within(columnOf("To Do")).getByText("Failed draft card")).toBeTruthy();
    expect(within(columnOf("Human Review")).queryByText("Failed draft card")).toBe(null);
    errorSpy.mockRestore();
    // Dropping back on To Do changes nothing.
    fireEvent.dragStart(cardElement("Failed draft card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("To Do"), { dataTransfer: dragTransfer() });
    await flushBoard();
    expect(rpcMethods(view, "moveTask")).toHaveLength(1);
    // The card menu follows the same rule, and Completed is allowed.
    await openCardMenu(11);
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Move to" }), { pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Completed" }));
    await waitFor(() => expect(rpcMethods(view, "moveTask")).toStrictEqual([
      { method: "moveTask", input: { number: 10, stageId: "stage-progress" } },
      { method: "moveTask", input: { number: 11, stageId: "stage-completed" } },
    ]));
  });

  test("a failed drafted card moved to Completed renders there once its run state is completed", async () => {
    let moved = false;
    renderBoard({
      snapshot: () => snapshotOf([mirrorCard({
        number: 11, title: "Failed to done", threadId: "thr-d2", readAt: 5,
        ...(moved ? { stageId: "stage-completed", runState: "completed" } : { runState: "failed", attentionReason: "boom" }),
      })])(),
      moveTask: () => { moved = true; return { ok: true }; },
    }, undefined, drafted(["thr-d2"]));
    await screen.findByText("Failed to done");
    fireEvent.dragStart(cardElement("Failed to done"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("Completed"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(within(columnOf("Completed")).getByText("Failed to done")).toBeTruthy());
    expect(within(columnOf("To Do")).queryByText("Failed to done")).toBe(null);
  });

  test("a settled drafted card dragged out of To Do renders in its new column once reopened", async () => {
    let reopened = false;
    const card = (open: boolean) => mirrorCard({
      number: 10, title: "Snap draft", threadId: "thr-d1", readAt: 5,
      ...(open ? { stageId: "stage-attention", settledAt: null } : { settledAt: 500 }),
    });
    renderBoard({
      snapshot: () => snapshotOf([card(reopened)])(),
      moveTask: () => ({ ok: true }),
      setTaskSettled: () => { reopened = true; return { ok: true }; },
    }, undefined, drafted(["thr-d1"]));
    await screen.findByText("Snap draft");
    expect(within(columnOf("To Do")).getByText("Snap draft")).toBeTruthy();
    fireEvent.dragStart(cardElement("Snap draft"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("Human Review"), { dataTransfer: dragTransfer() });
    await waitFor(() => expect(within(columnOf("Human Review")).getByText("Snap draft")).toBeTruthy());
    expect(within(columnOf("To Do")).queryByText("Snap draft")).toBe(null);
  });

  test("a card without a draft keeps the plain move rule", async () => {
    const tasks = [mirrorCard({ number: 10, title: "Plain card", threadId: "thr-d1", stageId: "stage-todo" })];
    const view = renderBoard({ snapshot: snapshotOf(tasks), moveTask: () => ({ ok: true }) }, undefined, drafted(["thr-other"]));
    await screen.findByText("Plain card");
    fireEvent.dragStart(cardElement("Plain card"), { dataTransfer: dragTransfer() });
    fireEvent.drop(columnOf("To Do"), { dataTransfer: dragTransfer() });
    await flushBoard();
    expect(rpcMethods(view, "moveTask")).toHaveLength(0);
  });

  test("a host without the draft hook, and one where it throws, still renders the board twice and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tasks = [mirrorCard({ number: 10, title: "Hook card", threadId: "thr-d1", settledAt: 500 })];
    for (const mode of ["missing", "throws"] as const) {
      draftHook.mode = mode;
      try {
        renderBoard({ snapshot: snapshotOf(tasks) }, undefined, drafted(["thr-d1"]));
        await screen.findByText("In Progress");
        expect(screen.queryByText("Hook card")).toBe(null);
        // A second render: a lens change re-renders the board with the same hook order.
        fireEvent.click(screen.getByRole("button", { name: /^Settled\d*$/ }));
        expect(screen.getByText("Hook card")).toBeTruthy();
      } finally {
        draftHook.mode = "real";
        cleanup();
      }
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("could not read sidebar drafts");
  });
});

const flushBoard = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
