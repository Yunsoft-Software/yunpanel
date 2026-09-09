import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireLocalExecutionLock, LocalExecutionLockError } from '../src/local-execution-lock.js';

async function withLockDir(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-local-lock-'));
  try {
    await callback({ directory, filePath: path.join(directory, 'local-executor.lock') });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('only one live local executor lock owns a server and release is idempotent', async () => {
  await withLockDir(async ({ filePath }) => {
    const first = await acquireLocalExecutionLock({ filePath, serverId: 'server-1', pid: 111, signalProcess: () => {} });
    const metadata = await stat(filePath);
    assert.equal(metadata.mode & 0o077, 0);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.serverId, 'server-1');
    assert.equal(persisted.pid, 111);

    await assert.rejects(
      acquireLocalExecutionLock({ filePath, serverId: 'server-1', pid: 222, signalProcess: () => {} }),
      (error) => error instanceof LocalExecutionLockError && error.code === 'local_executor_locked',
    );

    assert.equal(await first.release(), true);
    assert.equal(await first.release(), false);
    const second = await acquireLocalExecutionLock({ filePath, serverId: 'server-1', pid: 222, signalProcess: () => {} });
    assert.equal(await second.release(), true);
  });
});

test('a well-formed stale lock is replaced only when its pid is confirmed absent', async () => {
  await withLockDir(async ({ filePath }) => {
    await writeFile(filePath, `${JSON.stringify({
      version: 1,
      serverId: 'server-1',
      pid: 999,
      token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      createdAt: '2026-09-10T00:00:00.000Z',
    })}\n`, { mode: 0o600 });

    const lock = await acquireLocalExecutionLock({
      filePath,
      serverId: 'server-1',
      pid: 333,
      signalProcess: () => { const error = new Error('not found'); error.code = 'ESRCH'; throw error; },
    });
    const current = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(current.pid, 333);
    assert.notEqual(current.token, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await lock.release();
  });
});

test('malformed existing lock fails closed instead of being deleted', async () => {
  await withLockDir(async ({ filePath }) => {
    await writeFile(filePath, 'not-json\n', { mode: 0o600 });
    await assert.rejects(
      acquireLocalExecutionLock({ filePath, serverId: 'server-1', pid: 444, signalProcess: () => {} }),
      (error) => error instanceof LocalExecutionLockError && error.code === 'local_executor_lock_invalid',
    );
    assert.equal(await readFile(filePath, 'utf8'), 'not-json\n');
  });
});

test('release never unlinks a lock that no longer belongs to the caller', async () => {
  await withLockDir(async ({ filePath }) => {
    const lock = await acquireLocalExecutionLock({ filePath, serverId: 'server-1', pid: 555, signalProcess: () => {} });
    await writeFile(filePath, `${JSON.stringify({
      version: 1,
      serverId: 'server-1',
      pid: 777,
      token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      createdAt: '2026-09-10T00:00:00.000Z',
    })}\n`, { mode: 0o600 });
    assert.equal(await lock.release(), false);
    assert.equal(JSON.parse(await readFile(filePath, 'utf8')).pid, 777);
  });
});
