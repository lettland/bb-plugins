import type {
  WorkItem,
  WorkStateCategory,
  WorkStatusOption
} from '../contract.js';

export const DEFAULT_WORKFLOW_STATUS_ORDER: readonly string[] = [
  'Backlog',
  'Todo',
  'In Progress',
  'In Review',
  'QA',
  'Ready for Release',
  'Blocked',
  'Duplicate',
  'Done',
  'Canceled'
];

export interface WorkflowStatus {
  name: string;
  category: WorkStateCategory;
}

export interface WorkflowStatusGroup extends WorkflowStatus {
  key: string;
  items: WorkItem[];
}

export interface WorkflowStatusLane extends WorkflowStatus {
  key: string;
}

const FALLBACK_WORKFLOW_RANK: Readonly<Record<WorkStateCategory, number>> = {
  in_progress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  canceled: 4
};

const FALLBACK_STATUS_LABEL: Readonly<Record<WorkStateCategory, string>> = {
  in_progress: 'In progress',
  todo: 'Todo',
  backlog: 'Backlog',
  done: 'Done',
  canceled: 'Canceled'
};

const PROVIDER_STATUS_ANCHORS: Readonly<
  Record<WorkStateCategory, readonly string[]>
> = {
  in_progress: ['in review', 'in progress', 'blocked'],
  todo: ['blocked', 'todo'],
  backlog: ['backlog'],
  done: ['done'],
  canceled: []
};

export function normalizedValue(value: string): string {
  return value
    .trim()
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase();
}

export function normalizedStatus(value: string): string {
  const normalized = normalizedValue(value);
  return normalized === 'to do' ? 'todo' : normalized;
}

export const WORKFLOW_STATUS_TONES = [
  'review',
  'progress',
  'blocked',
  'qa',
  'todo',
  'duplicate',
  'triage',
  'backlog',
  'done',
  'canceled'
] as const;
export type WorkflowStatusTone = (typeof WORKFLOW_STATUS_TONES)[number];

const EXACT_STATUS_TONES = new Map<string, WorkflowStatusTone>([
  ['in review', 'review'],
  ['review', 'review'],
  ['in progress', 'progress'],
  ['started', 'progress'],
  ['blocked', 'blocked'],
  ['paused', 'blocked'],
  ['qa', 'qa'],
  ['quality assurance', 'qa'],
  ['todo', 'todo'],
  ['unstarted', 'todo'],
  ['duplicate', 'duplicate'],
  ['triage', 'triage'],
  ['backlog', 'backlog'],
  ['done', 'done'],
  ['completed', 'done'],
  ['closed', 'done'],
  ['canceled', 'canceled'],
  ['cancelled', 'canceled']
]);

export function workflowStatusTone(
  name: string,
  category: WorkStateCategory
): WorkflowStatusTone {
  const normalized = normalizedStatus(name);
  const exact = EXACT_STATUS_TONES.get(normalized);
  if (exact) return exact;

  let hash = 0;
  for (const character of `${category}:${normalized}`) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return WORKFLOW_STATUS_TONES[hash % WORKFLOW_STATUS_TONES.length]!;
}

function workflowRank(
  status: WorkflowStatus,
  statusOrder: readonly string[]
): number {
  const normalizedOrder = statusOrder.map(normalizedStatus);
  const exactRank = normalizedOrder.indexOf(normalizedStatus(status.name));
  if (exactRank >= 0) return exactRank;

  let categoryAnchor = -1;
  for (const [index, name] of normalizedOrder.entries()) {
    if (PROVIDER_STATUS_ANCHORS[status.category].includes(name)) {
      categoryAnchor = index;
    }
  }
  if (categoryAnchor >= 0) return categoryAnchor + 0.5;

  return statusOrder.length + FALLBACK_WORKFLOW_RANK[status.category];
}

export function compareWorkflowStatuses(
  left: WorkflowStatus,
  right: WorkflowStatus,
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): number {
  return (
    workflowRank(left, statusOrder) - workflowRank(right, statusOrder) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
    left.name.localeCompare(right.name)
  );
}

export function sortWorkItemsByWorkflow(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkItem[] {
  return [...items].sort((left, right) =>
    compareWorkflowStatuses(
      { name: left.status, category: left.stateCategory },
      { name: right.status, category: right.stateCategory },
      statusOrder
    )
  );
}

export function workflowStatusGroups(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusGroup[] {
  const groups = new Map<string, WorkflowStatusGroup>();
  for (const item of items) {
    const name = item.status.trim() || FALLBACK_STATUS_LABEL[item.stateCategory];
    const key = `${item.stateCategory}:${normalizedStatus(name)}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, {
        key,
        name,
        category: item.stateCategory,
        items: [item]
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}

export function workflowStatusLaneKey(
  name: string,
  category: WorkStateCategory
): string {
  return `${category}:${normalizedStatus(name)}`;
}

export function workflowStatusLanes(
  items: readonly WorkItem[],
  discovered: readonly WorkStatusOption[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusLane[] {
  const lanes = new Map<string, WorkflowStatusLane>();
  for (const group of workflowStatusGroups(items, statusOrder)) {
    const key = workflowStatusLaneKey(group.name, group.category);
    lanes.set(key, {
      key,
      name: group.name,
      category: group.category
    });
  }
  for (const status of discovered) {
    const key = workflowStatusLaneKey(status.name, status.stateCategory);
    if (lanes.has(key)) continue;
    lanes.set(key, {
      key,
      name: status.name,
      category: status.stateCategory
    });
  }
  return [...lanes.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}
