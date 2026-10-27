// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ThreadTriageAction } from "@/components/triage/thread-triage-action";
import { refreshTriage } from "@/lib/triage-store";
import {
  createFakeRpc,
  deferred,
  makeSnapshot,
  makeTask,
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
});

async function loadStore(snapshot = makeSnapshot()) {
  sdk.rpc = createFakeRpc({ snapshot: () => snapshot });
  await refreshTriage(sdk.rpc);
}

// empty tests.
test("renders nothing before the first snapshot", async () => {
  const gate = deferred<ReturnType<typeof makeSnapshot>>();
  sdk.rpc = createFakeRpc({ snapshot: () => gate.promise });
  const { container } = render(<ThreadTriageAction threadId="thr-1" />);
  expect(container.childElementCount).toBe(0);
  gate.resolve(makeSnapshot());
  await act(async () => {});
});

// import tests.
test("imports an untracked session into Triage", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-other" })] }));
  render(<ThreadTriageAction threadId="thr-1" />);

  const button = screen.getByRole("button", { name: "Move to Triage" });
  fireEvent.click(button);
  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("importThread", { threadId: "thr-1" });
  });
  expect(toasts.success).toHaveBeenCalledWith("Session moved to Triage");
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

test("drops the label on compact viewports", async () => {
  await loadStore(makeSnapshot({ tasks: [] }));
  const { container } = render(
    <ThreadTriageAction threadId="thr-1" isCompactViewport />,
  );
  const button = screen.getByRole("button", { name: "Move to Triage" });
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.textContent).not.toContain("Move to Triage");
  expect(container.querySelectorAll("svg")).toHaveLength(1);
});

test("toasts the error and refreshes when an import fails", async () => {
  await loadStore(makeSnapshot({ tasks: [] }));
  sdk.rpc = createFakeRpc({
    snapshot: () => makeSnapshot({ tasks: [] }),
    importThread: () => Promise.reject(new Error("Thread is gone")),
  });
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to Triage" }));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Thread is gone"));
});

test("stringifies non-error import failures", async () => {
  await loadStore(makeSnapshot({ tasks: [] }));
  sdk.rpc = createFakeRpc({
    snapshot: () => makeSnapshot({ tasks: [] }),
    importThread: () => Promise.reject("plain"),
  });
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to Triage" }));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("plain"));
});

test("ignores clicks while an operation is pending", async () => {
  const gate = deferred<unknown>();
  await loadStore(makeSnapshot({ tasks: [] }));
  sdk.rpc = createFakeRpc({
    snapshot: () => makeSnapshot({ tasks: [] }),
    importThread: () => gate.promise,
  });
  render(<ThreadTriageAction threadId="thr-1" />);
  const button = screen.getByRole("button", { name: "Move to Triage" }) as HTMLButtonElement;

  fireEvent.click(button);
  await waitFor(() => expect(button.disabled).toBe(true));
  fireEvent.click(button);
  expect(sdk.rpc.call.mock.calls.filter(([m]) => m === "importThread")).toHaveLength(1);

  gate.resolve({});
  await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Session moved to Triage"));
});

// task menu tests.
test("offers the triage menu for a tracked session", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-1", number: 5 })] }));
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });

  expect(await screen.findByRole("menuitem", { name: "Edit title" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Open Triage board" })).toBeTruthy();
  // sidebarVisible is unknown, so the toggle renders disabled.
  const toggle = screen.getByRole("menuitem", { name: "Show session in sidebar" });
  expect(toggle.getAttribute("aria-disabled")).toBe("true");
});

test("renames through the menu", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-1", number: 5 })] }));
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit title" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Title")).toBeTruthy();
});

test("opens the triage board from the menu", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-1", number: 5 })] }));
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Open Triage board" }));
  expect(sdk.navigate.toPluginPanel).toHaveBeenCalledWith("triage");
});

test("toggles sidebar visibility for a shown session", async () => {
  await loadStore(
    makeSnapshot({
      tasks: [makeTask({ threadId: "thr-1", number: 5, sidebarVisible: true })],
    }),
  );
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Hide session from sidebar" }),
  );
  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("setThreadSidebar", {
      number: 5,
      visible: false,
    });
  });
  expect(toasts.success).toHaveBeenCalledWith("Session hidden from sidebar");
});

test("offers to show a hidden session", async () => {
  await loadStore(
    makeSnapshot({
      tasks: [makeTask({ threadId: "thr-1", number: 5, sidebarVisible: false })],
    }),
  );
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });
  const item = (await screen.findByRole("menuitem", {
    name: "Show session in sidebar",
  })) as HTMLButtonElement;
  expect(item.getAttribute("aria-disabled")).toBe(null);
  fireEvent.click(item);
  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("setThreadSidebar", {
      number: 5,
      visible: true,
    });
  });
  expect(toasts.success).toHaveBeenCalledWith("Session shown in sidebar");
});

test("disables the sidebar toggle while visibility is unknown", async () => {
  await loadStore(
    makeSnapshot({
      tasks: [makeTask({ threadId: "thr-1", number: 5, sidebarVisible: null })],
    }),
  );
  render(<ThreadTriageAction threadId="thr-1" />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Triage #5 actions" }), {
    key: "Enter",
  });
  const item = (await screen.findByRole("menuitem", {
    name: "Show session in sidebar",
  })) as HTMLButtonElement;
  expect(item.getAttribute("aria-disabled")).toBe("true");
});

// realtime tests.
test("claims each distinct realtime stamp and refreshes once", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-1" })] }));
  render(<ThreadTriageAction threadId="thr-1" />);
  expect(sdk.realtimeHandlers).toHaveLength(1);
  const handler = sdk.realtimeHandlers[0];

  const before = sdk.rpc.call.mock.calls.length;
  handler({ at: 11 });
  await waitFor(() => expect(sdk.rpc.call.mock.calls.length).toBeGreaterThan(before));
  const after = sdk.rpc.call.mock.calls.length;
  handler({ at: 11 });
  expect(sdk.rpc.call.mock.calls.length).toBe(after);
  handler(null);
  await waitFor(() => expect(sdk.rpc.call.mock.calls.length).toBeGreaterThan(after));
});

test("drops the task menu label on compact viewports", async () => {
  await loadStore(makeSnapshot({ tasks: [makeTask({ threadId: "thr-1", number: 5 })] }));
  render(<ThreadTriageAction threadId="thr-1" isCompactViewport />);
  const trigger = screen.getByRole("button", { name: "Triage #5 actions" });
  expect(trigger.textContent).not.toContain("Triage #5");
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(await screen.findByRole("menuitem", { name: "Edit title" })).toBeTruthy();
});
