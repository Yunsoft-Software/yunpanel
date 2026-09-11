import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningInspection, JobRunningRecoveryError } from '../src/job-running-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const applicationId = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const stopped = async () => ({ apiActive: false, agentActive: false });

function candidate(operation = OPERATIONS.SYSTEM_PACKAGES_INSPECT, resourceType = 'system', resourceId = serverId) {
  return {
    jobId,
    serverId,
    status: 'running',
    operation,
    resourceType,
    resourceId,
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

function contextFor(job, payload) {
  return {
    id: job.jobId,
    serverId: job.serverId,
    status: 'running',
    operation: job.operation,
    resourceType: job.resourceType,
    resourceId: job.resourceId,
    payload,
  };
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

test('database inspection remains safely re-executable with an empty payload', async () => {
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

test('managed Node runtime inventory remains safely re-executable with an empty payload', async () => {
  const job = candidate(OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, 'system');
  const jobRegistry = registry(job);
  const executions = [];
  const result = await recoverRunningInspection({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus: stopped,
    inspect: async () => inspectWith(job),
    executeOperation: async (operation, payload) => { executions.push([operation, payload]); return { managedRuntimes: [] }; },
  });
  assert.equal(result.operation, OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT);
  assert.deepEqual(executions, [[OPERATIONS.SYSTEM_NODE_RUNTIMES_INSPECT, {}]]);
});

test('managed service inspection reuses only its exact private persisted payload', async () => {
  const job = candidate(OPERATIONS.SYSTEM_SERVICES_INSPECT, 'system');
  const jobRegistry = registry(job);
  const executions = [];
  await recoverRunningInspection({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus: stopped,
    inspect: async () => inspectWith(job),
    loadJobContext: async () => contextFor(job, { serviceId: 'nginx' }),
    executeOperation: async (operation, payload) => {
      executions.push([operation, payload]);
      return { id: 'nginx', installed: true, active: true, packages: [], units: [] };
    },
  });
  assert.deepEqual(executions, [[OPERATIONS.SYSTEM_SERVICES_INSPECT, { serviceId: 'nginx' }]]);
});

test('Node status recovery reuses the exact application-scoped private payload', async () => {
  const job = candidate(OPERATIONS.APP_NODE_STATUS, 'application', applicationId);
  const jobRegistry = registry(job);
  const payload = {
    applicationId,
    releaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
    runtime: { nodeMajor: 24, installMode: 'ci', buildScript: null, start: { mode: 'node', entryFile: 'server.js', script: null }, port: 3100, healthPath: '/health', healthTimeoutSeconds: 30, restartPolicy: 'on-failure' },
  };
  const executions = [];
  await recoverRunningInspection({
    serverId,
    jobId,
    jobRegistry,
    serviceStatus: stopped,
    inspect: async () => inspectWith(job),
    loadJobContext: async () => contextFor(job, payload),
    executeOperation: async (operation, actualPayload) => {
      executions.push([operation, actualPayload]);
      return { releaseId: payload.releaseId, healthy: true };
    },
  });
  assert.deepEqual(executions, [[OPERATIONS.APP_NODE_STATUS, payload]]);
});

test('payload-backed inspection refuses missing or mismatched private context before host execution', async () => {
  const job = candidate(OPERATIONS.APP_NODE_STATUS, 'application', applicationId);
  for (const loadJobContext of [
    null,
    async () => contextFor(job, { applicationId: 'different-app' }),
  ]) {
    const jobRegistry = registry(job);
    let executions = 0;
    await assert.rejects(
      recoverRunningInspection({
        serverId,
        jobId,
        jobRegistry,
        serviceStatus: stopped,
        inspect: async () => inspectWith(job),
        loadJobContext,
        executeOperation: async () => { executions += 1; return {}; },
      }),
      (error) => error instanceof JobRunningRecoveryError
        && ['job_running_recovery_context_unavailable', 'job_running_recovery_context_mismatch'].includes(error.code),
    );
    assert.equal(executions, 0);
  }
});

test('mutating operations remain rejected before host execution or completion', async () => {
  for (const [operation, resourceType, resourceId] of [
    [OPERATIONS.SYSTEM_UPGRADE, 'system', serverId],
    [OPERATIONS.DATABASE_CREATE, 'database', serverId],
    [OPERATIONS.DOMAIN_ACTIVATE, 'domain', 'domain-1'],
    [OPERATIONS.SSL_RENEW, 'certificate', 'certificate-1'],
    [OPERATIONS.APP_NODE_RESTART, 'application', applicationId],
  ]) {
    const job = candidate(operation, resourceType, resourceId);
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
