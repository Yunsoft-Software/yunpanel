import test from 'node:test';
import assert from 'node:assert/strict';
import { safeLocalOperationError } from '../src/local-execution-error.js';
import { createLocalJobExecutor, localExecutorInternals } from '../src/local-job-executor.js';

test('known diagnostics preserve the code, never the original message or attached output', () => {
  const result = safeLocalOperationError({ code: 'certbot_failed', message: 'API_KEY=PRIVATE', stdout: 'PRIVATE', stderr: 'PRIVATE', command: 'PRIVATE' });
  assert.equal(result.code, 'certbot_failed');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('Node, environment and managed-service diagnostics use authored messages only', () => {
  for (const code of [
    'node_deployment_command_failed',
    'node_restart_restore_failed',
    'node_rollback_health_failed',
    'secret_decryption_failed',
    'invalid_environment_bundle',
    'managed_service_install_failed',
    'managed_service_conflict',
  ]) {
    const result = safeLocalOperationError({
      code,
      message: 'API_TOKEN=PRIVATE /etc/private/key',
      stdout: 'PRIVATE',
      stderr: 'PRIVATE',
    });
    assert.equal(result.code, code);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'message']);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.ok(!JSON.stringify(result).includes('/etc/private'));
  }
});

test('unknown codes and native error shapes cannot disclose arbitrary strings', () => {
  for (const code of ['private_token_value', 'token=PRIVATE', 'constructor', '__proto__', 'toString', 1, null, undefined]) {
    const result = safeLocalOperationError({ code, message: 'PRIVATE' });
    assert.equal(result.code, 'local_operation_failed');
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('operating-system failures have safe actionable descriptions without paths', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT']) {
    const result = safeLocalOperationError({ code, path: '/private/key', message: 'secret' });
    assert.equal(result.code, code);
    assert.ok(!JSON.stringify(result).includes('/private'));
  }
});

test('error objects with throwing getters or arbitrary thrown values are safe', () => {
  const error = Object.defineProperties({}, {
    code: { get() { throw new Error('PRIVATE'); } },
    message: { get() { throw new Error('must never read'); } },
  });
  for (const value of [error, null, undefined, 'PRIVATE', 1, Symbol('PRIVATE')]) {
    assert.equal(safeLocalOperationError(value).code, 'local_operation_failed');
  }
});

test('the executor persists and reconciles only the sanitized diagnostic', async () => {
  const id = '12345678-1234-4234-8234-123456789012'; const serverId = 'local';
  const job = { id, serverId, operation: 'ssl.issue', status: 'running' };
  let persisted; let reconciled;
  const executor = createLocalJobExecutor({ serverId,
    jobRegistry: {
      claimNext: async () => ({ job, envelope: { id, operation: job.operation, payload: {} } }),
      complete: async input => { persisted = input; return { ...job, status: input.status, error: input.error }; },
    },
    executeOperation: async () => { throw Object.assign(new Error('PRIVATE_CERTBOT_OUTPUT'), { code: 'certbot_failed', stderr: 'PRIVATE_TOKEN' }); },
    reconcileCompletedJob: async terminal => { reconciled = terminal; },
  });
  const result = await executor.runOnce();
  assert.equal(result.job.status, 'failed');
  assert.equal(persisted.error.code, 'certbot_failed');
  assert.ok(!JSON.stringify([persisted, reconciled, result]).includes('PRIVATE'));
});

test('returned objects cannot mutate the shared diagnostic catalog', () => {
  const result = safeLocalOperationError({ code: 'ENOSPC' }); result.message = 'injected';
  assert.notEqual(safeLocalOperationError({ code: 'ENOSPC' }).message, 'injected');
  assert.equal(localExecutorInternals.safeExecutionError, safeLocalOperationError);
});
