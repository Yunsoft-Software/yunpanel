import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  validateOperationEnvelope,
} from '../src/index-extended.js';

const VALID = Object.freeze({
  provider: 'cloudflare',
  credentialId: '10714f5d-8646-4f9a-a8e9-b80439ff6305',
  dnsZoneId: '822fa920-166c-4a7a-a26b-476c81d82165',
  zoneName: 'example.test',
  action: 'upsert',
  record: Object.freeze({
    type: 'TXT',
    name: 'mail-2026._domainkey.example.test',
    content: `v=DKIM1; k=rsa; p=${Buffer.alloc(256, 3).toString('base64')}`,
    ttl: 300,
    proxied: false,
  }),
  expectedSnapshotDigest: 'a'.repeat(64),
});

function validate(payload) {
  return validateOperationEnvelope({
    id: 'dns-txt-operation-1',
    operation: OPERATIONS.DNS_RECORD_APPLY,
    payload,
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
}

test('extended protocol accepts canonical bounded TXT mutation envelopes', () => {
  const envelope = createOperationEnvelope({
    id: 'dns-txt-operation-1',
    operation: OPERATIONS.DNS_RECORD_APPLY,
    payload: VALID,
  });
  assert.deepEqual(envelope.payload, VALID);
  assert.equal(validate(VALID).ok, true);
});

test('TXT mutation rejects control characters, proxying, zone escape and oversized content', () => {
  for (const payload of [
    { ...VALID, record: { ...VALID.record, content: 'line1\nline2' } },
    { ...VALID, record: { ...VALID.record, proxied: true } },
    { ...VALID, record: { ...VALID.record, name: 'mail._domainkey.other.test' } },
    { ...VALID, record: { ...VALID.record, content: 'x'.repeat(4097) } },
    { ...VALID, record: { ...VALID.record, type: 'txt' } },
    { ...VALID, record: { ...VALID.record, ttl: 30 } },
  ]) assert.equal(validate(payload).ok, false);
});
