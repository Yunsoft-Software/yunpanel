import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDataBackupManager,
  MailDataBackupError,
  mailDataBackupInternals,
} from '../src/index.js';

const CANONICAL_SOURCE = '/var/lib/yunpanel/mail/example.com/owner';
const SNAPSHOT = 'a'.repeat(64);

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-data-backup-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function mappedFs(sourceRoot) {
  const mapPath = (value) => value === CANONICAL_SOURCE || value.startsWith(`${CANONICAL_SOURCE}/`)
    ? path.join(sourceRoot, value.slice(CANONICAL_SOURCE.length + (value === CANONICAL_SOURCE ? 0 : 1)))
    : value;
  return {
    mapPath,
    lstatFn: (value) => lstat(mapPath(value)),
    openFn: (value, flags, mode) => open(mapPath(value), flags, mode),
    readdirFn: (value, options) => readdir(mapPath(value), options),
  };
}

async function sourceFixture(root) {
  const sourceRoot = path.join(root, 'source');
  await mkdir(path.join(sourceRoot, 'cur'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sourceRoot, 'new'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sourceRoot, 'tmp'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceRoot, 'cur', 'msg-secret-1'), 'first message body\n', { mode: 0o600 });
  await writeFile(path.join(sourceRoot, 'new', 'msg-secret-2'), 'second message body\n', { mode: 0o600 });
  return sourceRoot;
}

function inspector({ present = true, snapshot = SNAPSHOT } = {}) {
  return {
    async inspectMailbox(address) {
      assert.equal(address, 'owner@example.com');
      return {
        version: 1,
        scope: 'mailbox',
        identity: address,
        dataPath: CANONICAL_SOURCE,
        present,
        bytes: present ? 38 : 0,
        snapshotSha256: snapshot,
        sideEffects: false,
      };
    },
    async inspectDomain() { throw new Error('unexpected domain inspection'); },
  };
}

test('creates an atomic private mailbox backup with content digest and no public message names', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  const backupRoot = path.join(root, 'backups');
  const mapped = mappedFs(sourceRoot);
  const manager = createMailDataBackupManager({
    backupRoot,
    mailDataInspector: inspector(),
    now: () => Date.parse('2026-09-13T20:00:00.000Z'),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });

  const result = await manager.backup({
    backupId: 'mail-backup-0001',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });

  assert.equal(result.backupId, 'mail-backup-0001');
  assert.equal(result.scope, 'mailbox');
  assert.equal(result.identity, 'owner@example.com');
  assert.equal(result.sourcePresent, true);
  assert.equal(result.files, 2);
  assert.equal(result.directories, 3);
  assert.equal(result.bytes, Buffer.byteLength('first message body\nsecond message body\n'));
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(result.sourceFingerprintSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.sideEffects, true);
  assert.doesNotMatch(JSON.stringify(result), /msg-secret|message body/);

  const finalDirectory = manager.finalDirectory('mail-backup-0001');
  assert.equal((await stat(finalDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(finalDirectory, mailDataBackupInternals.manifestFile))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(finalDirectory, 'data', 'cur', 'msg-secret-1'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(finalDirectory, 'data', 'cur'))).mode & 0o777, 0o700);

  const inspected = await manager.inspectBackup('mail-backup-0001');
  assert.deepEqual(inspected, result);
  const repeated = await manager.backup({
    backupId: 'mail-backup-0001',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });
  assert.deepEqual(repeated, result);
}));

test('stale preview and conflicting backup id fail before a new backup is committed', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  const mapped = mappedFs(sourceRoot);
  const manager = createMailDataBackupManager({
    backupRoot: path.join(root, 'backups'),
    mailDataInspector: inspector({ snapshot: 'b'.repeat(64) }),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });
  await assert.rejects(
    manager.backup({
      backupId: 'mail-backup-0002',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataBackupError && error.code === 'mail_data_backup_snapshot_stale',
  );

  const manager2 = createMailDataBackupManager({
    backupRoot: path.join(root, 'backups-2'),
    mailDataInspector: inspector(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });
  await manager2.backup({
    backupId: 'mail-backup-0003',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });
  await assert.rejects(
    manager2.backup({
      backupId: 'mail-backup-0003',
      scope: 'mailbox',
      identity: 'other@example.com',
      expectedSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataBackupError && error.code === 'mail_data_backup_id_conflict',
  );
}));

test('source symlinks are rejected and pending backup state is removed', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  await symlink('/etc/passwd', path.join(sourceRoot, 'new', 'unsafe-link'));
  const mapped = mappedFs(sourceRoot);
  const backupRoot = path.join(root, 'backups');
  const manager = createMailDataBackupManager({
    backupRoot,
    mailDataInspector: inspector(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });

  await assert.rejects(
    manager.backup({
      backupId: 'mail-backup-0004',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataBackupError && error.code === 'mail_data_backup_source_unsafe',
  );
  await assert.rejects(
    lstat(path.join(backupRoot, '.pending-mail-backup-0004')),
    (error) => error?.code === 'ENOENT',
  );
}));

test('tampered backup content is rejected instead of returning a stale receipt', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  const mapped = mappedFs(sourceRoot);
  const manager = createMailDataBackupManager({
    backupRoot: path.join(root, 'backups'),
    mailDataInspector: inspector(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });
  await manager.backup({
    backupId: 'mail-backup-0005',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });
  const target = path.join(manager.finalDirectory('mail-backup-0005'), 'data', 'cur', 'msg-secret-1');
  await writeFile(target, 'tampered\n', { mode: 0o600 });
  await chmod(target, 0o600);

  await assert.rejects(
    manager.inspectBackup('mail-backup-0005'),
    (error) => error instanceof MailDataBackupError && error.code === 'mail_data_backup_corrupt',
  );
}));

test('absent mailbox data produces a valid empty backup without source traversal', async () => withTempDirectory(async (root) => {
  const manager = createMailDataBackupManager({
    backupRoot: path.join(root, 'backups'),
    mailDataInspector: inspector({ present: false }),
  });
  const result = await manager.backup({
    backupId: 'mail-backup-0006',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });
  assert.equal(result.sourcePresent, false);
  assert.equal(result.bytes, 0);
  assert.equal(result.files, 0);
  assert.equal(result.directories, 0);
  assert.deepEqual(await manager.inspectBackup('mail-backup-0006'), result);
}));
