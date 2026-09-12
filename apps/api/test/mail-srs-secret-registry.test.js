import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailSrsSecretRegistry,
  MailSrsSecretRegistryError,
} from '../src/mail-srs-secret-registry.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const MASTER_KEY = '11'.repeat(32);

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-srs-secret-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function deterministicRandom() {
  let secretCounter = 0;
  let ivCounter = 0;
  return (size) => {
    if (size === 32) return Buffer.alloc(size, 0x21 + secretCounter++);
    if (size === 12) return Buffer.alloc(size, 0x41 + ivCounter++);
    throw new Error(`unexpected random byte size ${size}`);
  };
}

test('SRS secret registry persists encrypted state and exposes plaintext only through private materialization', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'mail-srs-secret-registry.json');
  const registry = createMailSrsSecretRegistry({
    filePath,
    masterKey: MASTER_KEY,
    now: () => Date.parse('2026-09-13T00:00:00.000Z'),
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(),
  });
  await registry.init();
  const publicRecord = await registry.ensureForServer(SERVER_ID);
  const materialized = await registry.materializeForServer(SERVER_ID);

  assert.deepEqual(publicRecord, {
    serverId: SERVER_ID,
    revision: 1,
    configured: true,
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });
  assert.equal(materialized.serverId, SERVER_ID);
  assert.equal(materialized.revision, 1);
  assert.match(materialized.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const raw = await readFile(filePath, 'utf8');
  assert.doesNotMatch(raw, new RegExp(materialized.secret));
  assert.doesNotMatch(raw, /"secret"\s*:/);
  assert.match(raw, /"ciphertext"\s*:/);

  const reopened = createMailSrsSecretRegistry({
    filePath,
    masterKey: MASTER_KEY,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(),
  });
  await reopened.init();
  assert.deepEqual(await reopened.materializeForServer(SERVER_ID), materialized);
}));

test('SRS secret rotation requires exact revision confirmation and invalidates the previous plaintext', async () => withTempDirectory(async (root) => {
  let now = Date.parse('2026-09-13T00:00:00.000Z');
  const registry = createMailSrsSecretRegistry({
    filePath: path.join(root, 'mail-srs-secret-registry.json'),
    masterKey: MASTER_KEY,
    now: () => now,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(),
  });
  await registry.init();
  await registry.ensureForServer(SERVER_ID);
  const before = await registry.materializeForServer(SERVER_ID);

  await assert.rejects(
    registry.rotateForServer(SERVER_ID, { expectedRevision: 1, confirmation: 'wrong' }),
    (error) => error instanceof MailSrsSecretRegistryError
      && error.code === 'mail_srs_secret_confirmation_invalid',
  );

  now = Date.parse('2026-09-13T01:00:00.000Z');
  const rotated = await registry.rotateForServer(SERVER_ID, {
    expectedRevision: 1,
    confirmation: `rotate-mail-srs-secret:${SERVER_ID}:1`,
  });
  const after = await registry.materializeForServer(SERVER_ID);
  assert.equal(rotated.revision, 2);
  assert.equal(after.revision, 2);
  assert.notEqual(after.secret, before.secret);
  assert.equal(rotated.updatedAt, '2026-09-13T01:00:00.000Z');

  await assert.rejects(
    registry.rotateForServer(SERVER_ID, {
      expectedRevision: 1,
      confirmation: `rotate-mail-srs-secret:${SERVER_ID}:1`,
    }),
    (error) => error instanceof MailSrsSecretRegistryError
      && error.code === 'mail_srs_secret_confirmation_invalid',
  );
}));

test('SRS secret registry rejects tampered ciphertext and missing server references on restart', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'mail-srs-secret-registry.json');
  const registry = createMailSrsSecretRegistry({
    filePath,
    masterKey: MASTER_KEY,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: deterministicRandom(),
  });
  await registry.init();
  await registry.ensureForServer(SERVER_ID);

  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  parsed.records[0].ciphertext = `${parsed.records[0].ciphertext.slice(0, -2)}AA`;
  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  const tampered = createMailSrsSecretRegistry({
    filePath,
    masterKey: MASTER_KEY,
    serverExists: async (id) => id === SERVER_ID,
  });
  await assert.rejects(
    tampered.init(),
    (error) => error instanceof MailSrsSecretRegistryError
      && error.code === 'mail_srs_secret_decryption_failed',
  );

  parsed.records[0].ciphertext = JSON.parse(await readFile(filePath, 'utf8')).records[0].ciphertext;
  const missingServer = createMailSrsSecretRegistry({
    filePath,
    masterKey: MASTER_KEY,
    serverExists: async () => false,
  });
  await assert.rejects(
    missingServer.init(),
    (error) => error instanceof MailSrsSecretRegistryError
      && error.code === 'mail_srs_secret_state_invalid',
  );
}));
