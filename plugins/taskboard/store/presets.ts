import { randomUUID } from 'node:crypto';
import {
  FILTER_PRESET_LIMIT,
  FILTER_PRESET_PROJECT_STATE_BYTES_MAX,
  filterPresetIdSchema,
  filterPresetNameSchema,
  filterPresetOrderSchema,
  filterPresetProjectIdSchema,
  filterPresetStateSchema,
  normalizePresetName,
  resolvePresetOrder,
  serializeFilterPresetState,
  type FilterPreset
} from '../contract.js';
import type { StoreContext } from './context.js';
import { filterPresetFromRow } from './rows.js';
import type { FilterPresetRow } from './types.js';

export interface SaveFilterPresetInput {
  projectId: string;
  id?: string;
  name: string;
  state: FilterPreset['state'];
}

function visibleFilterPresets(
  context: StoreContext,
  projectId: string
): FilterPreset[] {
  return context.readFilterPresets
    .all(projectId)
    .map(filterPresetFromRow)
    .filter((preset): preset is FilterPreset => preset !== null)
    .slice(0, FILTER_PRESET_LIMIT);
}

function readSavedPreset(
  context: StoreContext,
  projectId: string,
  id: string
): FilterPreset {
  const row = context.readFilterPreset.get(projectId, id);
  const saved = row ? filterPresetFromRow(row) : null;
  if (!saved) {
    throw new Error('Saved filter preset could not be read back');
  }
  return saved;
}

function assertStateBytesWithinLimit(
  context: StoreContext,
  projectId: string,
  id: string | undefined,
  serializedState: string
): void {
  const existingStateBytes = id
    ? (context.readFilterPresetStateBytesExcluding.get(projectId, id)
        ?.total_bytes ?? 0)
    : (context.readFilterPresetStateBytes.get(projectId)?.total_bytes ?? 0);
  const nextStateBytes = new TextEncoder().encode(serializedState).byteLength;
  if (
    existingStateBytes + nextStateBytes >
    FILTER_PRESET_PROJECT_STATE_BYTES_MAX
  ) {
    throw new Error(
      `Filter presets for this project exceed the ${FILTER_PRESET_PROJECT_STATE_BYTES_MAX}-byte limit`
    );
  }
}

function assertNameAvailable(
  { db }: StoreContext,
  projectId: string,
  normalized: string,
  id: string | undefined
): void {
  const conflict = db
    .prepare<[string, string], { id: string; name: string }>(
      `
      SELECT id, name
      FROM project_filter_presets
      WHERE bb_project_id = ? AND name_normalized = ?
    `
    )
    .get(projectId, normalized);
  if (conflict && conflict.id !== id) {
    throw new Error(`A filter preset named "${conflict.name}" already exists`);
  }
}

function renumberRows(
  { db }: StoreContext,
  projectId: string,
  rows: FilterPresetRow[],
  now: string
): void {
  const updatePosition = db.prepare<[number, string, string, string]>(
    `
    UPDATE project_filter_presets
    SET position = ?, updated_at = ?
    WHERE bb_project_id = ? AND id = ?
  `
  );
  rows.forEach((row, index) => {
    if (row.position === index) return;
    updatePosition.run(index, now, projectId, row.id);
  });
}

function updatePreset(
  context: StoreContext,
  id: string,
  fields: { projectId: string; name: string; normalized: string },
  serializedState: string,
  now: string
): FilterPreset {
  const { projectId, name, normalized } = fields;
  if (!context.readFilterPreset.get(projectId, id)) {
    throw new Error(`Unknown filter preset: ${id}`);
  }
  context.db
    .prepare<[string, string, string, string, string, string]>(
      `
      UPDATE project_filter_presets
      SET name = ?, name_normalized = ?, filters_json = ?, updated_at = ?
      WHERE bb_project_id = ? AND id = ?
    `
    )
    .run(name, normalized, serializedState, now, projectId, id);
  return readSavedPreset(context, projectId, id);
}

