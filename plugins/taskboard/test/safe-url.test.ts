import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeExternalUrl } from '../features/shared/safe-url.ts';

test('accepts http and https tracker links as their parsed href', () => {
  for (const [url, href] of [
    ['https://x.atlassian.net/browse/A-1', 'https://x.atlassian.net/browse/A-1'],
    ['http://example.com', 'http://example.com/']
  ]) {
    assert.equal(safeExternalUrl(url), href);
  }
});

test('rejects non-http(s) and unparseable links', () => {
  for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    '\njavascript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'not a url',
    ''
  ]) {
    assert.equal(safeExternalUrl(url), null, JSON.stringify(url));
  }
});
