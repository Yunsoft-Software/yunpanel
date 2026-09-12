import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMailConfigurationService, MailConfigurationError } from '../src/mail-configuration.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const WEB_DOMAIN_ID = '0b83fb4d-d9d5-4a88-9975-977f015427c5';
const MAIL_DOMAIN_ID = '74774ae1-e801-4d8e-a631-13e92cf13a05';
const HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 4).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 5).toString('base64').replace(/=+$/, '')}`;

function identity(overrides = {}) {
  return {
    serverId: SERVER_ID,
    webDomainId: WEB_DOMAIN_ID,
    hostname: 'mail.example.com',
    certificateId: '7b51a02c-c991-44f9-bde0-30a497724c18',
    certificateFingerprint256: 'AA:BB:CC',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
    revision: 1,
    ...overrides,
  };
}

function fixture({ identityProvider = null } = {}) {
  const mailDomain = {
    id: MAIL_DOMAIN_ID,
    domainName: 'example.com',
    managementMode: 'local',
    webDomainId: WEB_DOMAIN_ID,
    status: 'enabled',
    revision: 1,
  };
  let currentIdentity = identityProvider ?? identity();
  const service = createMailConfigurationService({
    mailDomainRegistry: {
      getMailDomain: async (id) => id === MAIL_DOMAIN_ID ? mailDomain : null,
      listMailDomains: async () => [mailDomain],
    },
    mailboxRegistry: {
      listMailboxes: async () => [{
        id: 'mailbox-1', mailDomainId: MAIL_DOMAIN_ID, address: 'owner@example.com', enabled: true,
      }],
      materializeEnabledAccounts: async () => [{ address: 'owner@example.com', passwordHash: HASH }],
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
    domainRegistry: {
      getDomain: async (id) => id === WEB_DOMAIN_ID
        ? { id, serverId: SERVER_ID, primaryDomain: 'example.com' }
        : null,
    },
    mailServiceIdentityRegistry: {
      materializeForServer: async (serverId) => {
        if (currentIdentity instanceof Error) throw currentIdentity;
        assert.equal(serverId, SERVER_ID);
        return structuredClone(currentIdentity);
      },
    },
  });
  return {
    service,
    setIdentity(value) { currentIdentity = value; },
  };
}

function transition() {
  return { mailDomainId: MAIL_DOMAIN_ID, expectedRevision: 1, status: 'enabled' };
}

test('public config preview exposes TLS identity but never certificate material paths', async () => {
  const fx = fixture();
  const preview = await fx.service.previewTransition(transition());
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.configuration.tlsIdentity, {
    hostname: 'mail.example.com',
    certificateId: identity().certificateId,
    certificateFingerprint256: 'AA:BB:CC',
    revision: 1,
  });

  const keyParameter = preview.configuration.postfixParameters.find((parameter) => parameter.name === 'smtpd_tls_key_file');
  const certParameter = preview.configuration.postfixParameters.find((parameter) => parameter.name === 'smtpd_tls_cert_file');
  assert.deepEqual(keyParameter, {
    name: 'smtpd_tls_key_file',
    protected: true,
    valueSha256: createHash('sha256').update(identity().privateKeyPath).digest('hex'),
  });
  assert.equal(certParameter.protected, true);
  assert.doesNotMatch(JSON.stringify(preview), /privkey\.pem|fullchain\.pem|\/etc\/letsencrypt/);

  const bundle = await fx.service.materializeTransition(transition(), {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configurationSha256,
  });
  const parameters = new Map(bundle.preview.postfixParameters.map((parameter) => [parameter.name, parameter.value]));
  assert.equal(parameters.get('smtpd_tls_key_file'), identity().privateKeyPath);
  assert.equal(parameters.get('smtpd_tls_cert_file'), identity().fullchainPath);
  const dovecot = bundle.preview.artifacts.find((artifact) => artifact.path === '/etc/dovecot/conf.d/99-yunpanel-mail.conf');
  assert.match(dovecot.content, /ssl_key = <\/etc\/letsencrypt\/live\/mail\.example\.com\/privkey\.pem/);
});

test('missing TLS identity becomes an authored readiness blocker instead of falling back to arbitrary host TLS', async () => {
  const error = Object.assign(new Error('missing'), {
    code: 'mail_service_identity_required',
    status: 409,
  });
  const fx = fixture({ identityProvider: error });
  const preview = await fx.service.previewTransition(transition());
  assert.equal(preview.readyToApply, false);
  assert.deepEqual(preview.blockers, ['mail_service_identity_required']);
  assert.equal(preview.configuration, null);
});

test('certificate renewal changes configuration identity and makes the old preview stale', async () => {
  const fx = fixture();
  const first = await fx.service.previewTransition(transition());
  fx.setIdentity(identity({
    certificateId: 'cd6fa71e-82aa-42cf-b296-bb925515ae38',
    certificateFingerprint256: 'DD:EE:FF',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com-0002/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com-0002/privkey.pem',
  }));
  const second = await fx.service.previewTransition(transition());
  assert.notEqual(second.configurationSha256, first.configurationSha256);
  assert.notEqual(second.previewDigest, first.previewDigest);

  await assert.rejects(
    fx.service.materializeTransition(transition(), {
      expectedPreviewDigest: first.previewDigest,
      expectedConfigurationSha256: first.configurationSha256,
    }),
    (error) => error instanceof MailConfigurationError && error.code === 'mail_configuration_preview_stale',
  );
});

test('last-domain disable remains available even when TLS identity state is missing', async () => {
  const error = Object.assign(new Error('missing'), {
    code: 'mail_service_identity_required',
    status: 409,
  });
  const fx = fixture({ identityProvider: error });
  const preview = await fx.service.previewTransition({
    mailDomainId: MAIL_DOMAIN_ID,
    expectedRevision: 1,
    status: 'disabled',
  });
  assert.equal(preview.readyToApply, true);
  assert.deepEqual(preview.domains, []);
});
