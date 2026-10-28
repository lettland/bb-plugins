// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, test, vi } from "vitest";

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

function renderBoard(handlers: Record<string, Handler> = {}, context?: { projectId: string | null }) {
  return renderSlot(boardSlot, {} as never, {
    rpc: { snapshot: cloneSnapshot, ...handlers } as never,
    context: context ?? { projectId: "p-route" },
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
// @get-bb/plugin-sdk 0.6.79 (dist/testing).
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
