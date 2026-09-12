import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  createMailSrsConfigurationService,
  MailSrsConfigurationError,
} from '../src/mail-srs-configuration.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const SECRET = 'A'.repeat(43);

function fixture({ identityReady = true, secretConfigured = false } = {}) {
  let configured = secretConfigured;
  let revision = secretConfigured ? 1 : null;
  const calls = [];
  const identity = identityReady ? {
    serverId: SERVER_ID,
    hostname: 'mail.example.com',
    revision: 4,
    ready: true,
    blockers: [],
  } : {
    serverId: SERVER_ID,
    hostname: 'mail.example.com',
    revision: 4,
    ready: false,
    blockers: ['mail_service_certificate_not_ready'],
  };
  const mailServiceIdentityRegistry = {
    async getForServer(id) {
      calls.push(['identity.get', id]);
      return identity;
    },
    async materializeForServer(id) {
      calls.push(['identity.materialize', id]);
      if (!identityReady) throw Object.assign(new Error('not ready'), { status: 409 });
      return {
        serverId: id,
        hostname: identity.hostname,
        revision: identity.revision,
      };
    },
  };
  const mailSrsSecretRegistry = {
    async getForServer(id) {
      calls.push(['secret.get', id]);
      return configured ? { serverId: id, revision, configured: true } : null;
    },
    async ensureForServer(id) {
      calls.push(['secret.ensure', id]);
      configured = true;
      revision = revision ?? 1;
      return { serverId: id, revision, configured: true };
    },
    async materializeForServer(id) {
      calls.push(['secret.materialize', id]);
      if (!configured) throw Object.assign(new Error('missing'), { status: 409 });
      return { serverId: id, revision, secret: SECRET };
    },
    async rotateForServer(id, options) {
      calls.push(['secret.rotate', id, options]);
      revision += 1;
      return { serverId: id, revision, configured: true };
    },
  };
  return {
    calls,
    service: createMailSrsConfigurationService({ mailServiceIdentityRegistry, mailSrsSecretRegistry }),
  };
}

test('SRS preview is side-effect free and blocked until the private secret exists', async () => {
  const fx = fixture();
  const preview = await fx.service.previewForServer(SERVER_ID);
  assert.deepEqual(preview, {
    version: 1,
    serverId: SERVER_ID,
    srsDomain: 'mail.example.com',
    mailServiceIdentityRevision: 4,
    srsSecretRevision: null,
    configured: false,
    ready: false,
    blockers: ['mail_srs_secret_required'],
    sideEffects: false,
  });
  assert.equal(fx.calls.some(([name]) => name === 'secret.ensure'), false);
});

test('explicit SRS prepare creates private state only after the mail TLS identity is ready', async () => {
  const fx = fixture();
  const prepared = await fx.service.prepareForServer(SERVER_ID);
  assert.equal(prepared.ready, true);
  assert.equal(prepared.srsDomain, 'mail.example.com');
  assert.equal(prepared.srsSecretRevision, 1);
  assert.ok(fx.calls.some(([name]) => name === 'secret.ensure'));

  const blocked = fixture({ identityReady: false });
  await assert.rejects(
    blocked.service.prepareForServer(SERVER_ID),
    (error) => error instanceof MailSrsConfigurationError && error.code === 'mail_srs_identity_not_ready',
  );
  assert.equal(blocked.calls.some(([name]) => name === 'secret.ensure'), false);
});

test('SRS materialization returns exact protected artifact metadata without changing public preview shape', async () => {
  const fx = fixture({ secretConfigured: true });
  const materialized = await fx.service.materializeForServer(SERVER_ID);
  const content = `${SECRET}\n`;
  assert.equal(materialized.srsDomain, 'mail.example.com');
  assert.equal(materialized.srsSecretRevision, 1);
  assert.equal(materialized.secretContent, content);
  assert.deepEqual(materialized.secretArtifact, {
    version: 1,
    path: '/etc/postsrsd.secret',
    sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content),
    sensitive: true,
    contentIncluded: false,
    mode: 0o600,
  });
  assert.doesNotMatch(JSON.stringify(await fx.service.previewForServer(SERVER_ID)), new RegExp(SECRET));
});

test('SRS secret rotation requires ready state and changes only the safe public revision', async () => {
  const fx = fixture({ secretConfigured: true });
  const rotated = await fx.service.rotateForServer(SERVER_ID, {
    expectedRevision: 1,
    confirmation: `rotate-mail-srs-secret:${SERVER_ID}:1`,
  });
  assert.equal(rotated.ready, true);
  assert.equal(rotated.srsSecretRevision, 2);
  assert.equal(JSON.stringify(rotated).includes(SECRET), false);
});
