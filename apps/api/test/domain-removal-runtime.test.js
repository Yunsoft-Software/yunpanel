import assert from 'node:assert/strict';
import test from 'node:test';

import { createDomainRemovalOperationRegistry } from '../src/domain-removal-operation-registry.js';
import {
  createDomainRemovalRuntime,
  DomainRemovalRuntimeError,
} from '../src/domain-removal-runtime.js';

const checksum = 'a'.repeat(64);
const impactDigest = 'b'.repeat(64);
const previewDigest = 'c'.repeat(64);
const suspensionPreviewDigest = 'd'.repeat(64);
const dnsPreviewDigest = 'e'.repeat(64);
const zoneSnapshotDigest = 'f'.repeat(64);

function removalPreview({ suspended = false } = {}) {
  const suspensionOperationId = suspended ? 'suspension-operation-1' : null;
  return {
    version: 1,
    operation: 'domain_remove',
    domain: {
      id: 'domain-1',
      serverId: 'local',
      primaryDomain: 'example.com',
      websiteId: 'website-1',
      certificateId: 'certificate-1',
      parentDomainId: null,
      state: suspended ? 'suspended' : 'active',
      desiredRevision: 4,
      checksum,
      suspensionOperationId,
    },
    impact: {
      previewDigest: impactDigest,
      confirmation: `delete:domain:domain-1:${impactDigest}`,
      blockers: [
        'authoritative_dns_retirement_blocked',
        'certificates_present',
        'child_domains_present',
        'impact_apply_not_implemented',
        'website_binding_present',
      ],
    },
    plan: {
      childDomainIds: ['child-domain-1'],
      websiteId: 'website-1',
      applicationId: 'application-1',
      managedComposeProjectId: null,
      certificateIds: ['certificate-1'],
      dnsZoneIds: [],
      mailDomainIds: [],
      activeJobIds: [],
      additional: {
        mailboxes: { status: 'available', ids: [] },
        backups: { status: 'available', ids: [] },
        crons: { status: 'available', ids: [] },
        dockerWorkloads: { status: 'available', ids: [] },
      },
      authoritativeDns: {
        state: 'blocked',
        previewDigest: dnsPreviewDigest,
        zoneSnapshotDigest,
        blockers: suspended
          ? ['domain_website_binding_present', 'domain_certificate_present']
          : ['domain_routing_active', 'domain_website_binding_present', 'domain_certificate_present'],
      },
    },
    hardBlockers: [],
    readyToStart: true,
    previewDigest,
    confirmation: `start-domain-remove:domain-1:4:${previewDigest}`,
    sideEffects: false,
  };
}

function leafRemovalPreview() {
  const base = removalPreview();
  const leafPreviewDigest = '9'.repeat(64);
  return {
    ...base,
    domain: {
      ...base.domain,
      certificateId: null,
    },
    impact: {
      ...base.impact,
      blockers: ['impact_apply_not_implemented', 'website_binding_present'],
    },
    plan: {
      ...base.plan,
      childDomainIds: [],
      certificateIds: [],
      dnsZoneIds: [],
      mailDomainIds: [],
      authoritativeDns: null,
    },
    previewDigest: leafPreviewDigest,
    confirmation: `start-domain-remove:domain-1:4:${leafPreviewDigest}`,
  };
}

function suspensionPreview() {
  return {
    version: 1,
    operation: 'domain_suspend',
    readyToSuspend: true,
    blockers: [],
    domain: {
      id: 'domain-1',
      serverId: 'local',
      primaryDomain: 'example.com',
      desiredRevision: 4,
      stagedRevision: 4,
      appliedRevision: 4,
      stagedChecksum: checksum,
    },
    previewDigest: suspensionPreviewDigest,
    confirmation: 'suspend-confirmation',
  };
}

function suspendedChild(overrides = {}) {
  return {
    id: 'suspension-operation-1',
    domainId: 'domain-1',
    serverId: 'local',
    primaryDomain: 'example.com',
    domainRevision: 4,
    checksum,
    previewDigest: suspensionPreviewDigest,
    status: 'suspended',
    suspendResult: {
      suspended: true,
      hostChanged: true,
      suspendedAt: '2026-09-18T20:30:00.000Z',
    },
    suspendError: null,
    resumeResult: null,
    resumeError: null,
    recovery: { required: false, phase: null, automaticReplayBlocked: false },
    actions: {
      suspendRetryConfirmation: null,
      resumeConfirmation: 'resume-confirmation',
      resumeRetryConfirmation: null,
    },
    createdAt: '2026-09-18T20:29:00.000Z',
    updatedAt: '2026-09-18T20:30:00.000Z',
    ...overrides,
  };
}

