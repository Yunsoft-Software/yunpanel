import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteRegistry, WebsiteRegistryError } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23';
const applicationId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const staticApplication = (overrides = {}) => ({
  id: applicationId,
  serverId,
  name: 'Static App',
  type: 'static',
  webRoot: `/var/www/yunpanel/apps/${applicationId}/current`,
  ...overrides,
});

async function persistedFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-website-reference-'));
  const filePath = path.join(root, 'website-registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createWebsiteRegistry({
    filePath,
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => id === applicationId ? staticApplication() : null,
  });
  await registry.init();
  const website = await registry.createWebsite({ serverId, name: 'Bound Site', applicationId });
  return { filePath, website };
}

function reopened(filePath, { server = true, application = staticApplication() } = {}) {
  return createWebsiteRegistry({
    filePath,
    serverExists: async (id) => server && id === serverId,
    getApplication: async (id) => id === applicationId ? application : null,
  });
}

const code = (expected) => (error) => error instanceof WebsiteRegistryError && error.code === expected;

test('persisted Website revalidates healthy server and application binding on restart', async (t) => {
  const { filePath, website } = await persistedFixture(t);
  const registry = reopened(filePath);
  await registry.init();
  const loaded = await registry.getWebsite(website.id);
  assert.equal(loaded.id, website.id);
  assert.equal(loaded.applicationId, applicationId);
  assert.equal(Object.hasOwn(loaded, 'hostname'), false);
  assert.equal(Object.hasOwn(loaded, 'domainId'), false);
});

test('persisted Website refuses missing server or application references', async (t) => {
  const { filePath } = await persistedFixture(t);
  await assert.rejects(reopened(filePath, { server: false }).init(), code('website_server_reference_missing'));
  await assert.rejects(reopened(filePath, { application: null }).init(), code('website_application_reference_missing'));
});

test('persisted Website refuses application server runtime and root drift', async (t) => {
  const { filePath } = await persistedFixture(t);
  await assert.rejects(
    reopened(filePath, { application: staticApplication({ serverId: otherServerId }) }).init(),
    code('website_application_server_mismatch'),
  );
  await assert.rejects(
    reopened(filePath, { application: staticApplication({ webRoot: '/tmp/drifted' }) }).init(),
    code('website_application_root_drift'),
  );
  await assert.rejects(
    reopened(filePath, { application: staticApplication({ type: 'node', webRoot: null }) }).init(),
    code('website_application_binding_drift'),
  );
});

test('persisted proxy Website still requires its server but never invents an application', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-proxy-reference-'));
  const filePath = path.join(root, 'website-registry.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = createWebsiteRegistry({ filePath, serverExists: async () => true });
  await registry.init();
  const created = await registry.createWebsite({ serverId, name: 'External Proxy', runtimeType: 'proxy' });
  assert.equal(created.applicationId, null);
  await assert.rejects(
    createWebsiteRegistry({ filePath, serverExists: async () => false }).init(),
    code('website_server_reference_missing'),
  );
});
