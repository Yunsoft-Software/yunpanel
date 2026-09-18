import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneRetirementError,
  createDnsZoneRetirementService,
  dnsZoneRetirementInternals,
} from '../src/dns-zone-retirement.js';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';

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
  secretError = null,
  zoneError = null,
} = {}) {
  let secretCalls = 0;
  let zoneCalls = 0;
  const allDomains = domains ?? [currentDomain];
  const service = createDnsZoneRetirementService({
    localServerId,
    domainRegistry: {
      async getDomain(id) { return id === currentDomain.id ? currentDomain : null; },
      async listDomains() { return allDomains; },
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
