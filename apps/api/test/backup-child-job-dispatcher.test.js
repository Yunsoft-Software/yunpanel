import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  BackupChildDispatcherError,
  createBackupChildJobDispatcher,
} from '../src/backup-child-job-dispatcher.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const inventoryJobId = '1dff50cb-0840-413c-a9d1-d069f8e87743';
const mailDomainId = 'f15f21e0-3ce8-47cf-93bf-d45c8c723246';
const childJobId = '0bb78242-03a6-429f-9d17-7725c521437c';

function databaseStep(overrides = {}) {
  return {
    stepId: `backup-step:${'a'.repeat(64)}`,
    stepDigest: 'a'.repeat(64),
    resourceIdentity: `database:${serverId}:novasis`,
    resourceType: 'database',
    executorKind: 'database_backup',
    input: {
      databaseName: 'novasis',
      engine: 'mariadb',
      databaseVersion: '11.4.3-MariaDB',
      sizeBytes: 4096,
      inventoryJobId,
      inventoryRefreshedAt: '2026-09-13T20:01:00.000Z',
    },
    ...overrides,
  };
}

function mailStep(overrides = {}) {
  return {
    stepId: `backup-step:${'b'.repeat(64)}`,
    stepDigest: 'b'.repeat(64),
    resourceIdentity: `mail-data:${'c'.repeat(64)}`,
    resourceType: 'mail_data',
    executorKind: 'mail_data_backup',
    input: {
      mailDomainId,
      scope: 'domain',
      resourceId: mailDomainId,
      identity: 'example.com',
      expectedRevision: 5,
      expectedSnapshotSha256: 'd'.repeat(64),
      bytes: 2048,
    },
    ...overrides,
  };
}

function databaseInventory(overrides = {}) {
  return {
    engine: 'mariadb',
    version: '11.4.3-MariaDB',
    databases: [{ name: 'novasis', sizeBytes: 4096 }],
    snapshot: { jobId: inventoryJobId, refreshedAt: '2026-09-13T20:01:00.000Z' },
    ...overrides,
  };
}

function mailPreview(overrides = {}) {
  return {
    version: 1,
    operation: 'mail_data_backup',
    mailDomainId,
    scope: 'domain',
    resourceId: mailDomainId,
    identity: 'example.com',
    expectedRevision: 5,
    snapshotSha256: 'd'.repeat(64),
    sourcePresent: true,
    bytes: 2048,
    previewDigest: 'e'.repeat(64),
    confirmation: `backup-mail-data:${mailDomainId}:${'e'.repeat(64)}`,
    sideEffects: false,
    ...overrides,
  };
}

function mailExistingJob(status = 'succeeded') {
  return {
    id: childJobId,
    serverId,
    type: 'mail_data_backup',
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    status,
    createdAt: '2026-09-13T20:10:00.000Z',
    startedAt: '2026-09-13T20:10:01.000Z',
    finishedAt: status === 'succeeded' ? '2026-09-13T20:10:20.000Z' : null,
    attempts: 1,
    result: null,
    error: null,
  };
}

function fixture({
  jobs = [],
  inventory = databaseInventory(),
  preview = mailPreview(),
  existingJob = null,
} = {}) {
  const enqueued = [];
  const events = [];
  const registry = {
    async listJobs() {
      events.push('jobs');
      return jobs;
    },
    async enqueue(request) {
      events.push('enqueue');
      enqueued.push(request);
      return {
        id: childJobId,
        serverId: request.serverId,
        type: request.type,
        operation: request.operation,
        resourceType: request.resourceType,
        resourceId: request.resourceId,
        status: 'queued',
        createdAt: '2026-09-13T20:10:00.000Z',
        startedAt: null,
        finishedAt: null,
        attempts: 0,
        result: null,
        error: null,
      };
    },
  };
  const dispatcher = createBackupChildJobDispatcher({
    jobRegistry: registry,
    jobIdempotencyLookup: {
      async find() {
        events.push('lookup');
        return existingJob;
      },
    },
    async loadDatabaseInventory() {
      events.push('inventory');
      return inventory;
    },
    mailDataOperationsService: {
      async previewBackup() {
        events.push('preview');
        if (preview instanceof Error) throw preview;
        return preview;
      },
    },
  });
  return { dispatcher, enqueued, events };
}

test('child prepare emits deterministic intent without reading source state', async () => {
  const { dispatcher, events } = fixture({
    inventory: databaseInventory({ databases: [{ name: 'novasis', sizeBytes: 9999 }] }),
  });
  const prepared = await dispatcher.prepare(serverId, databaseStep());

  assert.deepEqual(prepared.workRef, {
    kind: 'job',
    id: `general-backup-step:${'a'.repeat(64)}`,
  });
  assert.equal(prepared.request.operation, OPERATIONS.DATABASE_BACKUP);
  assert.deepEqual(prepared.request.payload, { databaseName: 'novasis' });
  assert.equal(prepared.request.idempotencyKey, prepared.workRef.id);
  assert.deepEqual(events, []);
});

