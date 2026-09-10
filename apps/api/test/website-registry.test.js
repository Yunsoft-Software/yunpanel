import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteRegistry, WebsiteRegistryError, websiteRegistryInternals } from '../src/website-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23';
const staticAppId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const nodeAppId = '340344cf-4e57-4f70-946a-3c6e919e951d';

function applications() {
  return new Map([
    [staticAppId, {
      id: staticAppId,
      serverId,
      name: 'Static App',
      type: 'static',
      webRoot: `/var/www/yunpanel/apps/${staticAppId}/current`,
    }],
    [nodeAppId, {
      id: nodeAppId,
      serverId,
      name: 'Node App',
      type: 'node',
      webRoot: null,
    }],
  ]);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-websites-'));
  const filePath = path.join(root, 'website-registry.json');
  const apps = applications();
  const registry = createWebsiteRegistry({
    filePath,
    now: () => Date.parse('2026-09-10T20:30:00.000Z'),
    serverExists: async (id) => id === serverId || id === otherServerId,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await registry.init();
  return { root, filePath, apps, registry };
}

test('application-backed Website gets independent identity and canonical runtime binding', async (t) => {
  const { registry } = await fixture(t);
  const website = await registry.createWebsite({
    serverId,
    name: 'Marketing Site',
    applicationId: staticAppId,
  });

  assert.notEqual(website.id, staticAppId);
  assert.equal(website.serverId, serverId);
  assert.equal(website.name, 'Marketing Site');
  assert.equal(website.applicationId, staticAppId);
  assert.equal(website.runtimeType, 'static');
  assert.equal(website.documentRoot, `/var/www/yunpanel/apps/${staticAppId}/current`);
  assert.equal(website.unixUser, websiteRegistryInternals.appUnixUser(staticAppId));
  assert.match(website.unixUser, /^yunapp-[a-f0-9]{12}$/);
  assert.equal(Object.hasOwn(website, 'hostname'), false);
  assert.equal(Object.hasOwn(website, 'domainId'), false);
});

test('Node Website derives current release root and deterministic application user', async (t) => {
  const { registry } = await fixture(t);
  const website = await registry.createWebsite({ serverId, name: 'API', applicationId: nodeAppId, runtimeType: 'node' });
  assert.equal(website.runtimeType, 'node');
  assert.equal(website.documentRoot, `/var/lib/yunpanel/apps/${nodeAppId}/current`);
  assert.equal(website.unixUser, websiteRegistryInternals.appUnixUser(nodeAppId));
});

test('proxy Website is a real resource without an invented application or Unix user', async (t) => {
  const { registry } = await fixture(t);
  const website = await registry.createWebsite({ serverId, name: 'External Proxy', runtimeType: 'proxy' });
  assert.equal(website.applicationId, null);
  assert.equal(website.runtimeType, 'proxy');
  assert.equal(website.documentRoot, null);
  assert.equal(website.unixUser, null);
});

test('application binding is unique and must match Website server and runtime', async (t) => {
  const { apps, registry } = await fixture(t);
  await registry.createWebsite({ serverId, name: 'One', applicationId: staticAppId });
  await assert.rejects(
    registry.createWebsite({ serverId, name: 'Two', applicationId: staticAppId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'application_already_bound',
  );

  await assert.rejects(
    registry.createWebsite({ serverId, name: 'Wrong Runtime', applicationId: nodeAppId, runtimeType: 'static' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_runtime_mismatch',
  );

  apps.set(nodeAppId, { ...apps.get(nodeAppId), serverId: otherServerId });
  await assert.rejects(
    registry.createWebsite({ serverId, name: 'Wrong Server', applicationId: nodeAppId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_application_server_mismatch',
  );
});

test('static binding rejects application root drift instead of persisting a caller path', async (t) => {
  const { apps, registry } = await fixture(t);
  apps.set(staticAppId, { ...apps.get(staticAppId), webRoot: '/tmp/attacker-root' });
  await assert.rejects(
    registry.createWebsite({ serverId, name: 'Drifted', applicationId: staticAppId }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_application_root_drift',
  );
  assert.equal((await registry.listWebsites()).length, 0);
});

test('file-backed Website records persist privately and reopen without changing identity', async (t) => {
  const { filePath, apps, registry } = await fixture(t);
  const created = await registry.createWebsite({ serverId, name: 'Persistent', applicationId: nodeAppId });
  const metadata = await stat(filePath);
  assert.equal(metadata.mode & 0o077, 0);

  const reopened = createWebsiteRegistry({
    filePath,
    serverExists: async () => true,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  await reopened.init();
  const found = await reopened.getWebsite(created.id);
  assert.equal(found.id, created.id);
  assert.equal(found.applicationId, nodeAppId);
  assert.deepEqual((await reopened.listWebsites({ serverId })).map((item) => item.id), [created.id]);
});

test('corrupt persisted Website bindings fail closed on initialization', async (t) => {
  const { filePath, registry } = await fixture(t);
  const created = await registry.createWebsite({ serverId, name: 'Original', applicationId: staticAppId });
  const original = JSON.parse(await readFile(filePath, 'utf8'));

  for (const mutate of [
    (state) => { state.websites[0].documentRoot = '/tmp/outside'; },
    (state) => { state.websites[0].unixUser = 'root'; },
    (state) => { state.websites.push({ ...state.websites[0], id: created.id }); },
    (state) => { state.websites.push({ ...state.websites[0], id: nodeAppId }); },
    (state) => { state.websites[0].unexpected = 'field'; },
  ]) {
    const state = structuredClone(original);
    mutate(state);
    await writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
    const reopened = createWebsiteRegistry({ filePath });
    await assert.rejects(reopened.init());
  }
});
