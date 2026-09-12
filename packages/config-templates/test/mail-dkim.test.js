import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MailDkimTemplateError,
  mailDkimTemplatePolicy,
  managedDkimDnsRecord,
  previewRspamdDkimSigningConfig,
  renderRspamdDkimSigningConfig,
} from '../src/index.js';

const PUBLIC_A = Buffer.alloc(294, 1).toString('base64');
const PUBLIC_B = Buffer.alloc(294, 2).toString('base64');

test('renders deterministic exact-domain Rspamd DKIM signing config and DNS records', () => {
  const policies = [
    { domain: 'sub.example.com', selector: 'mail-2026', publicKey: PUBLIC_B },
    { domain: 'EXAMPLE.COM.', selector: 'yunpanel', publicKey: PUBLIC_A },
  ];
  const config = renderRspamdDkimSigningConfig(policies);
  const preview = previewRspamdDkimSigningConfig(policies);

  assert.match(config, /^enabled = true;$/m);
  assert.match(config, /^sign_authenticated = true;$/m);
  assert.match(config, /^sign_local = true;$/m);
  assert.match(config, /^sign_inbound = false;$/m);
  assert.match(config, /^use_domain = "header";$/m);
  assert.match(config, /^use_esld = false;$/m);
  assert.match(config, /^try_fallback = false;$/m);
  assert.match(config, /^check_pubkey = true;$/m);
  assert.match(config, /^allow_pubkey_mismatch = false;$/m);
  assert.ok(config.indexOf('example.com {') < config.indexOf('sub.example.com {'));
  assert.match(config, /path = "\/etc\/yunpanel\/mail\/dkim\/example\.com\.yunpanel\.key";/);
  assert.match(config, /path = "\/etc\/yunpanel\/mail\/dkim\/sub\.example\.com\.mail-2026\.key";/);
  assert.equal(preview.artifact.path, '/etc/rspamd/local.d/dkim_signing.conf');
  assert.equal(preview.artifact.content, config);
  assert.equal(preview.artifact.sensitive, false);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(preview.validate, { file: '/usr/bin/rspamadm', args: ['configtest'] });
  assert.deepEqual(preview.dnsRecords, [
    { type: 'TXT', name: 'yunpanel._domainkey.example.com', value: `v=DKIM1; k=rsa; p=${PUBLIC_A}` },
    { type: 'TXT', name: 'mail-2026._domainkey.sub.example.com', value: `v=DKIM1; k=rsa; p=${PUBLIC_B}` },
  ]);
  assert.equal(previewRspamdDkimSigningConfig(policies).sha256, preview.sha256);
});

test('builds a canonical DKIM DNS record without private material', () => {
  const record = managedDkimDnsRecord({
    domain: 'Example.COM.',
    selector: 'mail',
    publicKey: PUBLIC_A,
  });
  assert.deepEqual(record, {
    type: 'TXT',
    name: 'mail._domainkey.example.com',
    value: `v=DKIM1; k=rsa; p=${PUBLIC_A}`,
  });
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE KEY|\/etc\/yunpanel\/mail\/dkim/);
});

test('rejects duplicate domains, unsafe selectors and noncanonical public keys', () => {
  assert.throws(
    () => renderRspamdDkimSigningConfig([
      { domain: 'example.com', selector: 'mail', publicKey: PUBLIC_A },
      { domain: 'EXAMPLE.COM.', selector: 'second', publicKey: PUBLIC_B },
    ]),
    (error) => error instanceof MailDkimTemplateError && error.code === 'duplicate_dkim_domain',
  );
  assert.throws(
    () => renderRspamdDkimSigningConfig([{ domain: 'example.com', selector: '../mail', publicKey: PUBLIC_A }]),
    (error) => error instanceof MailDkimTemplateError && error.code === 'invalid_dkim_selector',
  );
  assert.throws(
    () => renderRspamdDkimSigningConfig([{ domain: 'example.com', selector: 'mail', publicKey: PUBLIC_A.replace(/=$/, '') }]),
    (error) => error instanceof MailDkimTemplateError && error.code === 'invalid_dkim_public_key',
  );
  assert.equal(mailDkimTemplatePolicy.keyPath('example.com', 'mail'), '/etc/yunpanel/mail/dkim/example.com.mail.key');
});
