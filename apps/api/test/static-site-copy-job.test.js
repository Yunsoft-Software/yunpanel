import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationEnvelope, isKnownOperation, OPERATIONS, validateOperationEnvelope } from '@yunpanel/protocol';
import { createAuthStore } from '../src/auth-store.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createJobRegistry, jobPublicView } from '../src/job-registry.js';
import { createLocalHostOperations } from '../src/local-host-operations.js';
import { createSiteFileManager } from '../src/site-file-manager.js';
import { executeSiteFileOperation } from '../src/site-file-worker.js';
import { createSiteMutationLock } from '../src/site-mutation-lock.js';
import { createStaticSiteCopyTransfer } from '../src/static-site-copy-transfer.js';
import { staticSiteCopyFixture } from './fixtures/static-site-copy.js';

const operation = OPERATIONS.WEBSITE_STATIC_COPY;
function copyJob({ source, target, session, previewDigest = 'a'.repeat(64), serverId = randomUUID() } = {}) {
  const payload = { websiteId: source?.site.id ?? randomUUID(), applicationId: source?.site.applicationId ?? randomUUID(),
    targetWebsiteId: target?.site.id ?? randomUUID(), targetApplicationId: target?.site.applicationId ?? randomUUID(),
    actorSessionId: session?.id ?? randomUUID(), actorUserId: session?.user.id ?? randomUUID(), actorRole: 'owner', previewDigest };
  const authorization = { kind: 'panel', scope: 'website', serverId, websiteId: payload.websiteId, role: payload.actorRole,
    actorId: payload.actorUserId, userId: payload.actorUserId, sessionId: payload.actorSessionId };
  return { serverId, type: operation, operation, resourceType: 'application', resourceId: payload.applicationId,
    payload, authorization, idempotencyKey: `website.static.copy:${randomUUID()}` };
}

async function diskJobStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yp-static-copy-job-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'jobs.json');
  const registry = createJobRegistry({ filePath });
  return { filePath, registry };
}

test('static copy has an exact Owner-only protocol envelope with distinct identities', () => {
  assert.equal(operation, 'website.static.copy');
  assert.equal(isKnownOperation(operation), true);
  const { payload } = copyJob();
  const id = randomUUID();
  const envelope = createOperationEnvelope({ id, operation, payload });
  assert.deepEqual(validateOperationEnvelope(envelope), { ok: true, errors: [] });
  for (const changed of [
    { actorRole: 'customer' }, { actorSessionId: null }, { targetApplicationId: payload.applicationId },
    { targetWebsiteId: payload.websiteId }, { previewDigest: 'not-a-digest' }, { manifest: [] },
  ]) {
    assert.equal(validateOperationEnvelope({ ...envelope, payload: { ...payload, ...changed } }).ok, false);
  }
  assert.equal(validateOperationEnvelope({ ...envelope, protocolVersion: -1 }).ok, false);
});

test('persists one authorized copy and only the validated result counts', async (t) => {
  const { filePath, registry } = await diskJobStore(t);
  const request = copyJob();
  await assert.rejects(registry.enqueue({ ...request, authorization: null }), { code: 'job_authorization_required' });
  await assert.rejects(registry.enqueue({ ...request, authorization: { ...request.authorization, sessionId: randomUUID() } }),
    { code: 'job_authorization_required' });
  await assert.rejects(registry.enqueue({ ...request, resourceId: request.payload.targetApplicationId }), { code: 'invalid_resource_id' });
  const queued = await registry.enqueue(request);
  assert.equal((await registry.enqueue(request)).id, queued.id);
  const reopened = createJobRegistry({ filePath });
  assert.equal((await reopened.getJob(queued.id)).status, 'queued');
  assert.deepEqual((await reopened.claimNext(request.serverId)).envelope.payload, request.payload);
  const completion = { serverId: request.serverId, jobId: queued.id, status: 'succeeded' };
  const result = { sourceWebsiteId: request.payload.websiteId, targetWebsiteId: request.payload.targetWebsiteId,
    digest: request.payload.previewDigest, filesCopied: 2, bytesCopied: 100 };
  await assert.rejects(reopened.complete({ ...completion, result: { ...result, targetWebsiteId: randomUUID() } }), { code: 'invalid_job_result' });
  await assert.rejects(reopened.complete({ ...completion, result: { ...result, digest: 'b'.repeat(64) } }), { code: 'invalid_job_result' });
  await assert.rejects(reopened.complete({ ...completion, result: { ...result, bytesCopied: -1 } }), { code: 'invalid_job_result' });
  const completed = await reopened.complete({ ...completion, result });
  const counts = { filesCopied: 2, bytesCopied: 100 };
  assert.deepEqual(jobPublicView(completed).result, counts);
  assert.ok(!Object.hasOwn(jobPublicView(completed), 'payload'));
  const stored = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.deepEqual(stored.jobs[0].result, counts);
});

