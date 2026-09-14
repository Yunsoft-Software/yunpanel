import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';

const operationId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';

function plan({ operation = operationId, website = websiteId } = {}) {
  return {
    operationId: operation,
    websiteId: website,
    steps: [{
      id: 'unix_identity',
      kind: 'unix_identity',
      state: 'pending',
      intent: {
        unixUser: 'yunapp-0123456789ab',
        homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
      },
      compensation: { state: 'pending' },
    }],
  };
}

function identityManager(overrides = {}) {
  return {
    inspect: async () => ({ satisfied: false, reason: 'unused' }),
    apply: async () => ({ satisfied: false, reason: 'unused' }),
    compensate: async () => ({ satisfied: false, reason: 'unused' }),
    inspectCompensation: async () => ({ satisfied: false, reason: 'unused' }),
    ...overrides,
  };
}

function passengerSiteManager() {
  return {
    inspect: async () => ({ satisfied: false, reason: 'unused' }),
    apply: async () => ({ satisfied: false, reason: 'unused' }),
  };
}

function nginxManager() {
  return {
    stageDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectStagedDomain: async () => ({ satisfied: false, result: null }),
    inspectActiveDomain: async () => ({ satisfied: false, result: null }),
    activateDomain: async () => ({ configName: 'unused', checksum: 'a'.repeat(64), active: true }),
    compensateDomain: async () => ({ satisfied: true, configName: 'unused', checksum: 'a'.repeat(64) }),
    inspectDomainCompensation: async () => ({ satisfied: true, configName: 'unused', checksum: 'a'.repeat(64) }),
  };
}

async function persistedFile(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'operations.json');
}

function runtime({ filePath = null, manager = identityManager() } = {}) {
  return createWebsiteProvisioningRuntime({
    filePath,
    identityManager: manager,
    passengerSiteManager: passengerSiteManager(),
    nginxManager: nginxManager(),
  });
}

test('runtime composes registry, injected managers and orchestrator', async () => {
  const calls = [];
  const provisioning = runtime({
    manager: identityManager({
      inspect: async (intent) => ({ satisfied: true, ...intent, uid: 1201, gid: 1201 }),
      apply: async (intent) => {
        calls.push(intent);
        return { satisfied: true, ...intent, uid: 1201, gid: 1201 };
      },
    }),
  });

  assert.deepEqual(await provisioning.init(), []);
  await provisioning.create(plan());
  const result = await provisioning.runNext(operationId);

  assert.equal(result.outcome, 'ready');
  assert.equal(result.operation.ready, true);
  assert.equal(typeof provisioning.compensateStep, 'function');
  assert.deepEqual(calls, [{
    user: 'yunapp-0123456789ab',
    homeDirectory: '/var/lib/yunpanel/data/6dcb8908-3f3e-43da-9452-15fd6b51ac76',
  }]);
  assert.deepEqual(await provisioning.get(operationId), result.operation);
  assert.deepEqual(await provisioning.listInterrupted(), []);
});

test('runtime startup reconciles an interrupted apply by inspection without applying again', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-restart-');
  const beforeRestart = runtime({ filePath });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'unix_identity' });

  let inspectCalls = 0;
  let applyCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspect: async (intent) => {
        inspectCalls += 1;
        return { satisfied: true, ...intent, uid: 1201, gid: 1201 };
      },
      apply: async () => {
        applyCalls += 1;
        throw new Error('startup reconcile must not reapply');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'ready');
  assert.equal(inspectCalls, 1);
  assert.equal(applyCalls, 0);
  assert.equal(restored.ready, true);
  assert.equal(restored.steps[0].state, 'succeeded');
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});

test('runtime startup leaves uncertain interrupted apply untouched instead of mutating the host', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-uncertain-');
  const beforeRestart = runtime({ filePath });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.registry.beginStep({ operationId, stepId: 'unix_identity' });

  let applyCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspect: async () => ({ satisfied: false, reason: 'website_identity_partial_state' }),
      apply: async () => {
        applyCalls += 1;
        throw new Error('startup reconcile must not apply uncertain state');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'interrupted');
  assert.equal(startup[0].actionRequired, 'inspect_or_remediate');
  assert.equal(applyCalls, 0);
  assert.equal(restored.steps[0].state, 'applying');
  assert.equal((await afterRestart.listInterrupted()).length, 1);
});

test('runtime startup reconciles interrupted compensation by inspection without compensating again', async (t) => {
  const filePath = await persistedFile(t, 'yunpanel-provisioning-compensation-');
  const beforeRestart = runtime({
    filePath,
    manager: identityManager({
      apply: async (intent) => ({ satisfied: true, ...intent, uid: 1201, gid: 1201 }),
    }),
  });
  await beforeRestart.init();
  await beforeRestart.create(plan());
  await beforeRestart.runNext(operationId);
  await beforeRestart.registry.beginCompensation({ operationId, stepId: 'unix_identity' });

  let inspectCalls = 0;
  let compensateCalls = 0;
  const afterRestart = runtime({
    filePath,
    manager: identityManager({
      inspectCompensation: async () => {
        inspectCalls += 1;
        return { satisfied: true, removedUser: true, removedGroup: true, removedHome: true };
      },
      compensate: async () => {
        compensateCalls += 1;
        throw new Error('startup reconcile must not repeat compensation');
      },
    }),
  });

  const startup = await afterRestart.init();
  const restored = await afterRestart.get(operationId);

  assert.equal(startup.length, 1);
  assert.equal(startup[0].outcome, 'compensated');
  assert.equal(inspectCalls, 1);
  assert.equal(compensateCalls, 0);
  assert.equal(restored.steps[0].state, 'compensated');
  assert.equal(restored.steps[0].compensation.state, 'succeeded');
  assert.deepEqual(await afterRestart.listInterrupted(), []);
});
