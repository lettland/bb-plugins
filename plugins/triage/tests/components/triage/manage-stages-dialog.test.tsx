// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ManageStagesDialog } from "@/components/triage/manage-stages-dialog";
import type { ManageStagesDialogProps } from "@/components/triage/manage-stages-dialog";
import {
  createFakeRpc,
  deferred,
  makeStage,
  resetSdk,
  sdk,
  toasts,
} from "./helpers";

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
  sdk.settingsValues = { showInSidebar: true };
});

function stages() {
  return [
    makeStage(),
    makeStage({ id: "stage-2", name: "In progress", position: 1, systemRole: "active" }),
    makeStage({ id: "stage-3", name: "Custom lane", position: 2, systemRole: null }),
  ];
}

function renderDialog(overrides: Partial<ManageStagesDialogProps> = {}) {
  const rpc = createFakeRpc();
  const onChanged = vi.fn(async () => {});
  render(<ManageStagesDialog {...{ stages: stages(), rpc, onChanged, ...overrides }} />);
  return { rpc, onChanged };
}

async function openDialog() {
  const handles = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Triage settings" }));
  await screen.findByText("Rename the columns and drag their handles to reorder them.");
  return handles;
}

function patchRowRects(rows: HTMLElement[]): void {
  rows.forEach((row, index) => {
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () =>
        ({ top: index * 42, bottom: index * 42 + 36, height: 36 }) as DOMRect,
    });
  });
}

function rowHandles(): HTMLButtonElement[] {
  const rows = Array.from(
    document.querySelectorAll(".triage-stage-row"),
  ) as HTMLElement[];
  patchRowRects(rows);
  return rows.map(
    (row) => row.querySelector(".triage-stage-handle") as HTMLButtonElement,
  );
}

// dialog tests.
test("lists the stages with their tones and remove affordances", async () => {
  await openDialog();

  expect(screen.getByLabelText("Stage name In box")).toBeTruthy();
  expect(screen.getByLabelText("Stage name In progress")).toBeTruthy();
  const dots = Array.from(document.querySelectorAll(".triage-stage-row .bb-status-dot"));
  expect(dots.map((d) => d.getAttribute("data-tone"))).toEqual(["pending", "ongoing", "neutral"]);
  expect(screen.getByRole("button", { name: "Remove Custom lane" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove In box" })).toBe(null);
});

// rename tests.
test("renames a stage on blur", async () => {
  const { rpc, onChanged } = await openDialog();
  const input = screen.getByLabelText("Stage name In box") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "  New name  " } });
  fireEvent.blur(input);

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("renameStage", { id: "stage-1", name: "New name" });
  });
  expect(toasts.success).toHaveBeenCalledWith("Renamed stage to New name");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

test("skips renames that are empty or unchanged", async () => {
  const { rpc } = await openDialog();
  const input = screen.getByLabelText("Stage name In box") as HTMLInputElement;

  // A blur without any edit has no draft entry at all.
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  fireEvent.change(input, { target: { value: "In box" } });
  fireEvent.blur(input);
  expect(rpc.call).not.toHaveBeenCalledWith("renameStage", expect.anything());
});

test("toasts a failed rename", async () => {
  const { rpc } = await openDialog();
  rpc.call.mockImplementationOnce(() => Promise.reject(new Error("Name taken")));
  const input = screen.getByLabelText("Stage name In box") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Clash" } });
  fireEvent.blur(input);
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Name taken"));
});

test("stringifies non-error failures", async () => {
  const { rpc } = await openDialog();
  rpc.call.mockImplementationOnce(() => Promise.reject("plain"));
  const input = screen.getByLabelText("Stage name In box") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Clash" } });
  fireEvent.blur(input);
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("plain"));
});

// add tests.
test("adds a stage from the footer form", async () => {
  const { rpc, onChanged } = await openDialog();
  const input = screen.getByLabelText("New stage name") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "  Grooming  " } });
  fireEvent.click(screen.getByRole("button", { name: /Add stage/ }));

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("createStage", { name: "Grooming" });
  });
  expect(toasts.success).toHaveBeenCalledWith("Added Grooming");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  await waitFor(() => expect((screen.getByLabelText("New stage name") as HTMLInputElement).value).toBe(""));
});

test("ignores empty new stage names", async () => {
  const { rpc } = await openDialog();
  fireEvent.click(screen.getByRole("button", { name: /Add stage/ }));
  expect(rpc.call).not.toHaveBeenCalledWith("createStage", expect.anything());
});

test("toasts a failed create", async () => {
  const { rpc } = await openDialog();
  rpc.call.mockImplementationOnce(() => Promise.reject(new Error("Too many stages")));
  fireEvent.change(screen.getByLabelText("New stage name"), { target: { value: "Extra" } });
  fireEvent.click(screen.getByRole("button", { name: /Add stage/ }));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Too many stages"));
});

// sidebar tests.
test("toggles the sidebar setting through the rpc", async () => {
  const { rpc, onChanged } = await openDialog();
  const checkbox = screen.getByLabelText("Show Triage in sidebar") as HTMLInputElement;
  expect(checkbox.checked).toBe(true);
  fireEvent.click(checkbox);

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("setShowInSidebar", { visible: false });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  // The checked state follows the host's settings, which the mock keeps put.
  expect(checkbox.checked).toBe(true);
});

