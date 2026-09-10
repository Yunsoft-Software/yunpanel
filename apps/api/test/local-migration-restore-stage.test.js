import assert from 'node:assert/strict';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stageLocalMigrationRestore } from '../src/local-migration-restore-stage.js';

const backupDirectory = '/var/backups/yunpanel/migration-2026-09-10T15-00-00-000Z';
const sha256 = 'a'.repeat(64);

function members() {
  return [
    { name: 'etc/yunpanel', type: 'd', root: '/etc/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o750, metadataMarker: null },
    { name: 'etc/yunpanel/api.env', type: '-', root: '/etc/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o640, metadataMarker: '*' },
    { name: 'etc/yunpanel/api-link', type: 'l', root: '/etc/yunpanel', resolvedLinkTarget: 'etc/yunpanel/api.env', uid: 0, gid: 0, mode: 0o777, metadataMarker: null },
    { name: 'var/lib/yunpanel', type: 'd', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o700, metadataMarker: null },
    { name: 'var/lib/yunpanel/data', type: 'd', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 0, gid: 0, mode: 0o750, metadataMarker: null },
    { name: 'var/lib/yunpanel/data/file', type: '-', root: '/var/lib/yunpanel', resolvedLinkTarget: null, uid: 101, gid: 101, mode: 0o640, metadataMarker: null },
    { name: 'var/lib/yunpanel/data/hard', type: 'h', root: '/var/lib/yunpanel', resolvedLinkTarget: 'var/lib/yunpanel/data/file', uid: 101, gid: 101, mode: 0o640, metadataMarker: null },
  ];
}

function preview(memberList = members(), overrides = {}) {
  return {
    destructive: false,
    backupDirectory,
    archivePath: `${backupDirectory}/state.tar`,
    manifestPath: `${backupDirectory}/manifest.json`,
    sha256,
    archiveInspection: {
      destructive: false,
      linksSafe: true,
      ownershipMetadata: true,
      extendedMetadataValidated: false,
      backupDirectory,
      sha256,
      counts: {
        total: memberList.length,
        files: memberList.filter((entry) => entry.type === '-').length,
        directories: memberList.filter((entry) => entry.type === 'd').length,
        symlinks: memberList.filter((entry) => entry.type === 'l').length,
        hardlinks: memberList.filter((entry) => entry.type === 'h').length,
        extendedMetadata: memberList.filter((entry) => entry.metadataMarker !== null).length,
      },
      members: memberList,
      ...(overrides.archiveInspection ?? {}),
    },
    ...overrides,
  };
}

async function materializeValidStage(directory) {
  await mkdir(path.join(directory, 'etc/yunpanel'), { recursive: true });
  await writeFile(path.join(directory, 'etc/yunpanel/api.env'), 'safe\n');
  await symlink('api.env', path.join(directory, 'etc/yunpanel/api-link'));
  await mkdir(path.join(directory, 'var/lib/yunpanel/data'), { recursive: true });
  const file = path.join(directory, 'var/lib/yunpanel/data/file');
  await writeFile(file, 'payload\n');
  await link(file, path.join(directory, 'var/lib/yunpanel/data/hard'));
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'yunpanel-stage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, stageRoot: path.join(root, 'restore-staging') };
}

test('restore staging extracts only into a private isolated tree and preserves owner-mode evidence without applying it', async (t) => {
  const { stageRoot } = await createFixture(t);
  const tarCalls = [];
  const result = await stageLocalMigrationRestore({
    backupDirectory,
    stageRoot,
    previewRestore: async () => preview(),
    runTar: async (args) => {
      tarCalls.push(args);
      const target = args[args.indexOf('--directory') + 1];
      await materializeValidStage(target);
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.validated, true);
  assert.equal(result.liveMutation, false);
  assert.equal(result.destructive, false);
  assert.equal(result.ownershipMetadata, true);
  assert.equal(result.extendedMetadata, 1);
  assert.equal(result.extendedMetadataValidated, false);
  assert.equal(result.members, members().length);
  assert.equal(path.dirname(result.stageDirectory), stageRoot);
  assert.equal((await lstat(stageRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(result.stageDirectory)).mode & 0o777, 0o700);
  assert.equal(tarCalls.length, 1);
  assert.ok(tarCalls[0].includes('--no-same-owner'));
  assert.ok(tarCalls[0].includes('--no-same-permissions'));
  assert.ok(tarCalls[0].includes('--delay-directory-restore'));
  assert.equal(tarCalls[0][tarCalls[0].indexOf('--file') + 1], `${backupDirectory}/state.tar`);
  assert.equal(tarCalls[0][tarCalls[0].indexOf('--directory') + 1], result.stageDirectory);

  const source = await lstat(path.join(result.stageDirectory, 'var/lib/yunpanel/data/file'));
  const hard = await lstat(path.join(result.stageDirectory, 'var/lib/yunpanel/data/hard'));
  assert.equal(source.dev, hard.dev);
  assert.equal(source.ino, hard.ino);
});

test('missing or malformed archive ownership metadata is rejected before staging root creation', async (t) => {
  const { stageRoot } = await createFixture(t);
  const invalidSets = [
    members().map((entry, index) => index === 0 ? Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'uid')) : entry),
    members().map((entry, index) => index === 0 ? { ...entry, gid: -1 } : entry),
    members().map((entry, index) => index === 0 ? { ...entry, mode: 0o10000 } : entry),
    members().map((entry, index) => index === 0 ? { ...entry, metadataMarker: '@' } : entry),
  ];
  for (const invalid of invalidSets) {
    await assert.rejects(
      stageLocalMigrationRestore({
        backupDirectory,
        stageRoot,
        previewRestore: async () => preview(invalid),
        runTar: async () => { throw new Error('must not extract'); },
      }),
      { code: 'migration_restore_stage_preview_invalid' },
    );
  }
  await assert.rejects(lstat(stageRoot), { code: 'ENOENT' });
});

test('extended metadata count drift is rejected before extraction', async (t) => {
  const { stageRoot } = await createFixture(t);
  let tarCalls = 0;
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(members(), {
        archiveInspection: { counts: { total: 7, files: 2, directories: 3, symlinks: 1, hardlinks: 1, extendedMetadata: 0 } },
      }),
      runTar: async () => { tarCalls += 1; },
    }),
    { code: 'migration_restore_stage_preview_invalid' },
  );
  assert.equal(tarCalls, 0);
  await assert.rejects(lstat(stageRoot), { code: 'ENOENT' });
});

