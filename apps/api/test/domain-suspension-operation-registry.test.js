import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDomainSuspensionOperationRegistry,
  domainSuspensionOperationPublicView,
  DomainSuspensionOperationRegistryError,
} from '../src/domain-suspension-operation-registry.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const domainId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);

function preview(overrides = {}) {
  return {
    version: 1,
    operation: 'domain_suspend',
    domain: {
      id: domainId,
      serverId,
      primaryDomain: 'example.com',
      desiredRevision: 4,
      stagedRevision: 4,
      appliedRevision: 4,
      stagedChecksum: checksum,
      state: 'active',
    },
    nginx: {
      satisfied: false,
      deactivationCandidate: true,
      restorable: false,
      reason: null,
      configName: 'yunpanel-example.com.conf',
      checksum,
      receiptVersion: null,
    },
    activeJobs: [],
    blockers: [],
    readyToSuspend: true,
    previewDigest,
    confirmation: `suspend-domain:${domainId}:4:${checksum}:${previewDigest}`,
    sideEffects: false,
    ...overrides,
  };
}

test('suspension journal persists root-private and public view omits original confirmation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-op-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createDomainSuspensionOperationRegistry({
    filePath,
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.init();
  const created = await registry.create(preview());

  assert.equal(created.status, 'pending');
  assert.equal(created.confirmation, preview().confirmation);
  const publicView = domainSuspensionOperationPublicView(created);
  assert.equal(Object.hasOwn(publicView, 'confirmation'), false);
  assert.equal(publicView.recovery.required, false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
});

test('journal tracks suspend then resume with monotonic revisions and separate evidence', async () => {
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const registry = createDomainSuspensionOperationRegistry({
    now: () => clock,
    idFactory: () => operationId,
  });
  const created = await registry.create(preview());
  const suspending = await registry.markSuspending(operationId);
  assert.equal(suspending.status, 'suspending');
  assert.equal(Date.parse(suspending.updatedAt) > Date.parse(created.updatedAt), true);

  clock += 1000;
  const suspended = await registry.succeedSuspend(operationId, {
    hostChanged: true,
    suspendedAt: '2026-09-18T16:00:01.000Z',
  });
  assert.equal(suspended.status, 'suspended');
  assert.deepEqual(suspended.suspendResult, {
    suspended: true,
    hostChanged: true,
    suspendedAt: '2026-09-18T16:00:01.000Z',
  });

  const resuming = await registry.markResuming(operationId);
  assert.equal(resuming.status, 'resuming');
  assert.deepEqual(resuming.suspendResult, suspended.suspendResult);
  assert.equal(resuming.resumeResult, null);

  clock += 1000;
  const resumed = await registry.succeedResume(operationId, {
    hostChanged: true,
    resumedAt: '2026-09-18T16:00:02.000Z',
  });
  assert.equal(resumed.status, 'resumed');
  assert.deepEqual(resumed.suspendResult, suspended.suspendResult);
  assert.deepEqual(resumed.resumeResult, {
    resumed: true,
    hostChanged: true,
    resumedAt: '2026-09-18T16:00:02.000Z',
  });
  assert.equal(domainSuspensionOperationPublicView(resumed).recovery.required, false);
});

test('interrupted suspend and resume survive restart as automatic-replay-blocked states', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  let clock = Date.parse('2026-09-18T16:00:00.000Z');
  const first = createDomainSuspensionOperationRegistry({
    filePath,
    now: () => clock,
    idFactory: () => operationId,
  });
  await first.init();
  await first.create(preview());
  await first.markSuspending(operationId);

  let restarted = createDomainSuspensionOperationRegistry({ filePath, now: () => clock });
  await restarted.init();
  let interrupted = await restarted.listInterrupted();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].status, 'suspending');
  let publicView = domainSuspensionOperationPublicView(interrupted[0]);
  assert.equal(publicView.recovery.required, true);
  assert.equal(publicView.recovery.phase, 'suspend');
  assert.equal(publicView.recovery.automaticReplayBlocked, true);

  clock += 1000;
  await restarted.succeedSuspend(operationId, {
    hostChanged: false,
    suspendedAt: '2026-09-18T16:00:01.000Z',
  });
  await restarted.markResuming(operationId);

  restarted = createDomainSuspensionOperationRegistry({ filePath, now: () => clock });
  await restarted.init();
  interrupted = await restarted.listInterrupted();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].status, 'resuming');
  publicView = domainSuspensionOperationPublicView(interrupted[0]);
  assert.equal(publicView.recovery.phase, 'resume');
  assert.equal(publicView.recovery.automaticReplayBlocked, true);
});

