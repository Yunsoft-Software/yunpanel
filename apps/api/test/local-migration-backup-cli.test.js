import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPackagedBackupDirectory,
  parseLocalMigrationBackupArguments,
  runLocalMigrationBackupCli,
} from '../../../scripts/local-migration-backup.mjs';

const packagedPath = '/usr/lib/yunpanel/scripts/local-migration-backup.mjs';
const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';

function verifiedResult() {
  return {
    verified: true,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256: 'a'.repeat(64),
    entries: [
      { path: '/etc/yunpanel', type: 'directory', present: true },
      { path: '/var/lib/yunpanel', type: 'directory', present: true },
      { path: '/etc/nginx', type: 'directory', present: false },
    ],
  };
}

function archiveMembers() {
  return [
    { name: 'etc/yunpanel', type: 'd', root: '/etc/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o750, metadataMarker: null },
    { name: 'etc/yunpanel/api.env', type: '-', root: '/etc/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o640, metadataMarker: '*' },
    { name: 'var/lib/yunpanel', type: 'd', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o700, metadataMarker: null },
    { name: 'var/lib/yunpanel/a', type: '-', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 101, gid: 101, mode: 0o640, metadataMarker: null },
    { name: 'var/lib/yunpanel/b', type: '-', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 101, gid: 101, mode: 0o640, metadataMarker: null },
    { name: 'var/lib/yunpanel/data', type: 'd', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 101, gid: 101, mode: 0o750, metadataMarker: null },
    { name: 'var/lib/yunpanel/cache', type: 'd', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 101, gid: 101, mode: 0o750, metadataMarker: null },
    { name: 'var/lib/yunpanel/link', type: 'l', root: '/var/lib/yunpanel', resolvedLinkTarget: 'var/lib/yunpanel/a', uid: 101, gid: 101, mode: 0o777, metadataMarker: null },
  ];
}

function archivePreview(value = backupDirectory, overrides = {}) {
  const members = archiveMembers();
  return {
    destructive: false,
    linksSafe: true,
    ownershipMetadata: true,
    extendedMetadataValidated: false,
    backupDirectory: value,
    sha256: 'a'.repeat(64),
    counts: { total: 8, files: 3, directories: 4, symlinks: 1, hardlinks: 0, extendedMetadata: 1 },
    members,
    ...overrides,
  };
}

function stagedResult(value = backupDirectory, overrides = {}) {
  return {
    validated: true,
    destructive: false,
    liveMutation: false,
    ownershipMetadata: true,
    extendedMetadata: 1,
    extendedMetadataValidated: false,
    backupDirectory: value,
    sha256: 'b'.repeat(64),
    stageDirectory: '/var/backups/yunpanel/.restore-staging/migration-2026-09-10T15-00-00-000Z-AbCd12',
    members: 8,
    ...overrides,
  };
}

test('migration backup CLI accepts only exact create, verify, preview and confirmed stage syntax', () => {
  assert.deepEqual(parseLocalMigrationBackupArguments(['create', '--confirm']), { action: 'create', confirm: true });
  assert.deepEqual(parseLocalMigrationBackupArguments(['verify', backupDirectory]), { action: 'verify', backupDirectory });
  assert.deepEqual(parseLocalMigrationBackupArguments(['preview', backupDirectory]), { action: 'preview', backupDirectory });
  assert.deepEqual(parseLocalMigrationBackupArguments(['stage', backupDirectory, '--confirm']), {
    action: 'stage', backupDirectory, confirm: true,
  });
  assert.throws(() => parseLocalMigrationBackupArguments(['create']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['verify', 'relative/path']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['preview', 'relative/path']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['stage', backupDirectory]), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['stage', 'relative/path', '--confirm']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['restore', backupDirectory]), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['verify', backupDirectory, '--confirm']), /Usage:/);
});

test('packaged migration backup CLI requires root and refuses non-packaged execution', async () => {
  await assert.rejects(
    runLocalMigrationBackupCli({ argv: ['verify', backupDirectory], filePath: packagedPath, uid: 1000 }),
    /must be run as root/,
  );
  await assert.rejects(
    runLocalMigrationBackupCli({ argv: ['verify', backupDirectory], filePath: '/work/scripts/local-migration-backup.mjs', uid: 0 }),
    /available only from the packaged YunPanel installation/,
  );
});

test('packaged verify, preview and stage can read only snapshot directories below the fixed backup root', () => {
  assert.equal(assertPackagedBackupDirectory(backupDirectory), backupDirectory);
  assert.throws(() => assertPackagedBackupDirectory('/var/backups/yunpanel'), /must be a snapshot below/);
  assert.throws(() => assertPackagedBackupDirectory('/tmp/yunpanel-copy'), /must be a snapshot below/);
  assert.throws(() => assertPackagedBackupDirectory('/var/backups/yunpanel-evil/migration-x'), /must be a snapshot below/);
});

