import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  type TrackerProject,
  type WorkItem,
  type WorkStateCategory
} from '../../contract.js';
import {
  ACROSS_PROJECTS_SCOPE,
  type BrowsePreferenceScope,
  browsePreferenceStore,
  projectBrowseScope,
  toggleGroupCollapsedOverride
} from '../../browse-preferences.js';
import {
  useBoardSettings,
  useBrowsePreferences
} from './use-list-preferences.js';
import {
  useProjectFilterPresets
} from '../filter-presets/use-project-filter-presets.js';
import {
  useMoveItemStatus,
  useQueryCommit,
  useWorkItems,
  useWorkItemsRefresh
} from './use-work-items.js';
import { ALL_SOURCES } from '../shared/constants.js';
import { useFacetOptions, useVisibleItems } from './use-list-view-model.js';
import {
  duplicateNames,
  groupItemsByProject,
  hasActiveListFilters,
  listStatusMessage,
  preferenceChangeHandlers
} from './list-model.js';
import { useApplyPreset, useSavePreset } from './use-list-presets.js';
import { TrackerFilterBar } from '../filters/filter-bar.js';
import { ListBody } from './list-body.js';
import { SavePresetDialog } from './save-preset-dialog.js';

export function TrackerList({
  projectId,
  projects,
  refreshGeneration,
  surfaceMode,
  onOpen
}: {
  projectId: string | null;
  projects: readonly TrackerProject[] | undefined;
  refreshGeneration: number;
  surfaceMode: 'full' | 'constrained';
  onOpen: (item: WorkItem) => void;
}) {
  const preferenceScope: BrowsePreferenceScope =
    projectId === null ? ACROSS_PROJECTS_SCOPE : projectBrowseScope(projectId);
  const { preferences, updatePreferences } =
    useBrowsePreferences(preferenceScope);
  const {
    source,
    stateCategories,
    statuses,
    assignees,
    priorities,
    externalProjects,
    labels,
    collapsedGroups,
    query,
    view
  } = preferences;
  const presetState = useProjectFilterPresets(projectId);
  const [committedQuery, setCommittedQuery] = useState(() => query.trim());
  const requestRevisionRef = useRef(0);
  const { boardSettings, boardSettingsReady } = useBoardSettings(
    projectId,
    preferenceScope
  );
  const stateFilterEnabled = boardSettings.enabledFilters.includes('state');
  const { items, setItems, error, authoritativeProvider, loadItems } =
    useWorkItems({
      projectId,
      source,
      committedQuery,
      stateFilterEnabled,
      stateCategories,
      defaultView: boardSettings.defaultView,
      boardSettingsReady,
      refreshGeneration,
      requestRevisionRef
    });
  useEffect(() => {
    if (projectId !== null && source !== ALL_SOURCES) {
      updatePreferences(current => ({ ...current, source: ALL_SOURCES }));
    }
  }, [projectId, source, updatePreferences]);
  useQueryCommit(query, setCommittedQuery, requestRevisionRef);
  useWorkItemsRefresh(projectId, loadItems);

  const projectsById = useMemo(
    () => new Map((projects ?? []).map(project => [project.id, project])),
    [projects]
  );
  const availableOptions = useFacetOptions({
    items,
    statusOrder: boardSettings.statusOrder,
    preferences,
    updatePreferences
  });
  const visibleItems = useVisibleItems(items, boardSettings, preferences);
  const acrossProjectGroups = useMemo(
    () => groupItemsByProject(projects, visibleItems),
    [projects, visibleItems]
  );
  const duplicateProjectNames = useMemo(() => duplicateNames(projects), [projects]);
  const filtered = hasActiveListFilters(
    projectId,
    preferences,
    boardSettings.enabledFilters,
    committedQuery
  );
  const clearFilters = () => {
    browsePreferenceStore.clearFilters(preferenceScope);
    setCommittedQuery('');
  };
  const toggleGroup = useCallback(
    (groupKey: string, category: WorkStateCategory) => {
      updatePreferences(current => ({
        ...current,
        collapsedGroups: toggleGroupCollapsedOverride(
          current.collapsedGroups,
          groupKey,
          category
        )
      }));
    },
    [updatePreferences]
  );
  const applyPreset = useApplyPreset(
    projectId,
    preferenceScope,
    authoritativeProvider
  );
  const savePreset = useSavePreset(
    projectId,
    preferences,
    authoritativeProvider,
    presetState.setAuthoritative
  );
  const moveItemStatus = useMoveItemStatus(setItems);

  return (
    <TooltipProvider delayDuration={180}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="tb-frame flex h-full min-h-0 w-full flex-col overflow-hidden">
          <TrackerFilterBar
            presets={projectId === null ? null : presetState.presets}
            presetsError={presetState.error}
            presetsRefreshError={presetState.refreshError}
            presetsLoading={presetState.loading}
            presetActionsReady={authoritativeProvider !== null}
            onApplyPreset={applyPreset}
            onRetryPresets={() =>
              void presetState.reload({
                background: presetState.presets.length > 0
              })
            }
            onSaveCurrentPreset={() => {
              savePreset.setPresetSaveError(null);
              savePreset.setPresetNameDraft('');
            }}
            source={projectId === null ? source : ALL_SOURCES}
            enabledFilters={boardSettings.enabledFilters}
            stateCategories={stateCategories}
            statuses={statuses}
            statusOptions={availableOptions.statuses}
            assignees={assignees}
            assigneeOptions={availableOptions.assignees}
            priorities={priorities}
            priorityOptions={availableOptions.priorities}
            externalProjects={externalProjects}
            projectOptions={availableOptions.externalProjects}
            labels={labels}
            labelOptions={availableOptions.labels}
            query={query}
            view={view}
            surfaceMode={surfaceMode}
            showSourceFilter={projectId === null}
            showViewToggle={projectId !== null}
            {...preferenceChangeHandlers(updatePreferences)}
            onClear={clearFilters}
          />
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {listStatusMessage(items, error, visibleItems.length, filtered)}
          </p>
          <div className="min-h-0 flex-1 overflow-y-auto @container">
            <ListBody
              projectId={projectId}
              items={items}
              visibleItems={visibleItems}
              boardSettingsReady={boardSettingsReady}
              statusOrder={boardSettings.statusOrder}
              error={error}
              view={view}
              surfaceMode={surfaceMode}
              filtered={filtered}
              searchActive={committedQuery.trim() !== ''}
              projectsById={projectsById}
              acrossProjectGroups={acrossProjectGroups}
              duplicateProjectNames={duplicateProjectNames}
              collapsedGroups={collapsedGroups}
              onToggleGroup={toggleGroup}
              onMove={moveItemStatus}
              onOpen={onOpen}
              onClear={clearFilters}
              onRetry={() => {
                setItems(undefined);
                void loadItems();
              }}
            />
          </div>
        </div>
      </div>
      <SavePresetDialog
        presetNameDraft={savePreset.presetNameDraft}
        setPresetNameDraft={savePreset.setPresetNameDraft}
        presetSaveError={savePreset.presetSaveError}
        setPresetSaveError={savePreset.setPresetSaveError}
        savingPreset={savePreset.savingPreset}
        onSave={savePreset.saveCurrentPreset}
      />
    </TooltipProvider>
  );
}
