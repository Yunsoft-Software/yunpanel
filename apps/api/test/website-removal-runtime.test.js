import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWebsiteRemovalOperationRegistry,
} from '../src/website-removal-operation-registry.js';
import {
  createWebsiteRemovalRuntime,
  WebsiteRemovalRuntimeError,
} from '../src/website-removal-runtime.js';
import {
  createWebsiteRemovalPreview,
} from '../src/website-removal-plan.js';

function mockPreview({ withDomains = true, backups = [] } = {}) {
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
      domains: withDomains ? [{ id: 'dom-1', primaryDomain: 'example.com', parentDomainId: null }] : [],
      databases: { status: 'available', items: [{ id: 'db-1', state: 'mydb' }] },
      sftpKeys: { status: 'available', items: [{ id: 'key-1', state: 'active' }] },
      runtimeBindings: { status: 'available', items: [{ id: 'rb-1', state: 'active' }] },
      unixIdentities: { status: 'available', items: [{ id: 'yunapp-site1', state: 'active' }] },
      logScopes: { status: 'available', items: [{ id: 'ws-1', state: 'managed' }] },
      crons: { status: 'available', items: [{ id: 'cron-1', state: 'active' }] },
      backups: { status: 'available', items: backups },
      activeJobs: [],
    },
    blockers: [],
    previewDigest: 'c'.repeat(64),
    confirmation: `delete:website:ws-1:${'c'.repeat(64)}`,
  };
  return createWebsiteRemovalPreview({ website, impact });
}

test('website-removal-runtime coordinates domain removal child operation before advancing to file/unix cleanup', async () => {
  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  let childOp = null;
  const domainRemovalRuntime = {
    listForDomain: async () => (childOp ? [childOp] : []),
    preview: async () => ({ confirmation: 'start-domain-remove:dom-1:1:xyz' }),
    start: async () => {
      childOp = {
        id: 'dom-rem-1',
        domainId: 'dom-1',
        status: 'running',
        actions: {
          stepContinuationConfirmation: 'continue-domain-remove-step:dom-1:dom-rem-1:step-1:time',
        },
      };
      return childOp;
    },
    continueStep: async () => {
      childOp = { id: 'dom-rem-1', domainId: 'dom-1', status: 'removed' };
      return childOp;
    },
  };

  const actionsCalled = [];
  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => mockPreview(),
    domainRemovalRuntime,
    websiteCronRegistry: {
      listTasks: async () => [{ id: 'cron-1' }],
      removeTask: async (id) => actionsCalled.push(`removeCron:${id}`),
    },
    websiteSftpKeyRegistry: {
      listKeys: async () => [{ id: 'key-1' }],
      revokeKey: async (id) => actionsCalled.push(`revokeKey:${id}`),
    },
    databaseBindingRegistry: {
      listBindings: async () => [{ id: 'db-1' }],
      removeBinding: async (id) => actionsCalled.push(`removeDb:${id}`),
    },
    runtimeBindingRegistry: {
      getBinding: async () => ({ revision: 1 }),
      removeOwnedPassenger: async () => actionsCalled.push('removePassenger'),
    },
    fileCleanupHandler: async () => actionsCalled.push('cleanFiles'),
    unixIdentityCleanupHandler: async () => actionsCalled.push('cleanUnix'),
  });

  const preview = mockPreview();
  // 1. Start operation -> should execute step 1 (domain_removal) and wait for domain to complete
  let op = await runtime.start({ confirmation: preview.confirmation });
  assert.equal(op.status, 'running');
  assert.equal(op.steps[0].kind, 'domain_removal');
  // At this point, files or unix have NOT been touched because domain removal is not completed!
  assert.deepEqual(actionsCalled, []);

  // 2. Continue step -> domainRemoval completes -> domain_removal step succeeds!
  op = await runtime.continueStep({
    websiteId: 'ws-1',
    operationId: op.id,
    stepId: op.steps[0].id,
    expectedUpdatedAt: op.updatedAt,
    confirmation: op.actions.stepContinuationConfirmation,
  });
  assert.equal(op.steps[0].status, 'succeeded');

  // 3. Now advance subsequent steps in reverse order
  while (op.status === 'running') {
    const nextStep = op.steps.find((s) => s.status !== 'succeeded');
    if (!nextStep) break;
    op = await runtime.continueStep({
      websiteId: 'ws-1',
      operationId: op.id,
      stepId: nextStep.id,
      expectedUpdatedAt: op.updatedAt,
      confirmation: op.actions.stepContinuationConfirmation,
    });
  }

  // Verify all steps completed and exact actions called in reverse order!
  assert.equal(op.status, 'removed');
  assert.deepEqual(actionsCalled, [
    'removeCron:cron-1',
    'revokeKey:key-1',
    'removeDb:db-1',
    'removePassenger',
    'cleanFiles',
    'cleanUnix',
  ]);
});

