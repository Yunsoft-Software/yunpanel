import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeHostingAccountSchema as initialize, rollbackEmptyHostingAccountSchema as rollback } from '../src/hosting-account-schema.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';

function setup(t) {
  const fixture = hostingAuthFixture();
  t.after(() => fixture.db.close());
  fixture.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-a', 'customer-a', 'customer-b', 'legacy']) fixture.addUser(id);
  fixture.addUser('viewer', { role: 'read_only' });
  return fixture;
}
function profile(db, id, kind = 'reseller', parent = null) {
  return db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)').run(id, kind, parent);
}
const snapshot = (db) => ['users', 'sessions', 'auth_user_websites', 'auth_user_revisions', 'auth_mfa', 'auth_mfa_recovery']
  .map((table) => db.prepare(`SELECT * FROM ${table}`).all());
const code = (expected) => (error) => error.code === expected;

test('additive install is idempotent and does not mutate existing auth data/version', (t) => {
  const f = setup(t);
  f.db.exec("PRAGMA user_version = 2; INSERT INTO auth_user_websites VALUES ('legacy', 'website-old'); INSERT INTO auth_mfa VALUES ('owner', 'fixture-secret');");
  f.session('owner');
  const before = snapshot(f.db);
  assert.deepEqual(initialize(f), { version: 2, created: true });
  assert.deepEqual(initialize(f), { version: 2, created: false });
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 2);
});
test('a failing installation rolls back every schema object', (t) => {
  const f = setup(t);
  assert.throws(() => initialize({ ...f, transaction: (op) => f.transaction(() => { op(); throw new Error('injected'); }) }), /injected/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'auth_hosting_schema'").get().n, 0);
  assert.equal(initialize(f).created, true);
});
test('foreign keys must be enabled before migration', (t) => {
  const f = setup(t);
  f.db.exec('PRAGMA foreign_keys = OFF');
  assert.throws(() => initialize(f), code('hosting_schema_invalid'));
});
test('initialization requires the existing auth tables, not a second login store', (t) => {
  const f = setup(t);
  f.db.exec('DROP TABLE auth_user_websites');
  assert.throws(() => initialize(f), code('hosting_schema_invalid'));
});
test('unknown future version is not downgraded', (t) => {
  const f = setup(t); initialize(f);
  f.db.exec('UPDATE auth_hosting_schema SET version = 3');
  assert.throws(() => initialize(f), code('hosting_schema_invalid'));
  assert.throws(() => rollback(f), code('hosting_schema_invalid'));
  assert.equal(f.db.prepare('SELECT version FROM auth_hosting_schema').get().version, 3);
});
test('populated v1 schema migrates to v2 without rewriting account identity or auth data', (t) => {
  const f = setup(t);
  initialize(f);
  profile(f.db, 'reseller-a');
  f.db.exec(`
    DROP TRIGGER auth_hosting_lifecycle_intent_consume;
    DROP TRIGGER auth_hosting_legacy_user_guard;
    DROP TRIGGER auth_hosting_lifecycle_intent_immutable;
    DROP TRIGGER auth_hosting_lifecycle_intent_insert;
    DROP TABLE auth_hosting_lifecycle_intents;
    CREATE TRIGGER auth_hosting_legacy_user_guard BEFORE UPDATE OF role, active ON users
      WHEN (NEW.role IS NOT OLD.role OR NEW.active IS NOT OLD.active)
        AND EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
        SELECT RAISE(ABORT, 'hosting_account_lifecycle_not_enabled');
      END;
    UPDATE auth_hosting_schema SET version = 1;
  `);
  const before = f.db.prepare("SELECT * FROM auth_hosting_accounts WHERE user_id = 'reseller-a'").get();
  assert.deepEqual(initialize(f), { version: 2, created: false });
  assert.deepEqual(f.db.prepare("SELECT * FROM auth_hosting_accounts WHERE user_id = 'reseller-a'").get(), before);
  assert.equal(f.db.prepare('SELECT version FROM auth_hosting_schema').get().version, 2);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_hosting_lifecycle_intents'").get());
});

test('hosting active lifecycle requires a one-shot live Owner intent and never permits role mutation', (t) => {
  const f = setup(t); initialize(f); profile(f.db, 'reseller-a');
  assert.throws(() => f.db.exec("UPDATE users SET active = 0 WHERE id = 'reseller-a'"), /lifecycle_not_enabled/);
  assert.throws(() => f.db.exec("UPDATE users SET role = 'owner' WHERE id = 'reseller-a'"), /lifecycle_not_enabled/);

  f.db.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)').run('reseller-a', 0, 'owner', 1000);
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'reseller-a'");
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'reseller-a'").get().active, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM auth_hosting_lifecycle_intents").get().n, 0);

  assert.throws(() => f.db.exec("UPDATE users SET active = 1 WHERE id = 'reseller-a'"), /lifecycle_not_enabled/);
  f.db.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)').run('reseller-a', 1, 'owner', 1001);
  f.db.exec("UPDATE users SET active = 1 WHERE id = 'reseller-a'");
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'reseller-a'").get().active, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM auth_hosting_lifecycle_intents").get().n, 0);
});

