import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';
const otherWebsiteId = 'da25db71-1a5d-414e-af9f-f1e7f9a9baf7';

async function fixture() {
  const websites = new Map([
    [websiteId, { id: websiteId, serverId }],
    [otherWebsiteId, { id: otherWebsiteId, serverId }],
  ]);
  const registry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => websites.get(id) ?? null,
  });
  const domain = await registry.createDomain({
    serverId,
    websiteId,
    primaryDomain: 'example.com',
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    httpsMode: 'managed',
  });
  await registry.attachCertificate(domain.id, 'certificate-1');
  await registry.markStaged(domain.id, { checksum: 'a'.repeat(64), configName: 'example.conf' });
  await registry.markApplied(domain.id, { checksum: 'a'.repeat(64) });
  return { registry, domain: await registry.getDomain(domain.id) };
}

test('migration rollback clears only the exact Website relationship', async () => {
  const { registry, domain } = await fixture();
  const rolledBack = await registry.rollbackWebsiteBinding(domain.id, websiteId);
  assert.equal(rolledBack.websiteId, null);
  for (const field of [
    'primaryDomain', 'parentDomainId', 'httpsMode', 'certificateId', 'state',
    'desiredRevision', 'stagedRevision', 'stagedChecksum', 'stagedConfigName',
    'appliedRevision', 'lastAppliedAt',
  ]) assert.deepEqual(rolledBack[field], domain[field], field);
  assert.deepEqual(rolledBack.target, domain.target);
  assert.deepEqual(rolledBack.aliases, domain.aliases);
});

test('migration rollback rejects a different current Website identity', async () => {
  const { registry, domain } = await fixture();
  await assert.rejects(
    registry.rollbackWebsiteBinding(domain.id, otherWebsiteId),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_website_rollback_mismatch' && error.status === 409,
  );
  assert.equal((await registry.getDomain(domain.id)).websiteId, websiteId);
});

test('migration rollback retry is idempotent once relationship is already null', async () => {
  const { registry, domain } = await fixture();
  await registry.rollbackWebsiteBinding(domain.id, websiteId);
  const retry = await registry.rollbackWebsiteBinding(domain.id, websiteId);
  assert.equal(retry.websiteId, null);
});
