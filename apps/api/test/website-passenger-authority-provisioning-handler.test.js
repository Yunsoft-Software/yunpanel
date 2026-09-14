import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationRegistry } from '../src/application-registry.js';
import { createApplicationRuntimeBindingRegistry } from '../src/application-runtime-binding-registry.js';
import { createWebsitePassengerAuthorityProvisioningHandler } from '../src/website-passenger-authority-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const primaryDomainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const wwwDomainId = 'ab15fe0c-b823-49ba-986a-09b1f48de8fb';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const checksum = 'c'.repeat(64);
const environmentChecksum = 'e'.repeat(64);
const environmentInclude = `/etc/yunpanel/passenger-env/${applicationId}.conf`;
const unixUser = 'yunapp-0123456789ab';

async function fixture() {
  const applicationRegistry = createApplicationRegistry({ serverExists: async () => true });
  const application = await applicationRegistry.createNodeApplication({
    applicationId,
    serverId,
    name: 'Passenger Site',
    repositoryUrl: 'https://github.com/example/passenger-site',
    branch: 'main',
    runtimeAdapter: 'passenger',
    runtime: { nodeMajor: 24, entryFile: 'server.js' },
  });
  await applicationRegistry.activatePassengerRelease(application.id, {
    operationId,
    releaseId: operationId,
    previousReleaseId: null,
    commitSha: 'a'.repeat(40),
    runtime: application.runtime,
  });

  const website = Object.freeze({
    id: websiteId,
    serverId,
    applicationId,
    runtimeType: 'node',
    revision: 1,
    unixUser,
  });
  const activeDomain = (id) => Object.freeze({
    id,
    serverId,
    websiteId,
    targetType: 'passenger',
    target: Object.freeze({ applicationId }),
    desiredRevision: 1,
    stagedRevision: 1,
    appliedRevision: 1,
    stagedChecksum: checksum,
    state: 'active',
    lastError: null,
  });
  const domains = new Map([
    [primaryDomainId, activeDomain(primaryDomainId)],
    [wwwDomainId, activeDomain(wwwDomainId)],
  ]);
  const websiteRegistry = { getWebsite: async (id) => id === websiteId ? website : null };
  const domainRegistry = { getDomain: async (id) => domains.get(id) ?? null };
  const runtimeBindingRegistry = createApplicationRuntimeBindingRegistry();
  const handler = createWebsitePassengerAuthorityProvisioningHandler({
    applicationRegistry,
    websiteRegistry,
    domainRegistry,
    runtimeBindingRegistry,
  });
  const operation = {
    operationId,
    websiteId,
    resources: {
      application: {
        id: applicationId,
        type: 'node',
        runtimeAdapter: 'passenger',
        runtime: application.runtime,
      },
      website: {
        id: websiteId,
        serverId,
        applicationId,
        runtimeType: 'node',
        unixUser,
      },
      primaryDomain: { id: primaryDomainId },
      wwwDomain: { id: wwwDomainId },
    },
    steps: [
      {
        id: 'passenger_environment',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'passenger-environment',
          applicationId,
          environmentRevision: 2,
          environmentInclude,
          includeSha256: environmentChecksum,
        },
      },
      {
        id: 'application_release',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'passenger-application-release',
          applicationId,
          releaseId: operationId,
        },
      },
      {
        id: 'runtime',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'passenger',
          applicationId,
          releaseId: operationId,
          nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
          appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
          documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
          startupFile: 'server.js',
          unixUser,
        },
      },
      {
        id: 'nginx',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          configName: 'yunpanel-example.test.conf',
          checksum,
          active: true,
        },
      },
      {
        id: 'domain_activation',
        state: 'succeeded',
        evidence: {
          satisfied: true,
          adapter: 'domain-activation',
          websiteId,
          nginxChecksum: checksum,
          nginxConfigName: 'yunpanel-example.test.conf',
        },
      },
    ],
  };
  const context = {
    operation,
    operationId,
    websiteId,
    intent: {
      adapter: 'passenger-authority',
      applicationId,
      websiteId,
      domainIds: [primaryDomainId, wwwDomainId],
    },
    evidence: null,
  };
  return { handler, context, runtimeBindingRegistry, domains };
}

