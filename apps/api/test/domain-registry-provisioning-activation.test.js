import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry, DomainRegistryError } from '../src/domain-registry.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const primaryDomainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const wwwDomainId = 'ab15fe0c-b823-49ba-986a-09b1f48de8fb';
const checksum = 'a'.repeat(64);
const configName = 'yunpanel-example.test.conf';

async function fixture({ managedHttps = false } = {}) {
  const registry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? { id: websiteId, serverId } : null,
    websiteBindingRequired: () => true,
  });
  await registry.init();
  await registry.createDomain({
    domainId: primaryDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.test',
    targetType: 'static',
    target: { root: '/var/www/example/current' },
    httpsMode: managedHttps ? 'managed' : 'off',
  });
  await registry.createDomain({
    domainId: wwwDomainId,
    serverId,
    websiteId,
    primaryDomain: 'www.example.test',
    parentDomainId: primaryDomainId,
    targetType: 'static',
    target: { root: '/var/www/example/current' },
    httpsMode: managedHttps ? 'managed' : 'off',
  });
  return registry;
}

function activationInput() {
  return {
    websiteId,
    domains: [
      { domainId: primaryDomainId, expectedRevision: 1 },
      { domainId: wwwDomainId, expectedRevision: 1 },
    ],
    checksum,
    configName,
  };
}

test('initial Website Domains become staged and applied in one idempotent activation', async () => {
  const registry = await fixture();
  const activated = await registry.activateProvisionedDomains(activationInput());
  assert.equal(activated.length, 2);
  for (const domain of activated) {
    assert.equal(domain.state, 'active');
    assert.equal(domain.desiredRevision, 1);
    assert.equal(domain.stagedRevision, 1);
    assert.equal(domain.appliedRevision, 1);
    assert.equal(domain.stagedChecksum, checksum);
    assert.equal(domain.stagedConfigName, configName);
    assert.equal(domain.appliedPrimaryDomain, domain.primaryDomain);
    assert.equal(domain.diagnosis, null);
  }
  const retried = await registry.activateProvisionedDomains(activationInput());
  assert.deepEqual(retried, activated);
});

test('operation-owned initial Domain activation can be atomically reset before later mutations', async () => {
  const registry = await fixture();
  await registry.activateProvisionedDomains(activationInput());
  const reset = await registry.resetProvisionedDomains(activationInput());
  for (const domain of reset) {
    assert.equal(domain.state, 'draft');
    assert.equal(domain.desiredRevision, 1);
    assert.equal(domain.stagedRevision, 0);
    assert.equal(domain.appliedRevision, 0);
    assert.equal(domain.stagedChecksum, null);
    assert.equal(domain.stagedConfigName, null);
    assert.equal(domain.appliedPrimaryDomain, null);
    assert.equal(domain.diagnosis.code, 'domain_stage_required');
  }
  assert.deepEqual(await registry.resetProvisionedDomains(activationInput()), reset);
});

test('Domain activation and compensation validate the whole Domain set before mutating any member', async () => {
  const registry = await fixture({ managedHttps: true });
  await registry.attachCertificate(primaryDomainId, 'certificate-1');

  await assert.rejects(
    registry.activateProvisionedDomains(activationInput()),
    (error) => error instanceof DomainRegistryError && error.code === 'provisioned_domain_state_drift',
  );
  const untouchedWww = await registry.getDomain(wwwDomainId);
  assert.equal(untouchedWww.stagedRevision, 0);
  assert.equal(untouchedWww.appliedRevision, 0);

  const clean = await fixture({ managedHttps: true });
  await clean.activateProvisionedDomains(activationInput());
  await clean.attachCertificate(primaryDomainId, 'certificate-2');
  await assert.rejects(
    clean.resetProvisionedDomains(activationInput()),
    (error) => error instanceof DomainRegistryError && error.code === 'provisioned_domain_compensation_drift',
  );
  const stillActiveWww = await clean.getDomain(wwwDomainId);
  assert.equal(stillActiveWww.state, 'active');
  assert.equal(stillActiveWww.appliedRevision, 1);
});
