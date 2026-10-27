import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, normalizeNginxSettings, normalizeRedirectTarget, RedirectTargetValidationError } from '../src/index.js';

test('a redirect target keeps the URL and defaults to a permanent redirect that keeps the path', () => {
  assert.deepEqual(normalizeRedirectTarget({ url: 'https://yeni.example.com' }),
    { url: 'https://yeni.example.com', status: 301, preservePath: true });
  assert.deepEqual(normalizeRedirectTarget({ url: 'http://example.com/kampanya/', status: 302, preservePath: false }),
    { url: 'http://example.com/kampanya/', status: 302, preservePath: false });
  // A kept path is appended to the URL, so its trailing slash would double up.
  assert.equal(normalizeRedirectTarget({ url: 'https://example.com/' }).url, 'https://example.com');
  assert.ok(Object.isFrozen(normalizeRedirectTarget({ url: 'https://example.com' })));
});

test('redirect URLs that could break out of the nginx directive or mislead are refused', () => {
  for (const url of ['example.com', 'ftp://example.com', 'javascript:alert(1)', 'https://', 'https://u:p@example.com',
    'https://example.com/a b', 'https://example.com/$host', 'https://example.com/;return 200', "https://example.com/'x",
    'https://example.com/{x}', 'https://example.com/a#frag', 'https://example.com/\\x', 'https://example.com/"x"',
    `https://example.com/${'a'.repeat(510)}`, 'https://example.com/a\nb', 42, null]) {
    assert.throws(() => normalizeRedirectTarget({ url }), RedirectTargetValidationError, String(url));
  }
  assert.throws(() => normalizeRedirectTarget({ url: 'https://example.com/?a=1' }), RedirectTargetValidationError, 'query plus kept path');
  assert.equal(normalizeRedirectTarget({ url: 'https://example.com/?a=1', preservePath: false }).url, 'https://example.com/?a=1');
  for (const target of [{ url: 'https://example.com', status: 307 }, { url: 'https://example.com', preservePath: 'yes' },
    { url: 'https://example.com', extra: 1 }, null, [], 'https://example.com']) {
    assert.throws(() => normalizeRedirectTarget(target), RedirectTargetValidationError, JSON.stringify(target));
  }
});

test('redirect Domains accept only settings that apply to a redirect response', () => {
  assert.deepEqual(normalizeNginxSettings('redirect', {}), { clientMaxBodySizeMb: null, headers: [] });
  for (const field of ['redirectRules', 'protectedPaths', 'gzip', 'documentRoot', 'websocket']) {
    assert.throws(() => normalizeNginxSettings('redirect', { [field]: field === 'gzip' }), NginxSettingsValidationError, field);
  }
});
