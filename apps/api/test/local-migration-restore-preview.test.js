import assert from 'node:assert/strict';
import test from 'node:test';
import { previewLocalMigrationRestore } from '../src/local-migration-restore-preview.js';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';

function metadata(type, { uid = 0, gid = 0, mode = 0o700, symlink = false } = {}) {
  return {
    uid,
    gid,
    mode,
    isSymbolicLink: () => symlink,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  };
}

function verification(entries) {
  return {
    verified: true,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256: 'a'.repeat(64),
    entries,
  };
}

function archiveInspection(overrides = {}) {
  return {
    destructive: false,
    linksSafe: true,
    backupDirectory,
    sha256: 'a'.repeat(64),
    counts: { total: 4, files: 2, directories: 2, symlinks: 0, hardlinks: 0 },
    ...overrides,
  };
}

function identityComparison(overrides = {}) {
  return {
    destructive: false,
    backupDirectory,
    sha256: 'a'.repeat(64),
    snapshotUsers: 2,
    currentUsers: 2,
    counts: { match: 2, drift: 0, missingCurrent: 0, addedCurrent: 0 },
    identities: [
      { name: 'yunapp-aaaaaaaaaaaa', status: 'match', changedFields: [] },
      { name: 'yunapp-bbbbbbbbbbbb', status: 'match', changedFields: [] },
    ],
    ...overrides,
  };
}

test('restore preview shares one verified backup with archive and Unix identity inspection', async () => {
  const entries = [
    { path: '/etc/yunpanel', type: 'directory', present: true },
    { path: '/var/lib/yunpanel', type: 'directory', present: true },
    { path: '/etc/passwd', type: 'file', present: true },
    { path: '/etc/group', type: 'file', present: true },
    { path: '/etc/nginx', type: 'directory', present: false },
    { path: '/etc/letsencrypt', type: 'directory', present: true },
  ];
  const current = new Map([
    ['/etc/yunpanel', metadata('directory', { mode: 0o750 })],
    ['/var/lib/yunpanel', metadata('directory')],
    ['/etc/passwd', metadata('file', { mode: 0o644 })],
    ['/etc/group', metadata('file', { mode: 0o644 })],
    ['/etc/nginx', metadata('directory', { mode: 0o755 })],
  ]);
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const calls = [];
  const verified = verification(entries);
  const result = await previewLocalMigrationRestore({
    backupDirectory,
    verifyBackup: async ({ backupDirectory: value }) => {
      calls.push(['verify', value]);
      return verified;
    },
    inspectArchive: async ({ backupDirectory: value, verification: acknowledgement }) => {
      calls.push(['archive', value, acknowledgement === verified]);
      return archiveInspection();
    },
    compareIdentities: async ({ backupDirectory: value, verification: acknowledgement }) => {
      calls.push(['identities', value, acknowledgement === verified]);
      return identityComparison();
    },
    lstatFn: async (target) => {
      calls.push(['lstat', target]);
      if (!current.has(target)) throw missing;
      return current.get(target);
    },
  });

  assert.equal(result.destructive, false);
  assert.equal(result.archiveInspection.linksSafe, true);
  assert.equal(result.targets.find((entry) => entry.path === '/etc/yunpanel').action, 'restore_replace');
  assert.equal(result.targets.find((entry) => entry.path === '/etc/letsencrypt').action, 'restore_missing');
  assert.equal(result.targets.find((entry) => entry.path === '/etc/nginx').action, 'preserve_current');
  assert.equal(result.targets.find((entry) => entry.path === '/etc/passwd').action, 'identity_reference');
  assert.equal(result.targets.find((entry) => entry.path === '/etc/group').action, 'identity_reference');
  assert.deepEqual(result.counts, { restore: 3, identityReferences: 2, preserved: 1 });
  assert.deepEqual(result.identityComparison.counts, { match: 2, drift: 0, missingCurrent: 0, addedCurrent: 0 });
  assert.deepEqual(calls[0], ['verify', backupDirectory]);
  assert.deepEqual(calls[1], ['archive', backupDirectory, true]);
  assert.equal(calls.filter((entry) => entry[0] === 'verify').length, 1);
  assert.ok(calls.some((entry) => entry[0] === 'identities' && entry[1] === backupDirectory && entry[2] === true));
});

