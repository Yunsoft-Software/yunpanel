import assert from 'node:assert/strict';
import test from 'node:test';
import { createAiActionPlan, verifyAiActionExecution } from '../src/ai-action-plan.js';
import { createAiToolRuntime } from '../src/ai-tool-runtime.js';

const ownerAuth = {
  user: { id: 'owner-1', role: 'owner' },
  access: { mode: 'management', permissions: ['*'] },
  security: { managementAllowed: true },
};

function fixture() {
  const server = { id: 'server-1', serverId: 'server-1', executionMode: 'local', status: 'online' };
  const website = { id: 'website-1', serverId: 'server-1', name: 'Site', applicationId: 'app-1' };
  const application = { id: 'app-1', serverId: 'server-1', type: 'node', currentReleaseId: 'release-1' };
  const job = {
    id: 'job-1', serverId: 'server-1', type: 'inspect', operation: 'system.inventory.inspect', payload: {},
    resourceType: 'application', resourceId: 'app-1', status: 'succeeded', createdAt: new Date().toISOString(), result: {}, error: null,
  };
  return createAiToolRuntime({
    localServerId: 'server-1',
    serverRegistry: { async listServers() { return [server]; }, async getServer(id) { return id === server.id ? server : null; } },
    websiteRegistry: { async listWebsites() { return [website]; }, async getWebsite(id) { return id === website.id ? website : null; } },
    domainRegistry: { async listDomains() { return [{ id: 'domain-1', serverId: 'server-1', websiteId: 'website-1', primaryDomain: 'example.com' }]; } },
    applicationRegistry: { async getApplication(id) { return id === application.id ? application : null; } },
    jobRegistry: {
      async getJob(id) { return id === job.id ? job : null; },
      async listJobs(filter = {}) { return filter.serverId && filter.serverId !== 'server-1' ? [] : [job]; },
    },
  });
}

test('AI runtime binds only implemented safe read tools at the first integration stage', () => {
  const registry = fixture();
  const available = registry.list().filter((tool) => tool.available).map((tool) => tool.name);
  assert.deepEqual(available, ['application.inspect', 'job.inspect', 'server.health', 'website.inspect', 'website.list']);
});

test('Website inspection composes explicit Website, Domain and Application relationships', async () => {
  const registry = fixture();
  const result = await registry.execute({ name: 'website.inspect', input: { websiteId: 'website-1' } });
  assert.equal(result.website.id, 'website-1');
  assert.equal(result.domains[0].primaryDomain, 'example.com');
  assert.equal(result.application.id, 'app-1');
});

test('action preview is bound to tool input and requires exact confirmation for configured writes', () => {
  const registry = fixture();
  registry.bind('application.deploy', async () => ({ queued: true }));
  const plan = createAiActionPlan({ registry, name: 'application.deploy', input: { applicationId: 'app-1' }, auth: ownerAuth });
  assert.equal(plan.decision, 'confirm');
  assert.match(plan.previewDigest, /^[a-f0-9]{64}$/);
  assert.equal(verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: plan.confirmation }), true);
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: plan.previewDigest, confirmation: 'wrong' }),
    (error) => error.code === 'ai_action_confirmation_required',
  );
});

test('always-confirm destructive action cannot execute with a stale preview digest', () => {
  const registry = fixture();
  registry.bind('backup.restore', async () => ({ restored: true }));
  const plan = createAiActionPlan({
    registry,
    name: 'backup.restore',
    input: { websiteId: 'website-1', snapshotId: 'snapshot-1' },
    auth: ownerAuth,
    overrides: { tool: { 'backup.restore': 'allow' } },
  });
  assert.equal(plan.decision, 'confirm');
  assert.throws(
    () => verifyAiActionExecution({ plan, previewDigest: '0'.repeat(64), confirmation: plan.confirmation }),
    (error) => error.code === 'ai_action_preview_stale',
  );
});
