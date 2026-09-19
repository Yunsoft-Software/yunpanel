import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMailDomainRemovalFinalizePhase,
  mailDomainRemovalFinalizePhaseInternals,
} from '../src/mail-domain-removal-finalize-phase.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const parentOperationId = '22345678-1234-4234-8234-123456789012';
const mailDomainId = '32345678-1234-4234-8234-123456789012';
const webDomainId = '42345678-1234-4234-8234-123456789012';

function localOperation(overrides = {}) {
  return {
    id: operationId,
    parentOperationId,
    mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    sourceStatus: 'enabled',
    sourceRevision: 5,
    sourceUpdatedAt: '2026-09-19T08:00:00.000Z',
    removalMethod: 'local_verified_data_finalize',
    previewDigest: '1'.repeat(64),
    planDigest: '2'.repeat(64),
    cleanupPlan: {
      version: 2,
      mailDomainId,
      mailboxes: [],
      aliases: [],
      quotas: [],
      forwardings: [],
      dkim: null,
      mailData: { present: true, bytes: 32, snapshotSha256: '3'.repeat(64) },
      disableConfiguration: {
        previewDigest: '4'.repeat(64),
        configurationSha256: '5'.repeat(64),
      },
    },
    status: 'finalizing',
    resumeStatus: null,
    disableJobId: 'mail-config-job-1',
    finalRevision: 6,
    cleanupEvidenceDigest: '6'.repeat(64),
    dataDeleteJobId: 'mail-delete-job-1',
    backupId: 'mail-backup-job-1',
    result: null,
    error: null,
    createdAt: '2026-09-19T09:00:00.000Z',
    updatedAt: '2026-09-19T09:05:00.000Z',
    ...overrides,
  };
}

function externalPending(overrides = {}) {
  return {
    id: operationId,
    parentOperationId,
    mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'external',
    sourceStatus: 'ready',
    sourceRevision: 7,
    sourceUpdatedAt: '2026-09-19T08:00:00.000Z',
    removalMethod: 'external_metadata_unlink',
    previewDigest: '1'.repeat(64),
    planDigest: '2'.repeat(64),
    cleanupPlan: {
      version: 2,
      mailDomainId,
      mailboxes: [],
      aliases: [],
      quotas: [],
      forwardings: [],
      dkim: null,
      mailData: null,
      disableConfiguration: null,
    },
    status: 'pending',
    resumeStatus: null,
    disableJobId: null,
    finalRevision: null,
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
    result: null,
    error: null,
    createdAt: '2026-09-19T09:00:00.000Z',
    updatedAt: '2026-09-19T09:05:00.000Z',
    ...overrides,
  };
}

function externalFinalizing(overrides = {}) {
  const pending = externalPending();
  return {
    ...pending,
    status: 'finalizing',
    finalRevision: pending.sourceRevision,
    cleanupEvidenceDigest: mailDomainRemovalFinalizePhaseInternals.externalCleanupDigest(pending),
    ...overrides,
  };
}

function fixture({
  mailDomain,
  finalizeResult = null,
  deleteResult = null,
} = {}) {
  const calls = {
    finalize: [],
    delete: [],
  };
  let current = mailDomain;
  const phase = createMailDomainRemovalFinalizePhase({
    mailDomainRegistry: {
      async getMailDomain() {
        return current === undefined ? null : structuredClone(current);
      },
      async deleteMailDomain(id, options) {
        calls.delete.push({ id, options });
        if (deleteResult instanceof Error) throw deleteResult;
        current = null;
        return deleteResult ?? { id, resourceType: 'mail_domain', deleted: true };
      },
    },
    domainRegistry: {
      async getDomain() {
        return {
          id: webDomainId,
          primaryDomain: 'example.com',
          serverId: 'local-server',
        };
      },
    },
    mailDeleteFinalizeService: {
      async finalizeMailDomain(input) {
        calls.finalize.push(input);
        if (finalizeResult instanceof Error) throw finalizeResult;
        current = null;
        return finalizeResult ?? {
          id: mailDomainId,
          resourceType: 'mail_domain',
          deleted: true,
          deleteJobId: 'mail-delete-job-1',
          backupId: 'mail-backup-job-1',
        };
      },
    },
    localServerId: 'local-server',
    now: () => Date.parse('2026-09-19T10:00:00.000Z'),
  });
  return { phase, calls, current: () => current };
}

