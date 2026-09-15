import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PowerDnsAuthoritativeManagerError,
  powerDnsAuthoritativeManagerInternals,
} from '../src/powerdns-authoritative-manager.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const apiKey = 'A'.repeat(43);

function intent(overrides = {}) {
  return {
    serverId,
    apiKey,
    apiKeyRevision: 2,
    secondaryDns: ['203.0.113.20', '2001:db8::20'],
    ...overrides,
  };
}

test('PowerDNS manager intent canonicalizes secondary targets and keeps secret private to host intent', () => {
  const normalized = powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({
    secondaryDns: ['203.0.113.20', '2001:db8::20'],
  }));
  assert.equal(normalized.serverId, serverId);
  assert.equal(normalized.apiKey, apiKey);
  assert.equal(normalized.apiKeyRevision, 2);
  assert.deepEqual(normalized.secondaryDns, ['2001:db8::20', '203.0.113.20']);
});

test('PowerDNS manager rejects malformed API keys and secondary DNS addresses', () => {
  assert.throws(
    () => powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({ apiKey: 'short' })),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_intent_invalid',
  );
  assert.throws(
    () => powerDnsAuthoritativeManagerInternals.normalizeIntent(intent({ secondaryDns: ['not-an-ip'] })),
    (error) => error instanceof PowerDnsAuthoritativeManagerError && error.code === 'powerdns_intent_invalid',
  );
});

test('PowerDNS manager requires vendor include-dir and parses package state deterministically', () => {
  assert.equal(
    powerDnsAuthoritativeManagerInternals.includeDirConfigured('include-dir=/etc/powerdns/pdns.d\n'),
    true,
  );
  assert.equal(
    powerDnsAuthoritativeManagerInternals.includeDirConfigured('include-dir=/tmp/not-managed\n'),
    false,
  );
  assert.deepEqual(
    powerDnsAuthoritativeManagerInternals.packageStatus('install ok installed\t4.8.3-1build2'),
    { installed: true, version: '4.8.3-1build2' },
  );
  assert.deepEqual(
    powerDnsAuthoritativeManagerInternals.packageStatus('deinstall ok config-files\t4.8.3'),
    { installed: false, version: null },
  );
});

test('PowerDNS managed config requires a non-trivial API key hash', () => {
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('api-key=$scrypt$example-hash-value\n'), '$scrypt$example-hash-value');
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('api-key=short\n'), null);
  assert.equal(powerDnsAuthoritativeManagerInternals.apiKeyHashFromConfig('webserver=yes\n'), null);
});