test('failed suspend retries explicitly while resume failure preserves completed suspension evidence', async () => {
  const registry = createDomainSuspensionOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.create(preview());
  await registry.markSuspending(operationId);
  const failed = await registry.failSuspend(operationId, {
    code: 'nginx_deactivation_failed',
    message: 'Nginx deactivation failed',
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.suspendResult, null);
  assert.equal(failed.suspendError.code, 'nginx_deactivation_failed');

  const retried = await registry.markSuspending(operationId);
  assert.equal(retried.status, 'suspending');
  assert.equal(retried.suspendError, null);

  const suspended = await registry.succeedSuspend(operationId, {
    hostChanged: true,
    suspendedAt: '2026-09-18T16:01:00.000Z',
  });
  await registry.markResuming(operationId);
  const resumeFailed = await registry.failResume(operationId, {
    code: 'nginx_deactivation_restore_failed',
    message: 'Nginx restore failed',
  });
  assert.equal(resumeFailed.status, 'resume_failed');
  assert.deepEqual(resumeFailed.suspendResult, suspended.suspendResult);
  assert.equal(resumeFailed.resumeError.code, 'nginx_deactivation_restore_failed');

  const resumeRetry = await registry.markResuming(operationId);
  assert.equal(resumeRetry.status, 'resuming');
  assert.equal(resumeRetry.resumeError, null);
});

test('operation identity can be reused only until a completed resume closes that suspension session', async () => {
  const ids = [
    operationId,
    '42345678-1234-4234-8234-123456789012',
  ];
  const registry = createDomainSuspensionOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => ids.shift(),
  });
  const first = await registry.create(preview());
  const duplicate = await registry.create(preview());
  assert.equal(duplicate.id, first.id);

  await registry.markSuspending(first.id);
  await registry.succeedSuspend(first.id, {
    hostChanged: true,
    suspendedAt: '2026-09-18T16:00:01.000Z',
  });
  await registry.markResuming(first.id);
  await registry.succeedResume(first.id, {
    hostChanged: true,
    resumedAt: '2026-09-18T16:00:02.000Z',
  });

  const second = await registry.create(preview());
  assert.notEqual(second.id, first.id);
});

test('persisted lifecycle tamper fails closed on restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-suspension-tamper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'operations.json');
  const registry = createDomainSuspensionOperationRegistry({
    filePath,
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await registry.init();
  await registry.create(preview());

  const disk = JSON.parse(await readFile(filePath, 'utf8'));
  disk.operations[0].status = 'suspended';
  disk.operations[0].suspendResult = null;
  await writeFile(filePath, JSON.stringify(disk));

  const restarted = createDomainSuspensionOperationRegistry({ filePath });
  await assert.rejects(
    restarted.init(),
    (error) => error instanceof DomainSuspensionOperationRegistryError
      && error.code === 'domain_suspension_operation_state_invalid',
  );
});

test('blocked or malformed suspension preview cannot be journaled', async () => {
  const registry = createDomainSuspensionOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
  await assert.rejects(
    registry.create(preview({
      blockers: ['domain_job_active'],
      readyToSuspend: false,
      confirmation: null,
    })),
    (error) => error instanceof DomainSuspensionOperationRegistryError
      && error.code === 'domain_suspension_operation_preview_invalid',
  );
});
