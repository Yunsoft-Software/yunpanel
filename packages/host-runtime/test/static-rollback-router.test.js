import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationIdentity } from '../src/application-identity.js';
import { createStaticRollbackRouter } from '../src/static-rollback-router.js';

const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const CURRENT_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';
const TARGET_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';
const UNIX_USER = createApplicationIdentity(APPLICATION_ID).unixUser;
const spec = Object.freeze({
  applicationId: APPLICATION_ID,
  releaseId: TARGET_RELEASE,
  currentReleaseId: CURRENT_RELEASE,
});

function result() {
  return { releaseId: TARGET_RELEASE, previousReleaseId: CURRENT_RELEASE, active: true };
}

test('static rollback verifies canonical Website identity before mutating current release', async () => {
  const calls = [];
  const router = createStaticRollbackRouter({
    canonicalIdentityManager: {
      async inspectIdentity(identity) { calls.push(['canonical', identity.applicationId]); },
    },
    legacyFallbackInspector: {
      async inspectLegacyIdentity() { calls.push(['legacy']); return { eligible: true }; },
    },
    rollbackManager: {
      async rollbackStatic(input) { calls.push(['rollback', input]); return result(); },
    },
  });

  assert.deepEqual(await router.rollbackStatic(spec), result());
  assert.deepEqual(calls, [
    ['canonical', APPLICATION_ID],
    ['rollback', spec],
  ]);
});

test('static rollback permits only positively verified legacy identity migration fallback', async () => {
  const calls = [];
  const router = createStaticRollbackRouter({
    canonicalIdentityManager: {
      async inspectIdentity() {
        throw Object.assign(new Error('canonical home drift'), { code: 'website_static_identity_drift' });
      },
    },
    legacyFallbackInspector: {
      async inspectLegacyIdentity(applicationId) {
        calls.push(['legacy', applicationId]);
        return { eligible: true };
      },
    },
    rollbackManager: {
      async rollbackStatic(input) { calls.push(['rollback', input]); return result(); },
    },
  });

  assert.deepEqual(await router.verifyIdentity(APPLICATION_ID), {
    mode: 'legacy',
    applicationId: APPLICATION_ID,
    unixUser: UNIX_USER,
  });
  calls.length = 0;
  assert.deepEqual(await router.rollbackStatic(spec), result());
  assert.equal(calls[0][0], 'legacy');
  assert.deepEqual(calls.at(-1), ['rollback', spec]);
});

test('static rollback fails closed before symlink mutation when neither identity contract is proven', async () => {
  let rollbackCalls = 0;
  const canonicalError = Object.assign(new Error('identity missing'), { code: 'website_static_identity_missing' });
  const router = createStaticRollbackRouter({
    canonicalIdentityManager: { inspectIdentity: async () => { throw canonicalError; } },
    legacyFallbackInspector: { inspectLegacyIdentity: async () => ({ eligible: false, reason: 'legacy_static_identity_missing' }) },
    rollbackManager: {
      rollbackStatic: async () => { rollbackCalls += 1; },
    },
  });

  await assert.rejects(() => router.rollbackStatic(spec), (error) => error === canonicalError);
  assert.equal(rollbackCalls, 0);
});

test('static rollback never treats canonical inspection failure as legacy eligibility', async () => {
  let legacyCalls = 0;
  let rollbackCalls = 0;
  const inspectionError = Object.assign(new Error('getent unavailable'), {
    code: 'website_static_identity_inspection_failed',
  });
  const router = createStaticRollbackRouter({
    canonicalIdentityManager: { inspectIdentity: async () => { throw inspectionError; } },
    legacyFallbackInspector: {
      inspectLegacyIdentity: async () => { legacyCalls += 1; return { eligible: true }; },
    },
    rollbackManager: {
      rollbackStatic: async () => { rollbackCalls += 1; },
    },
  });

  await assert.rejects(() => router.rollbackStatic(spec), (error) => error === inspectionError);
  assert.equal(legacyCalls, 0);
  assert.equal(rollbackCalls, 0);
});
