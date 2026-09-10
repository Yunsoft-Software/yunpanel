import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPackagedRoot,
  isPackagedLocalRuntimeScript,
  parseLocalRuntimeArguments,
  runLocalRuntimeCli,
} from '../../../scripts/local-runtime.mjs';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';

function verifiedBackup() {
  return {
    verified: true,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256: 'a'.repeat(64),
    entries: [],
  };
}

test('local runtime CLI accepts status and requires a backup snapshot for ownership mutations', () => {
  assert.deepEqual(parseLocalRuntimeArguments(['status', 'server-id']), { action: 'status', serverId: 'server-id', confirm: false });
  assert.deepEqual(
    parseLocalRuntimeArguments(['bind', 'server-id', '--backup-dir', backupDirectory, '--confirm']),
    { action: 'bind', serverId: 'server-id', backupDirectory, confirm: true },
  );
  assert.deepEqual(
    parseLocalRuntimeArguments(['release', 'server-id', '--backup-dir', backupDirectory, '--confirm']),
    { action: 'release', serverId: 'server-id', backupDirectory, confirm: true },
  );
  assert.throws(() => parseLocalRuntimeArguments(['bind', 'server-id', '--confirm']), /requires exactly --backup-dir/);
  assert.throws(() => parseLocalRuntimeArguments(['bind', 'server-id', '--backup-dir', 'relative/path', '--confirm']), /requires exactly --backup-dir/);
  assert.throws(() => parseLocalRuntimeArguments(['status', 'server-id', '--confirm']), /does not accept extra arguments/);
  assert.throws(() => parseLocalRuntimeArguments(['delete', 'server-id']), /Usage/);
});

test('packaged script detection is limited to the installed YunPanel script directory', () => {
  assert.equal(isPackagedLocalRuntimeScript('/usr/lib/yunpanel/scripts/local-runtime.mjs'), true);
  assert.equal(isPackagedLocalRuntimeScript('/work/yunpanel/scripts/local-runtime.mjs'), false);
  assert.equal(isPackagedLocalRuntimeScript('/usr/lib/yunpanel-other/scripts/local-runtime.mjs'), false);
});

test('packaged CLI requires root before verifying backup or executing migration', async () => {
  let verifies = 0;
  let executes = 0;
  await assert.rejects(
    runLocalRuntimeCli({
      argv: ['bind', 'server-id', '--backup-dir', backupDirectory, '--confirm'],
      filePath: '/usr/lib/yunpanel/scripts/local-runtime.mjs',
      uid: 1000,
      verifyBackup: async () => { verifies += 1; return verifiedBackup(); },
      execute: async () => { executes += 1; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(verifies, 0);
  assert.equal(executes, 0);
  assert.throws(() => assertPackagedRoot({ packaged: true, uid: 1000 }), /must be run as root/);
  assert.doesNotThrow(() => assertPackagedRoot({ packaged: true, uid: 0 }));
  assert.doesNotThrow(() => assertPackagedRoot({ packaged: false, uid: 1000 }));
});

test('CLI verifies backup before mutation and emits the exact local server env value without secrets', async () => {
  const output = [];
  const calls = [];
  const result = await runLocalRuntimeCli({
    argv: ['bind', '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7', '--backup-dir', backupDirectory, '--confirm'],
    env: { YUNPANEL_SECRET_MASTER_KEY: 'must-not-print' },
    hostname: 'host-1.example.local',
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    uid: 1000,
    verifyBackup: async ({ backupDirectory: value }) => {
      calls.push(['verify', value]);
      return verifiedBackup();
    },
    execute: async (input) => {
      calls.push(['execute', input]);
      return {
        action: 'bind',
        serverId: input.serverId,
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T00:00:00.000Z',
        statePaths: { serverStore: '/work/.data/server-registry.json', jobStore: '/work/.data/job-registry.json' },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(result.executionMode, 'local');
  assert.equal(result.verifiedBackupDirectory, backupDirectory);
  assert.deepEqual(calls.map(([name]) => name), ['verify', 'execute']);
  assert.equal(calls[1][1].hostname, 'host-1.example.local');
  assert.equal(Object.hasOwn(calls[1][1], 'backupDirectory'), false);
  assert.match(output.join(''), /verifiedBackup=\/var\/backups\/yunpanel\/migration-/);
  assert.match(output.join(''), /YUNPANEL_LOCAL_SERVER_ID=6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7/);
  assert.doesNotMatch(output.join(''), /must-not-print/);
});

test('backup verification failure prevents ownership mutation', async () => {
  let executed = false;
  await assert.rejects(
    runLocalRuntimeCli({
      argv: ['release', '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7', '--backup-dir', backupDirectory, '--confirm'],
      filePath: '/work/yunpanel/scripts/local-runtime.mjs',
      verifyBackup: async () => { throw new Error('checksum mismatch'); },
      execute: async () => { executed = true; },
      stdout: { write() {} },
    }),
    /checksum mismatch/,
  );
  assert.equal(executed, false);
});

test('status remains read-only and does not require backup verification', async () => {
  let verifies = 0;
  await runLocalRuntimeCli({
    argv: ['status', '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7'],
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    verifyBackup: async () => { verifies += 1; throw new Error('must not run'); },
    execute: async (input) => ({
      action: 'status', serverId: input.serverId, hostname: 'host-1', executionMode: 'local', localBoundAt: null,
      apiActive: false, agentActive: false, activeJobCount: 0, recoveryJobCount: 0,
      statePaths: { serverStore: '/work/servers.json', jobStore: '/work/jobs.json' },
    }),
    stdout: { write() {} },
  });
  assert.equal(verifies, 0);
});
