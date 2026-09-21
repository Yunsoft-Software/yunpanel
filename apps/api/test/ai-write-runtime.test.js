import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createAiToolRuntime } from '../src/ai-tool-runtime.js';

function fixture() {
  const server = { id: 'server-1', serverId: 'server-1', executionMode: 'local' };
  const website = { id: 'website-1', serverId: 'server-1', applicationId: 'app-1', name: 'Site' };
  const application = {
    id: 'app-1',
    serverId: 'server-1',
    type: 'node',
    currentReleaseId: 'release-1',
    activeDeploymentId: null,
    runtime: { nodeMajor: 24 },
    activeRuntime: { nodeMajor: 24 },
  };
  const queued = [];
  const jobRegistry = {
    async getJob() { return null; },
    async listJobs() { return []; },
    async enqueue(input) {
      queued.push(input);
      return {
        id: `job-${queued.length}`,
        serverId: input.serverId,
        type: input.type,
        operation: input.operation,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        status: 'queued',
        createdAt: new Date().toISOString(),
        payload: input.payload,
        result: null,
        error: null,
      };
    },
  };
  const registry = createAiToolRuntime({
    localServerId: server.id,
    serverRegistry: {
      async listServers() { return [server]; },
      async getServer(id) { return id === server.id ? server : null; },
    },
    websiteRegistry: {
      async listWebsites() { return [website]; },
      async getWebsite(id) { return id === website.id ? website : null; },
    },
    domainRegistry: { async listDomains() { return []; } },
    applicationRegistry: {
      async getApplication(id) { return id === application.id ? application : null; },
    },
    applicationEnvironmentRegistry: {
      async environmentStatus(id) {
        assert.equal(id, application.id);
        return { savedRevision: 7 };
      },
    },
    jobRegistry,
  });
  return { registry, queued };
}

test('service.restart queues only an allowlisted managed-service durable operation', async () => {
  const { registry, queued } = fixture();
  assert.equal(registry.get('service.restart').available, true);
  const result = await registry.execute({ name: 'service.restart', input: { serviceId: 'nginx' } });
  assert.equal(result.status, 'queued');
  assert.equal(Object.hasOwn(result, 'payload'), false);
  assert.equal(queued[0].operation, OPERATIONS.SYSTEM_SERVICE_CONTROL);
  assert.deepEqual(queued[0].payload, { serviceId: 'nginx', action: 'restart' });

  await assert.rejects(
    registry.execute({ name: 'service.restart', input: { serviceId: 'yunpanel-api' } }),
    (error) => error.code === 'unsupported_managed_service',
  );
});

test('website.restart reuses the Node restart durable job contract and never exposes its payload', async () => {
  const { registry, queued } = fixture();
  assert.equal(registry.get('website.restart').available, true);
  const result = await registry.execute({ name: 'website.restart', input: { websiteId: 'website-1' } });
  assert.equal(result.status, 'queued');
  assert.equal(Object.hasOwn(result, 'payload'), false);
  assert.equal(queued[0].operation, OPERATIONS.APP_NODE_RESTART);
  assert.deepEqual(queued[0].payload, {
    applicationId: 'app-1',
    releaseId: 'release-1',
    runtime: { nodeMajor: 24 },
    environmentRevision: 7,
  });
});
