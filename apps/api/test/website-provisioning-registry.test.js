import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteProvisioningRegistry,
  WebsiteProvisioningRegistryError,
} from '../src/website-provisioning-registry.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const secondOperationId = '4d5a28d3-67b5-4ff4-854d-508d3f720c4d';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function input({ operation = operationId } = {}) {
  return {
    operationId: operation,
    websiteId,
    resources: { website: { id: websiteId } },
    steps: [
      {
        id: 'unix_identity',
        kind: 'unix_identity',
        state: 'pending',
        intent: { user: 'yunapp-example' },
        compensation: { state: 'pending' },
      },
      {
        id: 'runtime',
        kind: 'runtime',
        state: 'pending',
        intent: { adapter: 'passenger' },
        compensation: { state: 'pending' },
      },
    ],
  };
}

test('registry persists applying intent before evidence and recovers interrupted work', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-'));
  const filePath = path.join(directory, 'provisioning.json');
  let clock = Date.parse('2026-09-14T01:00:00.000Z');
  try {
    const registry = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    const created = await registry.create(input());
    assert.equal(created.status, 'pending');

    clock += 1_000;
    const applying = await registry.beginStep({ operationId, stepId: 'unix_identity' });
    assert.equal(applying.steps[0].state, 'applying');
    assert.equal(applying.ready, false);

    const diskState = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(diskState.operations[0].steps[0].state, 'applying');
    assert.deepEqual(diskState.operations[0].steps[0].intent, { user: 'yunapp-example' });
    assert.equal(diskState.operations[0].steps[0].evidence, null);

    const restarted = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    await restarted.init();
    const interrupted = await restarted.listInterrupted();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].operationId, operationId);
    assert.equal(interrupted[0].steps[0].state, 'applying');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('latest Website lookup follows durable updatedAt across registry restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-latest-'));
  const filePath = path.join(directory, 'provisioning.json');
  let clock = Date.parse('2026-09-14T01:00:00.000Z');
  try {
    const registry = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    await registry.create(input({ operation: operationId }));
    clock += 1_000;
    await registry.create(input({ operation: secondOperationId }));

    let latest = await registry.getLatestForWebsite(websiteId);
    assert.equal(latest.operationId, secondOperationId);

    clock += 1_000;
    await registry.beginStep({ operationId, stepId: 'unix_identity' });
    latest = await registry.getLatestForWebsite(websiteId);
    assert.equal(latest.operationId, operationId);

    const restarted = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    await restarted.init();
    latest = await restarted.getLatestForWebsite(websiteId);
    assert.equal(latest.operationId, operationId);
    assert.equal(await restarted.getLatestForWebsite('3854e385-adfc-42bd-bccf-f655f24cd68f'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('successful steps require explicit evidence and readiness waits for every required step', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });

  await assert.rejects(
    registry.completeStep({ operationId, stepId: 'unix_identity', evidence: null }),
    (error) => error instanceof WebsiteProvisioningRegistryError && error.code === 'website_provisioning_evidence_required',
  );

  const identityComplete = await registry.completeStep({
    operationId,
    stepId: 'unix_identity',
    evidence: { uid: 1201, gid: 1201, home: '/var/lib/yunpanel/sites/example' },
  });
  assert.equal(identityComplete.status, 'partial');
  assert.equal(identityComplete.ready, false);

  await registry.beginStep({ operationId, stepId: 'runtime' });
  const ready = await registry.completeStep({
    operationId,
    stepId: 'runtime',
    evidence: { adapter: 'passenger', healthy: true },
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.progress, { required: 2, completed: 2, remaining: 0 });
});

test('blocked step persists bounded evidence and can re-enter applying only explicitly', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  const blocked = await registry.blockStep({
    operationId,
    stepId: 'unix_identity',
    error: 'website_release_missing',
    evidence: { satisfied: false, reason: 'website_release_missing' },
  });

  assert.equal(blocked.steps[0].state, 'blocked');
  assert.equal(blocked.steps[0].error, 'website_release_missing');
  assert.deepEqual(blocked.steps[0].evidence, { satisfied: false, reason: 'website_release_missing' });
  assert.equal(blocked.ready, false);

  const applying = await registry.beginStep({ operationId, stepId: 'unix_identity' });
  assert.equal(applying.steps[0].state, 'applying');
  assert.equal(applying.steps[0].error, null);
});

