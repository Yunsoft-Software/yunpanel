import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeEnvironmentWriter, NodeEnvironmentWriteError } from '../src/node-environment-writer.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';

test('writes a root-protected environment file atomically', async () => {
  const calls = [];
  const writer = createNodeEnvironmentWriter({
    envRoot: '/env',
    mkdirFn: async (...args) => calls.push(['mkdir', ...args]),
    writeFileFn: async (...args) => calls.push(['write', ...args]),
    renameFn: async (...args) => calls.push(['rename', ...args]),
  });

  const result = await writer.writeEnvironment({
    applicationId: APPLICATION_ID,
    runtime: { port: 3100 },
    environment: { API_TOKEN: 'secret-value' },
  });

  assert.equal(result.path, `/env/${APPLICATION_ID}.env`);
  const write = calls.find((entry) => entry[0] === 'write');
  assert.ok(write);
  assert.equal(write[3].mode, 0o600);
  assert.match(write[2], /API_TOKEN="secret-value"/);
  const rename = calls.find((entry) => entry[0] === 'rename');
  assert.equal(rename[2], `/env/${APPLICATION_ID}.env`);
});

test('rejects invalid custom environment before touching the filesystem', async () => {
  let touched = false;
  const writer = createNodeEnvironmentWriter({
    mkdirFn: async () => { touched = true; },
    writeFileFn: async () => { touched = true; },
    renameFn: async () => { touched = true; },
  });

  await assert.rejects(
    writer.writeEnvironment({
      applicationId: APPLICATION_ID,
      runtime: { port: 3100 },
      environment: { PORT: '9999' },
    }),
    (error) => error instanceof NodeEnvironmentWriteError && error.code === 'invalid_node_environment',
  );
  assert.equal(touched, false);
});
