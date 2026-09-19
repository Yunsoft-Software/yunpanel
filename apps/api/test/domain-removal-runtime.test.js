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

function childNoZoneDnsPlan() {
  return {
    state: 'not_applicable',
    previewDigest: '2'.repeat(64),
    zoneSnapshotDigest: null,
    ownershipEvidenceDigest: null,
    snapshotRetentionDays: null,
    blockers: [],
  };
}

function childZoneDnsPlan(overrides = {}) {
  return {
    state: 'blocked',
    previewDigest: 'a'.repeat(64),
    zoneSnapshotDigest: '6'.repeat(64),
    ownershipEvidenceDigest: '7'.repeat(64),
    snapshotRetentionDays: 14,
    blockers: ['domain_routing_active', 'domain_website_binding_present'],
    ...overrides,
  };
}

function removalPreview({
  suspended = false,
  childAuthoritativeDns = childNoZoneDnsPlan(),
} = {}) {
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
        authoritativeDns: childAuthoritativeDns,
      }],
      websiteId: 'website-1',
      applicationId: 'application-1',
      managedComposeProjectId: null,
      certificateIds: ['certificate-1'],
      certificateIntents: [{
        id: 'certificate-1',
        domainId: 'domain-1',
        serverId: 'local',
        state: 'active',
        source: 'acme',
        renewalMode: 'automatic',
        staging: false,
        validTo: '2026-12-01T00:00:00.000Z',
        updatedAt: '2026-09-18T20:00:00.000Z',
        retirementOperationId: null,
        retiredAt: null,
        retiredFromState: null,
      }],
      boundCertificateId: 'certificate-1',
      dnsZoneIds: [],
      dnsZoneIntents: [],
      mailDomainIds: [],
      mailDomainIntents: [],
      webmailMappingIds: [],
      webmailMappingIntents: [],
      activeJobIds: []
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
      certificateIntents: [],
      boundCertificateId: null,
      dnsZoneIds: [],
      dnsZoneIntents: [],
      mailDomainIds: [],
      mailDomainIntents: [],
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
      certificateIntents: [],
      boundCertificateId: null,
      dnsZoneIds: [],
      dnsZoneIntents: [],
      mailDomainIds: [],
      mailDomainIntents: [],
      webmailMappingIds: [],
      webmailMappingIntents: [],
      activeJobIds: []
      additional: {
        mailboxes: { status: 'available', ids: [] },
        backups: { status: 'available', ids: [] },
        crons: { status: 'available', ids: [] },
        dockerWorkloads: { status: 'available', ids: [] },
      },
      authoritativeDns: childNoZoneDnsPlan(),
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

