import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStaticRollbackManager,
  StaticRollbackError,
  StaticRollbackRouterError,
} from '../src/index.js';

const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const spec = Object.freeze({
  applicationId: APPLICATION_ID,
  releaseId: '216e4db8-468b-4e2f-a021-3ab31e0f4123',
  currentReleaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
});

test('host-runtime default static rollback export verifies identity before mutation', async () => {
  const calls = [];
  const manager = createStaticRollbackManager({
    canonicalIdentityManager: {
      inspectIdentity: async () => { calls.push('identity'); },
    },
    legacyFallbackInspector: {
      inspectLegacyIdentity: async () => ({ eligible: false }),
    },
    rollbackManager: {
      rollbackStatic: async (input) => {
        calls.push('rollback');
        return { releaseId: input.releaseId, previousReleaseId: input.currentReleaseId, active: true };
      },
    },
  });

  assert.deepEqual(await manager.rollbackStatic(spec), {
    releaseId: spec.releaseId,
    previousReleaseId: spec.currentReleaseId,
    active: true,
  });
  assert.deepEqual(calls, ['identity', 'rollback']);
  assert.equal(typeof StaticRollbackError, 'function');
  assert.equal(typeof StaticRollbackRouterError, 'function');
});
