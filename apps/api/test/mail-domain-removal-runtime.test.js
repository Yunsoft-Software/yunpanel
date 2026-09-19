import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createMailDomainRemovalOperationRegistry } from '../src/mail-domain-removal-operation-registry.js';
import {
  createMailDomainRemovalRuntime,
  MailDomainRemovalRuntimeError,
} from '../src/mail-domain-removal-runtime.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const parentOperationId = '22345678-1234-4234-8234-123456789012';
const mailDomainId = '32345678-1234-4234-8234-123456789012';
const webDomainId = '42345678-1234-4234-8234-123456789012';
const previewDigest = 'a'.repeat(64);
const cleanupEvidenceDigest = 'b'.repeat(64);

function removalPlan(managementMode) {
  return {
    version: 1,
    mailDomainId,
    mailboxes: [],
    aliases: [],
    quotas: [],
    forwardings: [],
    dkim: null,
    mailData: managementMode === 'local'
      ? { present: false, bytes: 0, snapshotSha256: 'd'.repeat(64) }
      : null,
  };
}

function removalPreview({ managementMode = 'local', status = 'enabled', overrides = {} } = {}) {
  const cleanupPlan = removalPlan(managementMode);
  return {
    version: 1,
    operation: 'mail_domain_remove',
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode,
      status,
      revision: 5,
      updatedAt: '2026-09-19T08:00:00.000Z',
    },
    parentOperationId,
    removalMethod: managementMode === 'local'
      ? 'local_verified_data_finalize'
      : 'external_metadata_unlink',
    cleanupPlan,
    planDigest: createHash('sha256').update(JSON.stringify(cleanupPlan)).digest('hex'),
    readyToStart: true,
    blockers: [],
    previewDigest,
    confirmation: `remove-mail-domain:${mailDomainId}:${parentOperationId}:${previewDigest}`,
    sideEffects: false,
    ...overrides,
  };
}

function emptyEvidence() {
  return {
    disableJobId: null,
    finalRevision: null,
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
  };
}

function localEvidence(overrides = {}) {
  return {
    disableJobId: 'mail-config-job-1',
    finalRevision: 6,
    cleanupEvidenceDigest,
    dataDeleteJobId: 'mail-delete-job-1',
    backupId: 'mail-backup-job-1',
    ...overrides,
  };
}

function outcome(operation, disposition, details = {}, sideEffects = true) {
  return {
    version: 1,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    fromStatus: operation.status,
    disposition,
    sideEffects,
    ...details,
  };
}

function registry() {
  let clock = Date.parse('2026-09-19T09:00:00.000Z');
  return createMailDomainRemovalOperationRegistry({
    now: () => clock++,
    idFactory: () => operationId,
  });
}

function runtimeFixture({
  operationRegistry = registry(),
  preview = removalPreview(),
  executor,
  inspector = async (operation) => outcome(operation, 'blocked', {
    error: { code: 'mail_domain_removal_retry_required', message: 'Explicit retry is required' },
  }, false),
} = {}) {
  let executorCalls = 0;
  let inspectorCalls = 0;
  const runtime = createMailDomainRemovalRuntime({
    registry: operationRegistry,
    previewProvider: async ({ mailDomainId: requestedId, parentOperationId: requestedParent }) => {
      assert.equal(requestedId, mailDomainId);
      assert.equal(requestedParent, parentOperationId);
      return preview;
    },
    stepExecutor: async (operation) => {
      executorCalls += 1;
      return executor(operation, executorCalls);
    },
    stepInspector: async (operation) => {
      inspectorCalls += 1;
      return inspector(operation, inspectorCalls);
    },
  });
  return {
    runtime,
    registry: operationRegistry,
    counts: () => ({ executorCalls, inspectorCalls }),
  };
}

function startInput(preview = removalPreview()) {
  return {
    mailDomainId,
    parentOperationId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  };
}

function retryInput(operation) {
  return {
    mailDomainId,
    parentOperationId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    confirmation: operation.recovery.retryConfirmation,
  };
}

