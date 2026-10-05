import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type {
  ProjectBoardSettings,
  ProjectSourceConfig,
  WorkItem,
  WorkSource
} from './contract.js';
import {
  configuredProjectIds,
  ensureProjectConfig,
  projectBoardSettings,
  projectConfig,
  saveProjectBoardSettings,
  saveProjectConfig,
  selectedProjectIds
} from './store/config.js';
import { createStoreContext } from './store/context.js';
import {
  clearSource,
  getItem,
  listItems,
  replaceSource,
  setSourceError,
  syncState,
  upsertItem
} from './store/items.js';
import { MIGRATIONS } from './store/migrations.js';
import {
  deleteFilterPreset,
  listFilterPresets,
  reorderFilterPresets,
  saveFilterPreset,
  type SaveFilterPresetInput
} from './store/presets.js';
import type {
  ProjectSourceConfigDefaults,
  StoredSyncState,
  WorkItemFilters
} from './store/types.js';

export type {
  ProjectSourceConfigDefaults,
  StoredSyncState,
  WorkItemFilters
} from './store/types.js';

export function createWorkItemStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const context = createStoreContext(db);

  return {
    upsert(item: WorkItem) {
      upsertItem(context, item);
    },
    replaceSource(
      projectId: string,
      source: WorkSource,
      items: WorkItem[],
      syncedAt: string
    ) {
      replaceSource(context, projectId, source, items, syncedAt);
    },
    setSourceError(projectId: string, source: WorkSource, message: string) {
      setSourceError(context, projectId, source, message);
    },
    syncState(projectId: string, source: WorkSource): StoredSyncState {
      return syncState(context, projectId, source);
    },
    clearSource(projectId: string, source: WorkSource) {
      clearSource(context, projectId, source);
    },
    get(
      projectId: string,
      source: WorkSource,
      locator: string
    ): WorkItem | undefined {
      return getItem(context, projectId, source, locator);
    },
    list(filters: WorkItemFilters): WorkItem[] {
      return listItems(context, filters);
    },
    projectConfig(
      projectId: string,
      defaults: ProjectSourceConfigDefaults
    ): ProjectSourceConfig {
      return projectConfig(context, projectId, defaults);
    },
    ensureProjectConfig(
      projectId: string,
      defaults: ProjectSourceConfigDefaults
    ): ProjectSourceConfig {
      return ensureProjectConfig(context, projectId, defaults);
    },
    saveProjectConfig(input: ProjectSourceConfig): ProjectSourceConfig {
      return saveProjectConfig(context, input);
    },
    projectBoardSettings(projectId: string): ProjectBoardSettings {
      return projectBoardSettings(context, projectId);
    },
    saveProjectBoardSettings(input: ProjectBoardSettings): ProjectBoardSettings {
      return saveProjectBoardSettings(context, input);
    },
    listFilterPresets(projectId: string) {
      return listFilterPresets(context, projectId);
    },
    saveFilterPreset(input: SaveFilterPresetInput) {
      return saveFilterPreset(context, input);
    },
    deleteFilterPreset(projectId: string, id: string) {
      return deleteFilterPreset(context, projectId, id);
    },
    reorderFilterPresets(projectId: string, ids: readonly string[]) {
      return reorderFilterPresets(context, projectId, ids);
    },
    configuredProjectIds(): string[] {
      return configuredProjectIds(context);
    },
    selectedProjectIds(source: WorkSource): string[] {
      return selectedProjectIds(context, source);
    }
  };
}

export type WorkItemStore = ReturnType<typeof createWorkItemStore>;
