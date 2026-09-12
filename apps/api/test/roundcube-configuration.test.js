import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailServiceIdentityRegistry } from '../src/mail-service-identity-registry.js';
import {
  createRoundcubeConfigurationService,
  RoundcubeConfigurationError,
} from '../src/roundcube-configuration.js';
import { createRoundcubeSecretRegistry } from '../src/roundcube-secret-registry.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const DOMAIN_ID = '0b83fb4d-d9d5-4a88-9975-977f015427c5';
const CERT_A = '74774ae1-e801-4d8e-a631-13e92cf13a05';
const CERT_B = '7b51a02c-c991-44f9-bde0-30a497724c18';
const NOW = Date.parse('2026-09-13T00:00:00.000Z');

function certificate(id, overrides = {}) {
  return {
    id,
    domainId: DOMAIN_ID,
    serverId: SERVER_ID,
    state: 'active',
    staging: false,
    certificateNames: ['mail.example.com'],
    validTo: '2027-01-01T00:00:00.000Z',
    fingerprint256: id === CERT_A ? 'AA:AA' : 'BB:BB',
    fullchainPath: id === CERT_A
      ? '/etc/letsencrypt/live/mail.example.com/fullchain.pem'
      : '/etc/letsencrypt/live/mail.example.com-0002/fullchain.pem',
    privateKeyPath: id === CERT_A
      ? '/etc/letsencrypt/live/mail.example.com/privkey.pem'
      : '/etc/letsencrypt/live/mail.example.com-0002/privkey.pem',
    ...overrides,
  };
}

async function fixture({ bindIdentity = true } = {}) {
  let domain = {
    id: DOMAIN_ID,
    serverId: SERVER_ID,
    primaryDomain: 'mail.example.com',
    certificateId: CERT_A,
  };
  const certificates = new Map([
    [CERT_A, certificate(CERT_A)],
    [CERT_B, certificate(CERT_B)],
  ]);
  const identity = createMailServiceIdentityRegistry({
    now: () => NOW,
    getWebDomain: async (id) => id === DOMAIN_ID ? structuredClone(domain) : null,
    getCertificate: async (id) => certificates.has(id) ? structuredClone(certificates.get(id)) : null,
  });
  await identity.init();
  if (bindIdentity) await identity.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });
  const secrets = createRoundcubeSecretRegistry({
    now: () => NOW,
    serverExists: async (id) => id === SERVER_ID,
    randomBytesFn: (() => {
      const values = [
        Buffer.from('111111111111111111111111111111111111', 'hex'),
        Buffer.from('222222222222222222222222222222222222', 'hex'),
      ];
      let index = 0;
      return () => values[index++] ?? values.at(-1);
    })(),
  });
  await secrets.init();
  const service = createRoundcubeConfigurationService({
    mailServiceIdentityRegistry: identity,
    roundcubeSecretRegistry: secrets,
  });
  return {
    identity,
    secrets,
    service,
    setCertificate(id) { domain = { ...domain, certificateId: id }; },
  };
}

test('preview is blocked until both explicit mail TLS identity and private Roundcube secret exist', async () => {
  const missingIdentity = await fixture({ bindIdentity: false });
  assert.deepEqual(await missingIdentity.service.previewForServer(SERVER_ID), {
    version: 1,
    serverId: SERVER_ID,
    readyToApply: false,
    blockers: ['mail_service_identity_required', 'roundcube_secret_required'],
    sideEffects: false,
  });

  await assert.rejects(
    missingIdentity.service.prepareForServer(SERVER_ID),
    (error) => error instanceof RoundcubeConfigurationError
      && error.code === 'roundcube_mail_identity_required',
  );

  const readyIdentity = await fixture();
  assert.deepEqual((await readyIdentity.service.previewForServer(SERVER_ID)).blockers, ['roundcube_secret_required']);
});

test('prepare creates only private secret state and returns secret-free deterministic Roundcube desired state', async () => {
  const fx = await fixture();
  const prepared = await fx.service.prepareForServer(SERVER_ID);
  assert.equal(prepared.readyToApply, true);
  assert.equal(prepared.mailHostname, 'mail.example.com');
  assert.equal(prepared.certificateId, CERT_A);
  assert.equal(prepared.mailServiceIdentityRevision, 1);
  assert.equal(prepared.roundcubeSecretRevision, 1);
  assert.equal(prepared.configuration.artifact.sensitive, true);
  assert.equal(prepared.fpm.runtimeUser, 'yunpanel-roundcube');
  assert.equal(JSON.stringify(prepared).includes('desKey'), false);
  assert.equal(JSON.stringify(prepared).includes('privkey.pem'), false);
  assert.equal(JSON.stringify(prepared).includes("smtp_pass']"), false);

  const again = await fx.service.previewForServer(SERVER_ID);
  assert.equal(again.sha256, prepared.sha256);
});

test('materialization carries protected config only after exact digest and becomes stale on cert renewal', async () => {
  const fx = await fixture();
  const prepared = await fx.service.prepareForServer(SERVER_ID);
  const bundle = await fx.service.materializeForServer(SERVER_ID, { expectedPreviewSha256: prepared.sha256 });
  assert.equal(bundle.preview.sha256, prepared.sha256);
  assert.equal(bundle.sensitiveArtifacts.length, 1);
  assert.equal(bundle.publicArtifacts.length, 1);
  assert.match(bundle.sensitiveArtifacts[0].content, /\$config\['des_key'\]/);
  assert.match(bundle.sensitiveArtifacts[0].content, /tls:\/\/mail\.example\.com:587/);
  assert.doesNotMatch(JSON.stringify(bundle.preview), /ABCDEFGHIJKLMNOPQRSTUVWX|privkey\.pem/);

  fx.setCertificate(CERT_B);
  await assert.rejects(
    fx.service.materializeForServer(SERVER_ID, { expectedPreviewSha256: prepared.sha256 }),
    (error) => error instanceof RoundcubeConfigurationError && error.code === 'roundcube_preview_stale',
  );
  const renewed = await fx.service.previewForServer(SERVER_ID);
  assert.notEqual(renewed.sha256, prepared.sha256);
  assert.equal(renewed.certificateId, CERT_B);
});

test('Roundcube secret rotation invalidates an approved preview', async () => {
  const fx = await fixture();
  const prepared = await fx.service.prepareForServer(SERVER_ID);
  await fx.secrets.rotateForServer(SERVER_ID, {
    expectedRevision: 1,
    confirmation: `rotate-roundcube-secret:${SERVER_ID}:1`,
  });
  await assert.rejects(
    fx.service.materializeForServer(SERVER_ID, { expectedPreviewSha256: prepared.sha256 }),
    (error) => error instanceof RoundcubeConfigurationError && error.code === 'roundcube_preview_stale',
  );
  const rotated = await fx.service.previewForServer(SERVER_ID);
  assert.equal(rotated.roundcubeSecretRevision, 2);
  assert.notEqual(rotated.configSha256, prepared.configSha256);
});