import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createStaticDeploymentReceiptStore,
  StaticDeploymentReceiptError,
} from '../src/static-deployment-receipt.js';

const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const deploymentId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const previousReleaseId = '316e4db8-468b-4e2f-a021-3ab31e0f4123';
const result = Object.freeze({
  deploymentId,
  releaseId: deploymentId,
  commitSha: 'a'.repeat(40),
  previousReleaseId,
  artifactFiles: 12,
  artifactBytes: 4096,
});

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-receipt-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'receipts');
  return { root, store: createStaticDeploymentReceiptStore({ root, now: () => Date.parse('2026-09-10T10:00:00.000Z') }) };
}

function mode(info) {
  return info.mode & 0o777;
}

test('static deployment receipt round-trips only authored metadata with private modes', async (t) => {
  const { root, store } = await fixture(t);
  const receipt = await store.write({ applicationId, deploymentId, result });
  assert.deepEqual(receipt, {
    version: 1,
    recordedAt: '2026-09-10T10:00:00.000Z',
    applicationId,
    deploymentId,
    result,
  });
  assert.deepEqual(await store.read(applicationId, deploymentId), receipt);

  const target = store.receiptPath(applicationId, deploymentId);
  assert.equal(mode(await stat(root)), 0o700);
  assert.equal(mode(await stat(path.dirname(target))), 0o700);
  assert.equal(mode(await stat(target)), 0o600);
  assert.doesNotMatch(await readFile(target, 'utf8'), /password|token|secret|environment|repositoryUrl/i);
});

test('existing permissive receipt directories are tightened before writing', async (t) => {
  const { root, store } = await fixture(t);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, applicationId), { recursive: true }));
  await chmod(root, 0o777);
  await chmod(path.join(root, applicationId), 0o777);
  await store.write({ applicationId, deploymentId, result });
  assert.equal(mode(await stat(root)), 0o700);
  assert.equal(mode(await stat(path.join(root, applicationId))), 0o700);
});

test('receipt rejects extra result fields before persisting them', async (t) => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.write({ applicationId, deploymentId, result: { ...result, token: 'do-not-store' } }),
    (error) => error instanceof StaticDeploymentReceiptError && error.code === 'invalid_static_receipt_result',
  );
  await assert.rejects(readFile(store.receiptPath(applicationId, deploymentId), 'utf8'), { code: 'ENOENT' });
});

test('missing receipt is null while malformed persisted receipt fails closed', async (t) => {
  const { store } = await fixture(t);
  assert.equal(await store.read(applicationId, deploymentId), null);
  const target = store.receiptPath(applicationId, deploymentId);
  await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
  await writeFile(target, JSON.stringify({ version: 1, applicationId, deploymentId, result: { ...result, token: 'bad' } }), { mode: 0o600 });
  await assert.rejects(
    store.read(applicationId, deploymentId),
    (error) => error instanceof StaticDeploymentReceiptError && error.code.startsWith('invalid_static_receipt'),
  );
});
