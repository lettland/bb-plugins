import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAttention,
  foldRuns,
  unreadIds,
  type CardRow,
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

  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  assert.deepEqual(rows[0].notificationIds, ["a", "b", "c"]);
});

test("foldRuns: a different action or card breaks the run", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "Moved to In Review", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "Agent started", createdAt: 200 }),
    notification({ id: "c", taskNumber: 2, action: "Moved to In Review", createdAt: 300 }),
    notification({ id: "d", taskNumber: null, action: "Moved to In Review", createdAt: 400 }),
  ]);

  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((r) => r.notificationIds),
    [["a"], ["b"], ["c"], ["d"]],
  );
});

test("foldRuns: a run is unread if any member is unread", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", readAt: 5, createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", readAt: null, createdAt: 200 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unread, true);
});

test("foldRuns: a fully-read run is not unread", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", readAt: 5, createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", readAt: 6, createdAt: 200 }),
  ]);
  assert.equal(rows[0].unread, false);
});

test("foldRuns: keeps the newest stamp in a run", () => {
  const rows = foldRuns([
    notification({ id: "a", taskNumber: 1, action: "X", createdAt: 100 }),
    notification({ id: "b", taskNumber: 1, action: "X", createdAt: 300 }),
    notification({ id: "c", taskNumber: 1, action: "X", createdAt: 200 }),
  ]);
  assert.equal(rows[0].createdAt, 300);
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

  assert.equal(rows.length, 1);
  const row: CardRow = rows[0];
  assert.equal(row.events, 2);
  assert.deepEqual(row.notificationIds, ["a", "b"]);
  assert.equal(row.unread, true);
  assert.equal(row.reason, "boom");
  assert.deepEqual([...absorbed], ["a", "b"]);
});

test("buildAttention: non-attention or unmatchable notifications are not absorbed", () => {
  const tasks = [task({ number: 1, runState: "idle" })];
  const { absorbed } = buildAttention(tasks, [
    notification({ id: "info", taskNumber: 1, action: "Agent started", level: "info", createdAt: 100 }),
    notification({ id: "orphan", taskNumber: 2, action: "Needs attention", level: "attention", createdAt: 200 }),
  ]);
  assert.equal(absorbed.size, 0);
});

test("buildAttention: a card with no attention notifications has no delete target", () => {
  const tasks = [task({ number: 1, runState: "idle" })];
  const { rows } = buildAttention(tasks, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].notificationIds, []);
  assert.equal(rows[0].events, 0);
});

test("buildAttention: failed cards rank above merely-idle ones", () => {
  const tasks = [
    task({ number: 2, runState: "idle" }),
    task({ number: 1, runState: "failed", attentionReason: "err" }),
  ];
  const { rows } = buildAttention(tasks, []);
  assert.deepEqual(rows.map((r) => r.task.number), [1, 2]);
});

/* ---------------------------------------------------------------------------
   unreadIds — the snapshot the delayed mark-read fires against
   ------------------------------------------------------------------------ */

test("unreadIds: returns only ids whose readAt is null", () => {
  assert.deepEqual(
    unreadIds([
      notification({ id: "a", action: "X", level: "info", readAt: null }),
      notification({ id: "b", action: "X", level: "info", readAt: 5 }),
      notification({ id: "c", action: "X", level: "attention", readAt: null }),
    ]),
    ["a", "c"],
  );
});

test("unreadIds: empty when everything is read", () => {
  assert.deepEqual(
    unreadIds([notification({ id: "a", action: "X", level: "info", readAt: 1 })]),
    [],
  );
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
  assert.deepEqual(snapshot, ["old"]);

  // While the user is glancing, a realtime event adds a fresh notification.
  const afterArrival = [
    ...atOpen,
    notification({ id: "fresh", action: "Y", level: "info", readAt: null }),
  ];

  // The delayed mark-read fires against the frozen snapshot, not the live list.
  const marked = snapshot;
  assert.deepEqual(marked, ["old"]);
  assert.ok(!marked.includes("fresh"));
  assert.equal(afterArrival.length, 2);
});

test("glance snapshot: empty snapshot skips the mark-read call entirely", () => {
  const snapshot = unreadIds([
    notification({ id: "a", action: "X", level: "info", readAt: 1 }),
  ]);
  assert.equal(snapshot.length, 0);
});
