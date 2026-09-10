import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLocalMigrationBackup,
  LocalMigrationBackupError,
  verifyLocalMigrationBackup,
} from '../src/local-migration-backup.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-migration-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'etc-yunpanel');
  const state = path.join(root, 'var-lib-yunpanel');
  const passwd = path.join(root, 'passwd');
  const optional = path.join(root, 'optional-nginx');
  await mkdir(config);
  await mkdir(state);
  await writeFile(path.join(config, 'api.env'), 'SECRET=must-not-enter-manifest\n');
  await writeFile(path.join(state, 'server.json'), '{"ok":true}\n');
  await writeFile(passwd, 'yunapp:x:991:991::/nonexistent:/usr/sbin/nologin\n');
  return {
    root,
    backupRoot: path.join(root, 'backups'),
    sourceEntries: [
      { path: config, type: 'directory', required: true },
      { path: state, type: 'directory', required: true },
      { path: passwd, type: 'file', required: true },
      { path: optional, type: 'directory', required: false },
    ],
  };
}

function archiveListing(entries) {
  return entries.filter((entry) => entry.present).map((entry) => entry.path.replace(/^\/+/, '')).join('\n') + '\n';
}

function tarFixture(sourceEntries) {
  let listing = sourceEntries.filter((entry) => entry.required).map((entry) => entry.path.replace(/^\/+/, '')).join('\n') + '\n';
  return {
    setListing(value) { listing = value; },
    async run(args) {
      if (args[0] === '--create') {
        const fileIndex = args.indexOf('--file');
        await writeFile(args[fileIndex + 1], 'private archive bytes');
        return { stdout: '' };
      }
      return { stdout: listing };
    },
  };
}

test('migration backup creates a private checksummed archive and verifies it', async (t) => {
  const fx = await fixture(t);
  const tar = tarFixture(fx.sourceEntries);
  const created = await createLocalMigrationBackup({
    root: fx.backupRoot,
    now: () => Date.parse('2026-09-10T15:00:00Z'),
    sourceEntries: fx.sourceEntries,
    runTar: (args) => tar.run(args),
  });

  tar.setListing(archiveListing(created.entries));
  const verified = await verifyLocalMigrationBackup({
    backupDirectory: created.backupDirectory,
    sourceEntries: fx.sourceEntries,
    runTar: (args) => tar.run(args),
  });

  assert.equal(verified.verified, true);
  assert.equal((await stat(fx.backupRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(created.backupDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(created.archivePath)).mode & 0o777, 0o600);
  assert.equal((await stat(created.manifestPath)).mode & 0o777, 0o600);
  const manifest = await readFile(created.manifestPath, 'utf8');
  assert.doesNotMatch(manifest, /must-not-enter-manifest|SECRET=/);
  assert.equal(created.entries.at(-1).present, false);
});

test('migration backup verification rejects archive checksum tampering', async (t) => {
  const fx = await fixture(t);
  const tar = tarFixture(fx.sourceEntries);
  const created = await createLocalMigrationBackup({
    root: fx.backupRoot,
    now: () => Date.parse('2026-09-10T15:01:00Z'),
    sourceEntries: fx.sourceEntries,
    runTar: (args) => tar.run(args),
  });
  await writeFile(created.archivePath, 'tampered archive');
  await chmod(created.archivePath, 0o600);

  await assert.rejects(
    verifyLocalMigrationBackup({ backupDirectory: created.backupDirectory, sourceEntries: fx.sourceEntries, runTar: (args) => tar.run(args) }),
    (error) => error instanceof LocalMigrationBackupError && error.code === 'migration_backup_checksum_mismatch',
  );
});

test('migration backup verification rejects paths outside the fixed source set', async (t) => {
  const fx = await fixture(t);
  const tar = tarFixture(fx.sourceEntries);
  const created = await createLocalMigrationBackup({
    root: fx.backupRoot,
    now: () => Date.parse('2026-09-10T15:02:00Z'),
    sourceEntries: fx.sourceEntries,
    runTar: (args) => tar.run(args),
  });
  tar.setListing(`${fx.sourceEntries[0].path.replace(/^\/+/, '')}\n../../etc/shadow\n`);

  await assert.rejects(
    verifyLocalMigrationBackup({ backupDirectory: created.backupDirectory, sourceEntries: fx.sourceEntries, runTar: (args) => tar.run(args) }),
    (error) => error instanceof LocalMigrationBackupError && error.code === 'migration_backup_archive_invalid',
  );
});

test('migration backup refuses symbolic-link sources before archive creation', async (t) => {
  const fx = await fixture(t);
  const target = path.join(fx.root, 'real-target');
  const linked = path.join(fx.root, 'linked-config');
  await mkdir(target);
  await symlink(target, linked);
  let tarCalls = 0;

  await assert.rejects(
    createLocalMigrationBackup({
      root: fx.backupRoot,
      now: () => Date.parse('2026-09-10T15:03:00Z'),
      sourceEntries: [{ path: linked, type: 'directory', required: true }],
      runTar: async () => { tarCalls += 1; return { stdout: '' }; },
    }),
    (error) => error instanceof LocalMigrationBackupError && error.code === 'migration_backup_source_unsafe',
  );
  assert.equal(tarCalls, 0);
});
