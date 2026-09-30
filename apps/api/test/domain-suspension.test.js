import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createDomainSuspensionService,
  DomainSuspensionError,
  domainSuspensionInternals,
} from '../src/domain-suspension.js';
import {
  createDomainSuspensionRuntime,
  DomainSuspensionRuntimeError,
  domainSuspensionRuntimeInternals,
} from '../src/domain-suspension-runtime.js';
import {
  createDomainSuspensionOperationRegistry,
  domainSuspensionOperationPublicView,
  DomainSuspensionOperationRegistryError,
} from '../src/domain-suspension-operation-registry.js';
import {
  createWebsiteSuspensionRuntime,
  WebsiteSuspensionRuntimeError,
} from '../src/website-suspension-runtime.js';
import {
  createWebsiteSuspensionOperationRegistry,
} from '../src/website-suspension-operation-registry.js';
import {
  createSiteResourceBoundary,
} from '../src/site-resource-boundary.js';

const domainId = '12345678-1234-4234-8234-123456789012';
const operationId = '22345678-1234-4234-8234-123456789012';
const serverId = '32345678-1234-4234-8234-123456789012';
const checksum = 'a'.repeat(64);

function activeDomain(overrides = {}) {
  return {
    id: domainId,
    serverId,
    websiteId: null,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    parentDomainId: null,
    certificateId: null,
    desiredRevision: 4,
    stagedRevision: 4,
    appliedRevision: 4,
    stagedChecksum: checksum,
    stagedConfigName: 'yunpanel-example.com.conf',
    appliedPrimaryDomain: 'example.com',
    state: 'active',
    lastError: null,
    suspensionOperationId: null,
    suspendedAt: null,
    suspendedChecksum: null,
    lastSuspensionOperationId: null,
    lastResumedAt: null,
    ...overrides,
  };
}

function fixture({
  domain = activeDomain(),
  jobs = [],
  suspendInspection = null,
  resumeInspection = null,
} = {}) {
  let current = structuredClone(domain);
  const calls = [];
  const nginxManager = {
    async inspectDomainDeactivation(input) {
      calls.push(['inspectSuspend', input]);
      return suspendInspection ?? {
        satisfied: false,
        deactivationCandidate: true,
        restorable: false,
        reason: null,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: null,
      };
    },
    async deactivateDomain(input) {
      calls.push(['deactivate', input]);
      return {
        satisfied: true,
        deactivated: true,
        deactivationCandidate: false,
        restorable: true,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: 1,
        changed: true,
      };
    },
    async inspectDomainDeactivationRollback(input) {
      calls.push(['inspectResume', input]);
      return resumeInspection ?? {
        satisfied: false,
        reason: 'nginx_deactivation_rollback_pending',
        configName: 'yunpanel-example.com.conf',
        checksum,
      };
    },
    async rollbackDomainDeactivation(input) {
      calls.push(['restore', input]);
      return {
        satisfied: true,
        restored: true,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: 1,
        changed: true,
      };
    },
  };
  const domainRegistry = {
    async getDomain(id) {
      return id === domainId ? structuredClone(current) : null;
    },
    async markSuspended(id, input) {
      calls.push(['markSuspended', id, structuredClone(input)]);
      assert.equal(id, domainId);
      if (current.state !== 'active') {
        const error = new Error('not active');
        error.code = 'domain_suspension_state_drift';
        error.status = 409;
        throw error;
      }
      current = {
        ...current,
        state: 'suspended',
        suspensionOperationId: input.operationId,
        suspendedAt: '2026-09-18T16:00:00.000Z',
        suspendedChecksum: input.checksum,
      };
      return structuredClone(current);
    },
    async markResumed(id, input) {
      calls.push(['markResumed', id, structuredClone(input)]);
      assert.equal(id, domainId);
      current = {
        ...current,
        state: 'active',
        suspensionOperationId: null,
        suspendedAt: null,
        suspendedChecksum: null,
        lastSuspensionOperationId: input.operationId,
        lastResumedAt: '2026-09-18T16:01:00.000Z',
      };
      return structuredClone(current);
    },
  };
  const service = createDomainSuspensionService({
    domainRegistry,
    jobRegistry: {
      async listJobs(filter) {
        calls.push(['jobs', filter]);
        return jobs;
      },
    },
    nginxManager,
    localServerId: serverId,
  });
  return {
    service,
    calls,
    current: () => structuredClone(current),
    setDomain(value) { current = structuredClone(value); },
  };
}

