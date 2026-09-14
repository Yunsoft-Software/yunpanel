import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import {
  createStaticDeploymentLegacyFallback,
  staticDeploymentLegacyFallbackInternals,
} from '../src/static-deployment-legacy-fallback.js';

const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const BUILD_ROOT = '/var/lib/yunpanel/build';
const WEB_ROOT = '/var/www/yunpanel/apps';
const identity = createApplicationIdentity(APPLICATION_ID);
const LEGACY_HOME = `${BUILD_ROOT}/${APPLICATION_ID}`;
const CANONICAL_HOME = `/var/lib/yunpanel/data/${APPLICATION_ID}`;

function missingCommand() {
  const error = new Error('not found');
  error.code = 2;
  return error;
}

function identityRun({ home = LEGACY_HOME, groupMembers = '' } = {}) {
  return async (file, args) => {
    if (file !== staticDeploymentLegacyFallbackInternals.paths.GETENT_PATH) return { stdout: '', stderr: '' };
    if (args[0] === 'passwd') {
      return { stdout: `${identity.unixUser}:x:991:991::${home}:/usr/sbin/nologin\n`, stderr: '' };
    }
    if (args[0] === 'group') {
      return { stdout: `${identity.unixUser}:x:991:${groupMembers}\n`, stderr: '' };
    }
    throw new Error('unexpected getent query');
  };
}

test('legacy static fallback accepts only a positively verified old build-home identity', async () => {
  const calls = [];
  const manager = createStaticDeploymentLegacyFallback({
    buildRoot: BUILD_ROOT,
    webRoot: WEB_ROOT,
    run: identityRun(),
    createLegacyManager(options) {
      calls.push(['factory', options.buildRoot, options.webRoot]);
      return {
        async deployStatic(spec, execution) {
          calls.push(['deploy', spec, execution]);
          return { deploymentId: spec.deploymentId, releaseId: spec.deploymentId };
        },
      };
    },
  });
  const spec = { applicationId: APPLICATION_ID, deploymentId: '216e4db8-468b-4e2f-a021-3ab31e0f4123' };

  assert.deepEqual(await manager.inspectLegacyIdentity(APPLICATION_ID), {
    eligible: true,
    reason: null,
    applicationId: APPLICATION_ID,
    unixUser: identity.unixUser,
    uid: 991,
    gid: 991,
    homeDirectory: LEGACY_HOME,
  });
  assert.deepEqual(await manager.deployStatic(spec, { marker: true }), {
    deploymentId: spec.deploymentId,
    releaseId: spec.deploymentId,
  });
  assert.deepEqual(calls, [
    ['factory', BUILD_ROOT, WEB_ROOT],
    ['deploy', spec, { marker: true }],
  ]);
});

test('missing legacy identity fails closed instead of creating a new Unix user', async () => {
  let deployments = 0;
  const manager = createStaticDeploymentLegacyFallback({
    run: async (file) => {
      if (file === staticDeploymentLegacyFallbackInternals.paths.GETENT_PATH) throw missingCommand();
      throw new Error('unexpected command');
    },
    createLegacyManager: () => ({
      deployStatic: async () => { deployments += 1; },
    }),
  });

  await assert.rejects(
    () => manager.deployStatic({ applicationId: APPLICATION_ID }),
    { code: 'legacy_static_identity_missing' },
  );
  assert.equal(deployments, 0);
});

test('canonical persistent-data home is never mistaken for a legacy build-home identity', async () => {
  let deployments = 0;
  const manager = createStaticDeploymentLegacyFallback({
    run: identityRun({ home: CANONICAL_HOME }),
    createLegacyManager: () => ({
      deployStatic: async () => { deployments += 1; },
    }),
  });

  assert.deepEqual(await manager.inspectLegacyIdentity(APPLICATION_ID), {
    eligible: false,
    reason: 'legacy_static_identity_drift',
    applicationId: APPLICATION_ID,
    unixUser: identity.unixUser,
  });
  await assert.rejects(
    () => manager.deployStatic({ applicationId: APPLICATION_ID }),
    { code: 'legacy_static_identity_drift' },
  );
  assert.equal(deployments, 0);
});

test('legacy fallback rejects unexpected group ownership evidence', async () => {
  const manager = createStaticDeploymentLegacyFallback({
    run: identityRun({ groupMembers: 'someone-else' }),
    createLegacyManager: () => ({ deployStatic: async () => null }),
  });

  const inspected = await manager.inspectLegacyIdentity(APPLICATION_ID);
  assert.equal(inspected.eligible, false);
  assert.equal(inspected.reason, 'legacy_static_group_drift');
});

test('legacy fallback blocks useradd even after legacy identity was proven', async () => {
  const manager = createStaticDeploymentLegacyFallback({
    run: identityRun(),
    createLegacyManager: ({ run }) => ({
      deployStatic: async () => run(staticDeploymentLegacyFallbackInternals.paths.USERADD_PATH, ['should-not-run']),
    }),
  });

  await assert.rejects(
    () => manager.deployStatic({ applicationId: APPLICATION_ID }),
    { code: 'legacy_static_identity_create_forbidden' },
  );
});
