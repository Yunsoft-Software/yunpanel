import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningInspection, JobRunningRecoveryError } from '../src/job-running-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const stopped = async () => ({ apiActive: false, agentActive: false });

function candidate(operation = OPERATIONS.SYSTEM_PACKAGES_INSPECT, resourceType = 'system') {
  return {
    jobId,
    serverId,
    status: 'running',
    operation,
    resourceType,
    resourceId: serverId,
  };
}

function registry(job = candidate()) {
  const events = [];
  return {
    events,
    async getJob(id) {
      events.push(['get', id]);
      return {
        id: job.jobId,
        serverId: job.serverId,
        status: job.status,
        operation: job.operation,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
      };
    },
    async complete(input) {
      events.push(['complete', input]);
      return {
        id: input.jobId,
        serverId: input.serverId,
        status: input.status,
        operation: job.operation,
        resourceType: job.resourceType,
        resourceId: job.resourceId,
        result: input.result,
      };
    },
  };
}

async function inspectWith(job) {
  return { version: 1, state: 'execution_state_unknown', jobs: [job] };
}

test('package inspection recovery repeats only the read-only probe and durably completes the exact job', async () => {
  const job = candidate();
  const jobRegistry = registry(job);
  const executions = [];
  const result = await recoverRunningInspection({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus: stopped,
    inspect: async () => inspectWith(job),
    executeOperation: async (operation, payload) => {
      executions.push([operation, payload]);
      return { packageName: 'yunpanel', installed: true, installedVersion: '0.3.0', candidateVersion: '0.3.0', updateAvailable: false };
    },
  });
  assert.deepEqual(executions, [[OPERATIONS.SYSTEM_PACKAGES_INSPECT, {}]]);
  assert.equal(jobRegistry.events.filter(([name]) => name === 'complete').length, 1);
  assert.deepEqual(result, {
    serverId,
    jobId,
    operation: OPERATIONS.SYSTEM_PACKAGES_INSPECT,
    status: 'succeeded',
    recoveryMethod: 'safe_read_only_reexecution',
  });
});

test('database inspection is the only other initially allowlisted running recovery operation', async () => {
  const job = candidate(OPERATIONS.DATABASE_INSPECT, 'database');
  const jobRegistry = registry(job);
  const result = await recoverRunningInspection({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus: stopped,
    inspect: async () => inspectWith(job),
    executeOperation: async () => ({ engine: 'mariadb', version: '11.4', databases: [] }),
  });
  assert.equal(result.operation, OPERATIONS.DATABASE_INSPECT);
});

test('mutating and payload-dependent operations are rejected before host execution or completion', async () => {
  for (const [operation, resourceType] of [
    [OPERATIONS.SYSTEM_UPGRADE, 'system'],
    [OPERATIONS.SYSTEM_SERVICES_INSPECT, 'system'],
    [OPERATIONS.DATABASE_CREATE, 'database'],
    [OPERATIONS.DOMAIN_ACTIVATE, 'domain'],
    [OPERATIONS.SSL_RENEW, 'certificate'],
    [OPERATIONS.APP_NODE_STATUS, 'application'],
    [OPERATIONS.APP_NODE_RESTART, 'application'],
  ]) {
    const job = candidate(operation, resourceType);
    const jobRegistry = registry(job);
    let executions = 0;
    await assert.rejects(
      recoverRunningInspection({
        serverId,
        jobId,
        jobRegistry,
        serviceStatus: stopped,
        inspect: async () => inspectWith(job),
        executeOperation: async () => { executions += 1; return {}; },
      }),
      (error) => error instanceof JobRunningRecoveryError && error.code === 'job_running_recovery_operation_unsafe',
    );
    assert.equal(executions, 0);
    assert.equal(jobRegistry.events.some(([name]) => name === 'complete'), false);
  }
});

test('a failed repeated inspection leaves the durable job unresolved and redacts host errors', async () => {
  const job = candidate();
  const jobRegistry = registry(job);
  await assert.rejects(
    recoverRunningInspection({
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: stopped,
      inspect: async () => inspectWith(job),
      executeOperation: async () => { throw new Error('TOKEN=PRIVATE /private/path'); },
    }),
    (error) => error instanceof JobRunningRecoveryError
      && error.code === 'job_running_recovery_probe_failed'
      && !error.message.includes('PRIVATE')
      && !error.message.includes('/private'),
  );
  assert.equal(jobRegistry.events.some(([name]) => name === 'complete'), false);
});

test('running recovery requires both command consumers stopped', async () => {
  const job = candidate();
  const jobRegistry = registry(job);
  await assert.rejects(
    recoverRunningInspection({
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: true, agentActive: false }),
      inspect: async () => inspectWith(job),
      executeOperation: async () => ({}),
    }),
    (error) => error instanceof JobRunningRecoveryError && error.code === 'job_running_recovery_consumers_must_be_stopped',
  );
  assert.equal(jobRegistry.events.length, 0);
});

test('candidate and persisted identity metadata must match exactly', async () => {
  const job = candidate();
  const jobRegistry = registry({ ...job, resourceId: 'other-server' });
  await assert.rejects(
    recoverRunningInspection({
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: stopped,
      inspect: async () => inspectWith(job),
      executeOperation: async () => ({}),
    }),
    (error) => error instanceof JobRunningRecoveryError && error.code === 'job_running_recovery_job_mismatch',
  );
});
