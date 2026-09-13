import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';

const serverId = '12345678-1234-4234-8234-123456789012';
const credentialId = '22345678-1234-4234-8234-123456789012';
const bindingId = '32345678-1234-4234-8234-123456789012';
const username = `ydb_${createHash('sha256').update(bindingId).digest('hex').slice(0, 24)}`;
const digest = 'a'.repeat(64);

function payload() {
  return {
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    expectedCredentialRevision: 3,
    expectedBindingRevision: 1,
    desiredStateSha256: digest,
  };
}

function result(operation, overrides = {}) {
  return {
    version: 1,
    databaseCredentialId: credentialId,
    databaseBindingId: bindingId,
    credentialRevision: 3,
    bindingRevision: 1,
    databaseName: 'app_main',
    username,
    host: 'localhost',
    desiredStateSha256: digest,
    [operation === OPERATIONS.DATABASE_CREDENTIAL_APPLY ? 'applied' : 'deleted']: true,
    sideEffects: true,
    ...overrides,
  };
}

async function queue(registry, operation) {
  return registry.enqueue({
    serverId,
    type: operation,
    operation,
    payload: payload(),
    resourceType: 'database',
    resourceId: 'app_main',
    idempotencyKey: `${operation}:${credentialId}:${digest}`,
  });
}

for (const operation of [OPERATIONS.DATABASE_CREDENTIAL_APPLY, OPERATIONS.DATABASE_CREDENTIAL_DELETE]) {
  test(`${operation} durably enqueues, claims and completes with secret-free exact evidence`, async () => {
    const registry = createJobRegistry();
    const queued = await queue(registry, operation);
    assert.equal(queued.status, 'queued');
    const claimed = await registry.claimNext(serverId);
    assert.equal(claimed.job.id, queued.id);
    assert.equal(claimed.envelope.operation, operation);
    assert.deepEqual(claimed.envelope.payload, payload());

    const terminal = await registry.complete({
      serverId,
      jobId: queued.id,
      status: 'succeeded',
      result: result(operation),
    });
    assert.equal(terminal.status, 'succeeded');
    assert.equal(terminal.result.username, username);
    assert.equal(terminal.result.databaseName, 'app_main');
    assert.doesNotMatch(JSON.stringify(terminal.result), /password|ciphertext|GRANT |CREATE USER/);
  });
}

test('database credential completion rejects mismatched or private result fields', async () => {
  for (const badResult of [
    result(OPERATIONS.DATABASE_CREDENTIAL_APPLY, { credentialRevision: 4 }),
    result(OPERATIONS.DATABASE_CREDENTIAL_APPLY, { desiredStateSha256: 'b'.repeat(64) }),
    result(OPERATIONS.DATABASE_CREDENTIAL_APPLY, { databaseName: 'other_db' }),
    result(OPERATIONS.DATABASE_CREDENTIAL_APPLY, { username: 'ydb_ffffffffffffffffffffffff' }),
    result(OPERATIONS.DATABASE_CREDENTIAL_APPLY, { password: 'forbidden' }),
  ]) {
    const registry = createJobRegistry();
    const queued = await queue(registry, OPERATIONS.DATABASE_CREDENTIAL_APPLY);
    await registry.claimNext(serverId);
    await assert.rejects(
      registry.complete({ serverId, jobId: queued.id, status: 'succeeded', result: badResult }),
      (error) => error instanceof JobRegistryError && error.code === 'invalid_job_result',
    );
  }
});

test('database credential jobs share the existing database resource lock', async () => {
  const registry = createJobRegistry();
  await registry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_CREATE,
    operation: OPERATIONS.DATABASE_CREATE,
    payload: { name: 'app_main' },
    resourceType: 'database',
    resourceId: 'app_main',
  });
  await assert.rejects(
    queue(registry, OPERATIONS.DATABASE_CREDENTIAL_APPLY),
    (error) => error instanceof JobRegistryError && error.code === 'database_job_conflict' && error.status === 409,
  );
});
