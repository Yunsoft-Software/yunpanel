import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NginxSettingsValidationError,
  normalizeNginxSettings,
} from '../src/nginx-settings.js';

test('Passenger nginx settings expose only common bounded controls', () => {
  assert.deepEqual(normalizeNginxSettings('passenger', {
    clientMaxBodySizeMb: 64,
    headers: [{ name: 'X-Frame-Options', value: 'DENY', always: true }],
  }), {
    clientMaxBodySizeMb: 64,
    headers: [{ name: 'X-Frame-Options', value: 'DENY', always: true }],
  });
});

test('Passenger nginx settings reject proxy and static-only controls', () => {
  assert.throws(
    () => normalizeNginxSettings('passenger', { websocket: true }),
    (error) => error instanceof NginxSettingsValidationError && error.code === 'invalid_nginx_settings',
  );
  assert.throws(
    () => normalizeNginxSettings('passenger', { spaFallback: true }),
    (error) => error instanceof NginxSettingsValidationError && error.code === 'invalid_nginx_settings',
  );
});
