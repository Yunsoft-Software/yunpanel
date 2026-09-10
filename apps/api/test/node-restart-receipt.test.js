import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNodeRestartReceiptStore, NodeRestartReceiptError } from '../src/node-restart-receipt.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const releaseId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-node-restart-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  return { root, store: createNodeRestartReceiptStore({ root, now: () => Date.parse('2026-09-10T12:00:00Z') }) };
}

function result(extra = {}) {
  return {
    releaseId,
    serviceName: 'yunpanel-node-0123456789abcdef.service',
    port: 3100,
    healthPath: '/health',
    healthy: true,
    restarted: true,
    ...extra,
  };
}

test('Node restart receipt persists only bounded recovery identity with private modes', async (t) => {
  const fx = await fixture(t);
  const receipt = await fx.store.write({ serverId, jobId, applicationId, result: result({ stdout: 'SECRET' }) });
  assert.deepEqual(await fx.store.read(serverId, jobId), receipt);
  assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(fx.root, serverId))).mode & 0o777, 0o700);
  assert.equal((await stat(fx.store.receiptPath(serverId, jobId))).mode & 0o777, 0o600);
  const raw = await readFile(fx.store.receiptPath(serverId, jobId), 'utf8');
  assert.doesNotMatch(raw, /SECRET|stdout|healthy|restarted/);
});

test('Node restart receipt refuses unconfirmed or malformed runtime results', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    fx.store.write({ serverId, jobId, applicationId, result: result({ restarted: false }) }),
    (error) => error instanceof NodeRestartReceiptError && error.code === 'node_restart_receipt_result_invalid',
  );
  await assert.rejects(
    fx.store.write({ serverId, jobId, applicationId, result: result({ healthPath: 'relative' }) }),
    (error) => error instanceof NodeRestartReceiptError && error.code === 'node_restart_receipt_invalid',
  );
});
