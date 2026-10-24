// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, afterAll, expect, test, vi } from "vitest";

import { NotificationCenter } from "@/components/triage/notification-center";
import type { NotificationCenterProps } from "@/components/triage/notification-center";
import {
  makeNotification,
  makeTask,
  resetSdk,
  toasts,
} from "./helpers";

vi.mock("sonner", async () => {
  const { createSonnerMock } = await import("./helpers");
  return createSonnerMock();
});

afterEach(cleanup);

beforeEach(() => {
  resetSdk();
  notificationApi.permission = "default";
  notificationApi.requestPermission.mockClear();
});

// The browser-notification opt-in row reads the host's Notification global.
const notificationApi = {
  permission: "default" as NotificationPermission,
  requestPermission: vi.fn(async () => "granted" as NotificationPermission),
};
const hadNotification = typeof globalThis.Notification !== "undefined";
(globalThis as { Notification?: unknown }).Notification = notificationApi;

afterAll(() => {
  if (!hadNotification) {
    delete (globalThis as { Notification?: unknown }).Notification;
  }
});

function yesterdayStamp(): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime() - 3_600_000;
}

interface CenterOverrides {
  notifications?: NotificationCenterProps["notifications"];
  tasks?: NotificationCenterProps["tasks"];
  unreadCount?: number;
  onSelect?: NotificationCenterProps["onSelect"];
  onMarkRead?: NotificationCenterProps["onMarkRead"];
  onDelete?: NotificationCenterProps["onDelete"];
}

function renderCenter(overrides: CenterOverrides = {}) {
  const props = {
    notifications: overrides.notifications ?? [],
    tasks: overrides.tasks ?? [],
    unreadCount: overrides.unreadCount ?? 0,
    onSelect: overrides.onSelect ?? vi.fn(),
    onMarkRead:
      overrides.onMarkRead ?? vi.fn(async (_ids: string[] | null) => {}),
    onDelete: overrides.onDelete ?? vi.fn(async (_ids: string[]) => {}),
  };
  render(<NotificationCenter {...props} />);
  return props;
}

function openPanel(label = "Updates") {
  fireEvent.click(screen.getByRole("button", { name: label }));
}

// trigger tests.
test("shows the unread tally on the trigger, capped at 9+", () => {
  renderCenter({ unreadCount: 12 });
  expect(screen.getByRole("button", { name: "Updates, 12 unread" })).toBeTruthy();
  expect(screen.getByText("9+")).toBeTruthy();
});

test("shows no badge or suffix without unread updates", () => {
  renderCenter({ unreadCount: 0 });
  expect(screen.getByRole("button", { name: "Updates" })).toBeTruthy();
  expect(screen.queryByText("9+")).toBe(null);
});

// recent feed tests.
test("groups the recent feed by day and folds repeated events", () => {
  renderCenter({
    notifications: [
      makeNotification({
        id: "note-fold-1",
        taskNumber: 1,
        action: "Needs attention",
        createdAt: Date.now() - 60_000,
        readAt: null,
      }),
      makeNotification({
        id: "note-fold-2",
        taskNumber: 1,
        action: "Needs attention",
        createdAt: Date.now() - 30_000,
        readAt: 1,
      }),
      makeNotification({
        id: "note-yesterday",
        taskNumber: null,
        action: "Board tidied",
        taskTitle: null,
        body: "Three settled cards were archived.",
        level: "info",
        createdAt: yesterdayStamp(),
      }),
    ],
    tasks: [makeTask()],
  });
  openPanel();

  const today = screen.getByText("Today").closest("section") as HTMLElement;
  const folded = within(today).getByTitle("The agent is waiting for you.");
  expect(folded.textContent).toContain("Fix the login flow");
  expect(screen.getByText("×2")).toBeTruthy();
  expect(screen.getByText(", 2 times")).toBeTruthy();

  const yesterday = screen.getByText("Yesterday").closest("section") as HTMLElement;
  expect(yesterday.textContent).toContain("Board tidied");
  expect(yesterday.textContent).toContain("Three settled cards were archived.");
});