test('create command verifies the newly created snapshot before printing safe metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runLocalMigrationBackupCli({
    argv: ['create', '--confirm'],
    filePath: packagedPath,
    uid: 0,
    createBackup: async ({ root }) => {
      calls.push(['create', root]);
      return { backupDirectory };
    },
    verifyBackup: async ({ backupDirectory: value }) => {
      calls.push(['verify', value]);
      return verifiedResult();
    },
    stdout: { write(value) { output.push(value); } },
  });

  assert.equal(result.verified, true);
  assert.deepEqual(calls, [
    ['create', '/var/backups/yunpanel'],
    ['verify', backupDirectory],
  ]);
  assert.match(output[0], /verified=true/);
  assert.match(output[0], /sourcesPresent=2/);
  assert.match(output[0], /sourcesMissingOptional=1/);
  assert.doesNotMatch(output[0], /SECRET|password|privateKey|PEM/);
});

test('verify delegates only after the fixed-root path guard', async () => {
  let verifyCalls = 0;
  await assert.rejects(
    runLocalMigrationBackupCli({
      argv: ['verify', '/tmp/outside'],
      filePath: packagedPath,
      uid: 0,
      verifyBackup: async () => { verifyCalls += 1; return verifiedResult(); },
      stdout: { write() {} },
    }),
    /must be a snapshot below/,
  );
  assert.equal(verifyCalls, 0);
});

test('preview is non-destructive and emits bounded archive ownership plus identity drift metadata only', async () => {
  let createCalls = 0;
  const calls = [];
  const output = [];
  const verifyBackup = async ({ backupDirectory: value }) => {
    calls.push(['verify', value]);
    return verifiedResult();
  };
  const result = await runLocalMigrationBackupCli({
    argv: ['preview', backupDirectory],
    filePath: packagedPath,
    uid: 0,
    createBackup: async () => { createCalls += 1; return {}; },
    verifyBackup,
    previewRestore: async ({ backupDirectory: value, verifyBackup: verifier }) => {
      calls.push(['preview', value, verifier === verifyBackup]);
      await verifier({ backupDirectory: value });
      return {
        destructive: false,
        backupDirectory: value,
        archivePath: `${value}/state.tar`,
        manifestPath: `${value}/manifest.json`,
        sha256: 'a'.repeat(64),
        archiveInspection: archivePreview(value),
        counts: { restore: 2, identityReferences: 2, preserved: 1 },
        targets: [
          {
            path: '/etc/yunpanel', action: 'restore_replace', snapshotPresent: true, snapshotType: 'directory',
            current: { present: true, type: 'directory' },
          },
          {
            path: '/etc/passwd', action: 'identity_reference', snapshotPresent: true, snapshotType: 'file',
            current: { present: true, type: 'file' },
          },
        ],
        identityComparison: {
          destructive: false,
          backupDirectory: value,
          sha256: 'a'.repeat(64),
          snapshotUsers: 3,
          currentUsers: 3,
          counts: { match: 1, drift: 1, missingCurrent: 1, addedCurrent: 0 },
          identities: [
            { name: 'yunapp-aaaaaaaaaaaa', status: 'match', changedFields: [] },
            { name: 'yunapp-bbbbbbbbbbbb', status: 'drift', changedFields: ['uid', 'supplementaryGroups'] },
            { name: 'yunapp-cccccccccccc', status: 'missing_current', changedFields: [] },
          ],
        },
      };
    },
    stdout: { write(value) { output.push(value); } },
  });

  assert.equal(createCalls, 0);
  assert.equal(result.destructive, false);
  assert.deepEqual(calls, [
    ['preview', backupDirectory, true],
    ['verify', backupDirectory],
  ]);
  const text = output.join('');
  assert.match(text, /action=preview/);
  assert.match(text, /destructive=false/);
  assert.match(text, /archiveMembers=8/);
  assert.match(text, /archiveFiles=3/);
  assert.match(text, /archiveDirectories=4/);
  assert.match(text, /archiveSymlinks=1/);
  assert.match(text, /archiveHardlinks=0/);
  assert.match(text, /archiveExtendedMetadata=1/);
  assert.match(text, /archiveLinksSafe=true/);
  assert.match(text, /archiveOwnershipMetadata=true/);
  assert.match(text, /archiveExtendedMetadataValidated=false/);
  assert.match(text, /restoreTargets=2/);
  assert.match(text, /identityReferences=2/);
  assert.match(text, /preservedCurrent=1/);
  assert.match(text, /identitySnapshotUsers=3/);
  assert.match(text, /identityCurrentUsers=3/);
  assert.match(text, /identityMatched=1/);
  assert.match(text, /identityDrift=1/);
  assert.match(text, /identityMissingCurrent=1/);
  assert.match(text, /identityAddedCurrent=0/);
  assert.match(text, /target path=\/etc\/yunpanel action=restore_replace snapshot=directory current=directory/);
  assert.match(text, /target path=\/etc\/passwd action=identity_reference snapshot=file current=file/);
  assert.match(text, /identity name=yunapp-bbbbbbbbbbbb status=drift changed=uid,supplementaryGroups/);
  assert.match(text, /identity name=yunapp-cccccccccccc status=missing_current changed=-/);
  assert.doesNotMatch(text, /yunapp-aaaaaaaaaaaa status=match/);
  assert.doesNotMatch(text, /uid=|gid=|mode=|SECRET|PASSWORD|TOKEN|PRIVATE KEY|root:x|:x:/);
});

