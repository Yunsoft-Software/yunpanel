import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const otherServerId = 'c8e93a53-6b7b-41bb-a55f-eddb6fe6aa23';
const websiteId = '5a5ea77f-2d7d-43f7-a455-1ed9e5cb41be';
const otherWebsiteId = '340344cf-4e57-4f70-946a-3c6e919e951d';

function input(extra = {}) {
  return {
    serverId,
    primaryDomain: 'example.test',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    ...extra,
  };
}

function websiteLookup(id) {
  if (id === websiteId) return { id, serverId };
  if (id === otherWebsiteId) return { id, serverId: otherServerId };
  return null;
}

test('new domain persists an explicit same-server Website foreign key', async () => {
  const registry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteLookup(id),
  });
  const domain = await registry.createDomain(input({ websiteId }));
  assert.equal(domain.websiteId, websiteId);
  assert.equal(domain.serverId, serverId);
  assert.equal(domain.primaryDomain, 'example.test');
});

test('missing invalid and cross-server Website references fail before domain persistence', async () => {
  const registry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websiteLookup(id),
  });
  for (const [value, code] of [
    ['not-a-uuid', 'invalid_website_id'],
    ['11111111-1111-4111-8111-111111111111', 'website_not_found'],
    [otherWebsiteId, 'website_server_mismatch'],
  ]) {
    await assert.rejects(
      registry.createDomain(input({ websiteId: value })),
      (error) => error instanceof DomainRegistryError && error.code === code,
    );
    assert.equal((await registry.listDomains()).length, 0);
  }
});

test('explicit Website binding requires a Website registry dependency', async () => {
  const registry = createDomainRegistry({ serverExists: async () => true });
  await assert.rejects(
    registry.createDomain(input({ websiteId })),
    (error) => error instanceof DomainRegistryError && error.code === 'website_registry_unavailable' && error.status === 503,
  );
});

test('legacy persisted domains without websiteId hydrate to null without rewriting the file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-website-legacy-'));
  const filePath = path.join(root, 'domains.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const seed = createDomainRegistry({ serverExists: async () => true });
  const domain = await seed.createDomain(input());
  delete domain.kind;
  delete domain.parentDomainId;
  delete domain.websiteId;
  const before = JSON.stringify({ version: 1, domains: [domain] });
  await writeFile(filePath, before, { mode: 0o600 });

  const reopened = createDomainRegistry({ filePath, serverExists: async () => true });
  const loaded = await reopened.getDomain(domain.id);
  assert.equal(loaded.websiteId, null);
  assert.equal(await readFile(filePath, 'utf8'), before);
});

test('persisted Website binding is revalidated against production Website lookup on startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-website-persisted-'));
  const filePath = path.join(root, 'domains.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  const writer = createDomainRegistry({
    filePath,
    serverExists: async () => true,
    getWebsite: async (id) => websiteLookup(id),
  });
  await writer.createDomain(input({ websiteId }));

  const missing = createDomainRegistry({
    filePath,
    serverExists: async () => true,
    getWebsite: async () => null,
  });
  await assert.rejects(missing.init(), { code: 'website_not_found' });

  const crossServer = createDomainRegistry({
    filePath,
    serverExists: async () => true,
    getWebsite: async (id) => ({ id, serverId: otherServerId }),
  });
  await assert.rejects(crossServer.init(), { code: 'website_server_mismatch' });
});
