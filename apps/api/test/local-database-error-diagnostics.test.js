import assert from 'node:assert/strict';
import test from 'node:test';
import { safeLocalOperationError } from '../src/local-execution-error.js';

const databaseCodes = [
  'invalid_database_name',
  'database_connection_invalid',
  'database_connection_unavailable',
  'database_inventory_invalid',
  'database_inventory_failed',
  'database_operation_in_progress',
  'database_exists',
  'database_create_failed',
  'database_create_unconfirmed',
  'database_not_found',
  'database_drop_failed',
  'database_drop_unconfirmed',
];

test('database host errors keep only authored safe diagnostics', () => {
  for (const code of databaseCodes) {
    const result = safeLocalOperationError({
      code,
      message: 'PASSWORD=PRIVATE socket=/var/run/private.sock SQL=DROP SECRET',
      stdout: 'PRIVATE',
      stderr: '/private/path',
      command: 'mysql --password=PRIVATE',
    });
    assert.equal(result.code, code);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'message']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|\/private|password|socket=|SQL=/i);
  }
});
