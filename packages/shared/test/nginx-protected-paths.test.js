import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, normalizeNginxSettings, protectedPathKey } from '../src/index.js';

test('protected paths are an optional directory list on every target and keep legacy envelopes unchanged', () => {
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python']) {
    assert.equal(Object.hasOwn(normalizeNginxSettings(target, {}), 'protectedPaths'), false);
    const settings = normalizeNginxSettings(target, { protectedPaths: ['/admin/', '/raporlar/2026/'] });
    assert.deepEqual(settings.protectedPaths, ['/admin/', '/raporlar/2026/']);
    assert.ok(Object.isFrozen(settings.protectedPaths));
  }
  assert.deepEqual(normalizeNginxSettings('php', { protectedPaths: [] }).protectedPaths, []);
});

test('protected paths reject injection, root, ACME, duplicates and nesting', () => {
  for (const value of [['admin/'], ['/admin'], ['/'], ['/a b/'], ['/admin;/'], ['/admin/../'], ['//admin/'], ['/.well-known/x/'],
    ['/$x/'], ['/admin/', '/admin/'], ['/admin/', '/admin/panel/'], Array.from({ length: 21 }, (_, i) => `/p${i}/`), '/admin/', [1]]) {
    assert.throws(() => normalizeNginxSettings('php', { protectedPaths: value }), NginxSettingsValidationError, JSON.stringify(value));
  }
});

test('the path key is stable, file-name safe and distinct per path', () => {
  assert.match(protectedPathKey('/admin/'), /^[a-f0-9]{16}$/);
  assert.equal(protectedPathKey('/admin/'), protectedPathKey('/admin/'));
  assert.notEqual(protectedPathKey('/admin/'), protectedPathKey('/admin2/'));
});
