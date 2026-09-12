import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createMailServiceIdentityRegistry,
  MailServiceIdentityRegistryError,
  mailServiceIdentityRegistryInternals,
} from '../src/mail-service-identity-registry.js';

const SERVER_ID = '10714f5d-8646-4f9a-a8e9-b80439ff6305';
const OTHER_SERVER_ID = '822fa920-166c-4a7a-a26b-476c81d82165';
const DOMAIN_ID = '0b83fb4d-d9d5-4a88-9975-977f015427c5';
const SECOND_DOMAIN_ID = 'f4d7be56-4fbb-4b89-a92b-8cb46ef93310';
const CERT_A = '74774ae1-e801-4d8e-a631-13e92cf13a05';
const CERT_B = '7b51a02c-c991-44f9-bde0-30a497724c18';
const CERT_C = 'df97d7cf-bfa5-442b-a6bc-826ef32effca';
const NOW = Date.parse('2026-09-13T00:00:00.000Z');

function certificate(id, overrides = {}) {
  return {
    id,
    domainId: DOMAIN_ID,
    serverId: SERVER_ID,
    state: 'active',
    staging: false,
    certificateNames: ['mail.example.com'],
    validTo: '2026-12-31T00:00:00.000Z',
    fingerprint256: 'AA:BB',
    fullchainPath: `/etc/letsencrypt/live/mail.example.com/fullchain.pem`,
    privateKeyPath: `/etc/letsencrypt/live/mail.example.com/privkey.pem`,
    ...overrides,
  };
}

async function withTempDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-mail-service-identity-'));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function fixture(filePath = null) {
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
  const registry = createMailServiceIdentityRegistry({
    filePath,
    now: () => NOW,
    getWebDomain: async (id) => id === domain.id ? structuredClone(domain) : null,
    getCertificate: async (id) => certificates.has(id) ? structuredClone(certificates.get(id)) : null,
  });
  return {
    registry,
    certificates,
    get domain() { return domain; },
    setDomain(value) { domain = structuredClone(value); },
  };
}

test('persists one private mail service binding with optimistic revision and secret-free public view', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'mail-service-identity.json');
  const fx = fixture(filePath);
  const bound = await fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });

  assert.deepEqual(bound, {
    serverId: SERVER_ID,
    webDomainId: DOMAIN_ID,
    hostname: 'mail.example.com',
    certificateId: CERT_A,
    revision: 1,
    ready: true,
    blockers: [],
    createdAt: '2026-09-13T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  });
  assert.equal(JSON.stringify(bound).includes('privateKeyPath'), false);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /privkey|fullchain/);

  await assert.rejects(
    fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 }),
    (error) => error instanceof MailServiceIdentityRegistryError
      && error.code === 'mail_service_identity_revision_conflict',
  );

  const reopened = fixture(filePath);
  await reopened.registry.init();
  assert.equal((await reopened.registry.getForServer(SERVER_ID)).hostname, 'mail.example.com');
}));

test('materialization follows the current selected certificate without changing the binding revision', async () => {
  const fx = fixture();
  await fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });
  const first = await fx.registry.materializeForServer(SERVER_ID);
  assert.equal(first.certificateId, CERT_A);
  assert.equal(first.revision, 1);

  fx.setDomain({ ...fx.domain, certificateId: CERT_B });
  fx.certificates.set(CERT_B, certificate(CERT_B, {
    fingerprint256: 'CC:DD',
    fullchainPath: '/etc/letsencrypt/live/mail.example.com-0002/fullchain.pem',
    privateKeyPath: '/etc/letsencrypt/live/mail.example.com-0002/privkey.pem',
  }));
  const second = await fx.registry.materializeForServer(SERVER_ID);
  assert.equal(second.certificateId, CERT_B);
  assert.equal(second.revision, 1);
  assert.equal(second.fullchainPath, '/etc/letsencrypt/live/mail.example.com-0002/fullchain.pem');
});

