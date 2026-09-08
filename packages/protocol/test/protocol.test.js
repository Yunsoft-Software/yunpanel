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
