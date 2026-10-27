import assert from 'node:assert/strict';
import test from 'node:test';
import { NginxSettingsValidationError, normalizeNginxSettings } from '../src/index.js';

test('a service override puts any site into maintenance or forwards it, and absence keeps legacy envelopes', () => {
  for (const target of ['static', 'proxy', 'passenger', 'php', 'python', 'redirect']) {
    assert.equal(Object.hasOwn(normalizeNginxSettings(target, {}), 'serviceOverride'), false, target);
    assert.deepEqual(normalizeNginxSettings(target, { serviceOverride: { mode: 'unavailable' } }).serviceOverride, { mode: 'unavailable' });
  }
  assert.deepEqual(normalizeNginxSettings('proxy', { serviceOverride: { mode: 'redirect', url: 'https://control.example.com/billing', status: 302, preservePath: false } }).serviceOverride,
    { mode: 'redirect', url: 'https://control.example.com/billing', status: 302, preservePath: false });
  assert.equal(normalizeNginxSettings('proxy', { serviceOverride: null }).serviceOverride, null);
});

test('unsafe or unknown overrides are refused', () => {
  for (const value of [{ mode: 'down' }, { mode: 'unavailable', extra: 1 }, { mode: 'redirect' }, { mode: 'redirect', url: 'https://x.com/;deny all' },
    { mode: 'redirect', url: 'ftp://x.com' }, 'unavailable', []]) {
    assert.throws(() => normalizeNginxSettings('proxy', { serviceOverride: value }), NginxSettingsValidationError, JSON.stringify(value));
  }
});