test('database child verification fails closed on stale inventory or active database work', async () => {
  const stale = fixture({ inventory: databaseInventory({ databases: [{ name: 'novasis', sizeBytes: 5000 }] }) });
  await assert.rejects(
    () => stale.dispatcher.verify(serverId, databaseStep()),
    (error) => error instanceof BackupChildDispatcherError
      && error.code === 'backup_database_preview_stale'
      && error.status === 409,
  );

  const busy = fixture({ jobs: [{ operation: OPERATIONS.DATABASE_INSPECT, status: 'running' }] });
  await assert.rejects(
    () => busy.dispatcher.verify(serverId, databaseStep()),
    (error) => error instanceof BackupChildDispatcherError
      && error.code === 'backup_database_job_conflict'
      && error.status === 409,
  );
});

test('mail child verification requires the exact guarded mail snapshot', async () => {
  const { dispatcher } = fixture();
  assert.equal(await dispatcher.verify(serverId, mailStep()), true);

  const stale = fixture({ preview: mailPreview({ bytes: 9999 }) });
  await assert.rejects(
    () => stale.dispatcher.verify(serverId, mailStep()),
    (error) => error instanceof BackupChildDispatcherError
      && error.code === 'backup_mail_preview_stale'
      && error.status === 409,
  );
});

test('dispatch checks for an existing child before verification and only enqueues absent work', async () => {
  const { dispatcher, events, enqueued } = fixture();
  const step = mailStep();
  const workRef = dispatcher.intent(step);
  const job = await dispatcher.dispatchPrepared(serverId, step, workRef);

  assert.equal(job.status, 'queued');
  assert.deepEqual(events, ['lookup', 'preview', 'enqueue']);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].idempotencyKey, workRef.id);
});

test('dispatch reconciles an existing successful child without re-verifying or re-enqueueing', async () => {
  const existingJob = mailExistingJob('succeeded');
  const { dispatcher, events, enqueued } = fixture({
    existingJob,
    preview: mailPreview({ bytes: 9999 }),
  });
  const step = mailStep();
  const job = await dispatcher.dispatchPrepared(serverId, step, dispatcher.intent(step));

  assert.deepEqual(job, existingJob);
  assert.deepEqual(events, ['lookup']);
  assert.equal(enqueued.length, 0);
});

test('prepared child enqueue requires the persisted deterministic dispatch intent', async () => {
  const { dispatcher, enqueued } = fixture();
  const step = mailStep();
  const prepared = await dispatcher.prepare(serverId, step);
  const first = await dispatcher.enqueuePrepared(serverId, step, prepared.workRef);
  const second = await dispatcher.enqueuePrepared(serverId, step, prepared.workRef);

  assert.equal(first.id, second.id);
  assert.equal(enqueued.length, 2);
  assert.equal(enqueued[0].idempotencyKey, prepared.workRef.id);
  assert.deepEqual(enqueued[1], enqueued[0]);

  await assert.rejects(
    () => dispatcher.enqueuePrepared(serverId, step, { kind: 'job', id: 'wrong-intent' }),
    (error) => error instanceof BackupChildDispatcherError
      && error.code === 'backup_child_dispatch_intent_invalid',
  );
});

test('database and mail successful jobs normalize to bounded aggregate artifact evidence', () => {
  const { dispatcher } = fixture();
  const databaseEvidence = dispatcher.evidence(databaseStep(), {
    operation: OPERATIONS.DATABASE_BACKUP,
    resourceType: 'database',
    resourceId: 'novasis',
    status: 'succeeded',
    createdAt: '2026-09-13T20:10:00.000Z',
    finishedAt: '2026-09-13T20:10:10.000Z',
    result: {
      version: 1,
      backupId: childJobId,
      databaseName: 'novasis',
      engine: 'mariadb',
      databaseVersion: '11.4.3-MariaDB',
      dumpSha256: 'f'.repeat(64),
      dumpBytes: 1234,
      createdAt: '2026-09-13T20:10:09.000Z',
      backedUp: true,
      sideEffects: true,
    },
  });
  assert.deepEqual(databaseEvidence, {
    artifactId: childJobId,
    contentSha256: 'f'.repeat(64),
    bytes: 1234,
    createdAt: '2026-09-13T20:10:09.000Z',
  });

  const mailEvidence = dispatcher.evidence(mailStep(), {
    operation: OPERATIONS.MAIL_DATA_BACKUP,
    resourceType: 'mail_domain',
    resourceId: mailDomainId,
    status: 'succeeded',
    createdAt: '2026-09-13T20:10:00.000Z',
    finishedAt: '2026-09-13T20:10:20.000Z',
    result: {
      version: 1,
      backupId: 'd0bc7f95-bdbd-4375-904f-50c532fc3faa',
      mailDomainId,
      scope: 'domain',
      identity: 'example.com',
      sourcePresent: true,
      sourceSnapshotSha256: 'd'.repeat(64),
      contentSha256: '1'.repeat(64),
      bytes: 2048,
      files: 8,
      directories: 3,
      backedUp: true,
      sideEffects: true,
    },
  });
  assert.deepEqual(mailEvidence, {
    artifactId: 'd0bc7f95-bdbd-4375-904f-50c532fc3faa',
    contentSha256: '1'.repeat(64),
    bytes: 2048,
    createdAt: '2026-09-13T20:10:20.000Z',
  });
});