test('keeps a failed static copy terminal after duplicate submission and rejects generic retry', async (t) => {
  const { filePath, registry } = await diskJobStore(t);
  const request = copyJob();
  const queued = await registry.enqueue(request);
  await registry.claimNext(request.serverId);
  await registry.complete({ serverId: request.serverId, jobId: queued.id, status: 'failed',
    error: { code: 'site_mutation_locked', message: 'The site lock is held' } });
  const reopened = createJobRegistry({ filePath });
  const duplicate = await reopened.enqueue(request);
  assert.equal(duplicate.id, queued.id);
  assert.equal(duplicate.status, 'failed');
  assert.equal(duplicate.attempts, 1);
  assert.equal(duplicate.manualRetryAllowed, false);
  await assert.rejects(reopened.enqueue({ ...request, manual: true }), { code: 'job_not_retryable' });
  await assert.rejects(reopened.retryJob({ jobId: queued.id, authorization: request.authorization }), { code: 'job_not_retryable' });
  assert.equal(await reopened.claimNext(request.serverId), null);
});

test('a running copy on disk requires recovery and cannot be picked up as a new run', async (t) => {
  const { filePath } = await diskJobStore(t);
  const registry = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  const request = copyJob();
  const queued = await registry.enqueue(request);
  await registry.claimNext(request.serverId);
  const reopened = createDurableJobRegistry({ filePath, registryFactory: createJobRegistry });
  await reopened.init();
  assert.equal(reopened.recovery().jobs[0].jobId, queued.id);
  await assert.rejects(reopened.claimNext(request.serverId), { code: 'durable_job_reconciliation_required' });
  assert.equal((await reopened.getJob(queued.id)).status, 'running');
});

test('local host operation dispatches through an actual Owner session and static file transfer', async (t) => {
  const { directory, source, target, server, planner, request, websiteRegistry, filesystem } = await staticSiteCopyFixture(t);
  const accountsFile = path.join(directory, 'accounts');
  const accounts = [source, target].map(({ site, evidence }) =>
    `${site.unixUser}:x:${evidence.unixUid}:${evidence.unixGid}::${directory}:/usr/sbin/nologin`);
  await fs.writeFile(accountsFile, `${accounts.join('\n')}\n`, { mode: 0o600 });
  const siteFileManager = createSiteFileManager({ websiteRegistry, localServerId: server.id, getuid: () => 0,
    readPasswd: () => fs.readFile(accountsFile, 'utf8'), statFn: filesystem.stat, realpathFn: filesystem.realpath,
    runWorker: ({ request: operation }) => executeSiteFileOperation(operation, filesystem) });
  const siteMutationLock = createSiteMutationLock({ root: path.join(directory, 'locks') });
  const transfer = createStaticSiteCopyTransfer({ planner, siteFileManager, siteMutationLock });
  const plan = await planner.preview(request, { fileManager: siteFileManager });
  const auth = createAuthStore({ filePath: path.join(directory, 'auth.sqlite') });
  t.after(() => auth.close());
  const password = randomBytes(32).toString('base64url');
  await auth.completeSetup({ setupToken: auth.issueSetupToken().token, username: 'admin', password });
  const { session } = await auth.login({ username: 'admin', password });
  function authorized({ sessionId, userId }) {
    const current = auth.getSessionById(sessionId);
    return current?.user.id === userId && current.user.role === 'owner';
  }
  const job = copyJob({ source, target, session, previewDigest: plan.digest, serverId: server.id });
  assert.equal(createLocalHostOperations().supports(operation), false);
  const operations = createLocalHostOperations({ authorizePanelJob: authorized, websiteStaticCopyOperation: {
    execute(payload, context) {
      assert.equal(context.resourceId, plan.source.applicationId);
      assert.equal(payload.previewDigest, plan.digest);
      return transfer.copy(plan, { authorize: () => authorized({ sessionId: payload.actorSessionId, userId: payload.actorUserId }) });
    },
  } });
  const execution = { jobId: randomUUID(), serverId: job.serverId, resourceType: job.resourceType,
    resourceId: job.resourceId, authorization: job.authorization };
  await assert.rejects(operations.executeOperation(operation, { ...job.payload, manifest: [] }, execution),
    { code: 'invalid_local_operation_payload' });
  await assert.rejects(operations.executeOperation(operation, job.payload, { ...execution, authorization: null }),
    { code: 'panel_job_actor_forbidden' });
  await assert.rejects(operations.executeOperation(operation, job.payload, { ...execution, resourceId: job.payload.targetApplicationId }),
    { code: 'panel_job_actor_forbidden' });
  assert.deepEqual(await fs.readdir(target.release), []);
  assert.equal((await operations.executeOperation(operation, job.payload, execution)).filesCopied, 2);
  assert.deepEqual(await fs.readFile(path.join(target.release, 'images', 'photo.bin')), Buffer.from([0, 1, 254, 255]));
});
