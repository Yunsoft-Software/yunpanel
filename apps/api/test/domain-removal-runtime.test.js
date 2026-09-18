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
const ownershipEvidenceDigest = '1'.repeat(64);
const childChecksum = '2'.repeat(64);

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
      childDomains: [{
        id: 'child-domain-1',
        serverId: 'local',
        primaryDomain: 'api.example.com',
        websiteId: 'website-2',
        certificateId: null,
        parentDomainId: 'domain-1',
        state: 'active',
        desiredRevision: 2,
        checksum: '2'.repeat(64),
        suspensionOperationId: null,
      }],
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
        ownershipEvidenceDigest,
        snapshotRetentionDays: 30,
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
      childDomains: [],
      certificateIds: [],
      dnsZoneIds: [],
      mailDomainIds: [],
      authoritativeDns: null,
    },
    previewDigest: leafPreviewDigest,
    confirmation: `start-domain-remove:domain-1:4:${leafPreviewDigest}`,
  };
}

function childRemovalPreview(overrides = {}) {
  const childPreviewDigest = '3'.repeat(64);
  const childImpactDigest = '4'.repeat(64);
  const base = {
    version: 1,
    operation: 'domain_remove',
    domain: {
      id: 'child-domain-1',
      serverId: 'local',
      primaryDomain: 'api.example.com',
      websiteId: 'website-2',
      certificateId: null,
      parentDomainId: 'domain-1',
      state: 'active',
      desiredRevision: 2,
      checksum: childChecksum,
      suspensionOperationId: null,
    },
    impact: {
      previewDigest: childImpactDigest,
      confirmation: `delete:domain:child-domain-1:${childImpactDigest}`,
      blockers: ['application_binding_present', 'impact_apply_not_implemented', 'website_binding_present'],
    },
    plan: {
      childDomainIds: [],
      childDomains: [],
      websiteId: 'website-2',
      applicationId: 'application-2',
      managedComposeProjectId: null,
      certificateIds: [],
      dnsZoneIds: [],
      mailDomainIds: [],
      activeJobIds: [],
      additional: {
        mailboxes: { status: 'available', ids: [] },
        backups: { status: 'available', ids: [] },
        crons: { status: 'available', ids: [] },
        dockerWorkloads: { status: 'available', ids: [] },
      },
      authoritativeDns: null,
    },
    hardBlockers: [],
    readyToStart: true,
    previewDigest: childPreviewDigest,
    confirmation: `start-domain-remove:child-domain-1:2:${childPreviewDigest}`,
    sideEffects: false,
  };
  return {
    ...base,
    ...overrides,
    domain: { ...base.domain, ...(overrides.domain ?? {}) },
    plan: { ...base.plan, ...(overrides.plan ?? {}) },
  };
}

