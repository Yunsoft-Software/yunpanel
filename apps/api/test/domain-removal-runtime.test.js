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
