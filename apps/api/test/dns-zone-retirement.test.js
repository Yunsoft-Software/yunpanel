import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneRetirementError,
  createDnsZoneRetirementService,
  dnsZoneRetirementInternals,
} from '../src/dns-zone-retirement.js';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';
import { websiteDnsZoneProvisioningInternals } from '../src/website-dns-zone-provisioning-handler.js';

const rootId = '12345678-1234-4234-8234-123456789012';
const childId = '22345678-1234-4234-8234-123456789012';
const websiteId = '32345678-1234-4234-8234-123456789012';
const localServerId = '42345678-1234-4234-8234-123456789012';
const certificateId = 'cert-1';
const apiKey = 'a'.repeat(43);

function domain(overrides = {}) {
  return {
    id: rootId,
    serverId: localServerId,
    websiteId: null,
    primaryDomain: 'example.com',
    parentDomainId: null,
    aliases: ['www.example.com'],
    certificateId: null,
    desiredRevision: 4,
    stagedRevision: 0,
    appliedRevision: 0,
    appliedPrimaryDomain: null,
    state: 'draft',
    ...overrides,
  };
}

function managedRrset({
  name = 'example.com.',
  type = 'A',
  content = '203.0.113.10',
  source = 'template',
  key = 'apex-a',
} = {}) {
  return {
    name,
    type,
    ttl: 300,
    records: [{ content, disabled: false }],
    comments: [powerDnsZoneManagerInternals.commentFor({
      source,
      key,
      templateVersion: 7,
    })],
  };
}

function manualRrset() {
  return {
    name: 'manual.example.com.',
    type: 'TXT',
    ttl: 300,
    records: [{ content: '"keep-me"', disabled: false }],
    comments: [],
  };
}

function zone({ dnssec = false, rrsets = [managedRrset()] } = {}) {
  return {
    zoneName: 'example.com',
    id: 'example.com.',
    kind: 'Primary',
    dnssec,
    rrsets,
  };
}

function fixture({
  currentDomain = domain(),
  domains = null,
  currentZone = null,
  parentDs = null,
  parentDsError = null,
  provisioningOperations = null,
  retentionPolicy = null,
  mailDomains = [],
  jobs = [],
  mailInventoryError = null,
  jobInventoryError = null,
  secretError = null,
  zoneError = null,
} = {}) {
  let secretCalls = 0;
  let zoneCalls = 0;
  const allDomains = domains ?? [currentDomain];
  const service = createDnsZoneRetirementService({
    localServerId,
    retentionPolicy,
    domainRegistry: {
      async getDomain(id) { return id === currentDomain.id ? currentDomain : null; },
      async listDomains() { return allDomains; },
    },
    parentDsInspector: {
      async inspect({ domain }) {
        if (parentDsError) throw parentDsError;
        const current = typeof parentDs === 'function' ? parentDs() : parentDs;
        return current ?? { status: 'absent', records: [], ttl: 0, checkedAt: new Date().toISOString() };
      },
    },
    ...(provisioningOperations === null ? {} : {
      provisioningRegistry: {
        async listForDnsZone(scope) {
          assert.deepEqual(scope, {
            serverId: currentDomain.serverId,
            webDomainId: currentDomain.id,
            zoneName: currentDomain.primaryDomain,
          });
          return provisioningOperations;
        },
      },
    }),
    mailDomainRegistry: {
      async listMailDomains() {
        if (mailInventoryError) throw mailInventoryError;
        return mailDomains;
      },
    },
    jobRegistry: {
      async listJobs(filter) {
        assert.deepEqual(filter, { resourceType: 'domain', resourceId: currentDomain.id });
        if (jobInventoryError) throw jobInventoryError;
        return jobs;
      },
    },
    powerDnsSecretRegistry: {
      async materializeForServer(serverId) {
        secretCalls += 1;
        assert.equal(serverId, localServerId);
        if (secretError) throw secretError;
        return { serverId, apiKey };
      },
    },
    zoneManager: {
      async getZone(zoneName, key) {
        zoneCalls += 1;
        assert.equal(zoneName, currentDomain.primaryDomain);
        assert.equal(key, apiKey);
        if (zoneError) throw zoneError;
        return currentZone;
      },
      async inspectSnapshotDeletion({ zoneName, apiKey: suppliedKey, snapshot }) {
        assert.equal(zoneName, currentDomain.primaryDomain);
        assert.equal(suppliedKey, apiKey);
        return {
          satisfied: currentZone === null,
          deleteCandidate: currentZone !== null,
          deleted: currentZone === null,
          zoneName,
          snapshotDigest: dnsZoneRetirementInternals.digest(snapshot),
        };
      },
      async deleteSnapshot({ zoneName, apiKey: suppliedKey, snapshot }) {
        assert.equal(zoneName, currentDomain.primaryDomain);
        assert.equal(suppliedKey, apiKey);
        return {
          satisfied: true,
          deleted: true,
          changed: currentZone !== null,
          zoneName,
          snapshotDigest: dnsZoneRetirementInternals.digest(snapshot),
        };
      },
    },
  });
  return {
    service,
    calls() { return { secretCalls, zoneCalls }; },
  };
}

