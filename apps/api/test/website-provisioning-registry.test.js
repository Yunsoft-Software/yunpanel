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

function compensationOrderInput(operation, laterState) {
  const later = {
    id: 'runtime',
    kind: 'runtime',
    state: laterState,
    intent: { adapter: 'passenger' },
    compensation: { state: 'pending' },
  };
  if (laterState === 'succeeded') later.evidence = { adapter: 'passenger', healthy: true };
  if (laterState === 'failed') later.error = 'runtime_apply_failed';
  if (laterState === 'blocked') later.error = 'runtime_blocked';
  if (laterState === 'compensating') later.compensation = { state: 'applying' };
  if (laterState === 'compensated') {
    later.compensation = { state: 'succeeded', evidence: { removed: true } };
  }
  return {
    operationId: operation,
    websiteId,
    resources: { website: { id: websiteId } },
    steps: [
      {
        id: 'unix_identity',
        kind: 'unix_identity',
        state: 'succeeded',
        intent: { user: 'yunapp-example' },
        evidence: { uid: 1201, gid: 1201 },
        compensation: { state: 'pending' },
      },
      later,
    ],
  };
}

test('registry keeps the latest provisioning actor private and durable', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-actor-'));
  const filePath = path.join(directory, 'provisioning.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createWebsiteProvisioningRegistry({ filePath });
  await registry.init();
  const created = await registry.create(input());
  const originalUpdatedAt = created.updatedAt;
  const first = Object.freeze({
    sessionId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'site_manager',
  });
  const second = Object.freeze({
    sessionId: '33333333-3333-4333-8333-333333333333',
    userId: '44444444-4444-4444-8444-444444444444',
    role: 'owner',
  });

  assert.equal(await registry.getActor(operationId), null);
  assert.equal(Object.hasOwn(await registry.get(operationId), 'actor'), false);
  assert.deepEqual(await registry.refreshActor({ operationId, actor: first }), first);
  assert.deepEqual(await registry.getActor(operationId), first);
  assert.equal((await registry.get(operationId)).updatedAt, originalUpdatedAt);
  assert.equal(Object.hasOwn(await registry.get(operationId), 'actor'), false);

  await registry.refreshActor({ operationId, actor: second });
  assert.deepEqual(await registry.getActor(operationId), second);
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(raw.operations[0].actor, second);

  const reopened = createWebsiteProvisioningRegistry({ filePath });
  await reopened.init();
  assert.deepEqual(await reopened.getActor(operationId), second);
  assert.equal(Object.hasOwn(await reopened.get(operationId), 'actor'), false);

  await reopened.abandonUncreated({
    operationId,
    websiteId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  await assert.rejects(
    reopened.refreshActor({ operationId, actor: first }),
    (error) => error instanceof WebsiteProvisioningRegistryError
      && error.code === 'website_provisioning_abandoned',
  );
});

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

test('Website operation history is durable and ordered by current journal revision', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-history-'));
  const filePath = path.join(directory, 'provisioning.json');
  let clock = Date.parse('2026-09-14T01:00:00.000Z');
  try {
    const registry = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    await registry.create(input({ operation: operationId }));
    clock += 1_000;
    await registry.create(input({ operation: secondOperationId }));

    assert.deepEqual(
      (await registry.listForWebsite(websiteId)).map((operation) => operation.operationId),
      [secondOperationId, operationId],
    );

    clock += 1_000;
    await registry.beginStep({ operationId, stepId: 'unix_identity' });
    assert.deepEqual(
      (await registry.listForWebsite(websiteId)).map((operation) => operation.operationId),
      [operationId, secondOperationId],
    );

    const restarted = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
    await restarted.init();
    assert.deepEqual(
      (await restarted.listForWebsite(websiteId)).map((operation) => operation.operationId),
      [operationId, secondOperationId],
    );
    assert.deepEqual(await restarted.listForWebsite('3854e385-adfc-42bd-bccf-f655f24cd68f'), []);
    await assert.rejects(
      restarted.listForWebsite(''),
      (error) => error instanceof WebsiteProvisioningRegistryError
        && error.code === 'website_provisioning_website_id_invalid',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('DNS zone ownership history lookup survives Website unbinding concerns and filters exact zone identity', async () => {
  const registry = createWebsiteProvisioningRegistry({
    now: () => Date.parse('2026-09-14T01:00:00.000Z'),
  });
  const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
  const webDomainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
  const zoneName = 'example.com';
  await registry.create({
    operationId,
    websiteId,
    resources: { website: { id: websiteId } },
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'pending',
      intent: { serverId, webDomainId, zoneName },
      compensation: { state: 'pending' },
    }],
  });
  await registry.create({
    operationId: secondOperationId,
    websiteId,
    resources: { website: { id: websiteId } },
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'pending',
      intent: { serverId, webDomainId: 'other-domain', zoneName },
      compensation: { state: 'pending' },
    }],
  });

  const matching = await registry.listForDnsZone({ serverId, webDomainId, zoneName });
  assert.deepEqual(matching.map((operation) => operation.operationId), [operationId]);

  assert.deepEqual(
    await registry.listForDnsZone({ serverId, webDomainId, zoneName: 'other.example.com' }),
    [],
  );
  await assert.rejects(
    registry.listForDnsZone({ serverId: '', webDomainId, zoneName }),
    (error) => error instanceof WebsiteProvisioningRegistryError
      && error.code === 'website_provisioning_dns_zone_scope_invalid',
  );
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

test('authorization-sensitive inventory retains failed and failed-compensation journals', async () => {
  const registry = createWebsiteProvisioningRegistry({
    now: () => Date.parse('2026-09-14T01:00:00.000Z'),
  });
  await registry.create(input());
  assert.deepEqual(await registry.listAuthorizationSensitive(), []);

  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  assert.equal((await registry.listAuthorizationSensitive()).length, 1);

  await registry.failStep({
    operationId,
    stepId: 'unix_identity',
    error: 'fixture_failed',
  });
  assert.equal((await registry.listAuthorizationSensitive()).length, 1);

  await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  await registry.failCompensation({
    operationId,
    stepId: 'unix_identity',
    error: 'fixture_compensation_failed',
  });
  const sensitive = await registry.listAuthorizationSensitive();
  assert.equal(sensitive.length, 1);
  assert.equal(sensitive[0].operationId, operationId);
  assert.equal(sensitive[0].steps[0].compensation.state, 'failed');
});

test('earlier compensation is blocked while a later step may still own host mutations', async () => {
  for (const laterState of ['applying', 'succeeded', 'failed', 'compensating']) {
    const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
    const currentOperationId = `order-blocked-${laterState}`;
    await registry.create(compensationOrderInput(currentOperationId, laterState));

    await assert.rejects(
      registry.beginCompensation({ operationId: currentOperationId, stepId: 'unix_identity' }),
      (error) => error instanceof WebsiteProvisioningRegistryError
        && error.code === 'website_provisioning_compensation_order_invalid',
      `later ${laterState} step must block earlier compensation`,
    );

    const unchanged = await registry.get(currentOperationId);
    assert.equal(unchanged.steps[0].state, 'succeeded');
    assert.equal(unchanged.steps[0].compensation.state, 'pending');
  }
});

test('earlier compensation can begin after later steps are inactive or already compensated', async () => {
  for (const laterState of ['pending', 'blocked', 'compensated']) {
    const registry = createWebsiteProvisioningRegistry({ now: () => Date.parse('2026-09-14T01:00:00.000Z') });
    const currentOperationId = `order-allowed-${laterState}`;
    await registry.create(compensationOrderInput(currentOperationId, laterState));

    const compensating = await registry.beginCompensation({
      operationId: currentOperationId,
      stepId: 'unix_identity',
    });
    assert.equal(compensating.steps[0].state, 'compensating');
    assert.equal(compensating.steps[0].compensation.state, 'applying');
  }
});


test('independent provisioning registries preserve concurrent journal writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-shared-'));
  const filePath = path.join(directory, 'provisioning.json');
  try {
    const left = createWebsiteProvisioningRegistry({
      filePath,
      now: () => Date.parse('2026-09-14T01:00:00.000Z'),
    });
    const right = createWebsiteProvisioningRegistry({
      filePath,
      now: () => Date.parse('2026-09-14T01:00:01.000Z'),
    });
    await Promise.all([left.init(), right.init()]);
    await Promise.all([
      left.create(input({ operation: operationId })),
      right.create(input({ operation: secondOperationId })),
    ]);
    const expected = [operationId, secondOperationId].sort();
    assert.deepEqual((await left.listForWebsite(websiteId)).map((item) => item.operationId).sort(), expected);
    assert.deepEqual((await right.listForWebsite(websiteId)).map((item) => item.operationId).sort(), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


function abandonmentProof(overrides = {}) {
  return {
    operationId,
    websiteId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
    ...overrides,
  };
}

test('pending provisioning journal can be durably abandoned and never reactivated', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-provisioning-abandon-'));
  const filePath = path.join(directory, 'provisioning.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-14T01:00:00.000Z');
  const registry = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
  await registry.init();
  await registry.create(input());

  clock += 1_000;
  const abandoned = await registry.abandonUncreated(abandonmentProof());
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.ready, false);
  assert.equal(abandoned.terminalState, 'abandoned');
  assert.equal(abandoned.abandonedAt, new Date(clock).toISOString());
  assert.equal(abandoned.steps.every((step) => step.state === 'pending'), true);
  assert.deepEqual(await registry.listInterrupted(), []);

  await assert.rejects(
    registry.beginStep({ operationId, stepId: 'unix_identity' }),
    (error) => error instanceof WebsiteProvisioningRegistryError
      && error.code === 'website_provisioning_abandoned',
  );
  await assert.rejects(
    registry.retryStep({ operationId, stepId: 'unix_identity' }),
    (error) => error instanceof WebsiteProvisioningRegistryError
      && error.code === 'website_provisioning_abandoned',
  );

  const recreated = await registry.create(input());
  assert.equal(recreated.status, 'abandoned');
  assert.equal(recreated.terminalState, 'abandoned');

  const reopened = createWebsiteProvisioningRegistry({ filePath, now: () => clock });
  await reopened.init();
  const restored = await reopened.get(operationId);
  assert.equal(restored.status, 'abandoned');
  assert.equal(restored.terminalState, 'abandoned');
  assert.equal(restored.abandonedAt, abandoned.abandonedAt);

  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  const stored = raw.operations.find((operation) => operation.operationId === operationId);
  assert.equal(stored.terminalState, 'abandoned');
  assert.equal(stored.abandonedAt, abandoned.abandonedAt);
});

test('fully compensated work plus pending steps may be abandoned', async () => {
  const registry = createWebsiteProvisioningRegistry({
    now: () => Date.parse('2026-09-14T01:00:00.000Z'),
  });
  await registry.create(input());
  await registry.beginStep({ operationId, stepId: 'unix_identity' });
  await registry.completeStep({
    operationId,
    stepId: 'unix_identity',
    evidence: { satisfied: true, uid: 1201 },
  });
  await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
  await registry.completeCompensation({
    operationId,
    stepId: 'unix_identity',
    evidence: { satisfied: true, removedUser: true },
  });

  const abandoned = await registry.abandonUncreated(abandonmentProof());
  assert.equal(abandoned.status, 'abandoned');
  assert.equal(abandoned.steps[0].state, 'compensated');
  assert.equal(abandoned.steps[0].compensation.state, 'succeeded');
  assert.equal(abandoned.steps[1].state, 'pending');
});

for (const unsafeState of ['applying', 'succeeded', 'failed', 'blocked', 'compensating']) {
  test(`abandonment rejects ${unsafeState} provisioning work`, async () => {
    const registry = createWebsiteProvisioningRegistry();
    await registry.create(input());
    await registry.beginStep({ operationId, stepId: 'unix_identity' });

    if (unsafeState === 'succeeded' || unsafeState === 'compensating') {
      await registry.completeStep({
        operationId,
        stepId: 'unix_identity',
        evidence: { satisfied: true, uid: 1201 },
      });
      if (unsafeState === 'compensating') {
        await registry.beginCompensation({ operationId, stepId: 'unix_identity' });
      }
    } else if (unsafeState === 'failed') {
      await registry.failStep({
        operationId,
        stepId: 'unix_identity',
        error: 'fixture_failed',
      });
    } else if (unsafeState === 'blocked') {
      await registry.blockStep({
        operationId,
        stepId: 'unix_identity',
        error: 'fixture_blocked',
      });
    }

    await assert.rejects(
      registry.abandonUncreated(abandonmentProof()),
      (error) => error instanceof WebsiteProvisioningRegistryError
        && error.code === 'website_provisioning_abandon_requires_compensation',
    );
    assert.notEqual((await registry.get(operationId)).status, 'abandoned');
  });
}

test('abandonment evidence is identity-bound and idempotent only for the same operation', async () => {
  const registry = createWebsiteProvisioningRegistry();
  await registry.create(input());

  for (const patch of [
    { websiteId: secondOperationId },
    { websiteAbsent: false },
    { applicationId: secondOperationId, applicationAbsent: true },
    { operationId: secondOperationId },
  ]) {
    await assert.rejects(
      registry.abandonUncreated(abandonmentProof(patch)),
      (error) => error instanceof WebsiteProvisioningRegistryError
        && ['website_provisioning_abandon_evidence_invalid',
          'website_provisioning_abandon_identity_conflict',
          'website_provisioning_not_found'].includes(error.code),
    );
  }

  const first = await registry.abandonUncreated(abandonmentProof());
  const retry = await registry.abandonUncreated(abandonmentProof());
  assert.deepEqual(retry, first);
});
