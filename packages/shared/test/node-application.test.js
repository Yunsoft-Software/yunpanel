import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApplicationValidationError,
  normalizeNodeApplicationSpec,
  normalizeNodeProcessSpec,
  normalizeNodeRuntimeConfig,
} from '../src/index.js';

test('normalizes structured Node runtime profiles without arbitrary commands', () => {
  assert.deepEqual(normalizeNodeRuntimeConfig({ port: 3100 }), {
    nodeMajor: 24,
    packageManager: 'npm',
    installMode: 'ci',
    buildScript: null,
    mode: 'production',
    documentRoot: '.',
    start: {
      mode: 'node',
      entryFile: 'server.js',
      script: null,
    },
    port: 3100,
    healthPath: '/health',
    healthTimeoutSeconds: 30,
    restartPolicy: 'on-failure',
  });

  const npmRuntime = normalizeNodeRuntimeConfig({
    nodeMajor: 24,
    packageManager: 'pnpm',
    installMode: 'install',
    buildScript: 'build:prod',
    mode: 'development',
    documentRoot: 'services/api',
    startMode: 'npm',
    startScript: 'start:prod',
    port: 4200,
    healthPath: '/api/health',
    healthTimeoutSeconds: 45,
    restartPolicy: 'always',
  });
  assert.equal(npmRuntime.start.mode, 'npm');
  assert.equal(npmRuntime.start.script, 'start:prod');
  assert.equal(npmRuntime.buildScript, 'build:prod');
  assert.equal(npmRuntime.packageManager, 'pnpm');
  assert.equal(npmRuntime.mode, 'development');
  assert.equal(npmRuntime.documentRoot, 'services/api');
});

test('normalized Node runtime profiles can be normalized again without losing startup state', () => {
  const nodeRuntime = normalizeNodeRuntimeConfig({
    nodeMajor: 24,
    installMode: 'ci',
    buildScript: 'build',
    startMode: 'node',
    entryFile: 'dist/server.js',
    port: 3100,
    healthPath: '/healthz',
  });
  assert.deepEqual(normalizeNodeRuntimeConfig(nodeRuntime), nodeRuntime);

  const npmRuntime = normalizeNodeRuntimeConfig({
    nodeMajor: 24,
    installMode: 'install',
    startMode: 'npm',
    startScript: 'serve:production',
    port: 4100,
  });
  assert.deepEqual(normalizeNodeRuntimeConfig(npmRuntime), npmRuntime);
});

test('rejects shell fragments, unsafe entry files, ports and health URLs', () => {
  const invalidProfiles = [
    { port: 3000, startMode: 'npm', startScript: 'start && id' },
    { port: 3000, startMode: 'node', entryFile: '../server.js' },
    { port: 80 },
    { port: 3000, healthPath: 'https://example.com/health' },
    { port: 3000, healthPath: '/health?token=x' },
    { port: 3000, start: 'node server.js' },
    { port: 3000, packageManager: 'bun' },
    { port: 3000, mode: 'staging' },
    { port: 3000, documentRoot: '../service' },
    { port: 3000, command: 'node server.js' },
    { port: 3000, start: { mode: 'node', entryFile: 'server.js', shell: true } },
  ];

  for (const profile of invalidProfiles) {
    assert.throws(() => normalizeNodeRuntimeConfig(profile), ApplicationValidationError);
  }
});

test('normalizes complete Node deployment specs', () => {
  const spec = normalizeNodeApplicationSpec({
    applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
    deploymentId: 'ff830043-9752-4640-83b4-3a1998de78a0',
    repositoryUrl: 'https://github.com/example/node-app',
    branch: 'production',
    gitTarget: { kind: 'tag', value: 'v3.2.1' },
    runtime: {
      nodeMajor: 24,
      buildScript: 'build',
      startMode: 'node',
      entryFile: 'dist/server.js',
      port: 3100,
    },
    retention: 4,
  });

  assert.equal(spec.repositoryUrl, 'https://github.com/example/node-app.git');
  assert.deepEqual(spec.gitTarget, { kind: 'tag', value: 'v3.2.1' });
  assert.equal(spec.runtime.start.entryFile, 'dist/server.js');
  assert.equal(spec.runtime.port, 3100);
  assert.equal(spec.retention, 4);
});

test('normalizes fixed Node process actions against a managed release', () => {
  const spec = normalizeNodeProcessSpec({
    applicationId: '9d4a4727-1aba-4d35-95fe-21db67042ce9',
    releaseId: 'ff830043-9752-4640-83b4-3a1998de78a0',
    runtime: { port: 3100 },
    action: 'enable',
  });
  assert.equal(spec.action, 'enable');
  assert.equal(spec.runtime.port, 3100);
  assert.throws(() => normalizeNodeProcessSpec({ ...spec, action: 'restart' }), ApplicationValidationError);
  assert.throws(() => normalizeNodeProcessSpec({ ...spec, command: 'whoami' }), ApplicationValidationError);
});
