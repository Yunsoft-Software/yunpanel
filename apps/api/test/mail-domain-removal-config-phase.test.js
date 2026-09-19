import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createMailDomainRemovalConfigPhase,
  MailDomainRemovalConfigPhaseError,
} from '../src/mail-domain-removal-config-phase.js';

const operationId = randomUUID();
const mailDomainId = randomUUID();
const webDomainId = randomUUID();
const serverId = randomUUID();
const sourceUpdatedAt = '2026-09-19T11:00:00.000Z';
const operationUpdatedAt = '2026-09-19T11:01:00.000Z';
const configPreviewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const jobId = randomUUID();

function operation(overrides = {}) {
  return {
    id: operationId,
    mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    sourceStatus: 'enabled',
    sourceRevision: 7,
    sourceUpdatedAt,
    status: 'pending',
    updatedAt: operationUpdatedAt,
    disableJobId: null,
    cleanupPlan: {
      version: 2,
      mailDomainId,
      mailboxes: [],
      aliases: [],
      quotas: [],
      forwardings: [],
      dkim: null,
      mailData: { present: false, bytes: 0, snapshotSha256: 'c'.repeat(64) },
      disableConfiguration: { previewDigest: configPreviewDigest, configurationSha256 },
    },
    ...overrides,
  };
}

function configPreview(overrides = {}) {
  return {
    version: 1,
    operation: 'mail_configuration_apply',
    mailDomainId,
    expectedRevision: 7,
    currentStatus: 'enabled',
    desiredStatus: 'disabled',
    readyToApply: true,
    blockers: [],
    previewDigest: configPreviewDigest,
    configuration: { sha256: configurationSha256 },
    sideEffects: false,
    ...overrides,
  };
}

function queuedJob(overrides = {}) {
  return {
    id: jobId,
    serverId,
    type: 'mail.config.apply',
    operation: 'mail.config.apply',
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    status: 'queued',
    result: null,
    ...overrides,
  };
}

function succeededJob(overrides = {}) {
  return queuedJob({
    status: 'succeeded',
    result: {
      version: 3,
      mailDomainId,
      previousRevision: 7,
      previousStatus: 'enabled',
      desiredStatus: 'disabled',
      previewDigest: configPreviewDigest,
      configurationSha256,
      planSha256: 'd'.repeat(64),
      backupSha256: 'e'.repeat(64),
      readinessSha256: 'f'.repeat(64),
      applied: true,
      sideEffects: true,
    },
    ...overrides,
  });
}

function fixture({
  currentMailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'enabled',
    revision: 7,
    updatedAt: sourceUpdatedAt,
  },
  preview = configPreview(),
  existingJob = null,
  listedJobs = [],
  fetchedJob = null,
} = {}) {
  const calls = { preview: 0, lookup: 0, list: 0, enqueue: 0, get: 0 };
  let enqueuedRequest = null;
  const phase = createMailDomainRemovalConfigPhase({
    localServerId: serverId,
    mailDomainRegistry: { async getMailDomain() { return currentMailDomain; } },
    domainRegistry: {
      async getDomain() {
        return { id: webDomainId, serverId, primaryDomain: 'example.com' };
      },
    },
    mailConfigurationService: {
      async previewTransition(input) {
        calls.preview += 1;
        assert.deepEqual(input, { mailDomainId, expectedRevision: 7, status: 'disabled' });
        return preview;
      },
    },
    jobIdempotencyLookup: {
      async find(request) {
        calls.lookup += 1;
        assert.equal(request.idempotencyKey, `mail-domain-remove-disable:${operationId}`);
        return existingJob;
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        calls.list += 1;
        assert.deepEqual(filter, { serverId });
        return listedJobs;
      },
      async enqueue(request) {
        calls.enqueue += 1;
        enqueuedRequest = structuredClone(request);
        return queuedJob();
      },
      async getJob(id) {
        calls.get += 1;
        assert.equal(id, jobId);
        return fetchedJob;
      },
    },
  });
  return { phase, calls, enqueuedRequest: () => enqueuedRequest };
}

test('enabled source first journals disabling intent without queueing a job', async () => {
  const state = fixture();
  const result = await state.phase.execute(operation());

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'disabling');
  assert.equal(result.evidence.disableJobId, null);
  assert.equal(result.sideEffects, true);
  assert.deepEqual(state.calls, { preview: 1, lookup: 0, list: 0, enqueue: 0, get: 0 });
});

