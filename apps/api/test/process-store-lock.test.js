import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProcessStoreLock } from '../src/runtime/process-store-lock.js';

test('process store lock waits for a live writer and then runs the next transaction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const lockA = createProcessStoreLock({ filePath, pid: 1111, signalProcess: () => true, waitMs: 1000, retryMs: 5 });
  const lockB = createProcessStoreLock({ filePath, pid: 2222, signalProcess: () => true, waitMs: 1000, retryMs: 5 });

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let startedA;
  const aStarted = new Promise((resolve) => { startedA = resolve; });
  const order = [];
  const first = lockA.withLock(async () => {
    order.push('a-start');
    startedA();
    await pending;
    order.push('a-end');
  });
  await aStarted;
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

test('nested calls share only a live verified async transaction, including another registry lock instance', async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-reentrant-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const filePath=path.join(root,'store.json'),first=createProcessStoreLock({filePath,waitMs:100}),second=createProcessStoreLock({filePath,waitMs:100});
 const result=await first.withLock(()=>second.withLock(async()=> 'nested'));
 assert.equal(result,'nested');
 await assert.rejects(readFile(first.lockPath),e=>e.code==='ENOENT');
});

test('a transaction token altered during nested entry is rejected and the foreign lock is retained',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-lock-token-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const lock=createProcessStoreLock({filePath:path.join(root,'store.json'),waitMs:100});
 await lock.withLock(async()=>{
  const original=JSON.parse(await readFile(lock.lockPath,'utf8'));await writeFile(lock.lockPath,JSON.stringify({...original,token:'22222222-2222-4222-8222-222222222222'}));
  await assert.rejects(lock.withLock(async()=>{throw new Error('must not run');}),e=>e.code==='process_store_lock_ownership_changed');
 });
 assert.equal(JSON.parse(await readFile(lock.lockPath,'utf8')).token,'22222222-2222-4222-8222-222222222222');
});

test('an async callback inherited from a finished transaction must wait for the current independent writer',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-finished-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const filePath=path.join(root,'store.json'),first=createProcessStoreLock({filePath,waitMs:1000}),second=createProcessStoreLock({filePath,waitMs:1000});
 let launch,child,ran=false;
 await first.withLock(async()=>{const gate=new Promise(resolve=>{launch=resolve;});child=gate.then(()=>first.withLock(async()=>{ran=true;}));});
 await second.withLock(async()=>{launch();await new Promise(resolve=>setTimeout(resolve,25));assert.equal(ran,false);});
 await child;assert.equal(ran,true);
});

test('an outer transaction retains ownership until an unawaited nested writer completes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yp-nested-writer-lifetime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'counter.json');
  await writeFile(filePath, '0');
  const first = createProcessStoreLock({ filePath, waitMs: 1000 });
  const second = createProcessStoreLock({ filePath, waitMs: 1000 });
  let child, release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let outerCompleted = false, independentEntered = false;
  const outer = first.withLock(async () => {
    child = first.withLock(async () => {
      const before = Number(await readFile(filePath, 'utf8'));
      started();
      await gate;
      // A nested call is still valid while the outer callback is draining.
      await first.withLock(() => writeFile(filePath, String(before + 1)));
    });
    await entered;
  }).then(() => { outerCompleted = true; });
  await entered;
  const independent = second.withLock(async () => {
    independentEntered = true;
    await writeFile(filePath, String(Number(await readFile(filePath, 'utf8')) + 1));
  });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(outerCompleted, false);
  assert.equal(independentEntered, false);
  release();
  await Promise.all([outer, child, independent]);
  assert.equal(await readFile(filePath, 'utf8'), '2');
  await assert.rejects(readFile(first.lockPath), error => error.code === 'ENOENT');
});

const RACE_CHILD = `
import { appendFile, access } from 'node:fs/promises';
const [moduleUrl, filePath, logPath, goPath, stalePid, delayMs, name] = process.argv.slice(1);
const { createProcessStoreLock } = await import(moduleUrl);
// A slow liveness probe for the dead owner widens the window between seeing the stale lock and removing it.
const signalProcess = (pid, signal) => {
  if (pid === Number(stalePid)) { const until = Date.now() + Number(delayMs); while (Date.now() < until); }
  return process.kill(pid, signal);
};
const lock = createProcessStoreLock({ filePath, signalProcess, waitMs: 10000, retryMs: 5 });
process.stdout.write('ready\\n');
while (true) { try { await access(goPath); break; } catch { await new Promise((r) => setTimeout(r, 2)); } }
await lock.withLock(async () => {
  await appendFile(logPath, 'enter ' + name + '\\n');
  await new Promise((r) => setTimeout(r, 300));
  await appendFile(logPath, 'exit ' + name + '\\n');
});
`;

test('two real processes reclaiming the same dead-owner lock never hold it at the same time', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const logPath = path.join(root, 'critical.log');
  const goPath = path.join(root, 'go');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(`${filePath}.lock`, JSON.stringify({
    version: 1, pid: deadPid, token: '66666666-6666-4666-8666-666666666666', createdAt: new Date().toISOString(),
  }));
  const moduleUrl = pathToFileURL(fileURLToPath(new URL('../src/runtime/process-store-lock.js', import.meta.url))).href;
  const children = [['fast', 30], ['slow', 150]].map(([name, delayMs]) => {
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', RACE_CHILD, moduleUrl, filePath, logPath, goPath, String(deadPid), String(delayMs), name,
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    return {
      ready: new Promise((resolve) => child.stdout.once('data', resolve)),
      exited: new Promise((resolve) => child.once('exit', resolve)),
    };
  });
  await Promise.all(children.map((child) => child.ready));
  await writeFile(goPath, '');
  assert.deepEqual(await Promise.all(children.map((child) => child.exited)), [0, 0]);

  const events = (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => line.split(' '));
  assert.deepEqual(events.map(([kind]) => kind), ['enter', 'exit', 'enter', 'exit']);
  assert.equal(events[0][1], events[1][1]);
  assert.equal(events[2][1], events[3][1]);
  assert.notEqual(events[0][1], events[2][1]);
  await assert.rejects(readFile(`${filePath}.lock`), { code: 'ENOENT' });
  await assert.rejects(readFile(`${filePath}.lock.reclaim`), { code: 'ENOENT' });
});

test('a reclaim guard left by a crashed process is cleared once it is old', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-store-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'jobs.json');
  const dead = () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); };
  const lock = createProcessStoreLock({ filePath, pid: 1111, signalProcess: dead, waitMs: 1000, retryMs: 5 });
  await writeFile(lock.lockPath, JSON.stringify({
    version: 1, pid: 9999, token: '77777777-7777-4777-8777-777777777777', createdAt: new Date().toISOString(),
  }));
  await writeFile(`${lock.lockPath}.reclaim`, '');
  const old = new Date(Date.now() - 60_000);
  await utimes(`${lock.lockPath}.reclaim`, old, old);
  assert.equal(await lock.withLock(async () => 'recovered'), 'recovered');
});
