import { useMemo, useState } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import {
  selectCards,
  selectTasks,
  useTasksQuery,
  type TasksInput,
} from "../../shell/data.js";
import {
  TASK_STATUSES,
  tasksRpcContract,
  type Label,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type TaskThread,
} from "../../shared/contract.js";

interface ListTaskFilters {
  statuses: readonly TaskStatus[];
  priorities: readonly TaskPriority[];
  labelIds: readonly string[] | null;
}

export type ListTaskMode = "focus" | "recent" | "archive" | "active";

const FOCUS_STATUSES: readonly TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
];
const CLOSED_STATUSES: readonly TaskStatus[] = ["done", "canceled"];

const MODE_STATUS_OPTIONS: Record<ListTaskMode, readonly TaskStatus[]> = {
  focus: FOCUS_STATUSES,
  recent: CLOSED_STATUSES,
  archive: CLOSED_STATUSES,
  active: TASK_STATUSES,
};

export function modeStatusOptions(mode: ListTaskMode): readonly TaskStatus[] {
  return MODE_STATUS_OPTIONS[mode];
}

export function statusFilterForMode(
  mode: ListTaskMode,
  selected: readonly TaskStatus[],
): TaskStatus[] {
  const options = MODE_STATUS_OPTIONS[mode];
  return selected.filter((status) => options.includes(status));
}

export function requestedStatuses(
  mode: ListTaskMode,
  selected: readonly TaskStatus[],
): readonly TaskStatus[] | undefined {
  const narrowed = statusFilterForMode(mode, selected);
  if (narrowed.length > 0) return narrowed;
  return mode === "focus" || mode === "recent"
    ? MODE_STATUS_OPTIONS[mode]
    : undefined;
}

export interface TaskEdit {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
}

export function applyEdit(task: Task, edit: TaskEdit): Task {
  return {
    ...task,
    ...(edit.status !== undefined ? { status: edit.status } : {}),
    ...(edit.priority !== undefined ? { priority: edit.priority } : {}),
    ...(edit.dueDate !== undefined ? { dueDate: edit.dueDate } : {}),
    ...(edit.labelIds !== undefined ? { labelIds: edit.labelIds } : {}),
  };
}

export function matchesFilters(
  task: Task,
  statuses: readonly TaskStatus[],
  priorities: readonly TaskPriority[],
  labelIds: readonly string[],
): boolean {
  return (
    (statuses.length === 0 || statuses.includes(task.status)) &&
    (priorities.length === 0 || priorities.includes(task.priority)) &&
    (labelIds.length === 0 || task.labelIds.some((id) => labelIds.includes(id)))
  );
}

export function listTasksQuery(
  projectId: string | null,
  mode: ListTaskMode,
  filters: ListTaskFilters,
): TasksInput<"listAllTasks"> {
  const statuses = requestedStatuses(mode, filters.statuses);
  return {
    ...(projectId === null ? {} : { projectId }),
    ...(statuses === undefined ? {} : { statuses: [...statuses] }),
    ...(filters.priorities.length > 0
      ? { priorities: [...filters.priorities] }
      : {}),
    ...(filters.labelIds !== null ? { labelIds: [...filters.labelIds] } : {}),
    activeOnly: mode === "active",
    archive: mode === "archive" ? ("archived" as const) : ("active" as const),
    parentTaskId: null,
  };
}

export function useListTasks(
  projectId: string | null,
  mode: ListTaskMode,
  filters: ListTaskFilters,
) {
  const query = listTasksQuery(projectId, mode, filters);
  const all = useTasksQuery("listAllTasks", query, selectTasks);
  const [previous, setPrevious] = useState<Task[] | undefined>(undefined);
  if (all.data !== undefined && all.data !== previous) setPrevious(all.data);
  return {
    data: all.data ?? (all.isLoading ? previous : undefined),
    error: all.error,
    isLoading: all.isLoading,
    reads: [query],
    refresh: all.refresh,
  };
}

export function useListTaskEdit(reads: readonly TasksInput<"listAllTasks">[]) {
  return experimental_useRpcMutation({
    contract: tasksRpcContract,
    method: "updateTask",
    optimistic: ({ taskId, ...edit }, cache) => {
      for (const input of reads) {
        cache.update("listAllTasks", input, (current) => ({
          ...current,
          tasks: current.tasks.map((task) =>
            task.id === taskId ? applyEdit(task, edit) : task,
          ),
        }));
      }
    },
  });
}

export function useLabels(projectIds: readonly string[]) {
  const query = experimental_useRpcKeyedQuery({
    contract: tasksRpcContract,
    method: "labelsByProject",
    keys: projectIds,
  });
  const loaded = projectIds.every((projectId) =>
    Object.hasOwn(query.data ?? {}, projectId),
  );
  const rows = query.data;
  const data = useMemo(
    (): Label[] | undefined =>
      loaded
        ? projectIds.flatMap((projectId) => rows?.[projectId] ?? [])
        : undefined,
    [loaded, projectIds, rows],
  );
  return { data };
}

export interface TaskRowMeta {
  activeThreads: TaskThread[];
}

export function useTaskListMeta(projectId: string | null) {
  const cards = useTasksQuery(
    "listTaskCardMeta",
    projectId === null ? {} : { projectId },
    selectCards,
  );
  const data = useMemo(
    () =>
      cards.data === undefined
        ? undefined
        : new Map(
            cards.data
              .filter((card) => card.activeThreads.length > 0)
              .map((card) => [
                card.taskId,
                { activeThreads: card.activeThreads },
              ]),
          ),
    [cards.data],
  );
  return { data };
}
