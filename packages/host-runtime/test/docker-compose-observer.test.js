import assert from 'node:assert/strict';
import test from 'node:test';
import { createDockerComposeObserver } from '../src/docker-compose-observer.js';

const containerId = 'a'.repeat(64);

function psRow(overrides = {}) {
  return JSON.stringify({
    ID: containerId,
    Names: 'shop-web-1',
    Image: 'nginx:1.28',
    State: 'running',
    Status: 'Up 10 seconds (healthy)',
    ...overrides,
  });
}

test('compose observer reports project-scoped runtime health without container environment', async () => {
  const calls = [];
  const observer = createDockerComposeObserver({
    accessFn: async () => {},
    execFn: async (file, args) => {
      calls.push([file, args]);
      if (args[0] === 'ps') return { stdout: `${psRow()}\n`, stderr: '' };
      if (args[0] === 'inspect') {
        return {
          stdout: JSON.stringify({
            Status: 'running', Running: true, Paused: false, Restarting: false,
            OOMKilled: false, Dead: false, ExitCode: 0,
            Health: { Status: 'healthy', FailingStreak: 0, Log: [{ Output: 'secret=do-not-return' }] },
          }),
          stderr: '',
        };
      }
      throw new Error('unexpected command');
    },
  });

  const result = await observer.inspect({ projectName: 'shop_app' });
  assert.equal(result.status, 'running');
  assert.equal(result.containerCount, 1);
  assert.deepEqual(result.containers[0].runtime.health, { status: 'healthy', failingStreak: 0 });
  assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  assert.ok(calls[0][1].includes('label=com.docker.compose.project=shop_app'));
  assert.deepEqual(calls[1][1], ['inspect', '--format', '{{json .State}}', containerId]);
});

test('compose observer marks unhealthy or OOM containers degraded', async () => {
  const observer = createDockerComposeObserver({
    accessFn: async () => {},
    execFn: async (file, args) => args[0] === 'ps'
      ? { stdout: `${psRow()}\n`, stderr: '' }
      : {
        stdout: JSON.stringify({
          Status: 'running', Running: true, Paused: false, Restarting: false,
          OOMKilled: false, Dead: false, ExitCode: 0,
          Health: { Status: 'unhealthy', FailingStreak: 3 },
        }),
        stderr: '',
      },
  });
  assert.equal((await observer.inspect({ projectName: 'shop_app' })).status, 'degraded');
});

test('compose logs are project/service scoped bounded and redact common secrets', async () => {
  const calls = [];
  const observer = createDockerComposeObserver({
    accessFn: async () => {},
    execFn: async (file, args) => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: `${psRow()}\n`, stderr: '' };
      if (args[0] === 'logs') {
        return {
          stdout: '2026-09-13T10:00:00Z ready token=supersecret\nAuthorization: Bearer abcdefghijklmnop\n',
          stderr: '',
        };
      }
      throw new Error('unexpected command');
    },
  });

  const result = await observer.logs({ projectName: 'shop_app', service: 'web', tail: 25 });
  assert.equal(result.service, 'web');
  assert.equal(result.tail, 25);
  assert.equal(result.containers.length, 1);
  assert.match(result.containers[0].lines[0], /token=\[REDACTED\]/);
  assert.match(result.containers[0].lines[1], /Bearer \[REDACTED\]/);
  assert.equal(JSON.stringify(result).includes('supersecret'), false);
  assert.ok(calls[0].includes('label=com.docker.compose.project=shop_app'));
  assert.ok(calls[0].includes('label=com.docker.compose.service=web'));
  assert.deepEqual(calls[1], ['logs', '--tail', '25', '--timestamps', containerId]);
});
