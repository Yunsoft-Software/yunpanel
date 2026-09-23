import assert from 'node:assert/strict';
import test from 'node:test';
import * as crypto from 'node:crypto';

// Must run on the repository's Node >=24.11.1 target with installed dependencies.
// Never replace native Argon2 with a shim and report this as real auth coverage.
test('real auth store shares hosting profiles and revokes a native login session', {
  skip: typeof crypto.argon2 !== 'function' ? 'Requires target Node native Argon2; not exercised on Node22' : false,
}, async (t) => {
  const { createAuthStore } = await import('../src/auth-store.js');
  const store = createAuthStore({ filePath: ':memory:' });
  t.after(() => store.close());
  const password = 'test-only-hosting-password';
  const setup = store.issueSetupToken();
  await store.completeSetup({ setupToken: setup.token, username: 'owner', password });
  const owner = await store.login({ username: 'owner', password });
  const policy = (session) => {
    assert.equal(session?.user.role, 'owner'); return session;
  };
  const user = await store.users.create(owner.token, policy, { username: 'reseller-login', password, role: 'site_manager' });
  const prior = await store.login({ username: 'reseller-login', password });
  assert.ok(store.getSession(prior.token));
  const account = store.users.hostingAccounts.registerReseller(owner.token, policy, {
    userId: user.id, expectedUserRevision: user.revision, limits: { maxCustomers: 1, maxWebsites: 1 },
  });
  assert.equal(account.id, user.id); assert.equal(store.getSession(prior.token), null);
  assert.equal(store.getSession(owner.token).user.role, 'owner');
  assert.throws(() => store.users.update(owner.token, policy, user.id, { revision: account.userRevision, role: 'owner' }), (error) => error.code === 'hosting_account_managed');
  const next = await store.login({ username: 'reseller-login', password });
  assert.equal(next.session.user.role, 'site_manager');
  assert.deepEqual(next.session.user.websiteIds, []);
});
