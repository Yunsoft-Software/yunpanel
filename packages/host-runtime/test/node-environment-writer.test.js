import assert from 'node:assert/strict';
import test from 'node:test';
import { createNodeEnvironmentWriter, NodeEnvironmentWriteError } from '../src/index.js';

const APPLICATION_ID = '9d4a4727-1aba-4d35-95fe-21db67042ce9';

function missingFileError() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

test('host runtime writes a root-protected Node environment file atomically', async () => {
  const calls = [];
  const writer = createNodeEnvironmentWriter({
    envRoot: '/env',
    mkdirFn: async (...args) => calls.push(['mkdir', ...args]),
    readFileFn: async () => { throw missingFileError(); },
    rmFn: async (...args) => calls.push(['rm', ...args]),
    writeFileFn: async (...args) => calls.push(['write', ...args]),
    renameFn: async (...args) => calls.push(['rename', ...args]),
  });

  const result = await writer.writeEnvironment({
    applicationId: APPLICATION_ID,
    runtime: { port: 3100 },
    environment: { API_TOKEN: 'secret-value' },
  });

  assert.equal(result.path, `/env/${APPLICATION_ID}.env`);
  assert.equal(result.previousExists, false);
  const write = calls.find((entry) => entry[0] === 'write');
  assert.ok(write);
  assert.equal(write[3].mode, 0o600);
  assert.match(write[2], /API_TOKEN="secret-value"/);
  assert.equal(calls.find((entry) => entry[0] === 'rename')[2], `/env/${APPLICATION_ID}.env`);
});

test('host runtime restores the exact previous Node environment after failed activation', async () => {
  const writes = [];
  const previous = 'NODE_ENV="production"\nAPI_TOKEN="old-secret"\n';
  const writer = createNodeEnvironmentWriter({
    envRoot: '/env',
    mkdirFn: async () => {},
    readFileFn: async () => previous,
    rmFn: async () => {},
    writeFileFn: async (target, content, options) => writes.push({ target, content, options }),
    renameFn: async () => {},
  });

  const transaction = await writer.writeEnvironment({
    applicationId: APPLICATION_ID,
    runtime: { port: 3100 },
    environment: { API_TOKEN: 'new-secret' },
  });
  await transaction.restore();
  assert.equal(writes.at(-1).content, previous);
  assert.equal(writes.at(-1).options.mode, 0o600);
});

test('host runtime removes a newly created environment file on rollback', async () => {
  const removals = [];
  const writer = createNodeEnvironmentWriter({
    envRoot: '/env',
    mkdirFn: async () => {},
    readFileFn: async () => { throw missingFileError(); },
    rmFn: async (target, options) => removals.push({ target, options }),
    writeFileFn: async () => {},
    renameFn: async () => {},
  });

  const transaction = await writer.writeEnvironment({
    applicationId: APPLICATION_ID,
    runtime: { port: 3100 },
    environment: { API_TOKEN: 'new-secret' },
  });
  await transaction.restore();
  assert.ok(removals.some((entry) => entry.target === `/env/${APPLICATION_ID}.env` && entry.options?.force === true));
});

test('host runtime commit makes later environment restore a no-op', async () => {
  const writes = [];
  const writer = createNodeEnvironmentWriter({
    envRoot: '/env',
    mkdirFn: async () => {},
    readFileFn: async () => 'API_TOKEN="old"\n',
    rmFn: async () => {},
    writeFileFn: async (target, content) => writes.push({ target, content }),
    renameFn: async () => {},
  });
  const transaction = await writer.writeEnvironment({
    applicationId: APPLICATION_ID,
    runtime: { port: 3100 },
    environment: { API_TOKEN: 'new' },
  });
  transaction.commit();
  await transaction.restore();
  assert.equal(writes.length, 1);
});

test('host runtime rejects invalid Node environment before filesystem access', async () => {
  let touched = false;
  const writer = createNodeEnvironmentWriter({
    mkdirFn: async () => { touched = true; },
    readFileFn: async () => { touched = true; return ''; },
    rmFn: async () => { touched = true; },
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
