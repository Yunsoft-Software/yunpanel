import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../scripts/plesk-transfer.mjs', import.meta.url));
const serverId = '99bc760a-d508-4ae6-92be-efdedee9658d';

function cliArgs(fixture) {
  return [
    '--bundle-dir', fixture.bundleDirectory,
    '--staging-dir', fixture.stagingDirectory,
    '--server-id', serverId,
    '--source-domain', 'wp-pilot.example.net',
    '--source-database', 'wp_pilot_db',
    '--target-domain', 'wp-target.example.net',
    '--target-database', 'wp_target_db',
  ];
}

async function createWordPressMailBundle(t, { withMail = true } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'yunpanel-plesk-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDirectory = path.join(root, 'bundle');
  const stagingDirectory = path.join(root, 'staging');
  const docRoot = path.join(bundleDirectory, 'site', 'httpdocs');
  await mkdir(path.join(docRoot, 'wp-content', 'themes', 'pilot'), { recursive: true, mode: 0o700 });
  await mkdir(stagingDirectory, { mode: 0o700 });

  const siteExport = {
    name: 'wp-pilot.example.net',
    runtime: { runtimeType: 'php', phpVersion: '8.3.14', documentRoot: 'httpdocs' },
    databases: [{ name: 'wp_pilot_db', type: 'mariadb', password: 'wp-db-secret-marker' }],
    ...(withMail ? {
      mail: {
        mailboxes: [
          {
            name: 'destek',
            email: 'destek@wp-pilot.example.net',
            quotaMb: 1024,
            password: 'wp-mail-password-marker',
            passwordHash: '$6$rounds=5000$mail-hash-secret-marker',
          },
        ],
        aliases: [
          { source: 'iletisim@wp-pilot.example.net', destination: 'destek@wp-pilot.example.net' },
        ],
        forwardings: [
          { source: 'destek@wp-pilot.example.net', destination: 'backup@external.test', mode: 'copy' },
        ],
      },
    } : {}),
  };

  await writeFile(path.join(bundleDirectory, 'plesk.json'), JSON.stringify({ websites: [siteExport] }), { mode: 0o600 });
  await writeFile(path.join(bundleDirectory, 'database.sql'), 'CREATE TABLE wp_options (option_id INT PRIMARY KEY);\nINSERT INTO wp_options VALUES (1);\n', { mode: 0o600 });
  await writeFile(path.join(docRoot, 'index.php'), '<?php // WordPress pilot entry\n', { mode: 0o600 });
  await writeFile(path.join(docRoot, 'wp-content', 'themes', 'pilot', 'style.css'), '/* Theme Name: Pilot */\n', { mode: 0o600 });

  return { root, bundleDirectory, stagingDirectory };
}

test('CLI --help documents offline transfer usage and non-secret mail inventory', async () => {
  const { stdout, stderr } = await exec(process.execPath, [cli, '--help']);
  assert.equal(stderr, '');
  assert.match(stdout, /Usage: node scripts\/plesk-transfer\.mjs \[stage\]/);
  assert.match(stdout, /mail inventory/i);
});

test('CLI previews and stages a mail-enabled WordPress export with deterministic digest and stagedAt in transfer.json', async (t) => {
  const fixture = await createWordPressMailBundle(t, { withMail: true });
  const args = cliArgs(fixture);

  const previewRun1 = await exec(process.execPath, [cli, ...args]);
  const previewRun2 = await exec(process.execPath, [cli, ...args]);
  assert.equal(previewRun1.stderr, '');
  assert.equal(previewRun2.stderr, '');
  assert.equal(previewRun1.stdout, previewRun2.stdout);

  const preview = JSON.parse(previewRun1.stdout);
  assert.equal(preview.readOnly, true);
  assert.equal(preview.stagedAt, undefined);
  assert.equal(preview.mail.enabled, true);
  assert.equal(preview.mail.domainName, 'wp-pilot.example.net');
  assert.deepEqual(preview.mail.mailboxes, [{ address: 'destek@wp-pilot.example.net', quotaBytes: 1024 * 1024 * 1024 }]);
  assert.deepEqual(preview.mail.aliases, [{ source: 'iletisim@wp-pilot.example.net', destinations: ['destek@wp-pilot.example.net'] }]);
  assert.deepEqual(preview.mail.forwardings, [{ source: 'destek@wp-pilot.example.net', destinations: ['backup@external.test'], mode: 'copy' }]);
  assert.deepEqual(preview.cutover, {
    imapSyncRequired: true,
    rollbackPreservesPostCutoverWrites: true,
    preDnsChecks: ['http', 'login', 'sql', 'imap'],
  });
  assert.doesNotMatch(previewRun1.stdout, /wp-db-secret-marker|wp-mail-password-marker|mail-hash-secret-marker/);

  const stageRun = await exec(process.execPath, [cli, 'stage', ...args, '--expect', preview.digest]);
  assert.equal(stageRun.stderr, '');
  const receipt = JSON.parse(stageRun.stdout);
  assert.equal(receipt.status, 'ready');
  assert.equal(receipt.digest, preview.digest);
  assert.match(receipt.stagedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(receipt.mail, preview.mail);
  assert.deepEqual(receipt.cutover, preview.cutover);
  assert.doesNotMatch(stageRun.stdout, /wp-db-secret-marker|wp-mail-password-marker|mail-hash-secret-marker/);

  const transferJsonRaw = await readFile(path.join(fixture.stagingDirectory, 'transfer.json'), 'utf8');
  assert.doesNotMatch(transferJsonRaw, /wp-db-secret-marker|wp-mail-password-marker|mail-hash-secret-marker/);
  assert.deepEqual(JSON.parse(transferJsonRaw), receipt);
});

test('CLI keeps non-mail exports valid and rejects missing/duplicate flags fail-closed', async (t) => {
  const fixture = await createWordPressMailBundle(t, { withMail: false });
  const args = cliArgs(fixture);

  const previewRun = await exec(process.execPath, [cli, ...args]);
  const preview = JSON.parse(previewRun.stdout);
  assert.equal(preview.mail.enabled, false);
  assert.equal(preview.cutover.imapSyncRequired, false);
  assert.deepEqual(preview.cutover.preDnsChecks, ['http', 'login', 'sql']);

  await assert.rejects(
    exec(process.execPath, [cli, ...args, '--server-id', serverId]),
    (error) => error.code === 1 && error.stderr.includes('Usage:'),
  );
  await assert.rejects(
    exec(process.execPath, [cli, '--bundle-dir', fixture.bundleDirectory]),
    (error) => error.code === 1 && error.stderr.includes('Usage:'),
  );
});
