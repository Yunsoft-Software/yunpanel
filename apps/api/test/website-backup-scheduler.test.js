import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebsiteBackupScheduleRegistry } from '../src/website-backup-schedule-registry.js';
import { createWebsiteBackupOperationRegistry } from '../src/website-backup-operation-registry.js';
import { createWebsiteBackupOperationService } from '../src/website-backup-operation-service.js';
import { createWebsiteBackupScheduler } from '../src/website-backup-scheduler.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { OPERATIONS } from '@yunpanel/protocol';

const websiteId = '11111111-1111-4111-8111-111111111111', serverId = '22222222-2222-4222-8222-222222222222';
const repositoryId = '33333333-3333-4333-8333-333333333333', creatorId = '44444444-4444-4444-8444-444444444444';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-scheduler-worker-')); t.after(() => rm(root, { recursive: true, force: true }));
  let time = Date.parse('2026-10-09T20:00:00Z'), active = true, snapshots = 0;
  const schedules = createWebsiteBackupScheduleRegistry({ filePath: path.join(root, 'schedules.json'), now: () => time });
  const saved = await schedules.save({ websiteId, serverId, repositoryId, creatorId, creatorRole: 'owner', expression: '0 2 * * *' });
  time = Date.parse(saved.nextRunAt);
  const authorize = async grant => { const record = await schedules.get(grant.scheduleId); return active && record?.enabled === true && record.revision === grant.scheduleRevision && record.creatorId === grant.userId; };
  const jobs = createDurableJobRegistry({ filePath: path.join(root, 'jobs.json'), registryFactory: createJobRegistry, automaticReconciliation: true }); await jobs.init();
  const registry = createWebsiteBackupOperationRegistry({ filePath: path.join(root, 'operations.json') });
  const service = createWebsiteBackupOperationService({ registry, jobRegistry: jobs,
    websiteRegistry: { getWebsite: async id => ({ id, serverId }) }, resticRepositoryRegistry: { getRepository: async id => ({ id, serverId }) },
    siteMutationLock: createSiteMutationLock({ root: path.join(root, 'site-locks') }), authorizeActor: async () => null,
    authorizeScheduledActor: authorize, backupScheduleRegistry: schedules,
    websiteBackupService: { previewBackup: async () => ({ backupSetDigest: 'a'.repeat(64), confirmation: 'backup-confirm' }),
      executeBackup: async () => { snapshots++; return { status: 'succeeded', snapshot: { snapshotId: 'verified-snapshot-id' } }; } },
  });
  const scheduler = createWebsiteBackupScheduler({ scheduleRegistry: schedules, operationService: service, authorizeSchedule: authorize, serverId, now: () => time });
  return { root, schedules, saved, jobs, service, scheduler, snapshots: () => snapshots, revoke: () => { active = false; }, now: () => time, authorize };
}

test('a due schedule enqueues a real durable job without a fabricated web session; the normal worker executes it once', async t => {
  const f = await fixture(t);
  const outcome = await f.scheduler.sweep(); assert.equal(outcome[0].status, 'queued'); assert.equal(f.snapshots(), 0);
  const claim = await f.jobs.claimNext(serverId);
  assert.equal(claim.envelope.operation, OPERATIONS.WEBSITE_BACKUP_ACTION); assert.equal(claim.envelope.payload.actorSessionId, null);
  assert.equal(claim.authorization.kind, 'website_backup_schedule'); assert.equal(claim.authorization.userId, creatorId);
  const result = await f.service.execute(claim.envelope.payload, { jobId: claim.job.id, serverId, resourceType: 'backup', resourceId: claim.job.resourceId });
  await f.jobs.beginReconciliation({ serverId, jobId: claim.job.id }); await f.jobs.complete({ serverId, jobId: claim.job.id, status: 'succeeded', result }); await f.jobs.acknowledgeReconciliation({ serverId, jobId: claim.job.id });
  assert.equal(f.snapshots(), 1); assert.deepEqual(await f.scheduler.sweep(), []);
  assert.equal((await f.schedules.get(f.saved.id)).lastOperationId, outcome[0].operationId);
});

test('crash after enqueue but before advancing the clock reuses the same persisted operation and job', async t => {
  const f = await fixture(t); let failedWrite = true;
  const failingRegistry = { ...f.schedules, advance: async input => { if (failedWrite) { failedWrite = false; throw Object.assign(new Error('Fixture write failure'), { code: 'fixture_write_failed' }); } return f.schedules.advance(input); } };
  const first = createWebsiteBackupScheduler({ scheduleRegistry: failingRegistry, operationService: f.service, authorizeSchedule: f.authorize, serverId, now: f.now });
  assert.equal((await first.sweep())[0].status, 'failed');
  const before = await f.jobs.listJobs({ serverId }); assert.equal(before.length, 1);
  const reopenedRegistry = createWebsiteBackupScheduleRegistry({ filePath: path.join(f.root, 'schedules.json'), now: f.now });
  const second = createWebsiteBackupScheduler({ scheduleRegistry: reopenedRegistry, operationService: f.service, authorizeSchedule: f.authorize, serverId, now: f.now });
  assert.equal((await second.sweep())[0].status, 'queued');
  const after = await f.jobs.listJobs({ serverId }); assert.equal(after.length, 1); assert.equal(after[0].id, before[0].id);
  assert.equal(f.snapshots(), 0);
});

test('revocation stops a queued scheduled job before any snapshot and suspends future scheduled work', async t => {
  const f = await fixture(t); await f.scheduler.sweep(); const claim = await f.jobs.claimNext(serverId); f.revoke();
  await assert.rejects(f.service.execute(claim.envelope.payload, { jobId: claim.job.id, serverId, resourceType: 'backup', resourceId: claim.job.resourceId }), error => error.code === 'website_backup_schedule_actor_forbidden');
  assert.equal(f.snapshots(), 0);
  const due = createWebsiteBackupScheduler({ scheduleRegistry: f.schedules, operationService: f.service, authorizeSchedule: f.authorize, serverId, now: () => Date.parse('2026-10-11T00:00:00Z') });
  assert.equal((await due.sweep())[0].status, 'suspended'); assert.equal((await f.schedules.get(f.saved.id)).enabled, false);
});