test('lifecycle intent requires a live Owner actor and cannot be rewritten in place', (t) => {
  const f = setup(t); initialize(f); profile(f.db, 'reseller-a');
  assert.throws(
    () => f.db.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)').run('reseller-a', 0, 'viewer', 1000),
    /hosting_lifecycle_owner_required/,
  );
  f.db.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)').run('reseller-a', 0, 'owner', 1000);
  assert.throws(() => f.db.exec("UPDATE auth_hosting_lifecycle_intents SET target_active = 1 WHERE user_id = 'reseller-a'"), /intent_immutable/);
});

test('missing trigger is detected instead of silently repairing an incomplete schema', (t) => {
  const f = setup(t); initialize(f);
  f.db.exec('DROP TRIGGER auth_hosting_identity_immutable');
  assert.throws(() => initialize(f), code('hosting_schema_invalid'));
});
test('partial schema without a version marker is rejected', (t) => {
  const f = setup(t);
  f.db.exec('CREATE TABLE auth_hosting_accounts (user_id TEXT)');
  assert.throws(() => initialize(f), code('hosting_schema_invalid'));
});
for (const id of ['owner', 'viewer', 'missing']) {
  test(`${id} cannot silently become a reseller profile`, (t) => {
    const f = setup(t); initialize(f);
    assert.throws(() => profile(f.db, id), /hosting_profile_requires_site_manager/);
  });
}
test('existing Website memberships require a separate explicit migration', (t) => {
  const f = setup(t); initialize(f);
  f.db.exec("INSERT INTO auth_user_websites VALUES ('legacy', 'website-old')");
  assert.throws(() => profile(f.db, 'legacy'), /explicit_site_migration/);
  assert.equal(f.db.prepare('SELECT website_id FROM auth_user_websites').get().website_id, 'website-old');
});
test('direct customers and one-level reseller customers are stored without duplicate logins', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'reseller-a');
  profile(f.db, 'customer-a', 'customer', 'reseller-a');
  profile(f.db, 'customer-b', 'customer');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM users').get().n, 6);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_accounts').get().n, 3);
});
test('customer parents, missing parents, sub-resellers and self-parenting are rejected', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'customer-a', 'customer');
  assert.throws(() => profile(f.db, 'customer-b', 'customer', 'customer-a'), /parent_must_be_reseller/);
  assert.throws(() => profile(f.db, 'customer-b', 'customer', 'missing'), /parent_must_be_reseller/);
  profile(f.db, 'reseller-a');
  assert.throws(() => profile(f.db, 'customer-b', 'reseller', 'reseller-a'), /CHECK constraint/);
  assert.throws(() => profile(f.db, 'customer-b', 'customer', 'customer-b'));
});
test('ownership and profile kind cannot be reassigned by direct SQL', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'reseller-a'); profile(f.db, 'customer-a', 'customer', 'reseller-a');
  for (const assignment of ["reseller_id = NULL", "kind = 'reseller'", "user_id = 'customer-b'"]) {
    assert.throws(() => f.db.exec(`UPDATE auth_hosting_accounts SET ${assignment} WHERE user_id = 'customer-a'`), /transfer_not_enabled/);
  }
});
test('child accounts prevent silent parent deletion', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'reseller-a'); profile(f.db, 'customer-a', 'customer', 'reseller-a');
  assert.throws(() => f.db.exec("DELETE FROM auth_hosting_accounts WHERE user_id = 'reseller-a'"), /FOREIGN KEY/);
  assert.throws(() => f.db.exec("DELETE FROM users WHERE id = 'customer-a'"), /FOREIGN KEY/);
});
test('limits require a reseller and valid nonnegative safe counts', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'reseller-a'); profile(f.db, 'customer-a', 'customer');
  const insert = (id, value) => f.db.prepare('INSERT INTO auth_reseller_limits VALUES (?, ?, NULL)').run(id, value);
  assert.throws(() => insert('customer-a', 1), /limits_require_reseller/);
  for (const value of [-1, 1.5, 9007199254740992, 'unknown']) assert.throws(() => insert('reseller-a', value), /CHECK/);
  insert('reseller-a', null);
  assert.throws(() => f.db.exec("UPDATE auth_reseller_limits SET reseller_id = 'customer-a'"), /identity_immutable/);
});
test('Website ownership requires a customer; transfers and duplicate identity fail', (t) => {
  const f = setup(t); initialize(f);
  profile(f.db, 'reseller-a'); profile(f.db, 'customer-a', 'customer');
  assert.throws(() => f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'reseller-a', 1000)"), /requires_customer/);
  f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'customer-a', 1000)");
  assert.throws(() => f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'customer-a', 1000)"), /UNIQUE/);
  assert.throws(() => f.db.exec("UPDATE auth_customer_websites SET customer_id = 'reseller-a'"), /transfer_not_enabled/);
  assert.throws(() => f.db.exec("DELETE FROM auth_hosting_accounts WHERE user_id = 'customer-a'"), /FOREIGN KEY/);
});
test('legacy role, activation and Website grants cannot bypass staged rollout', (t) => {
  const f = setup(t); initialize(f); profile(f.db, 'reseller-a');
  assert.throws(() => f.db.exec("UPDATE users SET role = 'owner' WHERE id = 'reseller-a'"), /lifecycle_not_enabled/);
  assert.throws(() => f.db.exec("UPDATE users SET active = 0 WHERE id = 'reseller-a'"), /lifecycle_not_enabled/);
  assert.throws(() => f.db.exec("INSERT INTO auth_user_websites VALUES ('reseller-a', 'site-a')"), /grants_not_enabled/);
  f.db.exec("INSERT INTO auth_user_websites VALUES ('legacy', 'site-a')");
  assert.throws(() => f.db.exec("UPDATE auth_user_websites SET user_id = 'reseller-a' WHERE user_id = 'legacy'"), /grants_not_enabled/);
  f.db.exec("UPDATE users SET username = 'changed', password_hash = 'rotated' WHERE id = 'reseller-a'");
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'legacy'");
});
test('empty rollback preserves all existing auth rows and can be installed again', (t) => {
  const f = setup(t); f.session('owner'); const before = snapshot(f.db);
  initialize(f);
  assert.deepEqual(rollback(f), { removed: true });
  assert.deepEqual(rollback(f), { removed: false });
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(initialize(f).created, true);
});
test('populated rollback is refused without losing account data', (t) => {
  const f = setup(t); initialize(f); profile(f.db, 'reseller-a');
  assert.throws(() => rollback(f), code('hosting_schema_in_use'));
  assert.equal(f.db.prepare('SELECT user_id FROM auth_hosting_accounts').get().user_id, 'reseller-a');
});
test('schema and profile relationships survive closing and reopening a real SQLite file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'yunpanel-hosting-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'auth.sqlite');
  let f = hostingAuthFixture(path);
  f.addUser('reseller-a'); initialize(f); profile(f.db, 'reseller-a'); f.db.close();
  f = hostingAuthFixture(path);
  try {
    assert.equal(initialize(f).created, false);
    assert.equal(f.db.prepare('SELECT kind FROM auth_hosting_accounts').get().kind, 'reseller');
  } finally { f.db.close(); }
});
