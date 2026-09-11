import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthStore } from '../src/auth-store.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';

// Requires the supported Node 24.11.1+ runtime with native Argon2 and OTPAuth.
// Loopback development policy here deliberately isolates password/store integration.
// HTTPS Owner-MFA enforcement is covered separately by user-admin-http.test.js.
const password = 'native-integration-fixture-password';
async function fixture(t) {
  const revoked = [];
  const store = createAuthStore({
    filePath: ':memory:',
    masterKey: null,
    liveSessions: {
      revokeSession() {},
      revokeUser(userId, reason) { revoked.push([userId, reason]); },
    },
  });
  t.after(() => store.close());
  const setup = store.issueSetupToken();
  const owner = await store.completeSetup({ setupToken: setup.token, username: 'owner', password });
  const login = await store.login({ username: 'owner', password });
  const policy = createOwnerMfaPolicy({ store, required: false }).requireManagement;
  return { store, owner, token: login.token, policy, revoked };
}

test('native additional-account password login and session revocation', async (t) => {
  const { store, token, policy, revoked } = await fixture(t);
  const user = await store.users.create(token, policy, { username: 'second', password, role: 'owner' });
  const login = await store.login({ username: 'second', password });
  assert.equal(login.session.user.id, user.id);
  store.users.update(token, policy, user.id, { revision: 1, active: false });
  assert.deepEqual(revoked, [[user.id, 'user_changed']]);
  assert.equal(store.getSession(login.token), null);
  await assert.rejects(store.login({ username: 'second', password }), { code: 'invalid_credentials' });
});

test('user revision prevents an in-flight native login from surviving a rename', async (t) => {
  const { store, token, policy } = await fixture(t);
  const user = await store.users.create(token, policy, { username: 'second', password });
  // login captures its row/revision synchronously, then awaits Argon2 work.
  const pending = store.login({ username: 'second', password });
  store.users.update(token, policy, user.id, { revision: 1, username: 'renamed' });
  await assert.rejects(pending, { code: 'invalid_credentials' });
  const fresh = await store.login({ username: 'renamed', password });
  assert.equal(fresh.session.user.id, user.id);
});

test('native setup accounts retain last-Owner protection and reuse username validation', async (t) => {
  const { store, token, policy, owner } = await fixture(t);
  assert.throws(() => store.users.remove(token, policy, owner.id, { revision: 1 }), { code: 'last_owner' });
  await assert.rejects(store.users.create(token, policy, { username: 'bad/name', password }), { code: 'invalid_username' });
  await assert.rejects(store.users.create(token, policy, { username: 'second', password: 'too-short' }), { code: 'invalid_password' });
  assert.equal(store.users.list(token, policy).total, 1);
});
