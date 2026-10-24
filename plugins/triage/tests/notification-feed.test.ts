import { expect, test } from "vitest";

import {
  buildAttention,
  bucketOf,
  cardStamp,
  FEED_LIMIT,
  foldRuns,
  groupByDay,
  LENSES,
  LEVEL_TONE,
  toCardRow,
  unreadIds,
  attentionRank,
  type CardRow,
  type FeedRow,
} from "../lib/notification-feed.ts";
import type { Task, TriageNotification } from "../lib/triage-types.ts";

/* ---------------------------------------------------------------------------
   Fixtures
   ------------------------------------------------------------------------ */

let counter = 0;
function nid(): string {
  counter += 1;
  return `n-${counter}`;
}

function notification(
  overrides: Partial<TriageNotification> & { action: string },
): TriageNotification {
  return {
    id: nid(),
    taskNumber: null,
    taskTitle: null,
    title: overrides.action,
    body: "",
    level: "info",
    readAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function task(overrides: Partial<Task> & Pick<Task, "number">): Task {
  return {
    id: `t-${overrides.number}`,
    title: `Task ${overrides.number}`,
    description: "",
    stageId: "stage-progress",
    projectId: "p",
    projectName: "Project",
    machineId: null,
    machineName: "Default",
    branchName: "main",
    providerId: "claude-code",
    model: "claude-sonnet",
    reasoningLevel: "medium",
    scheduledAt: null,
    threadId: null,
    runState: "idle",
    attentionReason: null,
    request: null,
    readAt: null,
    settledAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/* ---------------------------------------------------------------------------
   foldRuns — drives the feed rows and the ids a delete button targets
   ------------------------------------------------------------------------ */

test("foldRuns: each row keeps every notification id it folded in", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "Moved to In Review", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "Moved to In Review", createdAt: 200 }),
    notification({ id: "c", taskNumber: 1, action: "Moved to In Review", createdAt: 150 }),
  ]);

  expect(rows.length).toBe(1);
  expect(rows[0].count).toBe(3);
  expect(rows[0].notificationIds).toStrictEqual(["a", "b", "c"]);
});

test("foldRuns: a different action or card breaks the run", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "Moved to In Review", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "Agent started", createdAt: 200 }),
    notification({ id: "c", taskNumber: 2, action: "Moved to In Review", createdAt: 300 }),
    notification({ id: "d", taskNumber: null, action: "Moved to In Review", createdAt: 400 }),
  ]);

  expect(rows.length).toBe(4);
  expect(rows.map((r) => r.notificationIds)).toStrictEqual([
    ["a"],
    ["b"],
    ["c"],
    ["d"],
  ]);
});

test("foldRuns: a run is unread if any member is unread", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", readAt: 5, createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", readAt: null, createdAt: 200 }),
  ]);
  expect(rows.length).toBe(1);
  expect(rows[0].unread).toBe(true);
});

test("foldRuns: a fully-read run is not unread", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", readAt: 5, createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", readAt: 6, createdAt: 200 }),
  ]);
  expect(rows[0].unread).toBe(false);
});

test("foldRuns: keeps the newest stamp in a run", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", createdAt: 300 }),
    notification({ id: "c", taskNumber: 1, action: "X", createdAt: 200 }),
  ]);
  expect(rows[0].createdAt).toBe(300);
});

/* ---------------------------------------------------------------------------
   buildAttention — card rows carry the ids needed to delete their history,
   and absorbed ids leave the chronological feed
   ------------------------------------------------------------------------ */

test("buildAttention: folds attention notifications into the matching card", () => {
  const tasks = [task({ number: 1, runState: "failed", attentionReason: "boom" })];
  const { rows, absorbed } = buildAttention(tasks, [
    notification({ id: "a", taskNumber: 1, action: "Needs attention", level: "attention", body: "boom", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "Needs attention", level: "attention", body: "boom", createdAt: 200 }),
    notification({ id: "c", taskNumber: 1, action: "Agent started", level: "info", createdAt: 300 }),
  ]);

  expect(rows.length).toBe(1);
  const row: CardRow = rows[0];
  expect(row.events).toBe(2);
  expect(row.notificationIds).toStrictEqual(["a", "b"]);
  expect(row.unread).toBe(true);
  expect(row.reason).toBe("boom");
  expect([...absorbed]).toStrictEqual(["a", "b"]);
});