test('failed step can be explicitly reset for retry while clearing stale failure evidence', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  const failed = await registry.failStep({
    operationId,
    stepId: 'unix_identity',
    error: 'unix_identity_apply_failed',
    evidence: { attempted: true },
  });
  assert.equal(failed.steps[0].state, 'failed');

  const retried = await registry.retryStep({ operationId, stepId: 'unix_identity' });
  assert.equal(retried.steps[0].state, 'pending');
  assert.equal(retried.steps[0].error, null);
  assert.equal(retried.steps[0].evidence, null);
  assert.equal(retried.steps[0].compensation.state, 'pending');
});

test('retry rejects steps that are not failed', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());

  await assert.rejects(
    registry.retryStep({ operationId, stepId: 'unix_identity' }),
    (error) => error instanceof WebsiteProvisioningRegistryError
      && error.code === 'website_provisioning_retry_invalid',
  );
});

test('recreating the same operation preserves progressed mutable state', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({ operationId, stepId: 'unix_identity', evidence: { uid: 1201 } });

  const recreated = await registry.create(input());
  assert.equal(recreated.status, 'partial');
  assert.equal(recreated.steps[0].state, 'succeeded');
  assert.deepEqual(recreated.steps[0].evidence, { uid: 1201 });
  assert.equal(recreated.steps[1].state, 'pending');
});

test('compensation is persisted as an explicit lifecycle', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({ operationId, stepId: 'unix_identity', evidence: { uid: 1201 } });

  const compensating = await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  assert.equal(compensating.steps[0].state, 'compensating');
  assert.equal(compensating.steps[0].compensation.state, 'applying');

  const compensated = await registry.completeCompensation({
    operationId,
    stepId: 'unix_identity',
    evidence: { removedUser: true },
  });
  assert.equal(compensated.steps[0].state, 'compensated');
  assert.equal(compensated.steps[0].compensation.state, 'succeeded');
  assert.equal(compensated.ready, false);
});

test('failed compensation restores the stable source state so compensation can be retried', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({ operationId, stepId: 'unix_identity', evidence: { uid: 1201 } });

  await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  const failedCompensation = await registry.failCompensation({
    operationId,
    stepId: 'unix_identity',
    error: 'unix_identity_compensation_failed',
  });
  assert.equal(failedCompensation.steps[0].state, 'succeeded');
  assert.equal(failedCompensation.steps[0].compensation.state, 'failed');
  assert.equal(failedCompensation.steps[0].compensation.error, 'unix_identity_compensation_failed');

  const retriedCompensation = await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  assert.equal(retriedCompensation.steps[0].state, 'compensating');
  assert.equal(retriedCompensation.steps[0].compensation.state, 'applying');
  assert.equal(retriedCompensation.steps[0].compensation.error, null);
});

test('failed compensation restores a failed provisioning step to failed', async () => {
  const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.failStep({
    operationId,
    stepId: 'unix_identity',
    error: 'unix_identity_apply_failed',
    evidence: { attempted: true },
  });

  await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  const failedCompensation = await registry.failCompensation({
    operationId,
    stepId: 'unix_identity',
    error: 'unix_identity_compensation_failed',
  });
  assert.equal(failedCompensation.steps[0].state, 'failed');
  assert.equal(failedCompensation.steps[0].error, 'unix_identity_apply_failed');
  assert.equal(failedCompensation.steps[0].compensation.state, 'failed');
});