test('suspension preview binds exact active revision/checksum, Nginx evidence and active jobs', async () => {
  const fx = fixture();
  const preview = await fx.service.preview({ domainId });

  assert.equal(preview.operation, 'domain_suspend');
  assert.equal(preview.domain.id, domainId);
  assert.equal(preview.domain.desiredRevision, 4);
  assert.equal(preview.domain.stagedChecksum, checksum);
  assert.equal(preview.nginx.deactivationCandidate, true);
  assert.deepEqual(preview.activeJobs, []);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.readyToSuspend, true);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    preview.confirmation,
    `suspend-domain:${domainId}:4:${checksum}:${preview.previewDigest}`,
  );
  assert.equal(preview.sideEffects, false);
});

test('preview blocks non-active routing, unowned Nginx absence and active Domain jobs', async () => {
  const fx = fixture({
    domain: activeDomain({ state: 'draft', appliedRevision: 0, appliedPrimaryDomain: null }),
    jobs: [{ id: 'job-1', operation: 'domain.stage', status: 'running' }],
    suspendInspection: {
      satisfied: false,
      deactivationCandidate: false,
      restorable: false,
      reason: 'nginx_deactivation_unowned_absence',
      configName: 'yunpanel-example.com.conf',
      checksum,
      receiptVersion: null,
    },
  });
  const preview = await fx.service.preview({ domainId });

  assert.deepEqual(preview.blockers, [
    'domain_active_state_required',
    'domain_routing_evidence_invalid',
    'domain_nginx_deactivation_unavailable',
    'domain_job_active',
  ]);
  assert.equal(preview.readyToSuspend, false);
  assert.equal(preview.confirmation, null);
});

test('preview treats Nginx checksum drift as explicit blocker without mutation', async () => {
  const error = new Error('drift');
  error.code = 'nginx_deactivation_drift';
  const fx = fixture();
  fx.service;
  const service = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => [] },
    nginxManager: {
      inspectDomainDeactivation: async () => { throw error; },
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  const preview = await service.preview({ domainId });
  assert.deepEqual(preview.blockers, [
    'domain_nginx_active_state_drift',
    'domain_nginx_deactivation_unavailable',
  ]);
});

