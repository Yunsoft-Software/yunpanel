import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';

function registry() {
  return createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? { id, serverId, runtimeType: 'php', applicationId } : null,
    websiteBindingRequired: () => true,
  });
}

test('PHP Domain stores only canonical Application identity and Website binding', async () => {
  const value = registry();
  await value.init();
  const domain = await value.createDomain({
    serverId,
    websiteId,
    primaryDomain: 'php.example.test',
    targetType: 'php',
    target: { applicationId },
  });

  assert.equal(domain.targetType, 'php');
  assert.equal(domain.websiteId, websiteId);
  assert.deepEqual(domain.target, { applicationId });
  assert.deepEqual(domain.nginxSettings, { clientMaxBodySizeMb: null, headers: [] });
});

test('PHP Domain refuses raw socket/root fields and missing Website binding', async () => {
  const value = registry();
  await value.init();

  await assert.rejects(
    value.createDomain({
      serverId,
      websiteId,
      primaryDomain: 'bad-php.example.test',
      targetType: 'php',
      target: { applicationId, socketPath: '/run/php/attacker.sock' },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'invalid_php_target',
  );

  await assert.rejects(
    value.createDomain({
      serverId,
      websiteId: null,
      primaryDomain: 'unbound-php.example.test',
      targetType: 'php',
      target: { applicationId },
    }),
    (error) => error instanceof DomainRegistryError && error.code === 'website_binding_required',
  );
});