function certificateRemovalPreview() {
  const base = leafRemovalPreview();
  const certificatePreviewDigest = 'b'.repeat(64);
  return {
    ...base,
    domain: {
      ...base.domain,
      certificateId: 'certificate-1',
    },
    impact: {
      ...base.impact,
      blockers: ['certificates_present', ...base.impact.blockers],
    },
    plan: {
      ...base.plan,
      certificateIds: ['certificate-1'],
      certificateIntents: [{
        id: 'certificate-1',
        domainId: 'domain-1',
        serverId: 'local',
        state: 'active',
        source: 'acme',
        renewalMode: 'automatic',
        staging: false,
        validTo: '2026-12-01T00:00:00.000Z',
        updatedAt: '2026-09-18T20:00:00.000Z',
        retirementOperationId: null,
        retiredAt: null,
        retiredFromState: null,
      }],
      boundCertificateId: 'certificate-1',
    },
    previewDigest: certificatePreviewDigest,
    confirmation: `start-domain-remove:domain-1:4:${certificatePreviewDigest}`,
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

function mailRemovalPreview({ managementMode = 'local', status = 'enabled' } = {}) {
  const base = leafRemovalPreview();
  const mailPreviewDigest = managementMode === 'local' ? '0'.repeat(64) : '1'.repeat(64);
  return {
    ...base,
    impact: {
      ...base.impact,
      blockers: ['impact_apply_not_implemented', 'mail_domains_present', 'website_binding_present'],
    },
    plan: {
      ...base.plan,
      mailDomainIds: ['mail-domain-1'],
      mailDomainIntents: [{
        id: 'mail-domain-1',
        domainName: 'example.com',
        webDomainId: 'domain-1',
        managementMode,
        status,
        revision: 5,
        updatedAt: '2026-09-18T20:10:00.000Z',
      }],
    },
    previewDigest: mailPreviewDigest,
    confirmation: `start-domain-remove:domain-1:4:${mailPreviewDigest}`,
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

function childDomainControlPlaneFixture({ certificateId = null } = {}) {
  let current = {
    id: 'child-domain-1',
    serverId: 'local',
    primaryDomain: 'api.example.com',
    websiteId: 'website-2',
    certificateId,
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
  let certificateDetachCalls = 0;
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
      async detachCertificateForRemoval(id, input) {
        certificateDetachCalls += 1;
        assert.equal(id, 'child-domain-1');
        assert.deepEqual(input, {
          expectedCertificateId: certificateId,
          expectedRevision: 2,
          checksum: childChecksum,
          suspensionOperationId: 'child-suspension-operation-1',
        });
        current = { ...current, certificateId: null };
        return {
          changed: true,
          detachedCertificateId: certificateId,
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
    certificateDetachCalls: () => certificateDetachCalls,
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

function domainRegistryFixture({
  websiteId = 'website-1',
  certificateId = null,
  present = true,
} = {}) {
  let current = present ? {
    id: 'domain-1',
    serverId: 'local',
    primaryDomain: 'example.com',
    websiteId,
    certificateId,
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
  let certificateDetachCalls = 0;
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
      async detachCertificateForRemoval(id, input) {
        certificateDetachCalls += 1;
        assert.equal(id, 'domain-1');
        assert.deepEqual(input, {
          expectedCertificateId: 'certificate-1',
          expectedRevision: 4,
          checksum,
          suspensionOperationId: 'suspension-operation-1',
        });
        current = { ...current, certificateId: null };
        return {
          changed: true,
          detachedCertificateId: 'certificate-1',
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
    certificateDetachCalls: () => certificateDetachCalls,
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

function mailDomainRemovalPreview({
  managementMode = 'local',
  status = 'enabled',
  parentOperationId = 'removal-operation-1',
} = {}) {
  const childPreviewDigest = managementMode === 'local' ? '3'.repeat(64) : '4'.repeat(64);
  return {
    version: 1,
    operation: 'mail_domain_remove',
    mailDomain: {
      id: 'mail-domain-1',
      webDomainId: 'domain-1',
      domainName: 'example.com',
      managementMode,
      status,
      revision: 5,
      updatedAt: '2026-09-18T20:10:00.000Z',
    },
    parentOperationId,
    removalMethod: managementMode === 'local'
      ? 'local_verified_data_finalize'
      : 'external_metadata_unlink',
    readyToStart: true,
    blockers: [],
    previewDigest: childPreviewDigest,
    confirmation: `remove-mail-domain:mail-domain-1:${parentOperationId}:${childPreviewDigest}`,
    sideEffects: false,
  };
}

function mailDomainRemovalChild({
  managementMode = 'local',
  status = 'enabled',
  childStatus = 'removed',
  parentOperationId = 'removal-operation-1',
  updatedAt = '2026-09-18T20:41:00.000Z',
  externalJobEvidence = false,
} = {}) {
  const local = managementMode === 'local';
  const removalMethod = local ? 'local_verified_data_finalize' : 'external_metadata_unlink';
  return {
    id: 'mail-removal-operation-1',
    parentOperationId,
    mailDomainId: 'mail-domain-1',
    webDomainId: 'domain-1',
    domainName: 'example.com',
    managementMode,
    sourceStatus: status,
    sourceRevision: 5,
    sourceUpdatedAt: '2026-09-18T20:10:00.000Z',
    removalMethod,
    previewDigest: managementMode === 'local' ? '3'.repeat(64) : '4'.repeat(64),
    status: childStatus,
    result: childStatus === 'removed' ? {
      removed: true,
      mailDomainId: 'mail-domain-1',
      webDomainId: 'domain-1',
      domainName: 'example.com',
      managementMode,
      removalMethod,
      finalRevision: local && status === 'enabled' ? 6 : 5,
      disableJobId: local && status === 'enabled' ? 'mail-config-job-1' : null,
      dataDeleteJobId: local || externalJobEvidence ? 'mail-delete-job-1' : null,
      backupId: local || externalJobEvidence ? 'mail-backup-job-1' : null,
      cleanupEvidenceDigest: '5'.repeat(64),
      deletedAt: '2026-09-18T20:41:00.000Z',
    } : null,
    error: childStatus === 'failed'
      ? { code: 'mail_data_delete_failed', message: 'Mail data deletion failed' }
      : null,
    recovery: {
      required: childStatus !== 'removed',
      automaticReplayBlocked: childStatus !== 'removed',
      reason: childStatus !== 'removed' ? 'mail_domain_removal_incomplete' : null,
      retryable: childStatus !== 'removed',
      retryConfirmation: childStatus !== 'removed' ? 'retry-mail-removal-child' : null,
    },
    createdAt: '2026-09-18T20:40:00.000Z',
    updatedAt,
  };
}

function mailDomainRemovalRuntimeFixture({
  managementMode = 'local',
  status = 'enabled',
  initialChild = null,
  externalJobEvidence = false,
} = {}) {
  let child = initialChild;
  let previewCalls = 0;
  let startCalls = 0;
  let retryCalls = 0;
  let listCalls = 0;
  const preview = mailDomainRemovalPreview({ managementMode, status });
  return {
    runtime: {
      async preview(input) {
        previewCalls += 1;
        assert.deepEqual(input, {
          mailDomainId: 'mail-domain-1',
          parentOperationId: 'removal-operation-1',
        });
        return preview;
      },
      async start(input) {
        startCalls += 1;
        assert.deepEqual(input, {
          mailDomainId: 'mail-domain-1',
          parentOperationId: 'removal-operation-1',
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        });
        child = mailDomainRemovalChild({ managementMode, status, externalJobEvidence });
        return child;
      },
      async retry(input) {
        retryCalls += 1;
        assert.deepEqual(input, {
          mailDomainId: 'mail-domain-1',
          operationId: 'mail-removal-operation-1',
          parentOperationId: 'removal-operation-1',
          expectedUpdatedAt: child.updatedAt,
          confirmation: 'retry-mail-removal-child',
        });
        child = mailDomainRemovalChild({
          managementMode,
          status,
          externalJobEvidence,
          updatedAt: '2026-09-18T20:42:00.000Z',
        });
        return child;
      },
      async listForMailDomain(id) {
        listCalls += 1;
        assert.equal(id, 'mail-domain-1');
        return child ? [child] : [];
      },
    },
    counts: () => ({ previewCalls, startCalls, retryCalls, listCalls }),
  };
}

function childDnsRetirementRuntimeFixture() {
  let previewCalls = 0;
  let startCalls = 0;
  let listCalls = 0;
  const preview = {
    version: 1,
    operation: 'dns_zone_retirement_impact',
    domain: {
      id: 'child-domain-1',
      serverId: 'local',
      primaryDomain: 'api.example.com',
      websiteId: null,
      certificateId: null,
      desiredRevision: 2,
      state: 'suspended',
    },
    hierarchy: { descendantCount: 0, descendants: [] },
    routing: { active: false },
    zone: {
      exists: true,
      snapshotDigest: '6'.repeat(64),
      ownershipOrigin: { evidenceDigest: '7'.repeat(64) },
    },
    retention: { configured: true, snapshotRetentionDays: 14 },
    blockers: [],
    retirementPlanReady: true,
    previewDigest: '8'.repeat(64),
    confirmation: 'retire-child-authoritative-zone-confirmation',
    sideEffects: false,
  };
  const child = {
    id: 'child-dns-retirement-operation-1',
    domainId: 'child-domain-1',
    serverId: 'local',
    zoneName: 'api.example.com',
    domainRevision: 2,
    previewDigest: preview.previewDigest,
    snapshotDigest: '6'.repeat(64),
    ownershipEvidenceDigest: '7'.repeat(64),
    snapshotRetentionDays: 14,
    status: 'deleted',
    result: {
      deleted: true,
      changed: true,
      snapshotDigest: '6'.repeat(64),
      deletedAt: '2026-09-18T21:00:00.000Z',
      retainUntil: '2026-10-02T21:00:00.000Z',
    },
    error: null,
    recovery: {
      required: false,
      automaticReplayBlocked: false,
      reason: null,
      retryable: false,
      retryConfirmation: null,
    },
    createdAt: '2026-09-18T20:59:00.000Z',
    updatedAt: '2026-09-18T21:00:00.000Z',
  };
  let current = null;
  return {
    runtime: {
      async preview(input) {
        previewCalls += 1;
        assert.deepEqual(input, { domainId: 'child-domain-1' });
        return preview;
      },
      async start(input) {
        startCalls += 1;
        assert.deepEqual(input, {
          domainId: 'child-domain-1',
          previewDigest: preview.previewDigest,
          confirmation: preview.confirmation,
        });
        current = child;
        return current;
      },
      async retry() { throw new Error('unexpected child DNS retry'); },
      async listForDomain(id) {
        listCalls += 1;
        assert.equal(id, 'child-domain-1');
        return current ? [current] : [];
      },
    },
    counts: () => ({ previewCalls, startCalls, listCalls }),
  };
}

function certificateRegistryFixture({
  id = 'certificate-1',
  domainId = 'domain-1',
  operationId = 'removal-operation-1',
  state = 'active',
  updatedAt = '2026-09-18T20:00:00.000Z',
  retirementOperationId = null,
  retiredAt = null,
  retiredFromState = null,
  retiredFromUpdatedAt = null,
} = {}) {
  let current = {
    id,
    domainId,
    serverId: 'local',
    state,
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validTo: '2026-12-01T00:00:00.000Z',
    updatedAt,
    retirementOperationId,
    retiredAt,
    retiredFromState,
    retiredFromUpdatedAt,
  };
  let retireCalls = 0;
  return {
    registry: {
      async getCertificate(id) {
        assert.equal(id, current.id);
        return { ...current };
      },
      async retireForDomainRemoval(certificateId, input) {
        retireCalls += 1;
        assert.equal(certificateId, current.id);
        assert.deepEqual(input, {
          expectedDomainId: current.domainId,
          expectedServerId: 'local',
          expectedState: 'active',
          expectedSource: 'acme',
          expectedRenewalMode: 'automatic',
          expectedStaging: false,
          expectedValidTo: '2026-12-01T00:00:00.000Z',
          expectedUpdatedAt: '2026-09-18T20:00:00.000Z',
          operationId,
        });
        current = {
          ...current,
          state: 'retired',
          updatedAt: '2026-09-18T21:00:00.000Z',
          retirementOperationId: input.operationId,
          retiredAt: '2026-09-18T21:00:00.000Z',
          retiredFromState: input.expectedState,
          retiredFromUpdatedAt: input.expectedUpdatedAt,
        };
        return { changed: true, certificate: { ...current } };
      },
    },
    current: () => ({ ...current }),
    retireCalls: () => retireCalls,
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

test('explicit continuation detaches the bound certificate and retires its registry record', async () => {
  const registry = createRegistry();
  const preview = certificateRemovalPreview();
  let operation = await completeRoutingStep(registry, preview);
  const domains = domainRegistryFixture({ certificateId: 'certificate-1' });
  const certificates = certificateRegistryFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    certificateRegistry: certificates.registry,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions?.stepContinuationConfirmation
      ?? `continue-domain-remove-step:${operation.domainId}:${operation.id}:${operation.steps[1].id}:${operation.updatedAt}:${operation.checksum}`,
  });

  assert.equal(operation.steps[1].kind, 'certificate');
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[1].result.referenceId, 'certificate-1');
  assert.equal(operation.steps[2].kind, 'website_binding');
  assert.equal(domains.certificateDetachCalls(), 1);
  assert.equal(certificates.retireCalls(), 1);
  assert.equal(certificates.current().state, 'retired');
  assert.equal(certificates.current().retirementOperationId, operation.id);
});

test('startup reconciles exact operation-owned certificate retirement without replaying mutation', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry, certificateRemovalPreview());
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture({ certificateId: null });
  const certificates = certificateRegistryFixture({
    state: 'retired',
    updatedAt: '2026-09-18T21:00:00.000Z',
    retirementOperationId: operation.id,
    retiredAt: '2026-09-18T21:00:00.000Z',
    retiredFromState: 'active',
    retiredFromUpdatedAt: '2026-09-18T20:00:00.000Z',
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a preview'); },
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    certificateRegistry: certificates.registry,
  });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[1].status, 'succeeded');
  assert.equal(domains.certificateDetachCalls(), 0);
  assert.equal(certificates.retireCalls(), 0);
});

test('startup blocks an incomplete certificate step and explicit drift fails before detachment', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry, certificateRemovalPreview());
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture({ certificateId: 'certificate-1' });
  const certificates = certificateRegistryFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a preview'); },
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    certificateRegistry: certificates.registry,
  });

  const recovery = await runtime.init();
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[1].status, 'blocked');
  assert.equal(recovery[0].operation.steps[1].error.code, 'domain_removal_certificate_retry_required');
  assert.equal(domains.certificateDetachCalls(), 0);
  assert.equal(certificates.retireCalls(), 0);

  const driftedRegistry = createRegistry();
  let driftedOperation = await completeRoutingStep(driftedRegistry, certificateRemovalPreview());
  const driftedDomains = domainRegistryFixture({ certificateId: 'certificate-1' });
  const driftedCertificates = certificateRegistryFixture({
    updatedAt: '2026-09-18T20:05:00.000Z',
  });
  const driftedRuntime = createDomainRemovalRuntime({
    registry: driftedRegistry,
    previewProvider: async () => certificateRemovalPreview(),
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: driftedDomains.manager,
    certificateRegistry: driftedCertificates.registry,
  });
  driftedOperation = await driftedRuntime.continueStep({
    domainId: driftedOperation.domainId,
    operationId: driftedOperation.id,
    expectedUpdatedAt: driftedOperation.updatedAt,
    stepId: driftedOperation.steps[1].id,
    checksum: driftedOperation.checksum,
    confirmation: `continue-domain-remove-step:${driftedOperation.domainId}:${driftedOperation.id}:${driftedOperation.steps[1].id}:${driftedOperation.updatedAt}:${driftedOperation.checksum}`,
  });
  assert.equal(driftedOperation.steps[1].status, 'blocked');
  assert.equal(driftedOperation.steps[1].error.code, 'domain_removal_certificate_intent_drift');
  assert.equal(driftedDomains.certificateDetachCalls(), 0);
  assert.equal(driftedCertificates.retireCalls(), 0);
});

test('explicit continuation delegates local Mail Domain removal to exact child evidence', async () => {
  const registry = createRegistry();
  const preview = mailRemovalPreview();
  let operation = await completeRoutingStep(registry, preview);
  const domains = domainRegistryFixture();
  const mail = mailDomainRemovalRuntimeFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    mailDomainRemovalRuntime: mail.runtime,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: `continue-domain-remove-step:${operation.domainId}:${operation.id}:${operation.steps[1].id}:${operation.updatedAt}:${operation.checksum}`,
  });

  assert.equal(operation.steps[1].kind, 'mail_domain');
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[1].result.referenceId, 'mail-removal-operation-1');
  assert.match(operation.steps[1].result.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.equal(operation.steps[2].kind, 'website_binding');
  assert.deepEqual(mail.counts(), {
    previewCalls: 1,
    startCalls: 1,
    retryCalls: 0,
    listCalls: 1,
  });
});

test('startup reconciles exact completed Mail Domain child without replaying mutation', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry, mailRemovalPreview());
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture();
  const mail = mailDomainRemovalRuntimeFixture({
    initialChild: mailDomainRemovalChild(),
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a preview'); },
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    mailDomainRemovalRuntime: mail.runtime,
  });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, true);
  assert.equal(recovery[0].operation.steps[1].status, 'succeeded');
  assert.deepEqual(mail.counts(), {
    previewCalls: 0,
    startCalls: 0,
    retryCalls: 0,
    listCalls: 1,
  });

});

