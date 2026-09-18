import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainSuspensionOperationRegistry } from '../src/domain-suspension-operation-registry.js';
import {
  createDomainSuspensionRuntime,
  domainSuspensionRuntimeInternals,
} from '../src/domain-suspension-runtime.js';

const operationId = '12345678-1234-4234-8234-123456789012';
const domainId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);
const previewDigest = 'b'.repeat(64);
const suspendConfirmation = 'suspend-domain:' + domainId + ':4:' + checksum + ':' + previewDigest;

function suspensionPreview(overrides = {}) {
  return Object.freeze({
    version: 1,
    operation: 'domain_suspend',
    domain: Object.freeze({
      id: domainId,
      serverId,
      primaryDomain: 'example.com',
      desiredRevision: 4,
      stagedRevision: 4,
      appliedRevision: 4,
      stagedChecksum: checksum,
      state: 'active',
    }),
    nginx: Object.freeze({
      satisfied: false,
      deactivationCandidate: true,
      restorable: false,
      reason: null,
      configName: 'yunpanel-example.com.conf',
      checksum,
      receiptVersion: null,
    }),
    activeJobs: Object.freeze([]),
    blockers: Object.freeze([]),
    readyToSuspend: true,
    previewDigest,
    confirmation: suspendConfirmation,
    sideEffects: false,
    ...overrides,
  });
}

function registry() {
  return createDomainSuspensionOperationRegistry({
    now: () => Date.parse('2026-09-18T16:00:00.000Z'),
    idFactory: () => operationId,
  });
}

function fixture({
  initialDomain = 'active',
  initialHost = 'active',
  deactivateMode = 'success',
  restoreMode = 'success',
  commitSuspendMode = 'success',
  commitResumeMode = 'success',
  preview = suspensionPreview(),
} = {}) {
  let domainState = initialDomain;
  let hostState = initialHost;
  let deactivateCalls = 0;
  let restoreCalls = 0;
  let commitSuspendCalls = 0;
  let commitResumeCalls = 0;

  const controlPlane = () => {
    if (domainState === 'active') return 'active';
    if (domainState === 'suspended') return 'suspended';
    if (domainState === 'resumed') return 'resumed';
    return 'drift';
  };

  const service = {
    async preview() {
      return preview;
    },
    async inspectSuspend(input) {
      assert.equal(input.domainId, domainId);
      assert.equal(input.operationId, operationId);
      assert.equal(input.expectedRevision, 4);
      assert.equal(input.checksum, checksum);
      return {
        domainId,
        primaryDomain: 'example.com',
        expectedRevision: 4,
        checksum,
        controlPlane: controlPlane(),
        host: hostState === 'deactivated'
          ? {
            satisfied: true,
            deactivationCandidate: false,
            restorable: true,
            reason: null,
            configName: 'yunpanel-example.com.conf',
            checksum,
            receiptVersion: 1,
          }
          : {
            satisfied: false,
            deactivationCandidate: true,
            restorable: hostState === 'active_with_receipt',
            reason: null,
            configName: 'yunpanel-example.com.conf',
            checksum,
            receiptVersion: hostState === 'active_with_receipt' ? 1 : null,
          },
      };
    },
    async deactivateHost() {
      deactivateCalls += 1;
      if (deactivateMode === 'failed') {
        const error = new Error('deactivation failed');
        error.code = 'nginx_deactivation_failed';
        error.status = 409;
        throw error;
      }
      hostState = 'deactivated';
      if (deactivateMode === 'lost_ack') {
        const error = new Error('connection closed after Nginx reload');
        error.code = 'nginx_deactivation_result_uncertain';
        error.status = 503;
        throw error;
      }
      return { satisfied: true, changed: true };
    },
    async commitSuspended() {
      commitSuspendCalls += 1;
      if (commitSuspendMode === 'failed') {
        const error = new Error('Domain registry write failed');
        error.code = 'domain_suspension_state_drift';
        error.status = 409;
        throw error;
      }
      domainState = 'suspended';
      return {
        id: domainId,
        state: 'suspended',
        suspensionOperationId: operationId,
        suspendedChecksum: checksum,
        suspendedAt: '2026-09-18T16:00:01.000Z',
      };
    },
    async inspectResume(input) {
      assert.equal(input.domainId, domainId);
      assert.equal(input.operationId, operationId);
      assert.equal(input.expectedRevision, 4);
      assert.equal(input.checksum, checksum);
      return {
        domainId,
        primaryDomain: 'example.com',
        expectedRevision: 4,
        checksum,
        controlPlane: controlPlane(),
        host: hostState === 'deactivated'
          ? {
            satisfied: false,
            restored: false,
            reason: 'nginx_deactivation_rollback_pending',
            configName: 'yunpanel-example.com.conf',
            checksum,
            receiptVersion: 1,
          }
          : {
            satisfied: true,
            restored: true,
            reason: null,
            configName: 'yunpanel-example.com.conf',
            checksum,
            receiptVersion: 1,
          },
      };
    },
    async restoreHost() {
      restoreCalls += 1;
      if (restoreMode === 'failed') {
        const error = new Error('restore failed');
        error.code = 'nginx_deactivation_restore_failed';
        error.status = 409;
        throw error;
      }
      hostState = 'active_with_receipt';
      if (restoreMode === 'lost_ack') {
        const error = new Error('connection closed after restore');
        error.code = 'nginx_deactivation_restore_result_uncertain';
        error.status = 503;
        throw error;
      }
      return { satisfied: true, changed: true };
    },
    async commitResumed() {
      commitResumeCalls += 1;
      if (commitResumeMode === 'failed') {
        const error = new Error('Domain resume registry write failed');
        error.code = 'domain_resume_state_drift';
        error.status = 409;
        throw error;
      }
      domainState = 'resumed';
      return {
        id: domainId,
        state: 'active',
        lastSuspensionOperationId: operationId,
        lastResumedAt: '2026-09-18T16:02:00.000Z',
      };
    },
  };

  return {
    service,
    counts: () => ({ deactivateCalls, restoreCalls, commitSuspendCalls, commitResumeCalls }),
    state: () => ({ domainState, hostState }),
  };
}

