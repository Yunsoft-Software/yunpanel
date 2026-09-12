import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { jobReconciliationInternals } from '../src/job-reconciliation.js';

function job({ expectedRevision = 4, desiredStatus = 'enabled' } = {}) {
  return {
    id: 'job-1',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    status: 'succeeded',
    resourceType: 'mail_domain',
    resourceId: 'mail-domain-1',
    payload: {
      mailDomainId: 'mail-domain-1',
      expectedRevision,
    },
    result: {
      mailDomainId: 'mail-domain-1',
      desiredStatus,
    },
  };
}

function registry(current) {
  const transitions = [];
  return {
    transitions,
    api: {
      getMailDomain: async () => ({ managementMode: 'local', ...current }),
      transitionLocalStatus: async (id, input) => {
        transitions.push([id, { ...input }]);
        return { id, status: input.status, revision: input.expectedRevision + 1, managementMode: 'local' };
      },
    },
  };
}

test('enabled to enabled managed mail refresh does not increment domain revision', async () => {
  const state = registry({ id: 'mail-domain-1', status: 'enabled', revision: 4 });
  await jobReconciliationInternals.reconcileMailDomainJob(state.api, job());
  assert.deepEqual(state.transitions, []);
});

test('real mail-domain state transition still advances exactly one revision', async () => {
  const state = registry({ id: 'mail-domain-1', status: 'disabled', revision: 4 });
  await jobReconciliationInternals.reconcileMailDomainJob(state.api, job());
  assert.deepEqual(state.transitions, [[
    'mail-domain-1',
    { expectedRevision: 4, status: 'enabled' },
  ]]);
});

test('managed mail refresh rejects revision drift and accepts completed transition replay', async () => {
  const drifted = registry({ id: 'mail-domain-1', status: 'enabled', revision: 6 });
  await assert.rejects(
    jobReconciliationInternals.reconcileMailDomainJob(drifted.api, job()),
    { code: 'mail_domain_reconciliation_conflict' },
  );

  const replay = registry({ id: 'mail-domain-1', status: 'enabled', revision: 5 });
  await jobReconciliationInternals.reconcileMailDomainJob(replay.api, job());
  assert.deepEqual(replay.transitions, []);
});