test("disables the switch while saving and without settings", async () => {
  const gate = deferred<unknown>();
  const { rpc } = await openDialog();
  rpc.call.mockImplementationOnce(() => gate.promise);
  const checkbox = screen.getByLabelText("Show Triage in sidebar") as HTMLInputElement;
  fireEvent.click(checkbox);
  expect(checkbox.disabled).toBe(true);

  gate.resolve({});
  await waitFor(() => expect(checkbox.disabled).toBe(false));
});

test("disables the switch while settings are unavailable", async () => {
  sdk.settingsValues = undefined;
  await openDialog();
  const checkbox = screen.getByLabelText("Show Triage in sidebar") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(true);
});

// remove tests.
test("removes a custom stage through the confirm dialog", async () => {
  const { rpc, onChanged } = await openDialog();
  fireEvent.click(screen.getByRole("button", { name: "Remove Custom lane" }));
  expect(await screen.findByText("Remove Custom lane?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove stage" }));

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("deleteStage", { id: "stage-3" });
  });
  expect(toasts.success).toHaveBeenCalledWith("Removed Custom lane");
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

// keyboard reorder tests.
test("reorders with the arrow keys", async () => {
  const { rpc, onChanged } = await openDialog();
  const [first] = rowHandles();
  fireEvent.keyDown(first, { key: "ArrowDown" });

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("reorderStage", { id: "stage-1", targetId: "stage-2" });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

test("ignores arrows without a target row and unrelated keys", async () => {
  const { rpc } = await openDialog();
  const [first, second, third] = rowHandles();
  fireEvent.keyDown(first, { key: "ArrowUp" });
  fireEvent.keyDown(third, { key: "ArrowDown" });
  fireEvent.keyDown(second, { key: "a" });
  fireEvent.keyDown(second, { key: "Enter" });
  fireEvent.keyDown(first, { key: "Escape" });
  fireEvent.keyDown(first, { key: "a" });
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("skips reorders while one is in flight", async () => {
  const gate = deferred<unknown>();
  const { rpc } = await openDialog();
  rpc.call.mockImplementation(() => gate.promise);
  const [first, second] = rowHandles();

  fireEvent.keyDown(first, { key: "ArrowDown" });
  fireEvent.keyDown(second, { key: "ArrowUp" });
  gate.resolve({});
  const calls = rpc.call.mock.calls.filter(([m]) => m === "reorderStage");
  expect(calls).toHaveLength(1);
});

// drag reorder tests.
test("drags a row onto the next one", async () => {
  const { rpc } = await openDialog();
  const [first] = rowHandles();

  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(first, { clientY: 142 });
  fireEvent.pointerUp(first);

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("reorderStage", { id: "stage-1", targetId: "stage-2" });
  });
});

test("drags a row up one slot", async () => {
  const { rpc } = await openDialog();
  const handles = rowHandles();
  const last = handles[2];

  fireEvent.pointerDown(last, { button: 0, clientY: 200, pointerId: 1 });
  fireEvent.pointerMove(last, { clientY: 158 });
  fireEvent.pointerUp(last);

  await waitFor(() => {
    expect(rpc.call).toHaveBeenCalledWith("reorderStage", { id: "stage-3", targetId: "stage-2" });
  });
});

test("falls back to the row height for a single stage", async () => {
  const rpc = createFakeRpc();
  const onChanged = vi.fn(async () => {});
  render(<ManageStagesDialog stages={[makeStage()]} rpc={rpc} onChanged={onChanged} />);
  fireEvent.click(screen.getByRole("button", { name: "Triage settings" }));
  await screen.findByText("Rename the columns and drag their handles to reorder them.");

  const [first] = rowHandles();
  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(first, { clientY: 148 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("releases without moving anywhere", async () => {
  const { rpc } = await openDialog();
  const [first] = rowHandles();
  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("drags clamp at the list edges", async () => {
  const { rpc } = await openDialog();
  const [first, , third] = rowHandles();

  // Dragging the first row far up stays on the first slot.
  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(first, { clientY: -400 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());

  // Dragging the last row far down stays on the last slot.
  fireEvent.pointerDown(third, { button: 0, clientY: 300, pointerId: 1 });
  fireEvent.pointerMove(third, { clientY: 900 });
  fireEvent.pointerUp(third);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("pointer moves on other rows leave the drag alone", async () => {
  const { rpc } = await openDialog();
  const [first, second] = rowHandles();
  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(second, { clientY: 200 });
  fireEvent.pointerUp(second);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("secondary buttons and cancels never start a drag", async () => {
  const { rpc } = await openDialog();
  const [first] = rowHandles();
  fireEvent.pointerDown(first, { button: 2, clientY: 100, pointerId: 1 });
  fireEvent.pointerMove(first, { clientY: 142 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());

  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.pointerCancel(first);
  fireEvent.pointerMove(first, { clientY: 142 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

test("losing pointer capture cancels the drag", async () => {
  const { rpc } = await openDialog();
  const [first] = rowHandles();
  fireEvent.pointerDown(first, { button: 0, clientY: 100, pointerId: 1 });
  fireEvent.lostPointerCapture(first);
  fireEvent.pointerMove(first, { clientY: 142 });
  fireEvent.pointerUp(first);
  expect(rpc.call).not.toHaveBeenCalledWith("reorderStage", expect.anything());
});

