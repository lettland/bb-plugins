import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeExternalUrl } from '../features/shared/safe-url.ts';

test('accepts http and https tracker links unchanged', () => {
  for (const url of [
    'https://x.atlassian.net/browse/A-1',
    'http://example.com'
  ]) {
    assert.equal(safeExternalUrl(url), url);
  }
});

test('rejects non-http(s) and unparseable links', () => {
  for (const url of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,x',
    'vbscript:x',
    'not a url',
    ''
  ]) {
    assert.equal(safeExternalUrl(url), null, JSON.stringify(url));
  }
});
