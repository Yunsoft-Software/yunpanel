import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createMailConfigurationService, MailConfigurationError } from '../src/mail-configuration.js';

const SERVER_ID = randomUUID();
const MAIL_DOMAIN_ID = randomUUID();
const WEB_DOMAIN_ID = randomUUID();
const MAILBOX_ID = randomUUID();
const CERTIFICATE_ID = randomUUID();
const PASSWORD_HASH = `$argon2id$v=19$m=65536,t=3,p=1$${Buffer.alloc(16, 1).toString('base64').replace(/=+$/, '')}$${Buffer.alloc(32, 2).toString('base64').replace(/=+$/, '')}`;
const SECRET = `${'S'.repeat(43)}\n`;
const SECRET_SHA256 = createHash('sha256').update(SECRET).digest('hex');

function baseDependencies() {
  return {
    mailDomainRegistry: {
      async getMailDomain(id) {
        return id === MAIL_DOMAIN_ID ? {
          id: MAIL_DOMAIN_ID,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
          revision: 3,
          webDomainId: WEB_DOMAIN_ID,
        } : null;
      },
      async listMailDomains() {
        return [{
          id: MAIL_DOMAIN_ID,
          domainName: 'example.com',
          managementMode: 'local',
          status: 'enabled',
          revision: 3,
          webDomainId: WEB_DOMAIN_ID,
        }];
      },
    },
    mailboxRegistry: {
      async listMailboxes() {
        return [{
          id: MAILBOX_ID,
          mailDomainId: MAIL_DOMAIN_ID,
          address: 'owner@example.com',
          enabled: true,
        }];
      },
      async materializeEnabledAccounts() {
        return [{ address: 'owner@example.com', passwordHash: PASSWORD_HASH }];
      },
    },
    mailAliasRegistry: { materializeEnabledAliases: async () => [] },
    mailboxQuotaRegistry: { listQuotas: async () => [] },
    mailboxForwardingRegistry: {
      async materializeEnabledForwardings() {
        return [{
          mailboxId: MAILBOX_ID,
          source: 'owner@example.com',
          mode: 'copy',
          destinations: ['external@gmail.com'],
        }];
      },
    },
    domainRegistry: {
      async getDomain(id) {
        return id === WEB_DOMAIN_ID ? { id: WEB_DOMAIN_ID, serverId: SERVER_ID } : null;
      },
    },
    mailServiceIdentityRegistry: {
      async materializeForServer(id) {
        assert.equal(id, SERVER_ID);
        return {
          serverId: SERVER_ID,
          hostname: 'mail.example.com',
          certificateId: CERTIFICATE_ID,
          certificateFingerprint256: 'AA:BB:CC',
          fullchainPath: '/etc/letsencrypt/live/mail.example.com/fullchain.pem',
          privateKeyPath: '/etc/letsencrypt/live/mail.example.com/privkey.pem',
          revision: 4,
        };
      },
    },
  };
}

function readySrsService() {
  let revision = 1;
  return {
    rotate() { revision += 1; },
    async previewForServer(id) {
      assert.equal(id, SERVER_ID);
      return {
        version: 1,
        serverId: SERVER_ID,
        srsDomain: 'mail.example.com',
        mailServiceIdentityRevision: 4,
        srsSecretRevision: revision,
        configured: true,
        ready: true,
        blockers: [],
        sideEffects: false,
      };
    },
    async materializeForServer(id) {
      assert.equal(id, SERVER_ID);
      return {
        version: 1,
        serverId: SERVER_ID,
        srsDomain: 'mail.example.com',
        mailServiceIdentityRevision: 4,
        srsSecretRevision: revision,
        secretArtifact: {
          version: 1,
          path: '/etc/postsrsd.secret',
          sha256: SECRET_SHA256,
          bytes: Buffer.byteLength(SECRET),
          sensitive: true,
          contentIncluded: false,
          mode: 0o600,
        },
        secretContent: SECRET,
      };
    },
  };
}

const transition = Object.freeze({
  mailDomainId: MAIL_DOMAIN_ID,
  expectedRevision: 3,
  status: 'enabled',
});

test('external forwarding stays blocked until SRS private state is prepared', async () => {
  let materializations = 0;
  const service = createMailConfigurationService({
    ...baseDependencies(),
    mailSrsConfigurationService: {
      async previewForServer(id) {
        assert.equal(id, SERVER_ID);
        return {
          version: 1,
          serverId: SERVER_ID,
          srsDomain: 'mail.example.com',
          mailServiceIdentityRevision: 4,
          srsSecretRevision: null,
          configured: false,
          ready: false,
          blockers: ['mail_srs_secret_required'],
          sideEffects: false,
        };
      },
      async materializeForServer() {
        materializations += 1;
        throw new Error('must not materialize unprepared SRS state');
      },
    },
  });

  const preview = await service.previewTransition(transition);
  assert.equal(preview.readyToApply, false);
  assert.deepEqual(preview.blockers, ['mail_srs_secret_required']);
  assert.equal(preview.configuration, null);
  assert.equal(materializations, 0);
});

test('prepared SRS is public only as bounded metadata and materializes its secret only inside the apply bundle', async () => {
  const srs = readySrsService();
  const service = createMailConfigurationService({ ...baseDependencies(), mailSrsConfigurationService: srs });
  const preview = await service.previewTransition(transition);

  assert.equal(preview.readyToApply, true);
  assert.equal(preview.configuration.srs.required, true);
  assert.equal(preview.configuration.srs.rewriteDomain, 'mail.example.com');
  assert.equal(preview.configuration.srs.secretRevision, 1);
  assert.equal(preview.configuration.srs.secretSha256, SECRET_SHA256);
  assert.ok(preview.configuration.requirements.includes('postsrsd_srs'));
  assert.ok(preview.configuration.artifactDigests.some((artifact) => artifact.path === '/etc/postsrsd.secret'
    && artifact.sensitive === true && artifact.sha256 === SECRET_SHA256));
  assert.doesNotMatch(JSON.stringify(preview), new RegExp('S{20,}'));

  const materialized = await service.materializeTransition(transition, {
    expectedPreviewDigest: preview.previewDigest,
    expectedConfigurationSha256: preview.configuration.sha256,
  });
  const srsSecret = materialized.sensitiveArtifacts.find((artifact) => artifact.path === '/etc/postsrsd.secret');
  assert.deepEqual(srsSecret, { path: '/etc/postsrsd.secret', content: SECRET });
  assert.equal(materialized.sensitiveArtifacts.length, 2);
});

test('SRS secret rotation makes a previously approved managed-mail preview stale', async () => {
  const srs = readySrsService();
  const service = createMailConfigurationService({ ...baseDependencies(), mailSrsConfigurationService: srs });
  const preview = await service.previewTransition(transition);
  srs.rotate();

  await assert.rejects(
    service.materializeTransition(transition, {
      expectedPreviewDigest: preview.previewDigest,
      expectedConfigurationSha256: preview.configuration.sha256,
    }),
    (error) => error instanceof MailConfigurationError && error.code === 'mail_configuration_preview_stale',
  );
});
