import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager, NginxManagerError } from '../src/nginx-manager.js';

const spec = Object.freeze({
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  targetType: 'proxy',
  target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true },
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-nginx-deactivation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'staging');
  const sitesDir = path.join(root, 'sites');
  await mkdir(sitesDir, { recursive: true });
  return {
    stagingDir,
    sitesDir,
    activePath: path.join(sitesDir, 'yunpanel-example.com.conf'),
  };
}

function managerFor({ stagingDir, sitesDir, execFn = async () => '' }) {
  return createNginxManager({ stagingDir, sitesDir, execFn });
}

async function activate(manager) {
  const staged = await manager.stageDomain(spec);
  await manager.activateDomain({ primaryDomain: spec.primaryDomain, checksum: staged.checksum });
  return staged;
}

test('exact Nginx deactivation survives restart and rollback restores only its retained active config', async (t) => {
  const state = await fixture(t);
  const first = managerFor(state);
  const staged = await activate(first);
  const active = await readFile(state.activePath, 'utf8');

  const deactivated = await first.deactivateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(deactivated.satisfied, true);
  assert.equal(deactivated.deactivated, true);
  assert.equal(deactivated.changed, true);
  assert.equal(deactivated.restorable, true);
  assert.equal(deactivated.receiptVersion, 1);
  await assert.rejects(readFile(state.activePath, 'utf8'), (error) => error?.code === 'ENOENT');

  const restarted = managerFor(state);
  const inspected = await restarted.inspectDomainDeactivation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(inspected.satisfied, true);
  assert.equal(inspected.restorable, true);

  const restored = await restarted.rollbackDomainDeactivation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(restored.satisfied, true);
  assert.equal(restored.restored, true);
  assert.equal(restored.changed, true);
  assert.equal(await readFile(state.activePath, 'utf8'), active);
});

test('deactivation refuses active config drift without removing operator state', async (t) => {
  const state = await fixture(t);
  const manager = managerFor(state);
  const staged = await activate(manager);
  const foreign = '# operator changed active vhost\n';
  await writeFile(state.activePath, foreign, 'utf8');

  await assert.rejects(
    manager.deactivateDomain({
      primaryDomain: spec.primaryDomain,
      checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_deactivation_drift',
  );
  assert.equal(await readFile(state.activePath, 'utf8'), foreign);
});

test('deactivation does not claim an already absent vhost without its own receipt', async (t) => {
  const state = await fixture(t);
  const manager = managerFor(state);
  const staged = await manager.stageDomain(spec);

  const inspected = await manager.inspectDomainDeactivation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(inspected.satisfied, false);
  assert.equal(inspected.deactivationCandidate, false);
  assert.equal(inspected.restorable, false);
  assert.equal(inspected.reason, 'nginx_deactivation_unowned_absence');

  await assert.rejects(
    manager.deactivateDomain({
      primaryDomain: spec.primaryDomain,
      checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError
      && error.code === 'nginx_deactivation_unowned_absence',
  );
});

test('failed deactivation restores exact active config instead of leaving traffic half-suspended', async (t) => {
  const state = await fixture(t);
  let phase = 'activate';
  let deactivationChecks = 0;
  const execFn = async (file, args) => {
    if (phase === 'deactivate' && file.endsWith('/nginx') && args[0] === '-t') {
      deactivationChecks += 1;
      if (deactivationChecks === 1) throw new Error('synthetic configtest failure');
    }
    return '';
  };
  const manager = managerFor({ ...state, execFn });
  const staged = await activate(manager);
  const active = await readFile(state.activePath, 'utf8');
  phase = 'deactivate';

  await assert.rejects(
    manager.deactivateDomain({
      primaryDomain: spec.primaryDomain,
      checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError && error.code === 'nginx_deactivation_failed',
  );
  assert.equal(deactivationChecks, 2);
  assert.equal(await readFile(state.activePath, 'utf8'), active);
  const inspected = await manager.inspectDomainDeactivation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(inspected.satisfied, false);
  assert.equal(inspected.deactivationCandidate, true);
  assert.equal(inspected.restorable, true);
});

test('rollback refuses to overwrite foreign config that appeared after deactivation', async (t) => {
  const state = await fixture(t);
  const manager = managerFor(state);
  const staged = await activate(manager);
  await manager.deactivateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  const foreign = '# foreign replacement\n';
  await writeFile(state.activePath, foreign, 'utf8');

  await assert.rejects(
    manager.rollbackDomainDeactivation({
      primaryDomain: spec.primaryDomain,
      checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError
      && error.code === 'nginx_deactivation_rollback_drift',
  );
  assert.equal(await readFile(state.activePath, 'utf8'), foreign);
});

test('failed deactivation rollback returns to exact suspended state', async (t) => {
  const state = await fixture(t);
  let phase = 'activate';
  let rollbackChecks = 0;
  const execFn = async (file, args) => {
    if (phase === 'rollback' && file.endsWith('/nginx') && args[0] === '-t') {
      rollbackChecks += 1;
      if (rollbackChecks === 1) throw new Error('synthetic rollback configtest failure');
    }
    return '';
  };
  const manager = managerFor({ ...state, execFn });
  const staged = await activate(manager);
  await manager.deactivateDomain({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  phase = 'rollback';

  await assert.rejects(
    manager.rollbackDomainDeactivation({
      primaryDomain: spec.primaryDomain,
      checksum: staged.checksum,
    }),
    (error) => error instanceof NginxManagerError
      && error.code === 'nginx_deactivation_restore_failed',
  );
  assert.equal(rollbackChecks, 2);
  await assert.rejects(readFile(state.activePath, 'utf8'), (error) => error?.code === 'ENOENT');
  const inspected = await manager.inspectDomainDeactivation({
    primaryDomain: spec.primaryDomain,
    checksum: staged.checksum,
  });
  assert.equal(inspected.satisfied, true);
});