test('root Domain retirement impact binds hierarchy, routing, certificate and exact live zone digest', async () => {
  const root = domain({
    websiteId,
    certificateId,
    stagedRevision: 4,
    appliedRevision: 4,
    appliedPrimaryDomain: 'example.com',
    state: 'active',
  });
  const child = domain({
    id: childId,
    websiteId: null,
    primaryDomain: 'api.example.com',
    parentDomainId: rootId,
    aliases: [],
    certificateId: null,
    desiredRevision: 2,
    stagedRevision: 0,
    appliedRevision: 0,
    state: 'draft',
  });
  const currentZone = zone({
    dnssec: true,
    rrsets: [managedRrset(), manualRrset()],
  });
  const fx = fixture({ currentDomain: root, domains: [root, child], currentZone });

  const preview = await fx.service.preview({ domainId: rootId });

  assert.equal(preview.version, 1);
  assert.equal(preview.operation, 'dns_zone_retirement_impact');
  assert.equal(preview.sideEffects, false);
  assert.equal(preview.confirmation, null);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.hierarchy.descendantCount, 1);
  assert.deepEqual(preview.hierarchy.descendants, [{
    id: childId,
    primaryDomain: 'api.example.com',
    parentDomainId: rootId,
    websiteId: null,
  }]);
  assert.equal(preview.routing.active, true);
  assert.equal(preview.zone.exists, true);
  assert.match(preview.zone.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.zone.rrsetCount, 2);
  assert.equal(preview.zone.managedRrsetCount, 1);
  assert.equal(preview.zone.manualRrsetCount, 1);
  assert.equal(preview.zone.ownership, 'mixed_unproven');
  assert.deepEqual(preview.blockers, [
    'domain_descendants_present',
    'domain_website_binding_present',
    'domain_certificate_present',
    'domain_routing_active',
    'dns_zone_delete_ownership_evidence_required',
    'dns_zone_manual_rrsets_present',
    'dns_zone_dnssec_retirement_required',
  ]);
  assert.equal(preview.retirementPlanReady, false);
  assert.deepEqual(fx.calls(), { secretCalls: 1, zoneCalls: 1 });
});

test('all-managed RRsets still do not prove operation-created whole-zone ownership', async () => {
  const currentZone = zone({ rrsets: [managedRrset()] });
  const fx = fixture({ currentZone });
  const preview = await fx.service.preview({ domainId: rootId });

  assert.equal(preview.zone.ownership, 'managed_rrsets_unproven');
  assert.equal(preview.zone.managedRrsetCount, 1);
  assert.equal(preview.zone.manualRrsetCount, 0);
  assert.deepEqual(preview.blockers, ['dns_zone_delete_ownership_evidence_required']);
  assert.equal(preview.retirementPlanReady, false);
});

