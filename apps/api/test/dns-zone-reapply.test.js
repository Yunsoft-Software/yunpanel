import assert from 'node:assert/strict';
import test from 'node:test';
import { powerDnsZoneManagerInternals } from '@yunpanel/host-runtime/powerdns-zone-manager';
import { renderDnsZoneDesiredState } from '../src/dns-zone-desired-state.js';
import {
  createDnsZoneReapplyService,
  DnsZoneReapplyError,
  dnsZoneReapplyInternals,
} from '../src/dns-zone-reapply.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const domainId = '8bc307db-9e2d-4c3f-91ea-49e740d259a9';
const apiKey = 'a'.repeat(43);
const now = () => Date.parse('2026-09-16T00:00:00.000Z');

const identity = Object.freeze({
  serverId,
  revision: 4,
  settings: Object.freeze({
    publicIpv4: '203.0.113.10',
    publicIpv6: null,
    ns1: Object.freeze({ hostname: 'ns1.host.example', ipv4: '203.0.113.10', ipv6: null, local: true }),
    ns2: Object.freeze({ hostname: 'ns2.host.example', ipv4: '198.51.100.20', ipv6: null, local: false }),
    soa: Object.freeze({
      primaryNs: 'ns1.host.example',
      rname: 'hostmaster.host.example',
      refresh: 3600,
      retry: 900,
      expire: 1209600,
      minimum: 300,
      ttl: 300,
    }),
    dnssecDefault: false,
    secondaryDns: Object.freeze([]),
  }),
});

function template(version, extra = []) {
  return Object.freeze({
    serverId,
    schemaVersion: 1,
    version,
    records: Object.freeze([
      Object.freeze({ key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: Object.freeze(['<ns1>', '<ns2>']), condition: 'always' }),
      Object.freeze({ key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: Object.freeze(['<server-ipv4>']), condition: 'always' }),
      Object.freeze({ key: 'apex-ipv6', owner: '@', type: 'AAAA', ttl: null, values: Object.freeze(['<server-ipv6>']), condition: 'ipv6' }),
      Object.freeze({ key: 'www-alias', owner: 'www', type: 'CNAME', ttl: null, values: Object.freeze(['<domain>']), condition: 'always' }),
      ...extra,
    ]),
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
  });
}

const domain = Object.freeze({
  id: domainId,
  serverId,
  websiteId: '2b4a28c2-b7fd-41cb-99a8-28ec7e84449d',
  primaryDomain: 'example.com',
  aliases: Object.freeze([]),
  parentDomainId: null,
  desiredRevision: 3,
});

function liveRrset(record) {
  const rrset = powerDnsZoneManagerInternals.desiredRrset(record);
  return Object.freeze({
    ...rrset,
    managed: powerDnsZoneManagerInternals.parseManagedComment(rrset.comments),
  });
}

function liveZone({ sourceTemplate = template(1), serial = 2026091501, extraRrsets = [], domainState = domain } = {}) {
  const desired = renderDnsZoneDesiredState({
    zoneName: domainState.primaryDomain,
    template: sourceTemplate,
    dnsIdentity: identity,
    serial,
  });
  const records = dnsZoneReapplyInternals.recordsForDomain(domainState, desired);
  return Object.freeze({
    zoneName: domainState.primaryDomain,
    id: `${domainState.primaryDomain}.`,
    kind: 'Native',
    dnssec: false,
    serial,
    rrsets: Object.freeze([...records.map(liveRrset), ...extraRrsets]),
  });
}

function fixture({ currentTemplate = template(2, [
  Object.freeze({ key: 'verification', owner: '@', type: 'TXT', ttl: 300, values: Object.freeze(['yunpanel=verified']), condition: 'always' }),
]), zone = null, domainState = domain } = {}) {
  const calls = [];
  const currentZone = zone ?? liveZone({ domainState });
  const zoneManager = {
    getZone: async (zoneName, key) => {
      calls.push(['getZone', zoneName, key]);
      return currentZone;
    },
    apply: async (input) => {
      calls.push(['apply', input]);
      const soa = input.records.find((entry) => entry.type === 'SOA');
      const serial = Number.parseInt(soa.values[0].split(/\s+/)[2], 10);
      return {
        satisfied: true,
        serial,
        changedRrsetCount: input.records.length,
        manualRrsetCount: currentZone.rrsets.filter((entry) => !entry.managed).length,
      };
    },
  };
  const service = createDnsZoneReapplyService({
    domainRegistry: { getDomain: async (id) => id === domainState.id ? domainState : null },
    dnsIdentityRegistry: { getForServer: async () => identity },
    dnsZoneTemplateRegistry: { ensureForServer: async () => currentTemplate },
    powerDnsSecretRegistry: { materializeForServer: async () => ({ serverId, revision: 2, apiKey }) },
    localServerId: serverId,
    zoneManager,
    now,
  });
  return { calls, service, zone: currentZone };
}

