import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { previewPleskOfflineTransfer } from '../src/plesk-offline-transfer.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../scripts/plesk-transfer.mjs', import.meta.url));
const sql = 'CREATE TABLE messages (id INT PRIMARY KEY, body VARCHAR(80));\nINSERT INTO messages VALUES (1, "Türkçe içerik");\n';

async function createFixture(t) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'yunpanel-plesk-transfer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundleDirectory = path.join(root, 'bundle');
  const stagingDirectory = path.join(root, 'target');
  const documentRoot = path.join(bundleDirectory, 'site', 'httpdocs');
  await mkdir(documentRoot, { recursive: true, mode: 0o700 });
  await mkdir(stagingDirectory, { mode: 0o700 });
  const metadataPath = path.join(bundleDirectory, 'plesk.json');
  const sqlPath = path.join(bundleDirectory, 'database.sql');
  const indexPath = path.join(documentRoot, 'index.php');
  const exportSite = {
    name: 'source.example.net',
    runtime: { runtimeType: 'php', phpVersion: '8.3.10', documentRoot: 'httpdocs' },
    databases: [{ name: 'source_messages', type: 'mariadb', password: 'database-secret-marker' }],
    crons: [{ name: 'Import cron', schedule: '*/5 * * * *', command: 'echo cron-command-marker' }],
  };
  const setExport = (websites) => writeFile(metadataPath, JSON.stringify({ websites }), { mode: 0o600 });
  await setExport([exportSite]);
  await writeFile(sqlPath, sql, { mode: 0o600 });
  await writeFile(indexPath, '<?php echo "fixture-file-marker";', { mode: 0o600 });
  await writeFile(path.join(bundleDirectory, 'site', 'app-data.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });

  return {
    root, documentRoot, indexPath, sqlPath, exportSite, setExport, options: {
      bundleDirectory,
      stagingDirectory,
      serverId: '99bc760a-d508-4ae6-92be-efdedee9658d',
      sourceDomain: 'source.example.net',
      sourceDatabase: 'source_messages',
      targetDomain: 'target.example.net',
      targetDatabase: 'target_messages',
    },
  };
}

test('builds a stable read-only preview using real PHP files and SQL bytes', async (t) => {
  const { options, sqlPath } = await createFixture(t);
  const preview = await previewPleskOfflineTransfer(options);
  assert.equal(preview.readOnly, true);
  assert.deepEqual(preview.source, {
    domain: options.sourceDomain, database: options.sourceDatabase, phpVersion: '8.3', documentRoot: 'httpdocs',
  });
  assert.deepEqual(preview.target, {
    domain: options.targetDomain, database: options.targetDatabase, serverId: options.serverId,
  });
  assert.equal(preview.files.site.files, 2);
  assert.equal(preview.files.site.directories, 1);
  assert.equal(preview.files.sql.bytes, String(Buffer.byteLength(sql)));
  assert.match(preview.digest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(preview), /database-secret-marker|cron-command-marker|fixture-file-marker|Türkçe/);
  assert.deepEqual(await previewPleskOfflineTransfer({ ...options, expectedDigest: preview.digest }), preview);
  assert.deepEqual(await readdir(options.stagingDirectory), []);
  assert.equal(await readFile(sqlPath, 'utf8'), sql);
});

test('rejects foreign source sites, additional databases and incompatible runtimes', async (t) => {
  const { options, exportSite, setExport } = await createFixture(t);
  await assert.rejects(previewPleskOfflineTransfer({ ...options, sourceDomain: 'other.example.net' }), {
    code: 'plesk_transfer_source_mismatch',
  });
  await setExport([exportSite, { ...exportSite, name: 'different.example.net' }]);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_source_mismatch' });
  await setExport([{ ...exportSite, databases: [...exportSite.databases, { name: 'foreign_database' }] }]);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_source_mismatch' });
  await setExport([{ ...exportSite, databases: [{ name: 'source_messages', type: 'postgres' }] }]);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_source_mismatch' });
  await setExport([{ ...exportSite, runtime: { ...exportSite.runtime, phpVersion: '8.9' } }]);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_runtime_unsupported' });
});

test('rejects escaping document roots, symbolic links and hard-linked files', async (t) => {
  const { options, exportSite, setExport, documentRoot, root } = await createFixture(t);
  await setExport([{ ...exportSite, runtime: { ...exportSite.runtime, documentRoot: '../httpdocs' } }]);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_document_root_invalid' });
  await setExport([exportSite]);
  const outside = path.join(root, 'outside');
  const unsafe = path.join(documentRoot, 'unsafe.txt');
  await writeFile(outside, 'outside-bundle-marker', { mode: 0o600 });
  await symlink(outside, unsafe);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_entry_unsafe' });
  await rm(unsafe);
  await link(outside, unsafe);
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_entry_unsafe' });
  assert.equal(await readFile(outside, 'utf8'), 'outside-bundle-marker');
});

test('binds the digest to file and database contents, modes and destination identity', async (t) => {
  const { options, root, indexPath, sqlPath } = await createFixture(t);
  const { digest } = await previewPleskOfflineTransfer(options);
  const verify = () => previewPleskOfflineTransfer({ ...options, expectedDigest: digest });
  const mismatch = { code: 'plesk_transfer_digest_mismatch' };
  const original = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, `${original}\n`);
  await assert.rejects(verify(), mismatch);
  await writeFile(indexPath, original);
  await chmod(indexPath, 0o700);
  await assert.rejects(verify(), mismatch);
  await chmod(indexPath, 0o600);
  await writeFile(sqlPath, `${sql}\n`);
  await assert.rejects(verify(), mismatch);
  await writeFile(sqlPath, sql);
  assert.equal((await verify()).digest, digest);
  await rename(options.stagingDirectory, path.join(root, 'old-target'));
  await mkdir(options.stagingDirectory, { mode: 0o700 });
  await assert.rejects(verify(), mismatch);
});

