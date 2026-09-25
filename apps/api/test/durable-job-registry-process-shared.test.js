import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry } from '../src/job-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-shared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'jobs.json');
  const create = () => createDurableJobRegistry({
    filePath,
    registryFactory: createJobRegistry,
  });
  const left = create();
  const right = create();
  await Promise.all([left.init(), right.init()]);
  return { left, right };
}

function request(resourceId) {
  return {
    serverId: 'server-a',
    type: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    payload: {},
    resourceType: 'system',
    resourceId,
  };
}

test('independent durable registry instances reload committed jobs before reads and writes', async (t) => {
  const { left, right } = await fixture(t);
  const first = await left.enqueue(request('system-a'));
  assert.equal((await right.getJob(first.id)).id, first.id);

  const second = await right.enqueue(request('system-b'));
  const leftJobs = await left.listJobs();
  const rightJobs = await right.listJobs();
  assert.deepEqual(leftJobs.map((job) => job.id).sort(), [first.id, second.id].sort());
  assert.deepEqual(rightJobs.map((job) => job.id).sort(), [first.id, second.id].sort());
});

test('simultaneous independent enqueues do not lose either committed job', async (t) => {
  const { left, right } = await fixture(t);
  const [first, second] = await Promise.all([
    left.enqueue(request('system-a')),
    right.enqueue(request('system-b')),
  ]);
  const jobs = await left.listJobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.id).sort(), [first.id, second.id].sort());
  assert.equal((await right.listJobs()).length, 2);
});
