import {
  type TrackerProject,
  type WorkItem,
  type WorkStateCategory
} from '../../contract.js';
import {
  type TrackerView,
  type WorkItemFilterField
} from '../../board-settings.js';
import {
  canonicalizeSelectedFilterOptions,
  type FilterOption
} from '../../browse.js';
import { type BrowsePreferences } from '../../browse-preferences.js';
import { sameStringValues, type SourceFilter } from '../shared/filters.js';
import { ALL_SOURCES } from '../shared/constants.js';

export type BrowsePreferenceUpdater = (
  update: (current: BrowsePreferences) => BrowsePreferences
) => void;

export interface FacetOptionSets {
  statuses: readonly FilterOption[];
  assignees: readonly FilterOption[];
  priorities: readonly FilterOption[];
  externalProjects: readonly FilterOption[];
  labels: readonly FilterOption[];
}

export function enabledSelection(
  enabledFilters: readonly WorkItemFilterField[],
  field: WorkItemFilterField,
  values: readonly string[]
): readonly string[] {
  return enabledFilters.includes(field) ? values : [];
}

export function canonicalizeFacetSelections(
  current: BrowsePreferences,
  available: FacetOptionSets
): BrowsePreferences {
  const nextStatuses = canonicalizeSelectedFilterOptions(
    current.statuses,
    available.statuses
  );
  const nextAssignees = canonicalizeSelectedFilterOptions(
    current.assignees,
    available.assignees
  );
  const nextPriorities = canonicalizeSelectedFilterOptions(
    current.priorities,
    available.priorities
  );
  const nextExternalProjects = canonicalizeSelectedFilterOptions(
    current.externalProjects,
    available.externalProjects
  );
  const nextLabels = canonicalizeSelectedFilterOptions(
    current.labels,
    available.labels
  );
  if (
    sameStringValues(current.statuses, nextStatuses) &&
    sameStringValues(current.assignees, nextAssignees) &&
    sameStringValues(current.priorities, nextPriorities) &&
    sameStringValues(current.externalProjects, nextExternalProjects) &&
    sameStringValues(current.labels, nextLabels)
  ) {
    return current;
  }
  return {
    ...current,
    statuses: nextStatuses,
    assignees: nextAssignees,
    priorities: nextPriorities,
    externalProjects: nextExternalProjects,
    labels: nextLabels
  };
}

export function hasActiveListFilters(
  projectId: string | null,
  preferences: BrowsePreferences,
  enabledFilters: readonly WorkItemFilterField[],
  committedQuery: string
): boolean {
  const { source, stateCategories, statuses, assignees, priorities } =
    preferences;
  const { externalProjects, labels } = preferences;
  return (
    (projectId === null && source !== ALL_SOURCES) ||
    (enabledFilters.includes('state') && stateCategories.length > 0) ||
    (enabledFilters.includes('status') && statuses.length > 0) ||
    (enabledFilters.includes('assignee') && assignees.length > 0) ||
    (enabledFilters.includes('priority') && priorities.length > 0) ||
    (enabledFilters.includes('project') && externalProjects.length > 0) ||
    (enabledFilters.includes('labels') && labels.length > 0) ||
    committedQuery.trim() !== ''
  );
}

export function groupItemsByProject(
  projects: readonly TrackerProject[] | undefined,
  visibleItems: readonly WorkItem[]
): Array<{ project: TrackerProject; items: WorkItem[] }> {
  return (projects ?? []).flatMap(project => {
    const projectItems = visibleItems.filter(
      item => item.bbProjectId === project.id
    );
    return projectItems.length > 0 ? [{ project, items: projectItems }] : [];
  });
}

export function duplicateNames(
  projects: readonly TrackerProject[] | undefined
): Set<string> {
  const counts = new Map<string, number>();
  for (const project of projects ?? []) {
    counts.set(project.name, (counts.get(project.name) ?? 0) + 1);
  }
  return new Set(
    [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  );
}

export function listStatusMessage(
  items: readonly WorkItem[] | undefined,
  error: string | null,
  visibleCount: number,
  filtered: boolean
): string {
  if (items === undefined) return 'Loading work items';
  if (error) return 'Work items could not be loaded';
  if (visibleCount === 0) {
    return filtered
      ? 'No work items match the current filters'
      : 'No work items available';
  }
  return `${visibleCount} ${visibleCount === 1 ? 'work item' : 'work items'} shown`;
}

export function preferenceChangeHandlers(
  updatePreferences: BrowsePreferenceUpdater
) {
  return {
    onSourceChange: (nextSource: SourceFilter) =>
      updatePreferences(current => ({ ...current, source: nextSource })),
    onStateCategoriesChange: (nextStateCategories: WorkStateCategory[]) =>
      updatePreferences(current => ({
        ...current,
        stateCategories: nextStateCategories
      })),
    onStatusesChange: (nextStatuses: string[]) =>
      updatePreferences(current => ({ ...current, statuses: nextStatuses })),
    onAssigneesChange: (nextAssignees: string[]) =>
      updatePreferences(current => ({ ...current, assignees: nextAssignees })),
    onPrioritiesChange: (nextPriorities: string[]) =>
      updatePreferences(current => ({
        ...current,
        priorities: nextPriorities
      })),
    onExternalProjectsChange: (nextExternalProjects: string[]) =>
      updatePreferences(current => ({
        ...current,
        externalProjects: nextExternalProjects
      })),
    onLabelsChange: (nextLabels: string[]) =>
      updatePreferences(current => ({ ...current, labels: nextLabels })),
    onQueryChange: (nextQuery: string) =>
      updatePreferences(current => ({ ...current, query: nextQuery })),
    onViewChange: (nextView: TrackerView) =>
      updatePreferences(current => ({ ...current, view: nextView }))
  };
}
