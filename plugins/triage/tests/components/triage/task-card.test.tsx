// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TaskCard } from "@/components/triage/task-card";
import { makeStage, makeTask, resetSdk } from "./helpers";

import type { TaskCardProps } from "@/components/triage/task-card";
import type { Task } from "@/lib/triage-types";

vi.mock("@get-bb/plugin-sdk/app", async () => {
  const { createSdkAppMock } = await import("./helpers");
  return createSdkAppMock();
});

vi.mock("sonner", async () => {
  const { createSonnerMock } = await import("./helpers");
  return createSonnerMock();
});

afterEach(cleanup);

beforeEach(() => {
  resetSdk();
});

function renderCard(overrides: Partial<Task> = {}, propOverrides: Partial<TaskCardProps> = {}) {
  const props = {
    task: makeTask(overrides),
    stages: [
      makeStage(),
      makeStage({ id: "stage-2", name: "In progress", position: 1, systemRole: "active" }),
    ],
    showMachine: false,
    onOpen: vi.fn(),
    onToggleSidebar: vi.fn(),
    onMove: vi.fn(),
    onRun: vi.fn(),
    onStop: vi.fn(),
    onSetSettled: vi.fn(),
    onSetRead: vi.fn(),
    onDelete: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    ...propOverrides,
  };
  render(<TaskCard {...props} />);
  return props;
}

function openMenu(label = "Actions for Triage #1") {
  fireEvent.keyDown(screen.getByRole("button", { name: label }), { key: "Enter" });
}

// card tests.
test("opens the task from the title and renders the meta line", () => {
  const props = renderCard({ number: 3, settledAt: null });
  fireEvent.click(screen.getByTitle("Fix the login flow"));
  expect(props.onOpen).toHaveBeenCalledTimes(1);

  const meta = document.querySelector(".triage-card-meta") as HTMLElement;
  expect(meta.textContent).toContain("synthetic-project");
  expect(meta.textContent).toContain("synthetic/branch");
  expect(meta.textContent).not.toContain("synthetic-box");
  expect(meta.textContent).toContain("Claude Code · test-model-large");
  const brand = meta.querySelector("[aria-label='Anthropic']") as HTMLElement;
  expect(brand).toBeTruthy();
});

test("shows the machine when the board spans machines", () => {
  renderCard({}, { showMachine: true });
  const meta = document.querySelector(".triage-card-meta") as HTMLElement;
  expect(meta.textContent).toContain("synthetic-box");
});

test("flags the attention note", () => {
  renderCard({ attentionReason: "The build broke twice." });
  expect(screen.getByTitle("The build broke twice.").textContent).toContain(
    "The build broke twice.",
  );
});

// drag tests.
test("starts and ends drags with a move payload", () => {
  const props = renderCard({ number: 9 });
  const card = document.querySelector(".triage-card") as HTMLElement;
  const transfer = { effectAllowed: "", setData: vi.fn() };
  fireEvent.dragStart(card, { dataTransfer: transfer });
  expect(transfer.effectAllowed).toBe("move");
  expect(transfer.setData).toHaveBeenCalledWith("text/plain", "9");
  expect(props.onDragStart).toHaveBeenCalledTimes(1);

  fireEvent.dragEnd(card);
  expect(props.onDragEnd).toHaveBeenCalledTimes(1);
});

// settle tests.
test("settles an open card from the quick button", () => {
  const props = renderCard({ number: 4, settledAt: null });
  fireEvent.click(screen.getByRole("button", { name: "Mark Triage #4 settled" }));
  expect(props.onSetSettled).toHaveBeenCalledWith(true);
});

test("reopens a settled card from the quick button", () => {
  const props = renderCard({ number: 4, settledAt: 55 });
  fireEvent.click(screen.getByRole("button", { name: "Reopen Triage #4" }));
  expect(props.onSetSettled).toHaveBeenCalledWith(false);
});

// status footer tests.
test("hides the status column for idle and completed cards", () => {
  const { container: idle } = render(<TaskCard {...baseProps(makeTask({ runState: "idle" }))} />);
  expect(idle.querySelectorAll(".triage-card-status")).toHaveLength(0);
});

test("shows the status column for scheduled cards", () => {
  renderCard({ runState: "scheduled", scheduledAt: Date.now() + 60_000 });
  const footer = document.querySelector(".triage-card-footer") as HTMLElement;
  expect(footer.textContent).toContain("Scheduled");
});

// menu tests.
test("edits an untracked card from the menu", async () => {
  const props = renderCard({ threadId: null });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Edit task/ }));
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