function createRegistry() {
  let clock = Date.parse('2026-09-18T20:31:00.000Z');
  return createDomainRemovalOperationRegistry({
    idFactory: () => 'removal-operation-1',
    now: () => clock++,
  });
}

function domainRegistryFixture({ websiteId = 'website-1', present = true } = {}) {
  let current = present ? {
    id: 'domain-1',
    serverId: 'local',
    primaryDomain: 'example.com',
    websiteId,
    certificateId: null,
    state: 'suspended',
    desiredRevision: 4,
    stagedRevision: 4,
    appliedRevision: 4,
    stagedChecksum: checksum,
    suspendedChecksum: checksum,
    suspensionOperationId: 'suspension-operation-1',
    appliedPrimaryDomain: 'example.com',
    lastError: null,
  } : null;
  let detachCalls = 0;
  let finalizeCalls = 0;
  return {
    manager: {
      async getDomain(id) {
        assert.equal(id, 'domain-1');
        return current ? { ...current } : null;
      },
      async detachWebsiteForRemoval(id, input) {
        detachCalls += 1;
        assert.equal(id, 'domain-1');
        assert.deepEqual(input, {
          expectedWebsiteId: 'website-1',
          expectedRevision: 4,
          checksum,
          suspensionOperationId: 'suspension-operation-1',
        });
        current = { ...current, websiteId: null };
        return {
          changed: true,
          detachedWebsiteId: 'website-1',
          domain: { ...current },
        };
      },
      async finalizeDomainRemoval(id, input) {
        finalizeCalls += 1;
        assert.equal(id, 'domain-1');
        assert.deepEqual(input, {
          operationId: 'suspension-operation-1',
          expectedRevision: 4,
          checksum,
          confirmation: `finalize-domain-remove:domain-1:suspension-operation-1:4:${checksum}`,
        });
        const removed = {
          id: current.id,
          serverId: current.serverId,
          primaryDomain: current.primaryDomain,
          desiredRevision: current.desiredRevision,
          suspensionOperationId: current.suspensionOperationId,
          suspendedChecksum: current.suspendedChecksum,
        };
        current = null;
        return { removed: true, domain: removed };
      },
    },
    counts: () => ({ detachCalls, finalizeCalls }),
    setWebsiteId(value) { current = { ...current, websiteId: value }; },
    removeDomain() { current = null; },
  };
}

function completedSuspensionRuntime() {
  return {
    preview: async () => suspensionPreview(),
    start: async () => suspendedChild(),
    retrySuspend: async () => { throw new Error('unexpected retry'); },
    get: async () => null,
    listForDomain: async () => [],
  };
}

async function completeRoutingStep(registry, preview = leafRemovalPreview()) {
  const operation = await registry.create(preview);
  const running = await registry.markStepRunning(operation.id, operation.steps[0].id);
  return registry.succeedStep(running.id, running.steps[0].id, {
    referenceId: 'suspension-operation-1',
    evidenceDigest: '8'.repeat(64),
  });
}

test('explicit removal start delegates routing mutation to durable Domain suspension runtime', async () => {
  const registry = createRegistry();
  const preview = removalPreview();
  let suspensionStarts = 0;
  const suspensionRuntime = {
    preview: async () => suspensionPreview(),
    start: async (input) => {
      suspensionStarts += 1;
      assert.deepEqual(input, {
        domainId: 'domain-1',
        previewDigest: suspensionPreviewDigest,
        confirmation: 'suspend-confirmation',
      });
      return suspendedChild();
    },
    retrySuspend: async () => { throw new Error('unexpected retry'); },
    get: async () => null,
    listForDomain: async () => [],
  };
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime,
  });

  const operation = await runtime.start({
    domainId: 'domain-1',
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  assert.equal(suspensionStarts, 1);
  assert.equal(operation.steps[0].kind, 'routing_suspend');
  assert.equal(operation.steps[0].status, 'succeeded');
  assert.equal(operation.steps[0].result.referenceId, 'suspension-operation-1');
  assert.match(operation.steps[0].result.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(operation.steps[1].kind, 'child_domain');
  assert.equal(operation.steps[1].status, 'pending');
});

test('startup reconciles completed child suspension without replaying host mutation', async () => {
  const registry = createRegistry();
  const created = await registry.create(removalPreview());
  await registry.markStepRunning(created.id, created.steps[0].id);

  let mutationCalls = 0;
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => removalPreview(),
    suspensionRuntime: {
      preview: async () => { throw new Error('startup must not request mutation preview'); },
      start: async () => { mutationCalls += 1; throw new Error('unexpected start'); },
      retrySuspend: async () => { mutationCalls += 1; throw new Error('unexpected retry'); },
      get: async () => null,
      listForDomain: async () => [suspendedChild()],
    },
  });

  const recovery = await runtime.init();
  assert.equal(mutationCalls, 0);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[0].status, 'succeeded');
});