function authoritativeRemovalPreview() {
  const base = leafRemovalPreview();
  const authoritativePreviewDigest = '6'.repeat(64);
  return {
    ...base,
    impact: {
      ...base.impact,
      blockers: [
        'authoritative_dns_retirement_blocked',
        'impact_apply_not_implemented',
        'website_binding_present',
      ],
    },
    plan: {
      ...base.plan,
      authoritativeDns: {
        state: 'blocked',
        previewDigest: dnsPreviewDigest,
        zoneSnapshotDigest,
        ownershipEvidenceDigest,
        snapshotRetentionDays: 30,
        blockers: ['domain_routing_active', 'domain_website_binding_present'],
      },
    },
    previewDigest: authoritativePreviewDigest,
    confirmation: `start-domain-remove:domain-1:4:${authoritativePreviewDigest}`,
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

function createNestedRegistry() {
  let clock = Date.parse('2026-09-18T20:31:00.000Z');
  let nextId = 0;
  return createDomainRemovalOperationRegistry({
    idFactory: () => `removal-operation-${++nextId}`,
    now: () => clock++,
  });
}

function childDomainControlPlaneFixture() {
  let current = {
    id: 'child-domain-1',
    serverId: 'local',
    primaryDomain: 'api.example.com',
    websiteId: 'website-2',
    certificateId: null,
    state: 'active',
    desiredRevision: 2,
    stagedRevision: 2,
    appliedRevision: 2,
    stagedChecksum: childChecksum,
    suspendedChecksum: null,
    suspensionOperationId: null,
    appliedPrimaryDomain: 'api.example.com',
    lastError: null,
  };
  let detachCalls = 0;
  let finalizeCalls = 0;
  return {
    manager: {
      async getDomain(id) {
        assert.equal(id, 'child-domain-1');
        return current ? { ...current } : null;
      },
      async detachWebsiteForRemoval(id, input) {
        detachCalls += 1;
        assert.equal(id, 'child-domain-1');
        assert.deepEqual(input, {
          expectedWebsiteId: 'website-2',
          expectedRevision: 2,
          checksum: childChecksum,
          suspensionOperationId: 'child-suspension-operation-1',
        });
        current = { ...current, websiteId: null };
        return {
          changed: true,
          detachedWebsiteId: 'website-2',
          domain: { ...current },
        };
      },
      async finalizeDomainRemoval(id, input) {
        finalizeCalls += 1;
        assert.equal(id, 'child-domain-1');
        assert.deepEqual(input, {
          operationId: 'child-suspension-operation-1',
          expectedRevision: 2,
          checksum: childChecksum,
          confirmation: `finalize-domain-remove:child-domain-1:child-suspension-operation-1:2:${childChecksum}`,
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
    suspend() {
      current = {
        ...current,
        state: 'suspended',
        suspendedChecksum: childChecksum,
        suspensionOperationId: 'child-suspension-operation-1',
      };
    },
    counts: () => ({ detachCalls, finalizeCalls }),
  };
}

function childSuspensionPreview() {
  return {
    version: 1,
    operation: 'domain_suspend',
    readyToSuspend: true,
    blockers: [],
    domain: {
      id: 'child-domain-1',
      serverId: 'local',
      primaryDomain: 'api.example.com',
      desiredRevision: 2,
      stagedRevision: 2,
      appliedRevision: 2,
      stagedChecksum: childChecksum,
    },
    previewDigest: '7'.repeat(64),
    confirmation: 'suspend-child-confirmation',
  };
}

function suspendedChildDomain() {
  return {
    id: 'child-suspension-operation-1',
    domainId: 'child-domain-1',
    serverId: 'local',
    primaryDomain: 'api.example.com',
    domainRevision: 2,
    checksum: childChecksum,
    previewDigest: '7'.repeat(64),
    status: 'suspended',
    suspendResult: {
      suspended: true,
      hostChanged: true,
      suspendedAt: '2026-09-18T20:40:00.000Z',
    },
    suspendError: null,
    resumeResult: null,
    resumeError: null,
    recovery: { required: false, phase: null, automaticReplayBlocked: false },
    actions: {
      suspendRetryConfirmation: null,
      resumeConfirmation: 'resume-child-confirmation',
      resumeRetryConfirmation: null,
    },
    createdAt: '2026-09-18T20:39:00.000Z',
    updatedAt: '2026-09-18T20:40:00.000Z',
  };
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

function nestedSuspensionRuntime(domains, { allowMutation = true } = {}) {
  let starts = 0;
  return {
    runtime: {
      async preview({ domainId }) {
        if (domainId === 'domain-1') return suspensionPreview();
        assert.equal(domainId, 'child-domain-1');
        return childSuspensionPreview();
      },
      async start(input) {
        starts += 1;
        if (!allowMutation) throw new Error('unexpected child mutation');
        if (input.domainId === 'domain-1') return suspendedChild();
        assert.deepEqual(input, {
          domainId: 'child-domain-1',
          previewDigest: '7'.repeat(64),
          confirmation: 'suspend-child-confirmation',
        });
        domains.suspend();
        return suspendedChildDomain();
      },
      async retrySuspend() { throw new Error('unexpected retry'); },
      async get() { return null; },
      async listForDomain() { return []; },
    },
    counts: () => ({ starts }),
  };
}

function dnsRetirementPreview(overrides = {}) {
  return {
    version: 1,
    operation: 'dns_zone_retirement_impact',
    domain: {
      id: 'domain-1',
      serverId: 'local',
      primaryDomain: 'example.com',
      websiteId: null,
      certificateId: null,
      desiredRevision: 4,
      state: 'suspended',
    },
    hierarchy: { descendantCount: 0, descendants: [] },
    routing: { active: false },
    zone: {
      exists: true,
      snapshotDigest: zoneSnapshotDigest,
      ownershipOrigin: { evidenceDigest: ownershipEvidenceDigest },
    },
    retention: { configured: true, snapshotRetentionDays: 30 },
    blockers: [],
    retirementPlanReady: true,
    previewDigest: '5'.repeat(64),
    confirmation: 'retire-authoritative-zone-confirmation',
    sideEffects: false,
    ...overrides,
  };
}

function dnsRetirementChild({ status = 'deleted', updatedAt = '2026-09-18T21:00:00.000Z' } = {}) {
  return {
    id: 'dns-retirement-operation-1',
    domainId: 'domain-1',
    serverId: 'local',
    zoneName: 'example.com',
    domainRevision: 4,
    previewDigest: '5'.repeat(64),
    snapshotDigest: zoneSnapshotDigest,
    ownershipEvidenceDigest,
    snapshotRetentionDays: 30,
    status,
    result: status === 'deleted' ? {
      deleted: true,
      changed: true,
      snapshotDigest: zoneSnapshotDigest,
      deletedAt: '2026-09-18T21:00:00.000Z',
      retainUntil: '2026-10-18T21:00:00.000Z',
    } : null,
    error: status === 'failed'
      ? { code: 'powerdns_zone_api_failed', message: 'PowerDNS delete failed' }
      : null,
    recovery: {
      required: status === 'deleting',
      automaticReplayBlocked: status === 'deleting',
      reason: status === 'deleting' ? 'dns_zone_retirement_interrupted_delete' : null,
      retryable: ['deleting', 'failed'].includes(status),
      retryConfirmation: ['deleting', 'failed'].includes(status) ? 'retry-dns-child' : null,
    },
    createdAt: '2026-09-18T20:59:00.000Z',
    updatedAt,
  };
}

function dnsRetirementRuntimeFixture({ initialChild = null, preview = dnsRetirementPreview() } = {}) {
  let child = initialChild;
  let previewCalls = 0;
  let startCalls = 0;
  let retryCalls = 0;
  let listCalls = 0;
  return {
    runtime: {
      async preview(input) {
        previewCalls += 1;
        assert.deepEqual(input, { domainId: 'domain-1' });
        return preview;
      },
      async start(input) {
        startCalls += 1;
        assert.deepEqual(input, {
          domainId: 'domain-1',
          previewDigest: '5'.repeat(64),
          confirmation: 'retire-authoritative-zone-confirmation',
        });
        child = dnsRetirementChild();
        return child;
      },
      async retry(input) {
        retryCalls += 1;
        assert.deepEqual(input, {
          domainId: 'domain-1',
          operationId: 'dns-retirement-operation-1',
          expectedUpdatedAt: child.updatedAt,
          snapshotDigest: zoneSnapshotDigest,
          confirmation: 'retry-dns-child',
        });
        child = dnsRetirementChild({ updatedAt: '2026-09-18T21:01:00.000Z' });
        return child;
      },
      async listForDomain(id) {
        listCalls += 1;
        assert.equal(id, 'domain-1');
        return child ? [child] : [];
      },
    },
    counts: () => ({ previewCalls, startCalls, retryCalls, listCalls }),
    child: () => child,
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

async function completeWebsiteStep(registry, preview = authoritativeRemovalPreview()) {
  let operation = await completeRoutingStep(registry, preview);
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  return registry.succeedStep(operation.id, operation.steps[1].id, {
    referenceId: 'website-1',
    evidenceDigest: '7'.repeat(64),
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

test('explicit parent continuations drive one parent-owned leaf child Domain operation at a time', async () => {
  const registry = createNestedRegistry();
  const parentPreview = removalPreview();
  const childPreview = childRemovalPreview();
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains);
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async ({ domainId }) => (
      domainId === 'domain-1' ? parentPreview : childPreview
    ),
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
  });

  let operation = await runtime.start({
    domainId: parentPreview.domain.id,
    previewDigest: parentPreview.previewDigest,
    confirmation: parentPreview.confirmation,
  });
  assert.equal(operation.steps[1].kind, 'child_domain');
  assert.ok(operation.actions.stepContinuationConfirmation);

  const continueParent = () => runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  operation = await continueParent();
  assert.equal(operation.steps[1].status, 'blocked');
  assert.equal(suspensions.counts().starts, 2);
  let childOperations = await registry.listForDomain('child-domain-1');
  assert.equal(childOperations.length, 1);
  assert.equal(childOperations[0].parentOperationId, operation.id);
  assert.equal(childOperations[0].steps[0].status, 'succeeded');
  assert.equal(childOperations[0].steps[1].kind, 'website_binding');

  operation = await continueParent();
  assert.equal(operation.steps[1].status, 'blocked');
  childOperations = await registry.listForDomain('child-domain-1');
  assert.equal(childOperations[0].steps[1].status, 'succeeded');
  assert.equal(childOperations[0].steps[2].kind, 'metadata_finalization');

  operation = await continueParent();
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[1].result.referenceId, childOperations[0].id);
  assert.match(operation.steps[1].result.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(operation.steps[2].kind, 'certificate');
  childOperations = await registry.listForDomain('child-domain-1');
  assert.equal(childOperations[0].status, 'removed');
  assert.deepEqual(domains.counts(), { detachCalls: 1, finalizeCalls: 1 });
});

test('startup closes a running child step only from an exact parent-owned removed operation', async () => {
  const registry = createNestedRegistry();
  let parent = await completeRoutingStep(registry, removalPreview());
  parent = await registry.markStepRunning(parent.id, parent.steps[1].id);
  let child = await registry.create(childRemovalPreview(), { parentOperationId: parent.id });
  while (child.status !== 'removed') {
    const step = child.steps.find((candidate) => candidate.status !== 'succeeded');
    child = await registry.markStepRunning(child.id, step.id);
    child = await registry.succeedStep(child.id, step.id, {
      referenceId: step.kind === 'routing_suspend'
        ? 'child-suspension-operation-1'
        : step.kind === 'website_binding' ? 'website-2' : 'child-domain-1',
      evidenceDigest: '8'.repeat(64),
    });
  }
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains, { allowMutation: false });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a child preview'); },
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[1].status, 'succeeded');
  assert.equal(recovery[0].operation.steps[1].result.referenceId, child.id);
  assert.equal(suspensions.counts().starts, 0);
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
});

test('startup blocks an incomplete child operation without replaying its mutation', async () => {
  const registry = createNestedRegistry();
  let parent = await completeRoutingStep(registry, removalPreview());
  parent = await registry.markStepRunning(parent.id, parent.steps[1].id);
  const child = await registry.create(childRemovalPreview(), { parentOperationId: parent.id });
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains, { allowMutation: false });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a child preview'); },
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
  });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[1].status, 'blocked');
  assert.equal(recovery[0].operation.steps[1].error.code, 'domain_removal_child_retry_required');
  assert.ok(recovery[0].operation.actions.stepContinuationConfirmation);
  assert.equal((await registry.get(child.id)).steps[0].status, 'pending');
  assert.equal(suspensions.counts().starts, 0);
});

test('child dependency drift blocks before a child journal or routing mutation is created', async () => {
  const registry = createNestedRegistry();
  const parentPreview = removalPreview();
  const driftedChild = childRemovalPreview({
    plan: { dnsZoneIds: ['new-external-zone'] },
  });
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains);
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async ({ domainId }) => (
      domainId === 'domain-1' ? parentPreview : driftedChild
    ),
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
  });
  let operation = await runtime.start({
    domainId: parentPreview.domain.id,
    previewDigest: parentPreview.previewDigest,
    confirmation: parentPreview.confirmation,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  assert.equal(operation.steps[1].status, 'blocked');
  assert.equal(operation.steps[1].error.code, 'domain_removal_child_preview_drift');
  assert.equal((await registry.listForDomain('child-domain-1')).length, 0);
  assert.equal(suspensions.counts().starts, 1);
  assert.deepEqual(domains.counts(), { detachCalls: 0, finalizeCalls: 0 });
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

test('parent continuation runs exact durable DNS retirement before Domain metadata finalization', async () => {
  const registry = createRegistry();
  const preview = authoritativeRemovalPreview();
  const domains = domainRegistryFixture();
  const dns = dnsRetirementRuntimeFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });

  let operation = await runtime.start({
    domainId: preview.domain.id,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.steps[1].kind, 'website_binding');
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[2].kind, 'authoritative_dns');

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[2].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.steps[2].status, 'succeeded');
  assert.equal(operation.steps[2].result.referenceId, 'dns-retirement-operation-1');
  assert.equal(operation.steps[3].kind, 'metadata_finalization');
  assert.deepEqual(dns.counts(), {
    previewCalls: 1,
    startCalls: 1,
    retryCalls: 0,
    listCalls: 1,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[3].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.status, 'removed');
  assert.deepEqual(domains.counts(), { detachCalls: 1, finalizeCalls: 1 });
});

test('startup closes running authoritative DNS step from exact deleted child without replay', async () => {
  const registry = createRegistry();
  let operation = await completeWebsiteStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[2].id);
  const domains = domainRegistryFixture({ websiteId: null });
  const dns = dnsRetirementRuntimeFixture({ initialChild: dnsRetirementChild() });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => authoritativeRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[2].status, 'succeeded');
  assert.deepEqual(dns.counts(), {
    previewCalls: 0,
    startCalls: 0,
    retryCalls: 0,
    listCalls: 1,
  });
});