test('refuses to inspect nonempty, linked or overlapping targets and incomplete exports', async (t) => {
  const { options, root, sqlPath } = await createFixture(t);
  const sentinel = path.join(options.stagingDirectory, 'keep.txt');
  await writeFile(sentinel, 'preserved', { mode: 0o600 });
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_target_not_empty' });
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved');
  await rm(sentinel);
  const linkedTarget = path.join(root, 'linked-target');
  await symlink(options.stagingDirectory, linkedTarget);
  await assert.rejects(previewPleskOfflineTransfer({ ...options, stagingDirectory: linkedTarget }), {
    code: 'plesk_transfer_entry_unsafe',
  });
  await assert.rejects(previewPleskOfflineTransfer({ ...options, stagingDirectory: root }), {
    code: 'plesk_transfer_directory_overlap',
  });
  await writeFile(sqlPath, '');
  await assert.rejects(previewPleskOfflineTransfer(options), { code: 'plesk_transfer_sql_empty' });
});

test('CLI emits JSON, verifies the digest and returns a nonzero result for a stale bundle', async (t) => {
  const { options, sqlPath } = await createFixture(t);
  const args = [
    cli,
    '--bundle-dir', options.bundleDirectory,
    '--staging-dir', options.stagingDirectory,
    '--server-id', options.serverId,
    '--source-domain', options.sourceDomain,
    '--source-database', options.sourceDatabase,
    '--target-domain', options.targetDomain,
    '--target-database', options.targetDatabase,
  ];
  const first = await exec(process.execPath, args);
  assert.equal(first.stderr, '');
  const { digest } = JSON.parse(first.stdout);
  assert.match(digest, /^[a-f0-9]{64}$/);
  const verify = () => exec(process.execPath, [...args, '--expect', digest]);
  assert.equal((await verify()).stdout, first.stdout);
  await writeFile(sqlPath, 'SELECT 2;');
  await assert.rejects(verify(), (error) => error.code === 1 && error.stdout === ''
    && error.stderr.startsWith('plesk_transfer_digest_mismatch:'));
});
