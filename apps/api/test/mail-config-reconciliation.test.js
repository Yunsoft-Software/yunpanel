import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { jobReconciliationInternals } from '../src/job-reconciliation.js';

const MAIL_DOMAIN_ID = '11111111-1111-4111-8111-111111111111';

function succeededJob() {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    operation: OPERATIONS.MAIL_CONFIG_APPLY,
    resourceType: 'mail_domain',
    resourceId: MAIL_DOMAIN_ID,
    status: 'succeeded',
    payload: {
      mailDomainId: MAIL_DOMAIN_ID,
      expectedRevision: 4,
      desiredStatus: 'enabled',
    },
    result: {
      mailDomainId: MAIL_DOMAIN_ID,
      desiredStatus: 'enabled',
    },
  };
}

function registry(initial = { status: 'disabled', revision: 4 }) {
  let current = {
    id: MAIL_DOMAIN_ID,
    managementMode: 'local',
    ...initial,
  };
  let transitions = 0;
  return {
    async getMailDomain() { return { ...current }; },
    async transitionLocalStatus(id, { expectedRevision, status }) {
      assert.equal(id, MAIL_DOMAIN_ID);
      assert.equal(current.revision, expectedRevision);
      current = { ...current, status, revision: current.revision + 1 };
      transitions += 1;
      return { ...current };
    },
    state() { return { ...current }; },
    transitions() { return transitions; },
  };
}

test('successful managed mail reconciliation advances local lifecycle exactly once', async () => {
  const state = registry();
  const job = succeededJob();
  await jobReconciliationInternals.reconcileMailDomainJob(state, job);
  assert.deepEqual(state.state(), {
    id: MAIL_DOMAIN_ID,
    managementMode: 'local',
    status: 'enabled',
    revision: 5,
  });
  assert.equal(state.transitions(), 1);

  await jobReconciliationInternals.reconcileMailDomainJob(state, job);
  assert.equal(state.transitions(), 1);
  assert.equal(state.state().revision, 5);
});

test('failed managed mail jobs never change desired-state registry status', async () => {
  const state = registry();
  const job = { ...succeededJob(), status: 'failed', result: null };
  await jobReconciliationInternals.reconcileMailDomainJob(state, job);
  assert.equal(state.transitions(), 0);
  assert.equal(state.state().status, 'disabled');
  assert.equal(state.state().revision, 4);
});

test('managed mail reconciliation fails closed when desired-state revision drifted', async () => {
  const state = registry({ status: 'disabled', revision: 6 });
  await assert.rejects(
    jobReconciliationInternals.reconcileMailDomainJob(state, succeededJob()),
    (error) => error.code === 'mail_domain_reconciliation_conflict',
  );
  assert.equal(state.transitions(), 0);
});
