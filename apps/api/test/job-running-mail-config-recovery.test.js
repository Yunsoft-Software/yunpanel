import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningMailConfig } from '../src/job-running-mail-config-recovery.js';

const serverId = 'local-server';
const jobId = '11111111-2222-4333-8444-555555555555';
const mailDomainId = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const previewDigest = 'a'.repeat(64);
const configurationSha256 = 'b'.repeat(64);
const planSha256 = 'c'.repeat(64);
const readinessSha256 = 'd'.repeat(64);

function fixture({ receipt = undefined, evidence = undefined } = {}) {
  const events = [];
  let status = 'running';
  const payload = {
    mailDomainId,
    expectedRevision: 4,
    desiredStatus: 'enabled',
    previewDigest,
    configurationSha256,
  };
  const jobRegistry = {
    async getJob() {
      events.push('get');
      return { id: jobId, serverId, status, operation: OPERATIONS.MAIL_CONFIG_APPLY, resourceType: 'mail_domain', resourceId: mailDomainId };
    },
    async beginReconciliation(identity) { events.push('begin'); return { ...identity, status: 'running', pending: true }; },
    async complete(input) {
      events.push('complete');
      status = input.status;
      return { id: jobId, serverId, status, operation: OPERATIONS.MAIL_CONFIG_APPLY, resourceType: 'mail_domain', resourceId: mailDomainId, payload, result: input.result };
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
      mailDomainRegistry: {
        getMailDomain: async () => ({ id: mailDomainId, managementMode: 'local', status: 'disabled', revision: 4 }),
        transitionLocalStatus: async () => {},
      },
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({
        jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.MAIL_CONFIG_APPLY, resourceType: 'mail_domain', resourceId: mailDomainId }],
      }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: OPERATIONS.MAIL_CONFIG_APPLY, resourceType: 'mail_domain', resourceId: mailDomainId, payload };
      },
      readOperationReceipt: async () => {
        events.push('receipt');
        return receipt === undefined ? {
          serverId, jobId, mailDomainId, desiredStatus: 'enabled', previewDigest,
          configurationSha256, planSha256, readinessSha256, applied: true,
        } : receipt;
      },
      materializeTransition: async () => {
        events.push('materialize');
        return { preview: { sha256: configurationSha256 }, sensitiveArtifacts: [{ content: 'must-not-escape' }] };
      },
      inspectActiveEvidence: async () => {
        events.push('evidence');
        return evidence === undefined ? {
          satisfied: true,
          result: { version: 1, previewSha256: configurationSha256, planSha256, readinessSha256, applied: true, sideEffects: true },
        } : evidence;
      },
      reconcile: async ({ mailDomainRegistry }) => {
        events.push('reconcile');
        assert.equal(typeof mailDomainRegistry.transitionLocalStatus, 'function');
        return { reconciled: true, error: null };
      },
    },
  };
}

test('running managed mail recovery requires receipt and verified active host state before completion', async () => {
  const fx = fixture();
  const result = await recoverRunningMailConfig(fx.options);
  assert.equal(result.recoveryMethod, 'verified_mail_config_receipt_and_active_host_state');
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'materialize', 'evidence', 'begin', 'complete', 'reconcile', 'ack']);
  assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
});

test('missing managed mail receipt leaves running job unresolved before protected materialization', async () => {
  const fx = fixture({ receipt: null });
  await assert.rejects(recoverRunningMailConfig(fx.options), { code: 'job_mail_config_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});

test('managed mail host drift leaves running job unresolved', async () => {
  const fx = fixture({ evidence: { satisfied: false, result: null } });
  await assert.rejects(recoverRunningMailConfig(fx.options), { code: 'job_mail_config_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'materialize', 'evidence']);
});

test('managed mail receipt digest mismatch is rejected before desired-state materialization', async () => {
  const fx = fixture({
    receipt: {
      serverId, jobId, mailDomainId, desiredStatus: 'enabled', previewDigest,
      configurationSha256: 'e'.repeat(64), planSha256, readinessSha256, applied: true,
    },
  });
  await assert.rejects(recoverRunningMailConfig(fx.options), { code: 'job_mail_config_recovery_receipt_mismatch' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});
