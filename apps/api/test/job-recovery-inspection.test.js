import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectDurableJobRecovery, JobRecoveryInspectionError } from '../src/job-recovery-inspection.js';

function createRegistry({ recovery = null, record = { version: 1, detectedAt: null, jobs: [] }, running = [], initError = null } = {}) {
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
  attempts: 1,
  payload: { secret: 'must-not-leak' },
  result: { token: 'must-not-leak' },
  error: { message: 'SECRET must-not-leak' },
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

test('recovery inspection exposes only safe running-job metadata', async () => {
  const registry = createRegistry({
    recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
    record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
    running: [runningJob],
  });
  const result = await inspectDurableJobRecovery({ registry });
  assert.deepEqual(result, {
    version: 1,
    state: 'reconciliation_required',
    code: 'durable_job_reconciliation_required',
    detectedAt: '2026-09-10T01:00:00.000Z',
    jobs: [{
      jobId: identity.jobId,
      serverId: identity.serverId,
      operation: 'system.packages.inspect',
      resourceType: 'system',
      resourceId: 'server-1',
      createdAt: '2026-09-10T00:59:00.000Z',
      startedAt: '2026-09-10T01:00:00.000Z',
      attempts: 1,
    }],
  });
  assert.doesNotMatch(JSON.stringify(result), /payload|result|error|secret|token|must-not-leak/i);
});

test('recovery inspection fails closed when sidecar, memory and disk identities disagree', async () => {
  const registry = createRegistry({
    recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
    record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
    running: [{ ...runningJob, id: '87654321-1234-4234-8234-123456789012' }],
  });
  await assert.rejects(
    inspectDurableJobRecovery({ registry }),
    (error) => error instanceof JobRecoveryInspectionError && error.code === 'job_recovery_inspection_invalid',
  );
});

test('malformed recovery timestamps and running identities are rejected', async () => {
  for (const registry of [
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: 'not-a-date', jobs: [identity] },
      running: [runningJob],
    }),
    createRegistry({
      recovery: { code: 'durable_job_reconciliation_required', jobs: [identity] },
      record: { version: 1, detectedAt: '2026-09-10T01:00:00.000Z', jobs: [identity] },
      running: [{ ...runningJob, id: 'bad id with spaces' }],
    }),
  ]) {
    await assert.rejects(inspectDurableJobRecovery({ registry }), { code: 'job_recovery_inspection_invalid' });
  }
});

test('registry initialization failures are redacted from operator diagnostics', async () => {
  await assert.rejects(
    inspectDurableJobRecovery({ registry: createRegistry({ initError: new Error('SECRET=/private/path') }) }),
    (error) => error instanceof JobRecoveryInspectionError
      && error.code === 'job_recovery_inspection_unavailable'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
});

test('recovery inspection requires the durable registry boundary', async () => {
  await assert.rejects(
    inspectDurableJobRecovery({ registry: { init() {} } }),
    (error) => error instanceof JobRecoveryInspectionError && error.code === 'job_recovery_registry_required',
  );
});
