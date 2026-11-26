import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWordPressSelectiveFileRollback } from '../src/wordpress/wordpress-selective-file-rollback.js';

const linux = { skip: process.platform !== 'linux' && 'Requires Linux directory file descriptors' };
const serviceUrl = new URL('../src/wordpress/wordpress-selective-file-rollback.js', import.meta.url);
const relativePath = 'wp-content/plugins/shop/plugin.php';
const original = '<?php /* Production plugin */';
const replacement = '<?php /* Promoted plugin */';
const concurrent = '<?php /* Concurrent WordPress write */';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function fixture(t, { existing = true } = {}) {
  const tmp = await mkdtemp(path.join(await realpath(tmpdir()), 'yunpanel-wp-selective-rollback-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const releaseRoot = path.join(tmp, 'release');
  const retentionDirectory = path.join(tmp, 'private', 'operation');
  const live = path.join(releaseRoot, relativePath);
  await mkdir(path.dirname(live), { recursive: true, mode: 0o755 });
  await mkdir(retentionDirectory, { recursive: true, mode: 0o700 });
  if (existing) await writeFile(live, original, { mode: 0o640 });

  const { dev, ino } = await lstat(releaseRoot, { bigint: true });
  const settings = { releaseRoot, expectedRoot: { device: String(dev), inode: String(ino) }, retentionDirectory };
  const input = { relativePath, expectedTargetSha256: existing ? sha256(original) : null, content: Buffer.from(replacement) };
  return { tmp, live, settings, input, service: createWordPressSelectiveFileRollback(settings) };
}

async function receiptFor(settings) {
  return JSON.parse(await readFile(path.join(settings.retentionDirectory, `${sha256(relativePath)}.json`), 'utf8'));
}

async function retained(settings, receipt, role) {
  return readFile(path.join(settings.retentionDirectory, `${receipt.operation}.${role}`), 'utf8');
}

async function pausedChild(t, { settings, input, verb, functionName, stopAt }) {
  // A native subprocess pauses at the exact source line via Node's inspector.
  // The filesystem operation itself runs unchanged before the process is killed.
  const source = (await readFile(serviceUrl, 'utf8')).split('\n');
  const functionLine = source.findIndex((line) => line.includes(`function ${functionName}(`));
  const lineNumber = functionLine + source.slice(functionLine).findIndex((line) => line.includes(stopAt));
  assert.ok(lineNumber > functionLine, 'The crash checkpoint must identify an executable source line');

  const runner = `
    import { createWordPressSelectiveFileRollback } from ${JSON.stringify(serviceUrl.href)};
    const service = createWordPressSelectiveFileRollback(${JSON.stringify(settings)});
    const args = ${JSON.stringify(input)};
    if (args.content) args.content = Buffer.from(args.content.data);
    await service[${JSON.stringify(verb)}](args);
  `;
  const child = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', '--input-type=module', '-e', runner], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'exit');
  const stops = new EventEmitter();
  const signal = AbortSignal.timeout(10_000);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    const endpoint = /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr)?.[1];
    if (endpoint) stops.emit('endpoint', endpoint);
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });

  const [endpoint] = await once(stops, 'endpoint', { signal });
  const ws = new WebSocket(endpoint);
  t.after(() => ws.close());
  await once(ws, 'open', { signal });
  let requestId = 0;
  ws.addEventListener('message', (event) => {
    const packet = JSON.parse(event.data);
    if (packet.id) stops.emit(`reply:${packet.id}`, packet);
    else if (packet.method === 'Debugger.paused') stops.emit('pause', packet.params);
  });
  async function send(method, params = {}) {
    const id = ++requestId;
    const reply = once(stops, `reply:${id}`, { signal });
    ws.send(JSON.stringify({ id, method, params }));
    const [packet] = await reply;
    assert.equal(packet.error, undefined, JSON.stringify(packet.error));
    return packet.result;
  }

  await send('Debugger.enable');
  const { breakpointId } = await send('Debugger.setBreakpointByUrl', { url: serviceUrl.href, lineNumber });
  const firstPause = once(stops, 'pause', { signal });
  await send('Runtime.runIfWaitingForDebugger');
  let [paused] = await firstPause;
  // ESM eval on Node 24 can start directly at the explicit breakpoint. Other
  // Node builds may first report their automatic break on the entry line.
  if (!paused.hitBreakpoints?.includes(breakpointId)) {
    const checkpoint = once(stops, 'pause', { signal });
    await send('Debugger.resume');
    [paused] = await checkpoint;
  }
  assert.ok(paused.hitBreakpoints?.includes(breakpointId));
  return {
    async kill() {
      assert.equal(child.kill('SIGKILL'), true);
      assert.deepEqual(await exited, [null, 'SIGKILL']);
      ws.close();
    },
    async finish() {
      await send('Debugger.resume');
      ws.close();
      assert.deepEqual(await exited, [0, null], stderr);
    },
  };
}

