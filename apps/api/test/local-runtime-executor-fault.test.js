import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalRuntime } from '../src/local-runtime.js';

const serverId = 'server-1';
const hostname = 'host-1.example.local';
const jobId = '12345678-1234-4234-8234-123456789012';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(onError) {
  const events = [];
  let executorOptions;
  const server = {
    id: serverId,
    hostname,
    executionMode: 'local',
    localBoundAt: '2026-09-10T00:00:00.000Z',
  };
  const runtime = await startLocalRuntime({
    serverId,
    hostname,
    runtimeVersion: '0.3.0',
    lockPath: '/var/lib/yunpanel/control-plane/local-executor.lock',
    registry: {
      getServer: async () => ({ ...server }),
      updateLocalSnapshot: async () => ({ ...server, localRuntimeVersion: '0.3.0' }),
    },
    jobRegistry: { listJobs: async () => [], claimNext: async () => null, complete: async () => null },
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    hostOperations: {
      operations: ['system.packages.inspect'],
      supports: () => true,
      executeOperation: async () => ({}),
    },
    executorFactory: (options) => {
      executorOptions = options;
      return {
        start: () => events.push('executor.start'),
        stop: async () => events.push('executor.stop'),
      };
    },
    acquireLock: async () => ({ release: async () => { events.push('lock.release'); return true; } }),
    reconcile: async () => ({ reconciled: true }),
    onError,
    snapshotIntervalMs: 60_000,
  });
  return { runtime, events, executorOptions: () => executorOptions };
}

test('fatal executor fault stops local ownership and forwards only authored safe metadata', async () => {
  const errors = [];
  const fx = await fixture((error) => errors.push(error));
  fx.executorOptions().onError(Object.assign(new Error('SECRET=/private/value'), {
    code: 'local_completion_unconfirmed',
    phase: 'complete',
    jobId,
  }));
  await delay(20);

  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'local_completion_unconfirmed');
  assert.equal(errors[0].phase, 'complete');
  assert.equal(errors[0].jobId, jobId);
  assert.equal(errors[0].message.includes('SECRET'), false);
  assert.equal(errors[0].cause, undefined);
  assert.deepEqual(fx.runtime.failure(), { code: 'local_completion_unconfirmed', phase: 'complete', jobId });
  assert.equal(fx.events.filter((event) => event === 'executor.stop').length, 1);
  assert.equal(fx.events.filter((event) => event === 'lock.release').length, 1);

  await fx.runtime.stop();
  assert.equal(fx.events.filter((event) => event === 'lock.release').length, 1);
});

test('malformed executor fault metadata cannot inject codes, phases or job identifiers', async () => {
  const errors = [];
  const fx = await fixture((error) => errors.push(error));
  fx.executorOptions().onError(Object.assign(new Error('private raw executor detail'), {
    code: 'bad\ncode',
    phase: '../phase',
    jobId: '../../secret',
  }));
  await delay(20);

  assert.deepEqual(fx.runtime.failure(), { code: 'local_executor_fault', phase: 'executor', jobId: null });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'local_executor_fault');
  assert.equal(errors[0].phase, 'executor');
  assert.equal(errors[0].jobId, null);
  assert.equal(errors[0].message.includes('private raw'), false);
  assert.equal(fx.events.filter((event) => event === 'lock.release').length, 1);
});
