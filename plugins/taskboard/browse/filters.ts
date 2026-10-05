import type { WorkItem, WorkStateCategory } from '../contract.js';
import {
  DEFAULT_WORKFLOW_STATUS_ORDER,
  compareWorkflowStatuses,
  normalizedValue
} from './workflow.ts';

export const UNASSIGNED_ASSIGNEE_FILTER = '__taskboard_unassigned__';
export const NO_PRIORITY_FILTER = '__taskboard_no_priority__';
export const NO_PROJECT_FILTER = '__taskboard_no_project__';
export const NO_LABELS_FILTER = '__taskboard_no_labels__';

export interface FilterOption {
  value: string;
  label: string;
}

export type AssigneeFilterOption = FilterOption;

export interface WorkItemAttributeFilters {
  statuses: readonly string[];
  assignees: readonly string[];
  priorities: readonly string[];
  projects: readonly string[];
  labels: readonly string[];
}

function normalizedOptionalValue(
  value: string | null,
  emptyNames: RegExp
): string | null {
  const normalized = value?.trim().replaceAll(/\s+/gu, ' ') ?? '';
  if (!normalized || emptyNames.test(normalized)) return null;
  return normalized;
}

function normalizedAssignee(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|unassigned)$/iu);
}

function normalizedPriority(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no priority)$/iu);
}

function normalizedProject(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no project)$/iu);
}

export function filterOptionIdentity(value: string): string {
  return value.toLocaleLowerCase();
}

export function canonicalizeSelectedFilterOptions(
  selected: readonly string[],
  options: readonly FilterOption[]
): string[] {
  const canonicalValues = new Map<string, string>();
  for (const option of options) {
    const identity = filterOptionIdentity(option.value);
    if (!canonicalValues.has(identity)) {
      canonicalValues.set(identity, option.value);
    }
  }

  const seen = new Set<string>();
  const canonicalized: string[] = [];
  for (const value of selected) {
    const identity = filterOptionIdentity(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    canonicalized.push(canonicalValues.get(identity) ?? value);
  }
  return canonicalized;
}

export function isFilterOptionSelected(
  selected: readonly string[],
  optionValue: string
): boolean {
  const identity = filterOptionIdentity(optionValue);
  return selected.some(value => filterOptionIdentity(value) === identity);
}

export function toggleFilterOptionSelection(
  selected: readonly string[],
  optionValue: string
): string[] {
  const identity = filterOptionIdentity(optionValue);
  const remaining = selected.filter(
    value => filterOptionIdentity(value) !== identity
  );
  return remaining.length === selected.length
    ? [...selected, optionValue]
    : remaining;
}

function singleValueFilterOptions(
  values: readonly (string | null)[],
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string,
  emptyLabel?: string
): FilterOption[] {
  const options = new Map<string, FilterOption>();
  let hasEmpty = false;
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) {
      hasEmpty = true;
      continue;
    }
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  for (const value of selected) {
    if (emptyToken && value === emptyToken) {
      hasEmpty = true;
      continue;
    }
    const normalized = normalize(value);
    if (!normalized) continue;
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  const sorted = [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
  if (hasEmpty && emptyToken && emptyLabel) {
    sorted.push({ value: emptyToken, label: emptyLabel });
  }
  return sorted;
}

export function statusFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = [],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): FilterOption[] {
  const categories = new Map<string, WorkStateCategory>();
  for (const item of items) {
    categories.set(
      filterOptionIdentity(item.status.trim()),
      item.stateCategory
    );
  }
  return singleValueFilterOptions(
    items.map(item => item.status),
    selected,
    value => normalizedOptionalValue(value, /^$/u)
  ).sort((left, right) =>
    compareWorkflowStatuses(
      {
        name: left.label,
        category: categories.get(filterOptionIdentity(left.value)) ?? 'todo'
      },
      {
        name: right.label,
        category: categories.get(filterOptionIdentity(right.value)) ?? 'todo'
      },
      statusOrder
    )
  );
}

export function assigneeFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): AssigneeFilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.assignee),
    selected,
    normalizedAssignee,
    UNASSIGNED_ASSIGNEE_FILTER,
    'Unassigned'
  );
}

