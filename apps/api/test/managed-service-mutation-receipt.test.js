import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createManagedServiceMutationReceiptStore,
  ManagedServiceMutationReceiptError,
  managedServiceStateDigest,
} from '../src/managed-service-mutation-receipt.js';

const serverId = 'server-1';
const installJobId = '12345678-1234-4234-8234-123456789012';
const restartJobId = '87654321-1234-4234-8234-123456789012';

function activeState(extra = {}) {
  return {
    id: 'nginx',
    installed: true,
    active: true,
    packages: [{ packageName: 'nginx', installed: true, version: '1.24.0-1', raw: 'must-not-persist' }],
    units: [{
      unit: 'nginx.service',
      loadState: 'loaded',
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled',
      inspectionError: false,
      rawOutput: 'must-not-persist',
    }],
    rawOutput: 'must-not-persist',
    ...extra,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-service-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  return { root, store: createManagedServiceMutationReceiptStore({ root }) };
}

test('managed service receipts persist only minimal install/restart metadata plus safe state digest with private modes', async (t) => {
  const fx = await fixture(t);
  const installState = activeState({ changed: true });
  const restartState = activeState({ action: 'restart' });
  const install = await fx.store.write({
    serverId,
    jobId: installJobId,
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    serviceId: 'nginx',
    changed: true,
    state: installState,
  });
  const restart = await fx.store.write({
    serverId,
    jobId: restartJobId,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    serviceId: 'nginx',
    action: 'restart',
    state: restartState,
  });

  assert.equal(install.changed, true);
  assert.equal(restart.action, 'restart');
  assert.equal(install.stateDigest, managedServiceStateDigest(installState, 'nginx'));
  assert.equal(restart.stateDigest, managedServiceStateDigest(restartState, 'nginx'));
  assert.deepEqual(await fx.store.read(serverId, installJobId), install);
  assert.deepEqual(await fx.store.read(serverId, restartJobId), restart);

  assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fx.root, serverId))).mode & 0o777, 0o700);
  assert.equal((await stat(fx.store.receiptPath(serverId, installJobId))).mode & 0o777, 0o600);
  const raw = await readFile(fx.store.receiptPath(serverId, installJobId), 'utf8');
  assert.doesNotMatch(raw, /rawOutput|must-not-persist|packages|units|result/i);
});

test('Roundcube package-only install state can be digested without a fabricated systemd unit', () => {
  const digest = managedServiceStateDigest({
    id: 'roundcube',
    installed: true,
    active: false,
    packages: [{ packageName: 'roundcube-core', installed: true, version: '1.6.6+dfsg-2ubuntu0.1' }],
    units: [],
    health: { status: 'installed', configuration: 'valid' },
  }, 'roundcube');
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('receipt store rejects unsupported service controls and incomplete install evidence', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId: installJobId,
      operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
      serviceId: 'nginx',
      action: 'stop',
      state: activeState({ action: 'stop' }),
    }),
    (error) => error instanceof ManagedServiceMutationReceiptError && error.code === 'service_receipt_mutation_invalid',
  );
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId: installJobId,
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      serviceId: 'nginx',
      state: activeState(),
    }),
    (error) => error instanceof ManagedServiceMutationReceiptError && error.code === 'service_receipt_mutation_invalid',
  );
});

test('invalid safe service state is rejected before any receipt is persisted', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId: installJobId,
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      serviceId: 'nginx',
      changed: true,
      state: { id: 'nginx', installed: true, active: true },
    }),
    (error) => error instanceof ManagedServiceMutationReceiptError && error.code === 'service_receipt_state_invalid',
  );
});

test('tampered receipt fields fail closed without echoing file contents', async (t) => {
  const fx = await fixture(t);
  const target = fx.store.receiptPath(serverId, installJobId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify({
    version: 1,
    recordedAt: new Date().toISOString(),
    serverId,
    jobId: installJobId,
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    serviceId: 'nginx',
    action: null,
    changed: true,
    stateDigest: 'a'.repeat(64),
    token: 'hidden-value',
  }), { mode: 0o600 });

  await assert.rejects(
    fx.store.read(serverId, installJobId),
    (error) => error instanceof ManagedServiceMutationReceiptError
      && error.code === 'service_receipt_invalid'
      && !error.message.includes('hidden-value'),
  );
});
