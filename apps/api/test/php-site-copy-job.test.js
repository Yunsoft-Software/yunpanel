import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createOperationEnvelope, isKnownOperation, OPERATIONS, validateOperationEnvelope } from '@yunpanel/protocol';
import { createAuthStore } from '../src/auth-store.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry, jobPublicView } from '../src/job-registry.js';
import { createLocalHostOperations } from '../src/local-host-operations.js';

const operation = OPERATIONS.WEBSITE_PHP_COPY;
const maxBytes = 16 * 1024 * 1024;

function requestFor(session = { id: randomUUID(), user: { id: randomUUID() } }) {
  const serverId = randomUUID();
  const payload = { websiteId: randomUUID(), applicationId: randomUUID(),
    targetWebsiteId: randomUUID(), targetApplicationId: randomUUID(), actorSessionId: session.id,
    actorUserId: session.user.id, actorRole: 'owner', previewDigest: 'a'.repeat(64) };
  const authorization = { kind: 'panel', scope: 'website', serverId, websiteId: payload.websiteId,
    actorId: payload.actorUserId, userId: payload.actorUserId, sessionId: payload.actorSessionId, role: 'owner' };
  return { serverId, type: operation, operation, resourceType: 'application', resourceId: payload.applicationId,
    payload, authorization, idempotencyKey: `website.php.copy:${randomUUID()}` };
}

function resultFor(payload, counts) {
  return { sourceWebsiteId: payload.websiteId, targetWebsiteId: payload.targetWebsiteId, digest: payload.previewDigest, ...counts };
}

async function store(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yp-php-copy-job-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const filePath = path.join(directory, 'jobs.json');
  return { directory, filePath, registry: createJobRegistry({ filePath }) };
}

test('PHP copy has an exact Owner-only protocol envelope', () => {
  assert.equal(operation, 'website.php.copy');
  assert.equal(isKnownOperation(operation), true);
  const { payload } = requestFor();
  const envelope = createOperationEnvelope({ id: randomUUID(), operation, payload });
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
  for (const fields of [
    { actorRole: 'reseller' }, { actorSessionId: null }, { targetWebsiteId: payload.websiteId.toUpperCase() },
    { targetApplicationId: payload.applicationId }, { previewDigest: 'x'.repeat(64) }, { privateConnection: {} },
  ]) {
    assert.equal(validateOperationEnvelope({ ...envelope, payload: { ...payload, ...fields } }).ok, false);
  }
  assert.equal(validateOperationEnvelope({ ...envelope, protocolVersion: -1 }).ok, false);
});

test('PHP copy persists one Owner job and exposes only the bounded counts', async (t) => {
  const { filePath, registry } = await store(t);
  const request = requestFor();
  const { payload, authorization, serverId } = request;
  for (const changed of [
    null, { ...authorization, websiteId: payload.targetWebsiteId }, { ...authorization, role: 'customer' },
    { ...authorization, actorId: randomUUID() }, { ...authorization, serverId: randomUUID() },
  ]) {
    await assert.rejects(registry.enqueue({ ...request, authorization: changed }), { code: 'job_authorization_required' });
  }
  await assert.rejects(registry.enqueue({ ...request, resourceId: payload.targetApplicationId }), { code: 'invalid_resource_id' });
  await assert.rejects(registry.enqueue({ ...request, payload: { ...payload, secret: true } }), { code: 'invalid_operation_payload' });
  const job = await registry.enqueue(request);
  assert.equal((await registry.enqueue(request)).id, job.id);
  const reopened = createJobRegistry({ filePath });
  assert.equal(await reopened.claimNext(randomUUID()), null);
  const claim = await reopened.claimNext(serverId);
  assert.equal(claim.job.id, job.id);
  assert.deepEqual(claim.envelope.payload, payload);

  const completion = { serverId, jobId: job.id, status: 'succeeded' };
  const counts = { filesCopied: 1, bytesCopied: maxBytes, tablesCopied: 256, databaseBytes: maxBytes };
  const result = resultFor(payload, counts);
  for (const changed of [
    { sourceWebsiteId: randomUUID() }, { targetWebsiteId: randomUUID() }, { digest: 'b'.repeat(64) },
    { filesCopied: 0 }, { filesCopied: 2 }, { bytesCopied: 0 }, { bytesCopied: maxBytes + 1 },
    { tablesCopied: 0 }, { tablesCopied: 257 }, { tablesCopied: 1.5 },
    { databaseBytes: 0 }, { databaseBytes: maxBytes + 1 }, { databaseBytes: '20' },
  ]) {
    await assert.rejects(reopened.complete({ ...completion, result: { ...result, ...changed } }), { code: 'invalid_job_result' });
  }
  const completed = await reopened.complete({ ...completion, result });
  assert.deepEqual(jobPublicView(completed).result, counts);
  assert.equal(jobPublicView(completed).payload, undefined);
  const { jobs: [stored] } = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(stored.result, counts);
  const raw = { ...stored, result: { ...result, privateHome: '/test/private-home', username: 'private-identity' } };
  assert.deepEqual(jobPublicView(raw).result, counts);
  assert.equal(jobPublicView({ ...raw, result: { ...raw.result, tablesCopied: 257 } }).result, null);
});