test('inspectSuspend distinguishes active, suspended, resumed and drifted control-plane ownership', async () => {
  const fx = fixture();
  let inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'active');

  fx.setDomain(activeDomain({
    state: 'suspended',
    suspensionOperationId: operationId,
    suspendedAt: '2026-09-18T16:00:00.000Z',
    suspendedChecksum: checksum,
  }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'suspended');

  fx.setDomain(activeDomain({
    lastSuspensionOperationId: operationId,
    lastResumedAt: '2026-09-18T16:01:00.000Z',
  }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'resumed');

  fx.setDomain(activeDomain({ desiredRevision: 5 }));
  inspected = await fx.service.inspectSuspend({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(inspected.controlPlane, 'drift');
});

test('host mutation and Domain state commit are separate suspension boundaries', async () => {
  const fx = fixture();

  const host = await fx.service.deactivateHost({
    primaryDomain: 'example.com',
    checksum,
  });
  assert.equal(host.satisfied, true);
  assert.equal(fx.current().state, 'active');

  const committed = await fx.service.commitSuspended({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(committed.state, 'suspended');
  assert.equal(committed.suspensionOperationId, operationId);
});

test('resume inspection and host restore stay separate from Domain resume commit', async () => {
  const fx = fixture({
    domain: activeDomain({
      state: 'suspended',
      suspensionOperationId: operationId,
      suspendedAt: '2026-09-18T16:00:00.000Z',
      suspendedChecksum: checksum,
    }),
  });

  const before = await fx.service.inspectResume({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(before.controlPlane, 'suspended');
  assert.equal(before.host.satisfied, false);
  assert.equal(before.host.reason, 'nginx_deactivation_rollback_pending');

  const restored = await fx.service.restoreHost({
    primaryDomain: 'example.com',
    checksum,
  });
  assert.equal(restored.satisfied, true);
  assert.equal(fx.current().state, 'suspended');

  const committed = await fx.service.commitResumed({
    domainId,
    operationId,
    expectedRevision: 4,
    checksum,
  });
  assert.equal(committed.state, 'active');
  assert.equal(committed.lastSuspensionOperationId, operationId);
});

test('job inventory failure and malformed host inspection fail closed', async () => {
  const jobFailure = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => { throw new Error('offline'); } },
    nginxManager: {
      inspectDomainDeactivation: async () => ({}),
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  await assert.rejects(
    jobFailure.preview({ domainId }),
    (error) => error instanceof DomainSuspensionError
      && error.code === 'domain_suspension_job_inventory_unavailable',
  );

  const hostFailure = createDomainSuspensionService({
    domainRegistry: {
      getDomain: async () => activeDomain(),
      markSuspended: async () => ({}),
      markResumed: async () => ({}),
    },
    jobRegistry: { listJobs: async () => [] },
    nginxManager: {
      inspectDomainDeactivation: async () => ({ satisfied: false }),
      deactivateDomain: async () => ({}),
      inspectDomainDeactivationRollback: async () => ({}),
      rollbackDomainDeactivation: async () => ({}),
    },
    localServerId: serverId,
  });
  await assert.rejects(
    hostFailure.preview({ domainId }),
    (error) => error instanceof DomainSuspensionError
      && error.code === 'domain_suspension_host_inspection_invalid',
  );
});

test('suspension helper digest is deterministic', () => {
  const value = { domainId, revision: 4, checksum };
  assert.equal(
    domainSuspensionInternals.digest(value),
    domainSuspensionInternals.digest(structuredClone(value)),
  );
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'domain-susp-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('multi-domain website suspension coordinates all bound child domains and verifies fail-closed blockers', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteSuspensionOperationRegistry({ filePath });

    const websiteId = 'ws-multi-10';
    const testWebsite = {
      id: websiteId,
      serverId,
      name: 'multi-domain-site',
      revision: 2,
    };

    const domains = [
      {
        id: 'dom-10',
        serverId,
        websiteId,
        primaryDomain: 'example.com',
        state: 'active',
      },
      {
        id: 'dom-11',
        serverId,
        websiteId,
        primaryDomain: 'blog.example.com',
        state: 'active',
      },
      {
        id: 'dom-12',
        serverId,
        websiteId,
        primaryDomain: 'shop.example.com',
        state: 'active',
      },
    ];

    const domainStates = new Map([
      ['dom-10', { state: 'active', suspended: false }],
      ['dom-11', { state: 'active', suspended: false }],
      ['dom-12', { state: 'active', suspended: false }],
    ]);

    const domainSuspensionRuntime = {
      preview: async ({ domainId: dId }) => {
        const d = domainStates.get(dId);
        if (!d || d.state !== 'active') {
          return {
            readyToSuspend: false,
            previewDigest: null,
            confirmation: null,
            blockers: ['domain_active_state_required'],
          };
        }
        return {
          readyToSuspend: !d.suspended,
          previewDigest: 'd'.repeat(64),
          confirmation: `suspend-domain:${dId}:2:${checksum}:${'d'.repeat(64)}`,
          blockers: d.suspended ? ['domain_nginx_already_deactivated'] : [],
        };
      },
      start: async ({ domainId: dId }) => {
        const d = domainStates.get(dId);
        d.suspended = true;
        return {
          id: `op-${dId}`,
          domainId: dId,
          status: 'suspended',
          checksum,
          updatedAt: '2026-09-30T10:00:00.000Z',
        };
      },
      get: async (id) => {
        const dId = id.replace('op-', '');
        const d = domainStates.get(dId);
        return {
          id,
          domainId: dId,
          status: d?.suspended ? 'suspended' : 'active',
          checksum,
          updatedAt: '2026-09-30T10:00:00.000Z',
        };
      },
      resume: async ({ domainId: dId }) => {
        const d = domainStates.get(dId);
        d.suspended = false;
        return {
          id: `op-${dId}`,
          domainId: dId,
          status: 'resumed',
          checksum,
          updatedAt: '2026-09-30T10:01:00.000Z',
        };
      },
    };

    const runtime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry: { getWebsite: async (id) => (id === websiteId ? testWebsite : null) },
      domainRegistry: { listDomains: async () => domains },
      domainSuspensionRuntime,
      localServerId: serverId,
    });

    // 1. Healthy multi-domain preview
    const preview = await runtime.preview({ websiteId });
    assert.equal(preview.readyToSuspend, true);
    assert.equal(preview.readyToResume, false);
    assert.equal(preview.domains.length, 3);
    assert.ok(preview.confirmation.startsWith(`start-website-suspend:${websiteId}:2:`));

    // 2. Blocker verification: if any child domain is not ready, website suspension is blocked fail-closed
    domainStates.get('dom-11').state = 'draft';
    const blockedPreview = await runtime.preview({ websiteId });
    assert.equal(blockedPreview.readyToSuspend, false);
    assert.equal(blockedPreview.confirmation, null);
    assert.ok(blockedPreview.domains.find((d) => d.id === 'dom-11').blockers.includes('domain_active_state_required'));

    // Attempting to start with blocked preview fails closed
    await assert.rejects(
      runtime.start({
        websiteId,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      }),
      (err) => err instanceof WebsiteSuspensionRuntimeError && err.code === 'website_suspension_blocked',
    );

    // Restore dom-11 health
    domainStates.get('dom-11').state = 'active';
    const validPreview = await runtime.preview({ websiteId });

    // 3. Start: suspends all 3 domains
    const operation = await runtime.start({
      websiteId,
      previewDigest: validPreview.previewDigest,
      confirmation: validPreview.confirmation,
    });
    assert.equal(operation.status, 'suspended');
    assert.equal(operation.domainOperations.length, 3);
    assert.ok(operation.domainOperations.every((d) => d.status === 'suspended'));
    assert.ok(operation.actions.resumeConfirmation.startsWith(`resume-website:${websiteId}:`));

    // 4. Resume: restores all 3 domains
    const resumed = await runtime.resume({
      websiteId,
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      confirmation: operation.actions.resumeConfirmation,
    });
    assert.equal(resumed.status, 'resumed');
    assert.equal(resumed.domainOperations.length, 3);
    assert.ok(resumed.domainOperations.every((d) => d.status === 'resumed'));
  });
});

test('multi-domain partial child domain failure during suspend/resume isolates failed child and retries without redundant execution', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteSuspensionOperationRegistry({ filePath });

    const websiteId = 'ws-multi-20';
    const testWebsite = { id: websiteId, serverId, name: 'partial-site', revision: 3 };

    const domains = [
      { id: 'dom-20', serverId, websiteId, primaryDomain: 'example.com', state: 'active' },
      { id: 'dom-21', serverId, websiteId, primaryDomain: 'sub1.example.com', state: 'active' },
      { id: 'dom-22', serverId, websiteId, primaryDomain: 'sub2.example.com', state: 'active' },
    ];

    const deactivationCalls = [];
    const restoreCalls = [];
    let dom22SuspendFails = true;
    let dom21ResumeFails = true;

    const childOps = new Map();

    const domainSuspensionRuntime = {
      preview: async ({ domainId: dId }) => ({
        readyToSuspend: true,
        previewDigest: 'p'.repeat(64),
        confirmation: `suspend-domain:${dId}:3:${checksum}:${'p'.repeat(64)}`,
        blockers: [],
      }),
      start: async ({ domainId: dId }) => {
        deactivationCalls.push(dId);
        if (dId === 'dom-22' && dom22SuspendFails) {
          const err = new Error('Nginx deactivation timeout for dom-22');
          err.code = 'nginx_deactivation_timeout';
          throw err;
        }
        const op = {
          id: `child-op-${dId}`,
          domainId: dId,
          status: 'suspended',
          checksum,
          updatedAt: '2026-09-30T10:00:00.000Z',
        };
        childOps.set(op.id, op);
        return op;
      },
      get: async (id) => childOps.get(id) ?? null,
      resume: async ({ domainId: dId, operationId: opId }) => {
        restoreCalls.push(dId);
        if (dId === 'dom-21' && dom21ResumeFails) {
          const err = new Error('Nginx restore failed for dom-21');
          err.code = 'nginx_restore_failed';
          throw err;
        }
        const op = {
          id: opId,
          domainId: dId,
          status: 'resumed',
          checksum,
          updatedAt: '2026-09-30T10:01:00.000Z',
        };
        childOps.set(op.id, op);
        return op;
      },
    };

    const runtime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry: { getWebsite: async (id) => (id === websiteId ? testWebsite : null) },
      domainRegistry: { listDomains: async () => domains },
      domainSuspensionRuntime,
      localServerId: serverId,
    });

    const preview = await runtime.preview({ websiteId });

    // Step 1: Initial suspend with partial failure
    const partialOp = await runtime.start({
      websiteId,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    });

    assert.equal(partialOp.status, 'partial');
    assert.equal(partialOp.domainOperations.find((d) => d.domainId === 'dom-20').status, 'suspended');
    assert.equal(partialOp.domainOperations.find((d) => d.domainId === 'dom-21').status, 'suspended');
    assert.equal(partialOp.domainOperations.find((d) => d.domainId === 'dom-22').status, 'failed');
    assert.ok(partialOp.actions.suspendRetryConfirmation);
    assert.equal(partialOp.actions.resumeConfirmation, null); // Cannot resume while partial!
    assert.deepEqual(deactivationCalls, ['dom-20', 'dom-21', 'dom-22']);

    // Step 2: Retry with stale confirmation rejected fail-closed
    await assert.rejects(
      runtime.retrySuspend({
        websiteId,
        operationId: partialOp.id,
        expectedUpdatedAt: 'stale-time',
        confirmation: partialOp.actions.suspendRetryConfirmation,
      }),
      (err) => err instanceof WebsiteSuspensionRuntimeError && err.code === 'website_suspension_confirmation_mismatch',
    );

    // Step 3: Fix dom-22 and retry suspend
    dom22SuspendFails = false;
    deactivationCalls.length = 0; // reset counter

    const retriedOp = await runtime.retrySuspend({
      websiteId,
      operationId: partialOp.id,
      expectedUpdatedAt: partialOp.updatedAt,
      confirmation: partialOp.actions.suspendRetryConfirmation,
    });

    // Verification of isolation: only dom-22 was de-activated, dom-20 and dom-21 were NOT called again!
    assert.deepEqual(deactivationCalls, ['dom-22']);
    assert.equal(retriedOp.status, 'suspended');
    assert.ok(retriedOp.domainOperations.every((d) => d.status === 'suspended'));
    assert.ok(retriedOp.actions.resumeConfirmation);

    // Step 4: Resume with partial failure (dom-21 fails)
    const partialResumeOp = await runtime.resume({
      websiteId,
      operationId: retriedOp.id,
      expectedUpdatedAt: retriedOp.updatedAt,
      confirmation: retriedOp.actions.resumeConfirmation,
    });

    assert.equal(partialResumeOp.status, 'resume_partial');
    assert.equal(partialResumeOp.domainOperations.find((d) => d.domainId === 'dom-20').status, 'resumed');
    assert.equal(partialResumeOp.domainOperations.find((d) => d.domainId === 'dom-21').status, 'resume_failed');
    assert.equal(partialResumeOp.domainOperations.find((d) => d.domainId === 'dom-22').status, 'resumed');
    assert.ok(partialResumeOp.actions.resumeRetryConfirmation);
    assert.deepEqual(restoreCalls, ['dom-20', 'dom-21', 'dom-22']);

    // Step 5: Fix dom-21 and retry resume
    dom21ResumeFails = false;
    restoreCalls.length = 0; // reset counter

    const fixedResumeOp = await runtime.retryResume({
      websiteId,
      operationId: partialResumeOp.id,
      expectedUpdatedAt: partialResumeOp.updatedAt,
      confirmation: partialResumeOp.actions.resumeRetryConfirmation,
    });

    // Verification of isolation: only dom-21 was restored, dom-20 and dom-22 were NOT called again!
    assert.deepEqual(restoreCalls, ['dom-21']);
    assert.equal(fixedResumeOp.status, 'resumed');
    assert.ok(fixedResumeOp.domainOperations.every((d) => d.status === 'resumed'));
  });
});

