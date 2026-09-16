import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSftpAuthorizedKeyManager,
  SftpAuthorizedKeyManagerError,
  sftpAuthorizedKeyManagerInternals,
} from '../src/sftp-authorized-key-manager.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-4dc352e64a14';

function sshString(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function key(byte, id) {
  const blob = Buffer.concat([
    sshString('ssh-ed25519'),
    sshString(Buffer.alloc(32, byte)),
  ]);
  return {
    id,
    publicKey: `ssh-ed25519 ${blob.toString('base64')}`,
    fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')}`,
    revision: 1,
  };
}

function intent(keys) {
  return { websiteId, applicationId, unixUser, keys };
}

function rootOwnedStat(target) {
  return lstat(target).then((info) => ({
    mode: info.mode,
    uid: 0,
    gid: 0,
    isDirectory: () => info.isDirectory(),
    isFile: () => info.isFile(),
    isSymbolicLink: () => info.isSymbolicLink(),
  }));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-authorized-keys-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  let writes = 0;
  const manager = createSftpAuthorizedKeyManager({
    authorizedKeysRoot: root,
    lstatFn: rootOwnedStat,
    chownFn: async () => {},
    writeFileFn: async (...args) => {
      writes += 1;
      return writeFile(...args);
    },
  });
  return { root, manager, writes: () => writes };
}

test('authorized-key manager atomically materializes a root-owned managed key set without leaking raw keys in evidence', async (t) => {
  const { root, manager } = await fixture(t);
  const first = key(1, '9ae512c0-a717-4611-943c-6ce2ab0abf16');
  const second = key(2, '47bc6cf1-75bc-4cba-a610-aa0cd0522c80');

  const result = await manager.apply(intent([second, first]));
  assert.equal(result.satisfied, true);
  assert.equal(result.adapter, 'openssh-authorized-keys');
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.applicationId, applicationId);
  assert.equal(result.unixUser, unixUser);
  assert.equal(result.keyCount, 2);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(first.publicKey), false);
  assert.equal(JSON.stringify(result).includes(second.publicKey), false);

  const target = path.join(root, unixUser);
  const content = await readFile(target, 'utf8');
  assert.equal(content.startsWith(sftpAuthorizedKeyManagerInternals.managedHeader), true);
  assert.equal(content.includes(first.publicKey), true);
  assert.equal(content.includes(second.publicKey), true);
  assert.equal((await lstat(target)).mode & 0o777, 0o644);
  assert.deepEqual(await manager.inspect(intent([first, second])), result);
});

test('re-applying the exact desired key set is idempotent and does not rewrite the file', async (t) => {
  const fixtureState = await fixture(t);
  const desired = intent([key(3, '86e826ad-2dc6-45e4-ac3f-0c03bcff18fc')]);
  await fixtureState.manager.apply(desired);
  const writesAfterFirstApply = fixtureState.writes();
  await fixtureState.manager.apply(desired);
  assert.equal(fixtureState.writes(), writesAfterFirstApply);
});

test('changed desired keys inspect as outdated and apply reconciles only the YunPanel-managed file', async (t) => {
  const { root, manager } = await fixture(t);
  const first = intent([key(4, 'a17be329-acdf-48fd-ac1f-b3e35ec75565')]);
  const second = intent([key(5, 'cb934804-a7c7-4ffd-bcc4-93289219823b')]);
  await manager.apply(first);

  const stale = await manager.inspect(second);
  assert.equal(stale.satisfied, false);
  assert.equal(stale.reason, 'sftp_authorized_keys_outdated');
  assert.match(stale.currentSha256, /^[a-f0-9]{64}$/);
  assert.match(stale.desiredSha256, /^[a-f0-9]{64}$/);

  await manager.apply(second);
  const content = await readFile(path.join(root, unixUser), 'utf8');
  assert.equal(content.includes(first.keys[0].publicKey), false);
  assert.equal(content.includes(second.keys[0].publicKey), true);
});

test('revoking every key materializes only the managed marker and leaves public-key auth with zero accepted keys', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.apply(intent([key(6, '37861cf3-8462-4d4d-aab0-303fb53022a1')]));
  const result = await manager.apply(intent([]));
  assert.equal(result.keyCount, 0);
  assert.equal(await readFile(path.join(root, unixUser), 'utf8'), sftpAuthorizedKeyManagerInternals.managedHeader);
});

test('an existing non-YunPanel authorized_keys file fails closed instead of being overwritten', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-authorized-keys-conflict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const target = path.join(root, unixUser);
  await writeFile(target, `${key(7, 'fa97e720-cd0c-490a-ae56-cfb05c6e3686').publicKey}\n`, { mode: 0o644 });

  const manager = createSftpAuthorizedKeyManager({
    authorizedKeysRoot: root,
    lstatFn: rootOwnedStat,
    chownFn: async () => {},
  });

  await assert.rejects(
    manager.apply(intent([key(8, '36bd97f1-0189-4bac-bc1b-5abff87256d5')])),
    (error) => error instanceof SftpAuthorizedKeyManagerError
      && error.code === 'sftp_authorized_keys_unmanaged_conflict',
  );
});

test('key metadata or fingerprint drift is rejected before filesystem mutation', async (t) => {
  const fixtureState = await fixture(t);
  const current = key(9, '4ea277a7-76ea-4a66-a001-f1df6005327a');
  const before = fixtureState.writes();

  await assert.rejects(
    fixtureState.manager.apply(intent([{ ...current, fingerprint: 'SHA256:wrong' }])),
    (error) => error instanceof SftpAuthorizedKeyManagerError
      && error.code === 'sftp_authorized_key_fingerprint_mismatch',
  );
  assert.equal(fixtureState.writes(), before);
});