test('startup leaves incomplete Mail Domain child for explicit retry', async () => {
  const registry = createRegistry();
  let operation = await completeRoutingStep(registry, mailRemovalPreview());
  operation = await registry.markStepRunning(operation.id, operation.steps[1].id);
  const domains = domainRegistryFixture();
  const mail = mailDomainRemovalRuntimeFixture({
    initialChild: mailDomainRemovalChild({ childStatus: 'deleting_data' }),
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => { throw new Error('startup must not create a preview'); },
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    mailDomainRemovalRuntime: mail.runtime,
  });

  const recovery = await runtime.init();

  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].recovered, false);
  assert.equal(recovery[0].operation.steps[1].status, 'blocked');
  assert.equal(recovery[0].operation.steps[1].error.code, 'domain_removal_mail_retry_required');
  assert.deepEqual(mail.counts(), {
    previewCalls: 0,
    startCalls: 0,
    retryCalls: 0,
    listCalls: 1,
  });

  operation = recovery[0].operation;
  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.deepEqual(mail.counts(), {
    previewCalls: 0,
    startCalls: 0,
    retryCalls: 1,
    listCalls: 2,
  });
});

test('external Mail Domain removal rejects local data-job evidence', async () => {
  const registry = createRegistry();
  const preview = mailRemovalPreview({ managementMode: 'external', status: 'ready' });
  let operation = await completeRoutingStep(registry, preview);
  const domains = domainRegistryFixture();
  const mail = mailDomainRemovalRuntimeFixture({
    managementMode: 'external',
    status: 'ready',
    externalJobEvidence: true,
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    mailDomainRemovalRuntime: mail.runtime,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: `continue-domain-remove-step:${operation.domainId}:${operation.id}:${operation.steps[1].id}:${operation.updatedAt}:${operation.checksum}`,
  });

  assert.equal(operation.steps[1].status, 'blocked');
  assert.equal(operation.steps[1].error.code, 'domain_removal_mail_evidence_invalid');
});

