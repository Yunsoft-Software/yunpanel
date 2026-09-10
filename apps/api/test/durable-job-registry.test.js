import assert from 'node:assert/strict';
import test from 'node:test';
import { createDurableJobRegistry, DurableJobRegistryError } from '../src/durable-job-registry.js';

function createFakeFactory({ initialJobs = [], failRecovery = false, blockMutation = null, blockInit = null } = {}) {
  let disk = structuredClone(initialJobs);
  let factories = 0;
  let initCalls = 0;
  let failNext = false;
  const factory = () => {
    factories += 1;
    const instanceNumber = factories;
    let jobs = structuredClone(disk);
    return {
      async init() {
        initCalls += 1;
        if (blockInit) await blockInit();
        if (failRecovery && instanceNumber > 1) throw new Error('/private/path must not leak');
      },
      async enqueue(input) {
        jobs.push({ ...input, status: 'queued' });
        if (blockMutation) await blockMutation();
        if (failNext) {
          failNext = false;
          throw new Error('simulated persist failure SECRET=hidden');
        }
        disk = structuredClone(jobs);
        return structuredClone(jobs.at(-1));
      },
      async claimNext() { return null; },
      async complete() { return null; },
      async cancel() { return null; },
      async getJob(id) { return structuredClone(jobs.find((job) => job.id === id) ?? null); },
      async listJobs() { return structuredClone(jobs); },
    };
  };
  return {
    factory,
    failNextMutation() { failNext = true; },
    disk() { return structuredClone(disk); },
    factoryCount() { return factories; },
    initCalls() { return initCalls; },
  };
}

test('concurrent init calls share one underlying durable initialization', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = createFakeFactory({ blockInit: () => blocked });
  const registry = createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: fake.factory });
  const first = registry.init();
  const second = registry.init();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fake.initCalls(), 1);
  release();
  await Promise.all([first, second]);
  assert.equal(fake.initCalls(), 1);
});

test('failed mutation discards dirty in-memory state and reloads last committed disk state', async () => {
  const fake = createFakeFactory({ initialJobs: [{ id: 'committed', status: 'queued' }] });
  const registry = createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: fake.factory });
  await registry.init();
  fake.failNextMutation();
  await assert.rejects(registry.enqueue({ id: 'dirty' }), /simulated persist failure/);
  assert.deepEqual(await registry.listJobs(), [{ id: 'committed', status: 'queued' }]);
  assert.deepEqual(fake.disk(), [{ id: 'committed', status: 'queued' }]);
  assert.equal(fake.factoryCount(), 2);
  assert.equal(registry.failure(), null);
});

test('registry remains usable after successful durable reload', async () => {
  const fake = createFakeFactory();
  const registry = createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: fake.factory });
  fake.failNextMutation();
  await assert.rejects(registry.enqueue({ id: 'first' }));
  await registry.enqueue({ id: 'second' });
  assert.deepEqual(await registry.listJobs(), [{ id: 'second', status: 'queued' }]);
  assert.deepEqual(fake.disk(), [{ id: 'second', status: 'queued' }]);
});

test('reads wait for an in-flight mutation instead of observing dirty state', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const fake = createFakeFactory({ blockMutation: () => blocked });
  const registry = createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: fake.factory });
  const mutation = registry.enqueue({ id: 'job-1' });
  let readFinished = false;
  const read = registry.listJobs().then((value) => { readFinished = true; return value; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readFinished, false);
  release();
  await mutation;
  assert.deepEqual(await read, [{ id: 'job-1', status: 'queued' }]);
});

test('failed durable reload latches the wrapper and exposes only a safe recovery code', async () => {
  const fake = createFakeFactory({ failRecovery: true });
  const registry = createDurableJobRegistry({ filePath: '/virtual/jobs.json', registryFactory: fake.factory });
  fake.failNextMutation();
  await assert.rejects(
    registry.enqueue({ id: 'dirty' }),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_recovery_failed' && !error.message.includes('SECRET'),
  );
  assert.deepEqual(registry.failure(), {
    code: 'durable_job_recovery_failed',
    message: 'Durable job registry could not recover committed state',
  });
  await assert.rejects(
    registry.listJobs(),
    (error) => error instanceof DurableJobRegistryError && error.code === 'durable_job_recovery_failed',
  );
});

test('constructor rejects non-durable usage and invalid factories', () => {
  assert.throws(() => createDurableJobRegistry({ registryFactory: () => ({}) }), { code: 'durable_job_store_required' });
  assert.throws(() => createDurableJobRegistry({ filePath: '/virtual/jobs.json' }), { code: 'durable_job_factory_required' });
});
