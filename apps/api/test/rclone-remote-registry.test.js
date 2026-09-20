import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRcloneRemoteRegistry,
  RcloneRemoteRegistryError,
} from '../src/rclone-remote-registry.js';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const remoteId = '0bb78242-03a6-429f-9d17-7725c521437c';

function mockRcloneManager() {
  const calls = [];
  return {
    calls,
    writeConfigFile: async ({ remotes, targetPath }) => {
      calls.push({ method: 'writeConfigFile', remotes, targetPath });
      return { targetPath, writtenAt: '2026-09-20T10:00:00.000Z' };
    },
    testRemote: async ({ remoteName, configFile }) => {
      calls.push({ method: 'testRemote', remoteName, configFile });
      if (remoteName === 'failing_remote') {
        throw new Error('Connection refused to remote target');
      }
      return { reachable: true, remoteName, testedAt: '2026-09-20T10:05:00.000Z' };
    },
    listRemotes: async ({ configFile }) => {
      calls.push({ method: 'listRemotes', configFile });
      return ['my_s3'];
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-rclone-reg-'));
  const filePath = path.join(root, 'rclone-remotes.json');
  t.after(() => rm(root, { recursive: true, force: true }));
  const masterKey = randomBytes(32);
  const manager = mockRcloneManager();
  const registry = createRcloneRemoteRegistry({
    filePath,
    masterKey,
    serverExists: async (id) => id === serverId,
    rcloneManager: manager,
    now: () => Date.parse('2026-09-20T10:00:00.000Z'),
  });
  await registry.init();
  return { filePath, masterKey, registry, manager, root };
}

test('createRemote stores encrypted credentials and returns public view', async (t) => {
  const { registry } = await fixture(t);

  const remote = await registry.createRemote({
    remoteId,
    serverId,
    name: 's3_backup',
    type: 's3',
    parameters: { provider: 'AWS', region: 'eu-central-1' },
    credentials: { access_key_id: 'AKIA12345', secret_access_key: 'SECRET98765' },
  });

  assert.equal(remote.id, remoteId);
  assert.equal(remote.serverId, serverId);
  assert.equal(remote.name, 's3_backup');
  assert.equal(remote.type, 's3');
  assert.deepEqual(remote.parameters, { provider: 'AWS', region: 'eu-central-1' });
  assert.equal(remote.status, 'untested');
  assert.equal(remote.credentials, undefined); // Never exposed in public view

  // Credentials decryption
  const creds = registry.revealCredentials(remoteId);
  assert.deepEqual(creds, { access_key_id: 'AKIA12345', secret_access_key: 'SECRET98765' });
});

test('createRemote rejects invalid inputs', async (t) => {
  const { registry } = await fixture(t);

  // Unsupported type
  await assert.rejects(
    registry.createRemote({ serverId, name: 'r1', type: 'unsupported_cloud' }),
    (err) => err instanceof RcloneRemoteRegistryError && err.code === 'rclone_remote_type_unsupported',
  );

  // Invalid name
  await assert.rejects(
    registry.createRemote({ serverId, name: 'invalid name with spaces', type: 's3' }),
    (err) => err instanceof RcloneRemoteRegistryError && err.code === 'rclone_remote_name_invalid',
  );

  // Invalid server
  await assert.rejects(
    registry.createRemote({ serverId: '00000000-0000-4000-8000-000000000000', name: 'r1', type: 's3' }),
    (err) => err instanceof RcloneRemoteRegistryError && err.code === 'server_not_found' && err.status === 404,
  );
});

test('duplicate remote name on same server is rejected', async (t) => {
  const { registry } = await fixture(t);

  await registry.createRemote({
    serverId,
    name: 'b2_offsite',
    type: 'b2',
    credentials: { account: 'acc1', key: 'key1' },
  });

  await assert.rejects(
    registry.createRemote({ serverId, name: 'b2_offsite', type: 'b2', credentials: { account: 'acc2', key: 'key2' } }),
    (err) => err instanceof RcloneRemoteRegistryError && err.code === 'rclone_remote_name_conflict' && err.status === 409,
  );
});

test('updateRemote updates parameters, credentials, and name, resetting status to untested', async (t) => {
  const { registry } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 'initial_name',
    type: 's3',
    parameters: { region: 'us-east-1' },
    credentials: { key: 'old' },
  });

  const updated = await registry.updateRemote(remoteId, {
    name: 'renamed_remote',
    parameters: { region: 'us-west-2' },
    credentials: { key: 'new' },
  });

  assert.equal(updated.name, 'renamed_remote');
  assert.deepEqual(updated.parameters, { region: 'us-west-2' });
  assert.equal(updated.status, 'untested');

  const decrypted = registry.revealCredentials(remoteId);
  assert.deepEqual(decrypted, { key: 'new' });
});

