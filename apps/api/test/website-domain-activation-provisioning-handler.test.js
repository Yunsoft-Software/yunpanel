import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainRegistry } from '../src/domain-registry.js';
import { createWebsiteDomainActivationProvisioningHandler } from '../src/website-domain-activation-provisioning-handler.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const primaryDomainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const wwwDomainId = 'ab15fe0c-b823-49ba-986a-09b1f48de8fb';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const checksum = 'b'.repeat(64);
const configName = 'yunpanel-example.test.conf';

async function fixture() {
  const domainRegistry = createDomainRegistry({
    serverExists: async (id) => id === serverId,
    getWebsite: async (id) => id === websiteId ? { id: websiteId, serverId } : null,
    websiteBindingRequired: () => true,
  });
  await domainRegistry.init();
  await domainRegistry.createDomain({
    domainId: primaryDomainId,
    serverId,
    websiteId,
    primaryDomain: 'example.test',
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 8080 },
  });
  await domainRegistry.createDomain({
    domainId: wwwDomainId,
    serverId,
    websiteId,
    primaryDomain: 'www.example.test',
    parentDomainId: primaryDomainId,
    targetType: 'proxy',
    target: { upstreamHost: '127.0.0.1', upstreamPort: 8080 },
  });
  const operation = {
    operationId,
    websiteId,
    resources: {
      primaryDomain: { id: primaryDomainId },
      wwwDomain: { id: wwwDomainId },
    },
    steps: [{
      id: 'nginx',
      state: 'succeeded',
      evidence: { satisfied: true, active: true, checksum, configName },
    }],
  };
  const context = {
    operation,
    operationId,
    websiteId,
    intent: {
      adapter: 'domain-activation',
      websiteId,
      domains: [
        { domainId: primaryDomainId, expectedRevision: 1 },
        { domainId: wwwDomainId, expectedRevision: 1 },
      ],
    },
    evidence: null,
  };
  return {
    domainRegistry,
    handler: createWebsiteDomainActivationProvisioningHandler({ domainRegistry }),
    context,
  };
}

test('Domain activation handler reconciles active Nginx evidence into both Domain records idempotently', async () => {
  const { domainRegistry, handler, context } = await fixture();
  const pending = await handler.inspect(context);
  assert.equal(pending.satisfied, false);
  assert.equal(pending.reason, 'website_domain_activation_pending');

  const applied = await handler.apply(context);
  assert.equal(applied.satisfied, true);
  assert.equal(applied.nginxChecksum, checksum);
  assert.equal(applied.nginxConfigName, configName);
  assert.equal((await handler.inspect(context)).satisfied, true);
  assert.deepEqual(await handler.apply(context), applied);

  for (const domainId of [primaryDomainId, wwwDomainId]) {
    const domain = await domainRegistry.getDomain(domainId);
    assert.equal(domain.state, 'active');
    assert.equal(domain.stagedRevision, 1);
    assert.equal(domain.appliedRevision, 1);
    assert.equal(domain.stagedChecksum, checksum);
    assert.equal(domain.diagnosis, null);
  }
});

test('Domain activation compensation resets both operation-owned Domain states before Nginx compensation', async () => {
  const { domainRegistry, handler, context } = await fixture();
  const applied = await handler.apply(context);
  const compensationContext = { ...context, evidence: applied };
  assert.equal((await handler.inspectCompensation(compensationContext)).satisfied, false);

  const compensated = await handler.compensate(compensationContext);
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.reset, true);
  assert.equal((await handler.compensate(compensationContext)).satisfied, true);

  for (const domainId of [primaryDomainId, wwwDomainId]) {
    const domain = await domainRegistry.getDomain(domainId);
    assert.equal(domain.state, 'draft');
    assert.equal(domain.stagedRevision, 0);
    assert.equal(domain.appliedRevision, 0);
  }
});

test('Domain activation inspect fails closed on a partially applied Domain set', async () => {
  const { domainRegistry, handler, context } = await fixture();
  await domainRegistry.markStaged(primaryDomainId, { checksum, configName });
  await domainRegistry.markApplied(primaryDomainId, { checksum });

  await assert.rejects(
    handler.inspect(context),
    (error) => error?.code === 'website_domain_activation_state_drift',
  );
});
