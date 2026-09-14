import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '@yunpanel/protocol';
import { jobReconciliationInternals, reconcileCompletedJob } from '../src/job-reconciliation.js';

const serverId = '57f8611c-0af7-4d2f-8291-2fe7dbab22fe';
const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const domainId = 'f05764d6-d5e8-4d2a-9bdd-493111b24478';
const otherDomainId = '0ec761cd-766b-43ba-8b35-066b6c832d32';
const releaseId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const jobId = 'd2fe443b-0fa6-4f98-a061-6f41b7f2684e';
const oldChecksum = 'a'.repeat(64);
const newChecksum = 'b'.repeat(64);
const otherChecksum = 'c'.repeat(64);
const passengerTarget = Object.freeze({
  appRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  documentRoot: `/var/lib/yunpanel/apps/${applicationId}/current`,
  startupFile: 'server.js',
  nodeBinary: '/opt/yunpanel/node-runtimes/v24/bin/node',
  user: 'yunapp-0123456789ab',
  group: 'yunapp-0123456789ab',
  appEnv: 'production',
  environmentInclude: `/etc/nginx/yunpanel/passenger-env/${applicationId}.conf`,
});

function stagedDomain(overrides = {}) {
  return {
    id: domainId,
    serverId,
    websiteId,
    desiredRevision: 5,
    stagedRevision: 5,
    stagedChecksum: newChecksum,
    state: 'staged',
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    applicationId,
    serverId,
    adapter: 'passenger',
    state: 'cleanup_required',
    revision: 7,
    sourceOperationId: '8d249087-73db-4ca8-8039-8e1d9aa33a42',
    releaseId,
    websiteId,
    websiteRevision: 3,
    domains: [
      { domainId, desiredRevision: 4, nginxChecksum: oldChecksum },
      { domainId: otherDomainId, desiredRevision: 2, nginxChecksum: otherChecksum },
    ],
    passengerTarget,
    ...overrides,
  };
}

function passengerStageJob(overrides = {}) {
  return {
    id: jobId,
    serverId,
    operation: OPERATIONS.DOMAIN_STAGE,
    resourceType: 'domain',
    resourceId: domainId,
    status: 'succeeded',
    payload: {
      targetType: 'passenger',
      target: {
        root: passengerTarget.appRoot,
        startupFile: passengerTarget.startupFile,
        nodeBinary: passengerTarget.nodeBinary,
      },
    },
    result: { checksum: newChecksum, configName: 'example.com.conf', bytes: 512 },
    ...overrides,
  };
}

function dependencies({ currentBinding = binding() } = {}) {
  const activations = [];
  return {
    activations,
    applicationRegistry: {
      async getApplication(id) {
        return id === applicationId ? { id: applicationId, serverId, type: 'node', currentReleaseId: releaseId } : null;
      },
    },
    websiteRegistry: {
      async getWebsite(id) {
        return id === websiteId ? { id: websiteId, serverId, revision: 3, runtimeType: 'node', applicationId } : null;
      },
    },
    runtimeBindingRegistry: {
      async getBinding(id) { return id === applicationId ? currentBinding : null; },
      async activate(input, options) {
        activations.push({ input, options });
        return { ...input, revision: (options.expectedRevision ?? 0) + 1 };
      },
    },
  };
}

test('Passenger Domain stage advances only the staged Domain binding evidence', async () => {
  const deps = dependencies();
  const result = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job: passengerStageJob(),
    domain: stagedDomain(),
    ...deps,
  });

  assert.equal(result.revision, 8);
  assert.equal(deps.activations.length, 1);
  const [{ input, options }] = deps.activations;
  assert.equal(options.expectedRevision, 7);
  assert.equal(input.state, 'cleanup_required');
  assert.equal(input.sourceOperationId, jobId);
  assert.deepEqual(input.passengerTarget, passengerTarget);
  assert.deepEqual(input.domains, [
    { domainId, desiredRevision: 5, nginxChecksum: newChecksum },
    { domainId: otherDomainId, desiredRevision: 2, nginxChecksum: otherChecksum },
  ]);
});

test('non-Passenger Domain stage leaves runtime binding untouched', async () => {
  const deps = dependencies();
  const result = await jobReconciliationInternals.reconcilePassengerDomainStageBinding({
    job: passengerStageJob({ payload: { targetType: 'proxy', target: { upstreamHost: '127.0.0.1', upstreamPort: 3100 } } }),
    domain: stagedDomain(),
    ...deps,
  });
  assert.equal(result, null);
  assert.equal(deps.activations.length, 0);
});

test('Passenger Domain stage fails closed when queued target no longer matches runtime authority', async () => {
  const deps = dependencies();
  await assert.rejects(
    jobReconciliationInternals.reconcilePassengerDomainStageBinding({
      job: passengerStageJob({
        payload: {
          targetType: 'passenger',
          target: { root: '/var/lib/yunpanel/apps/wrong/current', startupFile: 'server.js', nodeBinary: passengerTarget.nodeBinary },
        },
      }),
      domain: stagedDomain(),
      ...deps,
    }),
    (error) => error?.code === 'passenger_domain_stage_target_drift',
  );
  assert.equal(deps.activations.length, 0);
});

test('completed Passenger Domain stage updates Domain state then runtime binding evidence', async () => {
  const deps = dependencies();
  const events = [];
  const domainRegistry = {
    async markStaged(id, evidence) {
      events.push({ type: 'domain', id, evidence });
      return stagedDomain();
    },
    async markFailed() { throw new Error('markFailed should not run'); },
  };
  const runtimeBindingRegistry = {
    ...deps.runtimeBindingRegistry,
    async activate(input, options) {
      events.push({ type: 'binding', input, options });
      return { ...input, revision: options.expectedRevision + 1 };
    },
  };

  const result = await reconcileCompletedJob({
    domainRegistry,
    certificateRegistry: {},
    applicationRegistry: deps.applicationRegistry,
    websiteRegistry: deps.websiteRegistry,
    runtimeBindingRegistry,
    job: passengerStageJob(),
  });

  assert.deepEqual(result, { reconciled: true, error: null });
  assert.equal(events[0].type, 'domain');
  assert.equal(events[1].type, 'binding');
  assert.equal(events[1].input.domains[0].desiredRevision, 5);
  assert.equal(events[1].input.domains[0].nginxChecksum, newChecksum);
});