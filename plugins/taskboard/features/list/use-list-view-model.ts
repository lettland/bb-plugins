import { useEffect, useMemo } from 'react';
import { type WorkItem } from '../../contract.js';
import { type ProjectBoardSettings } from '../../board-settings.js';
import {
  assigneeFilterOptions,
  filterWorkItemsByAttributes,
  labelFilterOptions,
  priorityFilterOptions,
  projectFilterOptions,
  sortWorkItemsByWorkflow,
  statusFilterOptions
} from '../../browse.js';
import { type BrowsePreferences } from '../../browse-preferences.js';
import {
  type BrowsePreferenceUpdater,
  canonicalizeFacetSelections,
  enabledSelection,
  type FacetOptionSets
} from './list-model.js';

export function useFacetOptions({
  items,
  statusOrder,
  preferences,
  updatePreferences
}: {
  items: readonly WorkItem[] | undefined;
  statusOrder: readonly string[];
  preferences: BrowsePreferences;
  updatePreferences: BrowsePreferenceUpdater;
}): FacetOptionSets {
  const { statuses, assignees, priorities, externalProjects, labels } =
    preferences;
  const availableAssignees = useMemo(
    () => assigneeFilterOptions(items ?? [], assignees),
    [assignees, items]
  );
  const availableStatuses = useMemo(
    () => statusFilterOptions(items ?? [], statuses, statusOrder),
    [statusOrder, items, statuses]
  );
  const availablePriorities = useMemo(
    () => priorityFilterOptions(items ?? [], priorities),
    [items, priorities]
  );
  const availableExternalProjects = useMemo(
    () => projectFilterOptions(items ?? [], externalProjects),
    [externalProjects, items]
  );
  const availableLabels = useMemo(
    () => labelFilterOptions(items ?? [], labels),
    [items, labels]
  );
  useEffect(() => {
    updatePreferences(current =>
      canonicalizeFacetSelections(current, {
        statuses: availableStatuses,
        assignees: availableAssignees,
        priorities: availablePriorities,
        externalProjects: availableExternalProjects,
        labels: availableLabels
      })
    );
  }, [
    availableAssignees,
    availableExternalProjects,
    availableLabels,
    availablePriorities,
    availableStatuses,
    updatePreferences
  ]);
  return {
    statuses: availableStatuses,
    assignees: availableAssignees,
    priorities: availablePriorities,
    externalProjects: availableExternalProjects,
    labels: availableLabels
  };
}

export function useVisibleItems(
  items: readonly WorkItem[] | undefined,
  boardSettings: ProjectBoardSettings,
  preferences: BrowsePreferences
): WorkItem[] {
  const { statuses, assignees, priorities, externalProjects, labels } =
    preferences;
  return useMemo(
    () =>
      sortWorkItemsByWorkflow(
        filterWorkItemsByAttributes(items ?? [], {
          statuses: enabledSelection(
            boardSettings.enabledFilters,
            'status',
            statuses
          ),
          assignees: enabledSelection(
            boardSettings.enabledFilters,
            'assignee',
            assignees
          ),
          priorities: enabledSelection(
            boardSettings.enabledFilters,
            'priority',
            priorities
          ),
          projects: enabledSelection(
            boardSettings.enabledFilters,
            'project',
            externalProjects
          ),
          labels: enabledSelection(boardSettings.enabledFilters, 'labels', labels)
        }),
        boardSettings.statusOrder
      ),
    [
      assignees,
      boardSettings.enabledFilters,
      boardSettings.statusOrder,
      externalProjects,
      items,
      labels,
      priorities,
      statuses
    ]
  );
}
