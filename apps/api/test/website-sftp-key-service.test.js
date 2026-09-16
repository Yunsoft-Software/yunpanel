import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWebsiteSftpKeyService,
  WebsiteSftpKeyServiceError,
} from '../src/website-sftp-key-service.js';

const websiteId = 'f73cc6ac-07e8-4d22-b29a-741154687d20';
const applicationId = '6dcb8908-3f3e-43da-9452-15fd6b51ac76';
const keyId = '9ae512c0-a717-4611-943c-6ce2ab0abf16';
const unixUser = 'yunapp-4dc352e64a14';
const publicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const fingerprint = 'SHA256:examplefingerprint';

function websiteRegistry(overrides = {}) {
  return {
    getWebsite: async (id) => ({
      id,
      serverId: '28dc1532-a2cb-4f29-9e0d-05f793652fa3',
      runtimeType: 'node',
      applicationId,
      unixUser,
      ...overrides,
    }),
  };
}

function publicKeyRecord(overrides = {}) {
  return {
    id: keyId,
    websiteId,
    label: 'Laptop',
    keyType: 'ssh-ed25519',
    fingerprint,
    status: 'active',
    revision: 1,
    createdAt: '2026-09-16T20:00:00.000Z',
    updatedAt: '2026-09-16T20:00:00.000Z',
    revokedAt: null,
    ...overrides,
  };
}

function material(overrides = {}) {
  return {
    id: keyId,
    websiteId,
    applicationId,
    unixUser,
    label: 'Laptop',
    keyType: 'ssh-ed25519',
    publicKey,
    fingerprint,
    revision: 1,
    ...overrides,
  };
}

function keyRegistry(overrides = {}) {
  const state = { keys: [publicKeyRecord()], material: [material()] };
  return {
    state,
    value: {
      addKey: async () => publicKeyRecord(),
      listKeys: async () => state.keys,
      revokeKey: async () => publicKeyRecord({ status: 'revoked', revision: 2, revokedAt: '2026-09-16T20:01:00.000Z' }),
      rotateKey: async () => ({
        revoked: publicKeyRecord({ status: 'revoked', revision: 2, revokedAt: '2026-09-16T20:01:00.000Z' }),
        created: publicKeyRecord({ id: '47bc6cf1-75bc-4cba-a610-aa0cd0522c80', fingerprint: 'SHA256:new' }),
      }),
      listActiveMaterial: async () => state.material,
      ...overrides,
    },
  };
}

function manager(overrides = {}) {
  return {
    inspect: async (intent) => ({
      satisfied: true,
      adapter: 'openssh-authorized-keys',
      keyCount: intent.keys.length,
      sha256: 'a'.repeat(64),
    }),
    apply: async (intent) => ({
      satisfied: true,
      adapter: 'openssh-authorized-keys',
      keyCount: intent.keys.length,
      sha256: 'b'.repeat(64),
    }),
    ...overrides,
  };
}

test('list exposes secret-safe key metadata plus current materialization status', async () => {
  const keys = keyRegistry();
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry(),
    authorizedKeyManager: manager(),
  });

  const result = await service.list(websiteId);
  assert.equal(result.websiteId, websiteId);
  assert.equal(result.keys.length, 1);
  assert.equal('publicKey' in result.keys[0], false);
  assert.equal(result.materialization.satisfied, true);
  assert.equal(result.materialization.keyCount, 1);
  assert.equal(JSON.stringify(result).includes(publicKey), false);
});

test('add persists the credential before reconciling the exact active key set to the host', async () => {
  const calls = [];
  const keys = keyRegistry({
    addKey: async (input) => {
      calls.push(['add', input]);
      return publicKeyRecord();
    },
    listActiveMaterial: async () => {
      calls.push(['material']);
      return [material()];
    },
  });
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry(),
    authorizedKeyManager: manager({
      apply: async (intent) => {
        calls.push(['apply', intent]);
        return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 1, sha256: 'c'.repeat(64) };
      },
    }),
  });

  const result = await service.add({ websiteId, label: 'Laptop', publicKey });
  assert.equal(result.key.fingerprint, fingerprint);
  assert.equal(result.materialization.satisfied, true);
  assert.equal('publicKey' in result.key, false);
  assert.deepEqual(calls.map((entry) => entry[0]), ['add', 'material', 'apply']);
  assert.deepEqual(calls[2][1], {
    websiteId,
    applicationId,
    unixUser,
    keys: [{ id: keyId, publicKey, fingerprint, revision: 1 }],
  });
});

test('host failure after a durable mutation is reported as reconcile-required instead of false success', async () => {
  let persisted = false;
  const keys = keyRegistry({
    addKey: async () => {
      persisted = true;
      return publicKeyRecord();
    },
  });
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry(),
    authorizedKeyManager: manager({
      apply: async () => {
        const error = new Error('disk unavailable');
        error.code = 'sftp_authorized_keys_write_failed';
        throw error;
      },
    }),
  });

  await assert.rejects(
    service.add({ websiteId, label: 'Laptop', publicKey }),
    (error) => error instanceof WebsiteSftpKeyServiceError
      && error.code === 'sftp_key_reconcile_required'
      && error.status === 503,
  );
  assert.equal(persisted, true);
});

test('reconcile with zero active keys still uses the current Website identity to materialize a deny-all key file', async () => {
  const keys = keyRegistry({ listActiveMaterial: async () => [] });
  let applied = null;
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry(),
    authorizedKeyManager: manager({
      apply: async (intent) => {
        applied = intent;
        return { satisfied: true, adapter: 'openssh-authorized-keys', keyCount: 0, sha256: 'd'.repeat(64) };
      },
    }),
  });

  const result = await service.reconcile(websiteId);
  assert.equal(result.satisfied, true);
  assert.equal(result.keyCount, 0);
  assert.deepEqual(applied, { websiteId, applicationId, unixUser, keys: [] });
});

test('inspect converts host drift into operator-visible materialization status without exposing host details', async () => {
  const keys = keyRegistry();
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry(),
    authorizedKeyManager: manager({
      inspect: async () => {
        const error = new Error('root ownership drifted');
        error.code = 'sftp_authorized_keys_root_drift';
        throw error;
      },
    }),
  });

  assert.deepEqual(await service.inspectMaterialization(websiteId), {
    satisfied: false,
    reason: 'sftp_authorized_keys_root_drift',
  });
});

test('proxy Websites are rejected before registry or host mutations', async () => {
  let mutations = 0;
  const keys = keyRegistry({ addKey: async () => { mutations += 1; return publicKeyRecord(); } });
  const service = createWebsiteSftpKeyService({
    keyRegistry: keys.value,
    websiteRegistry: websiteRegistry({ runtimeType: 'proxy', applicationId: null, unixUser: null }),
    authorizedKeyManager: manager({ apply: async () => { mutations += 1; return {}; } }),
  });

  await assert.rejects(
    service.add({ websiteId, label: 'Proxy', publicKey }),
    (error) => error instanceof WebsiteSftpKeyServiceError
      && error.code === 'sftp_key_website_unsupported'
      && error.status === 409,
  );
  assert.equal(mutations, 0);
});
