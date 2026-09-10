import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableJobRegistry, DurableJobRegistryError } from '../src/durable-job-registry.js';

function createFakeFactory({ initialJobs = [], failRecovery = false, failRecoveryRecord = false, blockMutation = null, blockInit = null } = {}) {
  let disk = structuredClone(initialJobs);
  let factories = 0;
  let initCalls = 0;
  let failBeforeMethod = null;
  let failAfterMethod = null;
  let recoveryState = { version: 1, detectedAt: null, jobs: [] };
  let recoveryWrites = 0;

  const factory = () => {
    factories += 1;
    const instanceNumber = factories;
    let jobs = structuredClone(disk);

    async function persist(method) {
      if (blockMutation && method === 'enqueue') await blockMutation();
      if (failBeforeMethod === method) {
        failBeforeMethod = null;
        throw new Error('simulated persist failure before commit SECRET=hidden');
      }
      disk = structuredClone(jobs);
      if (failAfterMethod === method) {
        failAfterMethod = null;
        throw new Error('simulated acknowledgement failure after commit SECRET=hidden');
      }
    }

    return {
      async init() {
        initCalls += 1;
        if (blockInit) await blockInit();
        if (failRecovery && instanceNumber > 1) throw new Error('/private/path must not leak');
      },
      async enqueue(input) {
        const job = { ...input, status: 'queued' };
        jobs.push(job);
        await persist('enqueue');
        return structuredClone(job);
      },
      async claimNext(serverId) {
        const job = jobs.find((entry) => entry.serverId === serverId && entry.status === 'queued');
        if (!job) return null;
        job.status = 'running';
        await persist('claimNext');
        return { job: structuredClone(job), envelope: { id: job.id, operation: job.operation, payload: {} } };
      },
      async complete({ serverId, jobId, status }) {
        const job = jobs.find((entry) => entry.id === jobId && entry.serverId === serverId);
        if (!job || job.status !== 'running') throw new Error('job is not running');
        job.status = status;
        await persist('complete');
        return structuredClone(job);
      },
      async cancel(jobId) {
        const job = jobs.find((entry) => entry.id === jobId);
        if (!job || job.status !== 'queued') throw new Error('job is not queued');
        job.status = 'cancelled';
        await persist('cancel');
        return structuredClone(job);
      },
      async getJob(id) { return structuredClone(jobs.find((job) => job.id === id) ?? null); },
      async listJobs({ status = null } = {}) { return structuredClone(jobs.filter((job) => !status || job.status === status)); },
    };
  };

  const recoveryStoreFactory = () => ({
    async init() {
      if (failRecoveryRecord) throw new Error('SECRET recovery record failure');
    },
    async replace(jobs) {
      if (failRecoveryRecord) throw new Error('SECRET recovery record failure');
      recoveryWrites += 1;
      recoveryState = {
        version: 1,
        detectedAt: jobs.length ? '2026-09-10T01:00:00.000Z' : null,
        jobs: structuredClone(jobs),
      };
      return structuredClone(recoveryState);
    },
    snapshot() { return structuredClone(recoveryState); },
  });

  return {
    factory,
    recoveryStoreFactory,
    failBeforeCommit(method) { failBeforeMethod = method; },
    failAfterCommit(method) { failAfterMethod = method; },
    disk() { return structuredClone(disk); },
    factoryCount() { return factories; },
    initCalls() { return initCalls; },
    recoveryState() { return structuredClone(recoveryState); },
    recoveryWrites() { return recoveryWrites; },
  };
}

function durable(fake) {
  return createDurableJobRegistry({
    filePath: '/virtual/jobs.json',
    registryFactory: fake.factory,
    recoveryStoreFactory: fake.recoveryStoreFactory,
  });
}

const runningJob = {
  id: '12345678-1234-4234-8234-123456789012',
  serverId: 'server-1',
  operation: 'system.packages.inspect',
  status: 'running',
};

test('concurrent init calls share one underlying durable initialization', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = createFakeFactory({ blockInit: () => blocked });
  const registry = durable(fake);
  const first = registry.init();
  const second = registry.init();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.initCalls(), 1);
  release();
  await Promise.all([first, second]);
  assert.equal(fake.initCalls(), 1);
});

test('failed mutation discards dirty in-memory state and reloads last committed disk state', async () => {
  const committed = { id: 'committed', serverId: 'server-1', status: 'queued' };
  const fake = createFakeFactory({ initialJobs: [committed] });
  const registry = durable(fake);
  await registry.init();
  fake.failBeforeCommit('enqueue');
  await assert.rejects(registry.enqueue({ id: 'dirty-job', serverId: 'server-1' }), /before commit/);
  assert.deepEqual(await registry.listJobs(), [committed]);
  assert.deepEqual(fake.disk(), [committed]);
  assert.equal(fake.factoryCount(), 2);
  assert.equal(registry.failure(), null);
});

