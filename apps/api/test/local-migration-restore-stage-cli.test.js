import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalMigrationBackupArguments,
  runLocalMigrationBackupCli,
} from '../../../scripts/local-migration-backup.mjs';

const packagedPath = '/usr/lib/yunpanel/scripts/local-migration-backup.mjs';
const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';
const stageDirectory = '/var/backups/yunpanel/.restore-staging/migration-2026-09-10T15-00-00-000Z-AbCd12';

function stagedResult(overrides = {}) {
  return {
    validated: true,
    destructive: false,
    liveMutation: false,
    backupDirectory,
    sha256: 'a'.repeat(64),
    stageDirectory,
    members: 42,
    ...overrides,
  };
}

test('stage syntax requires an absolute snapshot and explicit confirmation', () => {
  assert.deepEqual(
    parseLocalMigrationBackupArguments(['stage', backupDirectory, '--confirm']),
    { action: 'stage', backupDirectory, confirm: true },
  );
  assert.throws(() => parseLocalMigrationBackupArguments(['stage', backupDirectory]), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['stage', 'relative/path', '--confirm']), /Usage:/);
  assert.throws(() => parseLocalMigrationBackupArguments(['stage', backupDirectory, '--force']), /Usage:/);
});

test('packaged stage is root-only and validates backup root before staging', async () => {
  let stageCalls = 0;
  await assert.rejects(
    runLocalMigrationBackupCli({
      argv: ['stage', backupDirectory, '--confirm'],
      filePath: packagedPath,
      uid: 1000,
      stageRestore: async () => { stageCalls += 1; return stagedResult(); },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(stageCalls, 0);

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

test('stage delegates only to the fixed private staging workflow and prints safe metadata', async () => {
  const calls = [];
  const output = [];
  const result = await runLocalMigrationBackupCli({
    argv: ['stage', backupDirectory, '--confirm'],
    filePath: packagedPath,
    uid: 0,
    stageRestore: async ({ backupDirectory: value }) => {
      calls.push(value);
      return stagedResult();
    },
    stdout: { write(value) { output.push(value); } },
  });

  assert.deepEqual(calls, [backupDirectory]);
  assert.equal(result.validated, true);
  const text = output.join('');
  assert.match(text, /action=stage/);
  assert.match(text, /validated=true/);
  assert.match(text, /destructive=false/);
  assert.match(text, /liveMutation=false/);
  assert.match(text, /members=42/);
  assert.match(text, new RegExp(`stageDirectory=${stageDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(text, /SECRET|PASSWORD|TOKEN|PRIVATE KEY|root:x|:x:/i);
});

test('stage refuses malformed or escaped staging acknowledgements', async () => {
  for (const invalid of [
    stagedResult({ validated: false }),
    stagedResult({ liveMutation: true }),
    stagedResult({ destructive: true }),
    stagedResult({ stageDirectory: '/tmp/restore-stage' }),
    stagedResult({ stageDirectory: '/var/backups/yunpanel/.restore-staging/nested/stage' }),
    stagedResult({ members: 0 }),
  ]) {
    await assert.rejects(
      runLocalMigrationBackupCli({
        argv: ['stage', backupDirectory, '--confirm'],
        filePath: packagedPath,
        uid: 0,
        stageRestore: async () => invalid,
        stdout: { write() {} },
      }),
      /staging result is invalid/,
    );
  }
});
