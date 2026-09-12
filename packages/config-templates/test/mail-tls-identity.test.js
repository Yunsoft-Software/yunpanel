import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindManagedMailTlsIdentity,
  MailTlsIdentityTemplateError,
  mailTemplatePolicy,
  previewManagedMailSubmissionConfiguration,
} from '../src/index.js';

const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 2).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 3).toString('base64').replace(/=+$/, '')}`;

function preview() {
  return previewManagedMailSubmissionConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: HASH }],
    postmasterAddress: 'owner@example.com',
    forwardings: [],
  });
}

function identity(overrides = {}) {
  return {
    hostname: 'mail.example.com',
    certificateId: '74774ae1-e801-4d8e-a631-13e92cf13a05',
    certificateFingerprint256: 'AA:BB:CC',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
    revision: 1,
    ...overrides,
  };
}

test('binds one explicit certificate identity to Postfix and Dovecot desired state', () => {
  const base = preview();
  const bound = bindManagedMailTlsIdentity(base, identity());

  assert.notEqual(bound.sha256, base.sha256);
  assert.deepEqual(bound.tlsIdentity, {
    hostname: 'mail.example.com',
    certificateId: identity().certificateId,
    certificateFingerprint256: 'AA:BB:CC',
    revision: 1,
  });
  const parameters = new Map(bound.postfixParameters.map((entry) => [entry.name, entry]));
  assert.equal(parameters.get('myhostname').value, 'mail.example.com');
  assert.deepEqual(parameters.get('smtpd_tls_cert_file'), {
    name: 'smtpd_tls_cert_file',
    value: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
    protected: true,
  });
  assert.equal(parameters.get('smtpd_tls_key_file').protected, true);

  const dovecot = bound.artifacts.find((artifact) => artifact.path === mailTemplatePolicy.dovecotMailConfigPath);
  assert.match(dovecot.content, /^ssl_cert = <\/etc\/letsencrypt\/live\/mail\.example\.com\/fullchain\.pem$/m);
  assert.match(dovecot.content, /^ssl_key = <\/etc\/letsencrypt\/live\/mail\.example\.com\/privkey\.pem$/m);
  assert.equal(JSON.stringify(bound.tlsIdentity).includes('privkey'), false);
});

test('certificate renewal material changes the managed configuration digest without changing binding revision', () => {
  const base = preview();
  const first = bindManagedMailTlsIdentity(base, identity());
  const renewed = bindManagedMailTlsIdentity(base, identity({
    certificateId: '7b51a02c-c991-44f9-bde0-30a497724c18',
    certificateFingerprint256: 'DD:EE:FF',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com-0002/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com-0002/privkey.pem',
  }));
  assert.equal(first.tlsIdentity.revision, renewed.tlsIdentity.revision);
  assert.notEqual(first.sha256, renewed.sha256);
});

test('rejects unmanaged certificate paths and duplicate TLS configuration', () => {
  assert.throws(
    () => bindManagedMailTlsIdentity(preview(), identity({ privateKeyPath: '/tmp/privkey.pem' })),
    (error) => error instanceof MailTlsIdentityTemplateError && error.code === 'invalid_mail_tls_material_path',
  );

  const first = bindManagedMailTlsIdentity(preview(), identity());
  assert.throws(
    () => bindManagedMailTlsIdentity(first, identity()),
    (error) => error instanceof MailTlsIdentityTemplateError && error.code === 'mail_tls_postfix_conflict',
  );
});
