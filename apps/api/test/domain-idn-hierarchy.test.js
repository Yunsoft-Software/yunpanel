import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';

const base = (primaryDomain, extra = {}) => ({
  serverId: 'server-1',
  primaryDomain,
  targetType: 'proxy',
  target: { upstreamPort: 4301 },
  ...extra,
});

test('IDN parent and child persist in one canonical punycode hierarchy', async () => {
  const registry = createDomainRegistry();
  const root = await registry.createDomain(base('BÜCHER.example'));
  const child = await registry.createDomain(base('api.bücher.example', { parentDomainId: root.id, target: { upstreamPort: 4302 } }));

  assert.equal(root.primaryDomain, 'xn--bcher-kva.example');
  assert.equal(child.primaryDomain, 'api.xn--bcher-kva.example');
  assert.equal(child.parentDomainId, root.id);
  assert.equal(child.kind, 'subdomain');
});

test('Unicode and punycode equivalents collide as the same managed hostname', async () => {
  const registry = createDomainRegistry();
  await registry.createDomain(base('bücher.example'));
  await assert.rejects(
    registry.createDomain(base('XN--BCHER-KVA.EXAMPLE.')),
    { code: 'domain_conflict' },
  );
});

test('IDN aliases are canonical before duplicate checks', async () => {
  const registry = createDomainRegistry();
  const domain = await registry.createDomain(base('example.com', {
    aliases: ['shop.bücher.example', 'SHOP.XN--BCHER-KVA.EXAMPLE.'],
  }));
  assert.deepEqual(domain.aliases, ['shop.xn--bcher-kva.example']);
});
