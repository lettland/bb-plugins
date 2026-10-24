// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SidebarThreadList } from "@/components/triage/sidebar-thread-list";
import { claimTriageRefresh } from "@/lib/triage-mounts";
import { refreshTriage } from "@/lib/triage-store";
import { createFakeRpc, makeSnapshot, makeTask, resetSdk, sdk } from "./helpers";

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

function makeBoardTasks() {
  return [
    makeTask({
      id: "t-failed",
      number: 1,
      title: "Failed sync",
      runState: "failed",
      updatedAt: Date.now() - 500_000,
    }),
    makeTask({
      id: "t-idle",
      number: 2,
      title: "Fix the login flow",
      runState: "idle",
      attentionReason: "Waiting on you.",
      updatedAt: Date.now() - 400_000,
    }),
    makeTask({
      id: "t-running",
      number: 3,
      title: "Run the migration",
      runState: "working",
      threadId: "thr-3",
      updatedAt: Date.now() - 300_000,
    }),
    makeTask({
      id: "t-queued",
      number: 4,
      title: "Queue the report",
      runState: "queued",
      updatedAt: Date.now() - 200_000,
    }),
    makeTask({
      id: "t-other",
      number: 5,
      title: "Other project task",
      projectId: "proj-2",
      runState: "completed",
      updatedAt: Date.now() - 100_000,
    }),
    makeTask({
      id: "t-done",
      number: 6,
      title: "Completed work",
      runState: "completed",
      updatedAt: Date.now() - 50_000,
    }),
  ];
}

async function loadBoard(tasks = makeBoardTasks()) {
  sdk.rpc = createFakeRpc({ snapshot: () => makeSnapshot({ tasks }) });
  await refreshTriage(sdk.rpc);
}

function renderList(overrides = {}) {
  const onNavigate = vi.fn();
  const view = render(
    <SidebarThreadList
      activeThreadId={null}
      activeProjectId={null}
      isCompactViewport={false}
      onNavigate={onNavigate}
      searchQuery=""
      Original={() => <div data-testid="original-list" />}
      {...overrides}
    />,
  );
  return { onNavigate, view };
}

// settings gate tests.
test("leaves the sidebar untouched while the setting is off", () => {
  sdk.settingsValues = undefined;
  const { view } = renderList();
  expect(view.queryByTestId("original-list")).toBeTruthy();
  expect(view.queryByLabelText("Triage")).toBe(null);
});

test("shows nothing before the first snapshot", () => {
  const { view } = renderList();
  expect(view.queryByTestId("original-list")).toBeTruthy();
  expect(view.queryByLabelText("Triage")).toBe(null);
});

test("renders the triage section above the original list when opted in", async () => {
  await loadBoard();
  const { view } = renderList();
  expect(view.getByLabelText("Triage")).toBeTruthy();
  expect(view.getByTestId("original-list")).toBeTruthy();
});

// rows tests.
test("scopes rows to the selected project and sorts by urgency", async () => {
  await loadBoard();
  const { view } = renderList({ activeProjectId: "proj-1" });
  const rows = view.container.querySelectorAll(".triage-sidebar-row");
  expect(rows).toHaveLength(5);
  const titles = Array.from(rows).map((r) => r.querySelector(".triage-sidebar-label")?.textContent);
  // Urgency first; ties break on the newest update.
  expect(titles).toEqual([
    "Fix the login flow",
    "Failed sync",
    "Run the migration",
    "Queue the report",
    "Completed work",
  ]);
});

test("keeps every project when none is selected", async () => {
  await loadBoard();
  const { view } = renderList({ activeProjectId: null });
  expect(view.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(6);
});

test("matches the search query against titles and numbers", async () => {
  await loadBoard();
  const { view } = renderList({ searchQuery: "FIX" });
  expect(view.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(1);

  const { view: byNumber } = renderList({ searchQuery: "#3" });
  expect(byNumber.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(1);
  expect(byNumber.container.textContent).toContain("Run the migration");
});

test("goes quiet when nothing matches", async () => {
  await loadBoard();
  const { view } = renderList({ searchQuery: "no-such-card" });
  expect(view.queryByLabelText("Triage")).toBe(null);
});

test("marks the active thread's row and opens it", async () => {
  await loadBoard();
  const { onNavigate, view } = renderList({ activeThreadId: "thr-3" });
  const row = view.container.querySelectorAll(".triage-sidebar-row")[2] as HTMLElement;
  expect(row.getAttribute("data-active")).toBe("");

  fireEvent.click(row);
  expect(sdk.sidebarThreads.open).toHaveBeenCalledWith("thr-3");
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

test("sends threadless cards to the board's detail dialog", async () => {
  await loadBoard();
  const { onNavigate, view } = renderList({ activeProjectId: "proj-1" });
  const row = view.container.querySelectorAll(".triage-sidebar-row")[0] as HTMLElement;
  fireEvent.click(row);
  expect(sdk.sidebarThreads.open).not.toHaveBeenCalled();
  expect(sdk.navigate.toPluginPanel).toHaveBeenCalledWith("triage");
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

test("caps the visible rows and links to the board for the rest", async () => {
  const tasks = Array.from({ length: 12 }, (_, i) =>
    makeTask({
      id: `t-${i}`,
      number: 10 + i,
      title: `Card ${i}`,
      runState: "completed",
      updatedAt: Date.now() - i * 1000,
    }),
  );
  await loadBoard(tasks);
  const { onNavigate, view } = renderList();
  expect(view.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(10);
  expect(view.getByText("Show all 12")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Show all 12 Triage cards on the board" }));
  expect(sdk.navigate.toPluginPanel).toHaveBeenCalledWith("triage");
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

test("marks the compact viewport", async () => {
  await loadBoard(makeBoardTasks().slice(0, 1));
  const { view } = renderList({ isCompactViewport: true });
  expect(view.getByLabelText("Triage").getAttribute("data-compact")).toBe("");
});

// realtime tests.
test("claims each distinct realtime stamp once", async () => {
  await loadBoard();
  renderList();
  const handler = sdk.realtimeHandlers.at(-1) as (payload: unknown) => void;
  expect(claimTriageRefresh({ at: 1 })).toBe(true);
  expect(claimTriageRefresh({ at: 1 })).toBe(false);

  const before = sdk.rpc.call.mock.calls.length;
  handler({ at: 7 });
  await waitFor(() => expect(sdk.rpc.call.mock.calls.length).toBeGreaterThan(before));
  const after = sdk.rpc.call.mock.calls.length;
  handler({ at: 7 });
  expect(sdk.rpc.call.mock.calls.length).toBe(after);
});

// collapse tests — keep last: the disclosure lives in module state.
test("collapses and reopens the section", async () => {
  await loadBoard(makeBoardTasks().slice(0, 1));
  const { view } = renderList();
  const heading = view.container.querySelector(".triage-sidebar-toggle") as HTMLButtonElement;
  expect(heading.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(view.queryByLabelText("Triage")).toBeTruthy();
  expect(view.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(0);

  fireEvent.click(heading);
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  expect(view.container.querySelectorAll(".triage-sidebar-row")).toHaveLength(1);
});

test("renders the thread header action beside the list", async () => {
  await loadBoard();
  const { view } = renderList({ activeThreadId: "thr-untracked" });
  const button = view.getByRole("button", { name: "Move session to Triage" });
  expect(button.textContent).toContain("Move current session to Triage");
});
