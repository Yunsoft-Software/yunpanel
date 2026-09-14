import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStaticDeploymentManager,
  StaticDeploymentError,
  StaticDeploymentRouterError,
} from '../src/index.js';

const spec = Object.freeze({ applicationId: '2f334b35-03ce-4aa0-a8e4-b2ad4f592541' });

test('host-runtime default static deployment export is the canonical-first router', async () => {
  let legacyCalls = 0;
  const manager = createStaticDeploymentManager({
    websiteManager: {
      deployStatic: async () => ({ route: 'canonical' }),
    },
    legacyFallbackManager: {
      deployStatic: async () => {
        legacyCalls += 1;
        return { route: 'legacy' };
      },
    },
  });

  assert.deepEqual(await manager.deployStatic(spec), { route: 'canonical' });
  assert.equal(legacyCalls, 0);
  assert.equal(typeof StaticDeploymentError, 'function');
  assert.equal(typeof StaticDeploymentRouterError, 'function');
});
