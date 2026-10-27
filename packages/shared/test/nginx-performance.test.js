import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, normalizeNginxSettings } from '../src/index.js';

test('gzip is an optional boolean on every target and leaves legacy envelopes unchanged', () => {
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python']) {
    assert.equal(Object.hasOwn(normalizeNginxSettings(target, {}), 'gzip'), false);
    assert.equal(normalizeNginxSettings(target, { gzip: true }).gzip, true);
    assert.equal(normalizeNginxSettings(target, { gzip: false }).gzip, false);
    assert.throws(() => normalizeNginxSettings(target, { gzip: 'on' }), NginxSettingsValidationError);
  }
  const base = normalizeNginxSettings('proxy', { gzip: true });
  assert.equal(normalizeNginxSettings('proxy', { clientMaxBodySizeMb: 4 }, base).gzip, true);
});

test('PHP browser cache for static files is optional, ranged and unknown to other server-rendered targets', () => {
  assert.equal(Object.hasOwn(normalizeNginxSettings('php', {}), 'staticAssetCacheSeconds'), false);
  assert.equal(normalizeNginxSettings('php', { staticAssetCacheSeconds: 604_800 }).staticAssetCacheSeconds, 604_800);
  assert.equal(normalizeNginxSettings('php', { staticAssetCacheSeconds: null }).staticAssetCacheSeconds, null);
  assert.equal(normalizeNginxSettings('php', { staticAssetCacheSeconds: 0 }).staticAssetCacheSeconds, 0);
  for (const value of [-1, 31_536_001, 1.5, '60']) {
    assert.throws(() => normalizeNginxSettings('php', { staticAssetCacheSeconds: value }), NginxSettingsValidationError);
  }
  for (const target of ['proxy', 'passenger', 'python']) {
    assert.throws(() => normalizeNginxSettings(target, { staticAssetCacheSeconds: 60 }), { code: 'invalid_nginx_settings' });
  }
  // Static sites keep their existing default.
  assert.equal(normalizeNginxSettings('static', {}).staticAssetCacheSeconds, 604_800);
});
