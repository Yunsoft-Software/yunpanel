import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticDeploymentManager } from '../src/static-deployment-manager.js';

const APPLICATION_ID = '2f334b35-03ce-4aa0-a8e4-b2ad4f592541';
const DEPLOYMENT_ID = '216e4db8-468b-4e2f-a021-3ab31e0f4123';

test('static deployment restores traversable shared-root modes under a restrictive agent umask', async () => {
  const chmodCalls = [];
  const manager = createStaticDeploymentManager({
    buildRoot: '/srv/yunpanel/build',
    webRoot: '/srv/yunpanel/web/apps',
    run: async (_file, args) => {
      if (args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      if (args.includes('/worker.js')) {
        return { stdout: JSON.stringify({ files: 2, directories: 1, bytes: 512, healthFile: 'index.html' }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    accessFn: async () => {},
    chmodFn: async (target, mode) => chmodCalls.push([target, mode]),
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, mtimeMs: 1 }),
    mkdirFn: async () => {},
    readlinkFn: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    realpathFn: async (target) => target,
    readdirFn: async () => [],
    renameFn: async () => {},
    rmFn: async () => {},
    symlinkFn: async () => {},
    nodePath: '/usr/local/bin/node',
    artifactWorkerPath: '/worker.js',
  });

  const result = await manager.deployStatic({
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    repositoryUrl: 'https://github.com/example/static-site',
    branch: 'main',
    build: { mode: 'none', outputDir: '.', healthFile: 'index.html' },
    retention: 5,
  });

  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.deepEqual(chmodCalls.filter(([, mode]) => mode === 0o711), [
    ['/srv/yunpanel/build', 0o711],
    ['/srv/yunpanel/web', 0o711],
    ['/srv/yunpanel/web/apps', 0o711],
  ]);
  assert.ok(chmodCalls.some(([target, mode]) => target === `/srv/yunpanel/web/apps/${APPLICATION_ID}` && mode === 0o755));
  assert.ok(chmodCalls.some(([target, mode]) => target === `/srv/yunpanel/web/apps/${APPLICATION_ID}/releases` && mode === 0o755));
});
