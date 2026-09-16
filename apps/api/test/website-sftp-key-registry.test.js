import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWebsiteSftpKeyRegistry,
  WebsiteSftpKeyRegistryError,
  websiteSftpKeyRegistryInternals,
} from '../src/website-sftp-key-registry.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const unixUser = 'yunapp-4dc352e64a14';

function sshString(value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  return Buffer.concat([length, payload]);
}

function ed25519Key(byte, comment = 'developer@example.test') {
  const blob = Buffer.concat([
    sshString('ssh-ed25519'),
    sshString(Buffer.alloc(32, byte)),
  ]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function website(overrides = {}) {
  return {
    id: websiteId,
    serverId: '28dc1532-a2cb-4f29-9e0d-05f793652fa3',
    applicationId,
    runtimeType: 'node',
    unixUser,
    ...overrides,
  };
}

function registry({ currentWebsite = website(), filePath = null, now = () => Date.parse('2026-09-16T20:00:00.000Z') } = {}) {
  const state = { currentWebsite };
  return {
    state,
    value: createWebsiteSftpKeyRegistry({
      filePath,
      now,
      getWebsite: async (id) => id === websiteId ? state.currentWebsite : null,
    }),
  };
}

test('SFTP key registry stores only public-key material and exposes a secret-safe browser projection', async () => {
  const { value } = registry();
  const created = await value.addKey({ websiteId, label: 'Laptop', publicKey: ed25519Key(1) });

  assert.equal(created.websiteId, websiteId);
  assert.equal(created.label, 'Laptop');
  assert.equal(created.keyType, 'ssh-ed25519');
  assert.match(created.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(created.status, 'active');
  assert.equal(created.revision, 1);
  assert.equal('publicKey' in created, false);
  assert.equal('keyData' in created, false);
  assert.equal('applicationId' in created, false);
  assert.equal('unixUser' in created, false);

  const material = await value.listActiveMaterial(websiteId);
  assert.equal(material.length, 1);
  assert.equal(material[0].applicationId, applicationId);
  assert.equal(material[0].unixUser, unixUser);
  assert.match(material[0].publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+$/);
  assert.equal(material[0].publicKey.includes('developer@example.test'), false);
});

test('private keys, authorized_keys options and malformed key blobs are rejected', async () => {
  const { value } = registry();

  await assert.rejects(
    value.addKey({
      websiteId,
      label: 'Private',
      publicKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
    }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_private_key_rejected',
  );
  await assert.rejects(
    value.addKey({ websiteId, label: 'Options', publicKey: `from="10.0.0.1" ${ed25519Key(2)}` }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_public_key_type_unsupported',
  );
  await assert.rejects(
    value.addKey({ websiteId, label: 'Malformed', publicKey: 'ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && ['sftp_public_key_invalid', 'sftp_public_key_type_mismatch'].includes(error.code),
  );
});

test('duplicate public-key fingerprints fail closed for the same Website', async () => {
  const { value } = registry();
  await value.addKey({ websiteId, label: 'Laptop', publicKey: ed25519Key(3) });

  await assert.rejects(
    value.addKey({ websiteId, label: 'Same key', publicKey: ed25519Key(3, 'other-comment') }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_key_duplicate'
      && error.status === 409,
  );
});

test('revoke is revision-guarded, idempotent at the current revision and removes active material', async () => {
  let clock = Date.parse('2026-09-16T20:00:00.000Z');
  const { value } = registry({ now: () => clock });
  const created = await value.addKey({ websiteId, label: 'Laptop', publicKey: ed25519Key(4) });

  await assert.rejects(
    value.revokeKey({ websiteId, keyId: created.id, expectedRevision: 2 }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_key_revision_conflict',
  );

  clock += 1_000;
  const revoked = await value.revokeKey({ websiteId, keyId: created.id, expectedRevision: 1 });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revision, 2);
  assert.equal(revoked.revokedAt, '2026-09-16T20:00:01.000Z');
  assert.deepEqual(await value.listActiveMaterial(websiteId), []);

  const retried = await value.revokeKey({ websiteId, keyId: created.id, expectedRevision: 2 });
  assert.deepEqual(retried, revoked);
});

test('rotation atomically revokes the old key and creates a different active credential', async () => {
  let clock = Date.parse('2026-09-16T20:00:00.000Z');
  const { value } = registry({ now: () => clock });
  const first = await value.addKey({ websiteId, label: 'Old laptop', publicKey: ed25519Key(5) });

  await assert.rejects(
    value.rotateKey({
      websiteId,
      keyId: first.id,
      expectedRevision: 1,
      label: 'No change',
      publicKey: ed25519Key(5),
    }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_key_rotation_no_change',
  );

  clock += 2_000;
  const rotated = await value.rotateKey({
    websiteId,
    keyId: first.id,
    expectedRevision: 1,
    label: 'New laptop',
    publicKey: ed25519Key(6),
  });
  assert.equal(rotated.revoked.id, first.id);
  assert.equal(rotated.revoked.status, 'revoked');
  assert.equal(rotated.revoked.revision, 2);
  assert.equal(rotated.created.status, 'active');
  assert.equal(rotated.created.revision, 1);
  assert.notEqual(rotated.created.id, first.id);
  assert.notEqual(rotated.created.fingerprint, first.fingerprint);

  const listed = await value.listKeys({ websiteId });
  assert.equal(listed.length, 2);
  assert.equal(listed.filter((entry) => entry.status === 'active').length, 1);
  const material = await value.listActiveMaterial(websiteId);
  assert.deepEqual(material.map((entry) => entry.id), [rotated.created.id]);
});

test('active key material fails closed if the Website Application or Unix identity drifts', async () => {
  const fixture = registry();
  await fixture.value.addKey({ websiteId, label: 'Laptop', publicKey: ed25519Key(7) });
  fixture.state.currentWebsite = website({
    applicationId: '41318df2-d6c5-44ea-ae80-22612eb95433',
    unixUser: 'yunapp-0123456789ab',
  });

  await assert.rejects(
    fixture.value.listActiveMaterial(websiteId),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_key_website_drift'
      && error.status === 409,
  );
});

test('registry persists with restrictive mode and restart preserves fingerprint and revocation state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'yunpanel-sftp-keys-'));
  const filePath = path.join(root, 'keys.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  let clock = Date.parse('2026-09-16T20:00:00.000Z');
  const first = registry({ filePath, now: () => clock });
  await first.value.init();
  const created = await first.value.addKey({ websiteId, label: 'Laptop', publicKey: ed25519Key(8) });
  clock += 1_000;
  await first.value.revokeKey({ websiteId, keyId: created.id, expectedRevision: 1 });

  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const raw = await readFile(filePath, 'utf8');
  assert.equal(raw.includes('PRIVATE KEY'), false);
  assert.equal(raw.includes(created.fingerprint), true);

  const reopened = registry({ filePath, now: () => clock });
  await reopened.value.init();
  const listed = await reopened.value.listKeys({ websiteId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fingerprint, created.fingerprint);
  assert.equal(listed[0].status, 'revoked');
  assert.equal(listed[0].revision, 2);
});

test('only hosted Websites with managed Unix identity can own SFTP keys', async () => {
  const { value } = registry({ currentWebsite: website({ runtimeType: 'proxy', applicationId: null, unixUser: null }) });
  await assert.rejects(
    value.addKey({ websiteId, label: 'Proxy', publicKey: ed25519Key(9) }),
    (error) => error instanceof WebsiteSftpKeyRegistryError
      && error.code === 'sftp_key_website_unsupported'
      && error.status === 409,
  );
});

test('parser exposes only the supported key algorithms', () => {
  assert.deepEqual(
    websiteSftpKeyRegistryInternals.keyTypes,
    ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'],
  );
});
