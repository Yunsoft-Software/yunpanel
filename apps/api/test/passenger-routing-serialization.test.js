import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createDomainUpdateHandler } from '../src/domain-http.js';
import { createDomainStageTargetJobRegistry } from '../src/domain-stage-target-job-registry.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const migrationJob = Object.freeze({
  id: '5b5ac5b8-d56e-42f5-80ea-b19178d1bb03',
  serverId,
  operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
  resourceType: 'application',
  resourceId: applicationId,
  status: 'running',
});

function responseRecorder() {
  return {
    code: null,
    payload: null,
    status(code) { this.code = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function stageRegistry() {
  const enqueued = [];
  const registry = {
    async listJobs() { return [migrationJob]; },
    async enqueue(input) { enqueued.push(input); return { id: 'queued-job', ...input }; },
  };
  const decorated = createDomainStageTargetJobRegistry({
    registry,
    domainRegistry: {
      async getDomain(id) {
        return id === domainId ? {
          id: domainId,
          serverId,
          websiteId,
          targetType: 'proxy',
          target: { upstreamHost: '127.0.0.1', upstreamPort: 3100, websocket: true },
          nginxSettings: { clientMaxBodySizeMb: null, proxyTimeoutSeconds: null, websocket: true, headers: [] },
        } : null;
      },
    },
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? { id: websiteId, serverId, applicationId, runtimeType: 'node', revision: 3 } : null;
      },
    },
    dockerComposeProjectRegistry: { async getProject() { return null; } },
    applicationRegistry: { async getApplication() { return null; } },
    runtimeBindingRegistry: { async getBinding() { return null; } },
  });
  return { decorated, enqueued };
}

test('Domain stage cannot start while Passenger cutover is running', async () => {
  const { decorated, enqueued } = stageRegistry();
  await assert.rejects(
    decorated.enqueue({
      serverId,
      type: 'domain.stage',
      operation: OPERATIONS.DOMAIN_STAGE,
      payload: {},
      resourceType: 'domain',
      resourceId: domainId,
    }),
    (error) => error?.code === 'node_passenger_migration_routing_busy' && error.status === 409,
  );
  assert.equal(enqueued.length, 0);
});

test('certificate issue cannot start while Passenger cutover is running', async () => {
  const { decorated, enqueued } = stageRegistry();
  await assert.rejects(
    decorated.enqueue({
      serverId,
      type: 'ssl.issue',
      operation: OPERATIONS.SSL_ISSUE,
      payload: {},
      resourceType: 'certificate',
      resourceId: '7efeed41-b30d-4edb-b17d-c9c44e06cfb0',
    }),
    (error) => error?.code === 'node_passenger_migration_routing_busy' && error.status === 409,
  );
  assert.equal(enqueued.length, 0);
});

test('Domain update cannot mutate routing while Passenger cutover is running', async () => {
  let updated = false;
  const domain = {
    id: domainId,
    serverId,
    websiteId,
    canonicalRedirect: false,
  };
  const domainRegistry = {
    async getDomain(id) { return id === domainId ? domain : null; },
    async previewDomainUpdate() {
      return {
        previewDigest: 'a'.repeat(64),
        confirmation: `update:${domainId}`,
      };
    },
    async updateDomain() { updated = true; return domain; },
  };
  const handler = createDomainUpdateHandler(domainRegistry, {
    localServerId: serverId,
    jobRegistry: {
      async listJobs(filter) {
        if (filter?.resourceType === 'domain') return [];
        return [migrationJob];
      },
    },
    certificateRegistry: { async listCertificates() { return []; } },
  });
  let failure = null;
  await handler({
    params: { domainId },
    body: {
      changes: { canonicalRedirect: true },
      previewDigest: 'a'.repeat(64),
      confirmation: `update:${domainId}`,
    },
  }, responseRecorder(), (error) => { failure = error; });

  assert.equal(failure?.code, 'domain_update_operation_conflict');
  assert.equal(failure?.status, 409);
  assert.equal(updated, false);
});