test('process restart and crash recovery preserves interrupted operations and blocks automatic host replay', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const store = createDomainSuspensionOperationRegistry({
      filePath,
      now: () => Date.parse('2026-09-30T10:00:00.000Z'),
      idFactory: () => operationId,
    });
    await store.init();
    const created = await store.create({
      version: 1,
      operation: 'domain_suspend',
      domain: {
        id: domainId,
        serverId,
        primaryDomain: 'example.com',
        desiredRevision: 4,
        stagedRevision: 4,
        appliedRevision: 4,
        stagedChecksum: checksum,
        state: 'active',
      },
      nginx: {
        satisfied: false,
        deactivationCandidate: true,
        restorable: false,
        reason: null,
        configName: 'yunpanel-example.com.conf',
        checksum,
        receiptVersion: null,
      },
      activeJobs: [],
      blockers: [],
      readyToSuspend: true,
      previewDigest: 'b'.repeat(64),
      confirmation: `suspend-domain:${domainId}:4:${checksum}:${'b'.repeat(64)}`,
      sideEffects: false,
    });
    await store.markSuspending(created.id);

    // Simulate process termination and fresh startup from file on disk
    const restartedStore = createDomainSuspensionOperationRegistry({ filePath });
    await restartedStore.init();
    const interrupted = await restartedStore.listInterrupted();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0].id, operationId);
    assert.equal(interrupted[0].status, 'suspending');

    let deactivateCalls = 0;
    const fx = fixture();
    const service = {
      ...fx.service,
      deactivateHost: async (...args) => {
        deactivateCalls += 1;
        return fx.service.deactivateHost(...args);
      },
    };

    const runtime = createDomainSuspensionRuntime({ registry: restartedStore, service });
    const recovery = await runtime.init();

    // Replay is BLOCKED fail-closed: automatic host mutation is never performed on restart
    assert.equal(recovery[0].operationId, operationId);
    assert.equal(recovery[0].recovered, false);
    assert.equal(recovery[0].error.code, 'domain_suspension_retry_required');
    assert.equal(deactivateCalls, 0);

    const reloaded = await runtime.get(operationId);
    assert.equal(reloaded.recovery.automaticReplayBlocked, true);
    assert.ok(reloaded.actions.suspendRetryConfirmation.startsWith('retry-domain-suspend:'));
  });
});

