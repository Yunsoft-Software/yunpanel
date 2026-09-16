import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteProvisioningPlan } from '../src/website-provisioning-plan.js';
import { withWebsiteIsolationSteps } from '../src/site-create-provisioning-isolation.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';

function plan(runtimeType = 'php') {
  return createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    resources: {
      website: {
        id: websiteId,
        applicationId,
        runtimeType,
        unixUser,
      },
    },
    steps: [
      { id: 'website_metadata', kind: 'website_metadata', state: 'succeeded', intent: { websiteId }, compensation: { state: 'not_required' } },
      { id: 'unix_identity', kind: 'unix_identity', state: 'pending', intent: { websiteId, applicationId, unixUser }, compensation: { state: 'pending' } },
      { id: runtimeType === 'php' ? 'php_runtime' : 'runtime', kind: runtimeType === 'php' ? 'php_runtime' : 'runtime', state: 'pending', intent: { applicationId }, compensation: { state: 'pending' } },
      { id: 'nginx', kind: 'nginx', state: 'pending', intent: { websiteId }, compensation: { state: 'pending' } },
    ],
  });
}

function rebuild(current, steps) {
  return createWebsiteProvisioningPlan({
    operationId: current.operationId,
    websiteId: current.websiteId,
    resources: current.resources,
    steps,
  });
}

test('hosted Website plan inserts isolated SFTP before Nginx activation', () => {
  for (const runtimeType of ['static', 'node', 'php']) {
    const isolated = withWebsiteIsolationSteps(plan(runtimeType));
    const ids = isolated.steps.map((step) => step.id);
    const sftp = isolated.steps.find((step) => step.id === 'sftp');
    assert.ok(ids.indexOf('sftp') > ids.indexOf(runtimeType === 'php' ? 'php_runtime' : 'runtime'));
    assert.ok(ids.indexOf('sftp') < ids.indexOf('nginx'));
    assert.equal(sftp.required, true);
    assert.equal(sftp.intent.adapter, 'openssh-internal-sftp');
    assert.equal(sftp.intent.websiteId, websiteId);
    assert.equal(sftp.intent.applicationId, applicationId);
    assert.equal(sftp.intent.unixUser, unixUser);
    assert.equal(sftp.compensation.state, 'pending');
  }
});

test('proxy Website plan does not invent a Unix identity or SFTP jail', () => {
  const proxy = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    resources: { website: { id: websiteId, applicationId: null, runtimeType: 'proxy', unixUser: null } },
    steps: [
      { id: 'website_metadata', kind: 'website_metadata', state: 'succeeded', intent: { websiteId }, compensation: { state: 'not_required' } },
      { id: 'nginx', kind: 'nginx', state: 'pending', intent: { websiteId }, compensation: { state: 'pending' } },
    ],
  });
  assert.equal(withWebsiteIsolationSteps(proxy), proxy);
});

test('isolation plan decoration is idempotent only for the canonical SFTP intent', () => {
  const first = withWebsiteIsolationSteps(plan('php'));
  const second = withWebsiteIsolationSteps(first);
  assert.equal(second, first);
  assert.equal(first.steps.filter((step) => step.id === 'sftp').length, 1);
});

test('stale SFTP Website or Unix identity fails closed instead of being treated as idempotent', () => {
  const isolated = withWebsiteIsolationSteps(plan('php'));
  const stale = rebuild(isolated, isolated.steps.map((step) => step.id === 'sftp'
    ? { ...step, intent: { ...step.intent, unixUser: 'yunapp-stale000000' } }
    : step));

  assert.throws(
    () => withWebsiteIsolationSteps(stale),
    /SFTP step does not match canonical Website isolation intent/,
  );
});

test('duplicate SFTP kinds fail closed even when step ids are unique', () => {
  const isolated = withWebsiteIsolationSteps(plan('static'));
  const duplicate = rebuild(isolated, [
    ...isolated.steps,
    {
      id: 'legacy_sftp',
      kind: 'sftp',
      state: 'pending',
      intent: {
        adapter: 'openssh-internal-sftp',
        websiteId,
        applicationId,
        unixUser,
      },
      compensation: { state: 'pending' },
    },
  ]);

  assert.throws(
    () => withWebsiteIsolationSteps(duplicate),
    /duplicate SFTP isolation steps/,
  );
});

test('stale Unix identity ownership blocks SFTP isolation decoration', () => {
  const staleIdentity = rebuild(plan('node'), plan('node').steps.map((step) => step.id === 'unix_identity'
    ? { ...step, intent: { ...step.intent, applicationId: '41318df2-d6c5-44ea-ae80-22612eb95433' } }
    : step));

  assert.throws(
    () => withWebsiteIsolationSteps(staleIdentity),
    /Unix identity step does not match canonical Website ownership/,
  );
});

test('non-hosted Website with a stray SFTP step fails closed', () => {
  const proxy = createWebsiteProvisioningPlan({
    operationId,
    websiteId,
    resources: { website: { id: websiteId, applicationId: null, runtimeType: 'proxy', unixUser: null } },
    steps: [
      { id: 'website_metadata', kind: 'website_metadata', state: 'succeeded', intent: { websiteId }, compensation: { state: 'not_required' } },
      {
        id: 'sftp',
        kind: 'sftp',
        state: 'pending',
        intent: { adapter: 'openssh-internal-sftp', websiteId, applicationId, unixUser },
        compensation: { state: 'pending' },
      },
      { id: 'nginx', kind: 'nginx', state: 'pending', intent: { websiteId }, compensation: { state: 'pending' } },
    ],
  });

  assert.throws(
    () => withWebsiteIsolationSteps(proxy),
    /Non-hosted Website provisioning must not contain an SFTP isolation step/,
  );
});
