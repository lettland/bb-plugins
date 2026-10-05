import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  JIRA_URL,
  PROJECT_ID,
  bootPlugin,
  events,
  faults,
  secrets,
  type Harness
} from './support/server-harness.ts';

const originalFetch = globalThis.fetch;
const OTHER_URL = 'https://other.atlassian.net';
const TOKEN_KEY = `${PROJECT_ID}:jira`;

beforeEach(() => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ issues: [], nextPageToken: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
});

afterEach(async () => {
  await settle();
  globalThis.fetch = originalFetch;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function mutation(
  overrides: Record<string, unknown> = {},
  jiraCredential: Record<string, unknown> = { operation: 'keep' }
) {
  return {
    projectId: PROJECT_ID,
    source: 'jira',
    linearTeamKey: '',
    jiraBaseUrl: JIRA_URL,
    jiraEmail: 'me@example.com',
    jiraJql: 'project = ENG',
    linearCredential: { operation: 'keep' },
    jiraCredential,
    ...overrides
  };
}

async function save(harness: Harness, input: unknown) {
  return harness.handlers.saveProjectConfig(input as never) as Promise<{
    config: Record<string, unknown>;
  }>;
}

async function storedConfig(harness: Harness) {
  const { config } = (await harness.handlers.getProjectConfig({
    projectId: PROJECT_ID
  } as never)) as { config: Record<string, unknown> };
  return config;
}

const changed = (source: string | null) => ({
  channel: 'taskboard:changed',
  payload: { projectId: PROJECT_ID, source }
});

test('changing the Jira URL while keeping the stored token is rejected', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL })),
    /Changing the Jira URL or email requires a replacement token or explicit token removal/u
  );

  assert.deepEqual(events, []);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
  assert.equal((await storedConfig(harness)).jiraBaseUrl, JIRA_URL);
  assert.deepEqual(harness.published, []);
});

test('changing the Jira email while keeping the stored token is rejected', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  await assert.rejects(
    save(harness, mutation({ jiraEmail: 'someone-else@example.com' })),
    /Changing the Jira URL or email requires a replacement token/u
  );

  assert.deepEqual(events, []);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
  assert.equal((await storedConfig(harness)).jiraEmail, 'me@example.com');
});

test('changing the Jira URL without a stored token is allowed', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject('');

  const { config } = await save(harness, mutation({ jiraBaseUrl: OTHER_URL }));

  assert.equal(config.jiraBaseUrl, OTHER_URL);
  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig'
  ]);
});

test('a URL change with a replacement token clears the old token before saving the config', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  const { config } = await save(
    harness,
    mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })
  );

  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig',
    'credential:jira:set'
  ]);
  assert.equal(secrets.get(TOKEN_KEY), 'new-token');
  assert.equal(config.jiraBaseUrl, OTHER_URL);
  assert.equal(config.jiraCredentialConfigured, true);
  await settle();
  assert.deepEqual(harness.published, [changed(null), changed('jira')]);
});

test('a URL change with explicit token removal clears the token and saves the config', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  const { config } = await save(
    harness,
    mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'clear' })
  );

  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig'
  ]);
  assert.equal(secrets.has(TOKEN_KEY), false);
  assert.equal(config.jiraCredentialConfigured, false);
});

test('rotating the token without an identity change writes the token before the config', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  await save(harness, mutation({}, { operation: 'set', value: 'rotated' }));

  assert.deepEqual(events, [
    'credential:jira:set',
    'store:saveProjectConfig'
  ]);
  assert.equal(secrets.get(TOKEN_KEY), 'rotated');
});

test('saving an unchanged config touches nothing but still publishes a change', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();

  const { config } = await save(harness, mutation());

  assert.deepEqual(events, []);
  assert.equal(config.jiraBaseUrl, JIRA_URL);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
  assert.deepEqual(harness.published, [changed(null)]);
});

test('saving a config for an unknown BB project is rejected before any write', async () => {
  const harness = await bootPlugin();

  await assert.rejects(
    save(harness, mutation({ projectId: 'proj_missing' }, { operation: 'set', value: 'x' })),
    /BB project was not found/u
  );

  assert.deepEqual(events, []);
  assert.equal(secrets.size, 0);
});

test('a config save failure restores the old token when the restore succeeds', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.configSaves.add(1);

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })),
    /injected config save 1 failure/u
  );

  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig',
    'credential:jira:set'
  ]);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
  assert.equal((await storedConfig(harness)).jiraBaseUrl, JIRA_URL);
  assert.deepEqual(harness.published, []);
});

test('a config save failure with a failed token restore leaves Jira tokenless', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.configSaves.add(1);
  faults.credentials.set('credential:jira:set', [1, 2]);

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })),
    /Connector save failed and the previous credential state could not be fully restored/u
  );

  assert.equal(secrets.has(TOKEN_KEY), false);
  assert.equal((await storedConfig(harness)).jiraBaseUrl, JIRA_URL);
});

test('a failed new-token write rolls the config back and restores the old token', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.credentials.set('credential:jira:set', [1]);

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })),
    /Jira credential could not be saved; the previous Jira bundle was restored/u
  );

  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig',
    'credential:jira:set',
    'store:saveProjectConfig',
    'credential:jira:set'
  ]);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
  assert.equal((await storedConfig(harness)).jiraBaseUrl, JIRA_URL);
  assert.deepEqual(harness.published, [changed(null)]);
});

test('the old token is not restored when the config rollback also fails', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.credentials.set('credential:jira:set', [1]);
  faults.configSaves.add(2);

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })),
    /Jira credential could not be saved; Jira was left unconfigured/u
  );

  assert.deepEqual(events, [
    'credential:jira:clear',
    'store:saveProjectConfig',
    'credential:jira:set',
    'store:saveProjectConfig'
  ]);
  assert.equal(secrets.has(TOKEN_KEY), false);
  assert.equal((await storedConfig(harness)).jiraBaseUrl, OTHER_URL);
  assert.deepEqual(harness.published, [changed(null)]);
});

test('a failed new-token write whose restore also fails reports the partial restore', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.credentials.set('credential:jira:set', [1, 2]);

  await assert.rejects(
    save(harness, mutation({ jiraBaseUrl: OTHER_URL }, { operation: 'set', value: 'new-token' })),
    /Jira credential save failed and the previous credential state could not be fully restored/u
  );

  assert.equal(secrets.has(TOKEN_KEY), false);
  assert.equal((await storedConfig(harness)).jiraBaseUrl, JIRA_URL);
  assert.deepEqual(harness.published, [changed(null)]);
});

test('a config save failure after a token rotation restores the previous token', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.configSaves.add(1);

  await assert.rejects(
    save(harness, mutation({}, { operation: 'set', value: 'rotated' })),
    /injected config save 1 failure/u
  );

  assert.deepEqual(events, [
    'credential:jira:set',
    'store:saveProjectConfig',
    'credential:jira:set'
  ]);
  assert.equal(secrets.get(TOKEN_KEY), 'old-token');
});

test('a config save failure after a token rotation with a failed restore is reported', async () => {
  const harness = await bootPlugin();
  harness.seedJiraProject();
  faults.configSaves.add(1);
  faults.credentials.set('credential:jira:set', [2]);

  await assert.rejects(
    save(harness, mutation({}, { operation: 'set', value: 'rotated' })),
    /Credential save failed and the previous credential state could not be fully restored/u
  );

  assert.equal(secrets.get(TOKEN_KEY), 'rotated');
});
