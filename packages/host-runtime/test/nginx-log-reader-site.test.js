import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNginxLogReader } from '../src/index.js';

const access = (n) => `203.0.113.${n} - - [27/Oct/2026:10:00:0${n % 10} +0300] "GET /sayfa-${n} HTTP/1.1" 200 10 "-" "curl"\n`;
const range = { since: '2026-10-27T00:00:00.000Z', until: '2026-10-28T00:00:00.000Z', levels: ['info'] };

async function logDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-nginx-logs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a site query reads only that site\'s own log file, never the server-wide log', async (t) => {
  const directory = await logDirectory(t);
  await writeFile(path.join(directory, 'access.log'), access(1));
  await writeFile(path.join(directory, 'site-a.example.com.access.log'), access(2));
  await writeFile(path.join(directory, 'site-b.example.com.access.log'), access(3));
  const reader = createNginxLogReader({ logDirectory: directory });
  const result = await reader.query({ kind: 'access', site: 'site-a.example.com', ...range, limit: 50 });
  assert.deepEqual(result.entries.map(entry => entry.message.match(/sayfa-\d/)[0]), ['sayfa-2']);
});

test('a site without traffic yet returns an empty page instead of an error', async (t) => {
  const reader = createNginxLogReader({ logDirectory: await logDirectory(t) });
  const result = await reader.query({ kind: 'error', site: 'new.example.com', ...range, levels: ['error'], limit: 50 });
  assert.deepEqual(result.entries, []);
  const live = await reader.follow({ kind: 'access', site: 'new.example.com', levels: ['info'] });
  assert.deepEqual(live.entries, []);
  assert.equal(live.cursor, null);
});

test('site names are strict hostnames so a request cannot escape the log directory', async (t) => {
  const reader = createNginxLogReader({ logDirectory: await logDirectory(t) });
  for (const site of ['../etc/passwd', 'a/b.example.com', 'example', '.example.com', 'Example.com', 'a..b.com', `${'a'.repeat(64)}.com`, '']) {
    await assert.rejects(reader.query({ kind: 'access', site, ...range, limit: 10 }), { code: 'invalid_log_query' }, site);
    await assert.rejects(reader.follow({ kind: 'access', site, levels: ['info'] }), { code: 'invalid_log_query' }, site);
  }
});

test('follow starts at the end, then returns only newly completed lines in order', async (t) => {
  const directory = await logDirectory(t);
  const file = path.join(directory, 'live.example.com.access.log');
  await writeFile(file, access(1) + access(2));
  const reader = createNginxLogReader({ logDirectory: directory });
  const start = await reader.follow({ kind: 'access', site: 'live.example.com', levels: ['info'] });
  assert.deepEqual(start.entries, []);
  assert.ok(start.cursor);

  await appendFile(file, access(3) + access(4) + '203.0.113.5 - - [27/Oct/2026:10:00:05 +0300] "GET /yarim');
  const next = await reader.follow({ kind: 'access', site: 'live.example.com', levels: ['info'], cursor: start.cursor });
  assert.deepEqual(next.entries.map(entry => entry.message.match(/sayfa-\d/)[0]), ['sayfa-3', 'sayfa-4']);
  assert.equal(next.reset, false);

  await appendFile(file, ' HTTP/1.1" 200 10 "-" "curl"\n');
  const completed = await reader.follow({ kind: 'access', site: 'live.example.com', levels: ['info'], cursor: next.cursor });
  assert.equal(completed.entries.length, 1, 'a half-written line is delivered once it is complete');
  assert.match(completed.entries[0].message, /GET \/yarim HTTP/);

  const idle = await reader.follow({ kind: 'access', site: 'live.example.com', levels: ['info'], cursor: completed.cursor });
  assert.deepEqual(idle.entries, []);
  assert.equal(idle.cursor, completed.cursor);
});

test('follow restarts from the new file after logrotate and after truncation', async (t) => {
  const directory = await logDirectory(t);
  const file = path.join(directory, 'rot.example.com.access.log');
  await writeFile(file, access(1));
  const reader = createNginxLogReader({ logDirectory: directory });
  const start = await reader.follow({ kind: 'access', site: 'rot.example.com', levels: ['info'] });

  await rename(file, `${file}.1`);
  await writeFile(file, access(6));
  const rotated = await reader.follow({ kind: 'access', site: 'rot.example.com', levels: ['info'], cursor: start.cursor });
  assert.equal(rotated.reset, true);
  assert.deepEqual(rotated.entries.map(entry => entry.message.match(/sayfa-\d/)[0]), ['sayfa-6']);

  await truncate(file, 0);
  await writeFile(file, access(7));
  const truncated = await reader.follow({ kind: 'access', site: 'rot.example.com', levels: ['info'], cursor: rotated.cursor });
  assert.equal(truncated.reset, true);
  assert.deepEqual(truncated.entries.map(entry => entry.message.match(/sayfa-\d/)[0]), ['sayfa-7']);
});

test('follow honours level and search filters and rejects a malformed cursor', async (t) => {
  const directory = await logDirectory(t);
  const file = path.join(directory, 'err.example.com.error.log');
  await writeFile(file, '');
  const reader = createNginxLogReader({ logDirectory: directory });
  const start = await reader.follow({ kind: 'error', site: 'err.example.com', levels: ['error'] });
  await appendFile(file, '2026/10/27 10:00:01 [warn] 7#7: yavaş istek\n2026/10/27 10:00:02 [error] 7#7: upstream düştü\n2026/10/27 10:00:03 [error] 7#7: disk dolu\n');
  const next = await reader.follow({ kind: 'error', site: 'err.example.com', levels: ['error'], search: 'upstream', cursor: start.cursor });
  assert.deepEqual(next.entries.map(entry => entry.level), ['error']);
  assert.match(next.entries[0].message, /upstream/);
  await assert.rejects(reader.follow({ kind: 'error', site: 'err.example.com', levels: ['error'], cursor: 'file:1:2:3' }), { code: 'invalid_log_query' });
});