async function suspend(store, fx) {
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });
  await runtime.init();
  return runtime.start({ domainId, previewDigest, confirmation: suspendConfirmation });
}

test('explicit suspend deactivates Nginx then commits Domain suspended state', async () => {
  const store = registry();
  const fx = fixture();
  const completed = await suspend(store, fx);

  assert.equal(completed.status, 'suspended');
  assert.equal(completed.suspendResult.hostChanged, true);
  assert.match(completed.actions.resumeConfirmation, /^resume-domain:/);
  assert.deepEqual(fx.state(), { domainState: 'suspended', hostState: 'deactivated' });
  assert.equal(fx.counts().deactivateCalls, 1);
  assert.equal(fx.counts().commitSuspendCalls, 1);
});

test('Nginx deactivation lost acknowledgement reconciles without second host mutation', async () => {
  const store = registry();
  const fx = fixture({ deactivateMode: 'lost_ack' });
  const completed = await suspend(store, fx);

  assert.equal(completed.status, 'suspended');
  assert.equal(completed.suspendResult.hostChanged, false);
  assert.equal(fx.counts().deactivateCalls, 1);
  assert.equal(fx.counts().commitSuspendCalls, 1);
});

test('startup interrupted suspension never replays host mutation while vhost remains active', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(suspensionPreview());
  await store.markSuspending(created.id);
  const fx = fixture({ initialDomain: 'active', initialHost: 'active' });
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery[0].operationId, operationId);
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].error.code, 'domain_suspension_retry_required');
  assert.equal((await store.get(operationId)).status, 'suspending');
  assert.equal(fx.counts().deactivateCalls, 0);
  assert.match((await runtime.get(operationId)).actions.suspendRetryConfirmation, /^retry-domain-suspend:/);
});

test('startup reconciles deactivated host by committing only Domain suspended state', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(suspensionPreview());
  await store.markSuspending(created.id);
  const fx = fixture({ initialDomain: 'active', initialHost: 'deactivated' });
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'suspended');
  assert.equal(fx.counts().deactivateCalls, 0);
  assert.equal(fx.counts().commitSuspendCalls, 1);
});

test('suspension commit failure restores exact active Nginx state before failing operation', async () => {
  const store = registry();
  const fx = fixture({ commitSuspendMode: 'failed' });
  const failed = await suspend(store, fx);

  assert.equal(failed.status, 'failed');
  assert.equal(failed.suspendError.code, 'domain_suspension_state_drift');
  assert.deepEqual(fx.state(), { domainState: 'active', hostState: 'active_with_receipt' });
  assert.equal(fx.counts().deactivateCalls, 1);
  assert.equal(fx.counts().restoreCalls, 1);
});

