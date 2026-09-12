import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mailSecurityTemplatePolicy,
  mailTemplatePolicy,
  previewManagedMailEmptyConfiguration,
  previewManagedMailSecurityConfiguration,
  secureManagedMailPreview,
} from '../src/index.js';

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$AQEBAQEBAQEBAQEBAQEBAQ$AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';

function parameterMap(preview) {
  return new Map(preview.postfixParameters.map((entry) => [entry.name, entry.value]));
}

function assertSecurityPolicy(preview) {
  const parameters = parameterMap(preview);
  assert.equal(parameters.get('mynetworks'), '127.0.0.0/8 [::1]/128');
  assert.equal(parameters.get('smtpd_relay_restrictions'), 'permit_mynetworks, reject_unauth_destination');
  assert.equal(parameters.get('smtpd_sasl_auth_enable'), 'no');
  assert.equal(parameters.get('smtpd_tls_auth_only'), 'yes');
  assert.equal(parameters.get('smtpd_tls_security_level'), 'may');
  assert.equal(parameters.get('smtp_tls_security_level'), 'may');
  assert.equal(parameters.get('smtpd_tls_protocols'), '>=TLSv1.2');
  assert.equal(parameters.get('smtp_tls_protocols'), '>=TLSv1.2');
  assert.deepEqual(
    preview.postfixParameters.map((entry) => entry.name),
    [...preview.postfixParameters.map((entry) => entry.name)].sort(),
  );

  const dovecot = preview.artifacts.find((artifact) => artifact.path === mailTemplatePolicy.dovecotMailConfigPath);
  assert.ok(dovecot);
  assert.match(dovecot.content, /^ssl = required\nssl_min_protocol = TLSv1\.2\n\n/);
  assert.equal((dovecot.content.match(/^ssl\s*=/gm) ?? []).length, 1);
  assert.equal((dovecot.content.match(/^ssl_min_protocol\s*=/gm) ?? []).length, 1);
}

test('active managed mail preview carries deterministic TLS and fail-closed relay policy', () => {
  const preview = previewManagedMailSecurityConfiguration({
    domains: ['example.com'],
    mailboxes: ['owner@example.com'],
    aliases: [],
    accounts: [{ address: 'owner@example.com', passwordHash: PASSWORD_HASH, quotaBytes: null }],
    postmasterAddress: 'owner@example.com',
    forwardings: [],
  });
  assertSecurityPolicy(preview);
  assert.equal(preview.readyToApply, false);
  assert.equal(preview.sideEffects, false);
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
});

test('empty managed-set teardown retains the same TLS and relay policy without adding artifacts', () => {
  const base = previewManagedMailEmptyConfiguration();
  const preview = secureManagedMailPreview(base);
  assert.equal(preview.artifacts.length, base.artifacts.length);
  assertSecurityPolicy(preview);
  assert.notEqual(preview.sha256, base.sha256);
});

test('security policy constants remain bounded and explicit', () => {
  assert.equal(mailSecurityTemplatePolicy.tlsMinProtocol, 'TLSv1.2');
  assert.equal(mailSecurityTemplatePolicy.loopbackNetworks, '127.0.0.0/8 [::1]/128');
  assert.equal(mailSecurityTemplatePolicy.relayRestrictions, 'permit_mynetworks, reject_unauth_destination');
  assert.equal(mailSecurityTemplatePolicy.postfixParameters.length, 8);
});
