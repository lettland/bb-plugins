import assert from 'node:assert/strict';
import { test } from 'node:test';
import type Database from 'better-sqlite3';
import type { WorkItem } from '../contract.ts';
import {
  PROJECT_ID,
  bootPlugin,
  type MentionProvider
} from './support/server-harness.ts';

const { createWorkItemStore } = await import('../store.ts');

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: PROJECT_ID,
    source: 'github',
    locator: 'acme/app#42',
    key: 'acme/app#42',
    title: 'Crash on startup',
    description: '',
    url: 'https://github.com/acme/app/issues/42',
    status: 'Closed',
    stateCategory: 'done',
    priority: null,
    assignee: null,
    project: 'acme/app',
    labels: [],
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

function search(
  provider: MentionProvider,
  trigger: '@' | '#',
  projectId: string | null = PROJECT_ID
) {
  return provider.search({ trigger, query: 'crash', projectId, threadId: null });
}

function seedGithubProject(db: Database.Database): void {
  db.prepare(
    `INSERT INTO project_source_config (
      bb_project_id, source, linear_team_key, jira_base_url, jira_email,
      jira_jql, updated_at
    ) VALUES (?, 'github', '', '', '', 'project = ENG', ?)`
  ).run(PROJECT_ID, new Date().toISOString());
}

function seedItem(db: Database.Database, workItem: WorkItem): void {
  const store = createWorkItemStore({
    storage: { database: () => db, migrate() {} }
  } as unknown as Parameters<typeof createWorkItemStore>[0]);
  store.upsert(workItem);
}

test('mention search leaves GitHub-configured projects to the GitHub plugin', async () => {
  const harness = await bootPlugin();
  seedItem(harness.db, item());
  seedGithubProject(harness.db);
  assert.deepEqual(await search(harness.mentionProvider, '#'), []);
  assert.deepEqual(await search(harness.mentionProvider, '@'), []);
});

test('mention search returns nothing for a project without a config row', async () => {
  const harness = await bootPlugin();
  seedItem(harness.db, item());
  assert.deepEqual(await search(harness.mentionProvider, '#'), []);
  assert.deepEqual(await search(harness.mentionProvider, '@'), []);
});

test('mention search still returns items for a Jira project', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  seedItem(
    harness.db,
    item({
      source: 'jira',
      locator: 'ENG-7',
      key: 'ENG-7',
      title: 'Crash in Jira',
      status: 'In Progress',
      stateCategory: 'in_progress',
      assignee: 'Sam'
    })
  );
  const expected = [
    {
      id: `${PROJECT_ID}:jira:ENG-7`,
      title: 'ENG-7 Crash in Jira',
      subtitle: 'Jira · In Progress · Sam'
    }
  ];
  assert.deepEqual(await search(harness.mentionProvider, '#'), expected);
  assert.deepEqual(await search(harness.mentionProvider, '@'), expected);
});

test('mention resolve still serves existing GitHub item ids', async () => {
  const harness = await bootPlugin();
  seedItem(harness.db, item());
  seedGithubProject(harness.db);
  const resolved = await harness.mentionProvider.resolve(
    `${PROJECT_ID}:github:acme/app#42`
  );
  assert.match(resolved.context, /Crash on startup/);
});
