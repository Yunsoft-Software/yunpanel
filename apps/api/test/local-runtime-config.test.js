import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLocalRuntimeConfig, LocalRuntimeConfigError } from '../src/local-runtime-config.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';

test('local runtime remains disabled unless a server id is explicitly configured', () => {
  assert.deepEqual(resolveLocalRuntimeConfig({ env: {}, hostname: 'host-1', jobStorePath: '.data/jobs.json' }), { enabled: false });
  assert.deepEqual(resolveLocalRuntimeConfig({ env: { YUNPANEL_LOCAL_SERVER_ID: '   ' }, hostname: 'host-1', jobStorePath: '.data/jobs.json' }), { enabled: false });
});

test('enabled local runtime binds to the operating-system hostname and job-store lock directory', () => {
  const config = resolveLocalRuntimeConfig({
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId.toUpperCase() },
    hostname: 'HOST-1.EXAMPLE.LOCAL',
    jobStorePath: '/var/lib/yunpanel/control-plane/job-registry.json',
  });
  assert.equal(config.enabled, true);
  assert.equal(config.serverId, serverId);
  assert.equal(config.hostname, 'host-1.example.local');
  assert.equal(config.lockPath, '/var/lib/yunpanel/control-plane/local-executor.lock');
  assert.equal(Object.isFrozen(config), true);
});

test('configured local runtime rejects non-enrolled ids and unsafe hostnames', () => {
  assert.throws(
    () => resolveLocalRuntimeConfig({ env: { YUNPANEL_LOCAL_SERVER_ID: 'server-1' }, hostname: 'host-1', jobStorePath: '.data/jobs.json' }),
    (error) => error instanceof LocalRuntimeConfigError && error.code === 'invalid_local_server_id',
  );
  assert.throws(
    () => resolveLocalRuntimeConfig({ env: { YUNPANEL_LOCAL_SERVER_ID: serverId }, hostname: '../host', jobStorePath: '.data/jobs.json' }),
    (error) => error instanceof LocalRuntimeConfigError && error.code === 'invalid_local_hostname',
  );
});

test('lock path is derived from the effective job store and cannot be injected independently', () => {
  const config = resolveLocalRuntimeConfig({
    env: { YUNPANEL_LOCAL_SERVER_ID: serverId, YUNPANEL_LOCAL_EXECUTOR_LOCK: '/tmp/attacker.lock' },
    hostname: 'host-1',
    jobStorePath: '.data/job-registry.json',
  });
  assert.equal(config.lockPath.endsWith('/.data/local-executor.lock'), true);
  assert.notEqual(config.lockPath, '/tmp/attacker.lock');
});