test('durable Website provisioning created=true evidence proves zone origin but retention still blocks deletion', async () => {
  const root = domain({ websiteId });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 2,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 2,
    },
  );
  const operationId = '52345678-1234-4234-8234-123456789012';
  const provisioningOperations = [{
    operationId,
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'succeeded',
      intent,
      evidence,
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  }];
  const fx = fixture({
    currentDomain: root,
    domains: [root],
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations,
  });

  const preview = await fx.service.preview({ domainId: rootId });

  assert.equal(preview.zone.ownership, 'provisioning_created');
  assert.equal(preview.zone.ownershipOrigin.status, 'provisioning_created');
  assert.equal(preview.zone.ownershipOrigin.operationId, operationId);
  assert.match(preview.zone.ownershipOrigin.evidenceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.blockers, [
    'domain_website_binding_present',
    'dns_zone_delete_retention_policy_required',
  ]);
  assert.equal(preview.blockers.includes('dns_zone_delete_ownership_evidence_required'), false);
  assert.equal(preview.retirementPlanReady, false);
  assert.equal(JSON.stringify(preview).includes('203.0.113.10'), false);
});

test('configured snapshot retention unlocks typed zone retirement after Website binding is removed', async () => {
  const root = domain({ websiteId: null });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 2,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 2,
    },
  );
  const operationId = '72345678-1234-4234-8234-123456789012';
  const provisioningOperations = [{
    operationId,
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'succeeded',
      intent,
      evidence,
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  }];

  const preview = await fixture({
    currentDomain: root,
    domains: [root],
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 30 },
  }).service.preview({ domainId: rootId });

  assert.equal(preview.zone.ownershipOrigin.status, 'provisioning_created');
  assert.equal(preview.zone.ownershipOrigin.operationId, operationId);
  assert.deepEqual(preview.retention, { configured: true, snapshotRetentionDays: 30 });
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.retirementPlanReady, true);
  assert.match(preview.confirmation, new RegExp(
    `^retire-authoritative-zone:${rootId}:4:[a-f0-9]{64}:[a-f0-9]{64}:30:[a-f0-9]{64}$`,
  ));
  assert.equal(preview.sideEffects, false);

  const changedPolicy = await fixture({
    currentDomain: root,
    domains: [root],
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 31 },
  }).service.preview({ domainId: rootId });
  assert.notEqual(changedPolicy.previewDigest, preview.previewDigest);
  assert.notEqual(changedPolicy.confirmation, preview.confirmation);
});

test('exact suspended routing evidence unlocks retirement without clearing applied revisions', async () => {
  const suspended = domain({
    websiteId: null,
    stagedRevision: 4,
    appliedRevision: 4,
    appliedPrimaryDomain: 'example.com',
    stagedChecksum: 'f'.repeat(64),
    suspendedChecksum: 'f'.repeat(64),
    suspensionOperationId: 'suspension-operation-1',
    lastError: null,
    state: 'suspended',
  });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 1,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 1,
    },
  );
  const preview = await fixture({
    currentDomain: suspended,
    domains: [suspended],
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations: [{
      operationId: '92345678-1234-4234-8234-123456789012',
      websiteId,
      updatedAt: '2026-09-18T16:00:00.000Z',
      steps: [{
        id: 'dns_zone',
        kind: 'dns_zone',
        state: 'succeeded',
        intent,
        evidence,
        compensation: { state: 'pending', evidence: null, error: null },
      }],
    }],
    retentionPolicy: { snapshotRetentionDays: 30 },
  }).service.preview({ domainId: rootId });

  assert.equal(preview.routing.active, false);
  assert.equal(preview.blockers.includes('domain_routing_active'), false);
  assert.equal(preview.retirementPlanReady, true);
  assert.ok(preview.confirmation);
});

test('suspended label without exact ownership evidence remains routing-active', () => {
  assert.equal(dnsZoneRetirementInternals.routingActive(domain({
    stagedRevision: 4,
    appliedRevision: 4,
    appliedPrimaryDomain: 'example.com',
    state: 'suspended',
  })), true);
});

