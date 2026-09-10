import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareRootAuthStateOwnership,
  RootAuthStateMigrationError,
} from '../src/root-auth-state-migration.js';

function metadata({ uid, mode, type = 'file', symlink = false }) {
  return {
    uid,
    mode,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => symlink,
  };
}

test('non-root and non-packaged auth paths are never ownership-migrated', async () => {
  const calls = [];
  const lstatFn = async (candidate) => { calls.push(candidate); return metadata({ uid: 1000, mode: 0o40700, type: 'directory' }); };
  assert.deepEqual(await prepareRootAuthStateOwnership({ filePath: '/var/lib/yunpanel/control-plane/auth/auth.sqlite', processUid: 1000, lstatFn }), { migrated: false, files: 0 });
  assert.deepEqual(await prepareRootAuthStateOwnership({ filePath: '/tmp/auth.sqlite', processUid: 0, lstatFn }), { migrated: false, files: 0 });
  assert.equal(calls.length, 0);
});

test('root startup migrates only private legacy auth directory and SQLite files', async () => {
  const database = '/var/lib/yunpanel/control-plane/auth/auth.sqlite';
  const directory = '/var/lib/yunpanel/control-plane/auth';
  const stats = new Map([
    [directory, metadata({ uid: 998, mode: 0o40700, type: 'directory' })],
    [database, metadata({ uid: 998, mode: 0o100600 })],
    [`${database}-wal`, metadata({ uid: 998, mode: 0o100600 })],
  ]);
  const chowns = [];
  const result = await prepareRootAuthStateOwnership({
    filePath: database,
    processUid: 0,
    lstatFn: async (candidate) => {
      const value = stats.get(candidate);
      if (value) return value;
      const error = new Error('missing'); error.code = 'ENOENT'; throw error;
    },
    chownFn: async (...args) => chowns.push(args),
  });
  assert.deepEqual(result, { migrated: true, files: 2 });
  assert.deepEqual(chowns, [
    [database, 0, 0],
    [`${database}-wal`, 0, 0],
    [directory, 0, 0],
  ]);
});

test('root startup accepts already-root private auth state without writes', async () => {
  const database = '/var/lib/yunpanel/control-plane/auth/auth.sqlite';
  const directory = '/var/lib/yunpanel/control-plane/auth';
  const chowns = [];
  const result = await prepareRootAuthStateOwnership({
    filePath: database,
    processUid: 0,
    lstatFn: async (candidate) => {
      if (candidate === directory) return metadata({ uid: 0, mode: 0o40700, type: 'directory' });
      if (candidate === database) return metadata({ uid: 0, mode: 0o100600 });
      const error = new Error('missing'); error.code = 'ENOENT'; throw error;
    },
    chownFn: async (...args) => chowns.push(args),
  });
  assert.deepEqual(result, { migrated: false, files: 0 });
  assert.deepEqual(chowns, []);
});

test('unsafe permissions, symlinks and foreign file owners fail before chown', async () => {
  const database = '/var/lib/yunpanel/control-plane/auth/auth.sqlite';
  const directory = '/var/lib/yunpanel/control-plane/auth';
  for (const [directoryMetadata, fileMetadata, code] of [
    [metadata({ uid: 998, mode: 0o40755, type: 'directory' }), null, 'unsafe_auth_state_directory'],
    [metadata({ uid: 998, mode: 0o40700, type: 'directory', symlink: true }), null, 'unsafe_auth_state_directory'],
    [metadata({ uid: 998, mode: 0o40700, type: 'directory' }), metadata({ uid: 777, mode: 0o100600 }), 'unsafe_auth_state_file'],
    [metadata({ uid: 998, mode: 0o40700, type: 'directory' }), metadata({ uid: 998, mode: 0o100644 }), 'unsafe_auth_state_file'],
  ]) {
    const chowns = [];
    await assert.rejects(
      prepareRootAuthStateOwnership({
        filePath: database,
        processUid: 0,
        lstatFn: async (candidate) => {
          if (candidate === directory) return directoryMetadata;
          if (candidate === database && fileMetadata) return fileMetadata;
          const error = new Error('missing'); error.code = 'ENOENT'; throw error;
        },
        chownFn: async (...args) => chowns.push(args),
      }),
      (error) => error instanceof RootAuthStateMigrationError && error.code === code,
    );
    assert.deepEqual(chowns, []);
  }
});

test('auth database cannot use the entire control-plane root as its ownership migration directory', async () => {
  await assert.rejects(
    prepareRootAuthStateOwnership({ filePath: '/var/lib/yunpanel/control-plane/auth.sqlite', processUid: 0 }),
    (error) => error instanceof RootAuthStateMigrationError && error.code === 'auth_state_directory_too_broad',
  );
});
