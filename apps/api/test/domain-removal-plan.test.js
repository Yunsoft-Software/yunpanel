import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDomainRemovalPreview,
  DomainRemovalPlanError,
} from '../src/domain-removal-plan.js';

const checksum = 'a'.repeat(64);
const dnsPreviewDigest = 'b'.repeat(64);
const zoneSnapshotDigest = 'c'.repeat(64);
const ownershipEvidenceDigest = 'e'.repeat(64);

function domain(overrides = {}) {
  return {
    id: 'domain-1',
    serverId: 'local',
    primaryDomain: 'example.com',
    websiteId: 'website-1',
    certificateId: 'certificate-1',
    parentDomainId: null,
    state: 'active',
    desiredRevision: 4,
    stagedRevision: 4,
    appliedRevision: 4,
    appliedPrimaryDomain: 'example.com',
    stagedChecksum: checksum,
    suspendedChecksum: null,
    suspensionOperationId: null,
    ...overrides,
  };
}

function impact(currentDomain = domain(), overrides = {}) {
  const dependencies = {
    childDomains: [{ id: 'child-domain-1', parentDomainId: currentDomain.id }],
    website: { id: currentDomain.websiteId },
    application: { id: 'application-1' },
    managedComposeBinding: null,
    dnsZones: [{ id: 'external-zone-1' }],
    mailDomains: [{ id: 'mail-domain-1' }],
    certificates: [{ id: currentDomain.certificateId }],
    activeJobs: [],
    mailboxes: { status: 'available', items: [] },
    backups: { status: 'available', items: [] },
    crons: { status: 'available', items: [] },
    dockerWorkloads: { status: 'available', items: [] },
    authoritativeDns: {
      status: 'available',
      items: [{
        domainId: currentDomain.id,
        state: 'blocked',
        previewDigest: dnsPreviewDigest,
        zoneSnapshotDigest,
        ownershipEvidenceDigest,
        snapshotRetentionDays: 30,
        blockers: [
          'domain_website_binding_present',
          'domain_certificate_present',
          'domain_routing_active',
          'domain_descendants_present',
        ],
      }],
    },
    ...(overrides.dependencies ?? {}),
  };
  const blockers = overrides.blockers ?? [
    { code: 'child_domains_present', resourceType: 'domain', count: 1 },
    { code: 'website_binding_present', resourceType: 'website', count: 1 },
    { code: 'application_binding_present', resourceType: 'application', count: 1 },
    { code: 'dns_zones_present', resourceType: 'dns_zone', count: 1 },
    { code: 'mail_domains_present', resourceType: 'mail_domain', count: 1 },
    { code: 'certificates_present', resourceType: 'certificate', count: 1 },
    { code: 'authoritative_dns_retirement_blocked', resourceType: 'authoritative_dns', count: 1 },
    { code: 'impact_apply_not_implemented', resourceType: 'domain', count: null },
  ];
  const previewDigest = overrides.previewDigest ?? 'd'.repeat(64);
  return {
    version: 1,
    resourceType: 'domain',
    resource: {
      id: currentDomain.id,
      serverId: currentDomain.serverId,
      websiteId: currentDomain.websiteId,
      primaryDomain: currentDomain.primaryDomain,
      certificateId: currentDomain.certificateId,
      desiredRevision: currentDomain.desiredRevision,
      state: currentDomain.state,
    },
    operation: 'delete',
    targetServerId: null,
    dependencies,
    blockers,
    previewDigest,
    confirmation: `delete:domain:${currentDomain.id}:${previewDigest}`,
    ...(overrides.topLevel ?? {}),
  };
}

test('pins current resource-impact evidence into a deterministic Domain removal plan', () => {
  const currentDomain = domain();
  const preview = createDomainRemovalPreview({
    domain: currentDomain,
    impact: impact(currentDomain),
  });

  assert.equal(preview.operation, 'domain_remove');
  assert.equal(preview.readyToStart, true);
  assert.deepEqual(preview.hardBlockers, []);
  assert.deepEqual(preview.plan.childDomainIds, ['child-domain-1']);
  assert.equal(preview.plan.websiteId, 'website-1');
  assert.deepEqual(preview.plan.certificateIds, ['certificate-1']);
  assert.equal(preview.plan.authoritativeDns.previewDigest, dnsPreviewDigest);
  assert.equal(preview.plan.authoritativeDns.ownershipEvidenceDigest, ownershipEvidenceDigest);
  assert.equal(preview.plan.authoritativeDns.snapshotRetentionDays, 30);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(
    preview.confirmation,
    `start-domain-remove:domain-1:4:${preview.previewDigest}`,
  );
  assert.equal(preview.sideEffects, false);
});

