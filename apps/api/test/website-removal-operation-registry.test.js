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
      'application_cleanup',
    ]);

    // Step resources match
    assert.equal(op.steps[0].resourceId, 'dom-sub');
    assert.equal(op.steps[1].resourceId, 'dom-root');
    assert.equal(op.steps[2].resourceId, 'ws-1');
    assert.equal(op.steps[7].resourceId, 'yunapp-site1');
    assert.equal(op.steps[8].resourceId, 'ws-1');
    assert.equal(op.steps[9].resourceId, 'app-1');

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


test('running step checkpoints persist across registry restart without marking the step complete', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteRemovalOperationRegistry({ filePath });
    await registry.init();
    const op = await registry.create(mockPreview());
    const step = op.steps.find((entry) => entry.kind === 'cron_cleanup');
    const checkpoint = {
      version: 1,
      tasks: [{ identity: { taskId: 'cron-1' }, jobId: 'job-cron-1', status: 'queued' }],
    };
    const running = await registry.checkpointStep(op.id, step.id, checkpoint);
    assert.equal(running.status, 'running');
    assert.equal(running.steps.find((entry) => entry.id === step.id).status, 'running');
    assert.deepEqual(running.steps.find((entry) => entry.id === step.id).result, checkpoint);

    checkpoint.tasks[0].status = 'failed';
    const reopened = createWebsiteRemovalOperationRegistry({ filePath });
    await reopened.init();
    const restored = await reopened.get(op.id);
    const restoredStep = restored.steps.find((entry) => entry.id === step.id);
    assert.equal(restoredStep.status, 'running');
    assert.equal(restoredStep.result.tasks[0].status, 'queued');
  });
});


test('direct-systemd Application creates a runtime cleanup step without runtime-binding metadata', async () => {
  const website = {
    id: 'ws-direct',
    name: 'direct-site',
    serverId: 'srv-local',
    applicationId: 'app-direct',
    systemUser: null,
    desiredRevision: 1,
  };
  const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
  const impact = {
    version: 1,
    resourceType: 'website',
    resource: { id: website.id, serverId: website.serverId },
    application: {
      id: website.applicationId,
      serverId: website.serverId,
      name: 'direct-app',
      type: 'node',
      state: 'active',
      desiredRevision: 3,
      currentReleaseId: releaseId,
      activeDeploymentId: null,
    },
    operation: 'delete',
    targetServerId: null,
    dependencies: {
      domains: [],
      databases: { status: 'available', items: [] },
      sftpKeys: { status: 'available', items: [] },
      runtimeBindings: { status: 'available', items: [] },
      unixIdentities: { status: 'available', items: [] },
      logScopes: { status: 'available', items: [] },
      crons: { status: 'available', items: [] },
      backups: { status: 'available', items: [] },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'd'.repeat(64),
    confirmation: `delete:website:${website.id}:${'d'.repeat(64)}`,
  };
  const preview = createWebsiteRemovalPreview({
    website,
    impact,
    applicationState: {
      ...impact.application,
      runtimeAdapter: 'direct-systemd',
      serviceName: 'yunpanel-node-aaaaaaaaaaaaaaaa.service',
      currentCommitSha: 'b'.repeat(40),
      servicePort: 3100,
      healthPath: '/health',
    },
  });
  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();
  const operation = await registry.create(preview);
  assert.deepEqual(operation.steps.map((step) => step.kind), [
    'runtime_cleanup',
    'file_cleanup',
    'metadata_finalization',
    'application_cleanup',
  ]);
});


function bareRemovalPreview(websiteId) {
  return {
    operation: 'website_remove',
    readyToStart: true,
    website: {
      id: websiteId,
      serverId: 'server-a',
      applicationId: null,
      systemUser: null,
      desiredRevision: 1,
    },
    plan: {
      domainIds: [],
      applicationId: null,
      applicationRevision: null,
      applicationRuntime: null,
      systemUser: null,
      additional: {
        databases: { status: 'available', ids: [] },
        sftpKeys: { status: 'available', ids: [] },
        runtimeBindings: { status: 'available', ids: [] },
        unixIdentities: { status: 'available', ids: [] },
        logScopes: { status: 'available', ids: [] },
        crons: { status: 'available', ids: [] },
        backups: { status: 'available', ids: [] },
      },
    },
    previewDigest: 'f'.repeat(64),
    confirmation: `start-website-remove:${websiteId}:1:${'f'.repeat(64)}`,
  };
}

test('independent removal registries reload under the store lock and preserve different-site writes', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'shared-removals.json');
    const left = createWebsiteRemovalOperationRegistry({ filePath });
    const right = createWebsiteRemovalOperationRegistry({ filePath });
    await Promise.all([left.init(), right.init()]);

    const [first, second] = await Promise.all([
      left.create(bareRemovalPreview('site-a')),
      right.create(bareRemovalPreview('site-b')),
    ]);
    assert.notEqual(first.id, second.id);
    assert.deepEqual((await left.list()).map((entry) => entry.websiteId).sort(), ['site-a', 'site-b']);
    assert.deepEqual((await right.list()).map((entry) => entry.websiteId).sort(), ['site-a', 'site-b']);
  });
});


test('private Owner actor evidence survives restart without entering public operation views', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'actor-removals.json');
    const actor = {
      sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      role: 'owner',
    };
    const registry = createWebsiteRemovalOperationRegistry({ filePath });
    await registry.init();
    const operation = await registry.create(bareRemovalPreview('site-actor'), { actor });
    assert.equal(Object.hasOwn(operation, 'actor'), false);
    assert.deepEqual(await registry.getActor(operation.id), actor);

    const reopened = createWebsiteRemovalOperationRegistry({ filePath });
    await reopened.init();
    assert.deepEqual(await reopened.getActor(operation.id), actor);
    const publicOperation = await reopened.get(operation.id);
    assert.equal(Object.hasOwn(publicOperation, 'actor'), false);
    assert.doesNotMatch(JSON.stringify(publicOperation), /aaaaaaaa-aaaa|bbbbbbbb-bbbb/);
  });
});
