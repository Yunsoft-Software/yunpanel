import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createWebsiteRemovalOperationRegistry,
} from '../src/website-removal-operation-registry.js';
import {
  createWebsiteRemovalPreview,
} from '../src/website-removal-plan.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ws-rem-reg-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mockPreview() {
  const website = {
    id: 'ws-1',
    name: 'test-site',
    serverId: 'srv-local',
    applicationId: 'app-1',
    systemUser: 'yunapp-site1',
    desiredRevision: 1,
  };
  const impact = {
    version: 1,
    resourceType: 'website',
    resource: { id: 'ws-1', serverId: 'srv-local' },
    operation: 'delete',
    targetServerId: null,
    dependencies: {
      domains: [
        { id: 'dom-sub', primaryDomain: 'sub.example.com', parentDomainId: 'dom-root' },
        { id: 'dom-root', primaryDomain: 'example.com', parentDomainId: null },
      ],
      databases: { status: 'available', items: [{ id: 'db-1', state: 'mydb' }] },
      sftpKeys: { status: 'available', items: [{ id: 'key-1', state: 'active' }] },
      runtimeBindings: { status: 'available', items: [{ id: 'rb-1', state: 'active' }] },
      unixIdentities: { status: 'available', items: [{ id: 'yunapp-site1', state: 'active' }] },
      logScopes: { status: 'available', items: [{ id: 'ws-1', state: 'managed' }] },
      crons: { status: 'available', items: [{ id: 'cron-1', state: 'active' }] },
      backups: { status: 'available', items: [] },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'b'.repeat(64),
    confirmation: `delete:website:ws-1:${'b'.repeat(64)}`,
  };
  return createWebsiteRemovalPreview({ website, impact });
}

test('creates durable website removal operation with ordered reverse-order steps', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteRemovalOperationRegistry({ filePath });
    await registry.init();

    const preview = mockPreview();
    const op = await registry.create(preview);

    assert.ok(op.id.startsWith('ws-rem-'));
    assert.equal(op.websiteId, 'ws-1');
    assert.equal(op.status, 'pending');

    // Verify reverse-order step kinds
    const stepKinds = op.steps.map((s) => s.kind);
    assert.deepEqual(stepKinds, [
      'domain_removal', // dom-sub
      'domain_removal', // dom-root
      'cron_cleanup',
      'sftp_key_cleanup',
      'database_binding_cleanup',
      'runtime_cleanup',
      'file_cleanup',
      'unix_identity_cleanup',
      'metadata_finalization',
    ]);

    // Step resources match
    assert.equal(op.steps[0].resourceId, 'dom-sub');
    assert.equal(op.steps[1].resourceId, 'dom-root');
    assert.equal(op.steps[2].resourceId, 'ws-1');
    assert.equal(op.steps[7].resourceId, 'yunapp-site1');
    assert.equal(op.steps[8].resourceId, 'ws-1');

    // Test persistence across restart
    const registry2 = createWebsiteRemovalOperationRegistry({ filePath });
    await registry2.init();
    const reloaded = await registry2.get(op.id);
    assert.equal(reloaded.id, op.id);
    assert.equal(reloaded.steps.length, op.steps.length);
  });
});

test('transitions steps and updates overall status to removed when all succeed', async () => {
  await withTempDir(async (tempDir) => {
    const registry = createWebsiteRemovalOperationRegistry();
    await registry.init();

    const preview = mockPreview();
    const op = await registry.create(preview);

    // Step 1 running -> succeeded
    const step1 = op.steps[0];
    const running = await registry.markStepRunning(op.id, step1.id);
    assert.equal(running.status, 'running');
    assert.equal(running.steps[0].status, 'running');

    const succeeded = await registry.succeedStep(op.id, step1.id, { removed: true });
    assert.equal(succeeded.steps[0].status, 'succeeded');

    // Succeed all remaining steps
    for (let i = 1; i < op.steps.length; i++) {
      await registry.succeedStep(op.id, op.steps[i].id, { ok: true });
    }

    const completed = await registry.get(op.id);
    assert.equal(completed.status, 'removed');
  });
});