test('startup blocks incomplete suspension child and never retries it automatically', async () => {
  const registry = createRegistry();
  const created = await registry.create(removalPreview());
  await registry.markStepRunning(created.id, created.steps[0].id);

  let mutationCalls = 0;
  const inFlight = suspendedChild({
    status: 'suspending',
    suspendResult: null,
    actions: {
      suspendRetryConfirmation: 'retry-child',
      resumeConfirmation: null,
      resumeRetryConfirmation: null,
    },
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => removalPreview(),
    suspensionRuntime: {
      preview: async () => { throw new Error('unexpected preview'); },
      start: async () => { mutationCalls += 1; throw new Error('unexpected start'); },
      retrySuspend: async () => { mutationCalls += 1; throw new Error('unexpected retry'); },
      get: async () => null,
      listForDomain: async () => [inFlight],
    },
  });

  const recovery = await runtime.init();
  assert.equal(mutationCalls, 0);
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[0].status, 'blocked');
  assert.equal(
    recovery[0].operation.steps[0].error.code,
    'domain_removal_suspension_retry_required',
  );
  assert.ok(recovery[0].operation.actions.routingRetryConfirmation);
});

test('explicit parent routing retry uses child suspension retry confirmation', async () => {
  const registry = createRegistry();
  const created = await registry.create(removalPreview());
  let operation = await registry.markStepRunning(created.id, created.steps[0].id);
  operation = await registry.blockStep(operation.id, operation.steps[0].id, {
    code: 'domain_removal_suspension_retry_required',
    message: 'Explicit retry required',
  });

  const failedChild = suspendedChild({
    status: 'failed',
    suspendResult: null,
    suspendError: { code: 'nginx_reload_failed', message: 'reload failed' },
    actions: {
      suspendRetryConfirmation: 'retry-child',
      resumeConfirmation: null,
      resumeRetryConfirmation: null,
    },
  });
  let retryCalls = 0;
  const suspensionRuntime = {
    preview: async () => { throw new Error('unexpected preview'); },
    start: async () => { throw new Error('unexpected start'); },
    retrySuspend: async (input) => {
      retryCalls += 1;
      assert.deepEqual(input, {
        domainId: 'domain-1',
        operationId: 'suspension-operation-1',
        expectedUpdatedAt: failedChild.updatedAt,
        checksum,
        confirmation: 'retry-child',
      });
      return suspendedChild();
    },
    get: async () => null,
    listForDomain: async () => [failedChild],
  };
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => removalPreview(),
    suspensionRuntime,
  });
  const publicBefore = await runtime.get(operation.id);
  const result = await runtime.retryRouting({
    domainId: 'domain-1',
    operationId: operation.id,
    expectedUpdatedAt: publicBefore.updatedAt,
    checksum,
    confirmation: publicBefore.actions.routingRetryConfirmation,
  });

  assert.equal(retryCalls, 1);
  assert.equal(result.steps[0].status, 'succeeded');
});

test('already suspended Domain reuses exact pinned suspension operation without host mutation', async () => {
  const registry = createRegistry();
  const preview = removalPreview({ suspended: true });
  let mutationCalls = 0;
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: {
      preview: async () => { throw new Error('unexpected preview'); },
      start: async () => { mutationCalls += 1; throw new Error('unexpected start'); },
      retrySuspend: async () => { mutationCalls += 1; throw new Error('unexpected retry'); },
      get: async (id) => id === 'suspension-operation-1' ? suspendedChild() : null,
      listForDomain: async () => { throw new Error('pinned child should be used'); },
    },
  });

  const result = await runtime.start({
    domainId: 'domain-1',
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(mutationCalls, 0);
  assert.equal(result.steps[0].status, 'succeeded');
});

