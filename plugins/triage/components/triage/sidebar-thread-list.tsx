import * as React from "react";
import {
  experimental_useSidebarThreadActions,
  useBbNavigate,
  useRealtime,
  useSettings,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";

import { ThreadTriageAction } from "./thread-triage-action";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import {
  formatAbsolute,
  formatShortWhen,
  isPending,
  isTaskRunning,
  needsAttention,
  presentRunState,
} from "@/lib/triage-format";
import { claimTriageRefresh, requestOpenTaskDetail } from "@/lib/triage-mounts";
import { useTriage } from "@/lib/triage-store";
import type { Task } from "@/lib/triage-types";

/** The sidebar belongs to the thread list; Triage borrows the top of it, not more. */
const ROW_CAP = 10;

/** Kept out of component state so the disclosure survives a route change. */
let sectionCollapsed = false;

/** Attention first, then work in flight, then work with a clock on it. */
function urgency(task: Task): number {
  if (needsAttention(task)) return 0;
  if (isTaskRunning(task)) return 1;
  if (isPending(task)) return 2;
  return 3;
}

function matchesQuery(task: Task, query: string): boolean {
  return task.title.toLowerCase().includes(query) || `#${task.number}`.includes(query);
}

function TriageSidebarSection({
  activeThreadId,
  activeProjectId,
  isCompactViewport,
  onNavigate,
  searchQuery,
}: Omit<PluginThreadListProps, "Original" | "experimental_Original">) {
  const { snapshot, refresh } = useTriage();
  const navigate = useBbNavigate();
  const threads = experimental_useSidebarThreadActions();
  const [collapsed, setCollapsed] = React.useState(sectionCollapsed);

  // The board's subscription only runs while the board is mounted, so the
  // sidebar carries its own to stay live on a thread route.
  useRealtime("triage", (payload) => {
    if (claimTriageRefresh(payload)) void refresh();
  });

  const query = searchQuery.trim().toLowerCase();

  // Scoped to the selected project, because the list underneath is: an
  // unscoped Triage section would read as noise against it.
  const rows = React.useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tasks
      .filter(
        (task) =>
          (activeProjectId === null || task.projectId === activeProjectId) &&
          (query === "" || matchesQuery(task, query)),
      )
      .sort((left, right) => urgency(left) - urgency(right) || right.updatedAt - left.updatedAt);
  }, [activeProjectId, query, snapshot]);

  if (rows.length === 0) return null;

  const openTask = (task: Task) => {
    if (task.threadId) threads.open(task.threadId);
    else {
      requestOpenTaskDetail(task.number);
      navigate.toPluginPanel("triage");
    }
    onNavigate();
  };

  const showBoard = () => {
    navigate.toPluginPanel("triage");
    onNavigate();
  };

  const visible = rows.slice(0, ROW_CAP);

  return (
    <section
      className="triage-sidebar"
      aria-label="Triage"
      data-compact={isCompactViewport ? "" : undefined}
    >
      <h2 className="triage-sidebar-heading">
        <button
          type="button"
          className="triage-sidebar-toggle"
          aria-expanded={!collapsed}
          onClick={() => {
            sectionCollapsed = !collapsed;
            setCollapsed(sectionCollapsed);
          }}
        >
          <Icon name="ChevronDown" className="triage-sidebar-chevron size-3.5" aria-hidden="true" />
          <span className="triage-sidebar-title">Triage</span>
          <span className="triage-sidebar-count tabular-nums">{rows.length}</span>
        </button>
      </h2>

      {collapsed ? null : (
        <>
          <ul className="triage-sidebar-list">
            {visible.map((task) => {
              const status = presentRunState(task);
              const stamp = task.scheduledAt ?? task.updatedAt;
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className="triage-sidebar-row"
                    data-active={
                      task.threadId !== null && task.threadId === activeThreadId ? "" : undefined
                    }
                    title={`#${task.number} · ${task.title} · ${status.label}`}
                    onClick={() => openTask(task)}
                  >
                    <StatusDot
                      tone={status.tone}
                      label={status.label}
                      size="sm"
                      pulse={status.live}
                    />
                    <span className="triage-sidebar-number tabular-nums">#{task.number}</span>
                    <span className="triage-sidebar-label">{task.title}</span>
                    <time
                      className="triage-sidebar-time tabular-nums"
                      dateTime={new Date(stamp).toISOString()}
                      title={formatAbsolute(stamp)}
                    >
                      {formatShortWhen(stamp)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>

          {rows.length > visible.length ? (
            <button
              type="button"
              className="triage-sidebar-more"
              aria-label={`Show all ${rows.length} Triage cards on the board`}
              onClick={showBoard}
            >
              <span className="triage-sidebar-label">Show all {rows.length}</span>
              <Icon name="ChevronRight" className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * The thread-list slot is exclusive: registering it replaces BB's whole list.
 * So this renders BB's list unconditionally and only adds Triage above it once
 * the user opts in — while the setting loads, the sidebar is untouched.
 */
function SidebarThreadList({
  Original,
  ...props
}: PluginThreadListProps) {
  const { values } = useSettings();

  return (
    <>
      {values?.showInSidebar === true ? <TriageSidebarSection {...props} /> : null}
      {props.activeThreadId ? <ThreadTriageAction key={props.activeThreadId} threadId={props.activeThreadId} sidebar /> : null}
      <Original />
    </>
  );
}

export { SidebarThreadList };