test('start journals current preview before executing one local phase', async () => {
  const state = runtimeFixture({
    executor: async (operation) => outcome(operation, 'advance', {
      status: 'disabling',
      evidence: emptyEvidence(),
    }),
  });

  const operation = await state.runtime.start(startInput());

  assert.equal(operation.status, 'disabling');
  assert.equal(operation.parentOperationId, parentOperationId);
  assert.equal(operation.previewDigest, previewDigest);
  assert.equal(operation.recovery.automaticReplayBlocked, true);
  assert.deepEqual(state.counts(), { executorCalls: 1, inspectorCalls: 0 });
  assert.equal((await state.registry.get(operation.id)).confirmation, removalPreview().confirmation);
});

test('explicit retries advance exactly one durable local phase through verified removal', async () => {
  const state = runtimeFixture({
    executor: async (operation) => {
      if (operation.status === 'pending') {
        return outcome(operation, 'advance', { status: 'disabling', evidence: emptyEvidence() });
      }
      if (operation.status === 'disabling') {
        return outcome(operation, 'advance', {
          status: 'cleaning',
          evidence: localEvidence({ cleanupEvidenceDigest: null, dataDeleteJobId: null, backupId: null }),
        });
      }
      if (operation.status === 'cleaning') {
        return outcome(operation, 'advance', {
          status: 'deleting_data',
          evidence: localEvidence({ dataDeleteJobId: null }),
        });
      }
      if (operation.status === 'deleting_data' && operation.dataDeleteJobId === null) {
        return outcome(operation, 'advance', {
          status: 'deleting_data',
          evidence: localEvidence(),
        });
      }
      if (operation.status === 'deleting_data') {
        return outcome(operation, 'advance', {
          status: 'finalizing',
          evidence: localEvidence(),
        });
      }
      return outcome(operation, 'removed', { deletedAt: '2026-09-19T09:30:00.000Z' });
    },
  });
  let operation = await state.runtime.start(startInput());
  const statuses = [operation.status];
  while (operation.status !== 'removed') {
    operation = await state.runtime.retry(retryInput(operation));
    statuses.push(operation.status);
  }

  assert.deepEqual(statuses, [
    'disabling', 'cleaning', 'deleting_data', 'deleting_data', 'finalizing', 'removed',
  ]);
  assert.equal(operation.result.disableJobId, 'mail-config-job-1');
  assert.equal(operation.result.dataDeleteJobId, 'mail-delete-job-1');
  assert.equal(operation.result.backupId, 'mail-backup-job-1');
  assert.deepEqual(state.counts(), { executorCalls: 6, inspectorCalls: 0 });
});

test('startup reconciles interrupted evidence only through inspector and never calls executor', async () => {
  const operationRegistry = registry();
  let operation = await operationRegistry.create(removalPreview());
  operation = await operationRegistry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: emptyEvidence(),
  });
  const state = runtimeFixture({
    operationRegistry,
    executor: async () => { throw new Error('executor must not run during startup'); },
    inspector: async (current) => outcome(current, 'advance', {
      status: 'cleaning',
      evidence: localEvidence({ cleanupEvidenceDigest: null, dataDeleteJobId: null, backupId: null }),
    }, false),
  });

  const recovery = await state.runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].reconciled, true);
  assert.equal(recovery[0].operation.status, 'cleaning');
  assert.deepEqual(state.counts(), { executorCalls: 0, inspectorCalls: 1 });
});

test('startup blocks uncertain interrupted phase and explicit retry alone resumes execution', async () => {
  const operationRegistry = registry();
  let operation = await operationRegistry.create(removalPreview());
  operation = await operationRegistry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: emptyEvidence(),
  });
  const state = runtimeFixture({
    operationRegistry,
    executor: async (current) => outcome(current, 'advance', {
      status: 'cleaning',
      evidence: localEvidence({ cleanupEvidenceDigest: null, dataDeleteJobId: null, backupId: null }),
    }),
  });
  const [recovery] = await state.runtime.init();
  assert.equal(recovery.operation.status, 'blocked');
  assert.equal(recovery.operation.error.code, 'mail_domain_removal_retry_required');
  assert.deepEqual(state.counts(), { executorCalls: 0, inspectorCalls: 1 });

  operation = await state.runtime.retry(retryInput(recovery.operation));
  assert.equal(operation.status, 'cleaning');
  assert.deepEqual(state.counts(), { executorCalls: 1, inspectorCalls: 1 });
});

