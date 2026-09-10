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

function line(type, name, suffix = '', { permissions = null, marker = '', uid = 0, gid = 0 } = {}) {
  const base = permissions ?? (type === 'd' ? 'rwx------' : type === 'l' ? 'rwxrwxrwx' : 'rw-------');
  const mode = `${type}${base}${marker}`;
  const quoted = JSON.stringify(name);
  return `${mode} ${uid}/${gid} 1 2026-09-10 15:00 ${quoted}${suffix}`;
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
    line('d', 'etc/yunpanel/', '', { permissions: 'rwxr-x---', uid: 0, gid: 0 }),
    line('-', 'etc/yunpanel/api.env', '', { permissions: 'rw-r-----', uid: 0, gid: 0, marker: '*' }),
    line('d', 'var/lib/yunpanel/', '', { permissions: 'rwx------', uid: 0, gid: 0 }),
    line('d', 'var/lib/yunpanel/data/', '', { permissions: 'rwxr-x---', uid: 0, gid: 0 }),
    line('-', 'var/lib/yunpanel/data/file', '', { permissions: 'rw-r-----', uid: 101, gid: 202 }),
    line('h', 'var/lib/yunpanel/data/hard', ` link to ${JSON.stringify('var/lib/yunpanel/data/file')}`, { permissions: 'rw-r-----', uid: 101, gid: 202 }),
    line('-', 'etc/passwd', '', { permissions: 'rw-r--r--', uid: 0, gid: 0 }),
    line('-', 'etc/group', '', { permissions: 'rw-r--r--', uid: 0, gid: 0 }),
    line('d', 'etc/nginx/', '', { permissions: 'rwxr-xr-x', uid: 0, gid: 0 }),
    line('d', 'etc/nginx/sites-enabled/', '', { permissions: 'rwxr-xr-x', uid: 0, gid: 0 }),
    line('l', 'etc/nginx/sites-enabled/app', ` -> ${JSON.stringify('../sites-available/app')}`),
    line('l', 'etc/nginx/sites-enabled/absolute-app', ` -> ${JSON.stringify('/etc/nginx/sites-available/app')}`),
    line('d', 'etc/letsencrypt/', '', { permissions: 'rwxr-xr-x', uid: 0, gid: 0 }),
    line('d', 'etc/letsencrypt/live/', '', { permissions: 'rwx------', uid: 0, gid: 0 }),
    line('d', 'etc/letsencrypt/live/example/', '', { permissions: 'rwxr-xr-x', uid: 0, gid: 0 }),
    line('l', 'etc/letsencrypt/live/example/fullchain.pem', ` -> ${JSON.stringify('../../archive/example/fullchain1.pem')}`),
    '',
  ].join('\n');
}

test('archive inspection accepts in-root links and captures bounded numeric ownership metadata', async () => {
  const result = await inspectVerifiedLocalMigrationArchive({
    backupDirectory,
    verification: verification(roots),
    runTar: async (args) => {
      assert.deepEqual(args.slice(0, 7), [
        '--list', '--verbose', '--numeric-owner', '--acls', '--xattrs', '--quoting-style=c', '--file',
      ]);
      return { stdout: validListing() };
    },
  });

  assert.equal(result.destructive, false);
  assert.equal(result.linksSafe, true);
  assert.equal(result.ownershipMetadata, true);
  assert.equal(result.extendedMetadataValidated, false);
  assert.deepEqual(result.counts, {
    total: 16,
    files: 4,
    directories: 8,
    symlinks: 3,
    hardlinks: 1,
    extendedMetadata: 1,
  });
  assert.equal(result.members.length, 16);
  assert.deepEqual(
    result.members.find((entry) => entry.name === 'etc/nginx/sites-enabled/app'),
    {
      name: 'etc/nginx/sites-enabled/app',
      type: 'l',
      root: '/etc/nginx',
      resolvedLinkTarget: 'etc/nginx/sites-available/app',
      uid: 0,
      gid: 0,
      mode: 0o777,
      metadataMarker: null,
    },
  );
  assert.deepEqual(
    result.members.find((entry) => entry.name === 'var/lib/yunpanel/data/hard'),
    {
      name: 'var/lib/yunpanel/data/hard',
      type: 'h',
      root: '/var/lib/yunpanel',
      resolvedLinkTarget: 'var/lib/yunpanel/data/file',
      uid: 101,
      gid: 202,
      mode: 0o640,
      metadataMarker: null,
    },
  );
  assert.deepEqual(
    result.members.find((entry) => entry.name === 'etc/yunpanel/api.env'),
    {
      name: 'etc/yunpanel/api.env',
      type: '-',
      root: '/etc/yunpanel',
      resolvedLinkTarget: null,
      uid: 0,
      gid: 0,
      mode: 0o640,
      metadataMarker: '*',
    },
  );
  assert.equal(Object.hasOwn(result.members[0], 'linkTarget'), false);
});

test('permission parser preserves setuid setgid and sticky bits without applying them', () => {
  assert.equal(localMigrationArchiveInspectionInternals.parsePermissionMode('rwsr-sr-t'), 0o7755);
  assert.equal(localMigrationArchiveInspectionInternals.parsePermissionMode('rwSr-Sr-T'), 0o7644);
});

test('invalid owner, permission and extended-metadata markers fail closed', async () => {
  for (const [listing, code] of [
    [validListing().replace(' 101/202 1 ', ' root/202 1 '), 'migration_archive_owner_invalid'],
    [validListing().replace('-rw-r-----* 0/0', '-rw-r--q--* 0/0'), 'migration_archive_mode_invalid'],
    [validListing().replace('-rw-r-----* 0/0', '-rw-r-----@ 0/0'), 'migration_archive_metadata_marker_invalid'],
  ]) {
    await assert.rejects(
      inspectVerifiedLocalMigrationArchive({
        backupDirectory,
        verification: verification(roots),
        runTar: async () => ({ stdout: listing }),
      }),
      { code },
    );
  }
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

  const wrongRootType = validListing().replace(
    line('d', 'etc/yunpanel/', '', { permissions: 'rwxr-x---', uid: 0, gid: 0 }),
    line('-', 'etc/yunpanel', '', { permissions: 'rw-r-----', uid: 0, gid: 0 }),
  );
  await assert.rejects(
    inspectVerifiedLocalMigrationArchive({
      backupDirectory,
      verification: verification(roots),
      runTar: async () => ({ stdout: wrongRootType }),
    }),
    { code: 'migration_archive_root_type_mismatch' },
  );
});

test('C quoted control characters are rejected as archive member paths', () => {
  const parsed = localMigrationArchiveInspectionInternals.extractCStringLiterals(
    '-rw------- 0/0 1 2026-09-10 15:00 "var/lib/yunpanel/space file\\tname"',
  );
  assert.deepEqual(parsed, ['var/lib/yunpanel/space file\tname']);
  assert.throws(
    () => localMigrationArchiveInspectionInternals.normalizeMemberName(parsed[0]),
    { code: 'migration_archive_member_invalid' },
  );
});