test('invalid DNS zone retention policy is rejected at service construction', () => {
  for (const retentionPolicy of [
    { snapshotRetentionDays: 0 },
    { snapshotRetentionDays: 3651 },
    { snapshotRetentionDays: '30' },
    { snapshotRetentionDays: 30, extra: true },
  ]) {
    assert.throws(
      () => fixture({ retentionPolicy }),
      (error) => error instanceof DnsZoneRetirementError
        && error.code === 'dns_zone_retirement_policy_invalid',
    );
  }
});

test('private deletion capture revalidates exact retirement preview without exposing RRset content publicly', async () => {
  const root = domain({ websiteId: null });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 2,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 2,
    },
  );
  const provisioningOperations = [{
    operationId: '82345678-1234-4234-8234-123456789012',
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'succeeded',
      intent,
      evidence,
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  }];
  const fx = fixture({
    currentDomain: root,
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 30 },
  });
  const preview = await fx.service.preview({ domainId: rootId });
  assert.equal(preview.retirementPlanReady, true);
  assert.equal(JSON.stringify(preview).includes('203.0.113.10'), false);

  const capture = await fx.service.captureDeletionSnapshot({
    domainId: rootId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(capture.version, 1);
  assert.equal(capture.domainId, rootId);
  assert.equal(capture.serverId, localServerId);
  assert.equal(capture.zoneName, 'example.com');
  assert.equal(capture.domainRevision, 4);
  assert.equal(capture.previewDigest, preview.previewDigest);
  assert.equal(capture.snapshotDigest, preview.zone.snapshotDigest);
  assert.equal(capture.ownershipEvidenceDigest, preview.zone.ownershipOrigin.evidenceDigest);
  assert.equal(capture.snapshotRetentionDays, 30);
  assert.equal(
    capture.snapshot.rrsets.some((rrset) => rrset.records.some((record) => record.content.includes('203.0.113.10'))),
    true,
  );

  await assert.rejects(
    fx.service.captureDeletionSnapshot({
      domainId: rootId,
      previewDigest: preview.previewDigest,
      confirmation: 'wrong',
    }),
    (error) => error instanceof DnsZoneRetirementError
      && error.code === 'dns_zone_retirement_preview_stale',
  );
});

test('compensated or mismatched provisioning evidence never proves current zone ownership', async () => {
  const root = domain({ websiteId });
  const operation = {
    operationId: '62345678-1234-4234-8234-123456789012',
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'compensated',
      intent: {},
      evidence: { created: true },
      compensation: { state: 'succeeded', evidence: { removed: true }, error: null },
    }],
  };
  const preview = await fixture({
    currentDomain: root,
    domains: [root],
    currentZone: zone({ rrsets: [managedRrset()] }),
    provisioningOperations: [operation],
  }).service.preview({ domainId: rootId });

  assert.equal(preview.zone.ownershipOrigin.status, 'not_found');
  assert.equal(preview.zone.ownership, 'managed_rrsets_unproven');
  assert.equal(preview.blockers.includes('dns_zone_delete_ownership_evidence_required'), true);
  assert.equal(preview.blockers.includes('dns_zone_delete_retention_policy_required'), false);
});

test('pristine root Domain with no authoritative zone has a read-only clear impact plan', async () => {
  const fx = fixture({ currentZone: null });
  const preview = await fx.service.preview({ domainId: rootId });

  assert.equal(preview.zone.exists, false);
  assert.equal(preview.zone.snapshotDigest, null);
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.retirementPlanReady, true);
  assert.equal(preview.confirmation, null);
  assert.equal(preview.sideEffects, false);
});

test('subdomain impact never materializes root PowerDNS credentials or claims zone ownership', async () => {
  const child = domain({
    id: childId,
    primaryDomain: 'api.example.com',
    parentDomainId: rootId,
    aliases: [],
  });
  const root = domain();
  const fx = fixture({
    currentDomain: child,
    domains: [root, child],
    currentZone: zone(),
    secretError: new Error('must not be called'),
  });

  const preview = await fx.service.preview({ domainId: childId });

  assert.equal(preview.domain.parentDomainId, rootId);
  assert.equal(preview.zone.exists, false);
  assert.equal(preview.zone.ownership, 'parent_zone_owned');
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.retirementPlanReady, true);
  assert.deepEqual(fx.calls(), { secretCalls: 0, zoneCalls: 0 });
});