test('disabled source skips config dispatch and preserves final revision', async () => {
  const currentMailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: 7,
    updatedAt: sourceUpdatedAt,
  };
  const state = fixture({ currentMailDomain });
  const result = await state.phase.execute(operation({
    sourceStatus: 'disabled',
    cleanupPlan: {
      ...operation().cleanupPlan,
      disableConfiguration: null,
    },
  }));

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'cleaning');
  assert.equal(result.evidence.finalRevision, 7);
  assert.deepEqual(state.calls, { preview: 0, lookup: 0, list: 0, enqueue: 0, get: 0 });
});

test('disabling dispatch queues one exact idempotent config job', async () => {
  const state = fixture();
  const result = await state.phase.execute(operation({ status: 'disabling' }));

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'disabling');
  assert.equal(result.evidence.disableJobId, jobId);
  assert.deepEqual(state.calls, { preview: 1, lookup: 1, list: 1, enqueue: 1, get: 0 });
  assert.deepEqual(state.enqueuedRequest(), {
    serverId,
    type: 'mail.config.apply',
    operation: 'mail.config.apply',
    payload: {
      mailDomainId,
      expectedRevision: 7,
      desiredStatus: 'disabled',
      previewDigest: configPreviewDigest,
      configurationSha256,
    },
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    idempotencyKey: `mail-domain-remove-disable:${operationId}`,
  });
});

test('crash recovery adopts the exact idempotent job without duplicate enqueue', async () => {
  const state = fixture({ existingJob: queuedJob() });
  const result = await state.phase.execute(operation({ status: 'disabling' }));

  assert.equal(result.evidence.disableJobId, jobId);
  assert.deepEqual(state.calls, { preview: 0, lookup: 1, list: 0, enqueue: 0, get: 0 });
});

test('startup inspection never dispatches a missing disable job', async () => {
  const state = fixture();
  const result = await state.phase.inspect(operation({ status: 'disabling' }));

  assert.equal(result.disposition, 'blocked');
  assert.equal(result.error.code, 'mail_domain_removal_config_dispatch_required');
  assert.equal(result.sideEffects, false);
  assert.deepEqual(state.calls, { preview: 0, lookup: 1, list: 0, enqueue: 0, get: 0 });
});

test('successful exact job and reconciled disabled state advance to cleanup', async () => {
  const currentMailDomain = {
    id: mailDomainId,
    webDomainId,
    domainName: 'example.com',
    managementMode: 'local',
    status: 'disabled',
    revision: 8,
    updatedAt: '2026-09-19T11:05:00.000Z',
  };
  const state = fixture({ currentMailDomain, fetchedJob: succeededJob() });
  const result = await state.phase.inspect(operation({ status: 'disabling', disableJobId: jobId }));

  assert.equal(result.disposition, 'advance');
  assert.equal(result.status, 'cleaning');
  assert.equal(result.evidence.disableJobId, jobId);
  assert.equal(result.evidence.finalRevision, 8);
  assert.equal(result.sideEffects, false);
  assert.deepEqual(state.calls, { preview: 0, lookup: 0, list: 0, enqueue: 0, get: 1 });
});

test('active job and unreconciled success remain explicit-retry blocked', async () => {
  const active = fixture({ fetchedJob: queuedJob() });
  const activeResult = await active.phase.execute(operation({ status: 'disabling', disableJobId: jobId }));
  assert.equal(activeResult.disposition, 'blocked');
  assert.equal(activeResult.error.code, 'mail_domain_removal_config_job_pending');

  const complete = fixture({ fetchedJob: succeededJob() });
  const completeResult = await complete.phase.execute(operation({ status: 'disabling', disableJobId: jobId }));
  assert.equal(completeResult.disposition, 'blocked');
  assert.equal(completeResult.error.code, 'mail_domain_removal_config_reconciliation_pending');
});

test('stale pinned config preview fails before child job dispatch', async () => {
  const state = fixture({
    preview: configPreview({ previewDigest: '9'.repeat(64) }),
  });
  await assert.rejects(
    state.phase.execute(operation()),
    (error) => error instanceof MailDomainRemovalConfigPhaseError
      && error.code === 'mail_domain_removal_config_preview_stale',
  );
  assert.deepEqual(state.calls, { preview: 1, lookup: 0, list: 0, enqueue: 0, get: 0 });
});
