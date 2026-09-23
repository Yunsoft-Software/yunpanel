import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { createUserAdminStore } from '../src/user-admin-store.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';

const code = (expected) => (error) => error.code === expected;
function setup(t, options = {}) {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());
  f.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-a', 'reseller-b', 'customer-a', 'customer-b', 'customer-c', 'direct', 'legacy']) f.addUser(id);
  f.addUser('viewer', { role: 'read_only' });
  f.token = f.session('owner');
  const dependencies = { ...f, ...options };
  f.store = createHostingAccountStore(dependencies);
  f.reseller = (id = 'reseller-a', limits = { maxCustomers: 2, maxWebsites: 3 }) => f.store.registerReseller(f.token, f.requireManagement, { userId: id, expectedUserRevision: 1, limits });
  f.customer = (id = 'customer-a', resellerId = 'reseller-a') => f.store.registerCustomer(f.token, f.requireManagement, { userId: id, expectedUserRevision: 1, resellerId });
  f.get = (id = 'reseller-a') => f.store.get(f.token, f.requireManagement, id);
  return f;
}

test('existing user store mounts the same-DB hosting store without exposing a new login role', async (t) => {
  const f = setup(t);
  const users = createUserAdminStore({ ...f, hashPassword: async () => 'fixture-hash', normalizeUsername: (name) => name });
  assert.ok(users.hostingAccounts);
  const list = users.list(f.token, f.requireManagement);
  assert.equal(list.users.length, 9);
  const login = await users.create(f.token, f.requireManagement, { username: 'new-login', password: 'fixture-only', role: 'site_manager' });
  users.hostingAccounts.registerReseller(f.token, f.requireManagement, { userId: login.id, expectedUserRevision: login.revision, limits: { maxCustomers: 1, maxWebsites: 1 } });
  assert.equal(users.list(f.token, f.requireManagement).users.find((user) => user.id === login.id).role, 'site_manager');
});
for (const change of [{ role: 'owner' }, { active: false }, { websiteIds: ['other-site'] }]) {
  test(`legacy users PATCH cannot bypass hosting lifecycle: ${JSON.stringify(change)}`, (t) => {
    const f = setup(t); const users = createUserAdminStore({ ...f, hashPassword: async () => '', normalizeUsername: (name) => name });
    f.reseller(); const token = f.session('reseller-a');
    assert.throws(() => users.update(f.token, f.requireManagement, 'reseller-a', { revision: 2, ...change }), code('hosting_account_managed'));
    assert.ok(f.getSession(token)); assert.equal(users.revision('reseller-a'), 2);
  });
}
test('legacy delete is blocked, but normal password/name edits and unrelated accounts still work', (t) => {
  const f = setup(t); const users = createUserAdminStore({ ...f, hashPassword: async () => '', normalizeUsername: (name) => name });
  f.reseller();
  assert.throws(() => users.remove(f.token, f.requireManagement, 'reseller-a', { revision: 2 }), code('hosting_account_managed'));
  const changed = users.update(f.token, f.requireManagement, 'reseller-a', { revision: 2, username: 'renamed', passwordHash: 'rotated-fixture' });
  assert.equal(changed.revision, 3); assert.equal(f.get().username, 'renamed');
  users.update(f.token, f.requireManagement, 'legacy', { revision: 1, role: 'read_only' });
  assert.equal(users.list(f.token, f.requireManagement).users.find((user) => user.id === 'legacy').role, 'read_only');
});
