import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStaticDeploymentEvidenceInspector } from '../src/static-deployment-evidence.js';
import { createStaticDeploymentReceiptStore } from '../src/static-deployment-receipt.js';

const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const deploymentId = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const result = Object.freeze({
  deploymentId,
  releaseId: deploymentId,
  commitSha: 'a'.repeat(40),
  previousReleaseId: null,
  artifactFiles: 3,
  artifactBytes: 1024,
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-static-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webRoot = path.join(root, 'web');
  const receiptStore = createStaticDeploymentReceiptStore({ root: path.join(root, 'receipts') });
  const inspector = createStaticDeploymentEvidenceInspector({ webRoot, receiptStore });
  return { root, webRoot, receiptStore, inspector };
}

test('receipt without matching current release is not sufficient evidence', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({ applicationId, deploymentId, result });
  assert.deepEqual(await fx.inspector.inspect({ applicationId, deploymentId }), { satisfied: false, result: null });

  const appRoot = path.join(fx.webRoot, applicationId);
  await mkdir(path.join(appRoot, 'releases', deploymentId), { recursive: true });
  await symlink(path.join('releases', '316e4db8-468b-4e2f-a021-3ab31e0f4123'), path.join(appRoot, 'current'));
  assert.deepEqual(await fx.inspector.inspect({ applicationId, deploymentId }), { satisfied: false, result: null });
});

test('receipt, exact current symlink and real release directory prove the deployment result', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({ applicationId, deploymentId, result });
  const appRoot = path.join(fx.webRoot, applicationId);
  await mkdir(path.join(appRoot, 'releases', deploymentId), { recursive: true });
  await symlink(path.join('releases', deploymentId), path.join(appRoot, 'current'));

  assert.deepEqual(await fx.inspector.inspect({ applicationId, deploymentId }), {
    satisfied: true,
    result,
  });
});

test('symlink release directory is rejected as deployment evidence', async (t) => {
  const fx = await fixture(t);
  await fx.receiptStore.write({ applicationId, deploymentId, result });
  const appRoot = path.join(fx.webRoot, applicationId);
  await mkdir(path.join(appRoot, 'releases'), { recursive: true });
  await mkdir(path.join(fx.root, 'outside-release'), { recursive: true });
  await symlink(path.join(fx.root, 'outside-release'), path.join(appRoot, 'releases', deploymentId));
  await symlink(path.join('releases', deploymentId), path.join(appRoot, 'current'));

  assert.deepEqual(await fx.inspector.inspect({ applicationId, deploymentId }), { satisfied: false, result: null });
});

test('filesystem inspection errors are redacted', async () => {
  const inspector = createStaticDeploymentEvidenceInspector({
    receiptStore: { read: async () => ({ applicationId, deploymentId, result }) },
    readlinkFn: async () => { throw new Error('/private/path TOKEN=hidden'); },
  });
  await assert.rejects(
    inspector.inspect({ applicationId, deploymentId }),
    (error) => error.code === 'static_deployment_evidence_read_failed'
      && !error.message.includes('/private')
      && !error.message.includes('hidden'),
  );
});