test('publishes and restores an existing file with its original inode and permissions', linux, async (t) => {
  const { live, service, input, settings } = await fixture(t);
  const before = await lstat(live);
  const other = path.join(path.dirname(live), 'other.php');
  await writeFile(other, 'independent');
  const applied = await service.apply(input);
  assert.equal(applied.status, 'applied');
  assert.equal(await readFile(live, 'utf8'), replacement);
  assert.equal((await service.apply(input)).idempotent, true);
  assert.notEqual((await lstat(live)).ino, before.ino);
  assert.equal((await lstat(live)).mode, before.mode);

  assert.equal((await service.rollback({ relativePath })).status, 'rolled_back');
  assert.equal((await service.rollback({ relativePath })).idempotent, true);
  assert.equal(await readFile(live, 'utf8'), original);
  assert.equal((await lstat(live)).ino, before.ino);
  assert.equal(await readFile(other, 'utf8'), 'independent');
  assert.equal(await retained(settings, await receiptFor(settings), 'after'), replacement);
});

test('restoring a previously vacant path keeps later writes through a retained open handle', linux, async (t) => {
  const { live, service, input, settings } = await fixture(t, { existing: false });
  assert.equal((await service.apply(input)).status, 'applied');
  const writer = await open(live, 'a');
  t.after(() => writer.close());
  assert.equal((await service.rollback({ relativePath })).status, 'rolled_back');
  await assert.rejects(lstat(live), { code: 'ENOENT' });
  await writer.writeFile(concurrent);
  assert.equal(await retained(settings, await receiptFor(settings), 'after'), replacement + concurrent);
});

test('restores writes a WordPress process made via a still-open original inode', linux, async (t) => {
  const { live, service, input } = await fixture(t);
  const writer = await open(live, 'a');
  t.after(() => writer.close());
  await service.apply(input);
  await writer.writeFile(concurrent);
  assert.equal((await service.rollback({ relativePath })).status, 'rolled_back');
  assert.equal(await readFile(live, 'utf8'), original + concurrent);
});

test('a later in-place edit or SFTP rename survives rollback', linux, async (t) => {
  for (const changed of ['in-place edit', 'SFTP rename']) {
    await t.test(changed, async (subtest) => {
      const { tmp, live, service, input, settings } = await fixture(subtest);
      await service.apply(input);
      if (changed === 'in-place edit') await writeFile(live, concurrent);
      else {
        const incoming = path.join(tmp, 'uploaded.php');
        await writeFile(incoming, concurrent);
        await rename(incoming, live);
      }
      const later = await lstat(live);
      const outcome = await service.rollback({ relativePath });
      assert.equal(outcome.status, 'conflict');
      assert.equal(outcome.reason, 'target_changed');
      assert.equal(await readFile(live, 'utf8'), concurrent);
      assert.equal((await lstat(live)).ino, later.ino);
      assert.equal(await retained(settings, await receiptFor(settings), 'before'), original);
    });
  }
});

test('recovers after SIGKILL following the original rename before the publish receipt', { ...linux, timeout: 15_000 }, async (t) => {
  const { live, input, settings } = await fixture(t);
  const child = await pausedChild(t, { settings, input, verb: 'apply', functionName: 'capture', stopAt: 'await location.storage.sync()' });
  const receipt = await receiptFor(settings);
  assert.equal(receipt.phase, 'prepared');
  assert.equal(await retained(settings, receipt, 'before'), original);
  await assert.rejects(lstat(live), { code: 'ENOENT' });
  await child.kill();
  const restarted = createWordPressSelectiveFileRollback(settings);
  assert.equal((await restarted.rollback({ relativePath })).status, 'rolled_back');
  assert.equal(await readFile(live, 'utf8'), original);
  assert.equal((await restarted.rollback({ relativePath })).idempotent, true);
});

test('restores the vacant name and reports ambiguity when killed just before publication', { ...linux, timeout: 15_000 }, async (t) => {
  const { live, input, settings } = await fixture(t);
  const child = await pausedChild(t, { settings, input, verb: 'apply', functionName: 'publish', stopAt: 'try { await link' });
  const receipt = await receiptFor(settings);
  assert.equal(receipt.phase, 'publish_pending');
  await assert.rejects(lstat(live), { code: 'ENOENT' });
  await child.kill();
  const restarted = createWordPressSelectiveFileRollback(settings);
  const restored = await restarted.rollback({ relativePath });
  assert.equal(restored.status, 'conflict');
  assert.equal(restored.reason, 'publication_interrupted');
  assert.equal(await readFile(live, 'utf8'), original);
  assert.equal(await retained(settings, receipt, 'stage'), replacement);
});

