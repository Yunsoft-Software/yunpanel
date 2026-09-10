import assert from 'node:assert/strict';
import test from 'node:test';
import { JobRecoveryCommandError, reconcileTerminalRecovery } from '../src/job-recovery-command.js';

const identity = Object.freeze({
  serverId: 'server-1',
  jobId: '12345678-1234-4234-8234-123456789012',
});

function terminalCandidate(status = 'failed') {
  return { ...identity, status, operation: 'system.packages.inspect' };
}

function fixture(overrides = {}) {
  const events = [];
  const candidate = overrides.candidate ?? terminalCandidate();
  const persisted = overrides.persisted ?? {
    id: identity.jobId,
    serverId: identity.serverId,
    status: candidate.status,
    resourceType: 'system',
    resourceId: identity.serverId,
    operation: 'system.packages.inspect',
  };
  const jobRegistry = overrides.jobRegistry ?? {
    async getJob(jobId) {
      events.push('getJob');
      assert.equal(jobId, identity.jobId);
      return { ...persisted };
    },
    async acknowledgeReconciliation(input) {
      events.push('acknowledge');
      assert.deepEqual(input, identity);
      return { ...identity, status: candidate.status, acknowledged: true };
    },
  };
  return {
    events,
    candidate,
    jobRegistry,
    serviceStatus: overrides.serviceStatus ?? (async () => {
      events.push('services');
      return { apiActive: false, agentActive: false };
    }),
    inspect: overrides.inspect ?? (async () => {
      events.push('inspect');
      return { state: 'reconciliation_required', jobs: [candidate] };
    }),
    reconcile: overrides.reconcile ?? (async ({ job }) => {
      events.push('reconcile');
      assert.equal(job.id, identity.jobId);
      return { reconciled: true, error: null };
    }),
  };
}

function run(fx) {
  return reconcileTerminalRecovery({
    ...identity,
    jobRegistry: fx.jobRegistry,
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    serviceStatus: fx.serviceStatus,
    inspect: fx.inspect,
    reconcile: fx.reconcile,
  });
}

test('terminal recovery reconciles desired state before clearing the durable journal', async () => {
  const fx = fixture();
  const result = await run(fx);
  assert.deepEqual(result, { ...identity, status: 'failed', reconciled: true });
  assert.deepEqual(fx.events, ['services', 'inspect', 'getJob', 'reconcile', 'acknowledge']);
});

test('running recovery is never converted into a terminal reconciliation', async () => {
  const fx = fixture({ candidate: terminalCandidate('running') });
  await assert.rejects(
    run(fx),
    (error) => error instanceof JobRecoveryCommandError && error.code === 'job_recovery_execution_state_unknown',
  );
  assert.deepEqual(fx.events, ['services', 'inspect']);
});

test('active API or legacy agent blocks recovery before durable state is touched', async () => {
  for (const status of [
    { apiActive: true, agentActive: false },
    { apiActive: false, agentActive: true },
  ]) {
    const fx = fixture({
      serviceStatus: async () => {
        fx.events.push('services');
        return status;
      },
    });
    await assert.rejects(run(fx), { code: 'job_recovery_consumers_must_be_stopped' });
    assert.deepEqual(fx.events, ['services']);
  }
});

test('persisted identity drift fails before reconciliation or acknowledgement', async () => {
  const fx = fixture({
    persisted: {
      id: identity.jobId,
      serverId: 'server-other',
      status: 'failed',
      resourceType: 'system',
      resourceId: 'server-other',
      operation: 'system.packages.inspect',
    },
  });
  await assert.rejects(run(fx), { code: 'job_recovery_job_mismatch' });
  assert.deepEqual(fx.events, ['services', 'inspect', 'getJob']);
});

test('reconciliation failures are redacted and never clear the journal', async () => {
  const fx = fixture({
    reconcile: async () => {
      fx.events.push('reconcile');
      throw new Error('SECRET=/private/path must-not-leak');
    },
  });
  await assert.rejects(
    run(fx),
    (error) => error instanceof JobRecoveryCommandError
      && error.code === 'job_recovery_reconciliation_failed'
      && !error.message.includes('SECRET')
      && !error.message.includes('/private/path'),
  );
  assert.deepEqual(fx.events, ['services', 'inspect', 'getJob', 'reconcile']);
});

test('invalid acknowledgement remains fail-closed after reconciliation', async () => {
  const fx = fixture({
    jobRegistry: {
      async getJob() {
        fx.events.push('getJob');
        return {
          id: identity.jobId,
          serverId: identity.serverId,
          status: 'failed',
          resourceType: 'system',
          resourceId: identity.serverId,
          operation: 'system.packages.inspect',
        };
      },
      async acknowledgeReconciliation() {
        fx.events.push('acknowledge');
        return { ...identity, status: 'failed', acknowledged: false };
      },
    },
  });
  await assert.rejects(run(fx), { code: 'job_recovery_acknowledgement_invalid' });
  assert.deepEqual(fx.events, ['services', 'inspect', 'getJob', 'reconcile', 'acknowledge']);
});
