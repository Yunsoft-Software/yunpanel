import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDurableJobRecovery, JobRecoveryInspectionError } from '../src/job-recovery-inspection.js';

function createRegistry({
  recovery = null,
  record = { version: 1, detectedAt: null, jobs: [] },
  running = [],
  jobs = running,
  initError = null,
} = {}) {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  return {
    async init() {
      if (initError) throw initError;
    },
    recovery() { return structuredClone(recovery); },
    recoveryRecord() { return structuredClone(record); },
    async listJobs({ status } = {}) {
      assert.equal(status, 'running');
      return structuredClone(running);
    },
    async getJob(jobId) {
      return structuredClone(byId.get(jobId) ?? null);
    },
  };
}

const identity = Object.freeze({
  jobId: '12345678-1234-4234-8234-123456789012',
  serverId: 'server-1',
});

const runningJob = Object.freeze({
  id: identity.jobId,
  serverId: identity.serverId,
  type: 'system-packages-inspect',
  operation: 'system.packages.inspect',
  resourceType: 'system',
  resourceId: 'server-1',
  status: 'running',
  createdAt: '2026-09-10T00:59:00.000Z',
  startedAt: '2026-09-10T01:00:00.000Z',
  finishedAt: null,
  attempts: 1,
  payload: { secret: 'must-not-leak' },
  result: { token: 'must-not-leak' },
  error: { message: 'SECRET must-not-leak' },
});

const terminalJob = Object.freeze({
  ...runningJob,
  status: 'failed',
  finishedAt: '2026-09-10T01:01:00.000Z',
  error: { code: 'host_failed', message: 'SECRET must-not-leak' },
});

test('clear recovery state is reported without inventing work', async () => {
  const result = await inspectDurableJobRecovery({ registry: createRegistry() });
  assert.deepEqual(result, {
    version: 1,
    state: 'clear',
    code: null,
    detectedAt: null,
    jobs: [],
  });
});

test('running recovery is classified as unknown execution state with safe metadata only', async () => {
  const registry = createRegistry({
    recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
    record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
    running: [runningJob],
  });
  const result = await inspectDurableJobRecovery({ registry });
  assert.equal(result.state, 'execution_state_unknown');
  assert.deepEqual(result.jobs, [{
    jobId: identity.jobId,
    serverId: identity.serverId,
    status: 'running',
    operation: 'system.packages.inspect',
    resourceType: 'system',
    resourceId: 'server-1',
    createdAt: '2026-09-10T00:59:00.000Z',
    startedAt: '2026-09-10T01:00:00.000Z',
    finishedAt: null,
    attempts: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(result), /payload|result|error|secret|token|must-not-leak/i);
});

test('terminal journal entries are reported as reconciliation-required after restart', async () => {
  const registry = createRegistry({
    recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
    record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
    running: [],
    jobs: [terminalJob],
  });
  const result = await inspectDurableJobRecovery({ registry });
  assert.equal(result.state, 'reconciliation_required');
  assert.equal(result.jobs[0].status, 'failed');
  assert.equal(result.jobs[0].finishedAt, '2026-09-10T01:01:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|must-not-leak|host_failed/);
});

test('mixed running and terminal recovery entries remain explicitly unresolved', async () => {
  const secondIdentity = { jobId: '87654321-1234-4234-8234-123456789012', serverId: 'server-2' };
  const secondTerminal = { ...terminalJob, id: secondIdentity.jobId, serverId: secondIdentity.serverId };
  const registry = createRegistry({
    recovery: { code: 'durable_job_reconciliation_required', jobs: [identity, secondIdentity] },
    record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity, secondIdentity] },
    running: [runningJob],
    jobs: [runningJob, secondTerminal],
  });
  const result = await inspectDurableJobRecovery({ registry });
  assert.equal(result.state, 'mixed_recovery_required');
  assert.deepEqual(result.jobs.map((job) => job.status).sort(), ['failed', 'running']);
});

test('recovery inspection fails closed when sidecar, memory or persisted job identities disagree', async () => {
  const wrong = { jobId: '87654321-1234-4234-8234-123456789012', serverId: 'server-1' };
  for (const registry of [
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [wrong] },
      record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
      running: [runningJob],
    }),
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
      running: [{ ...runningJob, id: wrong.jobId }],
      jobs: [runningJob, { ...runningJob, id: wrong.jobId }],
    }),
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
      running: [],
      jobs: [{ ...terminalJob, serverId: 'server-other' }],
    }),
  ]) {
    await assert.rejects(
      inspectDurableJobRecovery({ registry }),
      (error) => error instanceof JobRecoveryInspectionError && error.code === 'job_recovery_inspection_invalid',
    );
  }
});

test('malformed recovery timestamps and unsupported persisted statuses are rejected', async () => {
  for (const registry of [
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: 'not-a-date', jobs: [identity] },
      running: [runningJob],
    }),
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
      running: [],
      jobs: [{ ...terminalJob, status: 'cancelled' }],
    }),
  ]) {
    await assert.rejects(inspectDurableJobRecovery({ registry }), { code: 'job_recovery_inspection_invalid' });
  }
});

test('registry initialization and read failures are redacted from operator diagnostics', async () => {
  await assert.rejects(
    inspectDurableJobRecovery({ registry: createRegistry({ initError: new Error('SECRET=/private/path') }) }),
    (error) => error instanceof JobRecoveryInspectionError
      && error.code === 'job_recovery_inspection_unavailable'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
});

test('recovery inspection requires the durable registry read boundary', async () => {
  await assert.rejects(
    inspectDurableJobRecovery({ registry: { init() {}, listJobs() {}, recovery() {}, recoveryRecord() {} } }),
    (error) => error instanceof JobRecoveryInspectionError && error.code === 'job_recovery_registry_required',
  );
});
