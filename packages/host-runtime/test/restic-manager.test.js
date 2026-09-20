import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createResticManager,
  ResticError,
  resticManagerInternals,
} from '../src/restic-manager.js';

const mockBinary = '/usr/bin/restic';
const repoPath = '/var/lib/yunpanel/backups/restic/repo1';
const repoPassword = 'super-secret-backup-pass';

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

test('initRepository initializes repository and returns structured receipt', async () => {
  const { runCommand, calls } = createMockRunner({
    init: () => ({
      stdout: JSON.stringify({ id: '9a8b7c6d5e4f', message: 'created restic repository' }),
      stderr: '',
    }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:00:00.000Z'),
  });

  const result = await manager.init({ repository: repoPath, password: repoPassword });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, mockBinary);
  assert.deepEqual(calls[0].args, ['init', '--json']);
  assert.equal(calls[0].options.env.RESTIC_REPOSITORY, repoPath);
  assert.equal(calls[0].options.env.RESTIC_PASSWORD, repoPassword);

  assert.equal(result.repository, repoPath);
  assert.equal(result.id, '9a8b7c6d5e4f');
  assert.equal(result.initializedAt, '2026-09-20T10:00:00.000Z');
});

test('check verifies repository integrity and handles readDataSubset', async () => {
  const { runCommand, calls } = createMockRunner({
    check: () => ({ stdout: 'no errors were found', stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const result = await manager.check({ repository: repoPath, password: repoPassword, readDataSubset: '20%' });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['check', '--json', '--read-data-subset=20%']);
  assert.equal(result.healthy, true);
  assert.equal(result.output, 'no errors were found');
});

test('unlock removes stale repository locks', async () => {
  const { runCommand, calls } = createMockRunner({
    unlock: () => ({ stdout: 'successfully removed locks', stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const result = await manager.unlock({ repository: repoPath, password: repoPassword, removeAll: true });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['unlock', '--remove-all']);
  assert.equal(result.unlocked, true);
});

test('createSnapshot parses streaming json and returns normalized snapshot receipt', async () => {
  const stdout = [
    JSON.stringify({ message_type: 'status', percent_done: 0.2 }),
    JSON.stringify({ message_type: 'status', percent_done: 0.8 }),
    JSON.stringify({
      message_type: 'summary',
      files_new: 15,
      files_changed: 3,
      files_unmodified: 100,
      dirs_new: 2,
      dirs_changed: 1,
      dirs_unmodified: 10,
      data_blobs: 25,
      tree_blobs: 5,
      data_added: 4096000,
      total_files_processed: 118,
      total_bytes_processed: 52428800,
      total_duration: 1.25,
      snapshot_id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    }),
  ].join('\n');

  const { runCommand, calls } = createMockRunner({
    backup: () => ({ stdout, stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:05:00.000Z'),
  });

  const result = await manager.createSnapshot({
    repository: repoPath,
    password: repoPassword,
    paths: ['/var/www/site1', '/var/log/site1'],
    tags: ['site:1', 'tier:prod'],
    excludes: ['*.tmp', '*.log'],
    parentSnapshotId: 'a1b2c3d4e5f6',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'backup', '--json',
    '--tag', 'site:1', '--tag', 'tier:prod',
    '--exclude', '*.tmp', '--exclude', '*.log',
    '--parent', 'a1b2c3d4e5f6',
    '/var/www/site1', '/var/log/site1',
  ]);

  assert.equal(result.snapshotId, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(result.shortId, 'e3b0c442');
  assert.equal(result.filesNew, 15);
  assert.equal(result.filesChanged, 3);
  assert.equal(result.filesUnmodified, 100);
  assert.equal(result.bytesAdded, 4096000);
  assert.equal(result.totalFiles, 118);
  assert.equal(result.totalBytes, 52428800);
  assert.equal(result.durationSeconds, 1.25);
  assert.equal(result.createdAt, '2026-09-20T10:05:00.000Z');
});

test('listSnapshots parses JSON array into normalized snapshot list', async () => {
  const snapshotsJson = JSON.stringify([
    {
      id: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      short_id: 'e3b0c442',
      time: '2026-09-20T10:05:00.000Z',
      paths: ['/var/www/site1'],
      tags: ['site:1'],
      hostname: 'prod-server',
      username: 'root',
      summary: { total_bytes_processed: 52428800 },
    },
  ]);

  const { runCommand, calls } = createMockRunner({
    snapshots: () => ({ stdout: snapshotsJson, stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const list = await manager.listSnapshots({
    repository: repoPath,
    password: repoPassword,
    tags: ['site:1'],
    path: '/var/www/site1',
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['snapshots', '--json', '--tag', 'site:1', '--path', '/var/www/site1']);
  assert.equal(list.length, 1);
  assert.equal(list[0].shortId, 'e3b0c442');
  assert.equal(list[0].hostname, 'prod-server');
  assert.deepEqual(list[0].paths, ['/var/www/site1']);
  assert.deepEqual(list[0].tags, ['site:1']);
});

test('forget applies retention policy with optional prune', async () => {
  const forgetOutput = JSON.stringify([
    {
      tags: ['site:1'],
      host: 'prod-server',
      paths: ['/var/www/site1'],
      keep: [{ id: 'keep1', short_id: 'k1' }],
      remove: [{ id: 'rem1', short_id: 'r1' }, { id: 'rem2', short_id: 'r2' }],
    },
  ]);

  const { runCommand, calls } = createMockRunner({
    forget: () => ({ stdout: forgetOutput, stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:10:00.000Z'),
  });

  const result = await manager.forget({
    repository: repoPath,
    password: repoPassword,
    policy: {
      keepLast: 5,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
      keepTags: ['preserve'],
    },
    prune: true,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'forget', '--json',
    '--keep-last', '5',
    '--keep-daily', '7',
    '--keep-weekly', '4',
    '--keep-monthly', '12',
    '--keep-tag', 'preserve',
    '--prune',
  ]);

  assert.deepEqual(result.keptSnapshots, ['keep1']);
  assert.deepEqual(result.removedSnapshots, ['rem1', 'rem2']);
  assert.equal(result.pruned, true);
  assert.equal(result.executedAt, '2026-09-20T10:10:00.000Z');
});

test('prune cleans unreferenced data and parses reclaimed bytes', async () => {
  const stdout = JSON.stringify({
    message_type: 'summary',
    bytes_freed: 10485760,
    packs_removed: 8,
  });

  const { runCommand, calls } = createMockRunner({
    prune: () => ({ stdout, stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:15:00.000Z'),
  });

  const result = await manager.prune({ repository: repoPath, password: repoPassword });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['prune', '--json']);
  assert.equal(result.bytesFreed, 10485760);
  assert.equal(result.packsRemoved, 8);
});

test('restore extracts snapshot to targetDirectory with includes/excludes', async () => {
  const { runCommand, calls } = createMockRunner({
    restore: () => ({ stdout: 'restoring files...', stderr: '' }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
    now: () => Date.parse('2026-09-20T10:20:00.000Z'),
  });

  const result = await manager.restore({
    repository: repoPath,
    password: repoPassword,
    snapshotId: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    targetDirectory: '/tmp/restore-target',
    include: ['*.html'],
    exclude: ['*.bak'],
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'restore',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '--target', '/tmp/restore-target',
    '--include', '*.html',
    '--exclude', '*.bak',
  ]);
  assert.equal(result.snapshotId, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(result.targetDirectory, '/tmp/restore-target');
});

test('stats returns repository statistics', async () => {
  const { runCommand, calls } = createMockRunner({
    stats: () => ({
      stdout: JSON.stringify({ total_size: 104857600, total_file_count: 500 }),
      stderr: '',
    }),
  });
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand,
  });

  const result = await manager.stats({ repository: repoPath, password: repoPassword });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['stats', '--mode', 'restore-size', '--json']);
  assert.equal(result.totalBytes, 104857600);
  assert.equal(result.totalFiles, 500);
  assert.equal(result.mode, 'restore-size');
});

test('error mapping correctly identifies restic error states', async () => {
  // 1. Binary missing
  const missingBinaryManager = createResticManager({
    resticPath: '/opt/nonexistent/restic',
    accessFn: async () => { throw new Error('ENOENT'); },
  });
  await assert.rejects(
    missingBinaryManager.init({ repository: repoPath, password: repoPassword }),
    (err) => err instanceof ResticError && err.code === 'restic_binary_missing' && err.status === 503,
  );

  // 2. Repo locked
  const lockedManager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('lock failed');
      err.stderr = 'unable to create lock in repo: repository is already locked exclusively by PID 1234';
      throw err;
    },
  });
  await assert.rejects(
    lockedManager.createSnapshot({ repository: repoPath, password: repoPassword, paths: ['/var/www'] }),
    (err) => err instanceof ResticError && err.code === 'restic_repo_locked' && err.status === 409,
  );

  // 3. Wrong password
  const wrongPassManager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('auth failed');
      err.stderr = 'Fatal: wrong password or no key found';
      throw err;
    },
  });
  await assert.rejects(
    wrongPassManager.listSnapshots({ repository: repoPath, password: 'wrong' }),
    (err) => err instanceof ResticError && err.code === 'restic_password_invalid' && err.status === 401,
  );

  // 4. Repo not initialized
  const uninitializedManager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('not found');
      err.stderr = 'Fatal: repository does not exist, run restic init to create it';
      throw err;
    },
  });
  await assert.rejects(
    uninitializedManager.check({ repository: repoPath, password: repoPassword }),
    (err) => err instanceof ResticError && err.code === 'restic_repo_not_initialized' && err.status === 404,
  );

  // 5. Repo already initialized
  const alreadyInitManager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('already init');
      err.stderr = 'Fatal: config file already exists';
      throw err;
    },
  });
  await assert.rejects(
    alreadyInitManager.init({ repository: repoPath, password: repoPassword }),
    (err) => err instanceof ResticError && err.code === 'restic_repo_already_initialized' && err.status === 409,
  );

  // 6. Snapshot not found
  const noSnapshotManager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
    runCommand: async () => {
      const err = new Error('snapshot missing');
      err.stderr = 'Fatal: specified snapshot does not exist';
      throw err;
    },
  });
  await assert.rejects(
    noSnapshotManager.restore({ repository: repoPath, password: repoPassword, snapshotId: '12345678', targetDirectory: '/tmp' }),
    (err) => err instanceof ResticError && err.code === 'restic_snapshot_not_found' && err.status === 404,
  );
});

test('validation rejects invalid inputs', async () => {
  const manager = createResticManager({
    resticPath: mockBinary,
    accessFn: async () => {},
  });

  await assert.rejects(
    manager.init({ repository: '', password: 'pass' }),
    (err) => err instanceof ResticError && err.code === 'restic_repository_invalid',
  );

  await assert.rejects(
    manager.init({ repository: repoPath, password: '' }),
    (err) => err instanceof ResticError && err.code === 'restic_password_invalid',
  );

  await assert.rejects(
    manager.createSnapshot({ repository: repoPath, password: repoPassword, paths: [] }),
    (err) => err instanceof ResticError && err.code === 'restic_argument_invalid',
  );

  await assert.rejects(
    manager.restore({ repository: repoPath, password: repoPassword, snapshotId: 'not-hex!', targetDirectory: '/tmp' }),
    (err) => err instanceof ResticError && err.code === 'restic_snapshot_id_invalid',
  );

  await assert.rejects(
    manager.restore({ repository: repoPath, password: repoPassword, snapshotId: '12345678', targetDirectory: 'relative/path' }),
    (err) => err instanceof ResticError && err.code === 'restic_argument_invalid',
  );
});
