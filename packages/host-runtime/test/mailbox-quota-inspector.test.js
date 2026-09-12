import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMailboxQuotaInspector,
  MailboxQuotaInspectorError,
  parseDoveadmQuotaTab,
} from '../src/index.js';

const output = [
  'Quota name\tType\tValue\tLimit\t%',
  'User quota\tSTORAGE\t90099\t102400\t87',
  'User quota\tMESSAGE\t20548\t30000\t68',
  '',
].join('\n');

test('parses Dovecot storage quota values from bounded tab output', () => {
  assert.deepEqual(parseDoveadmQuotaTab(output, 'OWNER@EXAMPLE.COM.'), {
    version: 1,
    address: 'owner@example.com',
    storageBytes: 90099 * 1024,
    limitBytes: 102400 * 1024,
    usagePercent: 87,
    source: 'doveadm_quota',
    sideEffects: false,
  });
});

test('supports unlimited storage rows without fabricating a limit', () => {
  const parsed = parseDoveadmQuotaTab(
    'Quota name\tType\tValue\tLimit\t%\nUser quota\tSTORAGE\t32\t-\t-\n',
    'owner@example.com',
  );
  assert.equal(parsed.storageBytes, 32768);
  assert.equal(parsed.limitBytes, null);
  assert.equal(parsed.usagePercent, null);
});

test('quota inspector executes only the fixed doveadm quota command', async () => {
  const calls = [];
  const inspector = createMailboxQuotaInspector({
    run: async (file, args) => {
      calls.push([file, [...args]]);
      return { stdout: output, stderr: '' };
    },
  });
  const result = await inspector.inspect('Owner@Example.com');
  assert.equal(result.address, 'owner@example.com');
  assert.deepEqual(calls, [[
    '/usr/bin/doveadm',
    ['-f', 'tab', 'quota', 'get', '-u', 'owner@example.com'],
  ]]);
});

test('quota inspector fails closed on malformed, duplicate and oversized output', async () => {
  for (const value of [
    '',
    'Type\tValue\tLimit\t%\nSTORAGE\t1\t2\t50\n',
    'Quota name\tType\tValue\tLimit\t%\nUser quota\tSTORAGE\tbogus\t2\t50\n',
    'Quota name\tType\tValue\tLimit\t%\nA\tSTORAGE\t1\t2\t50\nB\tSTORAGE\t1\t2\t50\n',
  ]) assert.throws(
    () => parseDoveadmQuotaTab(value, 'owner@example.com'),
    (error) => error instanceof MailboxQuotaInspectorError,
  );

  assert.throws(
    () => parseDoveadmQuotaTab(`Quota name\tType\tValue\tLimit\t%\n${'x'.repeat(70 * 1024)}`, 'owner@example.com'),
    { code: 'mailbox_quota_usage_output_too_large' },
  );
});

test('quota inspector hides command failure details', async () => {
  const inspector = createMailboxQuotaInspector({
    run: async () => {
      const error = new Error('private dovecot diagnostic');
      error.stderr = 'secret-like internal output';
      throw error;
    },
  });
  await assert.rejects(
    inspector.inspect('owner@example.com'),
    (error) => error instanceof MailboxQuotaInspectorError
      && error.code === 'mailbox_quota_usage_failed'
      && !/private|secret-like/.test(error.message),
  );
});
