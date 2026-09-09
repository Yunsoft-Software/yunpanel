import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createManagedServiceManager,
  ManagedServiceError,
  managedServicePolicy,
} from '../src/managed-service-manager.js';

const ACTIVE_UNIT = 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n';

test('managed service catalog covers the hosting service groups without arbitrary units', () => {
  assert.deepEqual(managedServicePolicy.services.map((entry) => entry.id), [
    'nginx', 'mariadb', 'mysql', 'docker', 'cron', 'postfix', 'dovecot', 'rspamd',
  ]);
  for (const entry of managedServicePolicy.services) {
    assert.ok(entry.packages.length > 0);
    assert.ok(entry.units.length > 0);
    assert.ok(entry.units.every((unit) => unit.endsWith('.service')));
  }
});

test('inspect reports package and unit state for an allowlisted service', async () => {
  const calls = [];
  const manager = createManagedServiceManager({
    run: async (file, args) => {
      calls.push([file, args]);
      if (file === '/usr/bin/dpkg-query') return { stdout: 'install ok installed\t1:10.11.13-0ubuntu0.24.04.1' };
      if (file === '/usr/bin/systemctl') return { stdout: ACTIVE_UNIT };
      throw new Error('unexpected command');
    },
  });
  const result = await manager.inspect('mariadb');
  assert.equal(result.id, 'mariadb');
  assert.equal(result.installed, true);
  assert.equal(result.active, true);
  assert.equal(result.packages[0].packageName, 'mariadb-server');
  assert.equal(result.units[0].unit, 'mariadb.service');
  assert.equal(calls.length, 2);
});

test('missing packages are reported without leaking command errors', async () => {
  const manager = createManagedServiceManager({
    run: async (file) => {
      if (file === '/usr/bin/dpkg-query') throw Object.assign(new Error('/secret/path'), { stderr: 'sensitive output' });
      return { stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=unknown\n' };
    },
  });
  const result = await manager.inspect('rspamd');
  assert.deepEqual(result.packages, [{ packageName: 'rspamd', installed: false, version: null }]);
  assert.equal(result.installed, false);
  assert.equal(result.active, false);
});

test('unknown service identifiers fail closed before a command is executed', async () => {
  let calls = 0;
  const manager = createManagedServiceManager({ run: async () => { calls += 1; return { stdout: '' }; } });
  await assert.rejects(
    manager.inspect('ssh'),
    (error) => error instanceof ManagedServiceError && error.code === 'unsupported_managed_service',
  );
  assert.equal(calls, 0);
});
