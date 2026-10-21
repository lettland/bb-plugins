import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/ui/status-dot";
import {
  agentBrand,
  providerLabel,
  formatShortWhen,
  isPending,
  isTaskRunning,
  needsAttention,
  presentRunState,
} from "@/lib/triage-format";
import {
  FEED_LIMIT,
  LENS_ORDER,
  LENSES,
  buildAttention,
  foldRuns,
  groupByDay,
  toCardRow,
  type CardRow,
  type FeedRow,
  type LensId,
} from "@/lib/notification-feed";
import type { Task, TriageNotification } from "@/lib/triage-types";

function Tally({ count }: { count: number }) {
  if (count < 2) return null;
  return (
    <>
      <span className="triage-notification-tally tabular-nums" aria-hidden="true">
        ×{count}
      </span>
      <span className="sr-only">, {count} times</span>
    </>
  );
}

function BrowserPermissionRow() {
  const [permission, setPermission] = React.useState<NotificationPermission | "unsupported">(
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission),
  );

  if (permission !== "default") return null;

  return (
    <button
      type="button"
      className="triage-notification-optin"
      onClick={() => {
        void Notification.requestPermission().then((next) => {
          setPermission(next);
          if (next === "granted") toast.success("Browser notifications enabled");
        });
      }}
    >
      <Icon name="MailOpen" className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[11px]">Enable browser notifications</span>
      </span>
    </button>
  );
}

