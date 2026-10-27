import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, newProtectedPathKey, normalizeNginxSettings, stableHexKey } from '../src/index.js';

const entry = (path, key = newProtectedPathKey()) => ({ path, key });

test('protected paths are an optional directory list on every target and keep legacy envelopes unchanged', () => {
  const paths = [entry('/admin/'), entry('/raporlar/2026/')];
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python']) {
    assert.equal(Object.hasOwn(normalizeNginxSettings(target, {}), 'protectedPaths'), false);
    const settings = normalizeNginxSettings(target, { protectedPaths: paths });
    assert.deepEqual(settings.protectedPaths, paths);
    assert.ok(Object.isFrozen(settings.protectedPaths) && Object.isFrozen(settings.protectedPaths[0]));
  }
  assert.deepEqual(normalizeNginxSettings('php', { protectedPaths: [] }).protectedPaths, []);
});

test('protected paths reject injection, root, ACME, duplicates, nesting and malformed or shared keys', () => {
  const key = newProtectedPathKey();
  for (const value of [[entry('admin/')], [entry('/admin')], [entry('/')], [entry('/a b/')], [entry('/admin;/')], [entry('/admin/../')],
    [entry('//admin/')], [entry('/.well-known/x/')], [entry('/$x/')], [entry('/admin/'), entry('/admin/')], [entry('/admin/'), entry('/admin/panel/')],
    Array.from({ length: 21 }, (_, i) => entry(`/p${i}/`)), '/admin/', ['/admin/'], [{ path: '/admin/' }], [entry('/admin/', 'ABC')],
    [entry('/admin/', '../../etc/passwd')], [entry('/a/', key), entry('/b/', key)], [{ ...entry('/admin/'), extra: 1 }]]) {
    assert.throws(() => normalizeNginxSettings('php', { protectedPaths: value }), NginxSettingsValidationError, JSON.stringify(value));
  }
});

test('new keys are random 16-hex identifiers; the stable key names nginx variables', () => {
  const keys = new Set(Array.from({ length: 200 }, () => newProtectedPathKey()));
  assert.equal(keys.size, 200);
  for (const key of keys) assert.match(key, /^[a-f0-9]{16}$/);
  assert.match(stableHexKey('site.example.com'), /^[a-f0-9]{16}$/);
  assert.equal(stableHexKey('site.example.com'), stableHexKey('site.example.com'));
});