function insertPreset(
  context: StoreContext,
  fields: { projectId: string; name: string; normalized: string },
  serializedState: string,
  now: string
): FilterPreset {
  const { projectId, name, normalized } = fields;
  const rows = context.readFilterPresets.all(projectId);
  if (rows.length >= FILTER_PRESET_LIMIT) {
    throw new Error(
      `A project can have at most ${FILTER_PRESET_LIMIT} filter presets`
    );
  }
  renumberRows(context, projectId, rows, now);
  const newId = filterPresetIdSchema.parse(
    `fp_${randomUUID().replaceAll('-', '')}`
  );
  context.db
    .prepare<[string, string, string, string, string, number, string, string]>(
      `
      INSERT INTO project_filter_presets (
        id, bb_project_id, name, name_normalized, filters_json, position,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
    )
    .run(
      newId,
      projectId,
      name,
      normalized,
      serializedState,
      rows.length,
      now,
      now
    );
  return readSavedPreset(context, projectId, newId);
}

export function listFilterPresets(
  context: StoreContext,
  projectId: string
): FilterPreset[] {
  const parsedProjectId = filterPresetProjectIdSchema.parse(projectId);
  return visibleFilterPresets(context, parsedProjectId);
}

export function saveFilterPreset(
  context: StoreContext,
  input: SaveFilterPresetInput
): FilterPreset {
  const projectId = filterPresetProjectIdSchema.parse(input.projectId);
  const id = input.id ? filterPresetIdSchema.parse(input.id) : undefined;
  const name = filterPresetNameSchema.parse(input.name);
  const normalized = normalizePresetName(name);
  const state = filterPresetStateSchema.parse(input.state);
  const serializedState = serializeFilterPresetState(state);
  const now = new Date().toISOString();
  const fields = { projectId, name, normalized };

  return context.db.transaction(() => {
    assertStateBytesWithinLimit(context, projectId, id, serializedState);
    assertNameAvailable(context, projectId, normalized, id);
    return id
      ? updatePreset(context, id, fields, serializedState, now)
      : insertPreset(context, fields, serializedState, now);
  })();
}

// Deleting an unknown id is a deliberate no-op, unlike saveFilterPreset
// and reorderFilterPresets which throw. Delete is idempotent, and the
// callers resync from the returned list rather than trusting a local
// delta, so a stale id produces no visible inconsistency.
export function deleteFilterPreset(
  context: StoreContext,
  projectId: string,
  id: string
): FilterPreset[] {
  const parsedProjectId = filterPresetProjectIdSchema.parse(projectId);
  const parsedId = filterPresetIdSchema.parse(id);
  return context.db.transaction(() => {
    const deletion = context.db
      .prepare<[string, string]>(
        `DELETE FROM project_filter_presets
         WHERE bb_project_id = ? AND id = ?`
      )
      .run(parsedProjectId, parsedId);
    if (deletion.changes === 0) {
      return visibleFilterPresets(context, parsedProjectId);
    }
    // Renumber every remaining row, including any that fail to parse:
    // an unreadable row is invisible to clients but still occupies a
    // position, so leaving it out here would let it collide with a
    // visible row forever instead of just until the next delete.
    const remaining = context.readFilterPresets.all(parsedProjectId);
    if (remaining.length > FILTER_PRESET_LIMIT) {
      return visibleFilterPresets(context, parsedProjectId);
    }
    renumberRows(context, parsedProjectId, remaining, new Date().toISOString());
    return visibleFilterPresets(context, parsedProjectId);
  })();
}

export function reorderFilterPresets(
  context: StoreContext,
  projectId: string,
  ids: readonly string[]
): FilterPreset[] {
  const parsedProjectId = filterPresetProjectIdSchema.parse(projectId);
  const parsedIds = filterPresetOrderSchema.parse(ids);
  return context.db.transaction(() => {
    const rows = context.readFilterPresets.all(parsedProjectId);
    if (rows.length > FILTER_PRESET_LIMIT) {
      throw new Error('Stored filter preset limit exceeded');
    }
    // A client can only ever request an order for presets it was
    // shown, and listFilterPresets hides rows that fail to parse. So
    // validate against, and renumber, only the parseable subset —
    // otherwise one corrupt row permanently blocks every reorder for
    // this project, since resolvePresetOrder demands an exact
    // permutation of every stored id. An unreadable row keeps its old
    // position and may end up sharing it with a visible row; that is
    // harmless because the corrupt row is never displayed, and the
    // next delete renumbers every row (visible or not) contiguously
    // from 0 anyway.
    const currentIds = rows
      .filter(row => filterPresetFromRow(row) !== null)
      .map(row => row.id);
    const ordered = resolvePresetOrder(currentIds, parsedIds);
    const positionById = new Map(rows.map(row => [row.id, row.position]));
    const now = new Date().toISOString();
    const updatePosition = context.db.prepare<[number, string, string, string]>(
      `
      UPDATE project_filter_presets
      SET position = ?, updated_at = ?
      WHERE bb_project_id = ? AND id = ?
    `
    );
    ordered.forEach((id, index) => {
      if (positionById.get(id) === index) return;
      updatePosition.run(index, now, parsedProjectId, id);
    });
    return visibleFilterPresets(context, parsedProjectId);
  })();
}
