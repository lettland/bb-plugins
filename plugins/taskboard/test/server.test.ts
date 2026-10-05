import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { JIRA_URL, PROJECT_ID, bootPlugin } from './support/server-harness.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jiraIssue(key: string, summary: string, statusKey = 'new') {
  return {
    id: String(100 + Number(key.split('-')[1])),
    key,
    fields: {
      summary,
      description: null,
      updated: '2026-08-26T12:00:00.000Z',
      status: { id: 'st-1', name: 'Todo', statusCategory: { key: statusKey } },
      priority: null,
      assignee: null,
      project: { key: 'ENG', name: 'Engineering' },
      labels: []
    }
  };
}

function stubJiraSearch(issues: unknown[]): Array<{ url: string; init?: RequestInit }> {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) });
    return new Response(JSON.stringify({ issues, nextPageToken: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
}

test('registers the rpc handlers and the taskboard cli', async () => {
  const harness = await bootPlugin();
  assert.deepEqual(Object.keys(harness.handlers).sort(), [
    'createIssue',
    'deleteFilterPreset',
    'getCreateIssueContext',
    'getCreateIssueMetadata',
    'getItem',
    'getProjectBoardSettings',
    'getProjectConfig',
    'listFilterPresets',
    'listItems',
    'listProjects',
    'refresh',
    'reorderFilterPresets',
    'saveFilterPreset',
    'saveProjectBoardSettings',
    'saveProjectConfig',
    'status',
    'statusOptions',
    'threadProject',
    'updateItemStatus'
  ]);
  assert.equal(harness.cli.register.length, 1);
});

test('listProjects sorts live projects by name then id', async () => {
  const harness = await bootPlugin([
    { id: 'proj_b', name: 'Beta' },
    { id: 'proj_a2', name: 'Alpha' },
    { id: 'proj_a1', name: 'Alpha' }
  ]);
  assert.deepEqual(await harness.handlers.listProjects(null as never), {
    projects: [
      { id: 'proj_a1', name: 'Alpha' },
      { id: 'proj_a2', name: 'Alpha' },
      { id: 'proj_b', name: 'Beta' }
    ]
  });
});

test('refresh syncs the selected Jira source and listItems returns the cache', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  const calls = stubJiraSearch([
    jiraIssue('ENG-1', 'First'),
    jiraIssue('ENG-2', 'Second', 'done')
  ]);

  const refreshed = (await harness.handlers.refresh({
    projectId: PROJECT_ID
  } as never)) as { sources: Array<Record<string, unknown>>; itemCount: number };

  assert.equal(refreshed.itemCount, 2);
  assert.equal(refreshed.sources.length, 1);
  assert.equal(refreshed.sources[0]?.source, 'jira');
  assert.equal(refreshed.sources[0]?.configured, true);
  assert.equal(refreshed.sources[0]?.available, true);
  assert.equal(refreshed.sources[0]?.message, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${JIRA_URL}/rest/api/3/search/jql`);
  assert.deepEqual(harness.published, [
    {
      channel: 'taskboard:changed',
      payload: { projectId: PROJECT_ID, source: null }
    }
  ]);

  const listed = (await harness.handlers.listItems({
    projectId: PROJECT_ID,
    limit: 50
  } as never)) as { items: Array<{ key: string; bbProjectId: string }>; provider: string };
  assert.equal(listed.provider, 'jira');
  assert.deepEqual(
    listed.items.map(item => [item.key, item.bbProjectId]).sort(),
    [
      ['ENG-1', PROJECT_ID],
      ['ENG-2', PROJECT_ID]
    ]
  );
});

test('listItems applies query and state filters to the cache', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  stubJiraSearch([
    jiraIssue('ENG-1', 'First'),
    jiraIssue('ENG-2', 'Second', 'done')
  ]);
  await harness.handlers.refresh({ projectId: PROJECT_ID } as never);

  const byQuery = (await harness.handlers.listItems({
    projectId: PROJECT_ID,
    query: 'second',
    limit: 50
  } as never)) as { items: Array<{ key: string }> };
  assert.deepEqual(byQuery.items.map(item => item.key), ['ENG-2']);

  const byState = (await harness.handlers.listItems({
    projectId: PROJECT_ID,
    stateCategories: ['todo'],
    limit: 50
  } as never)) as { items: Array<{ key: string }> };
  assert.deepEqual(byState.items.map(item => item.key), ['ENG-1']);
});

test('refresh keeps the cache and reports unavailable when Jira is unreachable', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  stubJiraSearch([jiraIssue('ENG-1', 'First')]);
  await harness.handlers.refresh({ projectId: PROJECT_ID } as never);

  globalThis.fetch = async () => {
    throw new Error('network down');
  };
  const refreshed = (await harness.handlers.refresh({
    projectId: PROJECT_ID
  } as never)) as { sources: Array<Record<string, unknown>>; itemCount: number };

  assert.equal(refreshed.sources[0]?.available, false);
  assert.equal(refreshed.sources[0]?.message, 'Could not reach Jira');
  assert.equal(refreshed.itemCount, 1);
  assert.equal(harness.warnings.length, 1);
  assert.match(harness.warnings[0]!, /Jira sync failed for proj_alpha/u);
  const listed = (await harness.handlers.listItems({
    projectId: PROJECT_ID,
    limit: 50
  } as never)) as { items: unknown[] };
  assert.equal(listed.items.length, 1);
});

test('refresh without Jira credentials records the configuration message', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject('');
  const calls = stubJiraSearch([]);

  const refreshed = (await harness.handlers.refresh({
    projectId: PROJECT_ID
  } as never)) as { sources: Array<Record<string, unknown>> };

  assert.equal(calls.length, 0);
  assert.equal(refreshed.sources[0]?.configured, false);
  assert.equal(refreshed.sources[0]?.available, false);
  assert.equal(
    refreshed.sources[0]?.message,
    'Set the Jira URL, email, and API token for this BB project in Manage.'
  );
});

test('refresh rejects a source that is not the selected tracker', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  await assert.rejects(
    harness.handlers.refresh({ projectId: PROJECT_ID, source: 'linear' } as never),
    /Linear is not the selected tracker for this BB project/u
  );
});

test('refresh and status reject an unknown BB project', async () => {
  const harness = await bootPlugin();
  await assert.rejects(
    harness.handlers.refresh({ projectId: 'proj_missing' } as never),
    /BB project was not found/u
  );
  await assert.rejects(
    harness.handlers.status({ projectId: 'proj_missing' } as never),
    /BB project was not found/u
  );
});

test('saveProjectBoardSettings persists, publishes and is read back', async () => {
  const harness = await bootPlugin();
  const defaults = (await harness.handlers.getProjectBoardSettings({
    projectId: PROJECT_ID
  } as never)) as { settings: { defaultView: string } };
  assert.equal(defaults.settings.defaultView, 'list');

  const settings = {
    projectId: PROJECT_ID,
    defaultView: 'kanban',
    enabledFilters: ['state', 'labels'],
    statusOrder: ['Todo', 'Done']
  };
  assert.deepEqual(await harness.handlers.saveProjectBoardSettings(settings as never), {
    settings
  });
  assert.deepEqual(
    await harness.handlers.getProjectBoardSettings({ projectId: PROJECT_ID } as never),
    { settings }
  );
  assert.deepEqual(harness.published, [
    {
      channel: 'taskboard:changed',
      payload: { projectId: PROJECT_ID, source: null }
    }
  ]);
});

test('cli status reports the selected source state', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  stubJiraSearch([jiraIssue('ENG-1', 'First')]);
  await harness.handlers.refresh({ projectId: PROJECT_ID } as never);

  assert.deepEqual(await harness.cli.run(['status']), {
    exitCode: 0,
    stdout: 'Jira\tready\t'
  });
});
