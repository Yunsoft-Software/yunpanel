import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { apiKeyActor, createApiKeyActorAuthorizer } from '../src/api-key-actor.js';
import { createApiKeyStore } from '../src/api-key-store.js';
import { createAuthStore } from '../src/auth-store.js';
import { createTenantSiteStore } from '../src/tenant-site-store.js';

// Real auth store, key store and tenant records: host jobs and removal re-check the
// actor at execution time, so a key acts only while it and its Owner are live and
// only on a tenant site inside its own scope.
async function fixture(t) {
  const authStore = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => authStore.close());
  const password = randomBytes(24).toString('base64url');
  await authStore.completeSetup({ setupToken: authStore.issueSetupToken().token, username: 'owner', password });
  const ownerId = authStore.getSession((await authStore.login({ username: 'owner', password })).token).user.id;
  const apiKeyStore = createApiKeyStore();
  const tenantSiteStore = createTenantSiteStore();
  const { key } = await apiKeyStore.create({ name: 'Provisioner', parentDomain: 'st.example.test', portMin: 32000, portMax: 32999, createdBy: ownerId });
  const websiteId = randomUUID();
  await tenantSiteStore.put({ hostname: 'acme.st.example.test', parentDomain: 'st.example.test', websiteId });
  const authorize = createApiKeyActorAuthorizer({ apiKeyStore, tenantSiteStore, getAutomationUser: (id) => authStore.getAutomationUser(id),
    ownerMfaRequired: false, mfaEnabled: () => true });
  return { authorize, apiKeyStore, key, websiteId, ownerId };
}

test('a live key acts as its Owner on its own tenant site', async (t) => {
  const f = await fixture(t);
  const actor = apiKeyActor(f.key);
  assert.deepEqual(await f.authorize(actor, f.websiteId), actor);
  assert.equal(actor.role, 'owner');
  assert.equal(actor.userId, f.ownerId);
});

test('other sites, forged actors, revoked keys and sessions are refused', async (t) => {
  const f = await fixture(t);
  const actor = apiKeyActor(f.key);
  assert.equal(await f.authorize(actor, randomUUID()), null, 'not a tenant site of this key');
  assert.equal(await f.authorize(actor, null), null);
  assert.equal(await f.authorize({ ...actor, userId: randomUUID() }, f.websiteId), null);
  assert.equal(await f.authorize({ ...actor, sessionId: randomUUID() }, f.websiteId), null);
  await f.apiKeyStore.revoke(f.key.id);
  assert.equal(await f.authorize(actor, f.websiteId), null);
});