test('explicit resume restores retained vhost then commits Domain active state', async () => {
  const store = registry();
  const fx = fixture();
  const suspended = await suspend(store, fx);
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const resumed = await runtime.resume({
    domainId,
    operationId,
    expectedUpdatedAt: suspended.updatedAt,
    checksum,
    confirmation: suspended.actions.resumeConfirmation,
  });

  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.resumeResult.hostChanged, true);
  assert.deepEqual(fx.state(), { domainState: 'resumed', hostState: 'active_with_receipt' });
  assert.equal(fx.counts().restoreCalls, 1);
  assert.equal(fx.counts().commitResumeCalls, 1);
});

test('Nginx resume lost acknowledgement reconciles without second restore', async () => {
  const store = registry();
  const fx = fixture({ restoreMode: 'lost_ack' });
  const suspended = await suspend(store, fx);
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const resumed = await runtime.resume({
    domainId,
    operationId,
    expectedUpdatedAt: suspended.updatedAt,
    checksum,
    confirmation: suspended.actions.resumeConfirmation,
  });

  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.resumeResult.hostChanged, false);
  assert.equal(fx.counts().restoreCalls, 1);
});

test('startup interrupted resume never automatically restores vhost', async () => {
  const store = registry();
  const fx = fixture();
  await suspend(store, fx);
  await store.markResuming(operationId);
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].error.code, 'domain_resume_retry_required');
  assert.equal((await store.get(operationId)).status, 'resuming');
  assert.equal(fx.counts().restoreCalls, 0);
  assert.match((await runtime.get(operationId)).actions.resumeRetryConfirmation, /^retry-domain-resume:/);
});

test('resume commit failure re-deactivates Nginx and preserves suspended Domain state', async () => {
  const store = registry();
  const fx = fixture({ commitResumeMode: 'failed' });
  const suspended = await suspend(store, fx);
  const runtime = createDomainSuspensionRuntime({ registry: store, service: fx.service });

  const failed = await runtime.resume({
    domainId,
    operationId,
    expectedUpdatedAt: suspended.updatedAt,
    checksum,
    confirmation: suspended.actions.resumeConfirmation,
  });

  assert.equal(failed.status, 'resume_failed');
  assert.equal(failed.resumeError.code, 'domain_resume_state_drift');
  assert.deepEqual(fx.state(), { domainState: 'suspended', hostState: 'deactivated' });
  assert.equal(fx.counts().restoreCalls, 1);
  assert.equal(fx.counts().deactivateCalls, 2);
});

test('stale preview and stale retry confirmation cannot mutate host', async () => {
  const staleFx = fixture({
    preview: suspensionPreview({
      previewDigest: 'c'.repeat(64),
      confirmation: 'stale',
    }),
  });
  const runtime = createDomainSuspensionRuntime({
    registry: registry(),
    service: staleFx.service,
  });
  await assert.rejects(
    runtime.start({ domainId, previewDigest, confirmation: suspendConfirmation }),
    (error) => error.code === 'domain_suspension_preview_stale',
  );
  assert.equal(staleFx.counts().deactivateCalls, 0);

  const store = registry();
  const fx = fixture();
  await store.init();
  const created = await store.create(suspensionPreview());
  await store.markSuspending(created.id);
  const retryRuntime = createDomainSuspensionRuntime({ registry: store, service: fx.service });
  const current = await retryRuntime.get(operationId);
  await assert.rejects(
    retryRuntime.retrySuspend({
      domainId,
      operationId,
      expectedUpdatedAt: current.updatedAt,
      checksum,
      confirmation: 'wrong',
    }),
    (error) => error.code === 'domain_suspension_retry_stale',
  );
  assert.equal(fx.counts().deactivateCalls, 0);
});

test('retry confirmation helper binds operation revision and checksum', async () => {
  const store = registry();
  await store.init();
  const created = await store.create(suspensionPreview());
  const suspending = await store.markSuspending(created.id);
  assert.equal(
    domainSuspensionRuntimeInternals.suspendRetryConfirmation(suspending),
    'retry-domain-suspend:' + domainId + ':' + operationId + ':' + suspending.updatedAt + ':' + checksum,
  );
});
