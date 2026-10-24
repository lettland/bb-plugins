// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TaskDetailDialog } from "@/components/triage/task-detail-dialog";
import { createFakeRpc, deferred, makeStage, makeTask, resetSdk, toasts } from "./helpers";

vi.mock("sonner", async () => {
  const { createSonnerMock } = await import("./helpers");
  return createSonnerMock();
});

afterEach(cleanup);

beforeEach(() => {
  resetSdk();
});

function renderDetail(task: Parameters<typeof makeTask>[0] | null, overrides = {}) {
  const rpc = createFakeRpc();
  const onOpenChange = vi.fn();
  const onEdit = vi.fn();
  const onChanged = vi.fn(async () => {});
  const view = render(
    <TaskDetailDialog
      task={task === null ? null : makeTask({ ...task, ...overrides })}
      stages={[
        makeStage(),
        makeStage({ id: "stage-2", name: "In progress", position: 1, systemRole: "active" }),
      ]}
      rpc={rpc}
      open
      onOpenChange={onOpenChange}
      onEdit={onEdit}
      onChanged={onChanged}
    />,
  );
  return { view, rpc, onOpenChange, onEdit, onChanged };
}

// empty tests.
test("renders nothing without a task", () => {
  const { view } = renderDetail(null);
  expect(view.container.childElementCount).toBe(0);
});

// rich tests.
test("shows the read view for a running task with a thread", () => {
  renderDetail(
    {
      number: 12,
      title: "Ship the release",
      description: "Cut the notes.",
      runState: "working",
      attentionReason: "The agent hit a failing test.",
      scheduledAt: Date.UTC(2026, 4, 4, 9, 0),
      threadId: "thr-1",
    },
    { reasoningLevel: "xhigh" },
  );

  expect(screen.getByText("Triage #12")).toBeTruthy();
  expect(screen.getByText("Ship the release")).toBeTruthy();
  expect(screen.getByText("Working")).toBeTruthy();
  expect(screen.getByText("Needs attention")).toBeTruthy();
  expect(screen.getByText("The agent hit a failing test.")).toBeTruthy();
  expect(screen.getByText("Cut the notes.")).toBeTruthy();
  expect(screen.getByText("synthetic-project")).toBeTruthy();
  expect(screen.getByText("synthetic/branch")).toBeTruthy();
  expect(screen.getByText("synthetic-box")).toBeTruthy();
  expect(screen.getByText("Claude Code · test-model-large · Extra-high thinking")).toBeTruthy();
  expect(screen.getByText("Scheduled")).toBeTruthy();

  const stage = screen.getByRole("combobox", { name: "Stage" }) as HTMLButtonElement;
  expect(stage.textContent).toContain("In box");
  expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Run now" })).toBe(null);
  expect(screen.getByRole("button", { name: "Stop agent" })).toBeTruthy();
});

// sparse tests.
test("falls back to placeholders for an unstarted idle card", () => {
  renderDetail({ number: 3, title: "Empty card", description: "", scheduledAt: null });
  expect(screen.getByText("No prompt was provided.")).toBeTruthy();
  expect(screen.queryByText("Needs attention")).toBe(null);
  expect(screen.queryByText("Scheduled")).toBe(null);
  expect(screen.queryByRole("button", { name: "Stop agent" })).toBe(null);
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
});

// actions tests.
test("moves the card through the stage select", async () => {
  const { rpc, onChanged } = renderDetail({ number: 5 });
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Stage" }), { key: "Enter" });
  const option = await screen.findByRole("option", { name: "In progress" });
  fireEvent.keyDown(option, { key: "Enter" });

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("moveTask", { number: 5, stageId: "stage-2" });
  });
  expect(toasts.success).toHaveBeenCalledWith("Moved Triage #5");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

test("toasts a failed stage move", async () => {
  const { rpc } = renderDetail({ number: 5 });
  rpc.call.mockImplementationOnce(() => Promise.reject(new Error("Column locked")));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Stage" }), { key: "Enter" });
  const option = await screen.findByRole("option", { name: "In progress" });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Column locked"));
});

test("stringifies non-error action failures", async () => {
  const { rpc } = renderDetail({ number: 5 });
  rpc.call.mockImplementationOnce(() => Promise.reject("plain"));
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Stage" }), { key: "Enter" });
  const option = await screen.findByRole("option", { name: "In progress" });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("plain"));
});

test("edits hands over to the composer", () => {
  const { onEdit } = renderDetail({ number: 5 });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(onEdit).toHaveBeenCalledTimes(1);
});

test("runs an unstarted card", async () => {
  const { rpc, onChanged } = renderDetail({ number: 6 });
  fireEvent.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("runTask", { number: 6 }));
  expect(toasts.success).toHaveBeenCalledWith("Started Triage #6");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

test("stops a running agent", async () => {
  const { rpc } = renderDetail({ number: 6, runState: "working", threadId: "thr-9" });
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("stopTask", { number: 6 }));
  expect(toasts.success).toHaveBeenCalledWith("Stopped Triage #6");
});

test("deletes through the confirm dialog", async () => {
  const { rpc, onChanged, onOpenChange } = renderDetail({ number: 8 });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Delete Triage #8?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Delete card" }));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledWith("deleteTask", { number: 8 }));
  expect(toasts.success).toHaveBeenCalledWith("Deleted Triage #8");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
});

test("toasts when the delete fails", async () => {
  const gate = deferred<void>();
  const { rpc } = renderDetail({ number: 8 });
  rpc.call.mockImplementationOnce(() => gate.promise);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete card" }));
  gate.reject(new Error("Card has a thread"));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Card has a thread"));
  await waitFor(() => expect(rpc.call).toHaveBeenCalledTimes(1));
});