test("runs an untracked card from the menu", async () => {
  const props = renderCard({ threadId: null });
  openMenu();
  await screen.findByRole("menuitem", { name: /Edit task/ });
  expect(screen.queryByRole("menuitem", { name: /session/ })).toBe(null);
  fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
  expect(props.onRun).toHaveBeenCalledTimes(1);
});

test("opens a tracked card's thread from the menu", async () => {
  const props = renderCard({ threadId: "thr-1", sidebarVisible: true });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: /Open thread/ }));
  expect(props.onOpen).toHaveBeenCalledTimes(1);
});

test("offers no run for a tracked card but hides it from the sidebar", async () => {
  const props = renderCard({ threadId: "thr-1", sidebarVisible: true });
  openMenu();
  await screen.findByRole("menuitem", { name: /Open thread/ });
  expect(screen.queryByRole("menuitem", { name: "Run now" })).toBe(null);
  fireEvent.click(screen.getByRole("menuitem", { name: "Hide session from sidebar" }));
  expect(props.onToggleSidebar).toHaveBeenCalledTimes(1);
});

test("disables the sidebar toggle while visibility is unknown", async () => {
  renderCard({ threadId: "thr-1", sidebarVisible: null });
  openMenu();
  const item = (await screen.findByRole("menuitem", {
    name: "Show session in sidebar",
  })) as HTMLElement;
  expect(item.getAttribute("aria-disabled")).toBe("true");
});

test("stops a running agent from the menu", async () => {
  const props = renderCard({ runState: "working", threadId: "thr-1" });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Stop agent" }));
  expect(props.onStop).toHaveBeenCalledTimes(1);
});

test("marks an unread card read", async () => {
  const props = renderCard({ runState: "working", readAt: null });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark read" }));
  expect(props.onSetRead).toHaveBeenCalledWith(true);
});

test("marks a read card unread", async () => {
  const props = renderCard({ runState: "working", readAt: 5 });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark unread" }));
  expect(props.onSetRead).toHaveBeenCalledWith(false);
});

test("marks a card settled from the menu", async () => {
  const props = renderCard({ settledAt: null });
  openMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Mark settled" }));
  expect(props.onSetSettled).toHaveBeenCalledWith(true);
});

test("moves a card through the stage submenu", async () => {
  const props = renderCard({ stageId: "stage-1" });
  openMenu();
  const sub = await screen.findByRole("menuitem", { name: "Move to" });
  fireEvent.keyDown(sub, { key: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "In progress" }));
  expect(props.onMove).toHaveBeenCalledWith("stage-2");
});

test("deletes a card through the confirm dialog", async () => {
  const props = renderCard({ number: 8 });
  openMenu("Actions for Triage #8");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(await screen.findByText("Delete Triage #8?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete card" }));
  await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(1));
});

test("renames a card through the menu", async () => {
  renderCard({ number: 8 });
  openMenu("Actions for Triage #8");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit title" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Title")).toBeTruthy();
});

// read-state attribute tests.
test("marks unread and read cards for styling", () => {
  const { container: unread } = render(
    <TaskCard {...baseProps(makeTask({ runState: "working", readAt: null }))} />,
  );
  expect(unread.querySelector(".triage-card")?.getAttribute("data-unread")).toBe("");
  expect(unread.querySelector(".triage-card")?.getAttribute("data-read")).toBe(null);

  const { container: read } = render(
    <TaskCard {...baseProps(makeTask({ runState: "idle", readAt: 5 }))} />,
  );
  expect(read.querySelector(".triage-card")?.getAttribute("data-read")).toBe("");
  expect(read.querySelector(".triage-card")?.getAttribute("data-unread")).toBe(null);
});

test("pending cards carry no read state", () => {
  const { container } = render(
    <TaskCard {...baseProps(makeTask({ runState: "queued", readAt: null }))} />,
  );
  const card = container.querySelector(".triage-card") as HTMLElement;
  expect(card.getAttribute("data-unread")).toBe(null);
  expect(card.getAttribute("data-read")).toBe(null);
});

function baseProps(task: Task): TaskCardProps {
  return {
    task,
    stages: [
      makeStage(),
      makeStage({ id: "stage-2", name: "In progress", position: 1, systemRole: "active" }),
    ],
    showMachine: false,
    onOpen: vi.fn(),
    onToggleSidebar: vi.fn(),
    onMove: vi.fn(),
    onRun: vi.fn(),
    onStop: vi.fn(),
    onSetSettled: vi.fn(),
    onSetRead: vi.fn(),
    onDelete: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
  };
}

