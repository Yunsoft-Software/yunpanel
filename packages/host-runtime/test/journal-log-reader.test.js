import assert from 'node:assert/strict';
import test from 'node:test';
import { createJournalLogReader, JournalLogReaderError } from '../src/index.js';

function entry({ cursor, message, priority = '6', timestamp = 1_788_739_200_000_000 }) {
  return JSON.stringify({ __CURSOR: cursor, __REALTIME_TIMESTAMP: String(timestamp), PRIORITY: priority, MESSAGE: message, _PID: '123' });
}

test('reads only one allowlisted journal unit with bounded fixed arguments and redacted output', async () => {
  const calls = [];
  const reader = createJournalLogReader({
    run: async (...args) => {
      calls.push(args);
      return { stdout: [
        entry({ cursor: 's=one;i=1', message: 'started TOKEN=private-value' }),
        entry({ cursor: 's=two;i=2', message: 'request complete', priority: '4' }),
      ].join('\n') };
    },
  });
  const result = await reader.query({
    unit: 'yunpanel-node-0123456789abcdef.service',
    since: '2026-09-10T00:00:00.000Z',
    until: '2026-09-11T00:00:00.000Z',
    priorities: [0, 1, 2, 3, 4, 5, 6, 7],
    search: 'started',
    limit: 20,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].message, 'started TOKEN=[REDACTED]');
  assert.equal(JSON.stringify(result).includes('private-value'), false);
  assert.deepEqual(calls[0][1], [
    '--unit=yunpanel-node-0123456789abcdef.service', '--output=json', '--no-pager', '--utc', '--reverse',
    '--lines=1001', '--since=2026-09-10T00:00:00.000Z', '--until=2026-09-11T00:00:00.000Z',
    '--priority=0..7',
  ]);
  assert.equal(calls[0][2].maxBuffer, 2 * 1024 * 1024);
});

test('uses an exact journal cursor and never executes arbitrary units', async () => {
  const calls = [];
  const reader = createJournalLogReader({ run: async (...args) => { calls.push(args); return { stdout: '' }; } });
  await reader.query({
    unit: 'nginx.service', since: '2026-09-10T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z',
    priorities: [3, 4], cursor: 's=cursor;i=20', limit: 10,
  });
  assert.equal(calls[0][1].at(-1), '--cursor=s=cursor;i=20');
  await assert.rejects(
    reader.query({
      unit: 'ssh.service', since: '2026-09-10T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z', priorities: [3],
    }),
    (error) => error instanceof JournalLogReaderError && error.code === 'unsupported_log_unit',
  );
});

test('collapses journal execution failures without returning command output', async () => {
  const reader = createJournalLogReader({
    run: async () => { throw Object.assign(new Error('secret'), { stdout: 'TOKEN=secret', stderr: 'private' }); },
  });
  await assert.rejects(
    reader.query({
      unit: 'yunpanel-api.service', since: '2026-09-10T00:00:00.000Z', until: '2026-09-11T00:00:00.000Z', priorities: [0, 1, 2, 3],
    }),
    (error) => error instanceof JournalLogReaderError && error.code === 'journal_log_read_failed' && !JSON.stringify(error).includes('secret'),
  );
});