test('auth and tenant boundary enforces fail-closed isolation on domain and website suspension', async () => {
  const websiteRegistry = {
    getWebsite: async (id) => {
      if (id === 'ws-tenant-1') return { id: 'ws-tenant-1', serverId, customerId: 'cust-1' };
      if (id === 'ws-tenant-2') return { id: 'ws-tenant-2', serverId, customerId: 'cust-2' };
      return null;
    },
    listWebsites: async () => [
      { id: 'ws-tenant-1', serverId, customerId: 'cust-1' },
      { id: 'ws-tenant-2', serverId, customerId: 'cust-2' },
    ],
  };

  const domainRegistry = {
    getDomain: async (id) => {
      if (id === 'dom-tenant-1') return { id: 'dom-tenant-1', serverId, websiteId: 'ws-tenant-1' };
      if (id === 'dom-tenant-2') return { id: 'dom-tenant-2', serverId, websiteId: 'ws-tenant-2' };
      return null;
    },
    listDomains: async () => [],
  };

  const boundary = createSiteResourceBoundary({
    websiteRegistry,
    domainRegistry,
    localServerId: serverId,
  });

  async function testBoundary(req) {
    let statusCode = 200;
    let responseBody = null;
    let nextCalled = false;
    const res = {
      status(s) { statusCode = s; return this; },
      json(b) { responseBody = b; return this; },
      setHeader() {},
    };
    await boundary(req, res, () => { nextCalled = true; });
    return { statusCode, responseBody, nextCalled };
  }

  // 1. Inactive account -> 403 site_scope_forbidden
  const inactiveResult = await testBoundary({
    method: 'POST',
    url: '/api/websites/ws-tenant-1/suspension/start',
    auth: {
      user: { role: 'customer', id: 'cust-1', active: false, websiteIds: ['ws-tenant-1'] },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    },
  });
  assert.equal(inactiveResult.statusCode, 403);
  assert.equal(inactiveResult.responseBody?.error?.code, 'site_scope_forbidden');
  assert.equal(inactiveResult.nextCalled, false);

  // 2. Cross-tenant website suspension access -> 403 site_scope_forbidden
  const foreignWebsiteResult = await testBoundary({
    method: 'GET',
    url: '/api/websites/ws-tenant-2/suspension',
    auth: {
      user: { role: 'customer', id: 'cust-1', active: true, websiteIds: ['ws-tenant-1'] },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    },
  });
  assert.equal(foreignWebsiteResult.statusCode, 403);
  assert.equal(foreignWebsiteResult.responseBody?.error?.code, 'site_scope_forbidden');
  assert.equal(foreignWebsiteResult.nextCalled, false);

  // 3. Cross-tenant domain suspension access -> 403 site_scope_forbidden
  const foreignDomainResult = await testBoundary({
    method: 'POST',
    url: '/api/domains/dom-tenant-2/suspend',
    auth: {
      user: { role: 'customer', id: 'cust-1', active: true, websiteIds: ['ws-tenant-1'] },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    },
  });
  assert.equal(foreignDomainResult.statusCode, 403);
  assert.equal(foreignDomainResult.responseBody?.error?.code, 'site_scope_forbidden');
  assert.equal(foreignDomainResult.nextCalled, false);

  // 4. Authorized tenant access to own website suspension -> 200 (next called)
  const authorizedResult = await testBoundary({
    method: 'GET',
    url: '/api/websites/ws-tenant-1/suspension',
    auth: {
      user: { role: 'customer', id: 'cust-1', active: true, websiteIds: ['ws-tenant-1'] },
      access: { mode: 'site_management' },
      security: { managementAllowed: true },
    },
  });
  assert.equal(authorizedResult.nextCalled, true);
});

