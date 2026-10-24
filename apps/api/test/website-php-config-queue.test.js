import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobRegistry } from '../src/job-registry.js';
import { createWebsitePhpToolsService } from '../src/website-php-tools-service.js';
import { createWebsitePhpToolActionService } from '../src/website-php-tool-action-service.js';
import { createLocalWebsitePhpToolOperation } from '../src/local-website-php-tool-operation.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const applicationId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const actor = { sessionId: '44444444-4444-4444-8444-444444444444', userId: '55555555-5555-4555-8555-555555555555', role: 'owner' };
async function fixture() {
  let active = true, calls = 0;
  const website = { id: websiteId, applicationId, serverId, unixUser: 'yunapp-123456789abc', runtimeType: 'php', revision: 1 };
  const application = { id: applicationId, serverId, unixUser: website.unixUser, type: 'php' };
  const service = createWebsitePhpToolsService({ websiteRegistry: {
    getWebsite: async () => ({ ...website }),
    updateWebsitePhpConfig: async ({ config, expectedRevision }) => {
      assert.equal(website.revision, expectedRevision); Object.assign(website, { phpConfig: { ...config }, revision: expectedRevision + 1 }); return { ...website };
    },
  }, applicationRegistry: { getApplication: async () => application }, phpCliToolManager: {},
    phpFpmSiteManager: { update: async () => { calls++; return { satisfied: true }; } },
    withApplicationLock: async (_id, action) => action(), lstatFn: async () => ({ isDirectory: () => true }) });
  const jobs = createJobRegistry(); await jobs.init();
  const authorizeActor = async (value) => active ? value : null;
  const actionService = createWebsitePhpToolActionService({ websitePhpToolsService: service, jobRegistry: jobs,
    authorizeActor, withApplicationLock: async (_id, action) => action() });
  const worker = createLocalWebsitePhpToolOperation({ websitePhpToolsService: service, authorizeActor, siteMutationLock: { withSiteLock: async (_id, action) => action() } });
  return { service, actionService, jobs, worker, website, calls: () => calls, revoke: () => { active = false; } };
}
async function queue(f) {
  const preview = await f.service.previewPhpFpmConfig(websiteId, { maxChildren: 9 });
  return f.actionService.queueConfig(websiteId, { config: preview.desired, expectedRevision: preview.websiteRevision,
    previewDigest: preview.previewDigest, confirmation: preview.confirmation }, actor);
}
test('PHP submission queues without mutation, then worker applies and persists before job success', async () => {
  const f = await fixture(); const queued = await queue(f);
  assert.equal(queued.job.status, 'queued'); assert.equal(f.calls(), 0);
  assert.equal((await f.service.getPhpFpmConfig(websiteId)).fpm.maxChildren, 8);
  const claimed = await f.jobs.claimNext(serverId);
  assert.equal(claimed.envelope.payload.actionId, 'php.fpm.update');
  const result = await f.worker.execute(claimed.envelope.payload, { jobId: queued.job.id, serverId, resourceType: 'application', resourceId: applicationId });
  await f.jobs.complete({ serverId, jobId: queued.job.id, status: 'succeeded', result });
  assert.equal((await f.jobs.getJob(queued.job.id)).status, 'succeeded');
  assert.equal(f.calls(), 1); assert.equal((await f.service.getPhpFpmConfig(websiteId)).fpm.maxChildren, 9); assert.equal(f.website.revision, 2);
});
test('PHP worker denies a revoked session before calling the native manager', async () => {
  const f = await fixture(); const queued = await queue(f); const claimed = await f.jobs.claimNext(serverId); f.revoke();
  await assert.rejects(f.worker.execute(claimed.envelope.payload, { jobId: queued.job.id, serverId, resourceType: 'application', resourceId: applicationId }), { code: 'website_php_action_actor_forbidden' });
  assert.equal(f.calls(), 0); assert.equal(f.website.revision, 1);
});
