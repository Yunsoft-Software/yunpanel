import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authoritativePresentation,
  delegationPresentation,
  dnsIdentityDraft,
  dnsIdentitySettings,
} from '../src/workspace/network-dns-model.js';

const identity = {
  settings: {
    publicIpv4: '203.0.113.10', publicIpv6: null,
    ns1: { hostname: 'ns1.example.net', ipv4: '203.0.113.10', ipv6: null, local: true },
    ns2: { hostname: 'ns2.example.net', ipv4: '203.0.113.11', ipv6: null, local: false },
    soa: { primaryNs: 'ns1.example.net', rname: 'hostmaster.example.net', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
    dnssecDefault: true,
    secondaryDns: ['203.0.113.11'],
  },
};

test('Network DNS model creates an editable draft without inventing missing server identity', () => {
  assert.deepEqual(dnsIdentityDraft(identity), {
    publicIpv4: '203.0.113.10', publicIpv6: '',
    ns1: { hostname: 'ns1.example.net', ipv4: '203.0.113.10', ipv6: '', local: true },
    ns2: { hostname: 'ns2.example.net', ipv4: '203.0.113.11', ipv6: '', local: false },
    soa: { rname: 'hostmaster.example.net', refresh: '3600', retry: '900', expire: '1209600', minimum: '300', ttl: '300' },
    dnssecDefault: true,
    secondaryDns: '203.0.113.11',
  });
  const empty = dnsIdentityDraft(null);
  assert.equal(empty.publicIpv4, '');
  assert.equal(empty.ns1.hostname, '');
  assert.equal(empty.soa.refresh, '3600');
});

test('Network DNS model serializes canonical settings and preserves explicit local/external nameserver policy', () => {
  const draft = dnsIdentityDraft(identity);
  const settings = dnsIdentitySettings(draft);
  assert.deepEqual(settings, {
    publicIpv4: '203.0.113.10', publicIpv6: null,
    ns1: { hostname: 'ns1.example.net', ipv4: '203.0.113.10', ipv6: null, local: true },
    ns2: { hostname: 'ns2.example.net', ipv4: '203.0.113.11', ipv6: null, local: false },
    soa: { rname: 'hostmaster.example.net', refresh: 3600, retry: 900, expire: 1209600, minimum: 300, ttl: 300 },
    dnssecDefault: true,
    secondaryDns: ['203.0.113.11'],
  });
});

test('Network DNS model blocks missing primary identity and duplicate secondary targets before API preview', () => {
  const missing = dnsIdentityDraft(identity);
  missing.publicIpv4 = '';
  assert.throws(() => dnsIdentitySettings(missing), /Public IPv4/);
  const badNs1 = dnsIdentityDraft(identity);
  badNs1.ns1.local = false;
  assert.throws(() => dnsIdentitySettings(badNs1), /ns1 yerel/);
  const duplicate = dnsIdentityDraft(identity);
  duplicate.secondaryDns = '203.0.113.20\n203.0.113.20';
  assert.throws(() => dnsIdentitySettings(duplicate), /tekrar etmemeli/);
});

test('Network DNS status presentation never confuses local PowerDNS health with delegation readiness', () => {
  assert.deepEqual(authoritativePresentation({ configured: true, ready: true }), { state: 'active', label: 'Local authoritative hazır' });
  assert.equal(authoritativePresentation({ configured: false, ready: false }).state, 'off');
  assert.equal(authoritativePresentation({ configured: true, ready: false, reason: 'powerdns_tcp_unavailable' }).state, 'warning');
  assert.deepEqual(delegationPresentation('ready'), { state: 'active', label: 'Delegation hazır' });
  assert.equal(delegationPresentation('pending_glue').state, 'warning');
  assert.equal(delegationPresentation('pending_delegation').state, 'pending');
  assert.equal(delegationPresentation('unverifiable').state, 'warning');
});