test('restore preview surfaces type drift without silently treating it as safe replacement', async () => {
  const result = await previewLocalMigrationRestore({
    backupDirectory,
    verifyBackup: async () => verification([{ path: '/etc/yunpanel', type: 'directory', present: true }]),
    inspectArchive: async () => archiveInspection(),
    compareIdentities: async () => identityComparison(),
    lstatFn: async () => metadata('file'),
  });
  assert.equal(result.targets[0].action, 'restore_type_mismatch');
});

test('top-level symlink restore target fails closed after archive inspection and before identity comparison', async () => {
  let archiveCalls = 0;
  let identityCalls = 0;
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([{ path: '/etc/yunpanel', type: 'directory', present: true }]),
      inspectArchive: async () => { archiveCalls += 1; return archiveInspection(); },
      compareIdentities: async () => { identityCalls += 1; return identityComparison(); },
      lstatFn: async () => metadata('directory', { symlink: true }),
    }),
    { code: 'migration_restore_target_symlink' },
  );
  assert.equal(archiveCalls, 1);
  assert.equal(identityCalls, 0);
});

test('invalid or outside-root backup acknowledgement never reaches archive or target inspection', async () => {
  let archiveCalls = 0;
  let inspected = false;
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => ({ ...verification([]), backupDirectory: '/var/backups/yunpanel/migration-other' }),
      inspectArchive: async () => { archiveCalls += 1; return archiveInspection(); },
      compareIdentities: async () => identityComparison(),
      lstatFn: async () => { inspected = true; return metadata('directory'); },
    }),
    { code: 'migration_restore_backup_invalid' },
  );
  assert.equal(archiveCalls, 0);
  assert.equal(inspected, false);

  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory: '/tmp/outside',
      verifyBackup: async () => verification([]),
      inspectArchive: async () => { archiveCalls += 1; return archiveInspection(); },
      compareIdentities: async () => identityComparison(),
      lstatFn: async () => metadata('directory'),
    }),
    { code: 'migration_backup_directory_outside_root' },
  );
  assert.equal(archiveCalls, 0);
});

test('invalid archive inspection acknowledgement fails closed before target inspection', async () => {
  let inspected = false;
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => archiveInspection({ linksSafe: false }),
      compareIdentities: async () => identityComparison(),
      lstatFn: async () => { inspected = true; return metadata('directory'); },
    }),
    { code: 'migration_restore_archive_result_invalid' },
  );
  assert.equal(inspected, false);
});

test('archive inspection count mismatch fails closed', async () => {
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => archiveInspection({
        counts: { total: 5, files: 2, directories: 2, symlinks: 0, hardlinks: 0 },
      }),
      compareIdentities: async () => identityComparison(),
      lstatFn: async () => metadata('directory'),
    }),
    { code: 'migration_restore_archive_result_invalid' },
  );
});

test('unexpected archive inspector errors are redacted by restore preview', async () => {
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => { throw new Error('SECRET=/root/private/archive-token'); },
      compareIdentities: async () => identityComparison(),
      lstatFn: async () => metadata('directory'),
    }),
    (error) => {
      assert.equal(error.code, 'migration_restore_archive_unavailable');
      assert.equal(error.message, 'Migration restore archive inspection could not be completed');
      assert.doesNotMatch(error.message, /SECRET|token|\/root\/private/i);
      return true;
    },
  );
});

test('invalid identity comparison acknowledgement fails closed', async () => {
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => archiveInspection(),
      compareIdentities: async () => identityComparison({ destructive: true }),
      lstatFn: async () => metadata('directory'),
    }),
    { code: 'migration_restore_identity_result_invalid' },
  );
});

test('identity comparison count mismatch fails closed', async () => {
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => archiveInspection(),
      compareIdentities: async () => identityComparison({
        counts: { match: 2, drift: 1, missingCurrent: 0, addedCurrent: 0 },
      }),
      lstatFn: async () => metadata('directory'),
    }),
    { code: 'migration_restore_identity_result_invalid' },
  );
});

test('unexpected identity comparator errors are redacted by restore preview', async () => {
  await assert.rejects(
    previewLocalMigrationRestore({
      backupDirectory,
      verifyBackup: async () => verification([]),
      inspectArchive: async () => archiveInspection(),
      compareIdentities: async () => { throw new Error('SECRET=/root/private/token'); },
      lstatFn: async () => metadata('directory'),
    }),
    (error) => {
      assert.equal(error.code, 'migration_restore_identity_unavailable');
      assert.doesNotMatch(error.message, /SECRET|token|\/root\/private/);
      return true;
    },
  );
});
