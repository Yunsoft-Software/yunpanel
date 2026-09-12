import assert from 'node:assert/strict';
import test from 'node:test';
import { mailTemplatePolicy } from '@yunpanel/config-templates';
import { createMailConfigurationService } from '../src/mail-configuration.js';

const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$AQEBAQEBAQEBAQEBAQEBAQ$AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI';
const mailDomain = Object.freeze({
  id: 'mail-domain-1',
  domainName: 'example.com',
  managementMode: 'local',
  status: 'enabled',
  revision: 4,
});
const mailbox = Object.freeze({
  id: 'mailbox-1',
  mailDomainId: mailDomain.id,
  address: 'owner@example.com',
  enabled: true,
});

function service() {
  return createMailConfigurationService({
    mailDomainRegistry: {
      async getMailDomain(id) { return id === mailDomain.id ? mailDomain : null; },
      async listMailDomains() { return [mailDomain]; },
    },
    mailboxRegistry: {
      async listMailboxes() { return [mailbox]; },
      async materializeEnabledAccounts() {
        return [{ address: mailbox.address, passwordHash: PASSWORD_HASH }];
      },
    },
    mailAliasRegistry: {
      async materializeEnabledAliases() { return []; },
    },
    mailboxQuotaRegistry: {
      async listQuotas() { return []; },
    },
    mailboxForwardingRegistry: {
      async materializeEnabledForwardings() { return []; },
    },
  });
}

test('enabled to enabled reapply binds TLS and relay security policy into desired configuration SHA', async () => {
  const configuration = service();
  const preview = await configuration.previewTransition({
    mailDomainId: mailDomain.id,
    expectedRevision: mailDomain.revision,
    status: 'enabled',
  });
  assert.equal(preview.readyToApply, true);
  assert.match(preview.configuration.sha256, /^[a-f0-9]{64}$/);
  const parameters = new Map(preview.configuration.postfixParameters.map((entry) => [entry.name, entry.value]));
  assert.equal(parameters.get('mynetworks'), '127.0.0.0/8 [::1]/128');
  assert.equal(parameters.get('smtpd_relay_restrictions'), 'permit_mynetworks, reject_unauth_destination');
  assert.equal(parameters.get('smtpd_sasl_auth_enable'), 'no');
  assert.equal(parameters.get('smtpd_tls_security_level'), 'may');
  assert.equal(parameters.get('smtp_tls_security_level'), 'may');

  const materialized = await configuration.materializeTransition({
    mailDomainId: mailDomain.id,
    expectedRevision: mailDomain.revision,
    status: 'enabled',
  }, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configuration.sha256,
  });
  const dovecot = materialized.preview.artifacts.find(
    (artifact) => artifact.path === mailTemplatePolicy.dovecotMailConfigPath,
  );
  assert.ok(dovecot);
  assert.match(dovecot.content, /^ssl = required\nssl_min_protocol = TLSv1\.2\n\n/);
  assert.equal(materialized.preview.sha256, preview.configuration.sha256);
});