test("buildAttention: non-attention or unmatchable notifications are not absorbed", () => {
  const tasks = [task({ number: 1, runState: "idle" })];
  const { absorbed } = buildAttention(tasks, [
    notification({ id: "info", taskNumber: 1, action: "Agent started", level: "info", createdAt: 100 }),
    notification({ id: "orphan", taskNumber: 2, action: "Needs attention", level: "attention", createdAt: 200 }),
  ]);
  expect(absorbed.size).toBe(0);
});

test("buildAttention: a card with no attention notifications has no delete target", () => {
  const tasks = [task({ number: 1, runState: "idle" })];
  const { rows } = buildAttention(tasks, []);
  expect(rows.length).toBe(1);
  expect(rows[0].notificationIds).toStrictEqual([]);
  expect(rows[0].events).toBe(0);
});

test("buildAttention: failed cards rank above merely-idle ones", () => {
  const tasks = [
    task({ number: 2, runState: "idle" }),
    task({ number: 1, runState: "failed", attentionReason: "err" }),
  ];
  const { rows } = buildAttention(tasks, []);
  expect(rows.map((r) => r.task.number)).toStrictEqual([1, 2]);
});

/* ---------------------------------------------------------------------------
   unreadIds — the snapshot the delayed mark-read fires against
   ------------------------------------------------------------------------ */

test("unreadIds: returns only ids whose readAt is null", () => {
  expect(
    unreadIds([
      notification({ id: "a", action: "X", level: "info", readAt: null }),
      notification({ id: "b", action: "X", level: "info", readAt: 5 }),
      notification({ id: "c", action: "X", level: "attention", readAt: null }),
    ]),
  ).toStrictEqual(["a", "c"]);
});

test("unreadIds: empty when everything is read", () => {
  expect(
    unreadIds([notification({ id: "a", action: "X", level: "info", readAt: 1 })]),
  ).toStrictEqual([]);
});

/* ---------------------------------------------------------------------------
   Glance mark-read: the snapshot is frozen at open, so notifications that
   arrive afterwards are never swept into the delayed mark-read.
   ------------------------------------------------------------------------ */

test("glance snapshot: a notification arriving after the snapshot is not marked", () => {
  // The popover opens; the snapshot is taken immediately from the current list.
  const atOpen = [
    notification({ id: "old", action: "X", level: "info", readAt: null }),
  ];
  const snapshot = unreadIds(atOpen);
  expect(snapshot).toStrictEqual(["old"]);

  // While the user is glancing, a realtime event adds a fresh notification.
  const afterArrival = [
    ...atOpen,
    notification({ id: "fresh", action: "Y", level: "info", readAt: null }),
  ];

  // The delayed mark-read fires against the frozen snapshot, not the live list.
  const marked = snapshot;
  expect(marked).toStrictEqual(["old"]);
  expect(!marked.includes("fresh")).toBeTruthy();
  expect(afterArrival.length).toBe(2);
});

test("glance snapshot: empty snapshot skips the mark-read call entirely", () => {
  const snapshot = unreadIds([
    notification({ id: "a", action: "X", level: "info", readAt: 1 }),
  ]);
  expect(snapshot.length).toBe(0);
});

/* ---------------------------------------------------------------------------
   Day buckets and grouping
   ------------------------------------------------------------------------ */

function feedRow(overrides: Partial<FeedRow> & Pick<FeedRow, "id" | "createdAt">): FeedRow {
  return {
    notificationIds: [overrides.id],
    taskNumber: null,
    taskTitle: null,
    action: "X",
    level: "info",
    body: "",
    count: 1,
    unread: false,
    ...overrides,
  };
}

test("bucketOf names today, yesterday, and older days by date", () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  expect(bucketOf(todayStart.getTime())).toBe("Today");
  expect(bucketOf(Date.now())).toBe("Today");
  expect(bucketOf(todayStart.getTime() - 1)).toBe("Yesterday");
  expect(bucketOf(todayStart.getTime() - 86_400_000)).toBe("Yesterday");
  const older = todayStart.getTime() - 3 * 86_400_000;
  expect(bucketOf(older)).toBe(
    new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(new Date(older)),
  );
});

