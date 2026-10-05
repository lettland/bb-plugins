import {
  defaultProjectBoardSettings,
  projectBoardSettingsSchema,
  projectSourceConfigSchema,
  type ProjectBoardSettings,
  type ProjectSourceConfig,
  type WorkSource
} from '../contract.js';
import type { StoreContext } from './context.js';
import { boardSettingsFromRow, configFromRow } from './rows.js';
import type { ProjectSourceConfigDefaults } from './types.js';

type ProjectConfigParameters = [
  string,
  WorkSource,
  string,
  string,
  string,
  string,
  string
];

function defaultConfig(
  projectId: string,
  defaults: ProjectSourceConfigDefaults
): ProjectSourceConfig {
  return projectSourceConfigSchema.parse({ projectId, ...defaults });
}

function projectConfigParameters(
  config: ProjectSourceConfig
): ProjectConfigParameters {
  return [
    config.projectId,
    config.source,
    config.linearTeamKey,
    config.jiraBaseUrl,
    config.jiraEmail,
    config.jiraJql,
    new Date().toISOString()
  ];
}

export function projectConfig(
  context: StoreContext,
  projectId: string,
  defaults: ProjectSourceConfigDefaults
): ProjectSourceConfig {
  const row = context.readProjectConfig.get(projectId);
  return row ? configFromRow(row) : defaultConfig(projectId, defaults);
}

export function ensureProjectConfig(
  { db, readProjectConfig }: StoreContext,
  projectId: string,
  defaults: ProjectSourceConfigDefaults
): ProjectSourceConfig {
  const config = defaultConfig(projectId, defaults);
  db.prepare<ProjectConfigParameters>(
    `
    INSERT INTO project_source_config (
      bb_project_id, source, linear_team_key, jira_base_url, jira_email,
      jira_jql, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bb_project_id) DO NOTHING
  `
  ).run(...projectConfigParameters(config));
  return configFromRow(readProjectConfig.get(projectId)!);
}

export function saveProjectConfig(
  { db, readProjectConfig }: StoreContext,
  input: ProjectSourceConfig
): ProjectSourceConfig {
  const config = projectSourceConfigSchema.parse(input);
  return db.transaction(() => {
    const previous = readProjectConfig.get(config.projectId);
    db.prepare<ProjectConfigParameters>(
      `
      INSERT INTO project_source_config (
        bb_project_id, source, linear_team_key, jira_base_url, jira_email,
        jira_jql, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bb_project_id) DO UPDATE SET
        source = excluded.source,
        linear_team_key = excluded.linear_team_key,
        jira_base_url = excluded.jira_base_url,
        jira_email = excluded.jira_email,
        jira_jql = excluded.jira_jql,
        updated_at = excluded.updated_at
    `
    ).run(...projectConfigParameters(config));
    if (previous && previous.source !== config.source) {
      db.prepare<[string]>(
        'DELETE FROM work_items_by_project WHERE bb_project_id = ?'
      ).run(config.projectId);
      db.prepare<[string]>(
        'DELETE FROM source_sync_by_project WHERE bb_project_id = ?'
      ).run(config.projectId);
    } else {
      db.prepare<[string, WorkSource]>(
        'DELETE FROM work_items_by_project WHERE bb_project_id = ? AND source <> ?'
      ).run(config.projectId, config.source);
      db.prepare<[string, WorkSource]>(
        'DELETE FROM source_sync_by_project WHERE bb_project_id = ? AND source <> ?'
      ).run(config.projectId, config.source);
    }
    return configFromRow(readProjectConfig.get(config.projectId)!);
  })();
}

export function projectBoardSettings(
  { readProjectBoardSettings }: StoreContext,
  projectId: string
): ProjectBoardSettings {
  const row = readProjectBoardSettings.get(projectId);
  return row
    ? boardSettingsFromRow(row)
    : defaultProjectBoardSettings(projectId);
}

export function saveProjectBoardSettings(
  { db, readProjectBoardSettings }: StoreContext,
  input: ProjectBoardSettings
): ProjectBoardSettings {
  const settings = projectBoardSettingsSchema.parse(input);
  db.prepare<[string, string, string, string, string]>(
    `
    INSERT INTO project_board_settings (
      bb_project_id, default_view, enabled_filters_json, status_order_json,
      updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bb_project_id) DO UPDATE SET
      default_view = excluded.default_view,
      enabled_filters_json = excluded.enabled_filters_json,
      status_order_json = excluded.status_order_json,
      updated_at = excluded.updated_at
  `
  ).run(
    settings.projectId,
    settings.defaultView,
    JSON.stringify(settings.enabledFilters),
    JSON.stringify(settings.statusOrder),
    new Date().toISOString()
  );
  return boardSettingsFromRow(
    readProjectBoardSettings.get(settings.projectId)!
  );
}

export function configuredProjectIds({ db }: StoreContext): string[] {
  return db
    .prepare<[], { bb_project_id: string }>(
      `
      SELECT bb_project_id
      FROM project_source_config
      ORDER BY bb_project_id
    `
    )
    .all()
    .map(row => row.bb_project_id);
}

export function selectedProjectIds(
  { db }: StoreContext,
  source: WorkSource
): string[] {
  return db
    .prepare<[WorkSource], { bb_project_id: string }>(
      `
      SELECT bb_project_id
      FROM project_source_config
      WHERE source = ?
      ORDER BY bb_project_id
    `
    )
    .all(source)
    .map(row => row.bb_project_id);
}
