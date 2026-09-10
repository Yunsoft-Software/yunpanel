import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const otherWebsiteId = 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7';
const serverId = 'server-1';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-domain-website-migration-'));
  const filePath = path.join(root, 'domains.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const websites = new Map([
    [websiteId, { id: websiteId, serverId }],
    [otherWebsiteId, { id: otherWebsiteId, serverId }],
  ]);
  const registry = createDomainRegistry({
    filePath,
    now: () => Date.parse('2026-09-11T00:40:00.000Z'),
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websites.get(id) ?? null,
  });
  await registry.init();
  return { filePath, registry, websites };
}

const code = (expected) => (error) => error instanceof DomainRegistryError && error.code === expected;

test('legacy Domain binds to a Website once without changing traffic revision state', async (t) => {
  const { filePath, registry } = await fixture(t);
  const domain = await registry.createDomain({
    serverId,
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  await registry.markStaged(domain.id, { checksum: 'a'.repeat(64), configName: 'example.conf' });
  await registry.markApplied(domain.id, { checksum: 'a'.repeat(64) });
  const before = await registry.getDomain(domain.id);

  const bound = await registry.bindWebsite(domain.id, websiteId);
  assert.equal(bound.websiteId, websiteId);
  assert.equal(bound.desiredRevision, before.desiredRevision);
  assert.equal(bound.appliedRevision, before.appliedRevision);
  assert.equal(bound.stagedChecksum, before.stagedChecksum);
  assert.deepEqual(bound.target, before.target);
  assert.equal((await registry.bindWebsite(domain.id, websiteId)).websiteId, websiteId);

  const persisted = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(persisted.domains[0].websiteId, websiteId);
});

test('existing Website binding cannot silently move to a different Website', async (t) => {
  const { registry } = await fixture(t);
  const domain = await registry.createDomain({
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  await assert.rejects(registry.bindWebsite(domain.id, otherWebsiteId), code('domain_website_rebind_requires_preview'));
  assert.equal((await registry.getDomain(domain.id)).websiteId, websiteId);
});

test('migration binding rejects null missing and cross-server Website targets', async (t) => {
  const { registry, websites } = await fixture(t);
  const domain = await registry.createDomain({
    serverId,
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
  });
  await assert.rejects(registry.bindWebsite(domain.id, null), code('website_binding_required'));
  await assert.rejects(registry.bindWebsite(domain.id, '2f4d1b59-b32e-42b1-83dd-a7a6151a2e5d'), code('website_not_found'));
  websites.set(otherWebsiteId, { id: otherWebsiteId, serverId: 'server-2' });
  await assert.rejects(registry.bindWebsite(domain.id, otherWebsiteId), code('website_server_mismatch'));
  assert.equal((await registry.getDomain(domain.id)).websiteId, null);
});
