import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailDataRestoreManager,
  MailDataRestoreError,
} from '../src/index.js';

const CANONICAL_ROOT = '/var/lib/yunpanel';
const CANONICAL_TARGET = '/var/lib/yunpanel/mail/example.com/owner';
const SNAPSHOT = 'a'.repeat(64);
const UID = 5000;
const GID = 5000;

function compareNames(left, right) {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function updateTreeHash(hash, tuple) {
  hash.update(`${JSON.stringify(tuple)}\n`);
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  let files = 0;
  let directories = 0;
  let bytes = 0;
  async function visit(current, relative) {
    const metadata = await lstat(current);
    if (metadata.isDirectory()) {
      if (relative) directories += 1;
      updateTreeHash(hash, ['d', relative]);
      const entries = await readdir(current, { withFileTypes: true });
      entries.sort(compareNames);
      for (const entry of entries) {
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        await visit(path.join(current, entry.name), next);
      }
      return;
    }
    assert.equal(metadata.isFile(), true);
    const content = await readFile(current);
    files += 1;
    bytes += content.length;
    updateTreeHash(hash, ['f', relative, content.length, createHash('sha256').update(content).digest('hex')]);
  }
  await visit(root, '');
  return { contentSha256: hash.digest('hex'), files, directories, bytes };
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-restore-'));
  try {
    const liveRoot = path.join(root, 'live-root');
    const canonicalBase = path.join(liveRoot, 'var/lib/yunpanel');
    await mkdir(canonicalBase, { recursive: true, mode: 0o755 });
    const mapPath = (value) => value === CANONICAL_ROOT || value.startsWith(`${CANONICAL_ROOT}/`)
      ? path.join(canonicalBase, value.slice(CANONICAL_ROOT.length + (value === CANONICAL_ROOT ? 0 : 1)))
      : value;
    const targetPath = mapPath(CANONICAL_TARGET);
    await mkdir(path.join(targetPath, 'Maildir', 'cur'), { recursive: true, mode: 0o700 });
    await chmod(mapPath('/var/lib/yunpanel/mail'), 0o700);
    await chmod(mapPath('/var/lib/yunpanel/mail/example.com'), 0o700);
    await chmod(targetPath, 0o700);
    await chmod(path.join(targetPath, 'Maildir'), 0o700);
    await chmod(path.join(targetPath, 'Maildir', 'cur'), 0o700);
    await writeFile(path.join(targetPath, 'Maildir', 'cur', 'old-message'), 'old message\n', { mode: 0o600 });

    const backupData = path.join(root, 'selected-backup');
    await mkdir(path.join(backupData, 'Maildir', 'cur'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(backupData, 'Maildir', 'cur', 'new-message'), 'restored message\n', { mode: 0o600 });
    const selectedTree = await treeDigest(backupData);
    const selectedManifest = {
      version: 1,
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      sourcePath: CANONICAL_TARGET,
      sourcePresent: true,
      sourceSnapshotSha256: 'b'.repeat(64),
      sourceFingerprintSha256: 'c'.repeat(64),
      ...selectedTree,
      createdAt: '2026-09-13T21:00:00.000Z',
      sideEffects: true,
    };

    const fs = {
      chmodFn: (value, mode) => chmod(mapPath(value), mode),
      chownFn: async () => {},
      lstatFn: async (value) => {
        const metadata = await lstat(mapPath(value));
        if (value === '/var/lib/yunpanel/mail' || value.startsWith('/var/lib/yunpanel/mail/')) {
          return {
            ...metadata,
            uid: UID,
            gid: GID,
            isDirectory: () => metadata.isDirectory(),
            isFile: () => metadata.isFile(),
            isSymbolicLink: () => metadata.isSymbolicLink(),
          };
        }
        return metadata;
      },
      mkdirFn: (value, options) => mkdir(mapPath(value), options),
      openFn: (value, flags, mode) => open(mapPath(value), flags, mode),
      readdirFn: (value, options) => readdir(mapPath(value), options),
      renameFn: (source, destination) => rename(mapPath(source), mapPath(destination)),
      rmFn: (value, options) => rm(mapPath(value), options),
      rmdirFn: (value) => rmdir(mapPath(value)),
    };

    return await run({ root, mapPath, targetPath, backupData, selectedManifest, fs });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function dependencies({ targetPath, backupData, selectedManifest, fs, mutateAfterPreBackup = null, renameFn = null }) {
  const backupCalls = [];
  const backupManager = {
    async materializeBackup(id) {
      assert.equal(id, 'mail-backup-selected');
      return { manifest: selectedManifest, dataPath: backupData };
    },
    async backup(input) {
      backupCalls.push(input);
      let tree;
      try { tree = await treeDigest(targetPath); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        tree = { contentSha256: createHash('sha256').update('empty').digest('hex'), files: 0, directories: 0, bytes: 0 };
      }
      const result = {
        version: 1,
        backupId: input.backupId,
        scope: input.scope,
        identity: input.identity,
        sourcePath: CANONICAL_TARGET,
        sourcePresent: true,
        sourceSnapshotSha256: input.expectedSnapshotSha256,
        sourceFingerprintSha256: 'd'.repeat(64),
        ...tree,
        createdAt: '2026-09-13T21:01:00.000Z',
        sideEffects: true,
      };
      if (mutateAfterPreBackup) await mutateAfterPreBackup();
      return result;
    },
  };
  const mailDataInspector = {
    async inspectMailbox(address) {
      assert.equal(address, 'owner@example.com');
      let present = true;
      try { await lstat(targetPath); } catch (error) { if (error?.code === 'ENOENT') present = false; else throw error; }
      return {
        version: 1,
        scope: 'mailbox',
        identity: address,
        dataPath: CANONICAL_TARGET,
        present,
        bytes: 0,
        snapshotSha256: SNAPSHOT,
        sideEffects: false,
      };
    },
    async inspectDomain() { throw new Error('unexpected domain inspection'); },
  };
  return {
    backupCalls,
    manager: createMailDataRestoreManager({
      backupManager,
      mailDataInspector,
      run: async (file, args) => {
        assert.equal(file, '/usr/bin/getent');
        assert.deepEqual(args, ['passwd', 'vmail']);
        return { stdout: `vmail:x:${UID}:${GID}::/var/lib/yunpanel/mail:/usr/sbin/nologin\n`, stderr: '' };
      },
      ...fs,
      ...(renameFn ? { renameFn } : {}),
    }),
  };
}

test('restores selected mail data by private staging, pre-restore backup and atomic swap', async () => withFixture(async (state) => {
  const { manager, backupCalls } = dependencies(state);
  const result = await manager.restore({
    transactionId: 'restore-job-0001',
    backupId: 'mail-backup-selected',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedTargetSnapshotSha256: SNAPSHOT,
  });

  assert.equal(result.backupId, 'mail-backup-selected');
  assert.equal(result.preRestoreBackupId, 'pre-restore:restore-job-0001');
  assert.equal(result.contentSha256, state.selectedManifest.contentSha256);
  assert.equal(result.applied, true);
  assert.equal(result.sideEffects, true);
  assert.deepEqual(backupCalls, [{
    backupId: 'pre-restore:restore-job-0001',
    scope: 'mailbox',
    identity: 'owner@example.com',
    expectedSnapshotSha256: SNAPSHOT,
  }]);
  assert.equal(await readFile(path.join(state.targetPath, 'Maildir', 'cur', 'new-message'), 'utf8'), 'restored message\n');
  await assert.rejects(readFile(path.join(state.targetPath, 'Maildir', 'cur', 'old-message')), (error) => error?.code === 'ENOENT');
  assert.equal((await lstat(state.targetPath)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(state.targetPath, 'Maildir', 'cur', 'new-message'))).mode & 0o777, 0o600);
  assert.deepEqual(await manager.inspectRestored({
    backupId: 'mail-backup-selected',
    scope: 'mailbox',
    identity: 'owner@example.com',
  }), {
    satisfied: true,
    result: {
      version: 1,
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      contentSha256: state.selectedManifest.contentSha256,
      bytes: state.selectedManifest.bytes,
      files: state.selectedManifest.files,
      directories: state.selectedManifest.directories,
      restoredPresent: true,
      applied: true,
      sideEffects: true,
    },
  });
}));

test('verification failure rolls the previous Maildir back after the atomic swap', async () => withFixture(async (state) => {
  const baseRename = state.fs.renameFn;
  const renameFn = async (source, destination) => {
    await baseRename(source, destination);
    if (source.includes('.restore-') && destination === CANONICAL_TARGET) {
      await chmod(path.join(state.targetPath, 'Maildir', 'cur', 'new-message'), 0o644);
    }
  };
  const { manager } = dependencies({ ...state, renameFn });

  await assert.rejects(
    manager.restore({
      transactionId: 'restore-job-0002',
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedTargetSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataRestoreError && error.code === 'mail_data_restore_verification_failed',
  );
  assert.equal(await readFile(path.join(state.targetPath, 'Maildir', 'cur', 'old-message'), 'utf8'), 'old message\n');
  await assert.rejects(readFile(path.join(state.targetPath, 'Maildir', 'cur', 'new-message')), (error) => error?.code === 'ENOENT');
}));

test('content race after pre-restore backup fails before staging can replace live mail data', async () => withFixture(async (state) => {
  const mutateAfterPreBackup = async () => {
    await writeFile(path.join(state.targetPath, 'Maildir', 'cur', 'old-message'), 'changed after backup\n', { mode: 0o600 });
  };
  const { manager } = dependencies({ ...state, mutateAfterPreBackup });
  await assert.rejects(
    manager.restore({
      transactionId: 'restore-job-0003',
      backupId: 'mail-backup-selected',
      scope: 'mailbox',
      identity: 'owner@example.com',
      expectedTargetSnapshotSha256: SNAPSHOT,
    }),
    (error) => error instanceof MailDataRestoreError && error.code === 'mail_data_restore_target_changed',
  );
  assert.equal(await readFile(path.join(state.targetPath, 'Maildir', 'cur', 'old-message'), 'utf8'), 'changed after backup\n');
}));