test('reads wait for an in-flight mutation instead of observing dirty state', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = createFakeFactory({ blockMutation: () => blocked });
  const registry = durable(fake);
  const mutation = registry.enqueue({ id: 'job-0001', serverId: 'server-1' });
  let readFinished = false;
  const read = registry.listJobs().then((value) => { readFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readFinished, false);
  release();
  await mutation;
  assert.deepEqual(await read, [{ id: 'job-0001', serverId: 'server-1', status: 'queued' }]);
});

test('startup persists running jobs into the versioned recovery record and keeps reads available', async () => {
  const fake = createFakeFactory({ initialJobs: [runningJob] });
  const registry = durable(fake);
  await registry.init();
  assert.deepEqual(registry.recovery(), {
    code: 'durable_job_reconciliation_required',
    jobs: [{ jobId: runningJob.id, serverId: runningJob.serverId }],
  });
  assert.deepEqual(registry.recoveryRecord(), {
    version: 1,
    detectedAt: '2026-09-10T01:00:00.000Z',
    jobs: [{ jobId: runningJob.id, serverId: runningJob.serverId }],
  });
  assert.equal(fake.recoveryWrites(), 1);
  assert.deepEqual(await registry.listJobs({ status: 'running' }), [runningJob]);
  for (const action of [
    () => registry.enqueue({ id: 'new-job-1', serverId: 'server-1' }),
    () => registry.claimNext('server-1'),
    () => registry.cancel('queued-job'),
  ]) await assert.rejects(action(), (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_reconciliation_required');
});

test('confirmed late completion clears both in-memory and durable recovery state', async () => {
  const fake = createFakeFactory({ initialJobs: [runningJob] });
  const registry = durable(fake);
  await registry.init();
  const completed = await registry.complete({ serverId: runningJob.serverId, jobId: runningJob.id, status: 'succeeded' });
  assert.equal(completed.status, 'succeeded');
  assert.equal(registry.recovery(), null);
  assert.deepEqual(registry.recoveryRecord(), { version: 1, detectedAt: null, jobs: [] });
  const queued = await registry.enqueue({ id: 'new-job-2', serverId: 'server-1' });
  assert.equal(queued.status, 'queued');
});

test('claim acknowledgement failure reloads committed running state and records reconciliation requirement', async () => {
  const queued = { ...runningJob, id: 'queued-01', status: 'queued' };
  const fake = createFakeFactory({ initialJobs: [queued] });
  const registry = durable(fake);
  fake.failAfterCommit('claimNext');
  await assert.rejects(registry.claimNext('server-1'), /after commit/);
  assert.deepEqual(fake.disk(), [{ ...queued, status: 'running' }]);
  assert.deepEqual(registry.recoveryRecord().jobs, [{ jobId: queued.id, serverId: queued.serverId }]);
  await assert.rejects(registry.claimNext('server-1'), (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_reconciliation_required');
});

test('claim persist failure before commit reloads queued state without false recovery record', async () => {
  const queued = { ...runningJob, id: 'queued-02', status: 'queued' };
  const fake = createFakeFactory({ initialJobs: [queued] });
  const registry = durable(fake);
  fake.failBeforeCommit('claimNext');
  await assert.rejects(registry.claimNext('server-1'), /before commit/);
  assert.equal(registry.recovery(), null);
  assert.deepEqual(registry.recoveryRecord(), { version: 1, detectedAt: null, jobs: [] });
  assert.deepEqual(await registry.listJobs({ status: 'queued' }), [queued]);
});

test('recovery record failure latches the queue without exposing record errors', async () => {
  const fake = createFakeFactory({ initialJobs: [runningJob], failRecoveryRecord: true });
  const registry = durable(fake);
  await assert.rejects(
    registry.init(),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_recovery_record_failed' && !error.message.includes('SECRET'),
  );
  assert.deepEqual(registry.failure(), {
    code: 'durable_job_recovery_record_failed',
    message: 'Durable job recovery record could not be initialized',
  });
});

test('invalid persisted running identity fails closed without exposing arbitrary job metadata', async () => {
  const fake = createFakeFactory({ initialJobs: [{ id: 'x', serverId: 'SECRET-server', status: 'running' }] });
  const registry = durable(fake);
  await assert.rejects(registry.init(), (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_recovery_state_invalid' && !error.message.includes('SECRET'));
});

test('failed durable reload latches the wrapper and exposes only a safe recovery code', async () => {
  const fake = createFakeFactory({ failRecovery: true });
  const registry = durable(fake);
  fake.failBeforeCommit('enqueue');
  await assert.rejects(
    registry.enqueue({ id: 'dirty-job', serverId: 'server-1' }),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_recovery_failed' && !error.message.includes('SECRET'),
  );
  assert.deepEqual(registry.failure(), { code: 'durable_job_recovery_failed', message: 'Durable job registry could not recover committed state' });
});

test('constructor rejects non-durable usage and invalid factories', () => {
  assert.throws(() => createDurableJobRegistry({ registryFactory: () => ({}) }), { code: 'durable_job_store_required' });
  assert.throws(() => createDurableJobRegistry({ filePath: '/virtual/jobs.json' }), { code: 'durable_job_factory_required' });
  assert.throws(() => createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: () => ({}), recoveryStoreFactory: null }), { code: 'durable_job_recovery_factory_required' });
});
