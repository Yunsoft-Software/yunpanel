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

test('external proxy targets canonicalize safe DNS and IPv6 hosts without URL injection', async () => {
  const registry = createDomainRegistry();
  const dns = await registry.createDomain({
    serverId: 'local',
    primaryDomain: 'edge.example.com',
    targetType: 'proxy',
    target: { upstreamHost: 'ORIGIN.Example.NET.', upstreamPort: 8443, websocket: false },
  });
  assert.deepEqual(dns.target, { upstreamHost: 'origin.example.net', upstreamPort: 8443, websocket: false });
  const ipv6 = await registry.createDomain({
    serverId: 'local',
    primaryDomain: 'ipv6.example.com',
    targetType: 'proxy',
    target: { upstreamHost: '[2001:0DB8:0:0:0:0:0:1]', upstreamPort: 8080 },
  });
  assert.equal(ipv6.target.upstreamHost, '2001:db8::1');

  await assert.rejects(
    registry.createDomain({
      serverId: 'local',
      primaryDomain: 'unsafe.example.com',
      targetType: 'proxy',
      target: { upstreamHost: 'https://origin.example.net/path', upstreamPort: 8443 },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_upstream_host',
  );
});

test('internal deterministic Domain identity is idempotent without resetting applied state', async () => {
  const registry = createDomainRegistry();
  const domainId = '234cd749-403d-4bb1-b122-5693d36af3fe';
  const input = {
    domainId,
    serverId: 'local',
    primaryDomain: 'stable.example.com',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 3100 },
  };
  const created = await registry.createDomain(input);
  await registry.markStaged(created.id, {
    revision: created.desiredRevision,
    checksum: 'a'.repeat(64),
    configName: 'stable.example.com.conf',
  });
  await registry.markApplied(created.id, { checksum: 'a'.repeat(64) });

  const retried = await registry.createDomain(input);
  assert.equal(retried.id, domainId);
  assert.equal(retried.state, 'active');
  assert.equal(retried.appliedRevision, 1);
  assert.equal((await registry.listDomains()).length, 1);

  await assert.rejects(
    registry.createDomain({ ...input, primaryDomain: 'reused.example.com' }),
    (error) => error instanceof DomainRegistryError && error.code === 'domain_identity_conflict' && error.status === 409,
  );
});
