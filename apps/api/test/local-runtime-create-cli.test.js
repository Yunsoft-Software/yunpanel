import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalRuntimeArguments, runLocalRuntimeCli } from '../../../scripts/local-runtime.mjs';

const serverId = '6f2cc8d7-995f-4c20-b9a8-e2ce07b760d7';
const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';

function verifiedBackup() {
  return {
    verified: true,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256: 'b'.repeat(64),
    entries: [],
  };
}

test('local runtime CLI accepts only confirmed create with an absolute verified-backup snapshot', () => {
  assert.deepEqual(
    parseLocalRuntimeArguments(['create', '--backup-dir', backupDirectory, '--confirm']),
    { action: 'create', backupDirectory, confirm: true },
  );
  assert.throws(() => parseLocalRuntimeArguments(['create']), /requires exactly --backup-dir/);
  assert.throws(() => parseLocalRuntimeArguments(['create', '--confirm']), /requires exactly --backup-dir/);
  assert.throws(() => parseLocalRuntimeArguments(['create', '--backup-dir', 'relative', '--confirm']), /requires exactly --backup-dir/);
  assert.throws(() => parseLocalRuntimeArguments(['create', '--backup-dir', backupDirectory, '--force']), /requires exactly --backup-dir/);
});

test('fresh create verifies backup, uses OS hostname and prints the exact local runtime id without credentials', async () => {
  const calls = [];
  const output = [];
  const result = await runLocalRuntimeCli({
    argv: ['create', '--backup-dir', backupDirectory, '--confirm'],
    env: { YUN_AGENT_TOKEN: 'must-not-print', YUNPANEL_SECRET_MASTER_KEY: 'also-hidden' },
    hostname: 'fresh-host.example.local',
    filePath: '/work/yunpanel/scripts/local-runtime.mjs',
    uid: 1000,
    verifyBackup: async ({ backupDirectory: value }) => {
      calls.push(['verify', value]);
      return verifiedBackup();
    },
    execute: async (input) => {
      calls.push(['execute', input]);
      return {
        action: 'create',
        serverId,
        hostname: input.hostname,
        executionMode: 'local',
        localBoundAt: '2026-09-10T10:30:00.000Z',
        statePaths: {
          serverStore: '/work/yunpanel/.data/server-registry.json',
          jobStore: '/work/yunpanel/.data/job-registry.json',
        },
      };
    },
    stdout: { write: (value) => output.push(value) },
  });

  assert.deepEqual(calls.map(([name]) => name), ['verify', 'execute']);
  assert.equal(calls[1][1].action, 'create');
  assert.equal(calls[1][1].confirm, true);
  assert.equal(calls[1][1].hostname, 'fresh-host.example.local');
  assert.equal(Object.hasOwn(calls[1][1], 'backupDirectory'), false);
  assert.equal(result.serverId, serverId);
  assert.equal(result.verifiedBackupDirectory, backupDirectory);
  assert.match(output.join(''), new RegExp(`YUNPANEL_LOCAL_SERVER_ID=${serverId}`));
  assert.match(output.join(''), /verifiedBackup=\/var\/backups\/yunpanel\/migration-/);
  assert.match(output.join(''), /No legacy agent credential was created/);
  assert.doesNotMatch(output.join(''), /must-not-print|also-hidden|YUN_AGENT_TOKEN|SECRET_MASTER_KEY/);
});

test('packaged fresh create requires root before backup verification or migration', async () => {
  let verified = false;
  let executed = false;
  await assert.rejects(
    runLocalRuntimeCli({
      argv: ['create', '--backup-dir', backupDirectory, '--confirm'],
      hostname: 'fresh-host.example.local',
      filePath: '/usr/lib/yunpanel/scripts/local-runtime.mjs',
      uid: 1000,
      verifyBackup: async () => { verified = true; return verifiedBackup(); },
      execute: async () => { executed = true; },
      stdout: { write() {} },
    }),
    /must be run as root/,
  );
  assert.equal(verified, false);
  assert.equal(executed, false);
});
