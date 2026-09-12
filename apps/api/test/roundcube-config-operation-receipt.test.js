import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRoundcubeConfigOperationReceiptStore,
  RoundcubeConfigOperationReceiptError,
} from '../src/roundcube-config-operation-receipt.js';

const SERVER = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const JOB = '12345678-1234-4234-8234-123456789012';
const receipt = {
  serverId: SERVER,
  jobId: JOB,
  previewSha256: 'a'.repeat(64),
  configSha256: 'b'.repeat(64),
  fpmSha256: 'c'.repeat(64),
  nginxSha256: 'd'.repeat(64),
  databaseCreated: true,
  httpHealthy: true,
  applied: true,
};

async function temp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-roundcube-receipt-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('Roundcube receipt persists only bounded secret-free recovery evidence', async () => temp(async (root) => {
  const store = createRoundcubeConfigOperationReceiptStore({ root, now: () => Date.parse('2026-09-13T00:00:00.000Z') });
  const saved = await store.write(receipt);
  assert.equal(saved.recordedAt, '2026-09-13T00:00:00.000Z');
  assert.equal(saved.nginxSha256, 'd'.repeat(64));
  assert.equal(saved.httpHealthy, true);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  const target = store.receiptPath(SERVER, JOB);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const raw = await readFile(target, 'utf8');
  assert.doesNotMatch(raw, /des_key|privateKey|fullchain|password|command|configContent|nginxContent/);
  assert.deepEqual(await store.read(SERVER, JOB), saved);
}));

test('Roundcube receipt fails closed on unsafe mode, unhealthy web state and extra persisted fields', async () => temp(async (root) => {
  const store = createRoundcubeConfigOperationReceiptStore({ root });
  await store.write(receipt);
  const target = store.receiptPath(SERVER, JOB);
  const { chmod } = await import('node:fs/promises');
  await chmod(target, 0o644);
  await assert.rejects(store.read(SERVER, JOB), (error) => error instanceof RoundcubeConfigOperationReceiptError
    && error.code === 'roundcube_receipt_unsafe');

  await chmod(target, 0o600);
  const parsed = JSON.parse(await readFile(target, 'utf8'));
  parsed.httpHealthy = false;
  await writeFile(target, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(store.read(SERVER, JOB), (error) => error instanceof RoundcubeConfigOperationReceiptError
    && error.code === 'roundcube_receipt_invalid');

  parsed.httpHealthy = true;
  parsed.secret = 'must-not-be-accepted';
  await writeFile(target, JSON.stringify(parsed), { mode: 0o600 });
  await assert.rejects(store.read(SERVER, JOB), (error) => error instanceof RoundcubeConfigOperationReceiptError
    && error.code === 'roundcube_receipt_invalid');
}));
