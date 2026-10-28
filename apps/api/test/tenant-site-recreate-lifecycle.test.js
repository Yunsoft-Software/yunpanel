import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createApiKeyActorAuthorizer } from '../src/api-key-actor.js';
import { createApiKeyStore } from '../src/api-key-store.js';
import { createAuthStore } from '../src/auth-store.js';
import { previewResourceImpact } from '../src/resource-impact.js';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalPreview } from '../src/website-removal-plan.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { createWebsiteRemovalWorker } from '../src/website-removal-worker.js';
import { createApp } from '../src/app.js';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createAuthenticatedApi } from '../src/auth-http.js';
import { createAutomationHandler } from '../src/automation-http.js';
import { createDnsHostingRegistry } from '../src/dns-hosting-registry.js';
import { createDockerWorkloadRegistry } from '../src/docker-workload-registry.js';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createMailDomainRegistry } from '../src/mail-domain-registry.js';
import { createJobRegistry } from '../src/job-registry.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';
import { OPERATIONS } from '@yunpanel/protocol';
import { createServerRegistry } from '../src/server-registry.js';
import { createTenantSiteStore } from '../src/tenant-site-store.js';
import { createWebsiteProvisioningRuntime } from '../src/website-provisioning-runtime.js';
import { createWebsiteRegistry } from '../src/website-registry.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-tenant-recreate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createServerRegistry();
  const serverId = (await registry.createLocalServer({ hostname: 'tenant-host' })).id;
  const serverExists = async (id) => Boolean(await registry.getServer(id));
  const applicationRegistry = createApplicationRegistry({ serverExists });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({ serverExists });
  const websiteRegistry = createWebsiteRegistry({
    serverExists,
    getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id),
  });
  const domainRegistry = createDomainRegistry({
    serverExists,
    getWebsite: async (id) => websiteRegistry.getWebsite(id),
  });

  async function removeDomainCompletely(domainId) {
    const domain = await domainRegistry.getDomain(domainId);
    if (!domain) return;
    const checksum = domain.stagedChecksum || '0'.repeat(64);
    if (!domain.stagedRevision || !domain.appliedRevision) {
      await domainRegistry.markStaged(domainId, { checksum, configName: `yunpanel-${domain.primaryDomain}.conf` });
      await domainRegistry.markApplied(domainId, { checksum });
    }
    const current = await domainRegistry.getDomain(domainId);
    const opId = randomBytes(16).toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-4$3-8$4-$5');
    await domainRegistry.markSuspended(domainId, {
      expectedRevision: current.desiredRevision,
      checksum,
      operationId: opId,
    });
    if (current.websiteId) {
      await domainRegistry.detachWebsiteForRemoval(domainId, {
        expectedWebsiteId: current.websiteId,
        expectedRevision: current.desiredRevision,
        checksum,
        suspensionOperationId: opId,
      });
    }
    const confirmation = `finalize-domain-remove:${domainId}:${opId}:${current.desiredRevision}:${checksum}`;
    await domainRegistry.finalizeDomainRemoval(domainId, {
      operationId: opId,
      expectedRevision: current.desiredRevision,
      checksum,
      confirmation,
    });
  }
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const sitesDir = path.join(directory, 'enabled');
  const nginxManager = createNginxManager({ stagingDir: path.join(directory, 'staging'), sitesDir, execFn: async () => '' });
  const jobRegistry = createJobRegistry();
  const executor = createLocalJobExecutor({
    serverId,
    jobRegistry,
    pollMs: 50,
    executeOperation: (operation, payload, execution) => operation === OPERATIONS.DOMAIN_STAGE
      ? nginxManager.stageDomain(payload)
      : nginxManager.activateDomain({ ...payload, activationId: execution?.jobId ?? null }),
    reconcileCompletedJob: (job) => reconcileCompletedJob({ domainRegistry, applicationRegistry, websiteRegistry, job }),
  });
  executor.start();
  t.after(() => executor.stop());

  let certificateRuns = 0;
  const websiteProvisioningRuntime = createWebsiteProvisioningRuntime({
    identityManager: {
      apply: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      compensate: async () => ({ satisfied: true }),
      inspectCompensation: async () => ({ satisfied: true }),
    },
    nginxManager,
    // Step runner hook / verification
  });
  await Promise.all([
    applicationRegistry.init(),
    dockerWorkloadRegistry.init(),
    websiteRegistry.init(),
    domainRegistry.init(),
    dnsHostingRegistry.init(),
    mailDomainRegistry.init(),
    websiteProvisioningRuntime.init(),
  ]);
  await domainRegistry.createDomain({
    serverId,
    primaryDomain: 'st.example.test',
    targetType: 'redirect',
    target: { url: 'https://example.test' },
  });

  const authStore = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => authStore.close());
  const password = randomBytes(24).toString('base64url');
  await authStore.completeSetup({ setupToken: authStore.issueSetupToken().token, username: 'owner', password });
  const ownerId = authStore.getSession((await authStore.login({ username: 'owner', password })).token).user.id;
  const apiKeyStore = createApiKeyStore();
  const storeFile = path.join(directory, 'tenant-sites.json');
  const tenantSiteStore = createTenantSiteStore({ filePath: storeFile });
  const { token } = await apiKeyStore.create({
    name: 'Provisioner',
    parentDomain: 'st.example.test',
    portMin: 32000,
    portMax: 32999,
    createdBy: ownerId,
  });

  const removalRegistry = createWebsiteRemovalOperationRegistry();
  await removalRegistry.init();

  // Simulating realistic domainRemovalRuntime that tracks removed domains across lifecycles:
  const domainHistory = new Map();
  const domainRemovalRuntime = {
    async listForDomain(id) {
      return domainHistory.get(id) ?? [];
    },
    async preview({ domainId }) {
      return {
        readyToStart: true,
        previewDigest: 'a'.repeat(64),
        confirmation: `start-domain-remove:${domainId}:1:${'a'.repeat(64)}`,
      };
    },
    async start({ domainId }) {
      const op = { id: `op-${domainId}`, domainId, status: 'removed' };
      domainHistory.set(domainId, [op]);
      await removeDomainCompletely(domainId);
      return op;
    },
  };

  const websiteRemovalRuntime = createWebsiteRemovalRuntime({
    registry: removalRegistry,
    domainRegistry,
    websiteRegistry,
    applicationRegistry,
    automaticExecution: true,
    authorizeActor: createApiKeyActorAuthorizer({
      apiKeyStore,
      tenantSiteStore,
      getAutomationUser: (id) => authStore.getAutomationUser(id),
      ownerMfaRequired: false,
    }),
    previewProvider: async ({ websiteId }) => {
      const website = await websiteRegistry.getWebsite(websiteId);
      const impact = await previewResourceImpact({
        resourceType: 'website',
        resourceId: websiteId,
        operation: 'delete',
        targetServerId: null,
        registry,
        applicationRegistry,
        websiteRegistry,
        domainRegistry,
        certificateRegistry: { async listCertificates() { return []; } },
        jobRegistry,
        dnsHostingRegistry,
        mailDomainRegistry,
        additionalProviders: {
          databases: async () => [],
          sftpKeys: async () => [],
          runtimeBindings: async () => [],
          unixIdentities: async () => (website.unixUser ? [{ id: website.unixUser, state: 'active' }] : []),
          logScopes: async () => [{ id: website.id, state: 'managed' }],
          crons: async () => [],
          backups: async () => [],
          dockerWorkloads: async () => [],
          webmailMappings: async () => [],
          mailboxes: async () => [],
        },
      });
      return createWebsiteRemovalPreview({ website, impact, applicationState: null });
    },
    domainRemovalRuntime,
    fileCleanupInspector: async () => ({ ready: true }),
    fileCleanupHandler: async (input) => ({ ...input, filesCleaned: true, retainedBackups: input.retainedBackups, retainedLogScopes: input.retainedLogScopes }),
    unixIdentityCleanupInspector: async () => ({ ready: true }),
    unixIdentityCleanupHandler: async (input) => ({ ...input, unixIdentityCleaned: true }),
  });
  await websiteRemovalRuntime.init?.();

  const worker = createWebsiteRemovalWorker({ registry: removalRegistry, runtime: websiteRemovalRuntime, intervalMs: 100 });
  worker.start();
  t.after(() => worker.stop());

  const listener = createAuthenticatedApi({
    store: { configured: () => true, mfa: { enabled: () => true }, getSession: () => null },
    publicOrigin: 'https://panel.example.test',
    createHandler: () => createApp({
      environment: 'production',
      registry,
      jobRegistry,
      applicationRegistry,
      dockerWorkloadRegistry,
      websiteRegistry,
      domainRegistry,
      dnsHostingRegistry,
      mailDomainRegistry,
      websiteProvisioningRuntime,
      websiteRemovalRuntime,
      localServerId: serverId,
      apiKeyStore,
      tenantSiteStore,
    }),
    automationHandler: createAutomationHandler({ apiKeyStore }),
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const call = async (method, pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return {
    call,
    domainRegistry,
    websiteRegistry,
    tenantSiteStore,
    websiteProvisioningRuntime,
    removalRegistry,
  };
}

async function untilState(call, slug, targetStates, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  let result;
  while (Date.now() < end) {
    result = await call('GET', `/api/automation/tenant-sites/${slug}`);
    if (result.status === 404 && targetStates.includes('404')) return result;
    const currentState = result.body?.data?.state;
    if (targetStates.includes(currentState)) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return result;
}

test('re-creating a deleted tenant with the same slug generates a new generation/journal and avoids old provisioning/removal collisions', async (t) => {
  const f = await fixture(t);
  const slug = 'ypt-recreate';

  // 1. Initial creation (generation 1)
  const created1 = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, { upstreamPort: 32010, https: false });
  assert.equal(created1.status, 202);
  const active1 = await untilState(f.call, slug, ['active', 'attention']);
  assert.equal(active1.body?.data?.state, 'active');
  const websiteId1 = active1.body?.data?.websiteId;
  assert.ok(websiteId1, 'First websiteId must exist');
  assert.equal(active1.body?.data?.generation, 1);

  // Idempotency: repeating PUT while active returns same websiteId and status 200
  const samePut1 = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, { upstreamPort: 32010, https: false });
  assert.equal(samePut1.status, 200);
  assert.equal(samePut1.body?.data?.websiteId, websiteId1);
  assert.equal(samePut1.body?.data?.generation, 1);

  // 2. Removal of first generation
  const delete1 = await f.call('DELETE', `/api/automation/tenant-sites/${slug}`);
  assert.equal(delete1.status, 202);
  const removed1 = await untilState(f.call, slug, ['removed', '404']);
  assert.ok(['removed', '404'].includes(removed1.status === 404 ? '404' : removed1.body?.data?.state));

  // Confirm it is completely gone (404)
  const afterDelete1 = await untilState(f.call, slug, ['404']);
  assert.equal(afterDelete1.status, 404);

  // 3. Re-create the same slug (generation 2)!
  const created2 = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, { upstreamPort: 32010, https: false });
  assert.equal(created2.status, 202, `Re-create response: ${JSON.stringify(created2.body)}`);

  // It should NOT immediately return active with stale operation; it must have a new identity and run provisioning
  const websiteId2 = created2.body?.data?.websiteId;
  assert.notEqual(websiteId2, websiteId1, 'Re-created site must have a new websiteId (isolated generation)');
  assert.equal(created2.body?.data?.generation, 2);

  const active2 = await untilState(f.call, slug, ['active', 'attention']);
  assert.equal(active2.body?.data?.state, 'active');
  assert.equal(active2.body?.data?.websiteId, websiteId2);
  assert.equal(active2.body?.data?.generation, 2);

  // Idempotency on generation 2
  const samePut2 = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, { upstreamPort: 32010, https: false });
  assert.equal(samePut2.status, 200);
  assert.equal(samePut2.body?.data?.websiteId, websiteId2);
  assert.equal(samePut2.body?.data?.generation, 2);

  // 4. Delete the re-created tenant (second generation)
  const delete2 = await f.call('DELETE', `/api/automation/tenant-sites/${slug}`);
  assert.equal(delete2.status, 202);

  // Must NOT fail with website_removal_domains_still_attached!
  const removed2 = await untilState(f.call, slug, ['removed', 'attention', '404'], 15_000);
  assert.notEqual(removed2.body?.data?.state, 'attention', `Removal failed: ${JSON.stringify(removed2.body)}`);
  assert.ok(['removed', '404'].includes(removed2.status === 404 ? '404' : removed2.body?.data?.state));

  const afterDelete2 = await untilState(f.call, slug, ['404']);
  assert.equal(afterDelete2.status, 404);

  // 5. Re-create third time to verify generation 3 increments monotonically
  const created3 = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, { upstreamPort: 32010, https: false });
  assert.equal(created3.status, 202);
  assert.equal(created3.body?.data?.generation, 3);
  const websiteId3 = created3.body?.data?.websiteId;
  assert.notEqual(websiteId3, websiteId2);
  assert.notEqual(websiteId3, websiteId1);

  const active3 = await untilState(f.call, slug, ['active', 'attention']);
  assert.equal(active3.body?.data?.state, 'active');
  assert.equal(active3.body?.data?.generation, 3);

  // Clean up generation 3
  const delete3 = await f.call('DELETE', `/api/automation/tenant-sites/${slug}`);
  assert.equal(delete3.status, 202);
  const removed3 = await untilState(f.call, slug, ['removed', '404']);
  assert.ok(['removed', '404'].includes(removed3.status === 404 ? '404' : removed3.body?.data?.state));
});

