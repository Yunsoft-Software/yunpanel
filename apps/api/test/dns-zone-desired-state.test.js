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

test('renders actual STARTTLS endpoints and current plus retiring DKIM records for a shared mail identity', () => {
  const desired = renderDnsZoneDesiredState({
    zoneName: 'customer.example',
    template: template(),
    dnsIdentity: identity(),
    serial: 2026091503,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      imap: true,
      submission: true,
      dkimRecords: [
        { selector: 'current', value: 'v=DKIM1; k=rsa; p=current' },
        { selector: 'previous', value: 'v=DKIM1; k=rsa; p=previous' },
      ],
    },
  });
  const byKey = new Map(desired.records.map((entry) => [entry.key, entry]));

  assert.deepEqual(byKey.get('mail-mx').values, ['10 mail.example.com']);
  assert.deepEqual(byKey.get('mail-imap').values, ['0 1 143 mail.example.com']);
  assert.deepEqual(byKey.get('mail-submission').values, ['0 1 587 mail.example.com']);
  assert.equal(byKey.has('mail-ipv4'), false);
  assert.equal(byKey.has('webmail-ipv4'), false);
  assert.equal(byKey.has('mail-dkim-current'), true);
  assert.equal(byKey.has('mail-dkim-previous'), true);
});

test('publishes discovery hostnames only from exact HTTPS endpoint readiness evidence', () => {
  const desired = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: template(),
    dnsIdentity: identity({ ipv6: '2001:db8::10' }),
    serial: 2026091504,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      autodiscoverEnabled: true,
      autoconfigEnabled: true,
      discovery: {
        revision: 5,
        autodiscover: {
          hostname: 'autodiscover.example.com',
          protocol: 'https',
          path: '/autodiscover/autodiscover.xml',
        },
        autoconfig: null,
      },
    },
  });
  const keys = new Set(desired.records.map((entry) => entry.key));

  assert.equal(keys.has('mail-autodiscover-ipv4'), true);
  assert.equal(keys.has('mail-autodiscover-ipv6'), true);
  assert.equal(keys.has('mail-autoconfig-ipv4'), false);
  assert.equal(keys.has('mail-autoconfig-ipv6'), false);
});

test('legacy discovery booleans cannot publish dead records and invalid endpoint evidence fails closed', () => {
  const withoutEvidence = renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: template(),
    dnsIdentity: identity(),
    serial: 2026091505,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      autodiscoverEnabled: true,
      autoconfigEnabled: true,
    },
  });
  assert.equal(withoutEvidence.records.some((entry) => entry.key.includes('autodiscover')), false);
  assert.equal(withoutEvidence.records.some((entry) => entry.key.includes('autoconfig')), false);

  assert.throws(() => renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: template(),
    dnsIdentity: identity(),
    serial: 2026091506,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      discovery: {
        revision: 6,
        autodiscover: null,
        autoconfig: {
          hostname: 'autoconfig.example.com',
          protocol: 'https',
          path: '/wrong',
        },
      },
    },
  }), (error) => error instanceof DnsZoneDesiredStateError
    && error.code === 'dns_zone_mail_discovery_invalid');
});

test('rejects duplicate DKIM selector intent before rendering an ambiguous managed RRset', () => {
  assert.throws(() => renderDnsZoneDesiredState({
    zoneName: 'example.com',
    template: template(),
    dnsIdentity: identity(),
    serial: 2026091504,
    mail: {
      enabled: true,
      host: 'mail.example.com',
      dkimRecords: [
        { selector: 'same', value: 'v=DKIM1; k=rsa; p=one' },
        { selector: 'same', value: 'v=DKIM1; k=rsa; p=two' },
      ],
    },
  }), (error) => error instanceof DnsZoneDesiredStateError && error.code === 'dns_zone_dkim_invalid');
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
