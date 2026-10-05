const WORK_ITEM_COLUMNS = `source TEXT NOT NULL CHECK (source IN ('linear', 'github', 'jira')),
        locator TEXT NOT NULL,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        state_category TEXT NOT NULL CHECK (
          state_category IN ('backlog', 'todo', 'in_progress', 'done', 'canceled')
        ),
        priority TEXT,
        assignee TEXT,
        project TEXT,
        labels_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,`;

export const MIGRATIONS = [
    `
      CREATE TABLE work_items (
        ${WORK_ITEM_COLUMNS}
        PRIMARY KEY (source, locator)
      );

      CREATE TABLE source_sync (
        source TEXT PRIMARY KEY CHECK (source IN ('linear', 'github', 'jira')),
        last_synced_at TEXT,
        error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0)
      );

      CREATE INDEX idx_work_items_updated
        ON work_items(updated_at DESC, source, locator);
      CREATE INDEX idx_work_items_source_state_updated
        ON work_items(source, state_category, updated_at DESC, locator);
      CREATE INDEX idx_work_items_key
        ON work_items(item_key COLLATE NOCASE);
    `,
    `
      CREATE TABLE work_items_by_project (
        bb_project_id TEXT NOT NULL,
        ${WORK_ITEM_COLUMNS}
        PRIMARY KEY (bb_project_id, source, locator)
      );

      CREATE TABLE source_sync_by_project (
        bb_project_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('linear', 'github', 'jira')),
        last_synced_at TEXT,
        error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
        PRIMARY KEY (bb_project_id, source)
      );

      CREATE TABLE project_source_config (
        bb_project_id TEXT PRIMARY KEY,
        github_enabled INTEGER NOT NULL CHECK (github_enabled IN (0, 1)),
        linear_team_key TEXT NOT NULL,
        jira_jql TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_project_work_items_updated
        ON work_items_by_project(bb_project_id, updated_at DESC, source, locator);
      CREATE INDEX idx_project_work_items_source_state_updated
        ON work_items_by_project(
          bb_project_id, source, state_category, updated_at DESC, locator
        );
      CREATE INDEX idx_project_work_items_key
        ON work_items_by_project(bb_project_id, item_key COLLATE NOCASE);
    `,
    `
      ALTER TABLE project_source_config
        ADD COLUMN linear_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (linear_enabled IN (0, 1));
      ALTER TABLE project_source_config
        ADD COLUMN jira_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (jira_enabled IN (0, 1));

      CREATE INDEX idx_all_project_work_items_updated
        ON work_items_by_project(updated_at DESC, bb_project_id, source, locator);

      DROP TABLE work_items;
      DROP TABLE source_sync;
    `,
    `
      ALTER TABLE project_source_config
        ADD COLUMN jira_base_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE project_source_config
        ADD COLUMN jira_email TEXT NOT NULL DEFAULT '';

      CREATE INDEX idx_project_source_linear_enabled
        ON project_source_config(linear_enabled, bb_project_id);
      CREATE INDEX idx_project_source_jira_enabled
        ON project_source_config(jira_enabled, bb_project_id);
    `,
    `
      CREATE TABLE project_source_config_next (
        bb_project_id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK (source IN ('linear', 'github', 'jira')),
        linear_team_key TEXT NOT NULL,
        jira_base_url TEXT NOT NULL,
        jira_email TEXT NOT NULL,
        jira_jql TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO project_source_config_next (
        bb_project_id, source, linear_team_key, jira_base_url, jira_email,
        jira_jql, updated_at
      )
      SELECT
        config.bb_project_id,
        CASE
          WHEN config.github_enabled + config.linear_enabled + config.jira_enabled = 0
            THEN 'github'
          WHEN config.github_enabled + config.linear_enabled + config.jira_enabled = 1
            THEN CASE
              WHEN config.jira_enabled = 1 THEN 'jira'
              WHEN config.linear_enabled = 1 THEN 'linear'
              ELSE 'github'
            END
          ELSE COALESCE(
            (
              SELECT candidate.source
              FROM (
                SELECT 'github' AS source, 1 AS priority
                UNION ALL SELECT 'linear', 2
                UNION ALL SELECT 'jira', 3
              ) AS candidate
              LEFT JOIN source_sync_by_project AS sync
                ON sync.bb_project_id = config.bb_project_id
                AND sync.source = candidate.source
              WHERE CASE candidate.source
                WHEN 'github' THEN config.github_enabled
                WHEN 'linear' THEN config.linear_enabled
                ELSE config.jira_enabled
              END = 1
              ORDER BY
                sync.last_synced_at IS NULL ASC,
                sync.last_synced_at DESC,
                candidate.priority DESC
              LIMIT 1
            ),
            CASE
              WHEN config.jira_enabled = 1 THEN 'jira'
              WHEN config.linear_enabled = 1 THEN 'linear'
              ELSE 'github'
            END
          )
        END,
        config.linear_team_key,
        config.jira_base_url,
        config.jira_email,
        config.jira_jql,
        config.updated_at
      FROM project_source_config AS config;

      DELETE FROM work_items_by_project
      WHERE EXISTS (
        SELECT 1
        FROM project_source_config_next AS config
        WHERE config.bb_project_id = work_items_by_project.bb_project_id
          AND config.source <> work_items_by_project.source
      );

      DELETE FROM source_sync_by_project
      WHERE EXISTS (
        SELECT 1
        FROM project_source_config_next AS config
        WHERE config.bb_project_id = source_sync_by_project.bb_project_id
          AND config.source <> source_sync_by_project.source
      );

      DROP TABLE project_source_config;
      ALTER TABLE project_source_config_next RENAME TO project_source_config;

      CREATE INDEX idx_project_source_selected
        ON project_source_config(source, bb_project_id);
    `,
    `
      CREATE TABLE project_board_settings (
        bb_project_id TEXT PRIMARY KEY,
        default_view TEXT NOT NULL CHECK (default_view IN ('list', 'kanban')),
        enabled_filters_json TEXT NOT NULL,
        status_order_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
    `
      CREATE TABLE project_filter_presets (
        id TEXT NOT NULL PRIMARY KEY
          CHECK (length(id) BETWEEN 1 AND 100),
        bb_project_id TEXT NOT NULL
          CHECK (
            substr(bb_project_id, 1, 5) = 'proj_' AND
            length(bb_project_id) BETWEEN 6 AND 500
          ),
        name TEXT NOT NULL
          CHECK (length(name) BETWEEN 1 AND 60),
        name_normalized TEXT NOT NULL
          CHECK (length(name_normalized) BETWEEN 1 AND 240),
        filters_json TEXT NOT NULL
          CHECK (
            length(CAST(filters_json AS BLOB)) BETWEEN 1 AND 910000
          ),
        position INTEGER NOT NULL
          CHECK (position >= 0 AND position < 50),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (bb_project_id, name_normalized)
      );

      CREATE INDEX idx_filter_presets_project
        ON project_filter_presets(
          bb_project_id, position, created_at, id
        );
    `
];
