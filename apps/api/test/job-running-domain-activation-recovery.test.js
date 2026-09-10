import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningDomainActivation } from '../src/job-running-domain-activation-recovery.js';

const serverId = 'server-1';
const jobId = '12345678-1234-4234-8234-123456789012';
const resourceId = '87654321-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

function fixture({ receipt = undefined, evidence = undefined } = {}) {
  const events = [];
  let status = 'running';
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return { id: jobId, serverId, status, operation: OPERATIONS.DOMAIN_ACTIVATE, resourceType: 'domain', resourceId };
    },
    async beginReconciliation(identity) { events.push('begin'); return { ...identity, status: 'running', pending: true }; },
    async complete(input) {
      events.push('complete');
      status = input.status;
      return { id: jobId, serverId, status, operation: OPERATIONS.DOMAIN_ACTIVATE, resourceType: 'domain', resourceId, result: input.result };
    },
    async acknowledgeReconciliation(identity) { events.push('ack'); return { ...identity, status: 'succeeded', acknowledged: true }; },
  };
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      domainRegistry: {},
      certificateRegistry: {},
      applicationRegistry: {},
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.DOMAIN_ACTIVATE, resourceType: 'domain', resourceId }],
      }),
      loadJobContext: async () => {
        events.push('context');
        return {
          id: jobId,
          serverId,
          status: 'running',
          operation: OPERATIONS.DOMAIN_ACTIVATE,
          resourceType: 'domain',
          resourceId,
          payload: { primaryDomain: 'example.com', checksum },
        };
      },
      readActivationReceipt: async () => {
        events.push('receipt');
        return receipt === undefined ? { serverId, jobId, primaryDomain: 'example.com', checksum } : receipt;
      },
      inspectActiveEvidence: async () => {
        events.push('evidence');
        return evidence === undefined
          ? { satisfied: true, result: { configName: 'yunpanel-example.com.conf', checksum, active: true } }
          : evidence;
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

test('domain activation recovery requires receipt and active config before journaling', async () => {
  const fx = fixture();
  const result = await recoverRunningDomainActivation(fx.options);
  assert.equal(result.recoveryMethod, 'verified_domain_activation_receipt_and_active_config');
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
});

test('missing activation receipt leaves the running job untouched before active inspection', async () => {
  const fx = fixture({ receipt: null });
  await assert.rejects(recoverRunningDomainActivation(fx.options), { code: 'job_domain_activation_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});

test('active config drift leaves the running activation unresolved', async () => {
  const fx = fixture({ evidence: { satisfied: false, result: null } });
  await assert.rejects(recoverRunningDomainActivation(fx.options), { code: 'job_domain_activation_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'evidence']);
});
