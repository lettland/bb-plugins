import type { StatusTone } from "../components/ui/status-dot";
import { isPending, isTaskRunning, needsAttention } from "./triage-format";
import type { NotificationLevel, Task, TriageNotification } from "./triage-types";

/** How many history rows survive the fold; past this the feed is archaeology. */
export const FEED_LIMIT = 40;

export const LEVEL_TONE: Record<NotificationLevel, StatusTone> = {
  attention: "danger",
  success: "done",
  info: "unread",
};

export type LensId = "attention" | "live" | "scheduled";

export interface Lens {
  label: string;
  tone: StatusTone;
  hint: string;
  match: (task: Task) => boolean;
}

/** Vocabulary is the board toolbar's, so the two filters mean the same thing. */
export const LENSES: Record<LensId, Lens> = {
  attention: {
    label: "Needs you",
    tone: "danger",
    hint: "Cards waiting on a person",
    match: needsAttention,
  },
  live: {
    label: "Running",
    tone: "ongoing",
    hint: "An agent is working right now",
    match: isTaskRunning,
  },
  scheduled: {
    label: "Pending",
    tone: "scheduled",
    hint: "Queued or scheduled",
    match: isPending,
  },
};

export const LENS_ORDER: readonly LensId[] = ["attention", "live", "scheduled"];

/** A live card, which is what the top of the panel is actually about. */
export interface CardRow {
  task: Task;
  unread: boolean;
  /** Attention events folded into this card. */
  events: number;
  /** Persisted notification rows represented by this live status card. */
  notificationIds: string[];
  reason: string | null;
  stamp: number;
}

/** A run of history collapsed to the one thing it says. */
export interface FeedRow {
  id: string;
  notificationIds: string[];
  taskNumber: number | null;
  taskTitle: string | null;
  action: string;
  level: NotificationLevel;
  body: string;
  count: number;
  createdAt: number;
  unread: boolean;
}

/** Today / Yesterday / date, so a long list stays scannable. */
export function bucketOf(timestamp: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (timestamp >= start.getTime()) return "Today";
  if (timestamp >= start.getTime() - 86_400_000) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(
    new Date(timestamp),
  );
}

export function groupByDay(rows: FeedRow[]): { bucket: string; items: FeedRow[] }[] {
  const groups: { bucket: string; items: FeedRow[] }[] = [];
  for (const row of rows) {
    const bucket = bucketOf(row.createdAt);
    const last = groups.at(-1);
    if (last?.bucket === bucket) last.items.push(row);
    else groups.push({ bucket, items: [row] });
  }
  return groups;
}

/**
 * "Needs attention" three times in a row is one card misbehaving, not three
 * things to read. Consecutive events for the same card and action fold into
 * one row that keeps the newest stamp.
 */
export function foldRuns(notifications: TriageNotification[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const notification of notifications) {
    const last = rows.at(-1);
    if (
      last &&
      last.taskNumber === notification.taskNumber &&
      last.action === notification.action
    ) {
      last.count += 1;
      last.createdAt = Math.max(last.createdAt, notification.createdAt);
      last.unread ||= notification.readAt === null;
      last.notificationIds.push(notification.id);
      continue;
    }
    rows.push({
      id: notification.id,
      notificationIds: [notification.id],
      taskNumber: notification.taskNumber,
      taskTitle: notification.taskTitle,
      action: notification.action,
      level: notification.level,
      body: notification.body,
      count: 1,
      createdAt: notification.createdAt,
      unread: notification.readAt === null,
    });
  }
  return rows;
}

export function cardStamp(task: Task): number {
  return isPending(task) ? task.scheduledAt ?? task.updatedAt : task.updatedAt;
}

export function toCardRow(task: Task): CardRow {
  return {
    task,
    unread: false,
    events: 0,
    notificationIds: [],
    reason: task.attentionReason,
    stamp: cardStamp(task),
  };
}

/** A broken card outranks a merely waiting one; after that, most recent wins. */
export function attentionRank(task: Task): number {
  if (task.runState === "failed") return 0;
  if (task.attentionReason !== null) return 1;
  return 2;
}

/**
 * The cards that currently want a person, each carrying its own history. The
 * card is the thing that needs answering, so its events belong to it rather
 * than to the chronological feed, where a fresh failure would sink under a
 * fortnight of routine updates.
 */
export function buildAttention(
  tasks: Task[],
  notifications: TriageNotification[],
): { rows: CardRow[]; absorbed: ReadonlySet<string> } {
  const rows = tasks.filter(needsAttention).map(toCardRow);
  const byNumber = new Map(rows.map((row) => [row.task.number, row]));
  const absorbed = new Set<string>();

  for (const notification of notifications) {
    if (notification.level !== "attention" || notification.taskNumber === null) continue;
    const row = byNumber.get(notification.taskNumber);
    if (!row) continue;
    absorbed.add(notification.id);
    row.events += 1;
    row.notificationIds.push(notification.id);
    row.unread ||= notification.readAt === null;
    row.reason ??= notification.body;
  }

  rows.sort((a, b) => attentionRank(a.task) - attentionRank(b.task) || b.stamp - a.stamp);
  return { rows, absorbed };
}

/**
 * The ids of every notification that is currently unread. Used to snapshot the
 * popover's contents at open so a delayed mark-read only touches what was
 * visible at that glance, never a notification that arrived afterwards.
 */
export function unreadIds(notifications: TriageNotification[]): string[] {
  return notifications.filter((n) => n.readAt === null).map((n) => n.id);
}