test('preview rejects outside-root snapshots before invoking the preview handler', async () => {
  let previewCalls = 0;
  await assert.rejects(
    runLocalMigrationBackupCli({
      argv: ['preview', '/tmp/outside'],
      filePath: packagedPath,
      uid: 0,
      previewRestore: async () => { previewCalls += 1; return {}; },
      stdout: { write() {} },
    }),
    /must be a snapshot below/,
  );
  assert.equal(previewCalls, 0);
});

test('preview rejects malformed archive and identity acknowledgements', async () => {
  const base = {
    destructive: false,
    backupDirectory,
    sha256: 'a'.repeat(64),
    counts: { restore: 0, identityReferences: 2, preserved: 0 },
    targets: [],
    identityComparison: {
      destructive: false,
      backupDirectory,
      sha256: 'a'.repeat(64),
      snapshotUsers: 0,
      currentUsers: 0,
      counts: { match: 0, drift: 0, missingCurrent: 0, addedCurrent: 0 },
      identities: [],
    },
  };

  for (const invalidArchive of [
    { destructive: true },
    archivePreview(backupDirectory, { ownershipMetadata: false }),
    archivePreview(backupDirectory, { extendedMetadataValidated: true }),
    archivePreview(backupDirectory, { counts: { total: 8, files: 3, directories: 4, symlinks: 1, hardlinks: 0, extendedMetadata: 0 } }),
  ]) {
    await assert.rejects(
      runLocalMigrationBackupCli({
        argv: ['preview', backupDirectory],
        filePath: packagedPath,
        uid: 0,
        previewRestore: async () => ({ ...base, archiveInspection: invalidArchive }),
        stdout: { write() {} },
      }),
      /preview result is invalid/,
    );
  }

  await assert.rejects(
    runLocalMigrationBackupCli({
      argv: ['preview', backupDirectory],
      filePath: packagedPath,
      uid: 0,
      previewRestore: async () => ({ ...base, archiveInspection: archivePreview(), identityComparison: { destructive: true } }),
      stdout: { write() {} },
    }),
    /preview result is invalid/,
  );
});

test('stage is confirmed, fixed-root scoped and emits only non-live validation metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runLocalMigrationBackupCli({
    argv: ['stage', backupDirectory, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    stageRestore: async ({ backupDirectory: value }) => {
      calls.push(['stage', value]);
      return stagedResult(value);
    },
    stdout: { write(value) { output.push(value); } },
  });

  assert.deepEqual(calls, [['stage', backupDirectory]]);
  assert.equal(result.validated, true);
  assert.equal(result.destructive, false);
  assert.equal(result.liveMutation, false);
  assert.equal(result.ownershipMetadata, true);
  assert.equal(result.extendedMetadataValidated, false);
  const text = output.join('');
  assert.match(text, /action=stage/);
  assert.match(text, /validated=true/);
  assert.match(text, /destructive=false/);
  assert.match(text, /liveMutation=false/);
  assert.match(text, /ownershipMetadata=true/);
  assert.match(text, /extendedMetadata=1/);
  assert.match(text, /extendedMetadataValidated=false/);
  assert.match(text, /members=8/);
  assert.match(text, /stageDirectory=\/var\/backups\/yunpanel\/\.restore-staging\//);
  assert.doesNotMatch(text, /uid=|gid=|mode=|SECRET|PASSWORD|TOKEN|PRIVATE KEY|root:x|:x:/);
});

test('stage rejects outside-root snapshots before invoking the stage handler', async () => {
  let stageCalls = 0;
  await assert.rejects(
    runLocalMigrationBackupCli({
      argv: ['stage', '/tmp/outside', '--confirm'],
      filePath: packagedPath,
      uid: 0,
      stageRestore: async () => { stageCalls += 1; return stagedResult(); },
      stdout: { write() {} },
    }),
    /must be a snapshot below/,
  );
  assert.equal(stageCalls, 0);
});

test('stage rejects acknowledgements that claim live/destructive mutation or incomplete metadata evidence', async () => {
  for (const bad of [
    { destructive: true },
    { liveMutation: true },
    { validated: false },
    { ownershipMetadata: false },
    { extendedMetadataValidated: true },
    { extendedMetadata: -1 },
    { extendedMetadata: 9 },
    { stageDirectory: '/tmp/outside-stage' },
    { members: 0 },
  ]) {
    await assert.rejects(
      runLocalMigrationBackupCli({
        argv: ['stage', backupDirectory, '--confirm'],
        filePath: packagedPath,
        uid: 0,
        stageRestore: async () => stagedResult(backupDirectory, bad),
        stdout: { write() {} },
      }),
      /staging result is invalid/,
    );
  }
});