test('external Mail Domain removal uses metadata unlink evidence without local jobs', async () => {
  const registry = createRegistry();
  const preview = mailRemovalPreview({ managementMode: 'external', status: 'ready' });
  let operation = await completeRoutingStep(registry, preview);
  const domains = domainRegistryFixture();
  const mail = mailDomainRemovalRuntimeFixture({
    managementMode: 'external',
    status: 'ready',
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async () => preview,
    suspensionRuntime: completedSuspensionRuntime(),
    domainRegistry: domains.manager,
    mailDomainRemovalRuntime: mail.runtime,
  });

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: `continue-domain-remove-step:${operation.domainId}:${operation.id}:${operation.steps[1].id}:${operation.updatedAt}:${operation.checksum}`,
  });

  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[1].result.referenceId, 'mail-removal-operation-1');
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

test('parent delegates an exact descendant certificate retirement to the child journal', async () => {
  const childCertificate = {
    id: 'child-certificate-1',
    domainId: 'child-domain-1',
    serverId: 'local',
    state: 'active',
    source: 'acme',
    renewalMode: 'automatic',
    staging: false,
    validTo: '2026-12-01T00:00:00.000Z',
    updatedAt: '2026-09-18T20:00:00.000Z',
    retirementOperationId: null,
    retiredAt: null,
    retiredFromState: null,
  };
  const registry = createNestedRegistry();
  const parentPreview = removalPreview();
  parentPreview.plan.childDomains[0] = {
    ...parentPreview.plan.childDomains[0],
    certificateId: childCertificate.id,
  };
  parentPreview.plan.certificateIds = ['certificate-1', childCertificate.id];
  parentPreview.plan.certificateIntents = [
    ...parentPreview.plan.certificateIntents,
    childCertificate,
  ];
  const childPreview = childRemovalPreview({
    domain: { certificateId: childCertificate.id },
    plan: {
      certificateIds: [childCertificate.id],
      certificateIntents: [childCertificate],
      boundCertificateId: childCertificate.id,
    },
  });
  const domains = childDomainControlPlaneFixture({ certificateId: childCertificate.id });
  const suspensions = nestedSuspensionRuntime(domains);
  const certificates = certificateRegistryFixture({
    id: childCertificate.id,
    domainId: childCertificate.domainId,
    operationId: 'removal-operation-2',
  });
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async ({ domainId }) => (
      domainId === 'domain-1' ? parentPreview : childPreview
    ),
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
    certificateRegistry: certificates.registry,
  });
  let operation = await runtime.start({
    domainId: parentPreview.domain.id,
    previewDigest: parentPreview.previewDigest,
    confirmation: parentPreview.confirmation,
  });
  const continueChild = () => runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  operation = await continueChild();
  let [childOperation] = await registry.listForDomain('child-domain-1');
  assert.deepEqual(childOperation.steps.map((step) => [step.kind, step.status]), [
    ['routing_suspend', 'succeeded'],
    ['certificate', 'pending'],
    ['website_binding', 'pending'],
    ['metadata_finalization', 'pending'],
  ]);

  operation = await continueChild();
  [childOperation] = await registry.listForDomain('child-domain-1');
  assert.equal(childOperation.steps[1].status, 'succeeded');
  assert.equal(domains.certificateDetachCalls(), 1);
  assert.equal(certificates.retireCalls(), 1);

  operation = await continueChild();
  operation = await continueChild();
  assert.equal(operation.steps[1].status, 'succeeded');
  assert.equal(operation.steps[2].kind, 'certificate');
  [childOperation] = await registry.listForDomain('child-domain-1');
  assert.equal(childOperation.status, 'removed');
});

