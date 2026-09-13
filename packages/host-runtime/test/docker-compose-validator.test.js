import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDockerComposeValidator,
  DockerComposeValidationError,
  summarizeDockerComposeConfig,
} from '../src/docker-compose-validator.js';

async function rootFixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-compose-validator-'));
  const root = path.join(parent, 'private');
  t.after(() => rm(parent, { recursive: true, force: true }));
  return root;
}

test('compose validator stages source privately, uses fixed docker compose config contract and returns safe summary', async (t) => {
  const root = await rootFixture(t);
  const calls = [];
  const document = [
    'services:',
    '  web:',
    '    image: example/web:1',
    '    environment:',
    '      API_TOKEN: ${API_TOKEN}',
    '  worker:',
    '    build: .',
    'volumes:',
    '  data: {}',
    '',
  ].join('\n');
  const validator = createDockerComposeValidator({
    root,
    randomSuffix: () => 'fixed',
    accessFn: async (candidate) => {
      if (candidate !== '/usr/bin/docker') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    execFn: async (file, args, options) => {
      calls.push({ file, args: [...args], options: { cwd: options.cwd, env: { ...options.env } } });
      const composePath = args[args.indexOf('-f') + 1];
      assert.equal(await readFile(composePath, 'utf8'), document);
      assert.equal((await stat(composePath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(composePath))).mode & 0o777, 0o700);
      return JSON.stringify({
        name: 'shop_app',
        services: {
          web: { image: 'example/web:1', environment: { API_TOKEN: 'super-secret' } },
          worker: { build: { context: '/private/project' } },
        },
        networks: { default: {} },
        volumes: { data: {} },
      });
    },
  });

  const result = await validator({
    projectName: 'shop_app',
    document,
    environment: { API_TOKEN: 'super-secret' },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/bin/docker');
  assert.deepEqual(calls[0].args.slice(0, 3), ['compose', '--project-name', 'shop_app']);
  assert.ok(calls[0].args.includes('--env-file'));
  assert.ok(calls[0].args.includes('/dev/null'));
  assert.equal(calls[0].options.env.API_TOKEN, 'super-secret');
  assert.equal(calls[0].options.env.PATH, '/usr/bin:/bin');
  assert.deepEqual(result.services, [
    { name: 'web', imageConfigured: true, buildConfigured: false },
    { name: 'worker', imageConfigured: false, buildConfigured: true },
  ]);
  assert.deepEqual(result.volumes, ['data']);
  assert.deepEqual(result.networks, ['default']);
  assert.equal(result.validated, true);
  assert.equal(result.sideEffects, false);
  assert.match(result.composeSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|API_TOKEN|private\/project|compose\.yaml/i);
  assert.deepEqual(await readdir(root), []);
});

test('compose validator fails closed when docker is missing or compose config fails without leaking child diagnostics', async (t) => {
  const root = await rootFixture(t);
  const missing = createDockerComposeValidator({
    root,
    accessFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  await assert.rejects(
    missing({ projectName: 'app', document: 'services:\n  web:\n    image: nginx\n' }),
    (error) => error instanceof DockerComposeValidationError && error.code === 'docker_compose_unavailable',
  );

  const invalid = createDockerComposeValidator({
    root,
    accessFn: async () => {},
    execFn: async () => { throw new Error('stderr contained REGISTRY_PASSWORD=secret'); },
  });
  await assert.rejects(
    invalid({ projectName: 'app', document: 'services: invalid' }),
    (error) => error instanceof DockerComposeValidationError
      && error.code === 'docker_compose_validation_failed'
      && !error.message.includes('secret'),
  );
  assert.deepEqual(await readdir(root), []);
});

test('compose summary rejects project drift, empty service sets and unsafe normalized resource names', () => {
  const base = { expectedProjectName: 'app', documentSha256: 'a'.repeat(64), documentBytes: 10 };
  assert.throws(
    () => summarizeDockerComposeConfig({ name: 'other', services: { web: { image: 'nginx' } } }, base),
    { code: 'docker_compose_project_name_mismatch' },
  );
  assert.throws(
    () => summarizeDockerComposeConfig({ name: 'app', services: {} }, base),
    { code: 'docker_compose_service_count_invalid' },
  );
  assert.throws(
    () => summarizeDockerComposeConfig({ name: 'app', services: { web: {} }, volumes: { 'bad/name': {} } }, base),
    { code: 'docker_compose_config_invalid' },
  );
});

test('compose validator bounds project name, document and interpolation environment before execution', async (t) => {
  const root = await rootFixture(t);
  let executions = 0;
  const validator = createDockerComposeValidator({
    root,
    accessFn: async () => {},
    execFn: async () => { executions += 1; return '{}'; },
  });
  await assert.rejects(validator({ projectName: '../bad', document: 'services: {}' }), { code: 'docker_compose_project_name_invalid' });
  await assert.rejects(validator({
    projectName: 'app',
    document: 'services: {}',
    environment: { 'BAD-KEY': 'value' },
  }), { code: 'docker_compose_environment_invalid' });
  await assert.rejects(validator({
    projectName: 'app',
    document: `services:\n${'x'.repeat(512 * 1024)}`,
  }), { code: 'docker_compose_document_too_large' });
  assert.equal(executions, 0);
});
