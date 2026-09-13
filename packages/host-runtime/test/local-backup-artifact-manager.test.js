import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createLocalBackupArtifactManager,
  LocalBackupArtifactError,
} from '../src/local-backup-artifact-manager.js';

const artifactId = 'a'.repeat(64);
const sourceDigest = 'b'.repeat(64);

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-local-backup-'));
  const root = path.join(parent, 'backups');
  const source = path.join(parent, 'source');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'file.txt'), 'payload');
  const calls = [];
  const manager = createLocalBackupArtifactManager({
    root,
    randomSuffix: () => 'fixed',
    now: () => Date.parse('2026-09-13T20:10:00.000Z'),
    accessFn: async (candidate) => {
      if (candidate !== '/usr/bin/tar') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    runTar: async (file, args) => {
      calls.push({ file, args: [...args] });
      const target = args[args.indexOf('--file') + 1];
      const mode = args[0];
      const names = args.slice(args.indexOf('--') + 1);
      const chunk = Buffer.from(`${mode}:${names.join(',')}\n`, 'utf8');
      if (mode === '--create') await writeFile(target, chunk);
      else await writeFile(target, chunk, { flag: 'a' });
    },
  });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, root, source, calls, manager };
}

test('local artifact manager creates private archive and verified receipt', async (t) => {
  const fx = await fixture(t);
  const evidence = await fx.manager.archive({
    artifactId,
    sourceDigest,
    entries: [{ directory: fx.source, name: 'file.txt' }],
    inlineFiles: [{ name: 'control.json', content: '{"version":1}' }],
  });

  const paths = fx.manager.artifactPaths(artifactId);
  const archive = await readFile(paths.archive);
  const receipt = JSON.parse(await readFile(paths.receipt, 'utf8'));
  assert.equal((await stat(fx.root)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.archive)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.receipt)).mode & 0o777, 0o600);
  assert.equal(receipt.sourceDigest, sourceDigest);
  assert.equal(receipt.contentSha256, createHash('sha256').update(archive).digest('hex'));
  assert.deepEqual(evidence, {
    artifactId,
    contentSha256: receipt.contentSha256,
    bytes: archive.length,
    createdAt: '2026-09-13T20:10:00.000Z',
  });
  assert.equal(fx.calls.length, 2);
  assert.deepEqual(fx.calls[0].args.slice(-2), ['--', 'control.json']);
  assert.deepEqual(fx.calls[1].args.slice(-2), ['--', 'file.txt']);
});

test('local artifact manager reuses exact verified evidence instead of recreating work', async (t) => {
  const fx = await fixture(t);
  const request = {
    artifactId,
    sourceDigest,
    entries: [{ directory: fx.source, name: 'file.txt' }],
  };
  const first = await fx.manager.archive(request);
  const callsAfterFirst = fx.calls.length;
  const repeated = await fx.manager.archive(request);
  assert.deepEqual(repeated, first);
  assert.equal(fx.calls.length, callsAfterFirst);
});

test('metadata-only artifacts are supported for undeployed Application state', async (t) => {
  const fx = await fixture(t);
  const evidence = await fx.manager.archive({
    artifactId,
    sourceDigest,
    entries: [],
    inlineFiles: [
      { name: 'control.json', content: '{"state":"draft"}' },
      { name: 'environment.json', content: '{}' },
    ],
  });
  assert.equal(evidence.artifactId, artifactId);
  assert.equal(fx.calls.length, 1);
  assert.deepEqual(fx.calls[0].args.slice(-3), ['--', 'control.json', 'environment.json']);
});

test('local artifact manager rejects empty sources and top-level symlinks', async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    () => fx.manager.archive({ artifactId, sourceDigest, entries: [], inlineFiles: [] }),
    (error) => error instanceof LocalBackupArtifactError && error.code === 'backup_artifact_empty',
  );

  await symlink(path.join(fx.source, 'file.txt'), path.join(fx.source, 'link.txt'));
  await assert.rejects(
    () => fx.manager.archive({
      artifactId: 'c'.repeat(64),
      sourceDigest: 'd'.repeat(64),
      entries: [{ directory: fx.source, name: 'link.txt' }],
    }),
    (error) => error instanceof LocalBackupArtifactError && error.code === 'backup_artifact_source_invalid',
  );
});

test('existing artifact checksum tampering fails closed', async (t) => {
  const fx = await fixture(t);
  await fx.manager.archive({
    artifactId,
    sourceDigest,
    entries: [{ directory: fx.source, name: 'file.txt' }],
  });
  const paths = fx.manager.artifactPaths(artifactId);
  await writeFile(paths.archive, 'tampered');
  await assert.rejects(
    () => fx.manager.archive({
      artifactId,
      sourceDigest,
      entries: [{ directory: fx.source, name: 'file.txt' }],
    }),
    (error) => error instanceof LocalBackupArtifactError
      && ['backup_artifact_incomplete', 'backup_artifact_checksum_mismatch'].includes(error.code),
  );
});
