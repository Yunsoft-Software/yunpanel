import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_PROTOCOL_VERSION,
  createOperationEnvelope,
  isReadOnlyOperation,
  OPERATIONS,
  validateOperationEnvelope,
} from '../src/index.js';

const id = '12345678-1234-4234-8234-123456789012';

function validate(operation, payload) {
  return validateOperationEnvelope({ id, operation, payload, protocolVersion: AGENT_PROTOCOL_VERSION });
}

test('database inspection is an explicit read-only operation with no arguments', () => {
  assert.equal(isReadOnlyOperation(OPERATIONS.DATABASE_INSPECT), true);
  assert.equal(validate(OPERATIONS.DATABASE_INSPECT, {}).ok, true);
  assert.equal(validate(OPERATIONS.DATABASE_INSPECT, { name: 'app_main' }).ok, false);
});

test('database create and delete accept only bounded safe non-system names', () => {
  for (const operation of [OPERATIONS.DATABASE_CREATE, OPERATIONS.DATABASE_DELETE]) {
    assert.equal(validate(operation, { name: 'customer_42' }).ok, true);
    for (const name of ['mysql', 'information_schema', 'performance_schema', 'sys', '../etc', 'db-name', 'db;drop', '', 'a'.repeat(65)]) {
      assert.equal(validate(operation, { name }).ok, false, `${operation} accepted ${name}`);
    }
    assert.equal(validate(operation, { name: 'safe_db', extra: true }).ok, false);
  }
});

test('database operation envelopes preserve only the validated payload contract', () => {
  assert.deepEqual(createOperationEnvelope({ id, operation: OPERATIONS.DATABASE_CREATE, payload: { name: 'app_main' } }), {
    id,
    operation: OPERATIONS.DATABASE_CREATE,
    payload: { name: 'app_main' },
    protocolVersion: AGENT_PROTOCOL_VERSION,
  });
  assert.throws(
    () => createOperationEnvelope({ id, operation: OPERATIONS.DATABASE_DELETE, payload: { name: 'mysql' } }),
    /database\.delete name is invalid/,
  );
});