function NotificationDeleteButton({
  label,
  onDelete,
}: {
  label: string;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = React.useState(false);

  return (
    <button
      type="button"
      className="triage-notification-delete"
      aria-label={label}
      title={label}
      disabled={deleting}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setDeleting(true);
        void onDelete()
          .catch((error) => {
            toast.error("Could not delete update", {
              description: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => setDeleting(false));
      }}
    >
      <Icon name="Trash2" className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function NotificationMetadata({ task, number }: { task: Task | null; number: number | null }) {
  const brand = task ? agentBrand(task.providerId, task.model) : null;
  return (
    <span className="triage-notification-metadata">
      {number !== null ? <span className="triage-notification-number">#{number}</span> : null}
      {task ? <>
        <span className="triage-notification-meta-item" title={task.projectName}>
          <Icon name="Folder" aria-hidden="true" />
          <span>{task.projectName}</span>
        </span>
        <span className="triage-notification-meta-item" title={task.branchName}>
          <Icon name="GitBranch" aria-hidden="true" />
          <span>{task.branchName}</span>
        </span>
        <span className="triage-notification-agent" title={`${providerLabel(task.providerId)} · ${task.model}`}>
          <Icon name={brand!.icon} aria-label={`${brand!.name} · ${task.model}`} />
        </span>
      </> : null}
    </span>
  );
}

function CardRowButton({
  row,
  onOpen,
  onDelete,
}: {
  row: CardRow;
  onOpen: () => void;
  onDelete?: () => Promise<void>;
}) {
  const status = presentRunState(row.task);
  return (
    <div data-unread={row.unread ? "" : undefined} className="triage-notification-row">
      <button
        type="button"
        className="triage-notification-row-main"
        title={row.reason ?? undefined}
        onClick={onOpen}
      >
        <span className="triage-notification-unread-dot" aria-label={row.unread ? "Unread" : undefined} />
        <span className="min-w-0">
          <span className="triage-notification-action">
            <span className="triage-notification-action-text">{row.task.title}</span>
            <Tally count={row.events} />
          </span>
          <span className="triage-notification-target">{row.reason || status.label}</span>
          <NotificationMetadata task={row.task} number={row.task.number} />
        </span>
      </button>
      <span className="triage-notification-trailing">
        <span className="triage-notification-time tabular-nums">
          {formatShortWhen(row.stamp)}
        </span>
        {onDelete ? (
          <NotificationDeleteButton
            label={`Delete updates for ${row.task.title}`}
            onDelete={onDelete}
          />
        ) : null}
      </span>
    </div>
  );
}

function FeedRowButton({
  row,
  task,
  onOpen,
  onDelete,
}: {
  row: FeedRow;
  task: Task | null;
  onOpen: (taskNumber: number) => void;
  onDelete: () => Promise<void>;
}) {
  const missing = row.taskNumber !== null && task === null;

  return (
    <div data-unread={row.unread ? "" : undefined} className="triage-notification-row">
      <button
        type="button"
        className="triage-notification-row-main"
        title={row.body || undefined}
        disabled={row.taskNumber === null || missing}
        onClick={() => {
          if (row.taskNumber === null || missing) return;
          onOpen(row.taskNumber);
        }}
      >
        <span className="triage-notification-unread-dot" aria-label={row.unread ? "Unread" : undefined} />
        <span className="min-w-0">
          <span className="triage-notification-action">
            <span className="triage-notification-action-text">{task?.title || row.taskTitle || (row.taskNumber !== null ? `Triage #${row.taskNumber}` : row.action)}</span>
          </span>
          <span className="triage-notification-target">
            {row.taskNumber === null ? row.body || row.action : row.action}
            <Tally count={row.count} />
            {missing ? <span className="triage-notification-missing"> · Card deleted</span> : null}
          </span>
          {row.level === "attention" && row.body && row.body !== row.action ? (
            <span className="triage-notification-reason">{row.body}</span>
          ) : null}
          <NotificationMetadata task={task} number={row.taskNumber} />
        </span>
      </button>
      <span className="triage-notification-trailing">
        <span className="triage-notification-time tabular-nums">
          {formatShortWhen(row.createdAt)}
        </span>
        <NotificationDeleteButton label={`Delete update: ${row.action}`} onDelete={onDelete} />
      </span>
    </div>
  );
}

export interface NotificationCenterProps {
  notifications: TriageNotification[];
  /**
   * Every card on the board. History alone cannot say what is true now, so
   * rows are joined against live cards by number.
   */
  tasks: Task[];
  unreadCount: number;
  onSelect: (taskNumber: number) => void;
  onMarkRead: (ids: string[] | null) => Promise<void>;
  onDelete: (ids: string[]) => Promise<void>;
}

/** Recent updates first, with separate views for current task states. */
function NotificationCenter({
  notifications,
  tasks,
  unreadCount,
  onSelect,
  onMarkRead,
  onDelete,
}: NotificationCenterProps) {
  const [open, setOpen] = React.useState(false);
  const [lens, setLens] = React.useState<LensId | null>(null);
  const taskByNumber = React.useMemo(
    () => new Map(tasks.map((task) => [task.number, task])),
    [tasks],
  );

  const counts = React.useMemo<Record<LensId, number>>(
    () => ({
      attention: tasks.filter(needsAttention).length,
      live: tasks.filter(isTaskRunning).length,
      scheduled: tasks.filter(isPending).length,
    }),
    [tasks],
  );

  const activeLens = lens;

  const attention = React.useMemo(
    () => buildAttention(tasks, notifications),
    [notifications, tasks],
  );

  const cardRows = React.useMemo(() => {
    if (activeLens === null) return [];
    if (activeLens === "attention") return attention.rows;
    const rows = tasks.filter(LENSES[activeLens].match).map(toCardRow);
    // Pending cards read forwards — the next one to fire is the useful one.
    return rows.sort((a, b) =>
      activeLens === "scheduled" ? a.stamp - b.stamp : b.stamp - a.stamp,
    );
  }, [activeLens, attention, tasks]);

  const feed = React.useMemo(
    () =>
      groupByDay(
        foldRuns(
          [...notifications]
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, FEED_LIMIT),
        ),
      ),
    [notifications],
  );

  const openTask = React.useCallback(
    (taskNumber: number) => {
      setOpen(false);
      const ids = notifications.filter((notification) => notification.taskNumber === taskNumber && notification.readAt === null).map((notification) => notification.id);
      if (ids.length) void onMarkRead(ids).catch(() => toast.error("Could not mark updates read"));
      onSelect(taskNumber);
    },
    [notifications, onMarkRead, onSelect],
  );

  const showFeed = activeLens === null;
  const groupLabel = activeLens === null ? LENSES.attention.label : LENSES[activeLens].label;
  const groupPinned = activeLens === null || activeLens === "attention";

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setLens(null); }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Updates${unreadCount ? `, ${unreadCount} unread` : ""}`}
        >
          <span className="triage-notification-icon" aria-hidden="true">
            <Icon name="Mail" className="size-4" />
            {unreadCount > 0 ? (
              <span className="triage-notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
            ) : null}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="triage-notification-panel"
        mobileTitle="Updates"
      >
        <header className="triage-notification-header">
          <span className="text-[13px] font-semibold">Updates</span>
          {unreadCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => {
                void onMarkRead(null).catch((error) => {
                  toast.error("Could not mark updates read", {
                    description: error instanceof Error ? error.message : String(error),
                  });
                });
              }}
            >
              Mark all read
            </Button>
          ) : null}
        </header>
        <div className="triage-notification-digest" role="group" aria-label="Filter updates">
          <button type="button" className="triage-notification-lens"
            aria-pressed={activeLens === null}
            data-state={activeLens === null ? "active" : undefined}
            onClick={() => setLens(null)}>
            <Icon name="Clock" className="size-3" aria-hidden="true" />
            <span>Recent</span>
          </button>
          {LENS_ORDER.map((id) => {
            const active = id === activeLens;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                data-state={active ? "active" : undefined}
                className="triage-notification-lens"
                title={LENSES[id].hint}
                onClick={() => setLens(id)}
              >
                <StatusDot tone={LENSES[id].tone} size="sm" />
                <span>{LENSES[id].label}</span>
                <span className="triage-notification-lens-count tabular-nums">{counts[id]}</span>
              </button>
            );
          })}
        </div>
        <div className="triage-notification-scroll">
          {cardRows.length === 0 && (!showFeed || feed.length === 0) ? (
            <p className="px-4 py-10 text-center text-[13px] text-muted-foreground">
              {showFeed ? "No recent updates yet." : `No ${LENSES[activeLens!].label.toLowerCase()} updates.`}
            </p>
          ) : (
            <>
              {cardRows.length > 0 ? (
                <section>
                  <h4 className="triage-notification-bucket" data-pinned={groupPinned ? "" : undefined}>
                    {groupLabel}
                    <span className="triage-notification-bucket-count tabular-nums">
                      {cardRows.length}
                    </span>
                  </h4>
                  {cardRows.map((row) => (
                    <CardRowButton
                      key={row.task.id}
                      row={row}
                      onOpen={() => openTask(row.task.number)}
                      onDelete={
                        row.notificationIds.length > 0
                          ? () => onDelete(row.notificationIds)
                          : undefined
                      }
                    />
                  ))}
                </section>
              ) : null}
              {showFeed
                ? feed.map((group) => (
                    <section key={group.bucket}>
                      <h4 className="triage-notification-bucket">{group.bucket}</h4>
                      {group.items.map((row) => (
                        <FeedRowButton
                          key={row.id}
                          row={row}
                          task={row.taskNumber === null ? null : taskByNumber.get(row.taskNumber) ?? null}
                          onOpen={openTask}
                          onDelete={() => onDelete(row.notificationIds)}
                        />
                      ))}
                    </section>
                  ))
                : null}
            </>
          )}
        </div>
        <BrowserPermissionRow />
      </PopoverContent>
    </Popover>
  );
}

export { NotificationCenter };
