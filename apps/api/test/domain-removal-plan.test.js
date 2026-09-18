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

function noZoneDnsReference(domainId, previewDigest = '1'.repeat(64)) {
  return {
    domainId,
    state: 'not_applicable',
    previewDigest,
    zoneSnapshotDigest: null,
    ownershipEvidenceDigest: null,
    snapshotRetentionDays: null,
    blockers: [],
  };
}

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

function childDomain(id = 'child-domain-1', parentDomainId = 'domain-1', overrides = {}) {
  const primaryDomain = `${id}.example.com`;
  return {
    id,
    serverId: 'local',
    primaryDomain,
    websiteId: `website-${id}`,
    certificateId: null,
    parentDomainId,
    state: 'active',
    desiredRevision: 2,
    stagedRevision: 2,
    appliedRevision: 2,
    appliedPrimaryDomain: primaryDomain,
    stagedChecksum: '2'.repeat(64),
    suspendedChecksum: null,
    suspensionOperationId: null,
    ...overrides,
  };
}

function impact(currentDomain = domain(), overrides = {}) {
  const dependencies = {
    childDomains: [childDomain('child-domain-1', currentDomain.id, {
      serverId: currentDomain.serverId,
    })],
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
      }, noZoneDnsReference('child-domain-1')],
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
  assert.deepEqual(preview.plan.childDomains, [{
    id: 'child-domain-1',
    serverId: 'local',
    primaryDomain: 'child-domain-1.example.com',
    websiteId: 'website-child-domain-1',
    certificateId: null,
    parentDomainId: 'domain-1',
    state: 'active',
    desiredRevision: 2,
    checksum: '2'.repeat(64),
    suspensionOperationId: null,
    authoritativeDns: {
      state: 'not_applicable',
      previewDigest: '1'.repeat(64),
      zoneSnapshotDigest: null,
      ownershipEvidenceDigest: null,
      snapshotRetentionDays: null,
      blockers: [],
    },
  }]);
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
          }, noZoneDnsReference('child-domain-1')],
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
      childDomain('child-domain-2', currentDomain.id),
    ],
    authoritativeDns: {
      ...changedImpact.dependencies.authoritativeDns,
      items: [
        ...changedImpact.dependencies.authoritativeDns.items,
        noZoneDnsReference('child-domain-2', '5'.repeat(64)),
      ],
    },
  };
  const second = createDomainRemovalPreview({
    domain: currentDomain,
    impact: changedImpact,
  });

  assert.notEqual(first.previewDigest, second.previewDigest);
});

test('child Domain revision and checksum drift changes the parent removal intent', () => {
  const currentDomain = domain();
  const first = createDomainRemovalPreview({
    domain: currentDomain,
    impact: impact(currentDomain),
  });
  const changedImpact = impact(currentDomain);
  changedImpact.dependencies = {
    ...changedImpact.dependencies,
    childDomains: [childDomain('child-domain-1', currentDomain.id, {
      desiredRevision: 3,
      stagedRevision: 3,
      appliedRevision: 3,
      stagedChecksum: '3'.repeat(64),
    })],
  };
  const second = createDomainRemovalPreview({
    domain: currentDomain,
    impact: changedImpact,
  });

  assert.notEqual(first.previewDigest, second.previewDigest);
  assert.equal(second.plan.childDomains[0].desiredRevision, 3);
  assert.equal(second.plan.childDomains[0].checksum, '3'.repeat(64));
});

