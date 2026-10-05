import type {
  ProjectSourceConfig,
  WorkSource,
  WorkStateCategory
} from '../contract.js';

export type SqlParameter = string | number | null;

export interface WorkItemRow {
  bb_project_id: string;
  source: string;
  locator: string;
  item_key: string;
  title: string;
  description: string;
  url: string;
  status: string;
  state_category: string;
  priority: string | null;
  assignee: string | null;
  project: string | null;
  labels_json: string;
  updated_at: string;
}

export interface SyncRow {
  bb_project_id: string;
  source: string;
  last_synced_at: string | null;
  error: string | null;
  item_count: number;
}

export interface ProjectConfigRow {
  bb_project_id: string;
  source: string;
  linear_team_key: string;
  jira_base_url: string;
  jira_email: string;
  jira_jql: string;
}

export interface ProjectBoardSettingsRow {
  bb_project_id: string;
  default_view: string;
  enabled_filters_json: string;
  status_order_json: string;
}

export interface FilterPresetRow {
  id: string;
  bb_project_id: string;
  name: string;
  name_normalized: string;
  filters_json: string;
  position: number;
}

export interface StoredSyncState {
  lastSyncedAt: string | null;
  error: string | null;
  itemCount: number;
}

export interface WorkItemFilters {
  /** Omit to search every project cache. */
  projectId?: string;
  /** Internal allowlist for intentional cross-project views. */
  projectIds?: string[];
  source?: WorkSource;
  query?: string;
  stateCategories?: WorkStateCategory[];
  limit: number;
}

export type ProjectSourceConfigDefaults = Omit<
  ProjectSourceConfig,
  'projectId'
>;
