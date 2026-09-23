import assert from 'node:assert/strict';
import test from 'node:test';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { initializeHostingAccountSchema, rollbackEmptyHostingAccountSchema } from '../src/hosting-account-schema.js';
import { rollbackEmptyHostingSiteAllocationSchema } from '../src/hosting-site-allocation-schema.js';

const code = (expected) => (error) => error.code === expected;
function fixture(t) {
  const f = hostingAuthFixture(); t.after(() => f.db.close());
  f.addUser('owner', { role: 'owner' }); f.session('owner');
  return f;
}
test('allocation schema is additive and repeatable without changing legacy records', (t) => {
  const f = fixture(t);
  const users = f.db.prepare('SELECT * FROM users').all();
  const sessions = f.db.prepare('SELECT * FROM sessions').all();
  assert.deepEqual(initializeHostingAccountSchema(f), { version: 1, created: true });
  assert.deepEqual(initializeHostingAccountSchema(f), { version: 1, created: false });
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), users);
  assert.deepEqual(f.db.prepare('SELECT * FROM sessions').all(), sessions);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 0);
});
test('old v1 hosting schema upgrades without rebuilding users or accounts', (t) => {
  const f = fixture(t); initializeHostingAccountSchema(f);
  f.transaction(() => rollbackEmptyHostingSiteAllocationSchema(f.db));
  f.addUser('direct');
  f.db.exec("INSERT INTO auth_hosting_accounts VALUES ('direct', 'customer', NULL, 1, 1000, 1000)");
  const prior = f.db.prepare('SELECT * FROM auth_hosting_accounts').all();
  initializeHostingAccountSchema(f);
  assert.deepEqual(f.db.prepare('SELECT * FROM auth_hosting_accounts').all(), prior);
  assert.equal(f.db.prepare('SELECT version FROM auth_hosting_site_schema').get().version, 1);
});
test('empty rollback removes allocation objects before parent tables and can be repeated', (t) => {
  const f = fixture(t); initializeHostingAccountSchema(f);
  assert.equal(rollbackEmptyHostingAccountSchema(f).removed, true);
  assert.equal(rollbackEmptyHostingAccountSchema(f).removed, false);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'auth_hosting_site_%'").get().n, 0);
  assert.equal(initializeHostingAccountSchema(f).created, true);
});
for (const change of ['UPDATE auth_hosting_site_schema SET version = 999', 'DROP TRIGGER auth_hosting_site_identity']) {
  test(`unknown/partial allocation schema fails closed: ${change}`, (t) => {
    const f = fixture(t); initializeHostingAccountSchema(f); f.db.exec(change);
    assert.throws(() => initializeHostingAccountSchema(f), code('hosting_site_schema_invalid'));
    assert.throws(() => rollbackEmptyHostingAccountSchema(f), code('hosting_site_schema_invalid'));
    assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'auth_hosting_accounts'").get());
  });
}
test('profile and operation foreign keys block destructive rollback/delete', (t) => {
  const f = fixture(t); initializeHostingAccountSchema(f); f.addUser('direct');
  f.db.exec("INSERT INTO auth_hosting_accounts VALUES ('direct', 'customer', NULL, 1, 1000, 1000)");
  f.db.exec("INSERT INTO auth_hosting_site_allocations VALUES ('op', 'site', 'direct', 'server', 'digest', 'website-digest', 'reserved', 1000, NULL)");
  assert.throws(() => rollbackEmptyHostingAccountSchema(f), code('hosting_schema_in_use'));
  assert.throws(() => f.transaction(() => rollbackEmptyHostingSiteAllocationSchema(f.db)), code('hosting_schema_in_use'));
  assert.throws(() => f.db.exec("DELETE FROM auth_hosting_accounts WHERE user_id = 'direct'"), /FOREIGN KEY/);
  assert.throws(() => f.db.exec("UPDATE auth_hosting_site_allocations SET customer_id = 'other'"), /hosting_site_identity_immutable/);
  assert.throws(() => f.db.exec("UPDATE auth_hosting_site_allocations SET state = 'attached', attached_at = 1001"), /hosting_site_transition_invalid/);
});