test('a new pathname occupant beats rollback after a process dies following compensation capture', { ...linux, timeout: 15_000 }, async (t) => {
  const { live, input, service, settings } = await fixture(t);
  await service.apply(input);
  const child = await pausedChild(t, { settings, input: { relativePath }, verb: 'rollback', functionName: 'capture', stopAt: 'await location.storage.sync()' });
  const receipt = await receiptFor(settings);
  assert.equal(receipt.phase, 'compensating');
  assert.equal(await retained(settings, receipt, 'after'), replacement);
  await writeFile(live, concurrent, { flag: 'wx' });
  await child.kill();
  const restarted = createWordPressSelectiveFileRollback(settings);
  const outcome = await restarted.rollback({ relativePath });
  assert.equal(outcome.status, 'conflict');
  assert.equal(await readFile(live, 'utf8'), concurrent);
  assert.equal(await retained(settings, receipt, 'before'), original);
  assert.equal(await retained(settings, receipt, 'after'), replacement);
  assert.equal((await restarted.rollback({ relativePath })).idempotent, true);
});

test('does not capture a directory that took the target name during a rollback race', { ...linux, timeout: 15_000 }, async (t) => {
  const { tmp, live, input, service, settings } = await fixture(t);
  await service.apply(input);
  const child = await pausedChild(t, { settings, input: { relativePath }, verb: 'rollback', functionName: 'capture', stopAt: 'try { await rename' });
  await rename(live, path.join(tmp, 'renamed.php'));
  await mkdir(live);
  await writeFile(path.join(live, 'important.php'), concurrent);
  await child.finish();
  assert.equal((await receiptFor(settings)).phase, 'conflict');
  assert.equal(await readFile(path.join(live, 'important.php'), 'utf8'), concurrent);
  assert.equal(await readFile(path.join(tmp, 'renamed.php'), 'utf8'), replacement);
});

test('restores the exact SFTP replacement selected by a racing capture', { ...linux, timeout: 15_000 }, async (t) => {
  const { tmp, live, input, service, settings } = await fixture(t);
  await service.apply(input);
  const child = await pausedChild(t, { settings, input: { relativePath }, verb: 'rollback', functionName: 'capture', stopAt: 'try { await rename' });
  const incoming = path.join(tmp, 'sftp-upload.php');
  await writeFile(incoming, concurrent);
  const uploaded = await lstat(incoming);
  await rename(incoming, live);
  await child.finish();
  const receipt = await receiptFor(settings);
  assert.equal(receipt.phase, 'conflict');
  assert.equal(await readFile(live, 'utf8'), concurrent);
  assert.equal((await lstat(live)).ino, uploaded.ino);
  assert.equal(await retained(settings, receipt, 'after'), concurrent);
  assert.equal(await retained(settings, receipt, 'before'), original);
});

test('fails closed for protected paths, an insecure retention directory and a changed parent', linux, async (t) => {
  const { live, input, service, settings } = await fixture(t);
  await assert.rejects(service.apply({ ...input, relativePath: 'wp-content/plugins/shop/.env' }), { code: 'wordpress_selective_file_protected' });
  await assert.rejects(service.apply({ ...input, relativePath: 'wp-content/uploads/production.jpg' }), { code: 'wordpress_selective_file_protected' });
  await chmod(settings.retentionDirectory, 0o755);
  await assert.rejects(service.apply(input), { code: 'wordpress_selective_retention_unsafe' });
  assert.deepEqual(await readdir(settings.retentionDirectory), []);
  await chmod(settings.retentionDirectory, 0o700);
  await service.apply(input);
  const parent = path.dirname(live);
  const moved = `${parent}-original`;
  await rename(parent, moved);
  await symlink(moved, parent, 'dir');
  await assert.rejects(service.rollback({ relativePath }), { code: 'wordpress_selective_file_location_unavailable' });
  assert.equal(await readFile(path.join(moved, path.basename(live)), 'utf8'), replacement);
  await rm(parent);
  await mkdir(parent);
  await writeFile(live, concurrent);
  await assert.rejects(service.rollback({ relativePath }), { code: 'wordpress_selective_file_identity_changed' });
  assert.equal(await readFile(live, 'utf8'), concurrent);
});
