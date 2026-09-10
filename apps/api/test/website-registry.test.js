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
const otherNodeAppId = 'c42e06d2-9bd1-4757-b320-5975ef454ee1';

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
    [otherNodeAppId, {
      id: otherNodeAppId,
      serverId,
      name: 'Other Node App',
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
  assert.equal(website.proxyTarget, null);
  assert.equal(website.revision, 1);
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

test('proxy Website owns a canonical optional target without an invented application or Unix user', async (t) => {
  const { apps, filePath, registry } = await fixture(t);
  const website = await registry.createWebsite({
    serverId,
    name: 'External Proxy',
    runtimeType: 'proxy',
    proxyTarget: { host: 'BÜCHER.example.', port: 8443, websocket: false },
  });
  assert.equal(website.applicationId, null);
  assert.equal(website.runtimeType, 'proxy');
  assert.equal(website.documentRoot, null);
  assert.equal(website.unixUser, null);
  assert.deepEqual(website.proxyTarget, { host: 'xn--bcher-kva.example', port: 8443, websocket: false });

  for (const target of [
    { host: 'https://example.com', port: 8443 },
    { host: 'example.com/path', port: 8443 },
    { host: 'example.com', port: 80 },
    { host: 'example.com', port: 8443, secret: true },
  ]) {
    await assert.rejects(
      registry.createWebsite({ serverId, name: 'Invalid Proxy', runtimeType: 'proxy', proxyTarget: target }),
      (error) => error instanceof WebsiteRegistryError && error.code.startsWith('invalid_website_proxy_'),
    );
  }

  const reopened = createWebsiteRegistry({
    filePath,
    serverExists: async () => true,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  await reopened.init();
  assert.deepEqual((await reopened.getWebsite(website.id)).proxyTarget, website.proxyTarget);
});

test('internal deterministic Website identity retries exactly and rejects reuse', async (t) => {
  const { registry } = await fixture(t);
  const websiteId = '5b504f8f-4341-4a55-a6fb-86c6eb282e61';
  const input = {
    websiteId,
    serverId,
    name: 'Deterministic Proxy',
    runtimeType: 'proxy',
    proxyTarget: { host: 'origin.example.test', port: 8443, websocket: false },
  };
  const created = await registry.createWebsite(input);
  const retried = await registry.createWebsite(input);
  assert.equal(created.id, websiteId);
  assert.deepEqual(retried, created);
  assert.equal((await registry.listWebsites()).length, 1);

  await assert.rejects(
    registry.createWebsite({ ...input, name: 'Reused identity' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_identity_conflict' && error.status === 409,
  );
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

test('v1 Website state migrates once to revisioned v2 without changing resource identity', async (t) => {
  const { filePath, apps, registry } = await fixture(t);
  const created = await registry.createWebsite({ serverId, name: 'Legacy Website', applicationId: staticAppId });
  const legacy = JSON.parse(await readFile(filePath, 'utf8'));
  legacy.version = 1;
  delete legacy.websites[0].revision;
  delete legacy.websites[0].proxyTarget;
  await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });

  const reopened = createWebsiteRegistry({
    filePath,
    serverExists: async () => true,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  await reopened.init();
  assert.deepEqual(await reopened.getWebsite(created.id), { ...created, revision: 1, proxyTarget: null });
  const migrated = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.websites[0].revision, 1);
  assert.equal(migrated.websites[0].proxyTarget, null);

  const again = createWebsiteRegistry({
    filePath,
    serverExists: async () => true,
    getApplication: async (id) => apps.get(id) ?? null,
  });
  await again.init();
  assert.equal((await again.getWebsite(created.id)).revision, 1);
});

test('Website update preview binds exact revision and canonical application impact', async (t) => {
  const { registry } = await fixture(t);
  const website = await registry.createWebsite({ serverId, name: 'Original', applicationId: staticAppId });
  const changes = { name: 'API Website', applicationId: nodeAppId, runtimeType: 'node' };
  const preview = await registry.previewWebsiteUpdate(website.id, changes);
  assert.equal(preview.currentRevision, 1);
  assert.equal(preview.nextWebsite.applicationId, nodeAppId);
  assert.equal(preview.nextWebsite.runtimeType, 'node');
  assert.equal(preview.nextWebsite.documentRoot, `/var/lib/yunpanel/apps/${nodeAppId}/current`);
  assert.deepEqual(preview.impact, { nameChanged: true, bindingChanged: true, proxyTargetChanged: false });
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);

  const updated = await registry.updateWebsite({
    websiteId: website.id,
    expectedRevision: preview.currentRevision,
    changes,
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'API Website');
  assert.equal(updated.applicationId, nodeAppId);

  await assert.rejects(
    registry.updateWebsite({ websiteId: website.id, expectedRevision: 1, changes: { name: 'Stale' }, previewFingerprint: preview.fingerprint }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_revision_conflict',
  );
});

test('Website rebind keeps application unique and proxy transitions explicit', async (t) => {
  const { registry } = await fixture(t);
  const first = await registry.createWebsite({ serverId, name: 'First', applicationId: staticAppId });
  await registry.createWebsite({ serverId, name: 'Second', applicationId: nodeAppId });

  await assert.rejects(
    registry.previewWebsiteUpdate(first.id, { applicationId: nodeAppId, runtimeType: 'node' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'application_already_bound',
  );
  await assert.rejects(
    registry.previewWebsiteUpdate(first.id, { runtimeType: 'proxy' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_proxy_application_conflict',
  );

  const changes = {
    applicationId: null,
    runtimeType: 'proxy',
    proxyTarget: { host: '[2001:0DB8:0:0:0:0:0:1]', port: 9443 },
  };
  const preview = await registry.previewWebsiteUpdate(first.id, changes);
  assert.deepEqual(preview.nextWebsite.proxyTarget, { host: '2001:db8::1', port: 9443, websocket: true });
  const updated = await registry.updateWebsite({
    websiteId: first.id,
    expectedRevision: preview.currentRevision,
    changes,
    previewFingerprint: preview.fingerprint,
  });
  assert.equal(updated.runtimeType, 'proxy');
  assert.equal(updated.applicationId, null);
  assert.equal(updated.documentRoot, null);
  assert.equal(updated.unixUser, null);

  const bind = await registry.previewWebsiteUpdate(first.id, { applicationId: otherNodeAppId, runtimeType: 'node' });
  assert.equal(bind.nextWebsite.proxyTarget, null);
});

test('Website update rejects no-op and stale fingerprint without mutation', async (t) => {
  const { registry } = await fixture(t);
  const website = await registry.createWebsite({ serverId, name: 'Stable', runtimeType: 'proxy' });
  await assert.rejects(
    registry.previewWebsiteUpdate(website.id, { name: 'Stable' }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_update_no_changes',
  );
  const preview = await registry.previewWebsiteUpdate(website.id, { name: 'Changed' });
  await assert.rejects(
    registry.updateWebsite({
      websiteId: website.id,
      expectedRevision: 1,
      changes: { name: 'Changed' },
      previewFingerprint: '0'.repeat(64),
    }),
    (error) => error instanceof WebsiteRegistryError && error.code === 'website_update_preview_stale',
  );
  assert.equal((await registry.getWebsite(website.id)).name, 'Stable');
  assert.equal(preview.currentRevision, 1);
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
    (state) => { state.websites[0].revision = 0; },
    (state) => { state.websites[0].proxyTarget = { host: 'example.com', port: 8443, websocket: true }; },
  ]) {
    const state = structuredClone(original);
    mutate(state);
    await writeFile(filePath, JSON.stringify(state), { mode: 0o600 });
    const reopened = createWebsiteRegistry({ filePath });
    await assert.rejects(reopened.init());
  }
});
