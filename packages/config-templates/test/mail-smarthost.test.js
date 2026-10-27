import test from 'node:test';
import assert from 'node:assert/strict';
import { MailTemplateError, normalizeSmarthost, renderSmarthost, SMARTHOST_SASL_PASSWD_PATH } from '../src/index.js';

const valid = { host: 'smtp.mailgun.org', port: 587, username: 'postmaster@mg.example.com', password: 'S3cret!pass:with:colons' };

test('STARTTLS ports require TLS and authenticate through a root-only hash map', () => {
  const rendered = renderSmarthost(valid);
  const params = Object.fromEntries(rendered.postfixParameters.map(({ name, value }) => [name, value]));
  assert.equal(params.relayhost, '[smtp.mailgun.org]:587');
  assert.equal(params.smtp_sasl_auth_enable, 'yes');
  assert.equal(params.smtp_sasl_password_maps, `hash:${SMARTHOST_SASL_PASSWD_PATH}`);
  assert.equal(params.smtp_sasl_security_options, 'noanonymous');
  assert.equal(params.smtp_tls_security_level, 'encrypt', 'a password is never sent over an unencrypted connection');
  assert.equal(params.smtp_tls_wrappermode, 'no');
  assert.equal(rendered.saslPasswd, '[smtp.mailgun.org]:587 postmaster@mg.example.com:S3cret!pass:with:colons\n');
  assert.equal(rendered.sensitive, true);
});

test('port 465 uses implicit TLS (wrapper mode)', () => {
  const params = Object.fromEntries(renderSmarthost({ ...valid, port: 465 }).postfixParameters.map(({ name, value }) => [name, value]));
  assert.equal(params.smtp_tls_wrappermode, 'yes');
  assert.equal(params.smtp_tls_security_level, 'encrypt');
});

test('the public view never contains the password', () => {
  const normalized = normalizeSmarthost(valid);
  assert.deepEqual(normalized.public, { host: 'smtp.mailgun.org', port: 587, username: 'postmaster@mg.example.com' });
  assert.equal(JSON.stringify(normalized.public).includes('S3cret'), false);
});

test('host, port, username and password are validated against injection into main.cf and sasl_passwd', () => {
  const invalid = [
    { host: 'smtp.example.com\nrelayhost=evil' }, { host: 'smtp example.com' }, { host: '[smtp.example.com]' }, { host: 'localhost' },
    { host: '-smtp.example.com' }, { host: 'a'.repeat(254) }, { port: 0 }, { port: 70000 }, { port: '587' }, { port: 25.5 },
    { username: '' }, { username: 'user name' }, { username: 'user\n' }, { username: 'u'.repeat(257) },
    { password: '' }, { password: 'with space' }, { password: 'tab\there' }, { password: 'line\nbreak' }, { password: 'p'.repeat(257) },
    { password: 'ünicode' },
  ];
  for (const change of invalid) {
    assert.throws(() => renderSmarthost({ ...valid, ...change }), MailTemplateError, JSON.stringify(change));
  }
  assert.throws(() => renderSmarthost({ ...valid, extra: true }), { code: 'invalid_smarthost' });
});