test('parent ignores matching DNS retirement evidence created before its own journal', async () => {
  const registry = createRegistry();
  let operation = await completeWebsiteStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[2].id);
  const domains = domainRegistryFixture({ websiteId: null });
  const oldChild = dnsRetirementChild();
  oldChild.createdAt = '2026-09-18T20:00:00.000Z';
  const dns = dnsRetirementRuntimeFixture({ initialChild: oldChild });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => authoritativeRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });

  const recovery = await runtime.init();

  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[2].status, 'blocked');
  assert.equal(dns.counts().startCalls, 0);
  assert.equal(dns.counts().retryCalls, 0);
});

test('startup blocks incomplete DNS child and explicit parent continuation uses child retry fence', async () => {
  const registry = createRegistry();
  let operation = await completeWebsiteStep(registry);
  operation = await registry.markStepRunning(operation.id, operation.steps[2].id);
  const domains = domainRegistryFixture({ websiteId: null });
  const dns = dnsRetirementRuntimeFixture({
    initialChild: dnsRetirementChild({ status: 'deleting' }),
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => authoritativeRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });

  const recovery = await runtime.init();
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[2].status, 'blocked');
  assert.equal(dns.counts().retryCalls, 0);

  operation = recovery[0].operation;
  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[2].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.steps[2].status, 'succeeded');
  assert.equal(dns.counts().retryCalls, 1);
  assert.equal(dns.counts().startCalls, 0);
});

test('authoritative DNS policy drift fails parent step before child mutation', async () => {
  const registry = createRegistry();
  const preview = authoritativeRemovalPreview();
  const domains = domainRegistryFixture();
  const dns = dnsRetirementRuntimeFixture({
    preview: dnsRetirementPreview({
      retention: { configured: true, snapshotRetentionDays: 31 },
    }),
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });
  let operation = await runtime.start({
    domainId: preview.domain.id,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[2].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  assert.equal(operation.steps[2].status, 'failed');
  assert.equal(operation.steps[2].error.code, 'domain_removal_dns_preview_drift');
  assert.deepEqual(dns.counts(), {
    previewCalls: 1,
    startCalls: 0,
    retryCalls: 0,
    listCalls: 1,
  });
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
