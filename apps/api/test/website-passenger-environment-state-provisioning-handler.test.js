import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePassengerEnvironmentStateProvisioningHandler } from '../src/website-passenger-environment-state-provisioning-handler.js';

const applicationId = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const operationId = 'ff830043-9752-4640-83b4-3a1998de78a0';

function context() {
  return {
    operationId,
    operation: {
      operationId,
      resources: {
        application: { id: applicationId, type: 'node', runtimeAdapter: 'passenger' },
      },
      steps: [
        {
          id: 'passenger_environment',
          state: 'succeeded',
          evidence: {
            satisfied: true,
            adapter: 'passenger-environment',
            applicationId,
            environmentRevision: 3,
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
      ],
    },
    intent: { adapter: 'passenger-environment-state', applicationId },
  };
}

test('Passenger environment state marks the pinned revision applied to the current release', async () => {
  let status = {
    savedRevision: 3,
    appliedRevision: null,
    appliedReleaseId: null,
    appliedToRunningProcess: false,
  };
  const calls = [];
  const handler = createWebsitePassengerEnvironmentStateProvisioningHandler({
    applicationRegistry: {
      getApplication: async () => ({ id: applicationId, type: 'node', runtimeAdapter: 'passenger', currentReleaseId: operationId }),
    },
    applicationEnvironmentRegistry: {
      environmentStatus: async (_id, options) => {
        assert.deepEqual(options, { currentReleaseId: operationId });
        return { ...status };
      },
      markApplied: async (input) => {
        calls.push(input);
        status = {
          ...status,
          appliedRevision: input.revision,
          appliedReleaseId: input.releaseId,
          appliedToRunningProcess: true,
        };
        return { ...status };
      },
    },
  });

  assert.equal((await handler.inspect(context())).satisfied, false);
  const applied = await handler.apply(context());
  assert.equal(applied.satisfied, true);
  assert.equal(applied.environmentRevision, 3);
  assert.deepEqual(calls, [{ applicationId, revision: 3, releaseId: operationId }]);
  assert.deepEqual(await handler.apply(context()), applied);
  assert.equal(calls.length, 1);
});

test('Passenger environment state fails closed when saved environment changes before reconciliation', async () => {
  let marked = false;
  const handler = createWebsitePassengerEnvironmentStateProvisioningHandler({
    applicationRegistry: {
      getApplication: async () => ({ id: applicationId, type: 'node', runtimeAdapter: 'passenger', currentReleaseId: operationId }),
    },
    applicationEnvironmentRegistry: {
      environmentStatus: async () => ({
        savedRevision: 4,
        appliedRevision: null,
        appliedReleaseId: null,
        appliedToRunningProcess: false,
      }),
      markApplied: async () => { marked = true; },
    },
  });

  await assert.rejects(
    handler.apply(context()),
    (error) => error?.code === 'website_passenger_environment_state_revision_drift',
  );
  assert.equal(marked, false);
});

test('Passenger environment state refuses to overwrite unrelated applied metadata', async () => {
  let marked = false;
  const handler = createWebsitePassengerEnvironmentStateProvisioningHandler({
    applicationRegistry: {
      getApplication: async () => ({ id: applicationId, type: 'node', runtimeAdapter: 'passenger', currentReleaseId: operationId }),
    },
    applicationEnvironmentRegistry: {
      environmentStatus: async () => ({
        savedRevision: 3,
        appliedRevision: 2,
        appliedReleaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
        appliedToRunningProcess: false,
      }),
      markApplied: async () => { marked = true; },
    },
  });

  await assert.rejects(
    handler.apply(context()),
    (error) => error?.code === 'website_passenger_environment_state_applied_drift',
  );
  assert.equal(marked, false);
});
