import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { WorkItem } from '../contract.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js')) {
      const sourceUrl = new URL(
        `${specifier.slice(0, -'.js'.length)}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { createWorkItemStore } = await import('../store.ts');
const { DEFAULT_WORKFLOW_STATUS_ORDER } = await import('../board-settings.ts');
type StoreBb = Parameters<typeof createWorkItemStore>[0];
type Store = ReturnType<typeof createWorkItemStore>;

const A = 'proj_a';
const B = 'proj_b';
const NOW = '2026-08-02T00:00:00.000Z';
const LATER = '2026-08-03T00:00:00.000Z';
const ALL_FILTERS = ['state', 'status', 'assignee', 'priority', 'project', 'labels'];
const DEFAULTS = {
  source: 'github' as const,
  linearTeamKey: '',
  jiraBaseUrl: '',
  jiraEmail: '',
  jiraJql: 'assignee = currentUser()'
};

function createStore(): { db: Database.Database; store: Store } {
  const db = new Database(':memory:');
  const bb = {
    storage: {
      database: () => db,
      migrate(database: Database.Database, migrations: readonly string[]) {
        for (const migration of migrations) database.exec(migration);
      }
    }
  } as unknown as StoreBb;
  return { db, store: createWorkItemStore(bb) };
}

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    bbProjectId: A,
    source: 'github',
    locator: 'acme/app#1',
    key: 'acme/app#1',
    title: 'First issue',
    description: 'Body text',
    url: 'https://github.com/acme/app/issues/1',
    status: 'Open',
    stateCategory: 'todo',
    priority: null,
    assignee: null,
    project: 'acme/app',
    labels: ['bug'],
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

function keys(items: WorkItem[]): string[] {
  return items.map(entry => entry.key).sort();
}

function counts(db: Database.Database): { items: number; syncs: number } {
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    items: count('work_items_by_project'),
    syncs: count('source_sync_by_project')
  };
}

const jiraConfig = (projectId: string) => ({
  projectId,
  source: 'jira' as const,
  linearTeamKey: '',
  jiraBaseUrl: 'https://example.atlassian.net',
  jiraEmail: 'me@example.com',
  jiraJql: 'project = ENG'
});

const jiraItem = () => item({ source: 'jira', locator: 'J-1', key: 'J-1' });
const emptySync = { lastSyncedAt: null, error: null, itemCount: 0 };

test('upsert inserts then updates an item and get returns it', () => {
  const { store } = createStore();
  store.upsert(item());
  store.upsert(item({ title: 'Renamed', status: 'Closed', stateCategory: 'done' }));

  const stored = store.get(A, 'github', 'acme/app#1');
  assert.equal(stored?.title, 'Renamed');
  assert.equal(stored?.status, 'Closed');
  assert.equal(stored?.stateCategory, 'done');
  assert.deepEqual(stored?.labels, ['bug']);
  assert.equal(store.get(A, 'github', 'missing'), undefined);
  assert.equal(store.get(B, 'github', 'acme/app#1'), undefined);
  assert.equal(store.list({ limit: 10 }).length, 1);
});

test('upsert rejects an item that fails the work item schema', () => {
  const { store } = createStore();
  assert.throws(() => store.upsert(item({ locator: '' })));
  assert.throws(() => store.upsert(item({ bbProjectId: 'not-a-project' })));
});

test('list orders by updatedAt descending and honors limit', () => {
  const { store } = createStore();
  store.upsert(item({ locator: 'old', key: 'OLD', updatedAt: '2026-01-01T00:00:00.000Z' }));
  store.upsert(item({ locator: 'new', key: 'NEW', updatedAt: '2026-03-01T00:00:00.000Z' }));
  store.upsert(item({ locator: 'mid', key: 'MID', updatedAt: '2026-02-01T00:00:00.000Z' }));

  const ordered = (limit: number) =>
    store.list({ limit }).map(entry => entry.key);
  assert.deepEqual(ordered(10), ['NEW', 'MID', 'OLD']);
  assert.deepEqual(ordered(2), ['NEW', 'MID']);
});

test('list filters by project, project allowlist, and source', () => {
  const { store } = createStore();
  store.upsert(item({ locator: 'a1', key: 'A-1' }));
  store.upsert(item({ bbProjectId: B, locator: 'b1', key: 'B-1' }));

  assert.deepEqual(keys(store.list({ projectId: A, limit: 10 })), ['A-1']);
  assert.deepEqual(keys(store.list({ projectIds: [B], limit: 10 })), ['B-1']);
  assert.deepEqual(keys(store.list({ projectIds: [], limit: 10 })), []);
  assert.deepEqual(keys(store.list({ source: 'github', limit: 10 })), ['A-1', 'B-1']);
  assert.deepEqual(keys(store.list({ source: 'jira', limit: 10 })), []);
});

test('list searches key, title, description and project case-insensitively', () => {
  const { store } = createStore();
  store.upsert(item({ locator: '1', key: 'KEY-100', title: 'alpha', description: '', project: null }));
  store.upsert(item({ locator: '2', key: 'K2', title: 'beta', description: 'Needle inside', project: null }));
  store.upsert(item({ locator: '3', key: 'K3', title: 'gamma', description: '', project: 'Platform' }));

  const search = (query: string) => keys(store.list({ query, limit: 10 }));
  assert.deepEqual(search('key-1'), ['KEY-100']);
  assert.deepEqual(search('ALPHA'), ['KEY-100']);
  assert.deepEqual(search('needle'), ['K2']);
  assert.deepEqual(search(' platform '), ['K3']);
  assert.deepEqual(search('absent'), []);
  assert.equal(search('   ').length, 3);
});

test('list treats LIKE wildcards in the query literally', () => {
  const { store } = createStore();
  store.upsert(item({ locator: '1', key: 'P-1', title: '100% done' }));
  store.upsert(item({ locator: '2', key: 'P-2', title: 'snake_case' }));
  store.upsert(item({ locator: '3', key: 'P-3', title: 'plain' }));

  const search = (query: string) => keys(store.list({ query, limit: 10 }));
  assert.deepEqual(search('%'), ['P-1']);
  assert.deepEqual(search('_'), ['P-2']);
  assert.deepEqual(search('sn_ke'), []);
});

test('list filters by state categories', () => {
  const { store } = createStore();
  store.upsert(item({ locator: '1', key: 'T', stateCategory: 'todo' }));
  store.upsert(item({ locator: '2', key: 'P', stateCategory: 'in_progress' }));
  store.upsert(item({ locator: '3', key: 'D', stateCategory: 'done' }));

  const byStates = (stateCategories: WorkItem['stateCategory'][]) =>
    keys(store.list({ stateCategories, limit: 10 }));
  assert.deepEqual(byStates(['todo', 'done']), ['D', 'T']);
  assert.deepEqual(byStates(['canceled']), []);
  assert.equal(byStates([]).length, 3);
});

test('list hides items of a source other than the project selected one', () => {
  const { store } = createStore();
  store.upsert(item({ locator: 'g', key: 'GH-1' }));
  store.upsert(item({ locator: 'LIN-1', key: 'LIN-1', source: 'linear' }));
  assert.deepEqual(keys(store.list({ projectId: A, limit: 10 })), ['GH-1']);

  store.ensureProjectConfig(A, { ...DEFAULTS, source: 'linear' });
  assert.deepEqual(keys(store.list({ projectId: A, limit: 10 })), ['LIN-1']);
});

test('syncState defaults to an empty state and setSourceError keeps the cached count', () => {
  const { store } = createStore();
  assert.deepEqual(store.syncState(A, 'github'), emptySync);

  store.replaceSource(A, 'github', [item()], NOW);
  store.setSourceError(A, 'github', 'rate limited');

  assert.deepEqual(store.syncState(A, 'github'), {
    lastSyncedAt: NOW,
    error: 'rate limited',
    itemCount: 1
  });
  assert.deepEqual(store.syncState(A, 'linear'), emptySync);
});

test('setSourceError on an unsynced source records the error without a sync time', () => {
  const { store } = createStore();
  store.setSourceError(A, 'github', 'not configured');
  assert.deepEqual(store.syncState(A, 'github'), {
    lastSyncedAt: null,
    error: 'not configured',
    itemCount: 0
  });
});

test('replaceSource drops items missing from the new set and clears the error', () => {
  const { store } = createStore();
  store.replaceSource(A, 'github', [item({ locator: '1', key: 'K1' }), item({ locator: '2', key: 'K2' })], NOW);
  store.setSourceError(A, 'github', 'boom');

  store.replaceSource(A, 'github', [item({ locator: '2', key: 'K2', title: 'Kept' }), item({ locator: '3', key: 'K3' })], LATER);

  assert.deepEqual(keys(store.list({ projectId: A, limit: 10 })), ['K2', 'K3']);
  assert.equal(store.get(A, 'github', '2')?.title, 'Kept');
  assert.deepEqual(store.syncState(A, 'github'), {
    lastSyncedAt: LATER,
    error: null,
    itemCount: 2
  });
});

test('replaceSource with no items empties that project and source only', () => {
  const { store } = createStore();
  store.replaceSource(A, 'github', [item()], NOW);
  store.replaceSource(B, 'github', [item({ bbProjectId: B })], NOW);

  store.replaceSource(A, 'github', [], LATER);

  assert.deepEqual(store.list({ projectId: A, limit: 10 }), []);
  assert.equal(store.list({ projectId: B, limit: 10 }).length, 1);
  assert.equal(store.syncState(A, 'github').itemCount, 0);
  assert.equal(store.syncState(B, 'github').itemCount, 1);
});

test('replaceSource rejects items outside the project and source scope without writing', () => {
  const { db, store } = createStore();
  store.replaceSource(A, 'github', [item()], NOW);
  const before = counts(db);

  for (const stray of [item({ bbProjectId: B }), item({ source: 'jira' })]) {
    assert.throws(
      () => store.replaceSource(A, 'github', [stray], LATER),
      /outside its BB project and source scope/u
    );
  }

  assert.deepEqual(counts(db), before);
  assert.equal(store.syncState(A, 'github').lastSyncedAt, NOW);
});

test('clearSource removes the items and sync row of one project and source', () => {
  const { db, store } = createStore();
  store.replaceSource(A, 'github', [item()], NOW);
  store.replaceSource(A, 'jira', [jiraItem()], NOW);
  store.replaceSource(B, 'github', [item({ bbProjectId: B })], NOW);

  store.clearSource(A, 'github');

  assert.equal(store.get(A, 'github', 'acme/app#1'), undefined);
  assert.equal(store.get(A, 'jira', 'J-1')?.key, 'J-1');
  assert.equal(store.get(B, 'github', 'acme/app#1')?.key, 'acme/app#1');
  assert.equal(store.syncState(A, 'github').lastSyncedAt, null);
  assert.equal(store.syncState(A, 'jira').itemCount, 1);
  assert.deepEqual(counts(db), { items: 2, syncs: 2 });
});

test('saveProjectConfig switching the source deletes all of the project items and sync rows', () => {
  const { db, store } = createStore();
  store.saveProjectConfig({ ...DEFAULTS, projectId: A });
  store.replaceSource(A, 'github', [item()], NOW);
  store.setSourceError(A, 'jira', 'stale');
  store.replaceSource(B, 'github', [item({ bbProjectId: B })], NOW);

  const saved = store.saveProjectConfig(jiraConfig(A));

  assert.equal(saved.source, 'jira');
  assert.equal(store.get(A, 'github', 'acme/app#1'), undefined);
  assert.deepEqual(store.syncState(A, 'github'), emptySync);
  assert.deepEqual(store.syncState(A, 'jira'), emptySync);
  assert.equal(store.get(B, 'github', 'acme/app#1')?.key, 'acme/app#1');
  assert.deepEqual(counts(db), { items: 1, syncs: 1 });
});

test('saveProjectConfig keeping the same source keeps the project items', () => {
  const { store } = createStore();
  store.saveProjectConfig(jiraConfig(A));
  store.replaceSource(A, 'jira', [jiraItem()], NOW);

  const saved = store.saveProjectConfig({ ...jiraConfig(A), jiraJql: 'project = OPS' });

  assert.equal(saved.jiraJql, 'project = OPS');
  assert.equal(store.get(A, 'jira', 'J-1')?.key, 'J-1');
  assert.equal(store.syncState(A, 'jira').itemCount, 1);
});

test('saveProjectConfig without a previous config only drops other-source items', () => {
  const { store } = createStore();
  store.replaceSource(A, 'github', [item()], NOW);
  store.setSourceError(A, 'jira', 'cached error');
  store.replaceSource(A, 'linear', [item({ source: 'linear', locator: 'L-1', key: 'L-1' })], NOW);

  store.saveProjectConfig({ ...DEFAULTS, projectId: A, source: 'linear' });

  assert.equal(store.get(A, 'github', 'acme/app#1'), undefined);
  assert.equal(store.get(A, 'linear', 'L-1')?.key, 'L-1');
  assert.equal(store.syncState(A, 'github').lastSyncedAt, null);
  assert.equal(store.syncState(A, 'jira').error, null);
  assert.equal(store.syncState(A, 'linear').itemCount, 1);
});

test('saveProjectConfig normalizes the Jira URL and rejects invalid input', () => {
  const { store } = createStore();
  const saved = store.saveProjectConfig({
    ...jiraConfig(A),
    jiraBaseUrl: ' HTTPS://Example.Atlassian.net/ '
  });
  assert.equal(saved.jiraBaseUrl, 'https://example.atlassian.net');

  assert.throws(() =>
    store.saveProjectConfig({ ...jiraConfig(A), jiraBaseUrl: 'http://example.atlassian.net' })
  );
  assert.throws(() => store.saveProjectConfig({ ...jiraConfig(A), jiraJql: '  ' }));
  assert.equal(store.projectConfig(A, DEFAULTS).jiraBaseUrl, 'https://example.atlassian.net');
});

test('projectConfig falls back to defaults and ensureProjectConfig never overwrites', () => {
  const { store } = createStore();
  assert.deepEqual(store.projectConfig(A, DEFAULTS), { ...DEFAULTS, projectId: A });
  assert.deepEqual(store.configuredProjectIds(), []);

  store.ensureProjectConfig(A, DEFAULTS);
  store.saveProjectConfig(jiraConfig(B));
  store.ensureProjectConfig(B, DEFAULTS);

  assert.equal(store.projectConfig(B, DEFAULTS).source, 'jira');
  assert.deepEqual(store.configuredProjectIds(), [A, B]);
  assert.deepEqual(store.selectedProjectIds('jira'), [B]);
  assert.deepEqual(store.selectedProjectIds('github'), [A]);
  assert.deepEqual(store.selectedProjectIds('linear'), []);
});

test('projectBoardSettings returns defaults until settings are saved', () => {
  const { store } = createStore();
  assert.deepEqual(store.projectBoardSettings(A), {
    projectId: A,
    defaultView: 'list',
    enabledFilters: ALL_FILTERS,
    statusOrder: [...DEFAULT_WORKFLOW_STATUS_ORDER]
  });

  const custom = {
    projectId: A,
    defaultView: 'kanban' as const,
    enabledFilters: ['state' as const, 'labels' as const],
    statusOrder: ['Todo', 'Doing', 'Done']
  };
  assert.deepEqual(store.saveProjectBoardSettings(custom), custom);
  assert.deepEqual(store.projectBoardSettings(A), custom);
  assert.equal(store.projectBoardSettings(B).defaultView, 'list');

  const replacement = { ...custom, defaultView: 'list' as const, enabledFilters: [] };
  assert.deepEqual(store.saveProjectBoardSettings(replacement), replacement);
});

test('saveProjectBoardSettings rejects duplicate filters and statuses without writing', () => {
  const { store } = createStore();
  const base = {
    projectId: A,
    defaultView: 'list' as const,
    enabledFilters: ['state' as const],
    statusOrder: ['Todo']
  };
  assert.throws(() =>
    store.saveProjectBoardSettings({ ...base, enabledFilters: ['state', 'state'] })
  );
  assert.throws(() =>
    store.saveProjectBoardSettings({ ...base, statusOrder: ['Todo', ' todo '] })
  );
  assert.throws(() => store.saveProjectBoardSettings({ ...base, statusOrder: [] }));
  assert.deepEqual(store.projectBoardSettings(A), {
    projectId: A,
    defaultView: 'list',
    enabledFilters: ALL_FILTERS,
    statusOrder: [...DEFAULT_WORKFLOW_STATUS_ORDER]
  });
});
