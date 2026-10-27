import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createNginxManager } from '@yunpanel/host-runtime';
import { createApiKeyStore } from '../src/api-key-store.js';
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

// Real auth entry, app, registries, provisioning engine and nginx manager (temporary
// directories; `nginx -t` runs on a real host separately). Creating a Unix account
// needs root, so only that host step is a stand-in.
const OWNER_ID = '0b6f4b4e-6f7a-4d55-9d3c-6c1c0f6a9e11';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-tenant-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = createServerRegistry();
  const serverId = (await registry.createLocalServer({ hostname: 'tenant-host' })).id;
  const serverExists = async (id) => Boolean(await registry.getServer(id));
  const applicationRegistry = createApplicationRegistry({ serverExists });
  const dockerWorkloadRegistry = createDockerWorkloadRegistry({ serverExists });
  const websiteRegistry = createWebsiteRegistry({ serverExists, getApplication: async (id) => applicationRegistry.getApplication(id),
    getDockerWorkload: async (id) => dockerWorkloadRegistry.getWorkload(id) });
  const domainRegistry = createDomainRegistry({ serverExists, getWebsite: async (id) => websiteRegistry.getWebsite(id) });
  const getWebDomain = async (id) => domainRegistry.getDomain(id);
  const dnsHostingRegistry = createDnsHostingRegistry({ getWebDomain });
  const mailDomainRegistry = createMailDomainRegistry({ getWebDomain });
  const sitesDir = path.join(directory, 'enabled');
  const nginxManager = createNginxManager({ stagingDir: path.join(directory, 'staging'), sitesDir, execFn: async () => '' });
  const jobRegistry = createJobRegistry();
  // The real local executor publishes mode changes through domain.stage/activate jobs.
  const executor = createLocalJobExecutor({ serverId, jobRegistry, pollMs: 50,
    // Same as local-host-operations: each activation job is its own rollback receipt.
    executeOperation: (operation, payload, execution) => operation === OPERATIONS.DOMAIN_STAGE ? nginxManager.stageDomain(payload)
      : nginxManager.activateDomain({ ...payload, activationId: execution?.jobId ?? null }),
    reconcileCompletedJob: (job) => reconcileCompletedJob({ domainRegistry, applicationRegistry, websiteRegistry, job }) });
  executor.start();
  t.after(() => executor.stop());
  const websiteProvisioningRuntime = createWebsiteProvisioningRuntime({
    identityManager: {
      apply: async () => ({ satisfied: true, uid: 1201, gid: 1201 }), inspect: async () => ({ satisfied: true, uid: 1201, gid: 1201 }),
      compensate: async () => ({ satisfied: true }), inspectCompensation: async () => ({ satisfied: true }),
    },
    nginxManager,
  });
  await Promise.all([applicationRegistry.init(), dockerWorkloadRegistry.init(), websiteRegistry.init(), domainRegistry.init(),
    dnsHostingRegistry.init(), mailDomainRegistry.init(), websiteProvisioningRuntime.init()]);
  await domainRegistry.createDomain({ serverId, primaryDomain: 'st.example.test', targetType: 'redirect', target: { url: 'https://example.test' } });
  const apiKeyStore = createApiKeyStore();
  const { token } = await apiKeyStore.create({ name: 'Provisioner', parentDomain: 'st.example.test', portMin: 32000, portMax: 32999, createdBy: OWNER_ID });
  const other = await apiKeyStore.create({ name: 'Other', parentDomain: 'other.example.test', portMin: 32000, portMax: 32999, createdBy: OWNER_ID });
  const listener = createAuthenticatedApi({
    store: { configured: () => true, mfa: { enabled: () => true }, getSession: () => null },
    publicOrigin: 'https://panel.example.test',
    createHandler: () => createApp({ environment: 'production', registry, jobRegistry, applicationRegistry, dockerWorkloadRegistry, websiteRegistry, domainRegistry,
      dnsHostingRegistry, mailDomainRegistry, websiteProvisioningRuntime, localServerId: serverId, apiKeyStore, tenantSiteStore: createTenantSiteStore() }),
    automationHandler: createAutomationHandler({ apiKeyStore }),
  });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = async (method, pathname, body, key = token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, { method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { call, otherKey: other.token, sitesDir, domainRegistry, serverId };
}

async function config(f, slug) {
  return readFile(path.join(f.sitesDir, (await readdir(f.sitesDir)).find(name => name.includes(slug))), 'utf8');
}

async function untilActive(f, slug) {
  let result;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    result = await f.call('GET', `/api/automation/tenant-sites/${slug}`);
    if (['active', 'attention'].includes(result.body?.data?.state)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return result;
}

test('a key creates a tenant site that proxies to its port and becomes active; repeating the call is harmless', async (t) => {
  const f = await fixture(t);
  const created = await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32010, https: false });
  assert.equal(created.status, 202, JSON.stringify(created.body));
  assert.equal(created.body.data.hostname, 'acme.st.example.test');
  const active = await untilActive(f, 'acme');
  assert.equal(active.body.data.state, 'active', JSON.stringify(active.body));
  const config = await readFile(path.join(f.sitesDir, (await readdir(f.sitesDir)).find(name => name.includes('acme'))), 'utf8');
  assert.match(config, /server_name acme\.st\.example\.test;/);
  assert.match(config, /proxy_pass http:\/\/127\.0\.0\.1:32010;/);
  const again = await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32010, https: false });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.websiteId, active.body.data.websiteId);
  assert.equal((await f.domainRegistry.listDomains()).filter(d => d.primaryDomain === 'acme.st.example.test').length, 1);
});

