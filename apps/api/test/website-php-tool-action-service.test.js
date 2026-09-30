import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpToolActionService } from '../src/website-php-tool-action-service.js';
import { websitePhpToolActionPreview } from '../src/website-php-tool-action.js';

const preview = websitePhpToolActionPreview({
  websiteId: '11111111-1111-4111-8111-111111111111',
  serverId: '33333333-3333-4333-8333-333333333333',
  applicationId: '22222222-2222-4222-8222-222222222222',
  unixUser: 'yunapp-123456789abc',
  websiteRevision: 4,
}, 'composer.dump-autoload');

const input = Object.freeze({
  actionId: preview.actionId,
  expectedWebsiteRevision: preview.websiteRevision,
  previewDigest: preview.previewDigest,
  confirmation: preview.confirmation,
});
const actor = Object.freeze({
  sessionId: '44444444-4444-4444-8444-444444444444',
  userId: '55555555-5555-4555-8555-555555555555',
  role: 'site_manager',
});
const dependencies = (jobs = []) => ({
  websitePhpToolsService: { getActionPreview: async () => preview },
  jobRegistry: {
    listJobs: async () => jobs,
    enqueue: async (value) => ({ id: 'php-action-job-01', status: 'queued', ...value }),
  },
  authorizeActor: async () => actor,
  withApplicationLock: async (_id, operation) => operation(),
});

test('action service enqueues exactly one application-scoped durable operation', async () => {
  const enqueued = [];
  const deps = dependencies();
  deps.jobRegistry.enqueue = async (value) => { enqueued.push(value); return { id: 'php-action-job-01', status: 'queued', ...value }; };
  const service = createWebsitePhpToolActionService(deps);
  const result = await service.queue(preview.websiteId, input, actor);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].operation, 'website.php.action');
  assert.equal(enqueued[0].resourceType, 'application');
  assert.equal(enqueued[0].resourceId, preview.applicationId);
  assert.equal(enqueued[0].payload.actionId, preview.actionId);
  assert.equal(enqueued[0].payload.actorSessionId, actor.sessionId);
  assert.equal(Object.hasOwn(enqueued[0].payload, 'command'), false);
  assert.equal(result.job.status, 'queued');
});

test('action service blocks when another Application job is active', async () => {
  let enqueued = false;
  const deps = dependencies([{ id: 'existing-job', status: 'running' }]);
  deps.jobRegistry.enqueue = async () => { enqueued = true; };
  const service = createWebsitePhpToolActionService(deps);
  await assert.rejects(
    () => service.queue(preview.websiteId, input, actor),
    (error) => error.code === 'website_php_action_job_conflict',
  );
  assert.equal(enqueued, false);
});

test('action service rejects enqueue when actor session is revoked or unauthorized', async () => {
  let enqueued = false;
  const deps = dependencies();
  deps.authorizeActor = async () => null; // Session revoked or invalid grant
  deps.jobRegistry.enqueue = async () => { enqueued = true; };
  const service = createWebsitePhpToolActionService(deps);
  await assert.rejects(
    () => service.queue(preview.websiteId, input, actor),
    (error) => error.code === 'website_php_action_actor_forbidden' && error.status === 403,
  );
  assert.equal(enqueued, false);
});

test('action service rejects enqueue when session is revoked while acquiring application lock', async () => {
  let enqueued = false;
  let checks = 0;
  const deps = dependencies();
  deps.authorizeActor = async () => {
    checks++;
    return checks === 1 ? actor : null; // Session revoked concurrently
  };
  deps.jobRegistry.enqueue = async () => { enqueued = true; };
  const service = createWebsitePhpToolActionService(deps);
  await assert.rejects(
    () => service.queue(preview.websiteId, input, actor),
    (error) => error.code === 'website_php_action_actor_forbidden' && error.status === 403,
  );
  assert.equal(enqueued, false);
});

test('action service binds live actor role to durable job payload for all authorized roles', async () => {
  for (const role of ['owner', 'site_manager', 'reseller', 'customer']) {
    const roleActor = Object.freeze({ ...actor, role });
    const enqueued = [];
    const deps = dependencies();
    deps.authorizeActor = async () => roleActor;
    deps.jobRegistry.enqueue = async (value) => { enqueued.push(value); return { id: 'job-1', status: 'queued', ...value }; };
    const service = createWebsitePhpToolActionService(deps);
    const result = await service.queue(preview.websiteId, input, roleActor);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].payload.actorRole, role);
    assert.equal(enqueued[0].payload.actorSessionId, roleActor.sessionId);
    assert.equal(result.job.status, 'queued');
  }
});
