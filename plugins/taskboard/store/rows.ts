import {
  filterPresetSchema,
  normalizePresetName,
  projectBoardSettingsSchema,
  projectSourceConfigSchema,
  workItemSchema,
  type FilterPreset,
  type ProjectBoardSettings,
  type ProjectSourceConfig,
  type WorkItem
} from '../contract.js';
import type {
  FilterPresetRow,
  ProjectBoardSettingsRow,
  ProjectConfigRow,
  WorkItemRow
} from './types.js';

export function itemFromRow(row: WorkItemRow): WorkItem {
  return workItemSchema.parse({
    bbProjectId: row.bb_project_id,
    source: row.source,
    locator: row.locator,
    key: row.item_key,
    title: row.title,
    description: row.description,
    url: row.url,
    status: row.status,
    stateCategory: row.state_category,
    priority: row.priority,
    assignee: row.assignee,
    project: row.project,
    labels: JSON.parse(row.labels_json),
    updatedAt: row.updated_at
  });
}

export function configFromRow(row: ProjectConfigRow): ProjectSourceConfig {
  return projectSourceConfigSchema.parse({
    projectId: row.bb_project_id,
    source: row.source,
    linearTeamKey: row.linear_team_key,
    jiraBaseUrl: row.jira_base_url,
    jiraEmail: row.jira_email,
    jiraJql: row.jira_jql
  });
}

export function boardSettingsFromRow(
  row: ProjectBoardSettingsRow
): ProjectBoardSettings {
  return projectBoardSettingsSchema.parse({
    projectId: row.bb_project_id,
    defaultView: row.default_view,
    enabledFilters: JSON.parse(row.enabled_filters_json),
    statusOrder: JSON.parse(row.status_order_json)
  });
}

export function filterPresetFromRow(
  row: FilterPresetRow
): FilterPreset | null {
  const state = parseJsonSafely(row.filters_json);
  if (state === undefined) return null;
  const parsed = filterPresetSchema.safeParse({
    id: row.id,
    projectId: row.bb_project_id,
    name: row.name,
    state,
    position: row.position
  });
  if (!parsed.success) return null;
  let normalizedName: string;
  try {
    normalizedName = normalizePresetName(parsed.data.name);
  } catch {
    return null;
  }
  if (
    parsed.data.id !== row.id ||
    parsed.data.projectId !== row.bb_project_id ||
    parsed.data.name !== row.name ||
    normalizedName !== row.name_normalized
  ) {
    return null;
  }
  return parsed.data;
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, character => `\\${character}`);
}

export function parseJsonSafely(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