test('tenant site store tracks and persists generations across delete and file reload', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-tenant-store-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'tenant-sites.json');

  const store1 = createTenantSiteStore({ filePath });
  assert.equal(await store1.getGeneration('foo.example.test'), 1);

  await store1.put({ hostname: 'foo.example.test', slug: 'foo', parentDomain: 'example.test', generation: 1 });
  assert.equal(await store1.getGeneration('foo.example.test'), 1);

  // Removing increments the generation for this hostname
  await store1.remove('foo.example.test');
  assert.equal(await store1.get('foo.example.test'), null);
  assert.equal(await store1.getGeneration('foo.example.test'), 2);

  // Reload store from the persisted file
  const store2 = createTenantSiteStore({ filePath });
  assert.equal(await store2.get('foo.example.test'), null);
  assert.equal(await store2.getGeneration('foo.example.test'), 2);

  // Create generation 2
  await store2.put({ hostname: 'foo.example.test', slug: 'foo', parentDomain: 'example.test', generation: 2 });
  assert.equal((await store2.get('foo.example.test')).generation, 2);

  // Remove again -> generation becomes 3
  await store2.remove('foo.example.test');
  assert.equal(await store2.getGeneration('foo.example.test'), 3);

  // Reload again
  const store3 = createTenantSiteStore({ filePath });
  assert.equal(await store3.getGeneration('foo.example.test'), 3);
});

