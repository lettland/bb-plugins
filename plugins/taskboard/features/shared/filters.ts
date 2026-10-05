import { type IconName } from '@/components/ui/icon';
import { type WorkSource, type WorkStateCategory } from '../../contract.js';
import { type WorkItemFilterField } from '../../board-settings.js';
import { ALL_SOURCES } from './constants.js';

export const STATE_CATEGORY_ORDER: readonly WorkStateCategory[] = [
  'in_progress',
  'todo',
  'backlog',
  'done',
  'canceled'
];

export const STATE_CATEGORY_LABELS: Readonly<Record<WorkStateCategory, string>> = {
  backlog: 'Backlog',
  todo: 'Todo',
  in_progress: 'In progress',
  done: 'Done',
  canceled: 'Canceled'
};

export type FilterPresentationKey = 'source' | WorkItemFilterField;
interface FilterPresentation {
  label: string;
  icon: IconName;
  description: string;
}

export const FILTER_PRESENTATION = {
  source: {
    label: 'Source',
    icon: 'GitBranch',
    description: 'The external tracker selected for the work.'
  },
  state: {
    label: 'State group',
    icon: 'Circle',
    description: 'Broad Backlog, Todo, In progress, Done, and Canceled groups.'
  },
  status: {
    label: 'Status',
    icon: 'Workflow',
    description: 'Exact provider workflow states such as In Review or Blocked.'
  },
  assignee: {
    label: 'Assignee',
    icon: 'UserRound',
    description: 'People assigned to the work, including Unassigned.'
  },
  priority: {
    label: 'Priority',
    icon: 'AlertCircle',
    description: 'Urgent, High, Medium, Low, and unprioritized work.'
  },
  project: {
    label: 'Project',
    icon: 'Folder',
    description: 'The provider project, repository, or Jira project.'
  },
  labels: {
    label: 'Labels',
    icon: 'Layers',
    description: 'Provider labels, including work with no labels.'
  }
} as const satisfies Record<FilterPresentationKey, FilterPresentation>;

export const BOARD_FILTER_FIELDS = [
  'state',
  'status',
  'assignee',
  'priority',
  'project',
  'labels'
] as const satisfies readonly WorkItemFilterField[];

export const BOARD_FILTER_OPTIONS = BOARD_FILTER_FIELDS.map(field => ({
  field,
  ...FILTER_PRESENTATION[field]
}));

export type SourceFilter = typeof ALL_SOURCES | WorkSource;

export function toggled<T>(values: readonly T[], value: T, checked: boolean): T[] {
  if (checked) return values.includes(value) ? [...values] : [...values, value];
  return values.filter(candidate => candidate !== value);
}

export function sameStringValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
