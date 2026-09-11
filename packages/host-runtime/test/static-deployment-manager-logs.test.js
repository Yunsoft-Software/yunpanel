import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaticDeploymentManager } from '../src/static-deployment-manager.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';
const DEPLOYMENT_ID = 'ff830043-9752-4640-83b4-3a1998de78a0';

test('static deploy emits Git/dependency/build output and completion through the optional private sink', async () => {
  const logs = [];
  const run = async (file, args) => {
    if (file === '/usr/sbin/runuser' && args.includes('rev-parse')) return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    if (file === '/usr/sbin/runuser' && args.includes('fetch')) return { stdout: '', stderr: 'fetch output\n' };
    if (file === '/usr/sbin/runuser' && args.includes('/usr/bin/npm')) return { stdout: 'npm output\n', stderr: '' };
    if (file === '/usr/sbin/runuser' && args.includes('/usr/bin/node')) {
      return { stdout: JSON.stringify({ files: 1, bytes: 12, healthFile: 'index.html' }), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  const manager = createStaticDeploymentManager({
    buildRoot: '/build',
    webRoot: '/web',
    nodePath: '/usr/bin/node',
    npmPaths: ['/usr/bin/npm'],
    run,
    recordLog: async (entry) => logs.push(entry),
    accessFn: async (target) => { if (target.endsWith('/.git')) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    chmodFn: async () => {},
    lstatFn: async () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, mtimeMs: 1 }),
    mkdirFn: async () => {},
    readlinkFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    realpathFn: async (target) => target,
    readdirFn: async () => [],
    renameFn: async () => {},
    rmFn: async () => {},
    symlinkFn: async () => {},
    writeFileFn: async () => {},
  });
  const result = await manager.deployStatic({
    applicationId: APPLICATION_ID,
    deploymentId: DEPLOYMENT_ID,
    repositoryUrl: 'https://github.com/example/static-app',
    branch: 'main',
    build: { mode: 'npm', installMode: 'ci', buildScript: 'build', outputDir: 'dist', healthFile: 'index.html' },
    retention: 5,
  });
  assert.equal(result.releaseId, DEPLOYMENT_ID);
  assert.ok(logs.some((entry) => entry.stage === 'git' && entry.level === 'warning' && entry.message.includes('fetch output')));
  assert.ok(logs.some((entry) => entry.stage === 'dependencies' && entry.message.includes('npm output')));
  assert.ok(logs.some((entry) => entry.stage === 'build' && entry.message.includes('npm output')));
  assert.ok(logs.some((entry) => entry.stage === 'complete'));
  assert.equal(logs.every((entry) => entry.jobId === DEPLOYMENT_ID), true);
});
