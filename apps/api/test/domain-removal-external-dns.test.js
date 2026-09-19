import assert from 'node:assert/strict';
import test from 'node:test';

import { createDomainRemovalOperationRegistry } from '../src/domain-removal-operation-registry.js';
import { createDomainRemovalRuntime } from '../src/domain-removal-runtime.js';

const checksum = 'a'.repeat(64);
const impactDigest = 'b'.repeat(64);
const previewDigest = 'c'.repeat(64);
const zoneUpdatedAt = '2026-09-19T11:00:00.000Z';

function removalPreview() {
  return {
    version: 1,
    operation: 'domain_remove',
    domain: {
      id: 'domain-1',
      serverId: 'local',
      primaryDomain: 'example.com',
      websiteId: null,
      certificateId: null,
      parentDomainId: null,
      state: 'active',
      desiredRevision: 4,
      checksum,
      suspensionOperationId: null,
    },
    impact: {
      previewDigest: impactDigest,
      confirmation: 'delete:domain:domain-1:' + impactDigest,
      blockers: ['dns_zones_present', 'impact_apply_not_implemented'],
    },
    plan: {
      childDomainIds: [],
      childDomains: [],
      websiteId: null,
      applicationId: null,
      managedComposeProjectId: null,
      certificateIds: [],
      certificateIntents: [],
      boundCertificateId: null,
      dnsZoneIds: ['dns-zone-1'],
      dnsZoneIntents: [{
        id: 'dns-zone-1',
        zoneName: 'example.com',
        webDomainId: 'domain-1',
        managementMode: 'external',
        status: 'ready',
        revision: 3,
        updatedAt: zoneUpdatedAt,
      }],
      mailDomainIds: [],
      mailDomainIntents: [],
      webmailMappingIds: [],
      webmailMappingIntents: [],
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
    previewDigest,
    confirmation: 'start-domain-remove:domain-1:4:' + previewDigest,
    sideEffects: false,
  };
}

function suspensionRuntime() {
  const child = {
    id: 'suspension-operation-1',
    domainId: 'domain-1',
    serverId: 'local',
    primaryDomain: 'example.com',
    domainRevision: 4,
    checksum,
    previewDigest: 'd'.repeat(64),
    status: 'suspended',
    suspendResult: {
      suspended: true,
      hostChanged: true,
      suspendedAt: '2026-09-19T11:10:00.000Z',
    },
    suspendError: null,
    resumeResult: null,
    resumeError: null,
    recovery: { required: false, phase: null, automaticReplayBlocked: false },
    actions: {
      suspendRetryConfirmation: null,
      resumeConfirmation: 'resume',
      resumeRetryConfirmation: null,
    },
    createdAt: '2026-09-19T11:09:00.000Z',
    updatedAt: '2026-09-19T11:10:00.000Z',
  };
  return {
    async preview() {
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
        previewDigest: child.previewDigest,
        confirmation: 'suspend-confirmation',
      };
    },
    async start() { return child; },
    async retrySuspend() { return child; },
    async get() { return child; },
    async listForDomain() { return []; },
  };
}

function domainRegistry() {
  return {
    async getDomain() {
      return {
        id: 'domain-1',
        serverId: 'local',
        primaryDomain: 'example.com',
        websiteId: null,
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
      };
    },
    async detachWebsiteForRemoval() { throw new Error('unexpected'); },
    async detachCertificateForRemoval() { throw new Error('unexpected'); },
    async finalizeDomainRemoval() { throw new Error('unexpected'); },
  };
}

function dnsRegistry({ zone = null } = {}) {
  let current = zone ?? {
    id: 'dns-zone-1',
    resourceType: 'dns_zone',
    zoneName: 'example.com',
    webDomainId: 'domain-1',
    managementMode: 'external',
    status: 'ready',
    revision: 3,
    lastObservedAt: '2026-09-19T10:59:00.000Z',
    lastErrorCode: null,
    diagnosis: null,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: zoneUpdatedAt,
  };
  const calls = [];
  return {
    calls,
    manager: {
      async getZone(id) {
        assert.equal(id, 'dns-zone-1');
        return current ? structuredClone(current) : null;
      },
      async deleteZone(id, options) {
        calls.push({ id, options });
        current = null;
        return { id, resourceType: 'dns_zone', deleted: true };
      },
    },
    removeOutOfBand() { current = null; },
  };
}

function createRuntime({ registry, dns }) {
  const preview = removalPreview();
  return createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: suspensionRuntime(),
    domainRegistry: domainRegistry(),
    dnsHostingRegistry: dns.manager,
  });
}

async function startToExternalDns(runtime) {
  const preview = removalPreview();
  return runtime.start({
    domainId: 'domain-1',
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
}

test('external DNS step unlinks only the exact journaled registry metadata', async () => {
  let clock = Date.parse('2026-09-19T11:20:00.000Z');
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'removal-operation-1',
    now: () => clock++,
  });
  const dns = dnsRegistry();
  const runtime = createRuntime({ registry, dns });

  let operation = await startToExternalDns(runtime);
  assert.deepEqual(operation.steps.map((step) => [step.kind, step.status]), [
    ['routing_suspend', 'succeeded'],
    ['external_dns_zone', 'pending'],
    ['metadata_finalization', 'pending'],
  ]);

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(dns.calls.length, 1);
  assert.deepEqual(dns.calls[0], {
    id: 'dns-zone-1',
    options: {
      expectedRevision: 3,
      confirmation: 'delete-dns-zone:dns-zone-1:3',
    },
  });
  assert.match(operation.steps[1].result.evidenceDigest, /^[a-f0-9]{64}$/);
});

test('startup reconciles lost acknowledgement only after the external DNS step owned mutation', async () => {
  let clock = Date.parse('2026-09-19T11:30:00.000Z');
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'removal-operation-1',
    now: () => clock++,
  });
  const dns = dnsRegistry();
  const runtime = createRuntime({ registry, dns });

  const operation = await startToExternalDns(runtime);
  await registry.markStepRunning(operation.id, operation.steps[1].id);
  dns.removeOutOfBand();

  const recovery = await runtime.init();
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  const current = await runtime.get(operation.id);
  assert.equal(current.steps[1].status, 'succeeded');
  assert.equal(dns.calls.length, 0);
});

test('external DNS revision drift blocks before registry deletion', async () => {
  let clock = Date.parse('2026-09-19T11:40:00.000Z');
  const registry = createDomainRemovalOperationRegistry({
    idFactory: () => 'removal-operation-1',
    now: () => clock++,
  });
  const dns = dnsRegistry({
    zone: {
      id: 'dns-zone-1',
      resourceType: 'dns_zone',
      zoneName: 'example.com',
      webDomainId: 'domain-1',
      managementMode: 'external',
      status: 'degraded',
      revision: 4,
      lastObservedAt: '2026-09-19T11:15:00.000Z',
      lastErrorCode: 'dns_target_mismatch',
      diagnosis: { severity: 'error' },
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T11:15:00.000Z',
    },
  });
  const runtime = createRuntime({ registry, dns });

  let operation = await startToExternalDns(runtime);
  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  assert.equal(operation.steps[1].status, 'blocked');
  assert.equal(operation.steps[1].error.code, 'domain_removal_external_dns_drift');
  assert.equal(dns.calls.length, 0);
});