test('native Passenger authority persists canonical binding from completed provisioning evidence', async () => {
  const { handler, context, runtimeBindingRegistry } = await fixture();
  assert.equal((await handler.inspect(context)).satisfied, false);

  const applied = await handler.apply(context);
  assert.equal(applied.satisfied, true);
  assert.equal(applied.bindingRevision, 1);
  assert.equal(applied.environmentRevision, 2);
  assert.deepEqual(applied.domainIds, [wwwDomainId, primaryDomainId].sort());

  const binding = await runtimeBindingRegistry.getBinding(applicationId);
  assert.equal(binding.adapter, 'passenger');
  assert.equal(binding.state, 'active');
  assert.equal(binding.sourceOperationId, operationId);
  assert.equal(binding.releaseId, operationId);
  assert.equal(binding.websiteId, websiteId);
  assert.equal(binding.passengerTarget.environmentInclude, environmentInclude);
  assert.equal(binding.passengerTarget.user, unixUser);
  assert.deepEqual(binding.domains, [
    { domainId: wwwDomainId, desiredRevision: 1, nginxChecksum: checksum },
    { domainId: primaryDomainId, desiredRevision: 1, nginxChecksum: checksum },
  ].sort((left, right) => left.domainId.localeCompare(right.domainId)));

  assert.deepEqual(await handler.apply(context), applied);
  assert.equal((await handler.inspect(context)).satisfied, true);
});

test('Passenger authority refuses to bind when Domain activation evidence is not live anymore', async () => {
  const { handler, context, domains } = await fixture();
  domains.set(primaryDomainId, Object.freeze({
    ...domains.get(primaryDomainId),
    state: 'error',
    lastError: 'nginx_drift',
  }));
  await assert.rejects(
    handler.apply(context),
    (error) => error?.code === 'website_passenger_authority_domain_drift',
  );
});

test('Passenger authority compensation removes only the exact operation-owned binding revision', async () => {
  const { handler, context, runtimeBindingRegistry } = await fixture();
  const applied = await handler.apply(context);
  const compensationContext = { ...context, evidence: applied };

  assert.equal((await handler.inspectCompensation(compensationContext)).satisfied, false);
  const compensated = await handler.compensate(compensationContext);
  assert.equal(compensated.satisfied, true);
  assert.equal(compensated.removed, true);
  assert.equal(await runtimeBindingRegistry.getBinding(applicationId), null);
  assert.equal((await handler.compensate(compensationContext)).satisfied, true);
});

test('Passenger authority compensation fails closed after binding revision advances', async () => {
  const { handler, context, runtimeBindingRegistry } = await fixture();
  const applied = await handler.apply(context);
  const binding = await runtimeBindingRegistry.getBinding(applicationId);
  await runtimeBindingRegistry.activate({
    applicationId: binding.applicationId,
    serverId: binding.serverId,
    adapter: binding.adapter,
    state: binding.state,
    sourceOperationId: binding.sourceOperationId,
    releaseId: binding.releaseId,
    websiteId: binding.websiteId,
    websiteRevision: binding.websiteRevision,
    domains: binding.domains.map((entry, index) => index === 0
      ? { ...entry, desiredRevision: entry.desiredRevision + 1, nginxChecksum: 'd'.repeat(64) }
      : entry),
    passengerTarget: binding.passengerTarget,
  }, { expectedRevision: binding.revision });

  await assert.rejects(
    handler.compensate({ ...context, evidence: applied }),
    (error) => error?.code === 'website_passenger_authority_compensation_drift',
  );
  assert.equal((await runtimeBindingRegistry.getBinding(applicationId)).revision, 2);
});