test('managed HTTPS plans a certificate for the tenant host', async (t) => {
  const f = await fixture(t);
  const created = await f.call('PUT', '/api/automation/tenant-sites/beta', { upstreamPort: 32011 });
  assert.equal(created.status, 202);
  assert.ok(created.body.data.steps.some(step => step.id === 'certificate'), JSON.stringify(created.body.data.steps));
});

test('scope, reserved names, ports and foreign hostnames are protected', async (t) => {
  const f = await fixture(t);
  for (const [slug, body, code] of [['www', { upstreamPort: 32010 }, 'tenant_slug_reserved'], ['a--b', { upstreamPort: 32010 }, 'invalid_tenant_slug'],
    ['Acme', { upstreamPort: 32010 }, 'invalid_tenant_slug'], ['acme', { upstreamPort: 8080 }, 'tenant_port_out_of_scope'],
    ['acme', { upstreamPort: 32010, extra: 1 }, 'invalid_tenant_site']]) {
    const result = await f.call('PUT', `/api/automation/tenant-sites/${slug}`, body);
    assert.equal(result.body?.error?.code, code, `${slug} ${JSON.stringify(body)}`);
  }
  await f.domainRegistry.createDomain({ serverId: f.serverId, primaryDomain: 'eski.st.example.test', targetType: 'redirect', target: { url: 'https://example.test' } });
  assert.equal((await f.call('PUT', '/api/automation/tenant-sites/eski', { upstreamPort: 32010 })).body.error.code, 'existing_domain_protected');
  assert.equal((await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32010 }, f.otherKey)).body.error.code, 'tenant_parent_domain_missing');
  await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32010, https: false });
  assert.equal((await f.call('GET', '/api/automation/tenant-sites/acme', null, f.otherKey)).status, 404, 'another scope cannot see it');
  assert.equal((await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32020, https: false })).body.error.code, 'tenant_port_change_unsupported');
});

test('stop answers 503, archive forwards to billing, and active serves the application again', async (t) => {
  const f = await fixture(t);
  await f.call('PUT', '/api/automation/tenant-sites/acme', { upstreamPort: 32010, https: false });
  await untilActive(f, 'acme');
  const stopped = await f.call('POST', '/api/automation/tenant-sites/acme/state', { state: 'stopped' });
  assert.equal(stopped.status, 202, JSON.stringify(stopped.body));
  assert.equal((await f.call('POST', '/api/automation/tenant-sites/acme/state', { state: 'active' })).body.error.code, 'tenant_site_busy');
  let result = await untilActive(f, 'acme');
  assert.deepEqual([result.body.data.state, result.body.data.mode], ['active', 'stopped'], JSON.stringify(result.body));
  assert.match(await config(f, 'acme'), /location \/ \{\n {4}return 503;/);
  assert.equal((await config(f, 'acme')).includes('proxy_pass'), false);
  await f.call('POST', '/api/automation/tenant-sites/acme/state', { state: 'archived', redirectUrl: 'https://control.example.test/billing' });
  result = await untilActive(f, 'acme');
  assert.deepEqual([result.body.data.state, result.body.data.mode], ['active', 'archived']);
  assert.match(await config(f, 'acme'), /return 302 https:\/\/control\.example\.test\/billing;/);
  const reactivated = await f.call('POST', '/api/automation/tenant-sites/acme/state', { state: 'active' });
  assert.equal(reactivated.status, 202, JSON.stringify(reactivated.body));
  result = await untilActive(f, 'acme');
  assert.deepEqual([result.body.data.state, result.body.data.mode], ['active', 'active'], JSON.stringify(result.body));
  assert.match(await config(f, 'acme'), /proxy_pass http:\/\/127\.0\.0\.1:32010;/);
  for (const body of [{ state: 'archived' }, { state: 'paused' }, { state: 'archived', redirectUrl: 'https://x.com/;deny all' }]) {
    const refused = await f.call('POST', '/api/automation/tenant-sites/acme/state', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
});