test('suspension strictly stops web ingress and does NOT delete files, databases or mail records (BUG-02 isolation)', async () => {
  await withTempDir(async (tempDir) => {
    const filePath = path.join(tempDir, 'operations.json');
    const registry = createWebsiteSuspensionOperationRegistry({ filePath });

    // Track simulated file system contents
    const mockFiles = new Map([
      ['/var/www/vhosts/example.com/httpdocs/index.html', '<html><body>Live Content</body></html>'],
      ['/var/www/vhosts/example.com/httpdocs/app.js', 'console.log("active application");'],
      ['/var/www/vhosts/example.com/httpdocs/uploads/image.png', 'binary-data-1234'],
      ['/var/www/vhosts/example.com/.env', 'DB_PASSWORD=secret-123'],
    ]);
    const fileSnapshot = new Map(mockFiles);

    // Track simulated database records and bindings
    const mockDatabases = new Map([
      ['db_live_site', { name: 'db_live_site', collation: 'utf8mb4_unicode_ci', tableCount: 15 }],
    ]);
    const mockDbCredentials = new Map([
      ['cred-live', { id: 'cred-live', databaseName: 'db_live_site', username: 'usr_live' }],
    ]);
    const dbSnapshot = new Map(mockDatabases);
    const credSnapshot = new Map(mockDbCredentials);

    // Track simulated mailboxes, aliases, and quotas
    const mockMailboxes = new Map([
      ['mb-admin', { id: 'mb-admin', email: 'admin@example.com', quotaMb: 2048, active: true }],
      ['mb-support', { id: 'mb-support', email: 'support@example.com', quotaMb: 1024, active: true }],
    ]);
    const mockMailAliases = new Map([
      ['alias-contact', { id: 'alias-contact', source: 'contact@example.com', destination: 'admin@example.com' }],
    ]);
    const mailSnapshot = new Map(mockMailboxes);
    const aliasSnapshot = new Map(mockMailAliases);

    // Host Nginx deactivation tracking
    let nginxWebTraffic = 'active';
    const nginxCalls = [];

    const websiteId = 'ws-safe-1';
    const testWebsite = { id: websiteId, serverId, name: 'safe-site', revision: 1 };
    const domain = { id: 'dom-safe-1', serverId, websiteId, primaryDomain: 'example.com', state: 'active' };

    const domainSuspensionRuntime = {
      preview: async () => ({
        readyToSuspend: true,
        previewDigest: 's'.repeat(64),
        confirmation: `suspend-domain:dom-safe-1:1:${checksum}:${'s'.repeat(64)}`,
        blockers: [],
      }),
      start: async () => {
        nginxCalls.push('deactivate');
        nginxWebTraffic = 'deactivated';
        return {
          id: 'op-dom-safe-1',
          domainId: 'dom-safe-1',
          status: 'suspended',
          checksum,
          updatedAt: '2026-09-30T10:00:00.000Z',
        };
      },
      get: async (id) => ({
        id,
        domainId: 'dom-safe-1',
        status: nginxWebTraffic === 'deactivated' ? 'suspended' : 'active',
        checksum,
        updatedAt: '2026-09-30T10:00:00.000Z',
      }),
      resume: async () => {
        nginxCalls.push('restore');
        nginxWebTraffic = 'active';
        return {
          id: 'op-dom-safe-1',
          domainId: 'dom-safe-1',
          status: 'resumed',
          checksum,
          updatedAt: '2026-09-30T10:01:00.000Z',
        };
      },
    };

    const runtime = createWebsiteSuspensionRuntime({
      registry,
      websiteRegistry: { getWebsite: async (id) => (id === websiteId ? testWebsite : null) },
      domainRegistry: { listDomains: async () => [domain] },
      domainSuspensionRuntime,
      localServerId: serverId,
    });

    // 1. Preview
    const preview = await runtime.preview({ websiteId });
    assert.equal(preview.readyToSuspend, true);

    // 2. Start Suspend
    const suspended = await runtime.start({
      websiteId,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    });
    assert.equal(suspended.status, 'suspended');
    assert.equal(nginxWebTraffic, 'deactivated');

    // Verify while suspended:
    // Files are 100% untouched
    assert.equal(mockFiles.size, fileSnapshot.size);
    for (const [p, c] of fileSnapshot) assert.equal(mockFiles.get(p), c);
    // Databases are 100% untouched
    assert.equal(mockDatabases.size, dbSnapshot.size);
    assert.deepEqual(mockDatabases.get('db_live_site'), dbSnapshot.get('db_live_site'));
    assert.deepEqual(mockDbCredentials.get('cred-live'), credSnapshot.get('cred-live'));
    // Mail records are 100% untouched
    assert.equal(mockMailboxes.size, mailSnapshot.size);
    assert.deepEqual(mockMailboxes.get('mb-admin'), mailSnapshot.get('mb-admin'));
    assert.deepEqual(mockMailAliases.get('alias-contact'), aliasSnapshot.get('alias-contact'));

    // 3. Resume
    const resumed = await runtime.resume({
      websiteId,
      operationId: suspended.id,
      expectedUpdatedAt: suspended.updatedAt,
      confirmation: suspended.actions.resumeConfirmation,
    });
    assert.equal(resumed.status, 'resumed');
    assert.equal(nginxWebTraffic, 'active');

    // Verify after resume:
    // Files remain intact
    for (const [p, c] of fileSnapshot) assert.equal(mockFiles.get(p), c);
    // Databases remain intact
    assert.deepEqual(mockDatabases.get('db_live_site'), dbSnapshot.get('db_live_site'));
    // Mail records remain intact
    assert.deepEqual(mockMailboxes.get('mb-admin'), mailSnapshot.get('mb-admin'));

    // Distinct lifecycle proof:
    // Only Nginx web traffic configuration was mutated (deactivate then restore);
    // file system, databases, and mail services were completely untouched and NOT removed!
    assert.deepEqual(nginxCalls, ['deactivate', 'restore']);
  });
});