test('DNS zone reapply previews current template diff with a monotonic SOA serial', async () => {
  const { service } = fixture();
  const preview = await service.preview({ domainId });

  assert.equal(preview.zoneName, 'example.com');
  assert.equal(preview.templateVersion, 2);
  assert.equal(preview.observedSerial, 2026091501);
  assert.equal(preview.nextSerial, 2026091601);
  assert.equal(preview.changeRequired, true);
  assert.equal(preview.applyAllowed, true);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.blockers.length, 0);
  assert.equal(preview.changes.some((entry) => entry.action === 'add' && entry.type === 'TXT'), true);
  assert.match(preview.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.confirmation, `reapply-dns-zone-template:${domainId}:${preview.previewDigest}`);
  assert.equal(Object.hasOwn(preview, 'apiKey'), false);
});

test('DNS zone reapply preserves unrelated manual RRsets', async () => {
  const manual = Object.freeze({
    name: 'custom.example.com.',
    type: 'A',
    ttl: 300,
    records: Object.freeze([{ content: '198.51.100.55', disabled: false }]),
    comments: Object.freeze([]),
    managed: null,
  });
  const { service } = fixture({ zone: liveZone({ extraRrsets: [manual] }) });
  const preview = await service.preview({ domainId });

  assert.equal(preview.applyAllowed, true);
  assert.equal(preview.preservedManualRrsetCount, 1);
  assert.equal(preview.conflicts.length, 0);
});

test('DNS zone reapply reports an explicit conflict instead of overwriting a manual RRset', async () => {
  const zone = liveZone();
  const rrsets = zone.rrsets.map((entry) => entry.type === 'A' && entry.name === 'example.com.'
    ? Object.freeze({ ...entry, comments: Object.freeze([]), managed: null })
    : entry);
  const { service } = fixture({ zone: Object.freeze({ ...zone, rrsets: Object.freeze(rrsets) }) });
  const preview = await service.preview({ domainId });

  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.conflicts.some((entry) => entry.code === 'manual_rrset_conflict' && entry.type === 'A'), true);
  assert.equal(preview.confirmation, null);
  await assert.rejects(
    service.apply({ domainId, previewDigest: preview.previewDigest, confirmation: 'anything' }),
    (error) => error instanceof DnsZoneReapplyError && error.code === 'dns_zone_reapply_manual_conflict',
  );
});

test('DNS zone reapply blocks mutation while an unreconciled mail-owned RRset exists', async () => {
  const mail = liveRrset({
    key: 'mail-dmarc', owner: '_dmarc.example.com', type: 'TXT', ttl: 300,
    values: ['v=DMARC1; p=none'], source: 'mail', templateVersion: null,
  });
  const { service } = fixture({ zone: liveZone({ extraRrsets: [mail] }) });
  const preview = await service.preview({ domainId });

  assert.equal(preview.changeRequired, true);
  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.blockers.some((entry) => entry.code === 'managed_source_not_reconciled' && entry.source === 'mail'), true);
  await assert.rejects(
    service.apply({ domainId, previewDigest: preview.previewDigest, confirmation: preview.confirmation }),
    (error) => error instanceof DnsZoneReapplyError && error.code === 'dns_zone_reapply_managed_source_blocked',
  );
});

test('DNS zone reapply applies only an exact current preview', async () => {
  const { calls, service } = fixture();
  const preview = await service.preview({ domainId });

  await assert.rejects(
    service.apply({ domainId, previewDigest: preview.previewDigest, confirmation: 'wrong' }),
    (error) => error instanceof DnsZoneReapplyError && error.code === 'dns_zone_reapply_confirmation_invalid',
  );
  assert.equal(calls.some((entry) => entry[0] === 'apply'), false);

  const result = await service.apply({
    domainId,
    previewDigest: preview.previewDigest,
    confirmation: preview.confirmation,
  });
  assert.equal(result.satisfied, true);
  assert.equal(result.serial, 2026091601);
  const applyCall = calls.find((entry) => entry[0] === 'apply');
  assert.ok(applyCall);
  assert.equal(applyCall[1].zoneName, 'example.com');
  assert.equal(applyCall[1].apiKey, apiKey);
  const soa = applyCall[1].records.find((entry) => entry.type === 'SOA');
  assert.match(soa.values[0], / 2026091601 /);
});

test('DNS zone reapply reports no-op when the live zone already matches current desired state', async () => {
  const currentTemplate = template(1);
  const { service } = fixture({ currentTemplate, zone: liveZone({ sourceTemplate: currentTemplate }) });
  const preview = await service.preview({ domainId });

  assert.equal(preview.noChanges, true);
  assert.equal(preview.changeRequired, false);
  assert.equal(preview.applyAllowed, false);
  assert.equal(preview.nextSerial, preview.observedSerial);
  assert.equal(preview.confirmation, null);
  await assert.rejects(
    service.apply({ domainId, previewDigest: preview.previewDigest, confirmation: null }),
    (error) => error instanceof DnsZoneReapplyError && error.code === 'dns_zone_reapply_no_changes',
  );
});
