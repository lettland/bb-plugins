import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type Database from 'better-sqlite3';
import {
  FILTER_PRESET_LIMIT,
  workItemSchema,
  type WorkItem,
  type WorkSource
} from '../contract.js';
import type {
  FilterPresetRow,
  ProjectBoardSettingsRow,
  ProjectConfigRow
} from './types.js';

type UpsertItemStatement = Database.Statement<
  [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string | null,
    string | null,
    string | null,
    string,
    string
  ]
>;

type TotalBytesRow = { total_bytes: number };

export interface StoreContext {
  db: ReturnType<BbPluginApi['storage']['database']>;
  upsertItem: UpsertItemStatement;
  replaceSourceTransaction: Database.Transaction<
    (
      projectId: string,
      source: WorkSource,
      items: WorkItem[],
      syncedAt: string
    ) => void
  >;
  clearSourceTransaction: Database.Transaction<
    (projectId: string, source: WorkSource) => void
  >;
  readProjectConfig: Database.Statement<[string], ProjectConfigRow>;
  readProjectBoardSettings: Database.Statement<
    [string],
    ProjectBoardSettingsRow
  >;
  readFilterPresets: Database.Statement<[string], FilterPresetRow>;
  readFilterPreset: Database.Statement<[string, string], FilterPresetRow>;
  readFilterPresetStateBytes: Database.Statement<[string], TotalBytesRow>;
  readFilterPresetStateBytesExcluding: Database.Statement<
    [string, string],
    TotalBytesRow
  >;
}

type StoreDatabase = StoreContext['db'];

export function writeItem(
  upsertItem: UpsertItemStatement,
  item: WorkItem
): void {
  const parsed = workItemSchema.parse(item);
  upsertItem.run(
    parsed.bbProjectId,
    parsed.source,
    parsed.locator,
    parsed.key,
    parsed.title,
    parsed.description,
    parsed.url,
    parsed.status,
    parsed.stateCategory,
    parsed.priority,
    parsed.assignee,
    parsed.project,
    JSON.stringify(parsed.labels),
    parsed.updatedAt
  );
}

function prepareUpsertItem(db: StoreDatabase): UpsertItemStatement {
  return db.prepare(`
    INSERT INTO work_items_by_project (
      bb_project_id, source, locator, item_key, title, description, url,
      status, state_category, priority, assignee, project, labels_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bb_project_id, source, locator) DO UPDATE SET
      item_key = excluded.item_key,
      title = excluded.title,
      description = excluded.description,
      url = excluded.url,
      status = excluded.status,
      state_category = excluded.state_category,
      priority = excluded.priority,
      assignee = excluded.assignee,
      project = excluded.project,
      labels_json = excluded.labels_json,
      updated_at = excluded.updated_at
  `);
}

function createTransactions(
  db: StoreDatabase,
  upsertItem: UpsertItemStatement
): Pick<StoreContext, 'replaceSourceTransaction' | 'clearSourceTransaction'> {
  const replaceSourceTransaction = db.transaction(
    (
      projectId: string,
      source: WorkSource,
      items: WorkItem[],
      syncedAt: string
    ) => {
      db.prepare<[string, WorkSource]>(
        'DELETE FROM work_items_by_project WHERE bb_project_id = ? AND source = ?'
      ).run(projectId, source);
      for (const item of items) writeItem(upsertItem, item);
      db.prepare<[string, WorkSource, string, number]>(
        `
        INSERT INTO source_sync_by_project (
          bb_project_id, source, last_synced_at, error, item_count
        ) VALUES (?, ?, ?, NULL, ?)
        ON CONFLICT(bb_project_id, source) DO UPDATE SET
          last_synced_at = excluded.last_synced_at,
          error = NULL,
          item_count = excluded.item_count
      `
      ).run(projectId, source, syncedAt, items.length);
    }
  );
  const clearSourceTransaction = db.transaction(
    (projectId: string, source: WorkSource) => {
      db.prepare<[string, WorkSource]>(
        'DELETE FROM work_items_by_project WHERE bb_project_id = ? AND source = ?'
      ).run(projectId, source);
      db.prepare<[string, WorkSource]>(
        'DELETE FROM source_sync_by_project WHERE bb_project_id = ? AND source = ?'
      ).run(projectId, source);
    }
  );
  return { replaceSourceTransaction, clearSourceTransaction };
}

function prepareReadStatements(
  db: StoreDatabase
): Omit<
  StoreContext,
  'db' | 'upsertItem' | 'replaceSourceTransaction' | 'clearSourceTransaction'
> {
  return {
    readProjectConfig: db.prepare<[string], ProjectConfigRow>(`
      SELECT
        bb_project_id,
        source,
        linear_team_key,
        jira_base_url,
        jira_email,
        jira_jql
      FROM project_source_config
      WHERE bb_project_id = ?
    `),
    readProjectBoardSettings: db.prepare<[string], ProjectBoardSettingsRow>(`
      SELECT
        bb_project_id,
        default_view,
        enabled_filters_json,
        status_order_json
      FROM project_board_settings
      WHERE bb_project_id = ?
    `),
    readFilterPresets: db.prepare<[string], FilterPresetRow>(`
      SELECT
        id, bb_project_id, name, name_normalized, filters_json, position
      FROM project_filter_presets
      WHERE bb_project_id = ?
      ORDER BY position ASC, created_at ASC, id ASC
      LIMIT ${FILTER_PRESET_LIMIT + 1}
    `),
    readFilterPreset: db.prepare<[string, string], FilterPresetRow>(`
      SELECT
        id, bb_project_id, name, name_normalized, filters_json, position
      FROM project_filter_presets
      WHERE bb_project_id = ? AND id = ?
    `),
    readFilterPresetStateBytes: db.prepare<[string], TotalBytesRow>(`
      SELECT COALESCE(SUM(length(CAST(filters_json AS BLOB))), 0) AS total_bytes
      FROM project_filter_presets
      WHERE bb_project_id = ?
    `),
    readFilterPresetStateBytesExcluding: db.prepare<
      [string, string],
      TotalBytesRow
    >(`
      SELECT COALESCE(SUM(length(CAST(filters_json AS BLOB))), 0) AS total_bytes
      FROM project_filter_presets
      WHERE bb_project_id = ? AND id <> ?
    `)
  };
}

export function createStoreContext(db: StoreDatabase): StoreContext {
  const upsertItem = prepareUpsertItem(db);
  return {
    db,
    upsertItem,
    ...createTransactions(db, upsertItem),
    ...prepareReadStatements(db)
  };
}
