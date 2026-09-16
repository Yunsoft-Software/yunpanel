import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebsiteSftpKeyRuntime } from '../src/website-sftp-key-runtime.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const remoteWebsiteId = '21e94c50-f18f-44de-91b7-8168abcee7de';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const localServerId = '28dc1532-a2cb-4f29-9e0d-05f793652fa3';
const remoteServerId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const unixUser = 'yunapp-4dc352e64a14';

function sshString(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function ed25519Key(byte) {
  const blob = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, byte))]);
  return `ssh-ed25519 ${blob.toString('base64')} runtime@test`;
}

function websiteRegistry() {
  return {
    getWebsite: async (id) => {
      if (![websiteId, remoteWebsiteId].includes(id)) return null;
      return {
        id,
        serverId: id === websiteId ? localServerId : remoteServerId,
        runtimeType: 'node',
        applicationId,
        unixUser,
      };
    },
  };
}

function manager(applied) {
  return {
    inspect: async (intent) => ({
      satisfied: applied.some((entry) => entry.websiteId === intent.websiteId),
      ...(applied.some((entry) => entry.websiteId === intent.websiteId)
        ? { adapter: 'openssh-authorized-keys', keyCount: intent.keys.length, sha256: 'a'.repeat(64) }
        : { reason: 'sftp_authorized_keys_file_missing' }),
    }),
    apply: async (intent) => {
      applied.push(intent);
      return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: intent.keys.length, sha256: 'b'.repeat(64) };
    },
  };
}

test('Website SFTP key runtime persists desired state across restart and scopes it to the local Server', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-sftp-key-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'website-sftp-key-registry.json');
  const applied = [];
  const options = {
    filePath,
    websiteRegistry: websiteRegistry(),
    localServerId,
    authorizedKeyManager: manager(applied),
    now: () => Date.parse('2026-09-17T10:00:00.000Z'),
  };
  const first = await createWebsiteSftpKeyRuntime(options);
  const added = await first.service.add({ websiteId, label: 'Laptop', publicKey: ed25519Key(7) });

  assert.equal(added.materialization.satisfied, true);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].websiteId, websiteId);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const restarted = await createWebsiteSftpKeyRuntime(options);
  const listed = await restarted.service.list(websiteId);
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].label, 'Laptop');
  assert.equal('publicKey' in listed.keys[0], false);
  assert.equal(JSON.stringify(listed).includes('runtime@test'), false);

  await assert.rejects(
    restarted.service.list(remoteWebsiteId),
    (error) => error?.code === 'website_not_found' && error?.status === 404,
  );
});