test('rejects unstable or cross-server child Domain intent before journaling', () => {
  const currentDomain = domain();
  const unstableImpact = impact(currentDomain);
  unstableImpact.dependencies = {
    ...unstableImpact.dependencies,
    childDomains: [childDomain('child-domain-1', currentDomain.id, {
      stagedRevision: 1,
    })],
  };
  assert.throws(
    () => createDomainRemovalPreview({ domain: currentDomain, impact: unstableImpact }),
    (error) => error instanceof DomainRemovalPlanError
      && error.code === 'domain_removal_domain_not_stable',
  );

  const crossServerImpact = impact(currentDomain);
  crossServerImpact.dependencies = {
    ...crossServerImpact.dependencies,
    childDomains: [childDomain('child-domain-1', currentDomain.id, {
      serverId: 'different-server',
    })],
  };
  assert.throws(
    () => createDomainRemovalPreview({ domain: currentDomain, impact: crossServerImpact }),
    (error) => error instanceof DomainRemovalPlanError
      && error.code === 'domain_removal_impact_stale',
  );
});


test('orders descendant Domain cleanup deepest-first before direct children', () => {
  const currentDomain = domain();
  const nestedImpact = impact(currentDomain);
  nestedImpact.dependencies = {
    ...nestedImpact.dependencies,
    childDomains: [
      childDomain('child-b', currentDomain.id),
      childDomain('grandchild-a', 'child-a'),
      childDomain('child-a', currentDomain.id),
      childDomain('grandchild-b', 'child-b'),
    ],
    authoritativeDns: {
      ...nestedImpact.dependencies.authoritativeDns,
      items: [
        nestedImpact.dependencies.authoritativeDns.items[0],
        noZoneDnsReference('child-a', '5'.repeat(64)),
        noZoneDnsReference('child-b', '6'.repeat(64)),
        noZoneDnsReference('grandchild-a', '7'.repeat(64)),
        noZoneDnsReference('grandchild-b', '8'.repeat(64)),
      ],
    },
  };
  const preview = createDomainRemovalPreview({
    domain: currentDomain,
    impact: nestedImpact,
  });

  assert.deepEqual(
    preview.plan.childDomainIds,
    ['grandchild-a', 'grandchild-b', 'child-a', 'child-b'],
  );
  assert.deepEqual(
    preview.plan.childDomains.map((child) => child.id),
    preview.plan.childDomainIds,
  );
});

test('child authoritative DNS ownership and policy are pinned and fail closed on hard blockers', () => {
  const currentDomain = domain();
  const base = impact(currentDomain);
  const withChildZone = {
    ...base,
    dependencies: {
      ...base.dependencies,
      authoritativeDns: {
        status: 'available',
        items: [base.dependencies.authoritativeDns.items[0], {
          domainId: 'child-domain-1',
          state: 'blocked',
          previewDigest: '5'.repeat(64),
          zoneSnapshotDigest: '6'.repeat(64),
          ownershipEvidenceDigest: '7'.repeat(64),
          snapshotRetentionDays: 45,
          blockers: ['domain_routing_active', 'domain_website_binding_present'],
        }],
      },
    },
  };
  const first = createDomainRemovalPreview({ domain: currentDomain, impact: withChildZone });
  assert.equal(first.readyToStart, true);
  assert.equal(first.plan.childDomains[0].authoritativeDns.snapshotRetentionDays, 45);

  const drifted = structuredClone(withChildZone);
  drifted.dependencies.authoritativeDns.items[1].snapshotRetentionDays = 46;
  const second = createDomainRemovalPreview({ domain: currentDomain, impact: drifted });
  assert.notEqual(first.previewDigest, second.previewDigest);

  const blocked = structuredClone(withChildZone);
  blocked.dependencies.authoritativeDns.items[1].blockers = ['dns_zone_manual_rrsets_present'];
  const blockedPreview = createDomainRemovalPreview({ domain: currentDomain, impact: blocked });
  assert.equal(blockedPreview.readyToStart, false);
  assert.deepEqual(blockedPreview.hardBlockers, ['dns_zone_manual_rrsets_present']);
});

test('rejects disconnected descendant inventory instead of guessing cascade order', () => {
  const currentDomain = domain();
  const brokenImpact = impact(currentDomain);
  brokenImpact.dependencies = {
    ...brokenImpact.dependencies,
    childDomains: [childDomain('child-domain-1', 'foreign-parent')],
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
