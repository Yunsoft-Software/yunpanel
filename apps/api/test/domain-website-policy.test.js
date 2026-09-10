import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = '46b95b12-600a-4f31-b269-cc9af195ee21';

function input(name = 'example.com', extra = {}) {
  return {
    serverId,
    primaryDomain: name,
    targetType: 'proxy',
    target: { upstreamPort: 4301 },
    ...extra,
  };
}

function registry(mode) {
  return createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? { id, serverId } : null,
    websiteBindingRequired: () => mode.value,
  });
}

test('compatibility mode allows legacy unbound Domain creation', async () => {
  const mode = { value: false };
  const domains = registry(mode);
  const domain = await domains.createDomain(input());
  assert.equal(domain.websiteId, null);
});

test('enforced mode rejects new unbound Domains before persistence', async () => {
  const mode = { value: true };
  const domains = registry(mode);
  await assert.rejects(
    domains.createDomain(input()),
    (error) => error instanceof DomainRegistryError && error.code === 'website_binding_required' && error.status === 409,
  );
  assert.deepEqual(await domains.listDomains(), []);
});

test('enforced mode accepts an exact same-server Website binding', async () => {
  const mode = { value: true };
  const domains = registry(mode);
  const domain = await domains.createDomain(input('site.example.com', { websiteId }));
  assert.equal(domain.websiteId, websiteId);
});

test('policy transition does not hide or strand legacy unbound state and migration bind remains available', async () => {
  const mode = { value: false };
  const domains = registry(mode);
  const legacy = await domains.createDomain(input());
  mode.value = true;

  assert.equal((await domains.getDomain(legacy.id)).websiteId, null);
  const bound = await domains.bindWebsite(legacy.id, websiteId);
  assert.equal(bound.websiteId, websiteId);

  await assert.rejects(
    domains.createDomain(input('other.example.com')),
    (error) => error instanceof DomainRegistryError && error.code === 'website_binding_required',
  );
});

test('invalid policy dependency fails closed at registry construction', () => {
  assert.throws(
    () => createDomainRegistry({ websiteBindingRequired: true }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_domain_registry_dependencies',
  );
});