test('unexpected extracted members fail closed and the partial stage is removed', async (t) => {
  const { stageRoot } = await createFixture(t);
  let stagedDirectory = null;
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(),
      runTar: async (args) => {
        stagedDirectory = args[args.indexOf('--directory') + 1];
        await materializeValidStage(stagedDirectory);
        await writeFile(path.join(stagedDirectory, 'etc/yunpanel/unexpected'), 'nope\n');
      },
    }),
    { code: 'migration_restore_stage_member_mismatch' },
  );
  assert.ok(stagedDirectory);
  await assert.rejects(lstat(stagedDirectory), { code: 'ENOENT' });
});

test('staged symlink target drift is rejected and cleaned up', async (t) => {
  const { stageRoot } = await createFixture(t);
  let stagedDirectory = null;
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(),
      runTar: async (args) => {
        stagedDirectory = args[args.indexOf('--directory') + 1];
        await mkdir(path.join(stagedDirectory, 'etc/yunpanel'), { recursive: true });
        await writeFile(path.join(stagedDirectory, 'etc/yunpanel/api.env'), 'safe\n');
        await symlink('../passwd', path.join(stagedDirectory, 'etc/yunpanel/api-link'));
        await mkdir(path.join(stagedDirectory, 'var/lib/yunpanel/data'), { recursive: true });
        const file = path.join(stagedDirectory, 'var/lib/yunpanel/data/file');
        await writeFile(file, 'payload\n');
        await link(file, path.join(stagedDirectory, 'var/lib/yunpanel/data/hard'));
      },
    }),
    { code: 'migration_restore_stage_link_mismatch' },
  );
  await assert.rejects(lstat(stagedDirectory), { code: 'ENOENT' });
});

test('hardlink identity must survive staging rather than becoming a copied file', async (t) => {
  const { stageRoot } = await createFixture(t);
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(),
      runTar: async (args) => {
        const target = args[args.indexOf('--directory') + 1];
        await mkdir(path.join(target, 'etc/yunpanel'), { recursive: true });
        await writeFile(path.join(target, 'etc/yunpanel/api.env'), 'safe\n');
        await symlink('api.env', path.join(target, 'etc/yunpanel/api-link'));
        await mkdir(path.join(target, 'var/lib/yunpanel/data'), { recursive: true });
        await writeFile(path.join(target, 'var/lib/yunpanel/data/file'), 'payload\n');
        await writeFile(path.join(target, 'var/lib/yunpanel/data/hard'), 'payload\n');
      },
    }),
    { code: 'migration_restore_stage_hardlink_mismatch' },
  );
});

test('cross-root link metadata is rejected before the staging root is created', async (t) => {
  const { stageRoot } = await createFixture(t);
  const unsafe = members().map((entry) => (
    entry.type === 'h'
      ? { ...entry, resolvedLinkTarget: 'etc/yunpanel/api.env' }
      : entry
  ));
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(unsafe),
      runTar: async () => { throw new Error('must not run'); },
    }),
    { code: 'migration_restore_stage_preview_invalid' },
  );
  await assert.rejects(lstat(stageRoot), { code: 'ENOENT' });
});

test('tar extraction failure is redacted and partial staging is removed', async (t) => {
  const { stageRoot } = await createFixture(t);
  let stagedDirectory = null;
  await assert.rejects(
    stageLocalMigrationRestore({
      backupDirectory,
      stageRoot,
      previewRestore: async () => preview(),
      runTar: async (args) => {
        stagedDirectory = args[args.indexOf('--directory') + 1];
        await mkdir(path.join(stagedDirectory, 'etc/yunpanel'), { recursive: true });
        throw new Error('SECRET=/root/private/key');
      },
    }),
    (error) => {
      assert.equal(error.code, 'migration_restore_stage_extract_failed');
      assert.equal(error.message, 'Migration restore archive could not be staged safely');
      assert.doesNotMatch(error.message, /SECRET|\/root\/private|key/i);
      return true;
    },
  );
  await assert.rejects(lstat(stagedDirectory), { code: 'ENOENT' });
});