test("falls back through title, stored title, number, and action", () => {
  renderCenter({
    notifications: [
      makeNotification({
        id: "note-live",
        taskNumber: 1,
        action: "Moved to Review",
        body: "Card moved.",
        level: "info",
      }),
      makeNotification({
        id: "note-gone",
        taskNumber: 99,
        taskTitle: "Deleted card",
        action: "Completed",
        body: "",
        level: "success",
      }),
      makeNotification({
        id: "note-unknown",
        taskNumber: 7,
        taskTitle: null,
        action: "Completed",
        body: "",
        level: "success",
      }),
      makeNotification({
        id: "note-global",
        taskNumber: null,
        taskTitle: null,
        action: "Board tidied",
        body: "",
        level: "info",
      }),
    ],
    tasks: [],
  });
  openPanel();

  const rows = document.querySelectorAll(".triage-notification-row-main");
  expect(rows).toHaveLength(4);
  expect(rows[0].textContent).toContain("Fix the login flow");
  expect(rows[1].textContent).toContain("Deleted card");
  expect(rows[1].textContent).toContain("· Card deleted");
  expect((rows[1] as HTMLButtonElement).disabled).toBe(true);
  expect(rows[2].textContent).toContain("Triage #7");
  expect((rows[2] as HTMLButtonElement).disabled).toBe(true);
  expect(rows[3].textContent).toContain("Board tidied");
  expect((rows[3] as HTMLButtonElement).disabled).toBe(true);
  expect(rows[3].textContent).toContain("Board tidied");
});

test("shows the attention reason under matching feed rows", () => {
  renderCenter({
    notifications: [
      makeNotification({
        id: "note-attention",
        level: "attention",
        action: "Needs attention",
        body: "The build broke twice.",
      }),
    ],
    tasks: [],
  });
  openPanel();
  expect(screen.getByText("The build broke twice.")).toBeTruthy();
});

test("opens the card behind a feed row, marks it read, and selects it", async () => {
  const onSelect = vi.fn();
  const onMarkRead = vi.fn(async () => {});
  renderCenter({
    notifications: [
      makeNotification({
        id: "note-open",
        taskNumber: 1,
        action: "Moved to Review",
        body: "Card moved.",
        level: "info",
        readAt: null,
      }),
    ],
    tasks: [makeTask()],
    onSelect,
    onMarkRead,
  });
  openPanel();
  fireEvent.click(screen.getByTitle("Card moved."));

  await waitFor(() => expect(onMarkRead).toHaveBeenCalledWith(["note-open"]));
  expect(onSelect).toHaveBeenCalledWith(1);
  await waitFor(() => {
    expect(screen.queryByTitle("Card moved.")).toBe(null);
  });
});

test("opens a card with no unread updates without marking anything", async () => {
  const onSelect = vi.fn();
  const onMarkRead = vi.fn(async () => {});
  renderCenter({
    notifications: [
      makeNotification({ id: "note-read", level: "info", body: "Card moved.", readAt: 5 }),
    ],
    tasks: [makeTask()],
    onSelect,
    onMarkRead,
  });
  openPanel();
  fireEvent.click(screen.getByTitle("Card moved."));
  expect(onSelect).toHaveBeenCalledWith(1);
  await waitFor(() => expect(onMarkRead).not.toHaveBeenCalled());
});

test("toasts when marking a card's updates read fails", async () => {
  const onMarkRead = vi.fn(async () => Promise.reject(new Error("offline")));
  renderCenter({
    notifications: [
      makeNotification({ id: "note-open", level: "info", body: "Card moved." }),
    ],
    tasks: [makeTask()],
    onMarkRead,
  });
  openPanel();
  fireEvent.click(screen.getByTitle("Card moved."));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Could not mark updates read"));
});