test('retirement impact blocks local mail-domain dependencies and active Domain jobs', async () => {
  const currentZone = zone({ rrsets: [managedRrset()] });
  const preview = await fixture({
    currentZone,
    mailDomains: [{
      id: 'mail-domain-1',
      webDomainId: rootId,
      domainName: 'example.com',
    }],
    jobs: [{
      id: 'domain-job-1',
      resourceType: 'domain',
      resourceId: rootId,
      status: 'running',
    }],
  }).service.preview({ domainId: rootId });

  assert.deepEqual(preview.dependencies.mail, {
    status: 'available',
    count: 1,
    ids: ['mail-domain-1'],
  });
  assert.deepEqual(preview.dependencies.jobs, {
    status: 'available',
    count: 1,
    ids: ['domain-job-1'],
  });
  assert.equal(preview.blockers.includes('dns_zone_mail_dependencies_present'), true);
  assert.equal(preview.blockers.includes('dns_zone_domain_jobs_active'), true);
});

test('mail and Domain job inventory failures are explicit instead of being treated as empty', async () => {
  for (const [setup, code] of [
    [{ mailInventoryError: new Error('mail registry offline') }, 'dns_zone_retirement_mail_inventory_unavailable'],
    [{ jobInventoryError: new Error('job registry offline') }, 'dns_zone_retirement_job_inventory_unavailable'],
  ]) {
    const fx = fixture({ currentZone: zone(), ...setup });
    await assert.rejects(
      fx.service.preview({ domainId: rootId }),
      (error) => error instanceof DnsZoneRetirementError
        && error.code === code
        && error.status === 503,
    );
  }
});

test('authoritative inspection fails closed when credentials or provider state are unavailable', async () => {
  for (const [setup, code] of [
    [{ secretError: new Error('secret store offline') }, 'dns_zone_retirement_secret_unavailable'],
    [{ zoneError: new Error('PowerDNS offline') }, 'dns_zone_retirement_inspection_failed'],
  ]) {
    const fx = fixture(setup);
    await assert.rejects(
      fx.service.preview({ domainId: rootId }),
      (error) => error instanceof DnsZoneRetirementError && error.code === code && error.status === 503,
    );
  }
});

test('retirement preview digest changes with exact live zone content without exposing record content', async () => {
  const first = await fixture({
    currentZone: zone({ rrsets: [managedRrset({ content: '203.0.113.10' })] }),
  }).service.preview({ domainId: rootId });
  const second = await fixture({
    currentZone: zone({ rrsets: [managedRrset({ content: '203.0.113.11' })] }),
  }).service.preview({ domainId: rootId });

  assert.notEqual(first.zone.snapshotDigest, second.zone.snapshotDigest);
  assert.notEqual(first.previewDigest, second.previewDigest);
  assert.equal(JSON.stringify(first).includes('203.0.113.10'), false);
  assert.equal(JSON.stringify(second).includes('203.0.113.11'), false);
});

test('preview identity helper is deterministic and blocker order is stable', () => {
  const root = domain({ websiteId, certificateId, appliedRevision: 1, state: 'active' });
  const child = domain({ id: childId, primaryDomain: 'api.example.com', parentDomainId: rootId });
  const currentZone = zone({ dnssec: true, rrsets: [manualRrset(), managedRrset()] });
  const first = dnsZoneRetirementInternals.previewIdentity(root, [child, root], currentZone);
  const second = dnsZoneRetirementInternals.previewIdentity(root, [root, child], currentZone);

  assert.deepEqual(first, second);
  assert.equal(dnsZoneRetirementInternals.digest(first), dnsZoneRetirementInternals.digest(second));
});

