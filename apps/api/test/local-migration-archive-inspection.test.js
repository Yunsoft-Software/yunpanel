import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectVerifiedLocalMigrationArchive,
  localMigrationArchiveInspectionInternals,
} from '../src/local-migration-archive-inspection.js';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';

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

function line(type, name, suffix = '') {
  const mode = type === 'd' ? 'drwx------' : type === 'l' ? 'lrwxrwxrwx' : type === 'h' ? 'hrw-------' : '-rw-------';
  const quoted = JSON.stringify(name);
  return `${mode} 0/0 1 2026-09-10 15:00 ${quoted}${suffix}`;
}

const roots = [
  { path: '/etc/yunpanel', type: 'directory', present: true },
  { path: '/var/lib/yunpanel', type: 'directory', present: true },
  { path: '/etc/passwd', type: 'file', present: true },
  { path: '/etc/group', type: 'file', present: true },
  { path: '/etc/nginx', type: 'directory', present: true },
  { path: '/etc/letsencrypt', type: 'directory', present: true },
  { path: '/etc/systemd/system/yun-agent.service', type: 'file', present: false },
];

function validListing() {
  return [
    line('d', 'etc/yunpanel/'),
    line('-', 'etc/yunpanel/api.env'),
    line('d', 'var/lib/yunpanel/'),
    line('d', 'var/lib/yunpanel/data/'),
    line('-', 'var/lib/yunpanel/data/file'),
    line('h', 'var/lib/yunpanel/data/hard', ` link to ${JSON.stringify('var/lib/yunpanel/data/file')}`),
    line('-', 'etc/passwd'),
    line('-', 'etc/group'),
    line('d', 'etc/nginx/'),
    line('d', 'etc/nginx/sites-enabled/'),
    line('l', 'etc/nginx/sites-enabled/app', ` -> ${JSON.stringify('../sites-available/app')}`),
    line('l', 'etc/nginx/sites-enabled/absolute-app', ` -> ${JSON.stringify('/etc/nginx/sites-available/app')}`),
    line('d', 'etc/letsencrypt/'),
    line('d', 'etc/letsencrypt/live/'),
    line('d', 'etc/letsencrypt/live/example/'),
    line('l', 'etc/letsencrypt/live/example/fullchain.pem', ` -> ${JSON.stringify('../../archive/example/fullchain1.pem')}`),
    '',
  ].join('\n');
}

test('archive inspection accepts only links resolving inside their verified source root', async () => {
  const result = await inspectVerifiedLocalMigrationArchive({
    backupDirectory,
    verification: verification(roots),
    runTar: async (args) => {
      assert.deepEqual(args.slice(0, 4), ['--list', '--verbose', '--numeric-owner', '--quoting-style=c']);
      return { stdout: validListing() };
    },
  });

  assert.equal(result.destructive, false);
  assert.equal(result.linksSafe, true);
  assert.deepEqual(result.counts, {
    total: 16,
    files: 5,
    directories: 7,
    symlinks: 3,
    hardlinks: 1,
  });
});

test('relative symlink escape outside its source root is rejected', async () => {
  const listing = validListing().replace(
    `${JSON.stringify('../sites-available/app')}`,
    `${JSON.stringify('../../../etc/passwd')}`,
  );
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: listing }),
    }),
    { code: 'migration_archive_link_escape' },
  );
});

test('hard links cannot target another verified root or a missing archive member', async () => {
  const crossRoot = validListing().replace(
    `link to ${JSON.stringify('var/lib/yunpanel/data/file')}`,
    `link to ${JSON.stringify('etc/passwd')}`,
  );
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: crossRoot }),
    }),
    { code: 'migration_archive_link_escape' },
  );

  const missingTarget = validListing().replace(
    `link to ${JSON.stringify('var/lib/yunpanel/data/file')}`,
    `link to ${JSON.stringify('var/lib/yunpanel/data/missing')}`,
  );
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: missingTarget }),
    }),
    { code: 'migration_archive_hardlink_target_missing' },
  );
});

test('duplicate archive paths fail closed before restore staging', async () => {
  const duplicate = `${validListing()}${line('-', 'etc/passwd')}\n`;
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: duplicate }),
    }),
    { code: 'migration_archive_duplicate_member' },
  );
});

test('special filesystem members and manifest root type drift are rejected', async () => {
  const special = `${validListing()}prw------- 0/0 0 2026-09-10 15:00 ${JSON.stringify('var/lib/yunpanel/data/fifo')}\n`;
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: special }),
    }),
    { code: 'migration_archive_special_member' },
  );

  const wrongRootType = validListing().replace(line('d', 'etc/yunpanel/'), line('-', 'etc/yunpanel'));
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: wrongRootType }),
    }),
    { code: 'migration_archive_root_type_mismatch' },
  );
});

test('C quoted names decode escapes without turning them into path separators', () => {
  const parsed = localMigrationArchiveInspectionInternals.extractCStringLiterals(
    '-rw------- 0/0 1 2026-09-10 15:00 "var/lib/yunpanel/space file\\tname"',
  );
  assert.deepEqual(parsed, ['var/lib/yunpanel/space file\tname']);
});
