import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDovecotPasswdFile } from '@yunpanel/config-templates';
import {
  hashMailboxPassword,
  mailboxPasswordPolicy,
  MailboxPasswordError,
  verifyMailboxPassword,
} from '../src/mailbox-password.js';

test('hashes mailbox passwords as canonical Dovecot-compatible Argon2id PHC', async () => {
  const password = 'mailbox password 2026';
  const encoded = await hashMailboxPassword(password);
  assert.match(encoded, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(encoded.split('$').slice(-2).some((part) => part.includes('=')), false);
  assert.equal(await verifyMailboxPassword(password, encoded), true);
  assert.equal(await verifyMailboxPassword('wrong mailbox password', encoded), false);
  assert.match(renderDovecotPasswdFile({
    domains: ['example.com'],
    accounts: [{ address: 'owner@example.com', passwordHash: encoded }],
  }), /^owner@example\.com:\{ARGON2ID\}\$argon2id\$/);
});

test('uses independent salts and exposes only non-secret password policy metadata', async () => {
  const [left, right] = await Promise.all([
    hashMailboxPassword('same mailbox password'),
    hashMailboxPassword('same mailbox password'),
  ]);
  assert.notEqual(left, right);
  assert.deepEqual(mailboxPasswordPolicy, {
    algorithm: 'argon2id', version: 19, memoryKib: 65_536, passes: 3, parallelism: 1,
    saltBytes: 16, hashBytes: 32, maxActiveHashes: 2,
  });
});

test('rejects weak inputs and malformed or resource-amplifying hashes', async () => {
  await assert.rejects(
    hashMailboxPassword('short'),
    (error) => error instanceof MailboxPasswordError && error.code === 'invalid_mailbox_password',
  );
  await assert.rejects(hashMailboxPassword('x'.repeat(1_025)), { code: 'invalid_mailbox_password' });
  assert.equal(await verifyMailboxPassword(null, 'not-a-hash'), false);
  assert.equal(await verifyMailboxPassword('valid password 2026', '$argon2id$v=19$m=999999999,t=3,p=1$bad$bad'), false);
  assert.equal(await verifyMailboxPassword('valid password 2026', '$argon2id$v=19$m=65536,t=3,p=1$bad$bad'), false);
});

test('bounds concurrent native Argon2 work', async () => {
  const first = hashMailboxPassword('first mailbox password');
  const second = hashMailboxPassword('second mailbox password');
  await assert.rejects(
    hashMailboxPassword('third mailbox password'),
    (error) => error instanceof MailboxPasswordError
      && error.code === 'mailbox_password_busy'
      && error.status === 503,
  );
  await Promise.all([first, second]);
});