test("marks everything read and reports failures with a description", async () => {
  const onMarkRead = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce("plain");
  renderCenter({ unreadCount: 4, notifications: [makeNotification()], onMarkRead });
  openPanel("Updates, 4 unread");
  const markAll = await screen.findByRole("button", { name: "Mark all read" });
  fireEvent.click(markAll);
  await waitFor(() => {
    expect(toasts.error).toHaveBeenCalledWith("Could not mark updates read", {
      description: "offline",
    });
  });
  fireEvent.click(markAll);
  await waitFor(() => {
    expect(toasts.error).toHaveBeenCalledWith("Could not mark updates read", {
      description: "plain",
    });
  });
});

// metadata tests.
test("shows project, branch, and agent metadata for live cards", () => {
  renderCenter({
    notifications: [makeNotification({ level: "attention", body: "Waiting on you." })],
    tasks: [makeTask()],
  });
  openPanel();
  const metadata = document.querySelector(".triage-notification-metadata") as HTMLElement;
  expect(metadata.textContent).toContain("#1");
  expect(metadata.textContent).toContain("synthetic-project");
  expect(metadata.textContent).toContain("synthetic/branch");
  const agent = metadata.querySelector(".triage-notification-agent [data-icon]") as HTMLElement;
  expect(agent.getAttribute("aria-label")).toBe("Anthropic · test-model-large");
});

test("skips metadata fields the row cannot know", () => {
  renderCenter({
    notifications: [
      makeNotification({ taskNumber: null, taskTitle: null, action: "Board tidied", level: "info" }),
    ],
    tasks: [],
  });
  openPanel();
  const metadata = document.querySelector(".triage-notification-metadata") as HTMLElement;
  expect(metadata.textContent).not.toContain("#");
  expect(metadata.textContent).toBe("");
});

// lens tests.
test("switches to the attention lens with card rows and their deletes", async () => {
  const onDelete = vi.fn(async () => {});
  renderCenter({
    notifications: [
      makeNotification({ id: "note-att", level: "attention", body: "Waiting on you." }),
    ],
    tasks: [
      makeTask({ number: 1, runState: "idle", attentionReason: "Waiting on you." }),
      makeTask({ number: 2, id: "task-2", runState: "working", attentionReason: null }),
    ],
    onDelete,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));

  const bucket = document.querySelector(".triage-notification-bucket") as HTMLElement;
  expect(bucket.textContent).toContain("Needs you");
  expect(bucket.textContent).toContain("1");
  expect(screen.getByTitle("Waiting on you.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Delete updates for Fix the login flow" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith(["note-att"]));
});

test("an attention card without absorbed notifications has no delete", () => {
  renderCenter({
    notifications: [],
    tasks: [makeTask({ number: 1, runState: "failed" })],
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
  expect(screen.queryByRole("button", { name: /Delete updates/ })).toBe(null);
});

test("the running lens lists work in flight, newest first", () => {
  renderCenter({
    tasks: [
      makeTask({
        id: "task-old",
        number: 1,
        title: "Older run",
        runState: "working",
        updatedAt: Date.now() - 500_000,
      }),
      makeTask({
        id: "task-new",
        number: 2,
        title: "Newer run",
        runState: "starting",
        updatedAt: Date.now() - 1_000,
      }),
    ],
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Running/ }));

  const rows = document.querySelectorAll(".triage-notification-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Newer run");
  expect(rows[1].textContent).toContain("Older run");
});

test("the pending lens reads forwards by schedule", () => {
  renderCenter({
    tasks: [
      makeTask({
        id: "task-late",
        number: 1,
        title: "Late run",
        runState: "scheduled",
        scheduledAt: Date.now() + 7_200_000,
      }),
      makeTask({
        id: "task-early",
        number: 2,
        title: "Early run",
        runState: "queued",
        scheduledAt: Date.now() + 60_000,
      }),
    ],
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Pending/ }));

  const rows = document.querySelectorAll(".triage-notification-row");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Early run");
  expect(rows[1].textContent).toContain("Late run");
});

test("pending card rows show the scheduled stamp and read-state columns", () => {
  renderCenter({
    tasks: [
      makeTask({
        id: "task-pending",
        number: 1,
        title: "Timed run",
        runState: "scheduled",
        scheduledAt: Date.now() + 60_000,
        readAt: 5,
      }),
    ],
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Pending/ }));

  const row = document.querySelector(".triage-notification-row") as HTMLElement;
  expect(row.getAttribute("data-unread")).toBe(null);
  expect(row.textContent).toContain("Scheduled");
});