test('website-removal-runtime init inspects interrupted running steps and blocks them without replay', async () => {
  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const preview = mockPreview({ withDomains: false });
  const op = await registry.create(preview);
  await registry.markStepRunning(op.id, op.steps[0].id);

  // Re-init with runtime
  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { start: async () => {} },
  });
  await runtime.init();

  const inspected = await runtime.get(op.id);
  assert.equal(inspected.status, 'blocked');
  assert.equal(inspected.steps[0].status, 'blocked');
  assert.equal(inspected.steps[0].error.code, 'website_removal_interrupted');
});

test('website-removal-runtime cleans up database credentials and passes retainedBackups to file cleanup', async () => {
  const registry = createWebsiteRemovalOperationRegistry();
  await registry.init();

  const preview = mockPreview({
    withDomains: false,
    backups: [{ id: 'backup-1' }, { id: 'backup-2' }],
  });

  const actions = [];
  const runtime = createWebsiteRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    domainRemovalRuntime: { start: async () => {} },
    databaseCredentialRegistry: {
      getForBinding: async (bindingId) => ({ id: `cred-${bindingId}`, revision: 2 }),
      deleteCredential: async (credId, opts) => {
        actions.push({ type: 'deleteCredential', credId, confirmation: opts.confirmation });
      },
    },
    databaseBindingRegistry: {
      listBindings: async () => [{ id: 'db-1', databaseName: 'mydb', revision: 3 }],
      unbindDatabase: async (bindingId, opts) => {
        actions.push({ type: 'unbindDatabase', bindingId, confirmation: opts.confirmation });
      },
    },
    fileCleanupHandler: async ({ websiteId, applicationId, retainedBackups }) => {
      actions.push({ type: 'fileCleanup', websiteId, applicationId, retainedBackups });
      return { cleanedFilesCount: 42 };
    },
  });

  let op = await runtime.start({ confirmation: preview.confirmation });
  // Step through until database_binding_cleanup
  while (op.status === 'running') {
    const nextStep = op.steps.find((s) => s.status !== 'succeeded');
    if (!nextStep) break;
    op = await runtime.continueStep({
      websiteId: 'ws-1',
      operationId: op.id,
      stepId: nextStep.id,
      expectedUpdatedAt: op.updatedAt,
      confirmation: op.actions.stepContinuationConfirmation,
    });
  }

  assert.equal(op.status, 'removed');
  // Verify credential was deleted with typed confirmation before unbind
  const credAction = actions.find((a) => a.type === 'deleteCredential');
  assert.ok(credAction);
  assert.equal(credAction.credId, 'cred-db-1');
  assert.equal(credAction.confirmation, 'delete-database-credential:cred-db-1:2');

  // Verify database was unbound with typed confirmation
  const unbindAction = actions.find((a) => a.type === 'unbindDatabase');
  assert.ok(unbindAction);
  assert.equal(unbindAction.bindingId, 'db-1');
  assert.equal(unbindAction.confirmation, 'unbind-database:db-1:3');

  // Verify file cleanup received retainedBackups
  const fileAction = actions.find((a) => a.type === 'fileCleanup');
  assert.ok(fileAction);
  assert.deepEqual(fileAction.retainedBackups, ['backup-1', 'backup-2']);

  // Check step results
  const dbStep = op.steps.find((s) => s.kind === 'database_binding_cleanup');
  assert.equal(dbStep.status, 'succeeded');
  assert.equal(dbStep.result.databaseBindingsCleaned, true);
  assert.equal(dbStep.result.unboundBindings.length, 1);
  assert.equal(dbStep.result.unboundBindings[0].databaseName, 'mydb');

  const fileStep = op.steps.find((s) => s.kind === 'file_cleanup');
  assert.equal(fileStep.status, 'succeeded');
  assert.equal(fileStep.result.filesCleaned, true);
  assert.deepEqual(fileStep.result.retainedBackups, ['backup-1', 'backup-2']);
  assert.equal(fileStep.result.cleanedFilesCount, 42);
});

