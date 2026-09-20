import assert from 'node:assert/strict';
import test from 'node:test';
import { createPythonRollbackManager, PythonRollbackError } from '../src/python-rollback-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const CURRENT_RELEASE = '11111111-1111-4111-8111-111111111111';
const TARGET_RELEASE = '22222222-2222-4222-8222-222222222222';

function rollbackSpec(overrides = {}) {
  return {
    applicationId: APPLICATION_ID,
    currentReleaseId: CURRENT_RELEASE,
    releaseId: TARGET_RELEASE,
    runtime: {
      pythonVersion: '3.12',
      appServer: 'gunicorn',
      entryPoint: 'app:app',
      workers: 2,
    },
    ...overrides,
  };
}

function createHarness({ releaseExists = true, restartFails = false } = {}) {
  const links = [];
  const pythonSiteManager = {
    restart: async (args) => {
      if (restartFails) throw new Error('restart failed');
      return {
        serviceName: `yunpanel-python-${args.applicationId.slice(0, 8)}.service`,
        socketPath: `/run/yunpanel/python-${args.applicationId}.sock`,
        active: true,
        healthy: true,
      };
    },
    inspect: async (args) => ({
      serviceName: `yunpanel-python-${args.applicationId.slice(0, 8)}.service`,
      socketPath: `/run/yunpanel/python-${args.applicationId}.sock`,
      active: true,
      healthy: true,
    }),
  };

  const manager = createPythonRollbackManager({
    appRoot: '/apps',
    pythonSiteManager,
    lstatFn: async () => {
      if (!releaseExists) {
        const error = new Error('not found');
        error.code = 'ENOENT';
        throw error;
      }
      return { isDirectory: () => true };
    },
    readlinkFn: async () => `releases/${CURRENT_RELEASE}`,
    renameFn: async () => {},
    symlinkFn: async (target, linkPath) => links.push({ target, linkPath }),
  });

  return { manager, links };
}

test('rollbackPython rolls back successfully', async () => {
  const harness = createHarness();
  const spec = rollbackSpec();
  const result = await harness.manager.rollbackPython(spec);

  assert.equal(result.releaseId, TARGET_RELEASE);
  assert.equal(result.active, true);
  assert.equal(result.healthy, true);
  assert.equal(result.rolledBack, true);

  // Verifies symlink was created to target release
  assert.ok(harness.links.some((l) => l.target === `releases/${TARGET_RELEASE}`));
});

test('rollbackPython fails when target release does not exist', async () => {
  const harness = createHarness({ releaseExists: false });
  const spec = rollbackSpec();

  await assert.rejects(
    () => harness.manager.rollbackPython(spec),
    (error) => error instanceof PythonRollbackError && error.code === 'target_release_not_found',
  );
});
