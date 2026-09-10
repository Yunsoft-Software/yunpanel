import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJobRecoveryStore, JobRecoveryStoreError } from '../src/job-recovery-store.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'job-registry.recovery.json');
}

test('recovery store writes a versioned secret-free record atomically', async (t) => {
  const filePath = await fixture(t);
  const store = createJobRecoveryStore({ filePath, now: () => Date.parse('2026-09-10T01:00:00.000Z') });
  await store.replace([{ jobId: '12345678-1234-4234-8234-123456789012', serverId: 'server-1' }]);
  assert.deepEqual(store.snapshot(), {
    version: 1,
    detectedAt: '2026-09-10T01:00:00.000Z',
    jobs: [{ jobId: '12345678-1234-4234-8234-123456789012', serverId: 'server-1' }],
  });
  const persisted = await readFile(filePath, 'utf8');
  assert.doesNotMatch(persisted, /payload|result|error|secret/i);
  assert.deepEqual(JSON.parse(persisted), store.snapshot());
});

test('empty recovery clears timestamp while preserving store version', async (t) => {
  const filePath = await fixture(t);
  const store = createJobRecoveryStore({ filePath, now: () => 1_000 });
  await store.replace([{ jobId: 'job-00001', serverId: 'server-1' }]);
  await store.replace([]);
  assert.deepEqual(store.snapshot(), { version: 1, detectedAt: null, jobs: [] });
});

test('existing valid recovery state is loaded without mutation', async (t) => {
  const filePath = await fixture(t);
  const existing = {
    version: 1,
    detectedAt: '2026-09-10T01:00:00.000Z',
    jobs: [{ jobId: 'job-00001', serverId: 'server-1' }],
  };
  await writeFile(filePath, JSON.stringify(existing), { mode: 0o600 });
  const store = createJobRecoveryStore({ filePath });
  await store.init();
  assert.deepEqual(store.snapshot(), existing);
});

test('malformed, duplicate or extra recovery fields fail closed', async (t) => {
  for (const value of [
    { version: 2, detectedAt: null, jobs: [] },
    { version: 1, detectedAt: null, jobs: [{ jobId: 'short', serverId: 'server-1' }] },
    { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [{ jobId: 'job-00001', serverId: 'server-1' }, { jobId: 'job-00001', serverId: 'server-1' }] },
    { version: 1, detectedAt: null, jobs: [], secret: 'must-not-be-accepted' },
  ]) {
    const filePath = await fixture(t);
    await writeFile(filePath, JSON.stringify(value), { mode: 0o600 });
    const store = createJobRecoveryStore({ filePath });
    await assert.rejects(store.init(), (error) => error instanceof JobRecoveryStoreError && error.code.startsWith('invalid_job_recovery_'));
  }
});

test('replace validates identities before creating the recovery file', async (t) => {
  const filePath = await fixture(t);
  const store = createJobRecoveryStore({ filePath });
  await assert.rejects(
    store.replace([{ jobId: 'job-00001', serverId: 'server-1', payload: { secret: 'x' } }]),
    (error) => error instanceof JobRecoveryStoreError && error.code === 'invalid_job_recovery_record',
  );
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
});

test('journal add and remove preserve the first detection timestamp until the last identity clears', async (t) => {
  const filePath = await fixture(t);
  let now = Date.parse('2026-09-10T01:00:00.000Z');
  const store = createJobRecoveryStore({ filePath, now: () => now });
  const first = { jobId: 'job-00001', serverId: 'server-1' };
  const second = { jobId: 'job-00002', serverId: 'server-2' };

  await store.add(first);
  now = Date.parse('2026-09-10T01:05:00.000Z');
  await store.add(second);
  await store.add(first);
  assert.deepEqual(store.snapshot(), {
    version: 1,
    detectedAt: '2026-09-10T01:00:00.000Z',
    jobs: [first, second],
  });

  await store.remove(first);
  assert.equal(store.snapshot().detectedAt, '2026-09-10T01:00:00.000Z');
  assert.deepEqual(store.snapshot().jobs, [second]);
  await store.remove(second);
  assert.deepEqual(store.snapshot(), { version: 1, detectedAt: null, jobs: [] });
});

test('concurrent journal additions serialize state computation instead of losing an identity', async (t) => {
  const filePath = await fixture(t);
  const store = createJobRecoveryStore({ filePath, now: () => Date.parse('2026-09-10T01:00:00.000Z') });
  const first = { jobId: 'job-00001', serverId: 'server-1' };
  const second = { jobId: 'job-00002', serverId: 'server-2' };
  await Promise.all([store.add(first), store.add(second)]);
  assert.deepEqual(new Set(store.snapshot().jobs.map((job) => `${job.serverId}:${job.jobId}`)), new Set([
    'server-1:job-00001',
    'server-2:job-00002',
  ]));
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), store.snapshot());
});

test('journal mutations reject extra fields and removing an absent valid identity is idempotent', async (t) => {
  const filePath = await fixture(t);
  const store = createJobRecoveryStore({ filePath });
  await assert.rejects(
    store.add({ jobId: 'job-00001', serverId: 'server-1', result: { secret: 'x' } }),
    { code: 'invalid_job_recovery_record' },
  );
  await store.add({ jobId: 'job-00001', serverId: 'server-1' });
  const before = store.snapshot();
  await store.remove({ jobId: 'job-00002', serverId: 'server-1' });
  assert.deepEqual(store.snapshot(), before);
});