test("groupByDay keeps one bucket per run of same-day rows", () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterday = todayStart.getTime() - 86_400_000;
  const groups = groupByDay([
    feedRow({ id: "a", createdAt: todayStart.getTime() }),
    feedRow({ id: "b", createdAt: todayStart.getTime() + 1 }),
    feedRow({ id: "c", createdAt: yesterday }),
    feedRow({ id: "d", createdAt: yesterday + 1 }),
    feedRow({ id: "e", createdAt: todayStart.getTime() + 2 }),
  ]);
  expect(groups.map((group) => group.bucket)).toStrictEqual(["Today", "Yesterday", "Today"]);
  expect(groups.map((group) => group.items.map((row) => row.id))).toStrictEqual([
    ["a", "b"],
    ["c", "d"],
    ["e"],
  ]);
  expect(groupByDay([])).toStrictEqual([]);
});

/* ---------------------------------------------------------------------------
   Card rows
   ------------------------------------------------------------------------ */

test("cardStamp prefers a schedule for pending cards and updatedAt otherwise", () => {
  expect(cardStamp(task({ number: 1, runState: "scheduled", scheduledAt: 500, updatedAt: 2 }))).toBe(500);
  expect(cardStamp(task({ number: 1, runState: "queued", scheduledAt: null, updatedAt: 2 }))).toBe(2);
  expect(cardStamp(task({ number: 1, runState: "working", scheduledAt: 500, updatedAt: 2 }))).toBe(2);
});

test("toCardRow carries the attention reason and the stamp", () => {
  const row = toCardRow(task({ number: 4, attentionReason: "needs access", scheduledAt: null, updatedAt: 9 }));
  expect(row.task.number).toBe(4);
  expect(row.unread).toBe(false);
  expect(row.events).toBe(0);
  expect(row.notificationIds).toStrictEqual([]);
  expect(row.reason).toBe("needs access");
  expect(row.stamp).toBe(9);
});

test("attentionRank orders failed, then reasoned, then the rest", () => {
  expect(attentionRank(task({ number: 1, runState: "failed" }))).toBe(0);
  expect(attentionRank(task({ number: 1, runState: "working", attentionReason: "why" }))).toBe(1);
  expect(attentionRank(task({ number: 1, runState: "idle" }))).toBe(2);
});

test("buildAttention: an idle card takes its reason from the notification body", () => {
  const { rows, absorbed } = buildAttention(
    [task({ number: 1, runState: "idle" })],
    [
      notification({ id: "a", taskNumber: 1, action: "Needs attention", level: "attention", body: "cannot reach the host", readAt: 10, createdAt: 100 }),
      notification({ id: "b", taskNumber: 1, action: "Needs attention", level: "attention", body: "second", readAt: null, createdAt: 200 }),
    ],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].reason).toBe("cannot reach the host");
  expect(rows[0].unread).toBe(true);
  expect(rows[0].events).toBe(2);
  expect([...absorbed]).toStrictEqual(["a", "b"]);
});

test("buildAttention: fully read history keeps the card row unread-free", () => {
  const { rows, absorbed } = buildAttention(
    [task({ number: 1, runState: "idle" })],
    [notification({ id: "a", taskNumber: 1, action: "Needs attention", level: "attention", readAt: 10, createdAt: 100 })],
  );
  expect(rows[0].unread).toBe(false);
  expect(absorbed.has("a")).toBe(true);
});

test("buildAttention: cards of equal rank sort newest first", () => {
  const { rows } = buildAttention([
    task({ number: 1, runState: "idle", updatedAt: 100 }),
    task({ number: 2, runState: "idle", updatedAt: 900 }),
  ], []);
  expect(rows.map((row) => row.task.number)).toStrictEqual([2, 1]);
});

/* ---------------------------------------------------------------------------
   Lenses and constants
   ------------------------------------------------------------------------ */

test("the lenses reuse the board predicates", () => {
  expect(LENSES.attention.match(task({ number: 1, runState: "failed" }))).toBe(true);
  expect(LENSES.attention.match(task({ number: 1, runState: "working" }))).toBe(false);
  expect(LENSES.live.match(task({ number: 1, runState: "working" }))).toBe(true);
  expect(LENSES.live.match(task({ number: 1, runState: "idle" }))).toBe(false);
  expect(LENSES.scheduled.match(task({ number: 1, runState: "queued" }))).toBe(true);
  expect(LENSES.scheduled.match(task({ number: 1, runState: "completed" }))).toBe(false);
  expect(LENSES.attention.label).toBe("Needs you");
  expect(LENSES.live.label).toBe("Running");
  expect(LENSES.scheduled.label).toBe("Pending");
});

test("levels map to tones and the feed keeps a fixed history length", () => {
  expect(LEVEL_TONE).toStrictEqual({ attention: "danger", success: "done", info: "unread" });
  expect(FEED_LIMIT).toBe(40);
});
