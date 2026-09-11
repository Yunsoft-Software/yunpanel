import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_PROTOCOL_VERSION, createOperationEnvelope, OPERATIONS, validateOperationEnvelope } from '../src/index.js';

const VALID = {
  provider: 'cloudflare',
  credentialId: '10714f5d-8646-4f9a-a8e9-b80439ff6305',
  dnsZoneId: '822fa920-166c-4a7a-a26b-476c81d82165',
  zoneName: 'example.test',
  action: 'upsert',
  record: { type: 'AAAA', name: 'app.example.test', content: '2001:db8::10', ttl: 300, proxied: false },
  expectedSnapshotDigest: 'a'.repeat(64),
};

function validate(payload) {
  return validateOperationEnvelope({
    id: 'dns-operation-1', operation: OPERATIONS.DNS_RECORD_APPLY, payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
}

test('DNS record mutation has one canonical provider-bound protocol envelope', () => {
  const envelope = createOperationEnvelope({ id: 'dns-operation-1', operation: OPERATIONS.DNS_RECORD_APPLY, payload: VALID });
  assert.deepEqual(envelope.payload, VALID);
  assert.equal(validate(VALID).ok, true);
});

test('DNS record protocol rejects drift, zone escape and noncanonical data', () => {
  for (const payload of [
    { ...VALID, provider: 'other' },
    { ...VALID, action: 'replace' },
    { ...VALID, extra: true },
    { ...VALID, expectedSnapshotDigest: '../unsafe' },
    { ...VALID, record: { ...VALID.record, name: 'lookalike-example.test' } },
    { ...VALID, record: { ...VALID.record, content: '2001:0db8::10' } },
    { ...VALID, record: { ...VALID.record, ttl: 30 } },
    { ...VALID, record: { ...VALID.record, ttl: 300, proxied: true } },
  ]) assert.equal(validate(payload).ok, false);
});
