import { type FilterPreset, type WorkStateCategory } from '../../contract.js';
import {
  type TrackerView,
  type WorkItemFilterField
} from '../../board-settings.js';
import { type FilterOption, isFilterOptionSelected } from '../../browse.js';
import {
  type SourceFilter,
  STATE_CATEGORY_LABELS,
  STATE_CATEGORY_ORDER
} from '../shared/filters.js';
import { ALL_SOURCES } from '../shared/constants.js';
import { sourceName } from '../shared/source.js';

export interface TrackerFilterBarProps {
  presets: readonly FilterPreset[] | null;
  presetsError: string | null;
  presetsRefreshError: string | null;
  presetsLoading: boolean;
  presetActionsReady: boolean;
  onApplyPreset: (preset: FilterPreset) => void;
  onRetryPresets: () => void;
  onSaveCurrentPreset: () => void;
  source: SourceFilter;
  enabledFilters: readonly WorkItemFilterField[];
  stateCategories: readonly WorkStateCategory[];
  statuses: readonly string[];
  statusOptions: readonly FilterOption[];
  assignees: readonly string[];
  assigneeOptions: readonly FilterOption[];
  priorities: readonly string[];
  priorityOptions: readonly FilterOption[];
  externalProjects: readonly string[];
  projectOptions: readonly FilterOption[];
  labels: readonly string[];
  labelOptions: readonly FilterOption[];
  query: string;
  view: TrackerView;
  surfaceMode: 'full' | 'constrained';
  showSourceFilter: boolean;
  showViewToggle: boolean;
  onSourceChange: (source: SourceFilter) => void;
  onStateCategoriesChange: (categories: WorkStateCategory[]) => void;
  onStatusesChange: (statuses: string[]) => void;
  onAssigneesChange: (assignees: string[]) => void;
  onPrioritiesChange: (priorities: string[]) => void;
  onExternalProjectsChange: (projects: string[]) => void;
  onLabelsChange: (labels: string[]) => void;
  onQueryChange: (query: string) => void;
  onViewChange: (view: TrackerView) => void;
  onClear: () => void;
}

type OptionFilterField = Exclude<WorkItemFilterField, 'state'>;

export interface OptionFacet {
  selected: readonly string[];
  options: readonly FilterOption[];
  onChange: (values: string[]) => void;
}

export const SOURCE_FILTER_OPTIONS = [
  ALL_SOURCES,
  'linear',
  'github',
  'jira'
] as const;

export function sourceOptionLabel(option: SourceFilter): string {
  return option === ALL_SOURCES ? 'All sources' : sourceName(option);
}

export function optionFacets(
  props: TrackerFilterBarProps
): Record<OptionFilterField, OptionFacet> {
  return {
    status: {
      selected: props.statuses,
      options: props.statusOptions,
      onChange: props.onStatusesChange
    },
    assignee: {
      selected: props.assignees,
      options: props.assigneeOptions,
      onChange: props.onAssigneesChange
    },
    priority: {
      selected: props.priorities,
      options: props.priorityOptions,
      onChange: props.onPrioritiesChange
    },
    project: {
      selected: props.externalProjects,
      options: props.projectOptions,
      onChange: props.onExternalProjectsChange
    },
    labels: {
      selected: props.labels,
      options: props.labelOptions,
      onChange: props.onLabelsChange
    }
  };
}

export function hasActiveFilters(props: TrackerFilterBarProps): boolean {
  return (
    props.source !== ALL_SOURCES ||
    props.stateCategories.length > 0 ||
    props.statuses.length > 0 ||
    props.assignees.length > 0 ||
    props.priorities.length > 0 ||
    props.externalProjects.length > 0 ||
    props.labels.length > 0 ||
    props.query.trim() !== ''
  );
}

export function selectedFacetNames(
  selected: readonly string[],
  options: readonly FilterOption[]
): string[] {
  return selected.map(
    value =>
      options.find(option => isFilterOptionSelected([value], option.value))
        ?.label ?? value
  );
}

export function countActiveFacets(props: TrackerFilterBarProps): number {
  const facets = optionFacets(props);
  return [
    props.showSourceFilter && props.source !== ALL_SOURCES,
    props.enabledFilters.includes('state') && props.stateCategories.length > 0,
    ...(Object.keys(facets) as OptionFilterField[]).map(
      field =>
        props.enabledFilters.includes(field) && facets[field].selected.length > 0
    )
  ].filter(Boolean).length;
}

export function matchingFacetValueCount(
  props: TrackerFilterBarProps,
  matchesFacet: (label: string) => boolean
): number {
  const facets = optionFacets(props);
  const optionCount = (Object.keys(facets) as OptionFilterField[]).reduce(
    (count, field) =>
      props.enabledFilters.includes(field)
        ? count +
          facets[field].options.filter(option => matchesFacet(option.label))
            .length
        : count,
    0
  );
  const sourceCount = props.showSourceFilter
    ? SOURCE_FILTER_OPTIONS.filter(option =>
        matchesFacet(sourceOptionLabel(option))
      ).length
    : 0;
  const stateCount = props.enabledFilters.includes('state')
    ? STATE_CATEGORY_ORDER.filter(category =>
        matchesFacet(STATE_CATEGORY_LABELS[category])
      ).length
    : 0;
  return sourceCount + stateCount + optionCount;
}