test('local finalizing delegates to guarded delete finalizer with pinned evidence', async () => {
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'disabled',
      revision: 6,
    },
  });

  const result = await state.phase.execute(localOperation());

  assert.equal(result.disposition, 'removed');
  assert.equal(result.deletedAt, '2026-09-19T10:00:00.000Z');
  assert.equal(result.sideEffects, true);
  assert.deepEqual(state.calls.finalize, [{
    mailDomainId,
    expectedRevision: 6,
    deleteJobId: 'mail-delete-job-1',
    confirmation: 'delete-mail-domain:' + mailDomainId + ':6',
  }]);
  assert.equal(state.calls.delete.length, 0);
});

test('local finalization startup reconciles already absent metadata without replay', async () => {
  const state = fixture({ mailDomain: undefined });

  const result = await state.phase.inspect(localOperation());

  assert.equal(result.disposition, 'removed');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.finalize.length, 0);
  assert.equal(state.calls.delete.length, 0);
});

test('local finalization inspection never invokes destructive finalizer while metadata remains', async () => {
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'local',
      status: 'disabled',
      revision: 6,
    },
  });

  const result = await state.phase.inspect(localOperation());

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_finalize_retry_required');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.finalize.length, 0);
});

test('external pending phase journals deterministic unlink evidence before deletion', async () => {
  const pending = externalPending();
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'external',
      status: 'ready',
      revision: 7,
      updatedAt: pending.sourceUpdatedAt,
    },
  });

  const result = await state.phase.execute(pending);

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'finalizing');
  assert.equal(result.sideEffects, true);
  assert.equal(result.evidence.finalRevision, 7);
  assert.equal(
    result.evidence.cleanupEvidenceDigest,
    mailDomainRemovalFinalizePhaseInternals.externalCleanupDigest(pending),
  );
  assert.equal(state.calls.delete.length, 0);
});

test('external finalizing unlinks metadata without invoking local finalizer', async () => {
  const operation = externalFinalizing();
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'external',
      status: 'ready',
      revision: 7,
      updatedAt: operation.sourceUpdatedAt,
    },
  });

  const result = await state.phase.execute(operation);

  assert.equal(result.disposition, 'removed');
  assert.equal(result.sideEffects, true);
  assert.deepEqual(state.calls.delete, [{
    id: mailDomainId,
    options: {
      expectedRevision: 7,
      confirmation: 'delete-mail-domain:' + mailDomainId + ':7',
    },
  }]);
  assert.equal(state.calls.finalize.length, 0);
});

test('external startup reconciliation treats already absent metadata as removed', async () => {
  const state = fixture({ mailDomain: undefined });

  const result = await state.phase.inspect(externalFinalizing());

  assert.equal(result.disposition, 'removed');
  assert.equal(result.sideEffects, false);
  assert.equal(state.calls.delete.length, 0);
  assert.equal(state.calls.finalize.length, 0);
});

test('external local dependency plan is rejected before metadata unlink', async () => {
  const pending = externalPending({
    cleanupPlan: {
      ...externalPending().cleanupPlan,
      mailboxes: [{
        id: '52345678-1234-4234-8234-123456789012',
        address: 'admin@example.com',
        enabled: true,
        revision: 1,
        updatedAt: '2026-09-19T08:00:00.000Z',
      }],
    },
  });
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'external',
      status: 'ready',
      revision: 7,
      updatedAt: pending.sourceUpdatedAt,
    },
  });

  await assert.rejects(
    state.phase.execute(pending),
    (error) => error.code === 'mail_domain_removal_finalize_operation_invalid',
  );
  assert.equal(state.calls.delete.length, 0);
});

test('external state drift fails without deleting metadata', async () => {
  const operation = externalFinalizing();
  const state = fixture({
    mailDomain: {
      id: mailDomainId,
      webDomainId,
      domainName: 'example.com',
      managementMode: 'external',
      status: 'degraded',
      revision: 8,
      updatedAt: '2026-09-19T09:30:00.000Z',
    },
  });

  const result = await state.phase.execute(operation);

  assert.equal(result.disposition, 'failed');
  assert.equal(result.error.code, 'mail_domain_removal_external_state_drift');
  assert.equal(state.calls.delete.length, 0);
});

test('external cleanup digest binds parent, plan and exact Mail Domain identity', () => {
  const left = externalPending();
  const right = externalPending({ planDigest: '9'.repeat(64) });
  assert.notEqual(
    mailDomainRemovalFinalizePhaseInternals.externalCleanupDigest(left),
    mailDomainRemovalFinalizePhaseInternals.externalCleanupDigest(right),
  );
});
