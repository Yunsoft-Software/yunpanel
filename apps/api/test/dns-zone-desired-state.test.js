import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DnsZoneDesiredStateError,
  renderDnsZoneDesiredState,
} from '../src/dns-zone-desired-state.js';

const serverId = '11111111-1111-4111-8111-111111111111';

function identity({ ipv6 = null } = {}) {
  return {
    serverId,
    revision: 3,
    settings: {
      publicIpv4: '203.0.113.10',
      publicIpv6: ipv6,
      ns1: { hostname: 'ns1.host.example', ipv4: '203.0.113.10', ipv6, local: true },
      ns2: { hostname: 'ns2.host.example', ipv4: '203.0.113.11', ipv6: null, local: false },
      soa: {
        primaryNs: 'ns1.host.example',
        rname: 'hostmaster.host.example',
        refresh: 3600,
        retry: 900,
        expire: 1209600,
        minimum: 300,
        ttl: 300,
      },
    },
  };
}

function template(records = null) {
  return {
    serverId,
    version: 7,
    records: records ?? [
      { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
      { key: 'apex-ipv4', owner: '@', type: 'A', ttl: null, values: ['<server-ipv4>'], condition: 'always' },
      { key: 'apex-ipv6', owner: '@', type: 'AAAA', ttl: null, values: ['<server-ipv6>'], condition: 'ipv6' },
      { key: 'www-alias', owner: 'www', type: 'CNAME', ttl: null, values: ['<domain>'], condition: 'always' },
    ],
  };
}

test('renders SOA and template records with template snapshot metadata', () => {
  const desired = renderDnsZoneDesiredState({
    zoneName: 'Example.COM',
    template: template(),
    dnsIdentity: identity(),
    serial: 2026091501,
  });
  assert.equal(desired.zoneName, 'example.com');
  assert.equal(desired.templateVersion, 7);
  assert.equal(desired.dnsIdentityRevision, 3);
  assert.equal(desired.records[0].type, 'SOA');
  assert.equal(desired.records[0].source, 'template');
  assert.equal(desired.records.some((entry) => entry.type === 'AAAA'), false);
  assert.deepEqual(desired.records.find((entry) => entry.key === 'apex-nameservers').values, [
    'ns1.host.example',
    'ns2.host.example',
  ]);
  assert.equal(desired.records.find((entry) => entry.key === 'www-alias').owner, 'www.example.com');
});

test('adds service-aware local mail records only for enabled services', () => {
  const desired = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: template(),
    dnsIdentity: identity({ ipv6: '2001:db8::10' }),
    serial: 2026091502,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      webmailEnabled: true,
      webmailHost: 'webmail.example.com',
      imaps: true,
      smtps: true,
      dkim: { selector: 'default', value: 'v=DKIM1; k=rsa; p=abc123' },
    },
  });
  const keys = new Set(desired.records.map((entry) => entry.key));
  for (const key of [
    'mail-ipv4', 'mail-ipv6', 'mail-mx', 'mail-spf', 'mail-dmarc',
    'webmail-ipv4', 'webmail-ipv6', 'mail-imaps', 'mail-submissions', 'mail-dkim-default',
  ]) assert.equal(keys.has(key), true, key);
  assert.equal(desired.records.find((entry) => entry.key === 'mail-mx').source, 'mail');
});

test('skips template mail placeholders when local mail or webmail is disabled', () => {
  const custom = template([
    { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
    { key: 'mail-target', owner: 'mail', type: 'CNAME', ttl: null, values: ['<mail-host>'], condition: 'always' },
    { key: 'webmail-target', owner: 'webmail', type: 'CNAME', ttl: null, values: ['<webmail-host>'], condition: 'always' },
  ]);
  const desired = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: custom,
    dnsIdentity: identity(),
    serial: 2026091503,
  });
  assert.equal(desired.records.some((entry) => entry.key === 'mail-target'), false);
  assert.equal(desired.records.some((entry) => entry.key === 'webmail-target'), false);
});

test('fails closed when template and service ownership collide on one RRset', () => {
  const custom = template([
    { key: 'apex-nameservers', owner: '@', type: 'NS', ttl: null, values: ['<ns1>', '<ns2>'], condition: 'always' },
    { key: 'custom-mx', owner: '@', type: 'MX', ttl: null, values: ['20 mx.external.example'], condition: 'always' },
  ]);
  assert.throws(() => renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: custom,
    dnsIdentity: identity(),
    serial: 2026091504,
    mail: { enabled: true, host: 'mail.example.com' },
  }), (error) => error instanceof DnsZoneDesiredStateError && error.code === 'dns_zone_source_conflict');
});
