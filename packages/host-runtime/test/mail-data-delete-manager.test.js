import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDataBackupManager,
  createMailDataDeleteManager,
  MailDataDeleteError,
} from '../src/index.js';

const CANONICAL_SOURCE = '/var/lib/yunpanel/mail/example.com/owner';
const SNAPSHOT = 'a'.repeat(64);

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-data-delete-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function mappedFs(sourceRoot) {
  const canonicalParent = path.dirname(CANONICAL_SOURCE);
  const localParent = path.dirname(sourceRoot);
  const mapPath = (value) => {
    if (value === CANONICAL_SOURCE) return sourceRoot;
    if (value.startsWith(`${CANONICAL_SOURCE}/`)) return path.join(sourceRoot, value.slice(CANONICAL_SOURCE.length + 1));
    if (value.startsWith(`${canonicalParent}/.`)) return path.join(localParent, path.basename(value));
    return value;
  };
  return {
    mapPath,
    lstatFn: (value) => lstat(mapPath(value)),
    openFn: (value, flags, mode) => open(mapPath(value), flags, mode),
    readdirFn: (value, options) => readdir(mapPath(value), options),
    renameFn: (from, to) => rename(mapPath(from), mapPath(to)),
    rmFn: (value, options) => rm(mapPath(value), options),
  };
}

async function sourceFixture(root) {
  const sourceRoot = path.join(root, 'owner');
  await mkdir(path.join(sourceRoot, 'cur'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sourceRoot, 'new'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(sourceRoot, 'tmp'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(sourceRoot, 'cur', 'mail-1'), 'one\n', { mode: 0o600 });
  await writeFile(path.join(sourceRoot, 'new', 'mail-2'), 'two\n', { mode: 0o600 });
  return sourceRoot;
}

function inspector() {
  return {
    async inspectMailbox(address) {
      assert.equal(address, 'owner@example.com');
      return {
        version: 1,
        scope: 'mailbox',
        identity: address,
        dataPath: CANONICAL_SOURCE,
        present: true,
        bytes: 8,
        snapshotSha256: SNAPSHOT,
        sideEffects: false,
      };
    },
    async inspectDomain() { throw new Error('unexpected domain inspection'); },
  };
}

function vmailRun() {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return async () => ({ stdout: `vmail:x:${uid}:${gid}:vmail:/var/lib/yunpanel/mail:/usr/sbin/nologin\n` });
}

async function createVerifiedBackup(root, sourceRoot, mapped) {
  const manager = createMailDataBackupManager({
    backupRoot: path.join(root, 'backups'),
    mailDataInspector: inspector(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
  });
  const manifest = await manager.backup({
    backupId: 'mail-delete-backup-1',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  });
  return { manager, manifest };
}

test('delete verifies backup content, removes live Maildir and exposes replay-free final evidence', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  const mapped = mappedFs(sourceRoot);
  const { manager, manifest } = await createVerifiedBackup(root, sourceRoot, mapped);
  const deletion = createMailDataDeleteManager({
    backupManager: manager,
    mailDataInspector: inspector(),
    run: vmailRun(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
    renameFn: mapped.renameFn,
    rmFn: mapped.rmFn,
  });

  const result = await deletion.deleteData({
    transactionId: 'mail-delete-tx-0001',
    backupId: manifest.backupId,
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedTargetSnapshotSha256: SNAPSHOT,
  });
  assert.equal(result.deleted, true);
  assert.equal(result.contentSha256, manifest.contentSha256);
  await assert.rejects(lstat(sourceRoot), (error) => error?.code === 'ENOENT');
  const evidence = await deletion.inspectDeleted({
    transactionId: 'mail-delete-tx-0001',
    backupId: manifest.backupId,
    scope: 'mailbox',
    identity: 'owner@example.com',
  });
  assert.equal(evidence.satisfied, true);
  assert.equal(evidence.result.contentSha256, manifest.contentSha256);
}));

test('purge failure restores the original live path when tombstone content is still complete', async () => withTempDirectory(async (root) => {
  const sourceRoot = await sourceFixture(root);
  const mapped = mappedFs(sourceRoot);
  const { manager, manifest } = await createVerifiedBackup(root, sourceRoot, mapped);
  let failed = false;
  const deletion = createMailDataDeleteManager({
    backupManager: manager,
    mailDataInspector: inspector(),
    run: vmailRun(),
    lstatFn: mapped.lstatFn,
    openFn: mapped.openFn,
    readdirFn: mapped.readdirFn,
    renameFn: mapped.renameFn,
    rmFn: async (value, options) => {
      if (!failed && String(value).includes('.owner.delete-mail-delete-tx-0002')) {
        failed = true;
        throw Object.assign(new Error('injected purge failure'), { code: 'EIO' });
      }
      return mapped.rmFn(value, options);
    },
  });

  await assert.rejects(
    deletion.deleteData({
      transactionId: 'mail-delete-tx-0002',
      backupId: manifest.backupId,
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedTargetSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataDeleteError && error.code === 'mail_data_delete_failed',
  );
  assert.equal((await lstat(sourceRoot)).isDirectory(), true);
  assert.equal(await open(path.join(sourceRoot, 'cur', 'mail-1')).then(async (handle) => { await handle.close(); return true; }), true);
}));