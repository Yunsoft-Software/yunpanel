import assert from 'node:assert/strict';
import test from 'node:test';
import { MANAGED_SERVICE_IDS, OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = 'server-1';

function serviceState(id, { installed = false, active = false } = {}) {
  return {
    id,
    label: 'must-not-persist',
    category: 'must-not-persist',
    installed,
    active,
    packages: [{ packageName: id, installed, version: installed ? '1.2.3-1' : null, raw: 'PRIVATE' }],
    units: [{
      unit: `${id}.service`,
      loadState: installed ? 'loaded' : 'not-found',
      activeState: active ? 'active' : 'inactive',
      subState: active ? 'running' : 'dead',
      unitFileState: installed ? 'enabled' : 'unknown',
      inspectionError: false,
      rawOutput: 'PRIVATE',
    }],
    stdout: 'PRIVATE',
  };
}

async function enqueueAndClaim(registry, operation, payload) {
  const job = await registry.enqueue({
    serverId,
    type: operation,
    operation,
    payload,
    resourceType: 'system',
    resourceId: serverId,
  });
  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, job.id);
  return claimed.job;
}

test('managed service catalog inspection persists only bounded structured state', async () => {
  const registry = createJobRegistry();
  const job = await enqueueAndClaim(registry, OPERATIONS.SYSTEM_SERVICES_INSPECT, {});
  const result = MANAGED_SERVICE_IDS.map((id) => serviceState(id));
  const completed = await registry.complete({ serverId, jobId: job.id, status: 'succeeded', result });

  assert.equal(completed.result.length, MANAGED_SERVICE_IDS.length);
  assert.deepEqual(completed.result.map((entry) => entry.id), MANAGED_SERVICE_IDS);
  assert.ok(!JSON.stringify(completed.result).includes('PRIVATE'));
  assert.equal(Object.hasOwn(completed.result[0], 'label'), false);
  assert.equal(Object.hasOwn(completed.result[0].packages[0], 'raw'), false);
});

test('single-service inspection must return the queued service identity', async () => {
  const registry = createJobRegistry();
  const job = await enqueueAndClaim(registry, OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'docker' });
  await assert.rejects(
    registry.complete({ serverId, jobId: job.id, status: 'succeeded', result: serviceState('nginx') }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
});

test('managed service install requires confirmed installed and active state', async () => {
  const registry = createJobRegistry();
  const job = await enqueueAndClaim(registry, OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'mariadb' });
  await assert.rejects(
    registry.complete({ serverId, jobId: job.id, status: 'succeeded', result: { ...serviceState('mariadb'), changed: true } }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );

  const validRegistry = createJobRegistry();
  const validJob = await enqueueAndClaim(validRegistry, OPERATIONS.SYSTEM_SERVICE_INSTALL, { serviceId: 'mariadb' });
  const completed = await validRegistry.complete({
    serverId,
    jobId: validJob.id,
    status: 'succeeded',
    result: { ...serviceState('mariadb', { installed: true, active: true }), changed: true },
  });
  assert.equal(completed.result.id, 'mariadb');
  assert.equal(completed.result.changed, true);
});

test('managed service control result must match action and resulting active state', async () => {
  const registry = createJobRegistry();
  const job = await enqueueAndClaim(registry, OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'nginx', action: 'stop' });
  const completed = await registry.complete({
    serverId,
    jobId: job.id,
    status: 'succeeded',
    result: { ...serviceState('nginx', { installed: true, active: false }), action: 'stop' },
  });
  assert.equal(completed.result.action, 'stop');
  assert.equal(completed.result.active, false);

  const invalidRegistry = createJobRegistry();
  const invalidJob = await enqueueAndClaim(invalidRegistry, OPERATIONS.SYSTEM_SERVICE_CONTROL, { serviceId: 'nginx', action: 'restart' });
  await assert.rejects(
    invalidRegistry.complete({
      serverId,
      jobId: invalidJob.id,
      status: 'succeeded',
      result: { ...serviceState('nginx', { installed: true, active: false }), action: 'stop' },
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
  );
});

test('job enqueue rejects unsupported managed service payloads through protocol validation', async () => {
  const registry = createJobRegistry();
  await assert.rejects(
    registry.enqueue({
      serverId,
      type: 'system.service.install',
      operation: OPERATIONS.SYSTEM_SERVICE_INSTALL,
      payload: { serviceId: 'ssh' },
      resourceType: 'system',
      resourceId: serverId,
    }),
    (error) => error instanceof JobRegistryError && error.code === 'invalid_operation_payload',
  );
});
