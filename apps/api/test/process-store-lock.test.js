import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProcessStoreLock } from '../src/process-store-lock.js';

test('process store lock waits for a live writer and then runs the next transaction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const lockA = createProcessStoreLock({ filePath, pid: 1111, signalProcess: () => true, waitMs: 1000, retryMs: 5 });
  const lockB = createProcessStoreLock({ filePath, pid: 2222, signalProcess: () => true, waitMs: 1000, retryMs: 5 });

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const order = [];
  const first = lockA.withLock(async () => {
    order.push('a-start');
    await pending;
    order.push('a-end');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = lockB.withLock(async () => {
    order.push('b');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ['a-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a-start', 'a-end', 'b']);
});

test('process store lock removes only a proven dead-process stale lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const first = createProcessStoreLock({
    filePath,
    pid: 1111,
    signalProcess: () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); },
  });
  const lockPath = first.lockPath;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(lockPath, JSON.stringify({
    version: 1,
    pid: 9999,
    token: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date().toISOString(),
  }));
  assert.equal(await first.withLock(async () => 'recovered'), 'recovered');

  await writeFile(lockPath, '{"broken":true}');
  await assert.rejects(
    () => first.withLock(async () => 'must-not-run'),
    (error) => error.code === 'process_store_lock_unreadable',
  );
});

test('process store lock preserves transaction callback errors and releases ownership', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = createProcessStoreLock({ filePath: path.join(root, 'jobs.json') });
  const failure = Object.assign(new Error('persist failed'), { code: 'persist_failed' });
  await assert.rejects(() => lock.withLock(async () => { throw failure; }), (error) => error === failure);
  assert.equal(await lock.withLock(async () => 'next'), 'next');
});

test('process store lock handles permission errors and signal EPERM safely', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');

  // When signalProcess throws EPERM (permission denied signaling foreign process),
  // processAlive treats it as alive and does NOT steal the lock, timing out cleanly.
  const lockStale = createProcessStoreLock({
    filePath,
    pid: 1111,
    signalProcess: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    waitMs: 50,
    retryMs: 5,
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(lockStale.lockPath, JSON.stringify({
    version: 1,
    pid: 9999,
    token: '44444444-4444-4444-8444-444444444444',
    createdAt: new Date().toISOString(),
  }));
  await assert.rejects(
    () => lockStale.withLock(async () => 'must-not-run'),
    (error) => error.code === 'process_store_locked' && error.status === 503,
  );

  // When lock file creation fails with an unrecoverable error (e.g. invalid directory), it fails closed
  const uncreatableLock = createProcessStoreLock({ filePath: '/dev/null/uncreatable/jobs.json' });
  await assert.rejects(
    () => uncreatableLock.withLock(async () => 'never'),
    (error) => error.code === 'process_store_lock_failed',
  );
});

test('independent API and worker process locks serialize mutations and handle lock crash', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const sharedLog = [];

  let apiAlive = true;
  let workerAlive = true;
  const signal = (pid) => {
    if (pid === 1001 && apiAlive) return true;
    if (pid === 2002 && workerAlive) return true;
    throw Object.assign(new Error('dead'), { code: 'ESRCH' });
  };

  const apiLock = createProcessStoreLock({ filePath, pid: 1001, signalProcess: signal, waitMs: 1000, retryMs: 5 });
  const workerLock = createProcessStoreLock({ filePath, pid: 2002, signalProcess: signal, waitMs: 1000, retryMs: 5 });

  await apiLock.withLock(async () => {
    sharedLog.push('api-write-1');
  });
  await workerLock.withLock(async () => {
    sharedLog.push('worker-write-1');
  });
  assert.deepEqual(sharedLog, ['api-write-1', 'worker-write-1']);

  // Simulate API process crash while holding lock (lock file remains on disk, API process dies)
  const { writeFile } = await import('node:fs/promises');
  await writeFile(apiLock.lockPath, JSON.stringify({
    version: 1,
    pid: 1001,
    token: '55555555-5555-4555-8555-555555555555',
    createdAt: new Date().toISOString(),
  }));
  apiAlive = false;

  // Worker process detects dead API process (ESRCH), cleans stale lock, and safely acquires lock
  await workerLock.withLock(async () => {
    sharedLog.push('worker-recovered-after-crash');
  });
  assert.deepEqual(sharedLog, ['api-write-1', 'worker-write-1', 'worker-recovered-after-crash']);
});