function priorityRank(value: string): number {
  const normalized = normalizedValue(value);
  if (['urgent', 'critical', 'highest', 'blocker', 'p0'].includes(normalized)) {
    return 0;
  }
  if (['high', 'major', 'p1'].includes(normalized)) return 1;
  if (['medium', 'normal', 'moderate', 'p2'].includes(normalized)) return 2;
  if (['low', 'lowest', 'minor', 'trivial', 'p3', 'p4'].includes(normalized)) {
    return 3;
  }
  return 4;
}

export function priorityFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.priority),
    selected,
    normalizedPriority,
    NO_PRIORITY_FILTER,
    'No priority'
  ).sort(
    (left, right) =>
      (left.value === NO_PRIORITY_FILTER ? 5 : priorityRank(left.value)) -
        (right.value === NO_PRIORITY_FILTER ? 5 : priorityRank(right.value)) ||
      left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
}

export function projectFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.project),
    selected,
    normalizedProject,
    NO_PROJECT_FILTER,
    'No project'
  );
}

export function labelFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  const options = singleValueFilterOptions(
    items.flatMap(item => item.labels),
    selected.filter(label => label !== NO_LABELS_FILTER),
    value => normalizedOptionalValue(value, /^$/u)
  );
  if (
    (items.some(item => item.labels.every(label => !label.trim())) ||
      selected.includes(NO_LABELS_FILTER)) &&
    !options.some(option => option.value === NO_LABELS_FILTER)
  ) {
    options.push({ value: NO_LABELS_FILTER, label: 'No labels' });
  }
  return options;
}

function matchesSingleValueFilter(
  value: string | null,
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string
): boolean {
  if (selected.length === 0) return true;
  const normalized = normalize(value);
  if (!normalized) return emptyToken ? selected.includes(emptyToken) : false;
  const selectedValues = new Set(
    selected
      .filter(candidate => candidate !== emptyToken)
      .map(candidate => normalize(candidate))
      .filter((candidate): candidate is string => candidate !== null)
      .map(filterOptionIdentity)
  );
  return selectedValues.has(filterOptionIdentity(normalized));
}

export function filterWorkItemsByAssignee(
  items: readonly WorkItem[],
  selected: readonly string[]
): WorkItem[] {
  return items.filter(item =>
    matchesSingleValueFilter(
      item.assignee,
      selected,
      normalizedAssignee,
      UNASSIGNED_ASSIGNEE_FILTER
    )
  );
}

export function filterWorkItemsByAttributes(
  items: readonly WorkItem[],
  filters: WorkItemAttributeFilters
): WorkItem[] {
  const selectedLabels = new Set(
    filters.labels
      .filter(label => label !== NO_LABELS_FILTER)
      .map(filterOptionIdentity)
  );
  const includeNoLabels = filters.labels.includes(NO_LABELS_FILTER);

  return items.filter(item => {
    if (
      !matchesSingleValueFilter(
        item.status,
        filters.statuses,
        value => normalizedOptionalValue(value, /^$/u)
      ) ||
      !matchesSingleValueFilter(
        item.assignee,
        filters.assignees,
        normalizedAssignee,
        UNASSIGNED_ASSIGNEE_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.priority,
        filters.priorities,
        normalizedPriority,
        NO_PRIORITY_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.project,
        filters.projects,
        normalizedProject,
        NO_PROJECT_FILTER
      )
    ) {
      return false;
    }

    if (filters.labels.length === 0) return true;
    const labels = item.labels
      .map(label => label.trim())
      .filter(Boolean)
      .map(filterOptionIdentity);
    return labels.length === 0
      ? includeNoLabels
      : labels.some(label => selectedLabels.has(label));
  });
}
