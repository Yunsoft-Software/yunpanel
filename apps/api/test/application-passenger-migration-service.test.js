import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { createApplicationPassengerMigrationService } from '../src/application-passenger-migration-service.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const digest = 'a'.repeat(64);
const confirmation = `migrate-node-passenger:${applicationId}:${digest}`;
const runtime = Object.freeze({
  nodeMajor: 24,
  port: 3100,
  mode: 'production',
  documentRoot: '.',
  start: Object.freeze({ mode: 'node', entryFile: 'server.js' }),
  healthPath: '/health',
});
const application = Object.freeze({
  id: applicationId,
  serverId,
  type: 'node',
  currentReleaseId: releaseId,
  activeRuntime: runtime,
});
const domain = Object.freeze({
  id: domainId,
  serverId,
  websiteId,
  primaryDomain: 'example.com',
  aliases: Object.freeze(['www.example.com']),
  certificateId: null,
  canonicalRedirect: false,
  httpsRedirect: false,
  nginxSettings: Object.freeze({ clientMaxBodySizeMb: 32, websocket: true, headers: Object.freeze([]) }),
  desiredRevision: 4,
  appliedRevision: 4,
});

function preview(overrides = {}) {
  return {
    ready: true,
    previewDigest: digest,
    confirmation,
    application: { applicationId, serverId, releaseId, desiredRevision: 2, appliedRevision: 2 },
    website: { websiteId, revision: 3, runtimeType: 'node', applicationId },
    domain: { domainId, websiteId, desiredRevision: 4, appliedRevision: 4 },
    ...overrides,
  };
}

function service({
  currentPreview = preview(),
  binding = null,
  routingJobs = [],
  certificates = [],
} = {}) {
  const enqueued = [];
  const migration = createApplicationPassengerMigrationService({
    previewService: { async preview() { return currentPreview; } },
    applicationRegistry: { async getApplication() { return application; } },
    domainRegistry: { async getDomain() { return domain; } },
    certificateRegistry: {
      async getCertificate() { return null; },
      async listCertificates() { return certificates; },
    },
    runtimeBindingRegistry: { async getBinding() { return binding; } },
    jobRegistry: {
      async listJobs() { return routingJobs; },
      async enqueue(input) {
        enqueued.push(input);
        return { id: 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e', ...input };
      },
    },
  });
  return { migration, enqueued };
}

test('queues only canonical node and domain state from an exact preview', async () => {
  const { migration, enqueued } = service();
  const result = await migration.apply(applicationId, { previewDigest: digest, confirmation });
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].operation, OPERATIONS.APP_NODE_PASSENGER_MIGRATE);
  assert.equal(enqueued[0].resourceType, 'application');
  assert.equal(enqueued[0].resourceId, applicationId);
  assert.deepEqual(Object.keys(enqueued[0].payload).sort(), ['domain', 'node']);
  assert.deepEqual(enqueued[0].payload.node, { applicationId, releaseId, runtime });
  assert.equal(enqueued[0].payload.domain.primaryDomain, 'example.com');
  assert.equal(enqueued[0].payload.domain.tls, null);
  assert.equal(enqueued[0].idempotencyKey, `node-passenger-migrate:${applicationId}:${digest}`);
  assert.equal(result.job.operation, OPERATIONS.APP_NODE_PASSENGER_MIGRATE);
});

test('rejects a stale preview before queue mutation', async () => {
  const { migration, enqueued } = service({ currentPreview: preview({ previewDigest: 'b'.repeat(64) }) });
  await assert.rejects(
    migration.apply(applicationId, { previewDigest: digest, confirmation }),
    (error) => error?.code === 'node_passenger_migration_preview_stale',
  );
  assert.equal(enqueued.length, 0);
});

test('rejects an already active Passenger binding', async () => {
  const { migration, enqueued } = service({
    binding: { adapter: 'passenger', state: 'active', releaseId },
  });
  await assert.rejects(
    migration.apply(applicationId, { previewDigest: digest, confirmation }),
    (error) => error?.code === 'node_passenger_migration_already_active',
  );
  assert.equal(enqueued.length, 0);
});

test('allows cleanup retry for the exact cleanup-required binding even when source preview is no longer ready', async () => {
  const { migration, enqueued } = service({
    currentPreview: preview({ ready: false }),
    binding: {
      adapter: 'passenger',
      state: 'cleanup_required',
      releaseId,
      websiteId,
      websiteRevision: 3,
      domains: [{ domainId, desiredRevision: 4, nginxChecksum: 'c'.repeat(64) }],
    },
  });
  await migration.apply(applicationId, { previewDigest: digest, confirmation });
  assert.equal(enqueued.length, 1);
});

test('waits for active Domain routing work before Passenger migration', async () => {
  const { migration, enqueued } = service({ routingJobs: [{ status: 'running' }] });
  await assert.rejects(
    migration.apply(applicationId, { previewDigest: digest, confirmation }),
    (error) => error?.code === 'node_passenger_migration_routing_busy' && error.status === 409,
  );
  assert.equal(enqueued.length, 0);
});

test('waits for certificate mutation before Passenger migration', async () => {
  const { migration, enqueued } = service({
    certificates: [{ domainId, state: 'issuing' }],
  });
  await assert.rejects(
    migration.apply(applicationId, { previewDigest: digest, confirmation }),
    (error) => error?.code === 'node_passenger_migration_routing_busy' && error.status === 409,
  );
  assert.equal(enqueued.length, 0);
});