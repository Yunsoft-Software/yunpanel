import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserAdminStore } from '../src/user-admin-store.js';
import { AuthError } from '../src/auth-error.js';
import { fixture } from './helpers/user-admin-fixture.js';

const code = (expected) => (error) => error.code === expected;
const newUser = { username: 'second', password: 'test-only-password' };

test('lists bounded public account fields without credentials', (t) => {
  const f = fixture(t); f.seed('reader', 'read_only');
  const page = f.store.list(f.token, f.policy, { limit: 1 });
  assert.equal(page.total, 2); assert.equal(page.users.length, 1);
  assert.deepEqual(Object.keys(page.users[0]).sort(), ['id', 'username', 'role', 'active', 'createdAt', 'updatedAt', 'revision', 'mfaEnabled'].sort());
  for (const limit of [0, 101, '1', Infinity]) assert.throws(() => f.store.list(f.token, f.policy, { limit }), code('invalid_pagination'));
});

test('creates normalized accounts and persists no credentials in audit', async (t) => {
  const f = fixture(t);
  const user = await f.store.create(f.token, f.policy, { ...newUser, username: ' SECOND ' });
  assert.equal(user.username, 'second'); assert.equal(user.role, 'owner'); assert.equal(user.revision, 1); assert.equal(user.mfaEnabled, false);
  const events = f.db.prepare('SELECT * FROM auth_user_admin_events').all();
  assert.equal(events[0].target_id, user.id); assert.equal(events[0].actor_id, 'owner');
  assert.equal(JSON.stringify(events).includes(newUser.password), false);
});

test('anonymous, read-only and unenrolled users cannot list or create', async (t) => {
  const f = fixture(t); f.seed('reader', 'read_only');
  for (const [token, expected] of [['bad', 'unauthorized'], ['session-reader', 'forbidden']]) {
    assert.throws(() => f.store.list(token, f.policy), code(expected));
    await assert.rejects(f.store.create(token, f.policy, newUser), code(expected));
  }
  f.db.exec("DELETE FROM auth_mfa WHERE user_id = 'owner'");
  assert.throws(() => f.store.list(f.token, f.policy), code('mfa_enrollment_required'));
  assert.throws(() => f.store.list(f.token, undefined), /management policy/);
});

test('rejects unrecognized fields, roles and nonboolean active values', async (t) => {
  const f = fixture(t);
  for (const input of [{ ...newUser, password_hash: 'bad' }, { ...newUser, role: 'admin' }, { ...newUser, active: 'false' }, []]) {
    await assert.rejects(f.store.create(f.token, f.policy, input), AuthError);
  }
  assert.equal(f.store.list(f.token, f.policy).total, 1);
});

for (const [name, mutation, expected] of [
  ['logout', (db) => db.exec("DELETE FROM sessions WHERE user_id = 'owner'"), 'unauthorized'],
  ['demotion', (db) => db.exec("UPDATE users SET role = 'read_only' WHERE id = 'owner'"), 'forbidden'],
  ['deactivation', (db) => db.exec("UPDATE users SET active = 0 WHERE id = 'owner'"), 'unauthorized'],
  ['MFA removal', (db) => db.exec("DELETE FROM auth_mfa WHERE user_id = 'owner'"), 'mfa_enrollment_required'],
]) {
  test(`creation rechecks ${name} after asynchronous password work`, async (t) => {
    let finish;
    const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
    const creation = f.store.create(f.token, f.policy, newUser);
    mutation(f.db); finish('test-only-new-hash');
    await assert.rejects(creation, code(expected));
    assert.equal(f.db.prepare("SELECT 1 FROM users WHERE username = 'second'").get(), undefined);
  });
}

test('username race is rejected inside transaction after hashing', async (t) => {
  let finish;
  const f = fixture(t, () => new Promise((resolve) => { finish = resolve; }));
  const creation = f.store.create(f.token, f.policy, newUser);
  f.seed('second'); finish('test-only-new-hash');
  await assert.rejects(creation, code('username_taken'));
});

