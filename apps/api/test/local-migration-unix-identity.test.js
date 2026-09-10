import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLocalMigrationUnixIdentities,
  localMigrationUnixIdentityInternals,
} from '../src/local-migration-unix-identity.js';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';
const archivePath = `${backupDirectory}/state.tar`;

function verification() {
  return {
    verified: true,
    backupDirectory,
    archivePath,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256: 'a'.repeat(64),
    entries: [
      { path: '/etc/passwd', type: 'file', present: true },
      { path: '/etc/group', type: 'file', present: true },
    ],
  };
}

function fileMetadata(size, { symlink = false } = {}) {
  return {
    size,
    isSymbolicLink: () => symlink,
    isFile: () => true,
  };
}

function runner({ snapshotPasswd, snapshotGroup, listing = 'etc/passwd\netc/group\n', calls = [] }) {
  return async (args) => {
    calls.push(args);
    if (args[0] === '--list') return { stdout: listing };
    if (args[0] === '--extract' && args.at(-1) === 'etc/passwd') return { stdout: snapshotPasswd };
    if (args[0] === '--extract' && args.at(-1) === 'etc/group') return { stdout: snapshotGroup };
    throw new Error('unexpected tar invocation');
  };
}

test('migration identity comparison reports match, drift, missing and added yunapp users without mutation', async () => {
  const snapshotPasswd = [
    'root:x:0:0:root:/root:/bin/bash',
    'yunapp-aaaaaaaaaaaa:x:900:900::/var/lib/yunpanel/data/a:/usr/sbin/nologin',
    'yunapp-bbbbbbbbbbbb:x:901:901::/var/lib/yunpanel/data/b:/usr/sbin/nologin',
    'yunapp-cccccccccccc:x:902:902::/var/lib/yunpanel/data/c:/usr/sbin/nologin',
    '',
  ].join('\n');
  const snapshotGroup = [
    'root:x:0:',
    'yunapp-aaaaaaaaaaaa:x:900:',
    'yunapp-bbbbbbbbbbbb:x:901:',
    'yunapp-cccccccccccc:x:902:',
    'deployers:x:950:yunapp-aaaaaaaaaaaa',
    '',
  ].join('\n');
  const currentPasswd = [
    'root:x:0:0:root:/root:/bin/bash',
    'yunapp-aaaaaaaaaaaa:x:900:900::/var/lib/yunpanel/data/a:/usr/sbin/nologin',
    'yunapp-bbbbbbbbbbbb:x:911:901::/var/lib/yunpanel/data/b:/usr/sbin/nologin',
    'yunapp-dddddddddddd:x:903:903::/var/lib/yunpanel/data/d:/usr/sbin/nologin',
    '',
  ].join('\n');
  const currentGroup = [
    'root:x:0:',
    'yunapp-aaaaaaaaaaaa:x:900:',
    'yunapp-bbbbbbbbbbbb:x:901:',
    'yunapp-dddddddddddd:x:903:',
    'deployers:x:950:yunapp-aaaaaaaaaaaa,yunapp-bbbbbbbbbbbb',
    '',
  ].join('\n');
  const tarCalls = [];
  const readCalls = [];
  const result = await compareLocalMigrationUnixIdentities({
    backupDirectory,
    verifyBackup: async () => verification(),
    runTar: runner({ snapshotPasswd, snapshotGroup, calls: tarCalls }),
    lstatFn: async (target) => fileMetadata(Buffer.byteLength(target === '/etc/passwd' ? currentPasswd : currentGroup)),
    readFileFn: async (target) => {
      readCalls.push(target);
      return target === '/etc/passwd' ? currentPasswd : currentGroup;
    },
  });

  assert.equal(result.destructive, false);
  assert.equal(result.snapshotUsers, 3);
  assert.equal(result.currentUsers, 3);
  assert.deepEqual(result.counts, { match: 1, drift: 1, missingCurrent: 1, addedCurrent: 1 });
  assert.equal(result.identities.find((entry) => entry.name === 'yunapp-aaaaaaaaaaaa').status, 'match');
  assert.deepEqual(
    result.identities.find((entry) => entry.name === 'yunapp-bbbbbbbbbbbb').changedFields,
    ['uid', 'supplementaryGroups'],
  );
  assert.equal(result.identities.find((entry) => entry.name === 'yunapp-cccccccccccc').status, 'missing_current');
  assert.equal(result.identities.find((entry) => entry.name === 'yunapp-dddddddddddd').status, 'added_current');
  assert.deepEqual(readCalls.sort(), ['/etc/group', '/etc/passwd']);
  assert.equal(tarCalls.filter((args) => args[0] === '--extract').length, 2);
  assert.equal(tarCalls.filter((args) => args[0] === '--list').length, 1);
});

test('managed Unix identity parser ignores unrelated accounts and requires the exact yunapp naming contract', () => {
  const users = localMigrationUnixIdentityInternals.parseManagedPasswd([
    'normal:x:1000:1000::/home/normal:/bin/bash',
    'yunapp-nothex:x:900:900::/tmp/no:/usr/sbin/nologin',
    'yunapp-0123456789ab:x:901:901::/var/lib/yunpanel/data/x:/usr/sbin/nologin',
    '',
  ].join('\n'), 'Fixture');
  assert.deepEqual([...users.keys()], ['yunapp-0123456789ab']);
});

test('snapshot identity members must be exact and unique before archive content is read', async () => {
  let readCalls = 0;
  await assert.rejects(
    compareLocalMigrationUnixIdentities({
      backupDirectory,
      verifyBackup: async () => verification(),
      runTar: runner({
        snapshotPasswd: '',
        snapshotGroup: '',
        listing: 'etc/passwd\netc/passwd\netc/group\n',
      }),
      lstatFn: async () => fileMetadata(0),
      readFileFn: async () => { readCalls += 1; return ''; },
    }),
    { code: 'migration_identity_snapshot_members_invalid' },
  );
  assert.equal(readCalls, 0);
});

test('managed user without same-name dedicated primary group fails closed', async () => {
  const passwd = 'yunapp-0123456789ab:x:901:901::/var/lib/yunpanel/data/x:/usr/sbin/nologin\n';
  const wrongGroup = 'other:x:901:\n';
  await assert.rejects(
    compareLocalMigrationUnixIdentities({
      backupDirectory,
      verifyBackup: async () => verification(),
      runTar: runner({ snapshotPasswd: passwd, snapshotGroup: wrongGroup }),
      lstatFn: async (target) => fileMetadata(Buffer.byteLength(target === '/etc/passwd' ? passwd : wrongGroup)),
      readFileFn: async (target) => target === '/etc/passwd' ? passwd : wrongGroup,
    }),
    { code: 'migration_identity_dedicated_group_invalid' },
  );
});

test('current passwd or group symlink is rejected before reading identity contents', async () => {
  let readCalls = 0;
  await assert.rejects(
    compareLocalMigrationUnixIdentities({
      backupDirectory,
      verifyBackup: async () => verification(),
      runTar: runner({ snapshotPasswd: '', snapshotGroup: '' }),
      lstatFn: async (target) => fileMetadata(0, { symlink: target === '/etc/passwd' }),
      readFileFn: async () => { readCalls += 1; return ''; },
    }),
    { code: 'migration_identity_current_unsafe' },
  );
  assert.equal(readCalls, 1);
});
