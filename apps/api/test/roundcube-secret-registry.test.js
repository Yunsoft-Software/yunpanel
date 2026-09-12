import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRoundcubeSecretRegistry,
  RoundcubeSecretRegistryError,
} from '../src/roundcube-secret-registry.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const MISSING_SERVER_ID = '822fa920-166c-4a7a-a26b-476c81d82165';

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-roundcube-secret-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function deterministicRandom(sequence) {
  let index = 0;
  return () => Buffer.from(sequence[index++] ?? sequence.at(-1), 'hex');
}

test('Roundcube secret is generated once, private on disk and hidden from public metadata', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'roundcube-secret.json');
  const registry = createRoundcubeSecretRegistry({
    filePath,
    now: () => Date.parse('2026-09-13T00:00:00.000Z'),
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(['00112233445566778899aabbccddeeff0011']),
  });
  await registry.init();
  const created = await registry.ensureForServer(SERVER_ID);
  assert.deepEqual(created, {
    serverId: SERVER_ID,
    revision: 1,
    configured: true,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(created).includes('desKey'), false);
  const materialized = await registry.materializeForServer(SERVER_ID);
  assert.equal(materialized.desKey.length, 24);
  assert.match(materialized.desKey, /^[A-Za-z0-9_-]{24}$/);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.match(await readFile(filePath, 'utf8'), new RegExp(materialized.desKey));

  const again = await registry.ensureForServer(SERVER_ID);
  assert.equal(again.revision, 1);
  assert.equal((await registry.materializeForServer(SERVER_ID)).desKey, materialized.desKey);
}));

test('Roundcube secret persists across restart without depending on panel master-key rotation', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'roundcube-secret.json');
  const first = createRoundcubeSecretRegistry({
    filePath,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(['111111111111111111111111111111111111']),
  });
  await first.ensureForServer(SERVER_ID);
  const before = await first.materializeForServer(SERVER_ID);

  const reopened = createRoundcubeSecretRegistry({
    filePath,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(['222222222222222222222222222222222222']),
  });
  await reopened.init();
  const after = await reopened.materializeForServer(SERVER_ID);
  assert.equal(after.desKey, before.desKey);
  assert.equal(after.revision, 1);
}));

test('Roundcube secret rotation is exact-revision confirmed and never exposes the new key', async () => {
  const registry = createRoundcubeSecretRegistry({
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom([
      '111111111111111111111111111111111111',
      '222222222222222222222222222222222222',
    ]),
  });
  await registry.ensureForServer(SERVER_ID);
  const before = await registry.materializeForServer(SERVER_ID);
  await assert.rejects(
    registry.rotateForServer(SERVER_ID, { expectedRevision: 1, confirmation: 'wrong' }),
    (error) => error instanceof RoundcubeSecretRegistryError
      && error.code === 'roundcube_secret_confirmation_invalid',
  );
  const rotated = await registry.rotateForServer(SERVER_ID, {
    expectedRevision: 1,
    confirmation: `rotate-roundcube-secret:${SERVER_ID}:1`,
  });
  assert.equal(rotated.revision, 2);
  assert.equal(JSON.stringify(rotated).includes('desKey'), false);
  const after = await registry.materializeForServer(SERVER_ID);
  assert.notEqual(after.desKey, before.desKey);
});

test('Roundcube secret fails closed for missing server and corrupt persisted records', async () => {
  const registry = createRoundcubeSecretRegistry({
    serverExists: async (id) => id === SERVER_ID,
  });
  await assert.rejects(
    registry.ensureForServer(MISSING_SERVER_ID),
    (error) => error instanceof RoundcubeSecretRegistryError && error.code === 'roundcube_server_not_found',
  );

  await withTempDirectory(async (root) => {
    const filePath = path.join(root, 'roundcube-secret.json');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, JSON.stringify({
      version: 1,
      records: [{
        serverId: SERVER_ID,
        desKey: 'short',
        revision: 1,
        createdAt: '2026-09-13T00:00:00.000Z',
        updatedAt: '2026-09-13T00:00:00.000Z',
      }],
    })));
    const corrupt = createRoundcubeSecretRegistry({ filePath, serverExists: async () => true });
    await assert.rejects(
      corrupt.init(),
      (error) => error instanceof RoundcubeSecretRegistryError && error.code === 'roundcube_secret_state_invalid',
    );
  });
});