test('parent delegates exact descendant Mail Domain intent to the child journal', async () => {
  const childMailDomain = {
    id: 'mail-domain-child-1',
    domainName: 'api.example.com',
    webDomainId: 'child-domain-1',
    managementMode: 'local',
    status: 'disabled',
    revision: 3,
    updatedAt: '2026-09-18T20:00:00.000Z',
  };
  const registry = createNestedRegistry();
  const parentPreview = removalPreview();
  parentPreview.plan.mailDomainIds = [childMailDomain.id];
  parentPreview.plan.mailDomainIntents = [childMailDomain];
  const childPreview = childRemovalPreview({
    plan: {
      mailDomainIds: [childMailDomain.id],
      mailDomainIntents: [childMailDomain],
    },
  });
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

  operation = await runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  const [childOperation] = await registry.listForDomain('child-domain-1');
  assert.deepEqual(childOperation.steps.map((step) => [step.kind, step.resourceId, step.status]), [
    ['routing_suspend', 'child-domain-1', 'succeeded'],
    ['mail_domain', childMailDomain.id, 'pending'],
    ['website_binding', 'website-2', 'pending'],
    ['metadata_finalization', 'child-domain-1', 'pending'],
  ]);
  assert.equal(operation.steps[1].status, 'blocked');
  assert.equal(operation.steps[1].error.code, 'domain_removal_child_retry_required');
});

