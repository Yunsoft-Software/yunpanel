import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMailDomainRemovalOperationRegistry,
  mailDomainRemovalOperationPublicView,
  MailDomainRemovalOperationRegistryError,
} from '../src/mail-domain-removal-operation-registry.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const parentOperationId = '22345678-1234-4234-8234-123456789012';
const mailDomainId = '32345678-1234-4234-8234-123456789012';
const webDomainId = '42345678-1234-4234-8234-123456789012';
const sourceUpdatedAt = '2026-09-19T08:00:00.000Z';
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

function preview({ managementMode = 'local', status = 'enabled', overrides = {} } = {}) {
  const removalMethod = managementMode === 'local'
    ? 'local_verified_data_finalize'
    : 'external_metadata_unlink';
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
      updatedAt: sourceUpdatedAt,
    },
    parentOperationId,
    removalMethod,
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
    cleanupEvidenceDigest: null,
    dataDeleteJobId: null,
    backupId: null,
    ...overrides,
  };
}

function createRegistry(options = {}) {
  let clock = Date.parse('2026-09-19T09:00:00.000Z');
  return createMailDomainRemovalOperationRegistry({
    now: () => clock++,
    idFactory: () => operationId,
    ...options,
  });
}

test('journal persists private confirmation with root-only modes and exposes bounded child view', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-removal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createRegistry({ filePath });

  await registry.init();
  const created = await registry.create(preview());
  const view = mailDomainRemovalOperationPublicView(created);

  assert.equal(created.status, 'pending');
  assert.equal(view.parentOperationId, parentOperationId);
  assert.equal(view.removalMethod, 'local_verified_data_finalize');
  assert.equal(view.planDigest, created.planDigest);
  assert.equal(Object.hasOwn(view, 'cleanupPlan'), false);
  assert.equal(view.recovery.retryable, true);
  assert.match(view.recovery.retryConfirmation, /^retry-mail-domain-remove:/);
  assert.equal(Object.hasOwn(view, 'confirmation'), false);
  assert.equal(Object.hasOwn(view, 'disableJobId'), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(disk.operations[0].confirmation, preview().confirmation);
  assert.deepEqual(disk.operations[0].cleanupPlan, preview().cleanupPlan);
});

test('enabled local lifecycle pins disable, cleanup, backup and data-delete evidence before removal', async () => {
  const registry = createRegistry();
  let operation = await registry.create(preview());

  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: emptyEvidence(),
  });
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: { ...emptyEvidence(), disableJobId: 'mail-config-job-1' },
  });
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'cleaning',
    evidence: localEvidence(),
  });
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'deleting_data',
    evidence: localEvidence({
      cleanupEvidenceDigest,
      backupId: 'mail-backup-job-1',
    }),
  });
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'deleting_data',
    evidence: localEvidence({
      cleanupEvidenceDigest,
      dataDeleteJobId: 'mail-delete-job-1',
      backupId: 'mail-backup-job-1',
    }),
  });
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'finalizing',
    evidence: localEvidence({
      cleanupEvidenceDigest,
      dataDeleteJobId: 'mail-delete-job-1',
      backupId: 'mail-backup-job-1',
    }),
  });
  operation = await registry.succeed(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    deletedAt: '2026-09-19T09:30:00.000Z',
  });

  assert.equal(operation.status, 'removed');
  assert.equal(operation.result.finalRevision, 6);
  assert.equal(operation.result.disableJobId, 'mail-config-job-1');
  assert.equal(operation.result.dataDeleteJobId, 'mail-delete-job-1');
  assert.equal(operation.result.backupId, 'mail-backup-job-1');
  assert.equal(operation.result.cleanupEvidenceDigest, cleanupEvidenceDigest);
  assert.equal(mailDomainRemovalOperationPublicView(operation).recovery.retryable, false);
  assert.deepEqual(await registry.listIncomplete(), []);
});

test('disabled local lifecycle skips disable and preserves its source revision', async () => {
  const registry = createRegistry();
  let operation = await registry.create(preview({ status: 'disabled' }));
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'cleaning',
    evidence: {
      ...emptyEvidence(),
      finalRevision: 5,
    },
  });
  assert.equal(operation.finalRevision, 5);
  assert.equal(operation.disableJobId, null);
  await assert.rejects(
    registry.advance(operation.id, {
      expectedUpdatedAt: operation.updatedAt,
      status: 'deleting_data',
      evidence: localEvidence({
        finalRevision: 5,
        cleanupEvidenceDigest,
        backupId: 'mail-backup-job-1',
      }),
    }),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_state_invalid',
  );
});

