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
  assert.equal(parameters.get('smtpd_recipient_restrictions'), 'permit_mynetworks, reject_unauth_destination');
  assert.equal(parameters.get('smtpd_helo_required'), 'yes');
  assert.equal(parameters.get('smtpd_helo_restrictions'), 'permit_mynetworks, reject_invalid_helo_hostname, permit');
  assert.equal(parameters.get('smtpd_sasl_auth_enable'), 'no');
  assert.equal(parameters.get('smtpd_tls_auth_only'), 'yes');
  assert.equal(parameters.get('smtpd_tls_security_level'), 'may');
  assert.equal(parameters.get('smtp_tls_security_level'), 'may');
  assert.equal(parameters.get('smtpd_tls_protocols'), '>=TLSv1.2');
  assert.equal(parameters.get('smtp_tls_protocols'), '>=TLSv1.2');
  assert.equal(parameters.get('anvil_rate_time_unit'), '60s');
  assert.equal(parameters.get('smtpd_client_connection_rate_limit'), '30');
  assert.equal(parameters.get('smtpd_client_message_rate_limit'), '100');
  assert.equal(parameters.get('smtpd_client_recipient_rate_limit'), '200');
  assert.equal(parameters.get('smtpd_client_connection_count_limit'), '50');
  assert.equal(parameters.get('smtpd_client_new_tls_session_rate_limit'), '30');
  assert.equal(parameters.get('smtpd_error_sleep_time'), '1s');
  assert.equal(parameters.get('smtpd_soft_error_limit'), '10');
  assert.equal(parameters.get('smtpd_hard_error_limit'), '20');
  assert.equal(parameters.get('milter_mail_macros'), 'i {mail_addr} {client_addr} {client_name} {auth_authen}');
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
  assert.equal(mailSecurityTemplatePolicy.recipientRestrictions, 'permit_mynetworks, reject_unauth_destination');
  assert.equal(mailSecurityTemplatePolicy.heloRestrictions, 'permit_mynetworks, reject_invalid_helo_hostname, permit');
  assert.equal(mailSecurityTemplatePolicy.milterMailMacros, 'i {mail_addr} {client_addr} {client_name} {auth_authen}');
  assert.equal(mailSecurityTemplatePolicy.rateLimits.anvilRateTimeUnit, '60s');
  assert.equal(mailSecurityTemplatePolicy.rateLimits.connectionRateLimit, '30');
  assert.equal(mailSecurityTemplatePolicy.rateLimits.messageRateLimit, '100');
  assert.equal(mailSecurityTemplatePolicy.rateLimits.recipientRateLimit, '200');
  assert.equal(mailSecurityTemplatePolicy.rateLimits.connectionCountLimit, '50');
  assert.equal(mailSecurityTemplatePolicy.postfixParameters.length, 21);
});
