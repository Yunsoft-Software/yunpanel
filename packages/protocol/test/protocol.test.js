import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  OPERATIONS,
  createOperationEnvelope,
  isKnownOperation,
  isReadOnlyOperation,
  validateOperationEnvelope,
} from '../src/index.js';

test('known operations are explicitly allowlisted', () => {
  assert.equal(isKnownOperation(OPERATIONS.SERVER_INSPECT), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SERVER_INSPECT), true);
  assert.equal(isKnownOperation(OPERATIONS.SERVER_DOCKER), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SERVER_DOCKER), true);
  assert.equal(isKnownOperation(OPERATIONS.SERVER_NGINX), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SERVER_NGINX), true);
  assert.equal(isKnownOperation(OPERATIONS.DOMAIN_STAGE), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.DOMAIN_STAGE), false);
  assert.equal(isKnownOperation(OPERATIONS.SSL_ISSUE), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SSL_ISSUE), false);
  assert.equal(isKnownOperation(OPERATIONS.SSL_RENEW), true);
  assert.equal(isReadOnlyOperation(OPERATIONS.SSL_RENEW), false);
  assert.equal(isKnownOperation('shell.exec'), false);
  assert.equal(isReadOnlyOperation('shell.exec'), false);
});

test('validates operation envelopes', () => {
  const envelope = createOperationEnvelope({
    id: 'request-0001',
    operation: OPERATIONS.SERVER_INSPECT,
    payload: {},
  });

  assert.equal(envelope.protocolVersion, AGENT_PROTOCOL_VERSION);
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
});

test('rejects arbitrary operations', () => {
  const result = validateOperationEnvelope({
    id: 'request-0002',
    operation: 'shell.exec',
    payload: { command: 'whoami' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /not allowed/);
});

test('validates domain mutation payloads before they reach the agent handler', () => {
  const validStage = validateOperationEnvelope({
    id: 'request-0003',
    operation: OPERATIONS.DOMAIN_STAGE,
    payload: {
      primaryDomain: 'example.com',
      aliases: ['www.example.com'],
      targetType: 'proxy',
      target: { upstreamPort: 3000 },
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validStage.ok, true);

  const invalidActivation = validateOperationEnvelope({
    id: 'request-0004',
    operation: OPERATIONS.DOMAIN_ACTIVATE,
    payload: { primaryDomain: 'example.com', checksum: '../bad' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(invalidActivation.ok, false);
  assert.match(invalidActivation.errors.join(' '), /SHA-256/);
});

test('validates certificate issue and renewal payloads', () => {
  const validIssue = validateOperationEnvelope({
    id: 'request-0005',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['example.com', 'www.example.com'],
      email: 'admin@example.com',
      staging: true,
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validIssue.ok, true);

  const wildcardIssue = validateOperationEnvelope({
    id: 'request-0006',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['*.example.com'],
      email: 'admin@example.com',
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(wildcardIssue.ok, false);

  const badEmail = validateOperationEnvelope({
    id: 'request-0007',
    operation: OPERATIONS.SSL_ISSUE,
    payload: {
      domains: ['example.com'],
      email: 'not-an-email',
    },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(badEmail.ok, false);

  const validRenew = validateOperationEnvelope({
    id: 'request-0008',
    operation: OPERATIONS.SSL_RENEW,
    payload: { certName: 'example.com', dryRun: true },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.equal(validRenew.ok, true);
});
