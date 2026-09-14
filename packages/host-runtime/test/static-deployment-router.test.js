import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticDeploymentRouter } from '../src/static-deployment-router.js';

const spec = Object.freeze({ applicationId: '2f334b35-03ce-4aa0-a8e4-b2ad4f592541' });

test('static deployment router prefers the canonical Website identity path', async () => {
  const calls = [];
  const router = createStaticDeploymentRouter({
    websiteManager: {
      async deployStatic(input, options) {
        calls.push(['canonical', input, options]);
        return { route: 'canonical' };
      },
    },
    legacyFallbackManager: {
      async deployStatic() {
        calls.push(['legacy']);
        return { route: 'legacy' };
      },
    },
  });

  assert.deepEqual(await router.deployStatic(spec, { marker: true }), { route: 'canonical' });
  assert.deepEqual(calls, [['canonical', spec, { marker: true }]]);
});

test('static deployment router uses proven legacy fallback only for identity migration states', async () => {
  const calls = [];
  for (const code of ['website_static_identity_missing', 'website_static_identity_drift']) {
    const router = createStaticDeploymentRouter({
      websiteManager: {
        async deployStatic() {
          calls.push(['canonical', code]);
          throw Object.assign(new Error('canonical identity unavailable'), { code });
        },
      },
      legacyFallbackManager: {
        async deployStatic(input, options) {
          calls.push(['legacy', code, input, options]);
          return { route: 'legacy', code };
        },
      },
    });
    assert.deepEqual(await router.deployStatic(spec, { marker: code }), { route: 'legacy', code });
  }
  assert.equal(calls.filter(([route]) => route === 'legacy').length, 2);
});

test('static deployment router preserves canonical identity failure when legacy ownership is unproven', async () => {
  const canonicalError = Object.assign(new Error('canonical identity missing'), {
    code: 'website_static_identity_missing',
  });
  const router = createStaticDeploymentRouter({
    websiteManager: { deployStatic: async () => { throw canonicalError; } },
    legacyFallbackManager: {
      deployStatic: async () => {
        throw Object.assign(new Error('legacy identity missing'), { code: 'legacy_static_identity_missing' });
      },
    },
  });

  await assert.rejects(() => router.deployStatic(spec), (error) => error === canonicalError);
});

test('static deployment router never falls back after a non-identity deployment failure', async () => {
  let legacyCalls = 0;
  const buildError = Object.assign(new Error('npm failed'), { code: 'deployment_command_failed' });
  const router = createStaticDeploymentRouter({
    websiteManager: { deployStatic: async () => { throw buildError; } },
    legacyFallbackManager: {
      deployStatic: async () => { legacyCalls += 1; },
    },
  });

  await assert.rejects(() => router.deployStatic(spec), (error) => error === buildError);
  assert.equal(legacyCalls, 0);
});