test('binding fails closed for cross-server, expired or hostname-incompatible certificates', async () => {
  for (const mutate of [
    (fx) => fx.setDomain({ ...fx.domain, serverId: OTHER_SERVER_ID }),
    (fx) => fx.certificates.set(CERT_A, certificate(CERT_A, { validTo: '2026-09-12T23:59:59.000Z' })),
    (fx) => fx.certificates.set(CERT_A, certificate(CERT_A, { certificateNames: ['other.example.com'] })),
  ]) {
    const fx = fixture();
    mutate(fx);
    await assert.rejects(
      fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 }),
      (error) => error instanceof MailServiceIdentityRegistryError && error.status === 409,
    );
  }
});

test('persisted hostname drift is rejected on restart instead of silently following a Domain rename', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'mail-service-identity.json');
  const fx = fixture(filePath);
  await fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });

  const renamed = fixture(filePath);
  renamed.setDomain({ ...renamed.domain, primaryDomain: 'mail2.example.com' });
  await assert.rejects(
    renamed.registry.init(),
    (error) => error instanceof MailServiceIdentityRegistryError
      && error.code === 'mail_service_identity_state_invalid',
  );
}));

test('rebind after restart replaces hydrated immutable state instead of mutating it', async () => withTempDirectory(async (root) => {
  const filePath = path.join(root, 'mail-service-identity.json');
  const domains = new Map([
    [DOMAIN_ID, {
      id: DOMAIN_ID,
      serverId: SERVER_ID,
      primaryDomain: 'mail.example.com',
      certificateId: CERT_A,
    }],
    [SECOND_DOMAIN_ID, {
      id: SECOND_DOMAIN_ID,
      serverId: SERVER_ID,
      primaryDomain: 'smtp.example.com',
      certificateId: CERT_C,
    }],
  ]);
  const certificates = new Map([
    [CERT_A, certificate(CERT_A)],
    [CERT_C, certificate(CERT_C, {
      domainId: SECOND_DOMAIN_ID,
      certificateNames: ['smtp.example.com'],
      fingerprint256: 'EE:FF',
      fullchainPath: '/etc/letsencrypt/live/smtp.example.com/fullchain.pem',
      privateKeyPath: '/etc/letsencrypt/live/smtp.example.com/privkey.pem',
    })],
  ]);
  const open = () => createMailServiceIdentityRegistry({
    filePath,
    now: () => NOW,
    getWebDomain: async (id) => domains.has(id) ? structuredClone(domains.get(id)) : null,
    getCertificate: async (id) => certificates.has(id) ? structuredClone(certificates.get(id)) : null,
  });

  const first = open();
  await first.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });
  const reopened = open();
  await reopened.init();
  const rebound = await reopened.bind({
    serverId: SERVER_ID,
    webDomainId: SECOND_DOMAIN_ID,
    expectedRevision: 1,
  });
  assert.equal(rebound.hostname, 'smtp.example.com');
  assert.equal(rebound.webDomainId, SECOND_DOMAIN_ID);
  assert.equal(rebound.certificateId, CERT_C);
  assert.equal(rebound.revision, 2);
  assert.equal((await reopened.getForServer(SERVER_ID)).hostname, 'smtp.example.com');
}));

test('clear requires exact revision and typed confirmation', async () => {
  const fx = fixture();
  await fx.registry.bind({ serverId: SERVER_ID, webDomainId: DOMAIN_ID, expectedRevision: 0 });
  await assert.rejects(
    fx.registry.clear(SERVER_ID, { expectedRevision: 1, confirmation: 'wrong' }),
    (error) => error instanceof MailServiceIdentityRegistryError
      && error.code === 'mail_service_identity_confirmation_invalid',
  );
  assert.deepEqual(await fx.registry.clear(SERVER_ID, {
    expectedRevision: 1,
    confirmation: `clear-mail-service-identity:${SERVER_ID}:1`,
  }), { serverId: SERVER_ID, cleared: true });
  assert.equal(await fx.registry.getForServer(SERVER_ID), null);
});

test('wildcard certificate coverage is limited to one DNS label', () => {
  assert.equal(mailServiceIdentityRegistryInternals.certificateCoversHostname({
    certificateNames: ['*.example.com'],
  }, 'mail.example.com'), true);
  assert.equal(mailServiceIdentityRegistryInternals.certificateCoversHostname({
    certificateNames: ['*.example.com'],
  }, 'deep.mail.example.com'), false);
});