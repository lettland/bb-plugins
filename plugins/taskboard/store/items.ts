import type { WorkItem, WorkSource } from '../contract.js';
import { writeItem, type StoreContext } from './context.js';
import { escapeLike, itemFromRow } from './rows.js';
import type {
  SqlParameter,
  StoredSyncState,
  SyncRow,
  WorkItemFilters,
  WorkItemRow
} from './types.js';

export function upsertItem(context: StoreContext, item: WorkItem): void {
  writeItem(context.upsertItem, item);
}

export function replaceSource(
  context: StoreContext,
  projectId: string,
  source: WorkSource,
  items: WorkItem[],
  syncedAt: string
): void {
  for (const item of items) {
    if (item.bbProjectId !== projectId || item.source !== source) {
      throw new Error(
        'Cannot write a work item outside its BB project and source scope'
      );
    }
  }
  context.replaceSourceTransaction(projectId, source, items, syncedAt);
}

export function setSourceError(
  { db }: StoreContext,
  projectId: string,
  source: WorkSource,
  message: string
): void {
  const count =
    db
      .prepare<
        [string, WorkSource],
        { count: number }
      >('SELECT COUNT(*) AS count FROM work_items_by_project WHERE bb_project_id = ? AND source = ?')
      .get(projectId, source)?.count ?? 0;
  db.prepare<[string, WorkSource, string, number]>(
    `
    INSERT INTO source_sync_by_project (
      bb_project_id, source, last_synced_at, error, item_count
    ) VALUES (?, ?, NULL, ?, ?)
    ON CONFLICT(bb_project_id, source) DO UPDATE SET
      error = excluded.error,
      item_count = excluded.item_count
  `
  ).run(projectId, source, message, count);
}

export function syncState(
  { db }: StoreContext,
  projectId: string,
  source: WorkSource
): StoredSyncState {
  const row = db
    .prepare<[string, WorkSource], SyncRow>(
      `
      SELECT *
      FROM source_sync_by_project
      WHERE bb_project_id = ? AND source = ?
    `
    )
    .get(projectId, source);
  return {
    lastSyncedAt: row?.last_synced_at ?? null,
    error: row?.error ?? null,
    itemCount: row?.item_count ?? 0
  };
}

export function clearSource(
  context: StoreContext,
  projectId: string,
  source: WorkSource
): void {
  context.clearSourceTransaction(projectId, source);
}

export function getItem(
  { db }: StoreContext,
  projectId: string,
  source: WorkSource,
  locator: string
): WorkItem | undefined {
  const row = db
    .prepare<[string, WorkSource, string], WorkItemRow>(
      `
      SELECT *
      FROM work_items_by_project
      WHERE bb_project_id = ? AND source = ? AND locator = ?
    `
    )
    .get(projectId, source, locator);
  return row ? itemFromRow(row) : undefined;
}

export function listItems(
  { db }: StoreContext,
  filters: WorkItemFilters
): WorkItem[] {
  const query = filters.query?.trim() ?? '';
  const states = filters.stateCategories ?? [];
  const parameters: Record<string, SqlParameter> = {
    projectId: filters.projectId ?? null,
    projectIds: JSON.stringify(filters.projectIds ?? []),
    projectIdsSpecified: filters.projectIds === undefined ? 0 : 1,
    source: filters.source ?? null,
    query: query ? `%${escapeLike(query)}%` : '',
    states: JSON.stringify(states),
    stateCount: states.length,
    limit: filters.limit
  };
  return db
    .prepare<Record<string, SqlParameter>, WorkItemRow>(
      `
      SELECT *
      FROM work_items_by_project AS item
      WHERE item.source = COALESCE(
          (
            SELECT config.source
            FROM project_source_config AS config
            WHERE config.bb_project_id = item.bb_project_id
          ),
          'github'
        )
        AND (:projectId IS NULL OR item.bb_project_id = :projectId)
        AND (
          :projectIdsSpecified = 0 OR
          item.bb_project_id IN (SELECT value FROM json_each(:projectIds))
        )
        AND (:source IS NULL OR item.source = :source)
        AND (
          :query = '' OR
          item.item_key LIKE :query ESCAPE '\\' COLLATE NOCASE OR
          item.title LIKE :query ESCAPE '\\' COLLATE NOCASE OR
          item.description LIKE :query ESCAPE '\\' COLLATE NOCASE OR
          item.project LIKE :query ESCAPE '\\' COLLATE NOCASE
        )
        AND (
          :stateCount = 0 OR
          item.state_category IN (SELECT value FROM json_each(:states))
        )
      ORDER BY item.updated_at DESC, item.bb_project_id, item.source, item.locator
      LIMIT :limit
    `
    )
    .all(parameters)
    .map(itemFromRow);
}
