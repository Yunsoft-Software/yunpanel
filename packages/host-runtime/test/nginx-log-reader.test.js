import assert from 'node:assert/strict';
import test from 'node:test';
import { createNginxLogReader, NginxLogReaderError, nginxLogInternals } from '../src/index.js';

function fixture(content) {
  const data = Buffer.from(content);
  const calls = [];
  let closed = false;
  const details = { size: data.length, dev: 1, ino: 2, isFile: () => true };
  const reader = createNginxLogReader({
    lstatFn: async (target) => { calls.push(['lstat', target]); return { ...details, isSymbolicLink: () => false }; },
    openFn: async (target, flags) => {
      calls.push(['open', target, flags]);
      return {
        stat: async () => details,
        read: async (target, offset, length, position) => {
          const source = data.subarray(position, position + length);
          source.copy(target, offset);
          return { bytesRead: source.length, buffer: target };
        },
        close: async () => { closed = true; },
      };
    },
  });
  return { reader, calls, closed: () => closed };
}

test('parses access/error timestamps and redacts Nginx lines from fixed files only', async () => {
  assert.equal(nginxLogInternals.isoFromAccess('127.0.0.1 - - [11/Sep/2026:14:30:00 +0300] "GET / HTTP/1.1" 200 10'), '2026-09-11T11:30:00.000Z');
  const logs = fixture([
    '2026/09/11 14:29:00 [error] 42#42: upstream TOKEN=private failed',
    '2026/09/11 14:30:00 [warn] 43#43: retry complete',
    '',
  ].join('\n'));
  const result = await logs.reader.query({
    kind: 'error', since: '2026-09-11T10:00:00.000Z', until: '2026-09-11T15:00:00.000Z',
    levels: ['error', 'warning'], search: 'upstream', limit: 20,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message.includes('private'), false);
  assert.equal(result.entries[0].pid, 42);
  assert.equal(logs.calls[0][1], '/var/log/nginx/error.log');
  assert.equal(logs.calls[1][1], '/var/log/nginx/error.log');
  assert.equal(logs.closed(), true);
});

test('uses byte cursors and rejects stale cursors without returning file content', async () => {
  const logs = fixture('127.0.0.1 - - [11/Sep/2026:14:30:00 +0300] "GET / HTTP/1.1" 200 10\n');
  const first = await logs.reader.query({
    kind: 'access', since: '2026-09-11T10:00:00.000Z', until: '2026-09-11T15:00:00.000Z', levels: ['info'], limit: 1,
  });
  assert.equal(first.entries.length, 1);
  await assert.rejects(
    logs.reader.query({
      kind: 'access', since: '2026-09-11T10:00:00.000Z', until: '2026-09-11T15:00:00.000Z', levels: ['info'], cursor: 'file:1:2:999999', limit: 1,
    }),
    (error) => error instanceof NginxLogReaderError && error.code === 'nginx_log_cursor_stale',
  );
  await assert.rejects(
    logs.reader.query({
      kind: 'access', since: '2026-09-11T10:00:00.000Z', until: '2026-09-11T15:00:00.000Z', levels: ['info'], cursor: 'file:1:99:0', limit: 1,
    }),
    (error) => error instanceof NginxLogReaderError && error.code === 'nginx_log_cursor_stale',
  );
});
