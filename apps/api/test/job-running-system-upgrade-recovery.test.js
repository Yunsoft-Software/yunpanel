import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { recoverRunningSystemUpgrade } from '../src/job-running-system-upgrade-recovery.js';

const serverId = 'server-1';
const jobId = '7f217caa-0f0f-4569-a657-30a97bcb7ca0';

function fixture({ upgraded = true, receipt = true, installedVersion = '0.4.0' } = {}) {
  const events = [];
  let status = 'running';
  const previousVersion = upgraded ? '0.3.0' : '0.4.0';
  const receiptValue = receipt ? {
    serverId,
    jobId,
    packageName: 'yunpanel',
    installedVersion: '0.4.0',
    candidateVersion: '0.4.0',
    updateAvailable: false,
    previousVersion,
    upgraded,
    restartScheduled: upgraded,
  } : null;
  const jobRegistry = {
    async getJob() { events.push('get'); return { id: jobId, serverId, status, operation: OPERATIONS.SYSTEM_UPGRADE, resourceType: 'system', resourceId: serverId }; },
    async beginReconciliation() { events.push('begin'); return { serverId, jobId, status: 'running', pending: true }; },
    async complete(input) { events.push('complete'); status = input.status; return { id: jobId, serverId, status, operation: OPERATIONS.SYSTEM_UPGRADE, resourceType: 'system', resourceId: serverId, result: input.result }; },
    async acknowledgeReconciliation() { events.push('ack'); return { serverId, jobId, status: 'succeeded', acknowledged: true }; },
  };
  return {
    events,
    options: {
      serverId,
      jobId,
      jobRegistry,
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
      inspect: async () => ({ jobs: [{ jobId, serverId, status: 'running', operation: OPERATIONS.SYSTEM_UPGRADE, resourceType: 'system', resourceId: serverId }] }),
      loadJobContext: async () => {
        events.push('context');
        return { id: jobId, serverId, status: 'running', operation: OPERATIONS.SYSTEM_UPGRADE, resourceType: 'system', resourceId: serverId, payload: {} };
      },
      readUpgradeReceipt: async () => { events.push('receipt'); return receiptValue; },
      inspectPackageState: async () => {
        events.push('state');
        return { packageName: 'yunpanel', installed: true, installedVersion, candidateVersion: '0.4.0', updateAvailable: installedVersion !== '0.4.0' };
      },
      reconcile: async () => { events.push('reconcile'); return { reconciled: true, error: null }; },
    },
  };
}

for (const upgraded of [true, false]) {
  test(`system upgrade recovery completes verified ${upgraded ? 'version transition' : 'no-op'} result`, async () => {
    const fx = fixture({ upgraded });
    const result = await recoverRunningSystemUpgrade(fx.options);
    assert.equal(result.recoveryMethod, 'verified_system_upgrade_receipt_and_package_state');
    assert.equal(result.upgraded, upgraded);
    assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'state', 'begin', 'complete', 'reconcile', 'ack']);
  });
}

test('missing system upgrade receipt prevents package state from proving historical completion', async () => {
  const fx = fixture({ receipt: false });
  await assert.rejects(recoverRunningSystemUpgrade(fx.options), { code: 'job_system_upgrade_recovery_receipt_missing' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt']);
});

test('current package drift leaves system upgrade unresolved before journal mutation', async () => {
  const fx = fixture({ installedVersion: '0.5.0' });
  await assert.rejects(recoverRunningSystemUpgrade(fx.options), { code: 'job_system_upgrade_recovery_evidence_not_satisfied' });
  assert.deepEqual(fx.events, ['get', 'context', 'receipt', 'state']);
});
