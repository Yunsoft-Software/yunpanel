import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailTemplateError,
  mailTemplatePolicy,
  previewPostfixVirtualDomainMap,
  renderPostfixVirtualDomainMap,
} from '../src/index.js';

test('renders a canonical deterministic Postfix virtual domain map', () => {
  const rendered = renderPostfixVirtualDomainMap(['Z.example.com.', 't\u00fcrkiye.example']);
  assert.equal(rendered, 'xn--trkiye-3ya.example OK\nz.example.com OK\n');
});

test('previews the exact source map and fixed validation commands without side effects', () => {
  const preview = previewPostfixVirtualDomainMap(['mail.example.com']);
  assert.deepEqual(preview, {
    version: 1,
    path: '/etc/yunpanel/mail/postfix/virtual-domains',
    lookup: 'hash:/etc/yunpanel/mail/postfix/virtual-domains',
    sha256: '8ff47cf9683bea83852eaf8089e850e46502ba1456c626bd246c68875907b261',
    bytes: 20,
    entries: 1,
    content: 'mail.example.com OK\n',
    compile: { file: '/usr/sbin/postmap', args: ['hash:/etc/yunpanel/mail/postfix/virtual-domains'] },
    validate: { file: '/usr/sbin/postfix', args: ['check'] },
    sideEffects: false,
  });
  assert.equal(mailTemplatePolicy.maxManagedDomains, 1_000);
});

test('renders an empty domain map for an explicit empty managed set', () => {
  const preview = previewPostfixVirtualDomainMap([]);
  assert.equal(preview.content, '');
  assert.equal(preview.entries, 0);
  assert.equal(preview.bytes, 0);
  assert.equal(preview.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('rejects invalid, duplicate and oversized managed domain state', () => {
  assert.throws(
    () => renderPostfixVirtualDomainMap('example.com'),
    (error) => error instanceof MailTemplateError && error.code === 'invalid_mail_domains',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(['Example.com', 'example.com.']),
    (error) => error instanceof MailTemplateError && error.code === 'duplicate_mail_domain',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(['not a domain']),
    (error) => error instanceof MailTemplateError && error.code === 'invalid_mail_domain',
  );
  assert.throws(
    () => renderPostfixVirtualDomainMap(Array.from({ length: 1_001 }, (_, index) => `${index}.example.com`)),
    (error) => error instanceof MailTemplateError && error.code === 'too_many_mail_domains',
  );
});