test('deleteRemote removes remote from registry', async (t) => {
  const { registry } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 'to_delete',
    type: 'sftp',
  });

  const success = await registry.deleteRemote(remoteId);
  assert.equal(success, true);

  const lookup = await registry.getRemote(remoteId);
  assert.equal(lookup, null);
});

test('testRemote verifies connectivity and updates status', async (t) => {
  const { registry, manager, root } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 's3_prod',
    type: 's3',
    credentials: { key: 'secret' },
  });

  const result = await registry.testRemote(remoteId, { tempDir: root });
  assert.equal(result.reachable, true);

  const afterTest = await registry.getRemote(remoteId);
  assert.equal(afterTest.status, 'verified');
  assert.equal(afterTest.lastTestedAt, '2026-09-20T10:05:00.000Z');
  assert.equal(afterTest.error, null);

  // Verify manager was called with decrypted remote
  const writeCall = manager.calls.find((c) => c.method === 'writeConfigFile');
  assert.ok(writeCall);
  assert.equal(writeCall.remotes[0].name, 's3_prod');
  assert.deepEqual(writeCall.remotes[0].credentials, { key: 'secret' });
});

test('testRemote records error status on failure', async (t) => {
  const { registry, root } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 'failing_remote',
    type: 's3',
  });

  await assert.rejects(
    registry.testRemote(remoteId, { tempDir: root }),
    (err) => err.message.includes('Connection refused'),
  );

  const afterFailure = await registry.getRemote(remoteId);
  assert.equal(afterFailure.status, 'error');
  assert.ok(afterFailure.error.includes('Connection refused'));
});

test('materializeConfigFile exports remotes with decrypted credentials', async (t) => {
  const { registry, manager } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 'rclone_s3',
    type: 's3',
    parameters: { provider: 'AWS' },
    credentials: { access_key_id: 'ID1', secret_access_key: 'KEY1' },
  });

  const result = await registry.materializeConfigFile('/etc/yunpanel/rclone.conf', { serverId });
  assert.equal(result.targetPath, '/etc/yunpanel/rclone.conf');
  assert.equal(result.remoteCount, 1);

  const writeCall = manager.calls.find((c) => c.method === 'writeConfigFile' && c.targetPath === '/etc/yunpanel/rclone.conf');
  assert.ok(writeCall);
  assert.deepEqual(writeCall.remotes[0].credentials, { access_key_id: 'ID1', secret_access_key: 'KEY1' });
});

test('persisted remotes and encrypted credentials survive reload', async (t) => {
  const { filePath, masterKey, registry } = await fixture(t);

  await registry.createRemote({
    remoteId,
    serverId,
    name: 'persistent_remote',
    type: 'b2',
    credentials: { key: 'persistent-secret-key' },
  });

  // Reload registry from file
  const reloaded = createRcloneRemoteRegistry({
    filePath,
    masterKey,
    serverExists: async (id) => id === serverId,
  });
  await reloaded.init();

  const remote = await reloaded.getRemote(remoteId);
  assert.ok(remote);
  assert.equal(remote.name, 'persistent_remote');

  const revealed = reloaded.revealCredentials(remoteId);
  assert.deepEqual(revealed, { key: 'persistent-secret-key' });
});
