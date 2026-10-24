// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { refreshTriage } from "@/lib/triage-store";
import { TriageHeaderActions } from "@/components/triage/header-actions";
import {
  createFakeRpc,
  deferred,
  makeNotification,
  makeSnapshot,
  resetSdk,
  sdk,
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

// offline tests.
test("renders nothing before the first snapshot lands", async () => {
  // A held-back snapshot keeps the store empty for this render; resolve it at
  // the end so the store's in-flight fetch does not leak into other tests.
  const gate = deferred<ReturnType<typeof makeSnapshot>>();
  sdk.rpc = createFakeRpc({ snapshot: () => gate.promise });
  const { container } = render(<TriageHeaderActions />);
  expect(container.childElementCount).toBe(0);
  gate.resolve(makeSnapshot());
  await act(async () => {});
});

// connected tests.
test("marks the connection live beside the board-wide controls", async () => {
  await refreshTriage(sdk.rpc);
  render(<TriageHeaderActions />);

  const connection = document.querySelector(".triage-connection") as HTMLElement;
  expect(connection.getAttribute("data-connected")).toBe("");
  expect(connection.getAttribute("title")).toBe("Live updates connected");
  expect(connection.textContent).toContain("Live");
  const dot = connection.querySelector(".bb-status-dot") as HTMLElement;
  expect(dot.getAttribute("data-tone")).toBe("done");

  expect(screen.getByRole("button", { name: "Updates" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Triage settings" })).toBeTruthy();
});

// reconnecting tests.
test("labels a dropped connection as reconnecting", async () => {
  sdk.connection = "reconnecting";
  await refreshTriage(sdk.rpc);
  render(<TriageHeaderActions />);

  const connection = document.querySelector(".triage-connection") as HTMLElement;
  expect(connection.getAttribute("data-connected")).toBe(null);
  expect(connection.getAttribute("title")).toBe("Reconnecting to live updates");
  expect(connection.textContent).toContain("Reconnecting");
  const dot = connection.querySelector(".bb-status-dot") as HTMLElement;
  expect(dot.getAttribute("data-tone")).toBe("scheduled");
});

test("passes the snapshot's feed into the notification center", async () => {
  const snapshot = makeSnapshot({ unreadCount: 3 });
  sdk.rpc = createFakeRpc({ snapshot: () => snapshot });
  await refreshTriage(sdk.rpc);
  render(<TriageHeaderActions />);
  expect(screen.getByRole("button", { name: "Updates, 3 unread" })).toBeTruthy();
});

test("mark-all-read and notification deletes route through the rpc", async () => {
  const snapshot = makeSnapshot({
    unreadCount: 2,
    notifications: [makeNotification({ id: "note-1", action: "Needs attention" })],
  });
  sdk.rpc = createFakeRpc({ snapshot: () => snapshot });
  await refreshTriage(sdk.rpc);
  render(<TriageHeaderActions />);

  fireEvent.click(screen.getByRole("button", { name: "Updates, 2 unread" }));
  fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("markNotificationsRead", { ids: null });
  });

  fireEvent.click(
    await screen.findByRole("button", { name: "Delete update: Needs attention" }),
  );
  await waitFor(() => {
    expect(sdk.rpc.call).toHaveBeenCalledWith("deleteNotifications", { ids: ["note-1"] });
  });
});