test('last active Owner cannot be deleted, demoted or deactivated', (t) => {
  const f = fixture(t); f.seed('disabled-owner', 'owner', 0);
  for (const input of [{ revision: 1, role: 'read_only' }, { revision: 1, active: false }]) {
    assert.throws(() => f.store.update(f.token, f.policy, 'owner', input), code('last_owner'));
  }
  assert.throws(() => f.store.remove(f.token, f.policy, 'owner', { revision: 1 }), code('last_owner'));
  assert.equal(f.store.revision('owner'), 1);
});

test('a second Owner may be demoted but remaining Owner is protected', (t) => {
  const f = fixture(t); f.seed('second');
  f.store.update(f.token, f.policy, 'second', { revision: 1, role: 'read_only' });
  assert.throws(() => f.store.remove(f.token, f.policy, 'owner', { revision: 1 }), code('last_owner'));
});

test('edit increments revision, invalidates sessions/challenges but preserves enrolled MFA', (t) => {
  const f = fixture(t); f.seed('second');
  f.db.exec("INSERT INTO auth_mfa_pending VALUES ('second', 'session-second'); INSERT INTO auth_mfa_challenges VALUES ('challenge-second', 'second')");
  const user = f.store.update(f.token, f.policy, 'second', { revision: 1, username: 'renamed' });
  assert.equal(user.revision, 2); assert.equal(user.mfaEnabled, true);
  for (const table of ['sessions', 'auth_mfa_pending', 'auth_mfa_challenges']) {
    assert.equal(f.db.prepare(`SELECT 1 FROM ${table} WHERE user_id = 'second'`).get(), undefined);
  }
  assert.throws(() => f.store.update(f.token, f.policy, 'second', { revision: 1, active: false }), code('user_revision_conflict'));
  assert.throws(() => f.store.remove(f.token, f.policy, 'second', { revision: 1 }), code('user_revision_conflict'));
});

test('no-op edit keeps revision and session; unknown user and missing revision fail', (t) => {
  const f = fixture(t);
  assert.equal(f.store.update(f.token, f.policy, 'owner', { revision: 1, active: true }).revision, 1);
  assert.equal(f.store.list(f.token, f.policy).total, 1);
  assert.throws(() => f.store.update(f.token, f.policy, 'owner', { active: true }), code('invalid_revision'));
  assert.throws(() => f.store.remove(f.token, f.policy, 'missing', { revision: 1 }), code('user_not_found'));
});

test('delete removes only target sessions/MFA/revisions and retains safe audit', (t) => {
  const f = fixture(t); f.seed('second');
  f.db.exec("INSERT INTO auth_mfa_recovery VALUES ('second', 'test-only-digest'); INSERT INTO auth_mfa_challenges VALUES ('c2', 'second')");
  f.store.update(f.token, f.policy, 'second', { revision: 1, active: false });
  f.store.remove(f.token, f.policy, 'second', { revision: 2 });
  assert.equal(f.store.revision('second'), null);
  for (const table of ['sessions', 'auth_mfa', 'auth_mfa_recovery', 'auth_mfa_challenges', 'auth_user_revisions']) {
    assert.equal(f.db.prepare(`SELECT 1 FROM ${table} WHERE user_id = 'second'`).get(), undefined);
  }
  assert.equal(f.store.list(f.token, f.policy).total, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM auth_user_admin_events WHERE target_id = 'second'").get().n, 2);
});

test('audit failure rolls back account edits and revocation atomically', (t) => {
  const f = fixture(t); f.seed('second');
  const store = createUserAdminStore({ ...f.options, audit() { throw new Error('audit unavailable'); } });
  assert.throws(() => store.update(f.token, f.policy, 'second', { revision: 1, active: false }), /audit unavailable/);
  assert.equal(store.revision('second'), 1);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'second'").get().active, 1);
  assert.ok(f.db.prepare("SELECT 1 FROM sessions WHERE user_id = 'second'").get());
});

test('sidecar migration is repeatable and refuses unknown versions', (t) => {
  const f = fixture(t);
  assert.equal(createUserAdminStore(f.options).revision('owner'), 1);
  f.db.exec('UPDATE auth_user_admin_schema SET version = 9');
  assert.throws(() => createUserAdminStore(f.options), /Unsupported user administration schema/);
  assert.equal(f.db.prepare('SELECT version FROM auth_user_admin_schema').get().version, 9);
});
