import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createJobRegistry } from '../src/job-registry.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';
import { createLocalHostOperations } from '../src/local-host-operations.js';
import { reconcileCompletedJob } from '../src/job-reconciliation.js';
import { localRuntimeInternals } from '../src/local-runtime.js';
import { localExecutorFaultLine } from '../src/local-claim-failure-diagnostic.js';

const sha = value => createHash('sha256').update(value).digest('hex');
async function ownedStore(t) {
  const temp = await realpath(os.tmpdir());
  const root = await realpath(await mkdtemp(path.join(temp, 'yunpanel-claim-diagnostic-')));
  const before = await lstat(root);
  assert.equal(before.isDirectory() && !before.isSymbolicLink() && before.uid === process.getuid() && (before.mode & 0o777) === 0o700, true);
  let complete = false;
  t.after(async () => {
    if (!complete) return;
    const current = await lstat(root);
    assert.equal(await realpath(root), root);
    assert.deepEqual([current.dev, current.ino, current.uid, current.mode], [before.dev, before.ino, before.uid, before.mode]);
    for (const name of await readdir(root)) {
      assert.equal(name, 'job-registry.json');
      const file = path.join(root, name), metadata = await lstat(file);
      assert.equal(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === process.getuid() && metadata.nlink === 1 && (metadata.mode & 0o777) === 0o600, true);
      await unlink(file);
    }
    await rmdir(root);
  });
  return { root, filePath: path.join(root, 'job-registry.json'), identity: before, complete() { complete = true; } };
}

function executorFor(registry, select = true) {
  const operations = createLocalHostOperations();
  assert.equal(operations.supports('domain.stage'), true);
  return createLocalJobExecutor({ serverId: randomUUID(), jobRegistry: registry,
    supportsOperation: select ? operations.supports : null,
    executeOperation: operations.executeOperation, reconcileCompletedJob });
}

async function assertStopped(executor, boundary, causeClass, causeCode, privateValues = []) {
  let failure;
  try { await executor.runOnce(); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.deepEqual([failure.code, failure.phase, failure.jobId, failure.failureBoundary, failure.causeClass, failure.causeCode],
    ['local_claim_unconfirmed', 'claim', null, boundary, causeClass, causeCode]);
  assert.equal(executor.running(), false);
  const snapshot = executor.failure();
  await assert.rejects(() => executor.runOnce(), error => error.code === 'local_claim_unconfirmed');
  assert.throws(() => executor.start(), error => error.code === 'local_claim_unconfirmed');
  assert.deepEqual(executor.failure(), snapshot);
  const normalized = localRuntimeInternals.normalizeExecutorFault(failure);
  const line = localExecutorFaultLine(normalized);
  assert.equal(line, `[yunpanel-api] local executor fault code=local_claim_unconfirmed phase=claim job=none failureBoundary=${boundary} causeClass=${causeClass} causeCode=${causeCode}`);
  assert.equal(Buffer.byteLength(line) < 512, true);
  for (const value of privateValues) assert.equal(line.includes(value) || JSON.stringify(normalized).includes(value), false);
  assert.equal(Object.hasOwn(normalized, 'message') || Object.hasOwn(normalized, 'stack') || Object.hasOwn(snapshot, 'cause'), false);
}

for (const [label, select, boundary] of [['selection', true, 'select_queued'], ['claim invocation', false, 'claim_next']]) {
  test(`real owned invalid JSON at ${label} preserves fatal stop and safe diagnostic output`, { timeout: 20000 }, async t => {
    const store = await ownedStore(t), registry = createJobRegistry({ filePath: store.filePath });
    await registry.init();
    const marker = 'owned-invalid-' + randomUUID();
    await writeFile(store.filePath, '{' + marker + '\n', { flag: 'wx', mode: 0o600 });
    const before = sha(await readFile(store.filePath));
    await assertStopped(executorFor(registry, select), boundary, 'SyntaxError', 'none', [marker, store.root]);
    assert.equal(sha(await readFile(store.filePath)), before);
    store.complete();
  });
}

test('real live-process store lock timeout preserves fatal stop without claim or retry', { timeout: 20000 }, async t => {
  const store = await ownedStore(t), registry = createJobRegistry({ filePath: store.filePath });
  await registry.init();
  const execArgv = process.execArgv.filter(value => value.startsWith('--import='));
  const child = fork(new URL('./fixtures/local-claim-failure-diagnostic-lock-owner.mjs', import.meta.url),
    [store.filePath, String(store.identity.dev), String(store.identity.ino)],
    { execArgv, env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdoutBytes = 0, stderrBytes = 0;
  child.stdout.on('data', data => { stdoutBytes += data.length; });
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  try {
    const [message] = await Promise.race([once(child, 'message', { signal: t.signal }), exited.then(() => { throw new Error('Owned lock process exited before acquisition'); })]);
    assert.equal(message.event, 'locked'); assert.equal(message.pid, child.pid);
    await assertStopped(executorFor(registry), 'select_queued', 'ProcessStoreLockError', 'process_store_locked', [store.root]);
  } finally {
    if (child.connected) child.send({ event: 'release' });
    assert.deepEqual(await exited, { code: 0, signal: null });
  }
  assert.equal(stdoutBytes, 0); assert.equal(stderrBytes, 0);
  assert.deepEqual(await readdir(store.root), []);
  store.complete();
});
