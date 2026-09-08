import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

test('creates normalized domain desired state for an existing server', async () => {
  const registry = createDomainRegistry({ serverExists: async (serverId) => serverId === 'server-1' });
  const domain = await registry.createDomain({
    serverId: 'server-1',
    primaryDomain: 'Example.COM',
    aliases: ['www.example.com', 'WWW.EXAMPLE.COM.'],
    targetType: 'static',
    target: { root: '/var/lib/yunpanel/apps/example/current', spaFallback: true },
  });

  assert.equal(domain.primaryDomain, 'example.com');
  assert.deepEqual(domain.aliases, ['www.example.com']);
  assert.equal(domain.state, 'draft');
  assert.equal(domain.desiredRevision, 1);
  assert.equal(domain.appliedRevision, 0);
});

test('rejects duplicate primary domains and aliases across records', async () => {
  const registry = createDomainRegistry({ serverExists: async () => true });
  await registry.createDomain({
    serverId: 'server-1',
    primaryDomain: 'example.com',
    aliases: ['www.example.com'],
    targetType: 'proxy',
    target: { upstreamPort: 3000 },
  });

  await assert.rejects(
    registry.createDomain({
      serverId: 'server-2',
      primaryDomain: 'www.example.com',
      targetType: 'proxy',
      target: { upstreamPort: 3001 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_conflict' && error.status === 409,
  );
});

test('rejects domains for unknown servers and unsafe target values', async () => {
  const registry = createDomainRegistry({ serverExists: async () => false });
  await assert.rejects(
    registry.createDomain({
      serverId: 'missing',
      primaryDomain: 'example.com',
      targetType: 'proxy',
      target: { upstreamPort: 3000 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'server_not_found',
  );

  const existingServerRegistry = createDomainRegistry({ serverExists: async () => true });
  await assert.rejects(
    existingServerRegistry.createDomain({
      serverId: 'server-1',
      primaryDomain: 'api.example.com',
      targetType: 'proxy',
      target: { upstreamPort: 80 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_upstream_port',
  );
});