test('failed and interrupted PHP copies cannot be replayed by the generic queue', async (t) => {
  const { filePath, registry } = await store(t);
  const request = requestFor();
  const { id } = await registry.enqueue(request);
  await registry.claimNext(request.serverId);
  const durable = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await durable.init();
  assert.equal(durable.recovery().jobs[0].jobId, id);
  await assert.rejects(durable.claimNext(request.serverId), { code: 'durable_job_reconciliation_required' });
  assert.equal((await durable.getJob(id)).status, 'running');

  await registry.complete({ serverId: request.serverId, jobId: id, status: 'failed',
    error: { code: 'site_mutation_locked', message: 'Site lock held' } });
  const reopened = createJobRegistry({ filePath });
  const duplicate = await reopened.enqueue(request);
  assert.equal(duplicate.id, id);
  assert.equal(duplicate.status, 'failed');
  assert.equal(duplicate.attempts, 1);
  assert.equal(duplicate.manualRetryAllowed, false);
  await assert.rejects(reopened.enqueue({ ...request, manualRetry: true }), { code: 'job_not_retryable' });
  await assert.rejects(reopened.retryJob({ jobId: id, authorization: request.authorization }), { code: 'job_not_retryable' });
  assert.equal(await reopened.claimNext(request.serverId), null);
});

test('only the valid queued Owner authority reaches the local PHP copy callback', async (t) => {
  const { directory, registry } = await store(t);
  const auth = createAuthStore({ filePath: path.join(directory, 'auth.sqlite') });
  t.after(() => auth.close());
  const password = randomBytes(32).toString('base64url');
  await auth.completeSetup({ setupToken: auth.issueSetupToken().token, username: 'admin', password });
  const login = await auth.login({ username: 'admin', password });
  const request = requestFor(login.session);
  const { payload, serverId, resourceType, resourceId } = request;
  await registry.enqueue(request);
  const claim = await registry.claimNext(serverId);
  const execution = { jobId: claim.job.id, serverId, resourceType, resourceId, authorization: claim.authorization };
  const sourceFile = path.join(directory, 'index.php');
  const sourceDb = path.join(directory, 'data.sqlite');
  await fs.writeFile(sourceFile, '<?php echo "YunPanel";');
  const db = new DatabaseSync(sourceDb);
  t.after(() => db.close());
  db.exec('CREATE TABLE entries (id INTEGER PRIMARY KEY)');
  const readback = [];
  const handlers = createLocalHostOperations({
    authorizePanelJob({ sessionId, userId }) {
      const session = auth.getSessionById(sessionId);
      return session?.user.id === userId && session.user.role === 'owner';
    },
    websitePhpCopyOperation: { async execute(input, context) {
      readback.push({ input, context });
      const { count } = db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get();
      return resultFor(input, { filesCopied: 1, bytesCopied: (await fs.stat(sourceFile)).size,
        tablesCopied: count, databaseBytes: (await fs.stat(sourceDb)).size });
    } },
  });
  assert.equal(createLocalHostOperations().supports(operation), false);
  assert.equal(handlers.supports(operation), true);
  await assert.rejects(handlers.executeOperation(operation, { ...payload, connectionFile: sourceFile }, execution),
    { code: 'invalid_local_operation_payload' });
  for (const invalid of [{ authorization: null }, { resourceId: payload.targetApplicationId },
    { authorization: { ...execution.authorization, websiteId: payload.targetWebsiteId } }]) {
    await assert.rejects(handlers.executeOperation(operation, payload, { ...execution, ...invalid }),
      { code: 'panel_job_actor_forbidden' });
  }
  assert.equal(readback.length, 0);
  const result = await handlers.executeOperation(operation, payload, execution);
  assert.equal(readback.length, 1);
  assert.deepEqual(readback[0], { input: payload, context: { jobId: claim.job.id, serverId, resourceType, resourceId } });
  const completed = await registry.complete({ serverId, jobId: claim.job.id, status: 'succeeded', result });
  assert.equal(jobPublicView(completed).result.tablesCopied, 1);
  auth.revokeSession(login.token);
  await assert.rejects(handlers.executeOperation(operation, payload, execution), { code: 'panel_job_actor_forbidden' });
  assert.equal(readback.length, 1);
});