test('missing descendant Mail Domain intent blocks before child journal creation', async () => {
  const childMailDomain = {
    id: 'mail-domain-child-1',
    domainName: 'api.example.com',
    webDomainId: 'child-domain-1',
    managementMode: 'local',
    status: 'disabled',
    revision: 3,
    updatedAt: '2026-09-18T20:00:00.000Z',
  };
  const registry = createNestedRegistry();
  const parentPreview = removalPreview();
  parentPreview.plan.mailDomainIds = [childMailDomain.id];
  parentPreview.plan.mailDomainIntents = [childMailDomain];
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains);
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async ({ domainId }) => (
      domainId === 'domain-1' ? parentPreview : childRemovalPreview()
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
  assert.deepEqual(await registry.listForDomain('child-domain-1'), []);
  assert.equal(suspensions.counts().starts, 1);
});

test('parent-owned child removal delegates exact local DNS retirement before child finalization', async () => {
  const registry = createNestedRegistry();
  const childDns = childZoneDnsPlan();
  const parentPreview = removalPreview({ childAuthoritativeDns: childDns });
  const childPreview = childRemovalPreview({ plan: { authoritativeDns: childDns } });
  const domains = childDomainControlPlaneFixture();
  const suspensions = nestedSuspensionRuntime(domains);
  const dns = childDnsRetirementRuntimeFixture();
  const runtime = createDomainRemovalRuntime({
    registry,
    previewProvider: async ({ domainId }) => (
      domainId === 'domain-1' ? parentPreview : childPreview
    ),
    suspensionRuntime: suspensions.runtime,
    domainRegistry: domains.manager,
    dnsZoneRetirementRuntime: dns.runtime,
  });

  let operation = await runtime.start({
    domainId: parentPreview.domain.id,
    previewDigest: parentPreview.previewDigest,
    confirmation: parentPreview.confirmation,
  });
  const continueChild = () => runtime.continueStep({
    domainId: operation.domainId,
    operationId: operation.id,
    expectedUpdatedAt: operation.updatedAt,
    stepId: operation.steps[1].id,
    checksum: operation.checksum,
    confirmation: operation.actions.stepContinuationConfirmation,
  });

  operation = await continueChild();
  operation = await continueChild();
  operation = await continueChild();
  let [childOperation] = await registry.listForDomain('child-domain-1');
  assert.deepEqual(childOperation.steps.map((step) => [step.kind, step.status]), [
    ['routing_suspend', 'succeeded'],
    ['website_binding', 'succeeded'],
    ['authoritative_dns', 'succeeded'],
    ['metadata_finalization', 'pending'],
  ]);
  assert.deepEqual(dns.counts(), { previewCalls: 1, startCalls: 1, listCalls: 1 });

  operation = await continueChild();
  assert.equal(operation.steps[1].status, 'succeeded');
  [childOperation] = await registry.listForDomain('child-domain-1');
  assert.equal(childOperation.status, 'removed');
  assert.deepEqual(domains.counts(), { detachCalls: 1, finalizeCalls: 1 });
});

test('child authoritative DNS policy drift blocks before child routing mutation', async () => {
  const registry = createNestedRegistry();
  const childDns = childZoneDnsPlan();
  const parentPreview = removalPreview({ childAuthoritativeDns: childDns });
  const driftedChild = childRemovalPreview({
    plan: {
      authoritativeDns: childZoneDnsPlan({ snapshotRetentionDays: 15 }),
    },
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
    plan: {
      dnsZoneIds: ['new-external-zone'],
      dnsZoneIntents: [{
        id: 'new-external-zone',
        zoneName: 'api.example.com',
        webDomainId: 'child-domain-1',
        managementMode: 'external',
        status: 'unverified',
        revision: 1,
        updatedAt: '2026-09-18T20:00:00.000Z',
      }],
    },
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
