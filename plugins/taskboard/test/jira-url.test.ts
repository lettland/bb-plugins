import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { jiraBaseUrlSchema } from '../credential-contract.ts';

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

const { createJiraAdapter } = await import('../sources/jira.ts');

const originalFetch = globalThis.fetch;
const REJECTION = 'Jira Cloud URL must be an HTTPS atlassian.net origin.';
const MISSING_SETTINGS =
  'Set the Jira URL, email, and API token for this BB project in Manage.';
const BASIC = `Basic ${Buffer.from('me@example.com:secret-token').toString('base64')}`;

const ACCEPTED: Array<[string, string]> = [
  ['https://example.atlassian.net', 'https://example.atlassian.net'],
  ['https://example.atlassian.net/', 'https://example.atlassian.net'],
  ['  https://example.atlassian.net  ', 'https://example.atlassian.net'],
  ['HTTPS://Example.Atlassian.NET', 'https://example.atlassian.net'],
  ['https://team.eu.atlassian.net', 'https://team.eu.atlassian.net'],
  ['https://atlassian.net', 'https://atlassian.net']
];

const REJECTED = [
  'http://example.atlassian.net',
  'ftp://example.atlassian.net',
  'https://atlassian.net.evil.com',
  'https://example.atlassian.net.evil.com',
  'https://evilatlassian.net',
  'https://example.evilatlassian.net',
  'https://example.atlassian.com',
  'https://evil.com/example.atlassian.net',
  'https://evil.com#.atlassian.net',
  'https://example.atlassian.net@evil.com',
  'https://user:pass@example.atlassian.net',
  'https://user@example.atlassian.net',
  'https://example.atlassian.net:8443',
  'https://example.atlassian.net:443',
  'https://example.atlassian.net/wiki',
  'https://example.atlassian.net/?next=1',
  'https://example.atlassian.net/#fragment',
  'example.atlassian.net',
  'not a url'
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function adapterFor(baseUrl: string) {
  return createJiraAdapter({
    enabled: true,
    baseUrl,
    email: 'me@example.com',
    apiToken: 'secret-token',
    jql: 'project = ENG'
  });
}

function stubFetch(
  respond: (url: string, init: RequestInit) => unknown = () => ({
    issues: [],
    nextPageToken: null
  })
): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(respond(String(input), init ?? {})), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
}

for (const [input, origin] of ACCEPTED) {
  test(`accepts ${JSON.stringify(input)} and requests ${origin}`, async () => {
    const calls = stubFetch();
    const adapter = adapterFor(input);

    assert.equal(adapter.configured(), true);
    assert.equal(adapter.configurationMessage(), null);
    await adapter.list();

    assert.equal(calls[0]?.url, `${origin}/rest/api/3/search/jql`);
    assert.equal(jiraBaseUrlSchema.parse(input), origin);
  });
}

for (const input of REJECTED) {
  test(`rejects ${JSON.stringify(input)} without any request`, async () => {
    const calls = stubFetch();
    const adapter = adapterFor(input);

    assert.equal(adapter.configured(), false);
    assert.equal(adapter.configurationMessage(), REJECTION);
    await assert.rejects(adapter.list(), /Jira is not configured/u);

    assert.equal(calls.length, 0);
    assert.equal(jiraBaseUrlSchema.safeParse(input).success, false);
  });
}

test('an empty base URL asks for the settings instead of reporting a bad URL', () => {
  const adapter = adapterFor('   ');
  assert.equal(adapter.configured(), false);
  assert.equal(adapter.configurationMessage(), MISSING_SETTINGS);
  assert.equal(jiraBaseUrlSchema.parse('   '), '');
});

test('requests refuse redirects and carry the basic authorization header', async () => {
  const calls = stubFetch(url =>
    url.includes('/jql/match')
      ? { matches: [{ matchedIssues: [101], errors: [] }] }
      : {
          id: '101',
          key: 'ENG-1',
          fields: {
            summary: 'Title',
            description: null,
            updated: '2026-08-26T12:00:00.000Z',
            status: { id: '1', name: 'Todo', statusCategory: { key: 'new' } },
            priority: null,
            assignee: null,
            project: { key: 'ENG', name: 'Engineering' },
            labels: [],
            comment: { comments: [] }
          }
        }
  );

  await adapterFor('https://example.atlassian.net').get('ENG-1');

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers.authorization, BASIC);
    assert.equal(headers.accept, 'application/json');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.equal(calls[0]?.init.method, undefined);
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)['content-type'],
    undefined
  );
  assert.equal(calls[1]?.init.method, 'POST');
  assert.equal(
    (calls[1]?.init.headers as Record<string, string>)['content-type'],
    'application/json'
  );
});

test('a refused redirect surfaces as an unreachable Jira, never as a followed request', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, 'error');
    throw new TypeError('fetch failed');
  };

  await assert.rejects(
    adapterFor('https://example.atlassian.net').list(),
    /Could not reach Jira/u
  );
  assert.deepEqual(calls, ['https://example.atlassian.net/rest/api/3/search/jql']);
});

test('a non-ok Jira response reports its HTTP status only', async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: 'secret-token leaked?' }), {
      status: 401
    });

  await assert.rejects(
    adapterFor('https://example.atlassian.net').list(),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Jira returned HTTP 401');
      return true;
    }
  );
});
