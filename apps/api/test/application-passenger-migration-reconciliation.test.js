import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { reconcileApplicationPassengerMigration } from '../src/application-passenger-migration-reconciliation.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const jobId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const runtime = Object.freeze({
  nodeMajor: 24,
  port: 3200,
  mode: 'production',
  documentRoot: '.',
  start: Object.freeze({ mode: 'node', entryFile: 'server.js' }),
  healthPath: '/health',
});
const nginxSettings = Object.freeze({
  clientMaxBodySizeMb: 32,
  websocket: true,
  headers: Object.freeze([]),
});
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: `/etc/yunpanel/passenger-env/${applicationId}.conf`,
});

function state() {
  const application = {
    id: applicationId,
    serverId,
    type: 'node',
    currentReleaseId: releaseId,
    activeRuntime: runtime,
  };
  const website = {
    id: websiteId,
    serverId,
    applicationId,
    runtimeType: 'node',
    revision: 3,
  };
  const domain = {
    id: domainId,
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    certificateId: null,
    canonicalRedirect: false,
    httpsRedirect: false,
    nginxSettings,
    state: 'active',
    desiredRevision: 4,
    appliedRevision: 4,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3200, websocket: true },
  };
  const job = {
    id: jobId,
    serverId,
    operation: OPERATIONS.APP_NODE_PASSENGER_MIGRATE,
    resourceType: 'application',
    resourceId: applicationId,
    status: 'succeeded',
    payload: {
      node: { applicationId, releaseId, runtime },
      domain: {
        primaryDomain: domain.primaryDomain,
        aliases: [...domain.aliases],
        tls: null,
        canonicalRedirect: false,
        httpsRedirect: false,
        nginxSettings,
      },
      authority: {
        websiteId,
        websiteRevision: 3,
        domainId,
        domainDesiredRevision: 4,
        domainAppliedRevision: 4,
      },
    },
    result: {
      state: 'migrated',
      nginx: { targetChecksum: 'b'.repeat(64) },
      passengerTarget,
    },
  };
  return { application, website, domain, job };
}

function dependencies(current, { binding = null, extraWebsites = [], extraDomains = [] } = {}) {
  const activations = [];
  return {
    activations,
    applicationRegistry: { async getApplication() { return current.application; } },
    websiteRegistry: {
      async getWebsite(id) { return id === current.website.id ? current.website : null; },
      async listWebsites() { return [current.website, ...extraWebsites]; },
    },
    domainRegistry: {
      async getDomain(id) { return id === current.domain.id ? current.domain : null; },
      async listDomains() { return [current.domain, ...extraDomains]; },
    },
    certificateRegistry: { async getCertificate() { return null; } },
    runtimeBindingRegistry: {
      async getBinding() { return binding; },
      async activate(input, options) {
        activations.push({ input, options });
        return { ...input, revision: (binding?.revision ?? 0) + 1 };
      },
    },
  };
}

test('reconciles a successful migration into the exact queued Passenger runtime authority', async () => {
  const current = state();
  const deps = dependencies(current);
  const result = await reconcileApplicationPassengerMigration({ job: current.job, ...deps });
  assert.equal(result.adapter, 'passenger');
  assert.equal(result.state, 'active');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.websiteRevision, 3);
  assert.equal(result.domains[0].domainId, domainId);
  assert.equal(result.domains[0].desiredRevision, 4);
  assert.equal(result.domains[0].nginxChecksum, 'b'.repeat(64));
  assert.deepEqual(result.passengerTarget, passengerTarget);
  assert.deepEqual(deps.activations[0].options, { expectedRevision: 0 });
});

test('persists cleanup-required without pretending systemd cleanup completed', async () => {
  const current = state();
  current.job.result.state = 'passenger_active_cleanup_required';
  const result = await reconcileApplicationPassengerMigration({ job: current.job, ...dependencies(current) });
  assert.equal(result.state, 'cleanup_required');
});

test('refuses reconciliation when exact Domain configuration drifted during host cutover', async () => {
  const current = state();
  current.domain.nginxSettings = { ...nginxSettings, clientMaxBodySizeMb: 64 };
  await assert.rejects(
    reconcileApplicationPassengerMigration({ job: current.job, ...dependencies(current) }),
    (error) => error?.code === 'node_passenger_migration_domain_drift',
  );
});

test('refuses reconciliation when queued Website revision changed', async () => {
  const current = state();
  current.website.revision = 4;
  await assert.rejects(
    reconcileApplicationPassengerMigration({ job: current.job, ...dependencies(current) }),
    (error) => error?.code === 'node_passenger_migration_website_drift',
  );
});

test('refuses reconciliation when queued Domain revision changed', async () => {
  const current = state();
  current.domain.desiredRevision = 5;
  current.domain.appliedRevision = 5;
  await assert.rejects(
    reconcileApplicationPassengerMigration({ job: current.job, ...dependencies(current) }),
    (error) => error?.code === 'node_passenger_migration_domain_drift',
  );
});

test('refuses reconciliation if another Website becomes bound to the same Application', async () => {
  const current = state();
  const extraWebsite = {
    id: '1af41a08-a03d-41dc-afef-a9d1af96785d',
    serverId,
    applicationId,
    runtimeType: 'node',
    revision: 1,
  };
  await assert.rejects(
    reconcileApplicationPassengerMigration({
      job: current.job,
      ...dependencies(current, { extraWebsites: [extraWebsite] }),
    }),
    (error) => error?.code === 'node_passenger_migration_website_drift',
  );
});

test('refuses reconciliation if another Domain route becomes bound to the Website', async () => {
  const current = state();
  const extraDomain = {
    ...current.domain,
    id: '1af41a08-a03d-41dc-afef-a9d1af96785d',
    primaryDomain: 'extra.example.com',
  };
  await assert.rejects(
    reconcileApplicationPassengerMigration({
      job: current.job,
      ...dependencies(current, { extraDomains: [extraDomain] }),
    }),
    (error) => error?.code === 'node_passenger_migration_domain_drift',
  );
});

test('uses the current runtime-binding revision for cleanup retries', async () => {
  const current = state();
  current.job.result.state = 'migrated';
  const existing = { revision: 7 };
  const deps = dependencies(current, { binding: existing });
  await reconcileApplicationPassengerMigration({ job: current.job, ...deps });
  assert.deepEqual(deps.activations[0].options, { expectedRevision: 7 });
});
