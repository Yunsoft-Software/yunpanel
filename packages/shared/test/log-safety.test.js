import assert from 'node:assert/strict';
import test from 'node:test';
import { logSafetyPolicy, sanitizeLogMessage } from '../src/index.js';

test('redacts common credentials and strips terminal control characters', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    'PASSWORD=hunter2 STRIPE_API_TOKEN: "private-token"',
    'clone https://person:secret@example.test/repo.git?token=another-secret',
    'github_pat_123456789012345678901234567890',
    'eyJabcdefghijk.abcdefghijkl.abcdefghijkl',
    '\u001b[31mred\u001b[0m\u0000',
  ].join('\n');
  const result = sanitizeLogMessage(input);
  assert.doesNotMatch(result.message, /hunter2|private-token|person:secret|another-secret|github_pat_|eyJabcdefghijk|\u001b/);
  assert.match(result.message, /Authorization: \[REDACTED\]/);
  assert.match(result.message, /PASSWORD=\[REDACTED\]/);
  assert.match(result.message, /STRIPE_API_TOKEN: \[REDACTED\]/);
  assert.match(result.message, /https:\/\/\[REDACTED\]@example\.test/);
  assert.equal(result.truncated, false);
});

test('redacts complete and truncated private keys before applying the output bound', () => {
  for (const value of [
    'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate\n-----END OPENSSH PRIVATE KEY-----\nafter',
    `-----BEGIN PRIVATE KEY-----\n${'secret'.repeat(20_000)}`,
  ]) {
    const result = sanitizeLogMessage(value);
    assert.doesNotMatch(result.message, /private\n|secretsecret/i);
    assert.ok(result.message.length <= logSafetyPolicy.maxMessageLength);
  }
});
