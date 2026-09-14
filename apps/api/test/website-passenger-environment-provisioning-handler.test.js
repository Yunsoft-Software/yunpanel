import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePassengerEnvironmentProvisioningHandler } from '../src/website-passenger-environment-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const websiteId = '5c1c0247-139f-45d2-a6ac-c8a4bb00bc75';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';
const includePath = `/etc/yunpanel/passenger-env/${applicationId}.conf`;
const includeSha256 = 'a'.repeat(64);

function context() {
  return {
    operationId,
    websiteId,
    operation: {
      operationId,
      websiteId,
      resources: {
        application: { id: applicationId, type: 'node', runtimeAdapter: 'passenger' },
        website: { id: websiteId, applicationId, runtimeType: 'node' },
      },
    },
    intent: { adapter: 'passenger-environment', applicationId },
    evidence: null,
  };
}

function evidence(environmentRevision = 2) {
  return Object.freeze({
    satisfied: true,
    adapter: 'passenger-environment',
    applicationId,
    environmentRevision,
    environmentInclude: includePath,
    includeSha256,
    includeBytes: 120,
    variableCount: 2,
    ownedByOperation: true,
    receiptVersion: 1,
    changed: true,
  });
}

test('Passenger environment handler materializes secret values only for the host manager', async () => {
  const calls = [];
  const applicationEnvironmentRegistry = {
    environmentStatus: async (id) => {
      assert.equal(id, applicationId);
      return { savedRevision: 2 };
    },
    materialize: async (id, options) => {
      assert.equal(id, applicationId);
      assert.deepEqual(options, { expectedRevision: 2 });
      return { PUBLIC_NAME: 'yunpanel', SECRET_TOKEN: 'super-secret-value' };
    },
  };
  const environmentManager = {
    operation: async () => null,
    inspect: async () => ({ satisfied: false, reason: 'missing' }),
    apply: async (spec, options) => {
      calls.push({ spec, options });
      return evidence(spec.environmentRevision);
    },
    inspectCompensation: async () => ({ satisfied: false }),
    compensate: async () => ({ satisfied: true }),
  };
  const handler = createWebsitePassengerEnvironmentProvisioningHandler({
    applicationEnvironmentRegistry,
    environmentManager,
  });

  const result = await handler.apply(context());
  assert.equal(result.satisfied, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    spec: {
      applicationId,
      environmentRevision: 2,
      values: { PUBLIC_NAME: 'yunpanel', SECRET_TOKEN: 'super-secret-value' },
    },
    options: { operationId },
  });
  assert.equal(JSON.stringify(result).includes('super-secret-value'), false);
  assert.equal(Object.hasOwn(result, 'values'), false);
});

test('Passenger environment handler pins the durable operation revision on retry', async () => {
  const applicationEnvironmentRegistry = {
    environmentStatus: async () => ({ savedRevision: 4 }),
    materialize: async (_id, { expectedRevision }) => {
      assert.equal(expectedRevision, 4);
      return { API_MODE: 'production' };
    },
  };
  const environmentManager = {
    operation: async () => ({ environmentRevision: 4 }),
    inspect: async (spec, { operationId: receivedOperationId }) => {
      assert.equal(spec.environmentRevision, 4);
      assert.equal(receivedOperationId, operationId);
      return evidence(4);
    },
    apply: async () => { throw new Error('apply must not run when inspect is already satisfied'); },
    inspectCompensation: async () => ({ satisfied: true }),
    compensate: async () => ({ satisfied: true }),
  };
  const handler = createWebsitePassengerEnvironmentProvisioningHandler({
    applicationEnvironmentRegistry,
    environmentManager,
  });
  assert.equal((await handler.apply(context())).environmentRevision, 4);
});

test('Passenger environment handler fails closed when saved environment changes after receipt capture', async () => {
  let materialized = false;
  let hostMutation = false;
  const handler = createWebsitePassengerEnvironmentProvisioningHandler({
    applicationEnvironmentRegistry: {
      environmentStatus: async () => ({ savedRevision: 3 }),
      materialize: async () => {
        materialized = true;
        return {};
      },
    },
    environmentManager: {
      operation: async () => ({ environmentRevision: 2 }),
      inspect: async () => { hostMutation = true; return {}; },
      apply: async () => { hostMutation = true; return {}; },
      inspectCompensation: async () => ({}),
      compensate: async () => ({}),
    },
  });

  await assert.rejects(
    handler.apply(context()),
    (error) => error?.code === 'website_passenger_environment_revision_drift',
  );
  assert.equal(materialized, false);
  assert.equal(hostMutation, false);
});
