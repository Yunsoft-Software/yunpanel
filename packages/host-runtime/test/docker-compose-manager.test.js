import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeManager,
  DockerComposeManagerError,
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
      const configPath = path.join(options.env.DOCKER_CONFIG, 'config.json');
      calls.push(['exec', file, [...args], { ...options.env }]);
      assert.equal((await stat(composePath)).mode & 0o777, 0o600);
      assert.equal((await stat(options.env.DOCKER_CONFIG)).mode & 0o777, 0o700);
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
      assert.equal(await readFile(composePath, 'utf8'), document);
      assert.match(await readFile(configPath, 'utf8'), /registry\.example/);
      assert.equal(args.includes('credential-value'), false);
      assert.equal(args.includes('build-user'), false);
    },
  });
  return { root, calls, manager };
}

test('compose manager uses private staging and fixed start argv without exposing private input in result', async (t) => {
  const fx = await fixture(t);
  const request = input({ composeSha256: await import('node:crypto').then(({ createHash }) => createHash('sha256').update(document).digest('hex')) });
  const result = await fx.manager.start(request);
  const execution = fx.calls.find(([name]) => name === 'exec');
  assert.deepEqual(execution[2].slice(-4), ['up', '-d', '--no-build', '--remove-orphans']);
  assert.equal(execution[3].APP_MODE, 'production');
  assert.equal(execution[3].PATH, '/usr/bin:/bin');
  assert.equal(result.action, 'start');
  assert.equal(result.runtimeState, 'running');
  assert.equal(result.executed, true);
  assert.equal(JSON.stringify(result).includes('credential-value'), false);
  assert.equal(JSON.stringify(result).includes('compose.yaml'), false);
  assert.deepEqual(await readdir(fx.root), []);
});

test('compose manager maps build pull stop and restart to bounded fixed commands', async (t) => {
  const fx = await fixture(t);
  const { createHash } = await import('node:crypto');
  const request = input({ composeSha256: createHash('sha256').update(document).digest('hex') });
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
    assert.equal(result.action, method);
    assert.equal(result.runtimeState, state);
    assert.deepEqual(await readdir(fx.root), []);
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
  assert.deepEqual(await readdir(root), []);
});
