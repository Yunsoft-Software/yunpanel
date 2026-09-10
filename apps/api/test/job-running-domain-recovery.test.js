import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { JobRunningDomainRecoveryError, recoverRunningDomainStage } from '../src/job-running-domain-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const resourceId = '87654321-1234-4234-8234-123456789012';
const payload = Object.freeze({
  primaryDomain: 'example.com',
  aliases: ['www.example.com'],
  targetType: 'proxy',
  target: { upstreamHost: '127.0.0.1', upstreamPort: 3000, websocket: true },
});
const result = Object.freeze({
  configName: 'yunpanel-example.com.conf',
  checksum: 'a'.repeat(64),
  bytes: 321,
});

function fixture({ operation = OPERATIONS.DOMAIN_STAGE, evidence = { satisfied: true, result }, reconcileError = null } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob(id) {
      events.push('get');
      assert.equal(id, jobId);
      return { id: jobId, serverId, status, operation, resourceType: 'domain', resourceId, payload };
    },
    async beginReconciliation(identity) {
      events.push('begin');
      assert.deepEqual(identity, { serverId, jobId });
      return { ...identity, status: 'running', pending: true };
    },
    async complete(input) {
      events.push('complete');
      assert.equal(input.status, 'succeeded');
      assert.deepEqual(input.result, result);
      status = 'succeeded';
      return { id: jobId, serverId, status, operation, resourceType: 'domain', resourceId, payload, result };
    },
    async acknowledgeReconciliation(identity) {
      events.push('ack');
      return { ...identity, status: 'succeeded', acknowledged: true };
    },
  };
  const inspection = {
    version: 1,
    state: 'execution_state_unknown',
    code: 'durable_job_reconciliation_required',
    detectedAt: '2026-09-10T10:00:00.000Z',
    jobs: [{ jobId, serverId, status: 'running', operation, resourceType: 'domain', resourceId }],
  };
  const options = {
    serverId,
    jobId,
    jobRegistry,
    domainRegistry: {},
    certificateRegistry: {},
    applicationRegistry: {},
    serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    inspect: async () => inspection,
    inspectStageEvidence: async (input) => {
      events.push('evidence');
      assert.deepEqual(input, payload);
      return evidence;
    },
    reconcile: async ({ job }) => {
      events.push('reconcile');
      assert.equal(job.status, 'succeeded');
      if (reconcileError) throw reconcileError;
      return { reconciled: true, error: null };
    },
  };
  return { events, options };
}

test('domain stage recovery proves host state before journaling and acknowledges only after reconciliation', async () => {
  const fx = fixture();
  const recovered = await recoverRunningDomainStage(fx.options);
  assert.equal(recovered.recoveryMethod, 'verified_staged_nginx_config');
  assert.equal(recovered.reconciled, true);
  assert.deepEqual(fx.events, ['get', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing exact staged evidence leaves the running job untouched', async () => {
  const fx = fixture({ evidence: { satisfied: false, result: null } });
  await assert.rejects(
    recoverRunningDomainStage(fx.options),
    (error) => error instanceof JobRunningDomainRecoveryError && error.code === 'job_domain_recovery_evidence_not_satisfied',
  );
  assert.deepEqual(fx.events, ['get', 'evidence']);
});

test('domain activate and other operations cannot enter staged-domain recovery', async () => {
  const fx = fixture({ operation: OPERATIONS.DOMAIN_ACTIVATE });
  await assert.rejects(
    recoverRunningDomainStage(fx.options),
    (error) => error instanceof JobRunningDomainRecoveryError && error.code === 'job_domain_recovery_job_mismatch',
  );
  assert.deepEqual(fx.events, []);
});

test('resource reconciliation failure leaves the terminal journal unacknowledged', async () => {
  const fx = fixture({ reconcileError: new Error('/private/path TOKEN=must-not-leak') });
  await assert.rejects(
    recoverRunningDomainStage(fx.options),
    (error) => error instanceof JobRunningDomainRecoveryError
      && error.code === 'job_domain_recovery_reconciliation_failed'
      && !error.message.includes('/private')
      && !error.message.includes('must-not-leak'),
  );
  assert.deepEqual(fx.events, ['get', 'evidence', 'begin', 'complete', 'reconcile']);
});

test('active API or agent blocks host evidence inspection', async () => {
  const fx = fixture();
  fx.options.serviceStatus = async () => ({ apiActive: true, agentActive: false });
  await assert.rejects(recoverRunningDomainStage(fx.options), { code: 'job_domain_recovery_consumers_must_be_stopped' });
  assert.deepEqual(fx.events, []);
});