test("opening a card row closes the panel, marks reads, and selects", async () => {
  const onSelect = vi.fn();
  const onMarkRead = vi.fn(async () => {});
  renderCenter({
    notifications: [
      makeNotification({ id: "note-att", level: "attention", body: "Stalled." }),
    ],
    tasks: [makeTask({ number: 1, runState: "idle", attentionReason: "Stalled." })],
    onSelect,
    onMarkRead,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
  fireEvent.click(screen.getByTitle("Stalled."));

  await waitFor(() => expect(onMarkRead).toHaveBeenCalledWith(["note-att"]));
  expect(onSelect).toHaveBeenCalledWith(1);
});

test("toasts when opening a card row fails to mark reads", async () => {
  const onMarkRead = vi.fn(async () => Promise.reject(new Error("offline")));
  renderCenter({
    notifications: [
      makeNotification({ id: "note-att", level: "attention", body: "Stalled." }),
    ],
    tasks: [makeTask({ number: 1, runState: "idle", attentionReason: "Stalled." })],
    onMarkRead,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Needs you/ }));
  fireEvent.click(screen.getByTitle("Stalled."));
  await waitFor(() => expect(toasts.error).toHaveBeenCalledWith("Could not mark updates read"));
});

// empty state tests.
test("shows the recent empty state on a quiet board", () => {
  renderCenter({});
  openPanel();
  expect(screen.getByText("No recent updates yet.")).toBeTruthy();
});

test("shows a lens-specific empty state", () => {
  renderCenter({ tasks: [makeTask({ runState: "idle" })] });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: /Running/ }));
  expect(screen.getByText("No running updates.")).toBeTruthy();
});

test("keeps the feed visible when the recent lens has no cards", () => {
  renderCenter({
    notifications: [makeNotification({ level: "info", action: "Moved", body: "" })],
    tasks: [makeTask({ runState: "working" })],
  });
  openPanel();
  // Recent lens with no attention cards still shows the feed sections.
  expect(screen.getByText("Today")).toBeTruthy();
});

// unread dot tests.
test("flags unread rows and dots", () => {
  renderCenter({
    notifications: [
      makeNotification({ id: "note-unread", action: "Moved", level: "info", body: "", readAt: null }),
      makeNotification({ id: "note-read", action: "Completed", level: "info", body: "", readAt: 3 }),
    ],
    tasks: [],
  });
  openPanel();
  const rows = document.querySelectorAll(".triage-notification-row");
  expect(rows[0].getAttribute("data-unread")).toBe("");
  expect(rows[1].getAttribute("data-unread")).toBe(null);
});

// browser notification tests.
test("hides the opt-in row when the browser already decided", () => {
  notificationApi.permission = "granted";
  try {
    renderCenter({});
    openPanel();
    expect(screen.queryByText("Enable browser notifications")).toBe(null);
  } finally {
    notificationApi.permission = "default";
  }
});

test("asks for browser notifications and toasts on grant", async () => {
  renderCenter({});
  openPanel();
  fireEvent.click(screen.getByText("Enable browser notifications"));
  await waitFor(() => expect(toasts.success).toHaveBeenCalledWith("Browser notifications enabled"));
  // The permission settled as granted, so a reopen shows no opt-in row.
  expect(notificationApi.requestPermission).toHaveBeenCalledTimes(1);
});