test('pending child survives startup without inspection or implicit execution', async () => {
  const operationRegistry = registry();
  await operationRegistry.create(removalPreview());
  const state = runtimeFixture({
    operationRegistry,
    executor: async () => { throw new Error('unexpected executor'); },
    inspector: async () => { throw new Error('unexpected inspector'); },
  });

  const [recovery] = await state.runtime.init();
  assert.equal(recovery.reconciled, false);
  assert.equal(recovery.operation.status, 'pending');
  assert.deepEqual(state.counts(), { executorCalls: 0, inspectorCalls: 0 });
});

test('legacy child without a pinned cleanup plan is blocked before executor or inspector', async () => {
  const operationRegistry = registry();
  const current = await operationRegistry.create(removalPreview());
  const legacyRegistry = {
    ...operationRegistry,
    async listIncomplete() {
      return [{ ...current, planDigest: null, cleanupPlan: null }];
    },
  };
  const state = runtimeFixture({
    operationRegistry: legacyRegistry,
    executor: async () => { throw new Error('unexpected executor'); },
    inspector: async () => { throw new Error('unexpected inspector'); },
  });

  const [recovery] = await state.runtime.init();
  assert.equal(recovery.reconciled, false);
  assert.equal(recovery.operation.status, 'blocked');
  assert.equal(recovery.operation.error.code, 'mail_domain_removal_plan_missing');
  assert.deepEqual(state.counts(), { executorCalls: 0, inspectorCalls: 0 });
});

test('external runtime uses finalizing metadata evidence without local jobs', async () => {
  const preview = removalPreview({ managementMode: 'external', status: 'ready' });
  const state = runtimeFixture({
    preview,
    executor: async (operation) => operation.status === 'pending'
      ? outcome(operation, 'advance', {
        status: 'finalizing',
        evidence: {
          disableJobId: null,
          finalRevision: 5,
          cleanupEvidenceDigest,
          dataDeleteJobId: null,
          backupId: null,
        },
      })
      : outcome(operation, 'removed', { deletedAt: '2026-09-19T09:30:00.000Z' }),
  });

  let operation = await state.runtime.start(startInput(preview));
  assert.equal(operation.status, 'finalizing');
  operation = await state.runtime.retry(retryInput(operation));
  assert.equal(operation.status, 'removed');
  assert.equal(operation.result.removalMethod, 'external_metadata_unlink');
  assert.equal(operation.result.dataDeleteJobId, null);
});

test('executor exception is persisted as bounded failed child state', async () => {
  const state = runtimeFixture({
    executor: async () => {
      const error = new Error('safe authored failure');
      error.code = 'mail_config_unavailable';
      throw error;
    },
  });

  const operation = await state.runtime.start(startInput());
  assert.equal(operation.status, 'failed');
  assert.equal(operation.error.code, 'mail_config_unavailable');
  assert.equal(operation.error.message, 'safe authored failure');
});

test('expanded executor outcome is rejected and persisted as failed evidence', async () => {
  const state = runtimeFixture({
    executor: async (operation) => ({
      ...outcome(operation, 'advance', {
        status: 'disabling',
        evidence: emptyEvidence(),
      }),
      secret: 'must-not-be-accepted',
    }),
  });

  const operation = await state.runtime.start(startInput());
  assert.equal(operation.status, 'failed');
  assert.equal(operation.error.code, 'mail_domain_removal_outcome_invalid');
  assert.equal(JSON.stringify(operation).includes('must-not-be-accepted'), false);
});

test('stale preview and retry confirmations fail before durable transition or executor call', async () => {
  const state = runtimeFixture({
    executor: async (operation) => outcome(operation, 'advance', {
      status: 'disabling',
      evidence: emptyEvidence(),
    }),
  });
  await assert.rejects(
    state.runtime.start({ ...startInput(), previewDigest: 'f'.repeat(64) }),
    (error) => error instanceof MailDomainRemovalRuntimeError
      && error.code === 'mail_domain_removal_preview_stale',
  );
  assert.equal((await state.registry.listIncomplete()).length, 0);

  const operation = await state.runtime.start(startInput());
  await assert.rejects(
    state.runtime.retry({ ...retryInput(operation), confirmation: 'wrong' }),
    (error) => error instanceof MailDomainRemovalRuntimeError
      && error.code === 'mail_domain_removal_retry_stale',
  );
  assert.deepEqual(state.counts(), { executorCalls: 1, inspectorCalls: 0 });
});
