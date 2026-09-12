import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailQueueInspector,
  MailQueueInspectorError,
  mailQueueInspectorInternals,
} from '../src/index.js';

function row(overrides = {}) {
  return JSON.stringify({
    queue_name: 'deferred',
    queue_id: 'ABC123DEF456',
    arrival_time: 1_789_000_000,
    message_size: 2048,
    sender: 'sender@example.com',
    recipients: [
      { address: 'recipient@example.net', delay_reason: 'connect to mx.example.net timed out' },
    ],
    ...overrides,
  });
}

test('uses fixed postqueue json argv and returns bounded normalized queue metadata', async () => {
  const calls = [];
  const inspector = createMailQueueInspector({
    run: async (file, args, options) => {
      calls.push({ file, args: [...args], options });
      return { stdout: `${row()}\n` };
    },
  });
  const result = await inspector.query({ limit: 10 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, '/usr/sbin/postqueue');
  assert.deepEqual(calls[0].args, ['-j']);
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.entries[0], {
    queueId: 'ABC123DEF456',
    queueName: 'deferred',
    arrivalTime: new Date(1_789_000_000 * 1_000).toISOString(),
    messageSize: 2048,
    sender: 'sender@example.com',
    recipients: [{ address: 'recipient@example.net', delayReason: 'connect to mx.example.net timed out' }],
  });
  assert.deepEqual(result.page, { limit: 10, count: 1, scanned: 1, hasMore: false, malformed: 0 });
  assert.equal(result.sideEffects, false);
});

test('filters by queue and search while counting malformed records without exposing raw lines', async () => {
  const inspector = createMailQueueInspector({
    run: async () => ({ stdout: [
      'not-json',
      row(),
      row({
        queue_name: 'active',
        queue_id: 'FFEEDDCCBBAA',
        sender: '',
        recipients: [{ address: 'target@example.org', delay_reason: null }],
      }),
    ].join('\n') }),
  });
  const result = await inspector.query({ limit: 20, queueName: 'active', search: 'target@example.org' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].queueId, 'FFEEDDCCBBAA');
  assert.equal(result.entries[0].sender, '');
  assert.equal(result.page.scanned, 3);
  assert.equal(result.page.malformed, 1);
  assert.doesNotMatch(JSON.stringify(result), /not-json/);
});

test('bounds response count and rejects unsafe query values before command execution', async () => {
  let calls = 0;
  const inspector = createMailQueueInspector({
    run: async () => {
      calls += 1;
      return { stdout: `${row()}\n${row({ queue_id: 'ABC123DEF457' })}\n` };
    },
  });
  const limited = await inspector.query({ limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.page.hasMore, true);
  assert.equal(calls, 1);

  await assert.rejects(
    inspector.query({ limit: 201 }),
    (error) => error instanceof MailQueueInspectorError && error.code === 'invalid_mail_queue_query',
  );
  await assert.rejects(
    inspector.query({ search: 'unsafe\nquery' }),
    (error) => error instanceof MailQueueInspectorError && error.code === 'invalid_mail_queue_query',
  );
  await assert.rejects(
    inspector.query({ queueName: '../maildrop' }),
    (error) => error instanceof MailQueueInspectorError && error.code === 'invalid_mail_queue_query',
  );
  assert.equal(calls, 1);
});

test('sanitizes and bounds provider delay reasons instead of returning arbitrary raw values', async () => {
  const reason = `Authorization: Bearer ${'A'.repeat(120)} ${'x'.repeat(1_500)}`;
  const inspector = createMailQueueInspector({
    run: async () => ({ stdout: `${row({ recipients: [{ address: 'recipient@example.net', delay_reason: reason }] })}\n` }),
  });
  const result = await inspector.query();
  const output = result.entries[0].recipients[0].delayReason;
  assert.equal(typeof output, 'string');
  assert.ok(output.length <= 1_000);
  assert.notEqual(output, reason);
});

test('maps postqueue execution failures to one authored unavailable error', async () => {
  const inspector = createMailQueueInspector({ run: async () => { throw new Error('private process error'); } });
  await assert.rejects(
    inspector.query(),
    (error) => error instanceof MailQueueInspectorError
      && error.code === 'mail_queue_unavailable'
      && error.status === 503
      && !error.message.includes('private process error'),
  );
});

test('queue policy exposes only fixed bounded command metadata', () => {
  assert.equal(mailQueueInspectorInternals.postqueuePath, '/usr/sbin/postqueue');
  assert.equal(mailQueueInspectorInternals.maxScanEntries, 1_000);
  assert.equal(mailQueueInspectorInternals.maxResponseBytes, 256 * 1024);
  assert.equal(mailQueueInspectorInternals.maxRawBytes, 2 * 1024 * 1024);
});
