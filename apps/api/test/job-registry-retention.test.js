import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import {
  createJobRegistry,
  isNewlyEnqueuedJob,
  jobArchivePathFor,
  jobRetentionDaysFromEnv,
  JobRegistryError,
} from '../src/jobs/job-registry.js';

const DAY = 24 * 60 * 60 * 1000;

async function withDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function stageInput(resourceId, idempotencyKey = null, serverId = 'server-1') {
  return {
    serverId,
    type: 'domain.stage',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: { primaryDomain: `${resourceId}.example.com`, aliases: [], targetType: 'proxy', target: { upstreamPort: 3008 } },
    resourceType: 'domain',
    resourceId,
    idempotencyKey,
  };
}

async function finish(registry, input, status = 'succeeded') {
  const job = await registry.enqueue(input);
  const claimed = await registry.claimNext('server-1');
  assert.equal(claimed.job.id, job.id);
  await registry.complete(status === 'failed'
    ? { serverId: 'server-1', jobId: job.id, status, error: { code: 'agent_failed' } }
    : { serverId: 'server-1', jobId: job.id, status, result: { checksum: 'a'.repeat(64), configName: 'yunpanel-example.com.conf', bytes: 512 } });
  return job;
}

const storedIds = async (filePath) => JSON.parse(await readFile(filePath, 'utf8')).jobs.map((job) => job.id).sort();

test('only finished jobs older than the retention period move to the archive', async (t) => {
  const directory = await withDirectory(t);
  const filePath = path.join(directory, 'jobs.json');
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const registry = createJobRegistry({ filePath, now: () => clock });

  const oldSucceeded = await finish(registry, stageInput('old-succeeded', 'retention-key-succeeded'));
  const oldFailed = await finish(registry, stageInput('old-failed'), 'failed');
  const oldCancelled = await registry.enqueue(stageInput('old-cancelled'));
  await registry.cancel(oldCancelled.id);
  const oldRunning = await registry.enqueue(stageInput('old-running'));
  assert.equal((await registry.claimNext('server-1')).job.id, oldRunning.id);
  const oldQueued = await registry.enqueue(stageInput('old-queued', null, 'server-2'));

  clock += 29 * DAY;
  const recentSucceeded = await finish(registry, stageInput('recent-succeeded'));
  assert.equal((await registry.listJobs()).length, 6, 'nothing is archived inside the retention period');
  await assert.rejects(readFile(jobArchivePathFor(filePath)), { code: 'ENOENT' });

  clock += 2 * DAY;
  const trigger = await registry.enqueue(stageInput('trigger'));

  assert.deepEqual(await storedIds(jobArchivePathFor(filePath)), [oldCancelled.id, oldFailed.id, oldSucceeded.id].sort());
  assert.deepEqual(await storedIds(filePath), [oldQueued.id, oldRunning.id, recentSucceeded.id, trigger.id].sort());
  assert.equal((await stat(jobArchivePathFor(filePath))).mode & 0o777, 0o600);
  assert.deepEqual((await registry.listJobs()).map((job) => job.id).sort(), await storedIds(filePath));

  // Archived jobs stay readable by id and by idempotency key.
  assert.equal((await registry.getJob(oldSucceeded.id)).status, 'succeeded');
  assert.equal((await registry.getJobForIdempotencyKey('retention-key-succeeded')).id, oldSucceeded.id);
  assert.equal((await registry.findIdempotentJob(stageInput('old-succeeded', 'retention-key-succeeded'))).id, oldSucceeded.id);

  // Replaying the same work returns the archived job without re-running it; different work still conflicts.
  const replay = await registry.enqueue(stageInput('old-succeeded', 'retention-key-succeeded'));
  assert.equal(replay.id, oldSucceeded.id);
  assert.equal(isNewlyEnqueuedJob(replay), false);
  await assert.rejects(
    registry.enqueue(stageInput('different-domain', 'retention-key-succeeded')),
    (error) => error instanceof JobRegistryError && error.code === 'job_idempotency_conflict',
  );
  assert.deepEqual(await storedIds(filePath), [oldQueued.id, oldRunning.id, recentSucceeded.id, trigger.id].sort());
});

test('startup archives expired finished jobs and keeps jobs the caller retains', async (t) => {
  const directory = await withDirectory(t);
  const filePath = path.join(directory, 'jobs.json');
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const writer = createJobRegistry({ filePath, now: () => clock });
  const reconciling = await finish(writer, stageInput('reconciling'));
  const archivable = await finish(writer, stageInput('archivable'));

  clock += 8 * DAY;
  const restarted = createJobRegistry({
    filePath,
    now: () => clock,
    retentionDays: 7,
    retainJob: (job) => job.id === reconciling.id,
  });
  await restarted.init();
  assert.deepEqual(await storedIds(filePath), [reconciling.id]);
  assert.deepEqual(await storedIds(jobArchivePathFor(filePath)), [archivable.id]);
});

test('an unreadable archive keeps finished jobs active instead of losing them', async (t) => {
  const directory = await withDirectory(t);
  const filePath = path.join(directory, 'jobs.json');
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const registry = createJobRegistry({ filePath, now: () => clock });
  const old = await finish(registry, stageInput('old'));
  await writeFile(jobArchivePathFor(filePath), '{not json', { mode: 0o600 });

  clock += 31 * DAY;
  const trigger = await registry.enqueue(stageInput('trigger'));
  assert.deepEqual(await storedIds(filePath), [old.id, trigger.id].sort());
  assert.equal(await readFile(jobArchivePathFor(filePath), 'utf8'), '{not json');
});

test('job retention days come from YUNPANEL_JOB_RETENTION_DAYS with a 30 day default', () => {
  assert.equal(jobRetentionDaysFromEnv({}), 30);
  assert.equal(jobRetentionDaysFromEnv({ YUNPANEL_JOB_RETENTION_DAYS: ' 90 ' }), 90);
  for (const value of ['0', '-1', '1.5', 'abc', '3651']) {
    assert.throws(() => jobRetentionDaysFromEnv({ YUNPANEL_JOB_RETENTION_DAYS: value }), { code: 'invalid_job_retention' });
  }
  assert.throws(() => createJobRegistry({ retentionDays: 0 }), { code: 'invalid_job_retention' });
});
