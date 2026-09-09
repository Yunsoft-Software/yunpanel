import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticRollbackManager, StaticRollbackError } from '../src/static-rollback-manager.js';

const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const CURRENT_RELEASE = 'ff830043-9752-4640-83b4-3a1998de78a0';
const TARGET_RELEASE = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

test('rollback atomically switches current symlink to an existing retained release', async () => {
  const calls = [];
  const manager = createStaticRollbackManager({
    lstatFn: async (target) => {
      calls.push(['lstat', target]);
      return { isDirectory: () => true, isSymbolicLink: () => false };
    },
    readlinkFn: async () => `releases/${CURRENT_RELEASE}`,
    mkdirFn: async (...args) => calls.push(['mkdir', ...args]),
    rmFn: async (...args) => calls.push(['rm', ...args]),
    symlinkFn: async (...args) => calls.push(['symlink', ...args]),
    renameFn: async (...args) => calls.push(['rename', ...args]),
  });

  const result = await manager.rollbackStatic({
    applicationId: APPLICATION_ID,
    releaseId: TARGET_RELEASE,
    currentReleaseId: CURRENT_RELEASE,
  });

  assert.deepEqual(result, {
    releaseId: TARGET_RELEASE,
    previousReleaseId: CURRENT_RELEASE,
    active: true,
  });
  const symlink = calls.find((call) => call[0] === 'symlink');
  assert.equal(symlink[1], `releases/${TARGET_RELEASE}`);
  const rename = calls.find((call) => call[0] === 'rename');
  assert.ok(rename[1].endsWith(`.rollback-${TARGET_RELEASE}`));
  assert.ok(rename[2].endsWith('/current'));
});

test('rollback rejects missing, symbolic and already-active releases', async () => {
  const missing = createStaticRollbackManager({
    lstatFn: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
  });
  await assert.rejects(
    missing.rollbackStatic({ applicationId: APPLICATION_ID, releaseId: TARGET_RELEASE, currentReleaseId: CURRENT_RELEASE }),
    (error) => error instanceof StaticRollbackError && error.code === 'rollback_release_missing',
  );

  const symbolic = createStaticRollbackManager({
    lstatFn: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
  });
  await assert.rejects(
    symbolic.rollbackStatic({ applicationId: APPLICATION_ID, releaseId: TARGET_RELEASE, currentReleaseId: CURRENT_RELEASE }),
    (error) => error instanceof StaticRollbackError && error.code === 'rollback_release_invalid',
  );

  const current = createStaticRollbackManager({
    lstatFn: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readlinkFn: async () => `releases/${TARGET_RELEASE}`,
  });
  await assert.rejects(
    current.rollbackStatic({ applicationId: APPLICATION_ID, releaseId: TARGET_RELEASE, currentReleaseId: TARGET_RELEASE }),
    (error) => error instanceof StaticRollbackError && error.code === 'rollback_target_current',
  );
});

test('rollback rejects release drift before mutating the application root', async () => {
  const mutationCalls = [];
  const manager = createStaticRollbackManager({
    lstatFn: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    readlinkFn: async () => `releases/${CURRENT_RELEASE}`,
    mkdirFn: async (...args) => mutationCalls.push(['mkdir', ...args]),
    rmFn: async (...args) => mutationCalls.push(['rm', ...args]),
    symlinkFn: async (...args) => mutationCalls.push(['symlink', ...args]),
    renameFn: async (...args) => mutationCalls.push(['rename', ...args]),
  });

  await assert.rejects(
    manager.rollbackStatic({
      applicationId: APPLICATION_ID,
      releaseId: TARGET_RELEASE,
      currentReleaseId: 'f8343982-05bc-48a7-9c50-979d85abf191',
    }),
    (error) => error instanceof StaticRollbackError && error.code === 'static_rollback_release_drift',
  );
  assert.deepEqual(mutationCalls, []);
});