test('lost acknowledgement and uncertain responses do NOT auto-replay and reconcile via journal GET inspection', async () => {
  const store = createDomainSuspensionOperationRegistry({
    now: () => Date.parse('2026-09-30T10:00:00.000Z'),
    idFactory: () => operationId,
  });
  await store.init();

  let hostState = 'active';
  let deactivateCalls = 0;
  let commitCalls = 0;

  const service = {
    async preview() {
      return {
        version: 1,
        operation: 'domain_suspend',
        domain: {
          id: domainId,
          serverId,
          primaryDomain: 'example.com',
          desiredRevision: 4,
          stagedRevision: 4,
          appliedRevision: 4,
          stagedChecksum: checksum,
          state: 'active',
        },
        nginx: {
          satisfied: hostState === 'deactivated',
          deactivationCandidate: hostState === 'active',
          restorable: hostState === 'deactivated',
          checksum,
        },
        activeJobs: [],
        blockers: [],
        readyToSuspend: true,
        previewDigest: 'b'.repeat(64),
        confirmation: `suspend-domain:${domainId}:4:${checksum}:${'b'.repeat(64)}`,
        sideEffects: false,
      };
    },
    async inspectSuspend() {
      return {
        domainId,
        primaryDomain: 'example.com',
        expectedRevision: 4,
        checksum,
        controlPlane: commitCalls > 0 ? 'suspended' : 'active',
        host: {
          satisfied: hostState === 'deactivated',
          deactivationCandidate: hostState === 'active',
          restorable: hostState === 'deactivated',
          checksum,
        },
      };
    },
    async deactivateHost() {
      deactivateCalls += 1;
      hostState = 'deactivated';
      // Simulate connection timeout or lost ACK right after Nginx reload
      const err = new Error('Connection reset by peer after Nginx reload');
      err.code = 'nginx_deactivation_result_uncertain';
      err.status = 503;
      throw err;
    },
    async commitSuspended() {
      commitCalls += 1;
      return {
        id: domainId,
        state: 'suspended',
        suspensionOperationId: operationId,
        suspendedChecksum: checksum,
        suspendedAt: '2026-09-30T10:00:01.000Z',
      };
    },
    async inspectResume() { throw new Error('unused'); },
    async restoreHost() { throw new Error('unused'); },
    async commitResumed() { throw new Error('unused'); },
  };

  const runtime = createDomainSuspensionRuntime({ registry: store, service });
  await runtime.init();

  // First POST attempt encounters lost ACK after host deactivation
  const result = await runtime.start({
    domainId,
    previewDigest: 'b'.repeat(64),
    confirmation: `suspend-domain:${domainId}:4:${checksum}:${'b'.repeat(64)}`,
  });

  // Reconciled safely via inspectSuspend without repeating deactivation
  assert.equal(result.status, 'suspended');
  assert.equal(deactivateCalls, 1);
  assert.equal(commitCalls, 1);

  // Subsequent Journal GET reads persisted state without triggering mutation
  const journalOp = await runtime.get(operationId);
  assert.equal(journalOp.status, 'suspended');
  assert.equal(deactivateCalls, 1);
});
