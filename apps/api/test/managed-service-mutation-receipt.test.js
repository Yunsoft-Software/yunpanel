import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createManagedServiceMutationReceiptStore,
  ManagedServiceMutationReceiptError,
} from '../src/managed-service-mutation-receipt.js';

const serverId = 'server-1';
const installJobId = '12345678-1234-4234-8234-123456789012';
const restartJobId = '87654321-1234-4234-8234-123456789012';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-service-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  return { root, store: createManagedServiceMutationReceiptStore({ root }) };
}

test('managed service receipts persist only minimal install/restart metadata with private modes', async (t) => {
  const fx = await fixture(t);
  const install = await fx.store.write({
    serverId,
    jobId: installJobId,
    operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
    serviceId: 'nginx',
    changed: true,
    result: { rawOutput: 'must-not-persist' },
  });
  const restart = await fx.store.write({
    serverId,
    jobId: restartJobId,
    operation: OPERATIONS.SYSTEM_SERVICE_CONTROL,
    serviceId: 'nginx',
    action: 'restart',
  });

  assert.equal(install.changed, true);
  assert.equal(restart.action, 'restart');
  assert.deepEqual(await fx.store.read(serverId, installJobId), install);
  assert.deepEqual(await fx.store.read(serverId, restartJobId), restart);

  assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fx.root, serverId))).mode & 0o777, 0o700);
  assert.equal((await stat(fx.store.receiptPath(serverId, installJobId))).mode & 0o777, 0o600);
  const raw = await readFile(fx.store.receiptPath(serverId, installJobId), 'utf8');
  assert.doesNotMatch(raw, /rawOutput|must-not-persist|result/i);
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
    }),
    (error) => error instanceof ManagedServiceMutationReceiptError && error.code === 'service_receipt_mutation_invalid',
  );
  await assert.rejects(
    fx.store.write({
      serverId,
      jobId: installJobId,
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      serviceId: 'nginx',
    }),
    (error) => error instanceof ManagedServiceMutationReceiptError && error.code === 'service_receipt_mutation_invalid',
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
    token: 'hidden-value',
  }), { mode: 0o600 });

  await assert.rejects(
    fx.store.read(serverId, installJobId),
    (error) => error instanceof ManagedServiceMutationReceiptError
      && error.code === 'service_receipt_invalid'
      && !error.message.includes('hidden-value'),
  );
});
