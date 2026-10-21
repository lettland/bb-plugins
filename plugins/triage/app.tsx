import { useCallback, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { BoardSkeleton, ToolbarSkeleton } from "@/components/triage/board-skeleton";
import { BoardToolbar, type TaskFilter } from "@/components/triage/board-toolbar";
import { TaskComposerDialog } from "@/components/triage/task-composer-dialog";
import { TriageHeaderActions } from "@/components/triage/header-actions";
import { ThreadTriageAction } from "@/components/triage/thread-triage-action";
import { SidebarThreadList } from "@/components/triage/sidebar-thread-list";
import { TaskCard } from "@/components/triage/task-card";
import {
  isTaskRunning,
  supportsTaskRead,
  stageTone,
} from "@/lib/triage-format";
import { claimTriageRefresh, usePendingOpenTaskDetail } from "@/lib/triage-mounts";
import { patchTaskRead, patchTaskStage, useOpenTaskRequests, useTriage } from "@/lib/triage-store";
import type { NotificationLevel, Task } from "@/lib/triage-types";
import "./app.css";

interface RealtimePayload {
  kind?: string;
  notification?: {
    taskNumber: number | null;
    action: string;
    taskTitle: string | null;
    title: string;
    body: string;
    level: NotificationLevel;
  };
}

/** Toast plus, when BB is in the background, a browser notification. */
function showNotification(payload: RealtimePayload["notification"]): void {
  if (!payload) return;
  const subject =
    payload.taskNumber === null
      ? payload.body
      : `#${payload.taskNumber}${payload.taskTitle ? ` · ${payload.taskTitle}` : ""}`;
  const options = { description: subject };
  if (payload.level === "attention") toast.error(payload.action, options);
  else if (payload.level === "success") toast.success(payload.action, options);
  else toast.info(payload.action, options);

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    document.visibilityState !== "visible"
  ) {
    new Notification(payload.action, {
      body: subject,
      tag: `triage-${payload.taskNumber ?? "general"}`,
    });
  }
}

function matchesFilter(task: Task, filter: TaskFilter): boolean {
  switch (filter) {
    case "live":
      return task.settledAt === null && isTaskRunning(task);
    case "unread":
      return task.settledAt === null && supportsTaskRead(task) && task.readAt === null;
    case "settled":
      return task.settledAt !== null;
    default:
      return task.settledAt === null;
  }
}

