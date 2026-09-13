import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeManager,
  DockerComposeManagerError,
  dockerComposeManagerInternals,
} from '../src/docker-compose-manager.js';

const document = 'services:\n  web:\n    image: example/web:1\n';
const digest = 'a'.repeat(64);

function input(overrides = {}) {
  return {
    projectId: 'project-0001',
    projectName: 'shop_app',
    projectRevision: 3,
    environmentRevision: 2,
    composeSha256: digest,
    document,
    environment: { APP_MODE: 'production' },
    credentials: [{ registryHost: 'registry.example', username: 'build-user', secret: 'credential-value' }],
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-manager-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const manager = createDockerComposeManager({
    root,
    randomSuffix: () => 'fixed',
    accessFn: async (candidate) => {
      if (candidate !== '/usr/bin/docker') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    validateCompose: async (request) => {
      calls.push(['validate', request]);
      return { validated: true };
    },
    execFn: async (file, args, options) => {
      const composePath = args[args.indexOf('-f') + 1];
      const projectDirectory = args[args.indexOf('--project-directory') + 1];
      const configPath = path.join(options.env.DOCKER_CONFIG, 'config.json');
      calls.push(['exec', file, [...args], { ...options.env }, options.cwd]);
      assert.equal((await stat(composePath)).mode & 0o777, 0o600);
      assert.equal((await stat(options.env.DOCKER_CONFIG)).mode & 0o777, 0o700);
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal((await stat(projectDirectory)).mode & 0o777, 0o700);
      assert.equal(await readFile(composePath, 'utf8'), document);
      assert.match(await readFile(configPath, 'utf8'), /registry\.example/);
      assert.equal(args.includes('credential-value'), false);
      assert.equal(args.includes('build-user'), false);
      assert.equal(options.cwd, projectDirectory);
    },
  });
  return { root, calls, manager };
}

async function assertPrivateStagingClean(root) {
  assert.deepEqual(await readdir(path.join(root, 'runs')), []);
}

test('compose manager separates private staging from the persistent project workspace', async (t) => {
  const fx = await fixture(t);
  const request = input({ composeSha256: await import('node:crypto').then(({ createHash }) => createHash('sha256').update(document).digest('hex')) });
  const result = await fx.manager.start(request);
  const execution = fx.calls.find(([name]) => name === 'exec');
  const projectDirectory = dockerComposeManagerInternals.projectWorkspacePath(fx.root, request.projectId);
  assert.deepEqual(execution[2].slice(-4), ['up', '-d', '--no-build', '--remove-orphans']);
  assert.equal(execution[2][execution[2].indexOf('--project-directory') + 1], projectDirectory);
  assert.equal(execution[4], projectDirectory);
  assert.equal(execution[3].APP_MODE, 'production');
  assert.equal(execution[3].PATH, '/usr/bin:/bin');
  assert.equal(result.action, 'start');
  assert.equal(result.runtimeState, 'running');
  assert.equal(result.executed, true);
  assert.equal(JSON.stringify(result).includes('credential-value'), false);
  assert.equal(JSON.stringify(result).includes('compose.yaml'), false);
  assert.deepEqual((await readdir(fx.root)).sort(), ['projects', 'runs']);
  await assertPrivateStagingClean(fx.root);
});

test('project-relative state survives lifecycle calls while private compose staging is recreated', async (t) => {
  const fx = await fixture(t);
  const { createHash } = await import('node:crypto');
  const request = input({ composeSha256: createHash('sha256').update(document).digest('hex') });
  await fx.manager.start(request);
  const projectDirectory = dockerComposeManagerInternals.projectWorkspacePath(fx.root, request.projectId);
  await writeFile(path.join(projectDirectory, 'persistent-marker'), 'kept', { mode: 0o600 });
  await fx.manager.restart(request);

  const executions = fx.calls.filter(([name]) => name === 'exec');
  assert.equal(executions.length, 2);
  assert.equal(executions[0][4], projectDirectory);
  assert.equal(executions[1][4], projectDirectory);
  assert.equal(await readFile(path.join(projectDirectory, 'persistent-marker'), 'utf8'), 'kept');
  await assertPrivateStagingClean(fx.root);
});

test('compose manager maps build pull stop and restart to bounded fixed commands', async (t) => {
  const fx = await fixture(t);
  const { createHash } = await import('node:crypto');
  const request = input({ composeSha256: createHash('sha256').update(document).digest('hex') });
  const projectDirectory = dockerComposeManagerInternals.projectWorkspacePath(fx.root, request.projectId);
  for (const [method, suffix, state] of [
    ['build', ['build'], null],
    ['pull', ['pull'], null],
    ['stop', ['stop'], 'stopped'],
    ['restart', ['restart'], 'running'],
  ]) {
    fx.calls.length = 0;
    const result = await fx.manager[method](request);
    const execution = fx.calls.find(([name]) => name === 'exec');
    assert.deepEqual(execution[2].slice(-suffix.length), suffix);
    assert.equal(execution[4], projectDirectory);
    assert.equal(result.action, method);
    assert.equal(result.runtimeState, state);
    await assertPrivateStagingClean(fx.root);
  }
});

test('compose manager validates desired state before mutation and cleans private staging after command failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-manager-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  const { createHash } = await import('node:crypto');
  const request = input({ composeSha256: createHash('sha256').update(document).digest('hex') });
  const invalid = createDockerComposeManager({
    root,
    accessFn: async () => {},
    validateCompose: async () => { throw new Error('invalid desired state'); },
    execFn: async () => { executions += 1; },
  });
  await assert.rejects(invalid.start(request));
  assert.equal(executions, 0);

  const failing = createDockerComposeManager({
    root,
    accessFn: async () => {},
    validateCompose: async () => ({ validated: true }),
    execFn: async () => { throw new Error('private docker diagnostic'); },
  });
  await assert.rejects(
    failing.pull(request),
    (error) => error instanceof DockerComposeManagerError
      && error.code === 'docker_compose_command_failed'
      && !error.message.includes('private docker diagnostic'),
  );
  await assertPrivateStagingClean(root);
  assert.deepEqual((await readdir(root)).sort(), ['projects', 'runs']);
});
