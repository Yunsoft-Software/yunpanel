import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxSettingsValidationError,
  normalizeNginxSettings,
} from '../src/index.js';

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
});

test('rejects cross-target, injection-capable and protocol-owned header settings', () => {
  for (const [targetType, value] of [
    ['static', { websocket: true }],
    ['proxy', { spaFallback: true }],
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
