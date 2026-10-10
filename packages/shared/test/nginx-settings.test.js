import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxSettingsValidationError,
  normalizeNginxSettings,
} from '../src/index.js';

test('file settings preserve legacy defaults and partial updates while pinning safe ordered names and local errors', () => {
  const base = normalizeNginxSettings('php', { indexFiles: ['home.php', 'index.html'], errorPages: { 404: '/errors/not-found.html', 500: '/errors/failure.html' } });
  assert.deepEqual(base.indexFiles, ['home.php', 'index.html']);
  assert.deepEqual(normalizeNginxSettings('php', { clientMaxBodySizeMb: 16 }, base), { ...base, clientMaxBodySizeMb: 16 });
  assert.deepEqual(normalizeNginxSettings('php', { indexFiles: null, errorPages: null }, base), { clientMaxBodySizeMb: null, indexFiles: null, errorPages: null, headers: [] });
  assert.equal(Object.hasOwn(normalizeNginxSettings('static', {}), 'indexFiles'), false);
  assert.equal(Object.hasOwn(normalizeNginxSettings('php', {}), 'errorPages'), false);
  assert.ok(Object.isFrozen(base.indexFiles)); assert.ok(Object.isFrozen(base.errorPages));
});

test('file settings reject cross-runtime directives, hidden paths, external redirects, injection and index/error collisions', () => {
  for (const [target, settings] of [
    ['passenger', { indexFiles: ['index.html'] }], ['proxy', { errorPages: { 404: '/error.html' } }],
    ['static', { indexFiles: ['index.php'] }], ['php', { indexFiles: ['../index.php'] }],
    ['php', { indexFiles: ['.env'] }], ['static', { indexFiles: ['home.html', 'home.html'] }],
    ['static', { indexFiles: [] }], ['php', { indexFiles: ['index.php; include /etc/nginx;'] }],
    ['php', { indexFiles: 'index.php index.html' }],
    ...['https://other.test/e.html', '/.env.html', '/errors/../e.html', '/errors/.hidden.html', '/e.html?$secret', '/e.html\ninclude /etc/nginx;', '/e.php', '//e.html'].map(uri => ['php', { errorPages: { 404: uri } }]),
    ['php', { errorPages: { 200: '/error.html' } }], ['static', { errorPages: { 404: '/index.html' } }],
    ['php', { indexFiles: ['home.html'], errorPages: { 500: '/home.html' } }],
  ]) assert.throws(() => normalizeNginxSettings(target, settings), NginxSettingsValidationError);
});

test('normalizes bounded target-specific Nginx settings and partial updates', () => {
  const proxy = normalizeNginxSettings('proxy', {
    clientMaxBodySizeMb: 64,
    proxyTimeoutSeconds: 120,
    websocket: false,
    headers: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN', always: true }],
  });
  assert.deepEqual(proxy, {
    clientMaxBodySizeMb: 64,
    proxyTimeoutSeconds: 120,
    websocket: false,
    headers: [{ name: 'X-Frame-Options', value: 'SAMEORIGIN', always: true }],
  });
  assert.deepEqual(normalizeNginxSettings('proxy', { websocket: true }, proxy), {
    ...proxy,
    websocket: true,
  });
  assert.deepEqual(normalizeNginxSettings('static', {}), {
    clientMaxBodySizeMb: null,
    spaFallback: true,
    staticAssetCacheSeconds: 604800,
    headers: [],
  });
  assert.deepEqual(normalizeNginxSettings('php', {}), {
    clientMaxBodySizeMb: null,
    headers: [],
  });
  assert.deepEqual(normalizeNginxSettings('python', {
    clientMaxBodySizeMb: 32,
    proxyTimeoutSeconds: 60,
    websocket: true,
  }), {
    clientMaxBodySizeMb: 32,
    proxyTimeoutSeconds: 60,
    websocket: true,
    headers: [],
  });
});

test('rejects cross-target, injection-capable and protocol-owned header settings', () => {
  for (const [targetType, value] of [
    ['static', { websocket: true }],
    ['proxy', { spaFallback: true }],
    ['php', { websocket: true }],
    ['php', { spaFallback: true }],
    ['proxy', { proxyTimeoutSeconds: 0 }],
    ['static', { staticAssetCacheSeconds: 31_536_001 }],
    ['proxy', { headers: [{ name: 'X-Test', value: 'safe\ninclude /etc/nginx', always: true }] }],
    ['proxy', { headers: [{ name: 'X-Test', value: 'safe\u2028include /etc/nginx', always: true }] }],
    ['proxy', { headers: [{ name: 'X-Test', value: '$upstream_http_secret', always: true }] }],
    ['proxy', { headers: [{ name: 'Set-Cookie', value: 'admin=true', always: true }] }],
    ['proxy', { headers: [
      { name: 'X-Test', value: 'one', always: true },
      { name: 'x-test', value: 'two', always: false },
    ] }],
  ]) {
    assert.throws(
      () => normalizeNginxSettings(targetType, value),
      (error) => error instanceof NginxSettingsValidationError,
    );
  }
});