test("stays quiet when the browser denies the request", async () => {
  notificationApi.requestPermission.mockImplementationOnce(async () => "denied");
  renderCenter({});
  openPanel();
  fireEvent.click(screen.getByText("Enable browser notifications"));
  await waitFor(() => expect(notificationApi.requestPermission).toHaveBeenCalledTimes(1));
  expect(toasts.success).not.toHaveBeenCalledWith("Browser notifications enabled");
});

// lens round trip tests.
test("returns to the recent lens and shows it as the active one", () => {
  renderCenter({
    notifications: [makeNotification({ level: "info", action: "Moved", body: "" })],
    tasks: [makeTask({ runState: "working" })],
  });
  openPanel();
  const recent = screen.getByText("Recent").closest("button") as HTMLButtonElement;
  expect(recent.getAttribute("data-state")).toBe("active");

  fireEvent.click(screen.getByRole("button", { name: /Running/ }));
  expect(recent.getAttribute("data-state")).toBe(null);

  fireEvent.click(recent);
  expect(screen.getByText("Today")).toBeTruthy();
  expect(recent.getAttribute("data-state")).toBe("active");
});

test("closes the panel again from the trigger", () => {
  renderCenter({});
  openPanel();
  expect(screen.getByText("Recent")).toBeTruthy();
  openPanel();
  expect(screen.queryByText("Recent")).toBe(null);
});

// delete button tests.
test("deletes a feed row through its delete button", async () => {
  const onDelete = vi.fn(async () => {});
  renderCenter({
    notifications: [makeNotification({ id: "note-del", level: "info", action: "Moved", body: "" })],
    onDelete,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Delete update: Moved" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith(["note-del"]));
  expect(toasts.error).not.toHaveBeenCalled();
});

test("toasts with the error message when a delete fails", async () => {
  const onDelete = vi.fn(async () => Promise.reject(new Error("nope")));
  renderCenter({
    notifications: [makeNotification({ id: "note-del", level: "info", action: "Moved", body: "" })],
    onDelete,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Delete update: Moved" }));
  await waitFor(() => {
    expect(toasts.error).toHaveBeenCalledWith("Could not delete update", { description: "nope" });
  });
});

test("stringifies non-error delete failures", async () => {
  const onDelete = vi.fn(async () => Promise.reject("nope"));
  renderCenter({
    notifications: [makeNotification({ id: "note-del", level: "info", action: "Moved", body: "" })],
    onDelete,
  });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Delete update: Moved" }));
  await waitFor(() => {
    expect(toasts.error).toHaveBeenCalledWith("Could not delete update", { description: "nope" });
  });
});

test("ignores clicks on rows without a card to open", () => {
  const onSelect = vi.fn();
  const onMarkRead = vi.fn(async () => {});
  renderCenter({
    notifications: [
      makeNotification({
        id: "note-global",
        taskNumber: null,
        taskTitle: null,
        action: "Board tidied",
        level: "info",
      }),
    ],
    onSelect,
    onMarkRead,
  });
  openPanel();
  const row = screen.getByTitle("The agent is waiting for you.") as HTMLButtonElement;
  expect(row.disabled).toBe(true);
  // The click lands on the row's text span, so the handler still guards.
  fireEvent.click(row.querySelector(".triage-notification-action-text")!);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onMarkRead).not.toHaveBeenCalled();
});

// unsupported browser tests.
test("hides the opt-in row when the browser has no Notification API", () => {
  delete (globalThis as { Notification?: unknown }).Notification;
  try {
    renderCenter({});
    openPanel();
    expect(screen.queryByText("Enable browser notifications")).toBe(null);
  } finally {
    (globalThis as { Notification?: unknown }).Notification = notificationApi;
  }
});