test('retirement preview blocks zone deletion when parent DS is present or unverifiable', async () => {
  const root = domain({ websiteId: null });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 2,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 2,
    },
  );
  const provisioningOperations = [{
    operationId: '82345678-1234-4234-8234-123456789012',
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'succeeded',
      intent,
      evidence,
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  }];

  const presentPreview = await fixture({
    currentDomain: root,
    currentZone: zone({ dnssec: false, rrsets: [managedRrset()] }),
    parentDs: { status: 'present', records: ['2371 13 2 abcdef'], ttl: 3600, checkedAt: new Date().toISOString() },
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 30 },
  }).service.preview({ domainId: rootId });

  assert.equal(presentPreview.retirementPlanReady, false);
  assert.equal(presentPreview.blockers.includes('dns_zone_parent_ds_present'), true);
  assert.equal(presentPreview.confirmation, null);

  const unverifiablePreview = await fixture({
    currentDomain: root,
    currentZone: zone({ dnssec: false, rrsets: [managedRrset()] }),
    parentDs: { status: 'unverifiable', records: [], ttl: null, checkedAt: new Date().toISOString() },
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 30 },
  }).service.preview({ domainId: rootId });

  assert.equal(unverifiablePreview.retirementPlanReady, false);
  assert.equal(unverifiablePreview.blockers.includes('dns_zone_parent_ds_unverifiable'), true);
});

test('parent DS present blocks snapshot capture and destructive deletion even if confirmation is attempted', async () => {
  const root = domain({ websiteId: null });
  const intent = {
    adapter: 'powerdns-zone',
    serverId: localServerId,
    webDomainId: rootId,
    zoneName: 'example.com',
    templateVersion: 7,
    templateSnapshot: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
    dnsIdentityRevision: 2,
    secondaryDns: [],
    serial: 2026091801,
    dnssec: false,
    records: [
      { key: 'apex-a', type: 'A', name: '@', ttl: 300, values: ['203.0.113.10'], source: 'template' },
      { key: 'www-a', type: 'A', name: 'www', ttl: 300, values: ['203.0.113.10'], source: 'template' },
    ],
  };
  const evidence = websiteDnsZoneProvisioningInternals.publicEvidence(
    websiteDnsZoneProvisioningInternals.normalizedIntent({ intent }),
    {
      kind: 'Primary',
      serial: 2026091801,
      dnssec: false,
      managedRrsetCount: 2,
      manualRrsetCount: 0,
      created: true,
      primaryKindChanged: false,
      changedRrsetCount: 2,
    },
  );
  const provisioningOperations = [{
    operationId: '82345678-1234-4234-8234-123456789012',
    websiteId,
    updatedAt: '2026-09-18T16:00:00.000Z',
    steps: [{
      id: 'dns_zone',
      kind: 'dns_zone',
      state: 'succeeded',
      intent,
      evidence,
      compensation: { state: 'pending', evidence: null, error: null },
    }],
  }];

  let parentDsStatus = 'absent';
  const fx = fixture({
    currentDomain: root,
    currentZone: zone({ dnssec: false, rrsets: [managedRrset()] }),
    parentDs: () => ({
      status: parentDsStatus,
      records: parentDsStatus === 'present' ? ['2371 13 2 abcdef'] : [],
      ttl: 3600,
      checkedAt: new Date().toISOString(),
    }),
    provisioningOperations,
    retentionPolicy: { snapshotRetentionDays: 30 },
  });

  const preview = await fx.service.preview({ domainId: rootId });
  assert.equal(preview.retirementPlanReady, true);

  parentDsStatus = 'present';
  await assert.rejects(
    fx.service.captureDeletionSnapshot({
      domainId: rootId,
      previewDigest: preview.previewDigest,
      confirmation: preview.confirmation,
    }),
    (error) => error instanceof DnsZoneRetirementError
      && (error.code === 'dns_zone_retirement_blocked' || error.code === 'dns_zone_retirement_parent_ds_present'),
  );

  parentDsStatus = 'absent';
  const capture = await fx.service.captureDeletionSnapshot({
    domainId: rootId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });

  parentDsStatus = 'present';
  await assert.rejects(
    fx.service.deleteCapturedSnapshot({
      serverId: localServerId,
      zoneName: 'example.com',
      snapshot: capture.snapshot,
    }),
    (error) => error instanceof DnsZoneRetirementError
      && error.code === 'dns_zone_retirement_parent_ds_present',
  );
});
