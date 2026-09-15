import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteRegistry, websiteRegistryInternals } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const webRoot = `/var/lib/yunpanel/apps/${applicationId}/current/public`;

function phpApplication(overrides = {}) {
  return {
    id: applicationId,
    serverId,
    name: 'PHP Site',
    type: 'php',
    repositoryUrl: null,
    branch: null,
    retention: 1,
    build: null,
    runtime: null,
    runtimeAdapter: null,
    webRoot,
    ...overrides,
  };
}

test('PHP Website binds canonical current/public root and survives registry reopen', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-php-website-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'websites.json');
  const apps = new Map([[applicationId, phpApplication()]]);
  const create = () => createWebsiteRegistry({
    filePath,
    serverExists: async (id) => id === serverId,
    getApplication: async (id) => apps.get(id) ?? null,
  });

  const registry = create();
  await registry.init();
  const website = await registry.createWebsite({
    serverId,
    name: 'PHP Website',
    applicationId,
    runtimeType: 'php',
  });

  assert.equal(website.runtimeType, 'php');
  assert.equal(website.documentRoot, webRoot);
  assert.equal(website.unixUser, websiteRegistryInternals.appUnixUser(applicationId));
  assert.equal(website.proxyTarget, null);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.version, 5);
  assert.equal(persisted.websites[0].runtimeType, 'php');
  assert.equal(persisted.websites[0].documentRoot, webRoot);

  const reopened = create();
  await reopened.init();
  assert.deepEqual(await reopened.getWebsite(website.id), website);
});

test('PHP Website binding fails closed on Application webRoot drift', async () => {
  const app = phpApplication({ webRoot: '/tmp/wrong-public' });
  const registry = createWebsiteRegistry({
    serverExists: async () => true,
    getApplication: async () => app,
  });
  await registry.init();

  await assert.rejects(
    registry.createWebsite({ serverId, name: 'Drifted PHP', applicationId, runtimeType: 'php' }),
    (error) => error?.code === 'website_application_root_drift' && error?.status === 409,
  );
});