function TriageBoard() {
  const { snapshot, error, loading, rpc, refresh } = useTriage();
  const { projectId: routeProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const [projectFilter, setProjectFilter] = useState("all");
  const [machineFilter, setMachineFilter] = useState("all");
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [draggedNumber, setDraggedNumber] = useState<number | null>(null);
  const [dropStageId, setDropStageId] = useState<string | null>(null);
  const [editingNumber, setEditingNumber] = useState<number | null>(null);

  useRealtime("triage", (payload) => {
    showNotification((payload as RealtimePayload).notification);
    // The sidebar list hears the same signal; only one of them needs to fetch.
    if (claimTriageRefresh(payload)) void refresh();
  });

  const openTask = useCallback(
    (taskNumber: number) => {
      const task = snapshot?.tasks.find((item) => item.number === taskNumber);
      if (!task) return;
      if (supportsTaskRead(task) && task.readAt === null) {
        patchTaskRead(task.number, true);
        void rpc.call("setTaskRead", { number: task.number, read: true }).then(refresh, refresh);
      }
      if (task.threadId) navigate.toThread(task.threadId);
      else setEditingNumber(task.number);
    },
    [navigate, refresh, rpc, snapshot],
  );

  useOpenTaskRequests(openTask);
  // Notification rows ask to open a card by number. Existing threads win;
  // cards without one fall back to the shared editor.
  usePendingOpenTaskDetail(setEditingNumber);

  /** Cards inside the current project and machine scope, before the lens. */
  const scopedTasks = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.tasks.filter(
      (task) =>
        (projectFilter === "all" || task.projectId === projectFilter) &&
        (machineFilter === "all" ||
          (task.machineId ?? snapshot.projects.find((project) => project.id === task.projectId)?.defaultMachineId) === machineFilter),
    );
  }, [machineFilter, projectFilter, snapshot]);

  const counts = useMemo(
    () => ({
      all: scopedTasks.filter((task) => task.settledAt === null).length,
      live: scopedTasks.filter((task) => task.settledAt === null && isTaskRunning(task)).length,
      unread: scopedTasks.filter((task) => task.settledAt === null && supportsTaskRead(task) && task.readAt === null).length,
      settled: scopedTasks.filter((task) => task.settledAt !== null).length,
    }),
    [scopedTasks],
  );

  const visibleTasks = useMemo(
    () => scopedTasks.filter((task) => matchesFilter(task, taskFilter)),
    [scopedTasks, taskFilter],
  );

  const taskAction = async (operation: () => Promise<unknown>, message: string) => {
    try {
      await operation();
      toast.success(message);
      await refresh();
    } catch (actionError) {
      toast.error(actionError instanceof Error ? actionError.message : String(actionError));
    }
  };

  const move = async (task: Task, stageId: string) => {
    if (task.stageId === stageId) return;
    patchTaskStage(task.number, stageId);
    try {
      await rpc.call("moveTask", { number: task.number, stageId });
      await refresh();
    } catch (moveError) {
      toast.error(moveError instanceof Error ? moveError.message : String(moveError));
      await refresh();
    }
  };

  if (!snapshot && loading) {
    return (
      <div className="triage-shell">
        <ToolbarSkeleton />
        <div className="triage-board-viewport">
          <BoardSkeleton />
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="triage-error">
        <Icon name="AlertTriangle" className="size-6 text-destructive" aria-hidden="true" />
        <div>
          <p className="font-semibold">Triage could not load</p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  const editingTask = snapshot.tasks.find((task) => task.number === editingNumber) ?? null;
  const defaultProjectId = projectFilter !== "all" ? projectFilter : routeProjectId;

  return (
    <div className="triage-shell">
      <BoardToolbar
        projects={snapshot.projects}
        machines={snapshot.machines}
        stages={snapshot.stages}
        projectFilter={projectFilter}
        machineFilter={machineFilter}
        taskFilter={taskFilter}
        counts={counts}
        defaultProjectId={defaultProjectId}
        rpc={rpc}
        onProjectFilterChange={(value) => {
          setProjectFilter(value);
          const defaultMachineId = snapshot.projects.find((project) => project.id === value)?.defaultMachineId;
          setMachineFilter(defaultMachineId && snapshot.machines.some((machine) => machine.id === defaultMachineId) ? defaultMachineId : "all");
        }}
        onMachineFilterChange={setMachineFilter}
        onTaskFilterChange={setTaskFilter}
        onCreated={refresh}
      />

      <div className="triage-board-viewport">
        <div className="triage-board">
          {snapshot.stages.map((stage) => {
            const cards = visibleTasks.filter((task) => task.stageId === stage.id);
            const dragging = draggedNumber !== null;
            return (
              <section
                key={stage.id}
                className="triage-column"
                data-dropping={dropStageId === stage.id ? "" : undefined}
                onDragOver={(event) => {
                  if (!dragging) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  if (dropStageId !== stage.id) setDropStageId(stage.id);
                }}
                onDragLeave={(event) => {
                  // Ignore the events fired while crossing this column's children.
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setDropStageId((current) => (current === stage.id ? null : current));
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const task = scopedTasks.find((item) => item.number === draggedNumber);
                  setDraggedNumber(null);
                  setDropStageId(null);
                  if (task) void move(task, stage.id);
                }}
              >
                <header className="triage-column-header">
                  <StatusDot tone={stageTone(stage)} size="sm" />
                  <h2 className="triage-column-name">{stage.name}</h2>
                  <span className="triage-column-count tabular-nums">{cards.length}</span>
                </header>
                <div className="triage-column-scroll">
                  {cards.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      stages={snapshot.stages}
                      showMachine={snapshot.machines.length > 1}
                      onOpen={() => openTask(task.number)}
                      onToggleSidebar={() => void taskAction(
                        () => rpc.call("setThreadSidebar", { number: task.number, visible: !task.sidebarVisible }),
                        task.sidebarVisible ? "Session hidden from sidebar" : "Session shown in sidebar",
                      )}
                      onMove={(stageId) => void move(task, stageId)}
                      onRun={() =>
                        void taskAction(
                          () => rpc.call("runTask", { number: task.number }),
                          `Started Triage #${task.number}`,
                        )
                      }
                      onStop={() =>
                        void taskAction(
                          () => rpc.call("stopTask", { number: task.number }),
                          `Stopped Triage #${task.number}`,
                        )
                      }
                      onSetSettled={(settled) =>
                        void taskAction(
                          () => rpc.call("setTaskSettled", { number: task.number, settled }),
                          settled ? `Settled Triage #${task.number}` : `Reopened Triage #${task.number}`,
                        )
                      }
                      onSetRead={(read) => {
                        patchTaskRead(task.number, read);
                        void rpc.call("setTaskRead", { number: task.number, read }).then(refresh, refresh);
                      }}
                      onDelete={() =>
                        void taskAction(
                          () => rpc.call("deleteTask", { number: task.number }),
                          `Deleted Triage #${task.number}`,
                        )
                      }
                      onDragStart={() => setDraggedNumber(task.number)}
                      onDragEnd={() => {
                        setDraggedNumber(null);
                        setDropStageId(null);
                      }}
                    />
                  ))}
                  {cards.length === 0 ? (
                    <p className="triage-column-empty" data-dragging={dragging ? "" : undefined}>
                      {dragging
                        ? `Drop in ${stage.name}`
                        : taskFilter === "all"
                          ? "No cards yet"
                          : "Nothing matches this filter"}
                    </p>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <TaskComposerDialog
        mode="edit"
        task={editingTask}
        stages={snapshot.stages}
        rpc={rpc}
        open={editingTask !== null}
        onOpenChange={(next) => {
          if (!next) setEditingNumber(null);
        }}
        onSaved={refresh}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "triage-thread-action",
    title: "Triage",
    component: ThreadTriageAction,
  });
  app.slots.navPanel({
    id: "triage-board",
    title: "Triage",
    icon: "ListTodo",
    path: "triage",
    component: TriageBoard,
    headerContent: TriageHeaderActions,
  });

  app.slots.experimental_threadList({
    id: "triage-sidebar",
    title: "Triage above threads",
    description:
      "BB's thread list with your Triage cards above it, once the plugin's sidebar setting is on.",
    component: SidebarThreadList,
  });
});
