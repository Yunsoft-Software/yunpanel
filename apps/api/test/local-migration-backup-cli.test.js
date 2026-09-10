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

test('migration backup CLI accepts only exact create, verify and preview syntax', () => {
  assert.deepEqual(parseLocalMigrationBackupArguments(['create', '--confirm']), { action: 'create', confirm: true });
  assert.deepEqual(parseLocalMigrationBackupArguments(['verify', backupDirectory]), { action: 'verify', backupDirectory });
  assert.deepEqual(parseLocalMigrationBackupArguments(['preview', backupDirectory]), { action: 'preview', backupDirectory });
  assert.throws(() => parseLocalMigrationBackupArguments(['create']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['verify', 'relative/path']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['preview', 'relative/path']), /Usage:/);
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

test('packaged verify and preview can read only snapshot directories below the fixed backup root', () => {
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

test('preview is non-destructive, reuses verification and emits metadata only', async () => {
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
        sha256: 'c'.repeat(64),
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
  assert.match(text, /restoreTargets=2/);
  assert.match(text, /identityReferences=2/);
  assert.match(text, /preservedCurrent=1/);
  assert.match(text, /target path=\/etc\/yunpanel action=restore_replace snapshot=directory current=directory/);
  assert.match(text, /target path=\/etc\/passwd action=identity_reference snapshot=file current=file/);
  assert.doesNotMatch(text, /SECRET|PASSWORD|TOKEN|PRIVATE KEY/);
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
