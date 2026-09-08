import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerInspector, parseDockerPsOutput } from '../src/docker-inspector.js';

test('parses docker ps JSON lines without exposing arbitrary fields', () => {
  const containers = parseDockerPsOutput([
    JSON.stringify({
      ID: 'abc123',
      Names: 'web',
      Image: 'nginx:latest',
      State: 'running',
      Status: 'Up 3 hours',
      Ports: '0.0.0.0:8080->80/tcp',
      Networks: 'bridge',
      Mounts: 'web-data',
      Labels: 'com.docker.compose.project=demo',
      CreatedAt: '2026-09-08 20:00:00 +0300 +03',
      UnsafeExtra: 'ignored',
    }),
    'not-json',
  ].join('\n'));

  assert.equal(containers.length, 1);
  assert.equal(containers[0].name, 'web');
  assert.equal(containers[0].image, 'nginx:latest');
  assert.equal('UnsafeExtra' in containers[0], false);
});

test('Docker inspection executes only fixed read-only arguments', async () => {
  const calls = [];
  const inspect = createDockerInspector({
    accessFn: async (candidate) => {
      if (candidate !== '/usr/bin/docker') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    execFn: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === 'version') return '27.5.1\n';
      if (args[0] === 'compose') return '2.35.0\n';
      return `${JSON.stringify({ ID: '1', Names: 'api', Image: 'node:24', State: 'running' })}\n`;
    },
  });

  const result = await inspect();
  assert.equal(result.installed, true);
  assert.equal(result.reachable, true);
  assert.equal(result.version, '27.5.1');
  assert.equal(result.composeVersion, '2.35.0');
  assert.equal(result.containers[0].name, 'api');
  assert.deepEqual(calls.map((call) => call.args), [
    ['version', '--format', '{{.Server.Version}}'],
    ['compose', 'version', '--short'],
    ['ps', '-a', '--no-trunc', '--format', '{{json .}}'],
  ]);
});

test('missing Docker is reported without executing a process', async () => {
  let executed = false;
  const inspect = createDockerInspector({
    accessFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    execFn: async () => {
      executed = true;
      return '';
    },
  });

  const result = await inspect();
  assert.equal(result.installed, false);
  assert.equal(result.reachable, false);
  assert.equal(executed, false);
});
