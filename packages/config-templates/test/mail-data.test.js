import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailDataTemplateError,
  mailDataTemplatePolicy,
  mailDomainDataPath,
  mailboxDataPath,
} from '../src/index.js';

test('mail data paths derive only from canonical managed mail identities', () => {
  assert.equal(mailDataTemplatePolicy.root, '/var/lib/yunpanel/mail');
  assert.equal(mailDomainDataPath('Example.COM'), '/var/lib/yunpanel/mail/example.com');
  assert.equal(mailboxDataPath('Owner+Tag@Example.COM'), '/var/lib/yunpanel/mail/example.com/owner+tag');
});

test('mail data path derivation rejects traversal and malformed identities', () => {
  for (const value of ['../example.com', '/etc/passwd', 'example..com', '']) {
    assert.throws(
      () => mailDomainDataPath(value),
      (error) => error instanceof MailDataTemplateError && error.code === 'invalid_mail_data_domain',
    );
  }
  for (const value of ['../owner@example.com', 'owner@../example.com', 'owner/example@example.com', 'owner']) {
    assert.throws(
      () => mailboxDataPath(value),
      (error) => error instanceof MailDataTemplateError && error.code === 'invalid_mail_data_mailbox',
    );
  }
});