test('external lifecycle cannot carry local job or backup evidence', async () => {
  const registry = createRegistry();
  let operation = await registry.create(preview({ managementMode: 'external', status: 'ready' }));
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'finalizing',
    evidence: {
      ...emptyEvidence(),
      finalRevision: 5,
      cleanupEvidenceDigest,
    },
  });
  operation = await registry.succeed(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    deletedAt: '2026-09-19T09:30:00.000Z',
  });
  assert.equal(operation.result.removalMethod, 'external_metadata_unlink');
  assert.equal(operation.result.dataDeleteJobId, null);

  const invalidRegistry = createMailDomainRemovalOperationRegistry({
    now: () => Date.parse('2026-09-19T09:00:00.000Z'),
    idFactory: () => 'external-operation-2',
  });
  const invalid = await invalidRegistry.create(preview({ managementMode: 'external', status: 'ready' }));
  await assert.rejects(
    invalidRegistry.advance(invalid.id, {
      expectedUpdatedAt: invalid.updatedAt,
      status: 'finalizing',
      evidence: {
        disableJobId: null,
        finalRevision: 5,
        cleanupEvidenceDigest,
        dataDeleteJobId: 'mail-delete-job-1',
        backupId: 'mail-backup-job-1',
      },
    }),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_state_invalid',
  );
});

test('interrupted phase survives restart and remains explicit-retry only', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-removal-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createRegistry({ filePath });
  await registry.init();
  let operation = await registry.create(preview());
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: emptyEvidence(),
  });

  const restarted = createMailDomainRemovalOperationRegistry({ filePath });
  await restarted.init();
  const [interrupted] = await restarted.listIncomplete();
  const view = mailDomainRemovalOperationPublicView(interrupted);
  assert.equal(interrupted.status, 'disabling');
  assert.equal(view.recovery.required, true);
  assert.equal(view.recovery.automaticReplayBlocked, true);
  assert.equal(view.recovery.reason, 'mail_domain_removal_interrupted_disabling');
});

test('blocked operation retains its phase evidence and explicit retry clears bounded error', async () => {
  const registry = createRegistry();
  let operation = await registry.create(preview());
  operation = await registry.advance(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    status: 'disabling',
    evidence: emptyEvidence(),
  });
  operation = await registry.block(operation.id, {
    expectedUpdatedAt: operation.updatedAt,
    error: { code: 'mail_config_job_pending', message: 'Mail configuration job is incomplete' },
  });
  assert.equal(operation.status, 'blocked');
  assert.equal(operation.resumeStatus, 'disabling');
  assert.equal(operation.error.code, 'mail_config_job_pending');

  operation = await registry.retry(operation.id, { expectedUpdatedAt: operation.updatedAt });
  assert.equal(operation.status, 'disabling');
  assert.equal(operation.resumeStatus, null);
  assert.equal(operation.error, null);
});

test('duplicate parent intent is idempotent while drift and concurrent parent ownership fail closed', async () => {
  const registry = createRegistry();
  const created = await registry.create(preview());
  assert.equal((await registry.create(preview())).id, created.id);

  await assert.rejects(
    registry.create(preview({ overrides: { previewDigest: 'c'.repeat(64) } })),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_intent_conflict',
  );
  await assert.rejects(
    registry.create(preview({ overrides: { parentOperationId: 'foreign-parent-operation' } })),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_active',
  );
});

test('version one pending journal migrates fail-closed and safely recaptures a current cleanup plan', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-removal-v1-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const initial = createRegistry({ filePath });
  await initial.init();
  const created = await initial.create(preview());
  const legacy = JSON.parse(await readFile(filePath, 'utf8'));
  legacy.version = 1;
  delete legacy.operations[0].planDigest;
  delete legacy.operations[0].cleanupPlan;
  await writeFile(filePath, JSON.stringify(legacy));

  const restarted = createMailDomainRemovalOperationRegistry({ filePath });
  await restarted.init();
  const [migrated] = await restarted.listIncomplete();
  assert.equal(migrated.id, created.id);
  assert.equal(migrated.cleanupPlan, null);
  assert.equal(migrated.planDigest, null);
  assert.equal(
    mailDomainRemovalOperationPublicView(migrated).recovery.reason,
    'mail_domain_removal_plan_missing',
  );
  const migratedDisk = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(migratedDisk.version, 2);
  assert.equal(migratedDisk.operations[0].cleanupPlan, null);

  const recaptured = await restarted.create(preview());
  assert.equal(recaptured.id, created.id);
  assert.deepEqual(recaptured.cleanupPlan, preview().cleanupPlan);
  assert.equal(recaptured.planDigest, preview().planDigest);
  assert.notEqual(recaptured.updatedAt, migrated.updatedAt);
});

test('tampered persisted phase evidence fails closed on restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-removal-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createRegistry({ filePath });
  await registry.init();
  await registry.create(preview());
  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.operations[0].backupId = 'foreign-backup';
  await writeFile(filePath, JSON.stringify(disk));

  const restarted = createMailDomainRemovalOperationRegistry({ filePath });
  await assert.rejects(
    restarted.init(),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_state_invalid',
  );
});

test('tampered private cleanup plan fails closed on restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-domain-removal-plan-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createRegistry({ filePath });
  await registry.init();
  await registry.create(preview());
  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.operations[0].cleanupPlan.mailData.snapshotSha256 = 'f'.repeat(64);
  await writeFile(filePath, JSON.stringify(disk));

  const restarted = createMailDomainRemovalOperationRegistry({ filePath });
  await assert.rejects(
    restarted.init(),
    (error) => error instanceof MailDomainRemovalOperationRegistryError
      && error.code === 'mail_domain_removal_operation_state_invalid',
  );
});
