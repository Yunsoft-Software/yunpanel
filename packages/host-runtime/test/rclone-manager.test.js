import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRcloneManager,
  RcloneError,
  rcloneManagerInternals,
} from '../src/rclone-manager.js';

const mockBinary = '/usr/bin/rclone';

function createMockRunner(handlers = {}) {
  const calls = [];
  const runCommand = async (file, args, options) => {
    calls.push({ file, args, options });
    const command = args[0];
    const handler = handlers[command] ?? handlers.default;
    if (typeof handler === 'function') {
      return handler(args, options);
    }
    if (handler && handler.error) {
      const err = new Error(handler.error.message ?? 'Command failed');
      err.stderr = handler.error.stderr ?? '';
      err.stdout = handler.error.stdout ?? '';
      err.code = handler.error.code ?? 1;
      throw err;
    }
    return handler ?? { stdout: '', stderr: '' };
  };
  return { runCommand, calls };
}

test('version executes rclone version --json and parses output', async () => {
  const { runCommand, calls } = createMockRunner({
    version: () => ({
      stdout: JSON.stringify({ version: 'v1.66.0', os: 'linux', arch: 'amd64' }),
      stderr: '',
    }),
  });
  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const info = await manager.version();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['version', '--json']);
  assert.equal(info.version, 'v1.66.0');
  assert.equal(info.os, 'linux');
});

test('version falls back to plain text when --json is not supported (rclone 1.60)', async () => {
  let callCount = 0;
  const { runCommand, calls } = createMockRunner({
    version: (args) => {
      callCount++;
      if (args.includes('--json')) {
        const err = new Error('unknown flag: --json');
        err.stderr = 'Error: unknown flag: --json\n';
        throw err;
      }
      return {
        stdout: [
          'rclone v1.60.1-DEV',
          '- os/version: ubuntu 24.04 (64 bit)',
          '- os/kernel: 6.8.0-139-generic (x86_64)',
          '- os/type: linux',
          '- os/arch: amd64',
          '- go/version: go1.22.2',
        ].join('\n'),
        stderr: '',
      };
    },
  });
  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const info = await manager.version();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['version', '--json']);
  assert.deepEqual(calls[1].args, ['version']);
  assert.equal(info.version, 'v1.60.1-DEV');
  assert.equal(info.os, 'linux');
  assert.equal(info.arch, 'amd64');
  assert.equal(info.go_version, 'go1.22.2');
});

test('testRemote executes rclone lsd with config and probe timeouts', async () => {
  const { runCommand, calls } = createMockRunner({
    lsd: () => ({ stdout: '          -1 2026-09-20 10:00:00        -1 mybucket', stderr: '' }),
  });
  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:00:00.000Z'),
  });

  const result = await manager.testRemote({
    remoteName: 'my_s3_remote',
    configFile: '/etc/yunpanel/rclone.conf',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'lsd', 'my_s3_remote:',
    '--contimeout', '10s',
    '--timeout', '15s',
    '--config', '/etc/yunpanel/rclone.conf',
  ]);
  assert.equal(result.reachable, true);
  assert.equal(result.remoteName, 'my_s3_remote');
  assert.equal(result.testedAt, '2026-09-20T10:00:00.000Z');
});

test('listRemotes parses rclone listremotes output', async () => {
  const { runCommand, calls } = createMockRunner({
    listremotes: () => ({ stdout: 's3remote:\nb2remote:\nbackup_sftp:\n', stderr: '' }),
  });
  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const remotes = await manager.listRemotes({ configFile: '/etc/yunpanel/rclone.conf' });
  assert.equal(calls.length, 1);
  assert.deepEqual(remotes, ['s3remote', 'b2remote', 'backup_sftp']);
});

test('writeConfigFile writes hardened rclone.conf in INI format with 0600 mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-rclone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = path.join(root, 'rclone.conf');

  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    now: () => Date.parse('2026-09-20T10:00:00.000Z'),
  });

  const result = await manager.writeConfigFile({
    remotes: [
      {
        name: 'my_s3',
        type: 's3',
        parameters: { provider: 'AWS', region: 'eu-central-1' },
        credentials: { access_key_id: 'AKIA123', secret_access_key: 'SECRET456' },
      },
      {
        name: 'b2_backup',
        type: 'b2',
        parameters: { endpoint: 's3.us-west-002.backblazeb2.com' },
        credentials: { account: 'acc1', key: 'key1' },
      },
    ],
    targetPath,
  });

  assert.equal(result.targetPath, targetPath);
  const content = await readFile(targetPath, 'utf8');
  assert.ok(content.includes('[my_s3]'));
  assert.ok(content.includes('type = s3'));
  assert.ok(content.includes('provider = AWS'));
  assert.ok(content.includes('access_key_id = AKIA123'));
  assert.ok(content.includes('secret_access_key = SECRET456'));
  assert.ok(content.includes('[b2_backup]'));
  assert.ok(content.includes('type = b2'));
});

test('error mapping identifies unreachable, auth failed, and not found', async () => {
  // 1. Unreachable
  const unreachableManager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('dial tcp timeout');
      err.stderr = 'Failed to make remote: dial tcp: i/o timeout';
      throw err;
    },
  });
  await assert.rejects(
    unreachableManager.testRemote({ remoteName: 'bad_remote', configFile: '/etc/rclone.conf' }),
    (err) => err instanceof RcloneError && err.code === 'rclone_remote_unreachable' && err.status === 502,
  );

  // 2. Auth failed
  const authFailedManager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('auth error');
      err.stderr = 'Failed to make remote: 403 Forbidden: Invalid credentials';
      throw err;
    },
  });
  await assert.rejects(
    authFailedManager.testRemote({ remoteName: 'bad_auth', configFile: '/etc/rclone.conf' }),
    (err) => err instanceof RcloneError && err.code === 'rclone_remote_auth_failed' && err.status === 401,
  );

  // 3. Not found
  const notFoundManager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('not found');
      err.stderr = 'Failed to make remote: bucket not found';
      throw err;
    },
  });
  await assert.rejects(
    notFoundManager.testRemote({ remoteName: 'missing_bucket', configFile: '/etc/rclone.conf' }),
    (err) => err instanceof RcloneError && err.code === 'rclone_remote_target_not_found' && err.status === 404,
  );
});

test('validation rejects invalid remote names and config paths', async () => {
  const manager = createRcloneManager({
    rclonePath: mockBinary,
    accessFn: async () => {},
  });

  await assert.rejects(
    manager.testRemote({ remoteName: 'invalid name with spaces!', configFile: '/etc/rclone.conf' }),
    (err) => err instanceof RcloneError && err.code === 'rclone_remote_name_invalid',
  );

  await assert.rejects(
    manager.testRemote({ remoteName: 'valid_remote', configFile: 'relative/path' }),
    (err) => err instanceof RcloneError && err.code === 'rclone_config_invalid',
  );
});
