import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { OPERATIONS } from '@yunpanel/protocol';
import { createJobRegistry, JobRegistryError } from '../src/jobs/job-registry.js';

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

function panelAuthorization(overrides = {}) {
  return {
    actorId: 'owner-user-a',
    userId: 'owner-user-a',
    sessionId: 'session-a',
    role: 'owner',
    websiteId: '42345678-1234-4234-8234-123456789012',
    ...overrides,
  };
}

function queueDeleteAs(registry, authorization) {
  return registry.enqueue({
    serverId,
    type: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    operation: OPERATIONS.DATABASE_CREDENTIAL_DELETE,
    payload: payload(),
    resourceType: 'database',
    resourceId: 'app_main',
    idempotencyKey: `${OPERATIONS.DATABASE_CREDENTIAL_DELETE}:${credentialId}:${digest}`,
    authorization,
  });
}

test('database credential delete idempotency ignores only the session of the same user, role and Website', async () => {
  const registry = createJobRegistry();
  const queued = await queueDeleteAs(registry, panelAuthorization());
  await registry.claimNext(serverId);
  await registry.complete({ serverId, jobId: queued.id, status: 'succeeded', result: result(OPERATIONS.DATABASE_CREDENTIAL_DELETE) });

  const resumed = await queueDeleteAs(registry, panelAuthorization({ sessionId: 'session-b' }));
  assert.equal(resumed.id, queued.id);
  assert.equal(resumed.status, 'succeeded');

  for (const other of [
    panelAuthorization({ actorId: 'owner-user-b', userId: 'owner-user-b', sessionId: 'session-c' }),
    panelAuthorization({ userId: 'owner-user-b', sessionId: 'session-c' }),
    panelAuthorization({ role: 'site_manager', sessionId: 'session-c' }),
    panelAuthorization({ websiteId: '52345678-1234-4234-8234-123456789012', sessionId: 'session-c' }),
    { actorId: 'owner-user-a', userId: 'owner-user-a', role: 'owner', websiteId: panelAuthorization().websiteId },
  ]) {
    await assert.rejects(
      queueDeleteAs(registry, other),
      (error) => error instanceof JobRegistryError && error.code === 'job_authorization_conflict' && error.status === 409,
    );
  }
});

test('a retried database credential job runs with the new session of the same user', async () => {
  const registry = createJobRegistry({ retryBackoffBaseMs: 0 });
  const queued = await queueDeleteAs(registry, panelAuthorization());
  await registry.claimNext(serverId);
  await registry.complete({ serverId, jobId: queued.id, status: 'failed',
    error: { code: 'database_connection_unavailable', message: 'Database is unavailable' } });

  const retried = await queueDeleteAs(registry, panelAuthorization({ sessionId: 'session-b' }));
  assert.equal(retried.id, queued.id);
  assert.equal(retried.status, 'queued');
  const claimed = await registry.claimNext(serverId);
  assert.equal(claimed.job.id, queued.id);
  assert.equal(claimed.authorization.sessionId, 'session-b');
  assert.equal(claimed.authorization.actorId, 'owner-user-a');
});
