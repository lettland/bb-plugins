// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BoardToolbar } from "@/components/triage/board-toolbar";
import { makeStage, resetSdk, sdk } from "./helpers";

import type { BoardToolbarProps } from "@/components/triage/board-toolbar";

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

function renderToolbar(overrides: Partial<BoardToolbarProps> = {}) {
  const props = {
    projects: [
      { id: "proj-1", kind: "standard" as const, name: "Synthetic app" },
      { id: "proj-2", kind: "personal" as const, name: "Personal project" },
    ],
    machines: [
      { id: "machine-1", name: "Box one", status: "connected" as const },
      { id: "machine-2", name: "Offline box", status: "disconnected" as const },
    ],
    stages: [makeStage()],
    projectFilter: "proj-1",
    machineFilter: "all",
    taskFilter: "all" as const,
    counts: { all: 3, live: 1, unread: 2, settled: 0 },
    defaultProjectId: null,
    rpc: sdk.rpc,
    onProjectFilterChange: vi.fn(),
    onMachineFilterChange: vi.fn(),
    onTaskFilterChange: vi.fn(),
    onCreated: vi.fn(async () => {}),
    ...overrides,
  };
  render(<BoardToolbar {...props} />);
  return props;
}

// trigger tests.
test("labels the project trigger with the active project", () => {
  renderToolbar();
  const trigger = screen.getByRole("button", { name: "Filter by project" });
  expect(trigger.textContent).toContain("Synthetic app");
});

test("falls back to all projects for an unknown filter", () => {
  renderToolbar({ projectFilter: "nope" });
  const trigger = screen.getByRole("button", { name: "Filter by project" });
  expect(trigger.textContent).toContain("All projects");
});

// picker tests.
test("picks a project and closes the picker", async () => {
  const props = renderToolbar();
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  const listbox = await screen.findByRole("listbox", { name: "Projects" });
  const options = listbox.querySelectorAll("[role=option]");
  expect(options).toHaveLength(3);
  expect(options[0].textContent).toContain("All projects");
  expect(options[1].textContent).toContain("Synthetic app");
  expect(options[2].textContent).toContain("Personal");
  expect(options[1].getAttribute("aria-selected")).toBe("true");

  fireEvent.click(options[2]);
  expect(props.onProjectFilterChange).toHaveBeenCalledWith("proj-2");
  await waitFor(() => {
    expect(screen.queryByRole("listbox", { name: "Projects" })).toBe(null);
  });
  expect((screen.getByRole("button", { name: "Filter by project" })).textContent).toContain(
    "Synthetic app",
  );
});

test("filters the project options by search", async () => {
  renderToolbar();
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  await screen.findByRole("listbox", { name: "Projects" });
  fireEvent.change(screen.getByLabelText("Search projects"), {
    target: { value: "syn" },
  });
  const listbox = screen.getByRole("listbox", { name: "Projects" });
  expect(listbox.querySelectorAll("[role=option]")).toHaveLength(1);

  fireEvent.change(screen.getByLabelText("Search projects"), {
    target: { value: "zzz" },
  });
  expect(screen.getByText("No projects found.")).toBeTruthy();
});

test("searching resets when the picker closes", async () => {
  renderToolbar();
  const trigger = screen.getByRole("button", { name: "Filter by project" });
  fireEvent.click(trigger);
  await screen.findByRole("listbox", { name: "Projects" });
  fireEvent.change(screen.getByLabelText("Search projects"), {
    target: { value: "syn" },
  });
  fireEvent.click(trigger);
  await waitFor(() => {
    expect(screen.queryByRole("listbox", { name: "Projects" })).toBe(null);
  });
  fireEvent.click(trigger);
  const reopened = await screen.findByLabelText("Search projects");
  expect((reopened as HTMLInputElement).value).toBe("");
});

// keyboard tests.
test("arrow down from the search focuses the first option", async () => {
  renderToolbar();
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  const input = await screen.findByLabelText("Search projects");
  // Other keys stay in the field.
  fireEvent.keyDown(input, { key: "a" });
  expect(document.activeElement).toBe(input);

  fireEvent.keyDown(input, { key: "ArrowDown" });
  const listbox = screen.getByRole("listbox", { name: "Projects" });
  expect(document.activeElement).toBe(listbox.querySelector("[role=option]"));
});

test("moves focus through the option list", async () => {
  renderToolbar();
  fireEvent.click(screen.getByRole("button", { name: "Filter by project" }));
  const listbox = await screen.findByRole("listbox", { name: "Projects" });
  const options = Array.from(listbox.querySelectorAll("[role=option]")) as HTMLElement[];

  options[2].focus();
  fireEvent.keyDown(listbox, { key: "ArrowUp" });
  expect(document.activeElement).toBe(options[1]);
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(document.activeElement).toBe(options[2]);
  fireEvent.keyDown(listbox, { key: "Home" });
  expect(document.activeElement).toBe(options[0]);
  fireEvent.keyDown(listbox, { key: "End" });
  expect(document.activeElement).toBe(options[2]);

  // The clamps hold at both ends.
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(document.activeElement).toBe(options[2]);
  fireEvent.keyDown(listbox, { key: "Home" });
  expect(document.activeElement).toBe(options[0]);
  fireEvent.keyDown(listbox, { key: "ArrowUp" });
  expect(document.activeElement).toBe(options[0]);
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(document.activeElement).toBe(options[1]);

  // Unhandled keys leave the focus alone.
  fireEvent.keyDown(listbox, { key: "a" });
  expect(document.activeElement).toBe(options[1]);
});

// machine tests.
test("offers the machine filter when several machines exist", async () => {
  renderToolbar();
  const trigger = screen.getByRole("combobox", { name: "Filter by machine" });
  expect(trigger.textContent).toContain("All machines");
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(await screen.findByText("Offline box · offline")).toBeTruthy();
});

test("omits the machine filter with a single machine", () => {
  renderToolbar({
    machines: [{ id: "machine-1", name: "Box one", status: "connected" }],
  });
  expect(screen.queryByRole("combobox", { name: "Filter by machine" })).toBe(null);
});

// task filter tests.
test("switches the card lens and shows tallies", () => {
  const props = renderToolbar();
  const group = screen.getByRole("group", { name: "Filter cards" });
  const buttons = group.querySelectorAll("button");
  expect(buttons).toHaveLength(4);
  expect(group.textContent).toContain("3");
  expect(group.textContent).toContain("1");
  expect(group.textContent).toContain("2");
  expect(group.textContent).toContain("0");

  fireEvent.click(buttons[1]);
  expect(props.onTaskFilterChange).toHaveBeenCalledWith("live");
  expect(buttons[1].getAttribute("title")).toBe("An agent is working right now");
});

// composer trigger tests.
test("keeps the new task trigger at hand", () => {
  renderToolbar();
  expect(screen.getByRole("button", { name: /New task/ })).toBeTruthy();
});