test('active jobs block removal start even when all other dependencies are orchestratable', () => {
  const currentDomain = domain();
  const preview = createDomainRemovalPreview({
    domain: currentDomain,
    impact: impact(currentDomain, {
      dependencies: {
        activeJobs: [{ id: 'job-1' }],
      },
      blockers: [
        { code: 'active_jobs_present', resourceType: 'job', count: 1 },
        { code: 'impact_apply_not_implemented', resourceType: 'domain', count: null },
      ],
    }),
  });

  assert.equal(preview.readyToStart, false);
  assert.deepEqual(preview.hardBlockers, ['active_jobs_present']);
  assert.equal(preview.confirmation, null);
});

test('non-orchestratable authoritative DNS blocker fails closed', () => {
  const currentDomain = domain();
  const base = impact(currentDomain);
  const preview = createDomainRemovalPreview({
    domain: currentDomain,
    impact: {
      ...base,
      dependencies: {
        ...base.dependencies,
        authoritativeDns: {
          status: 'available',
          items: [{
            domainId: currentDomain.id,
            state: 'blocked',
            previewDigest: dnsPreviewDigest,
            zoneSnapshotDigest,
            ownershipEvidenceDigest,
            snapshotRetentionDays: 30,
            blockers: ['dns_zone_manual_rrsets_present'],
          }],
        },
      },
    },
  });

  assert.equal(preview.readyToStart, false);
  assert.deepEqual(preview.hardBlockers, ['dns_zone_manual_rrsets_present']);
});

test('suspended Domain requires exact suspension ownership evidence', () => {
  const suspended = domain({
    state: 'suspended',
    suspendedChecksum: checksum,
    suspensionOperationId: 'suspension-operation-1',
  });
  const accepted = createDomainRemovalPreview({
    domain: suspended,
    impact: impact(suspended),
  });
  assert.equal(accepted.domain.suspensionOperationId, 'suspension-operation-1');

  assert.throws(
    () => createDomainRemovalPreview({
      domain: {
        ...suspended,
        suspendedChecksum: 'e'.repeat(64),
      },
      impact: impact(suspended),
    }),
    (error) => error instanceof DomainRemovalPlanError
      && error.code === 'domain_removal_suspension_evidence_invalid',
  );
});

test('dependency drift changes the Domain removal preview digest', () => {
  const currentDomain = domain();
  const first = createDomainRemovalPreview({
    domain: currentDomain,
    impact: impact(currentDomain),
  });
  const changedImpact = impact(currentDomain);
  changedImpact.dependencies = {
    ...changedImpact.dependencies,
    childDomains: [
      ...changedImpact.dependencies.childDomains,
      { id: 'child-domain-2', parentDomainId: currentDomain.id },
    ],
  };
  const second = createDomainRemovalPreview({
    domain: currentDomain,
    impact: changedImpact,
  });

  assert.notEqual(first.previewDigest, second.previewDigest);
});


test('orders descendant Domain cleanup deepest-first before direct children', () => {
  const currentDomain = domain();
  const nestedImpact = impact(currentDomain);
  nestedImpact.dependencies = {
    ...nestedImpact.dependencies,
    childDomains: [
      { id: 'child-b', parentDomainId: currentDomain.id },
      { id: 'grandchild-a', parentDomainId: 'child-a' },
      { id: 'child-a', parentDomainId: currentDomain.id },
      { id: 'grandchild-b', parentDomainId: 'child-b' },
    ],
  };
  const preview = createDomainRemovalPreview({
    domain: currentDomain,
    impact: nestedImpact,
  });

  assert.deepEqual(
    preview.plan.childDomainIds,
    ['grandchild-a', 'grandchild-b', 'child-a', 'child-b'],
  );
});

test('rejects disconnected descendant inventory instead of guessing cascade order', () => {
  const currentDomain = domain();
  const brokenImpact = impact(currentDomain);
  brokenImpact.dependencies = {
    ...brokenImpact.dependencies,
    childDomains: [{ id: 'child-domain-1', parentDomainId: 'foreign-parent' }],
  };

  assert.throws(
    () => createDomainRemovalPreview({
      domain: currentDomain,
      impact: brokenImpact,
    }),
    (error) => error instanceof DomainRemovalPlanError
      && error.code === 'domain_removal_preview_invalid',
  );
});
