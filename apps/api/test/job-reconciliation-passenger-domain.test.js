import assert from 'node:assert/strict';
import test from 'node:test';
import { jobReconciliationInternals } from '../src/job-reconciliation.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const sourceOperationId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const stageJobId = '2be5b32f-af61-4b61-b8da-d4a3ecdb6fa4';

const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: null,
});

test('Passenger Domain restage advances evidence without replacing authority source operation', async () => {
  const domain = {
    id: domainId,
    serverId,
    websiteId,
    desiredRevision: 2,
  };
  const website = {
    id: websiteId,
    serverId,
    runtimeType: 'node',
    applicationId,
    revision: 1,
  };
  const application = {
    id: applicationId,
    serverId,
    type: 'node',
    currentReleaseId: releaseId,
  };
  const binding = {
    applicationId,
    serverId,
    adapter: 'passenger',
    state: 'active',
    revision: 4,
    sourceOperationId,
    releaseId,
    websiteId,
    websiteRevision: 1,
    domains: [{ domainId, desiredRevision: 1, nginxChecksum: 'a'.repeat(64) }],
    passengerTarget,
  };
  let activation = null;
  const runtimeBindingRegistry = {
    getBinding: async () => binding,
    activate: async (input, options) => {
      activation = { input, options };
      return { ...input, revision: options.expectedRevision + 1 };
    },
  };
  const job = {
    id: stageJobId,
    serverId,
    resourceId: domainId,
    payload: {
      targetType: 'passenger',
      target: {
        root: passengerTarget.appRoot,
        startupFile: passengerTarget.startupFile,
        nodeBinary: passengerTarget.nodeBinary,
      },
    },
    result: { checksum: 'b'.repeat(64) },
  };

  await jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job,
    domain,
    applicationRegistry: { getApplication: async () => application },
    websiteRegistry: { getWebsite: async () => website },
    runtimeBindingRegistry,
  });

  assert.equal(activation.options.expectedRevision, 4);
  assert.equal(activation.input.sourceOperationId, sourceOperationId);
  assert.notEqual(activation.input.sourceOperationId, stageJobId);
  assert.deepEqual(activation.input.domains, [{
    domainId,
    desiredRevision: 2,
    nginxChecksum: 'b'.repeat(64),
  }]);
});