test('stale parent retry confirmation is rejected before child mutation', async () => {
  const registry = createRegistry();
  const created = await registry.create(removalPreview());
  let operation = await registry.markStepRunning(created.id, created.steps[0].id);
  operation = await registry.blockStep(operation.id, operation.steps[0].id, {
    code: 'domain_removal_suspension_retry_required',
    message: 'Explicit retry required',
  });
  let mutationCalls = 0;
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => removalPreview(),
    suspensionRuntime: {
      preview: async () => suspensionPreview(),
      start: async () => { mutationCalls += 1; return suspendedChild(); },
      retrySuspend: async () => { mutationCalls += 1; return suspendedChild(); },
      get: async () => null,
      listForDomain: async () => [],
    },
  });

  await assert.rejects(
    runtime.retryRouting({
      domainId: 'domain-1',
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      checksum,
      confirmation: 'wrong',
    }),
    (error) => error instanceof DomainRemovalRuntimeError
      && error.code === 'domain_removal_routing_retry_stale',
  );
  assert.equal(mutationCalls, 0);
});

test('explicit continuations detach Website binding and finalize leaf Domain metadata in journal order', async () => {
  const registry = createRegistry();
  const preview = leafRemovalPreview();
  const domains = domainRegistryFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });

  let operation = await runtime.start({
    domainId: preview.domain.id,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(operation.steps[0].status, 'succeeded');
  assert.equal(operation.steps[1].kind, 'website_binding');
  assert.equal(operation.steps[1].status, 'pending');
  assert.match(operation.actions.stepContinuationConfirmation, /^continue-domain-remove-step:/);

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[1].result.referenceId, 'website-1');
  assert.equal(operation.steps[2].kind, 'metadata_finalization');
  assert.equal(operation.steps[2].status, 'pending');

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[2].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.status, 'removed');
  assert.equal(operation.steps[2].status, 'succeeded');
  assert.equal(operation.steps[2].result.referenceId, 'domain-1');
  assert.deepEqual(domains.counts(), { detachCalls: 1, finalizeCalls: 1 });
  assert.equal(operation.actions.stepContinuationConfirmation, null);
});

test('startup closes a running Website detachment from exact absent post-condition without replay', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture({ websiteId: null });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => leafRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[1].status, 'succeeded');
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
});

test('startup blocks a still-present Website binding and never replays detachment', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => leafRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[1].status, 'blocked');
  assert.equal(
    recovery[0].operation.steps[1].error.code,
    'domain_removal_website_detach_retry_required',
  );
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
  assert.ok(recovery[0].operation.actions.stepContinuationConfirmation);
});

test('startup closes running metadata finalization only when exact Domain is already absent', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  operation = await registry.succeedStep(operation.id, operation.steps[1].id, {
    referenceId: 'website-1',
    evidenceDigest: '7'.repeat(64),
  });
  operation = await registry.markStepRunning(operation.id, operation.steps[2].id);
  const domains = domainRegistryFixture({ present: false });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => leafRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.status, 'removed');
  assert.equal(recovery[0].operation.steps[2].status, 'succeeded');
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
});

test('startup blocks present Domain metadata and never replays finalization', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  operation = await registry.succeedStep(operation.id, operation.steps[1].id, {
    referenceId: 'website-1',
    evidenceDigest: '7'.repeat(64),
  });
  operation = await registry.markStepRunning(operation.id, operation.steps[2].id);
  const domains = domainRegistryFixture({ websiteId: null });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => leafRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[2].status, 'blocked');
  assert.equal(
    recovery[0].operation.steps[2].error.code,
    'domain_removal_metadata_retry_required',
  );
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
});

test('missing control-plane dependency rejects continuation without starting the journal step', async () => {
  const registry = createRegistry();
  const preview = leafRemovalPreview();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
  });
  const operation = await runtime.start({
    domainId: preview.domain.id,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  await assert.rejects(
    runtime.continueStep({
      domainId: operation.domainId,
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      stepId: operation.steps[1].id,
      checksum: operation.checksum,
      confirmation: operation.actions.stepContinuationConfirmation,
    }),
    (error) => error instanceof DomainRemovalRuntimeError
      && error.code === 'domain_removal_control_plane_unavailable',
  );
  const unchanged = await runtime.get(operation.id);
  assert.equal(unchanged.updatedAt, operation.updatedAt);
  assert.equal(unchanged.steps[1].status, 'pending');
});

test('stale control-plane continuation is rejected before Domain mutation', async () => {
  const registry = createRegistry();
  const preview = leafRemovalPreview();
  const domains = domainRegistryFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
  });
  const operation = await runtime.start({
    domainId: preview.domain.id,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  await assert.rejects(
    runtime.continueStep({
      domainId: operation.domainId,
      operationId: operation.id,
      expectedUpdatedAt: operation.updatedAt,
      stepId: operation.steps[1].id,
      checksum: operation.checksum,
      confirmation: 'wrong',
    }),
    (error) => error instanceof DomainRemovalRuntimeError
      && error.code === 'domain_removal_step_continuation_stale',
  );
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
});
