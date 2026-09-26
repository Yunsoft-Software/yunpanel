import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAuthStore, hashPassword, verifyPassword, safeEqual } from '../src/auth-store.js';

const password = randomBytes(32).toString('base64url');
const secondPassword = randomBytes(32).toString('base64url');
function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-auth-'));
  const filePath = path.join(root, 'private', 'auth.sqlite');
  const store = createAuthStore({ filePath, ...options });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, filePath, root };
}
async function owner(store) {
  const { token: setupToken } = store.issueSetupToken();
  return store.completeSetup({ setupToken, username: 'Admin', password });
}
const login = (store, extra = {}) => store.login({ username: 'admin', password, ...extra });

test('Argon2id hashes use independent salts and verify without accepting malformed parameters', async () => {
  const left = await hashPassword(password);
  const right = await hashPassword(password);
  assert.notEqual(left, right);
  assert.match(left, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  assert.equal(await verifyPassword(password, left), true);
  assert.equal(await verifyPassword('wrong password', left), false);
  assert.equal(await verifyPassword(password, '$argon2id$bad'), false);
  assert.equal(await verifyPassword(password, left.replace('65536', '999999999')), false);
  assert.equal(await verifyPassword(password, `${left}$extra`), false);
});

test('password size bounds and constant-time comparison helper reject invalid types', async () => {
  await assert.rejects(hashPassword('short'), { code: 'invalid_password' });
  await assert.rejects(hashPassword('a'.repeat(1025)), { code: 'invalid_password' });
  assert.equal(await verifyPassword(null, 'not-a-hash'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'ab'), false);
  assert.equal(safeEqual(undefined, 'ab'), false);
});

test('owner setup requires a local token and consumes it permanently', async (t) => {
  const { store } = fixture(t);
  assert.equal(store.configured(), false);
  await assert.rejects(store.completeSetup({ setupToken: 'invented', username: 'admin', password }), { code: 'invalid_credentials' });
  const { token: setupToken } = store.issueSetupToken();
  const user = await store.completeSetup({ setupToken, username: ' Admin ', password });
  assert.equal(user.role, 'owner');
  assert.equal(user.username, 'admin');
  assert.equal(store.configured(), true);
  assert.throws(() => store.issueSetupToken(), { code: 'already_configured' });
  await assert.rejects(store.completeSetup({ setupToken, username: 'other', password }), { code: 'already_configured' });
});

test('expired and superseded setup tokens cannot create an owner', async (t) => {
  let now = 1000;
  const { store } = fixture(t, { now: () => now });
  const first = store.issueSetupToken();
  store.issueSetupToken();
  await assert.rejects(store.completeSetup({ setupToken: first.token, username: 'admin', password }), { code: 'invalid_credentials' });
  const current = store.issueSetupToken();
  now = current.expiresAt;
  await assert.rejects(store.completeSetup({ setupToken: current.token, username: 'admin', password }), { code: 'invalid_credentials' });
});

test('concurrent setup requests create exactly one owner', async (t) => {
  const { store } = fixture(t);
  const { token: setupToken } = store.issueSetupToken();
  const results = await Promise.allSettled([
    store.completeSetup({ setupToken, username: 'first', password }),
    store.completeSetup({ setupToken, username: 'second', password }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('invalid usernames and unknown accounts do not gain sessions', async (t) => {
  const { store } = fixture(t);
  await owner(store);
  await assert.rejects(login(store, { password: 'wrong password' }), { code: 'invalid_credentials', status: 401 });
  await assert.rejects(login(store, { username: 'unknown' }), { code: 'invalid_credentials', status: 401 });
  assert.equal(store.getSession('not-a-token'), null);
});

test('SQLite persists sessions without storing plaintext passwords or bearer tokens', async (t) => {
  const { store, filePath } = fixture(t);
  const { token: setupToken } = store.issueSetupToken();
  await store.completeSetup({ setupToken, username: 'admin', password });
  const result = await login(store);
  assert.equal(result.session.user.username, 'admin');
  const other = createAuthStore({ filePath });
  try { assert.equal(other.getSession(result.token).id, result.session.id); }
  finally { other.close(); }
  for (const name of readdirSync(path.dirname(filePath))) {
    const bytes = readFileSync(path.join(path.dirname(filePath), name));
    for (const secret of [password, setupToken, result.token]) assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(statSync(path.join(path.dirname(filePath), name)).mode & 0o077, 0);
  }
});

test('suspended hosting parent blocks child sessions and new login without disabling the child account', async (t) => {
  const notifications = [];
  const liveSessions = {
    revokeSession(sessionId, reason) { notifications.push(['session', sessionId, reason]); },
    revokeUser(userId, reason) { notifications.push(['user', userId, reason]); },
  };
  const { store, filePath } = fixture(t, { liveSessions });
  const ownerUser = await owner(store);
  const encoded = await hashPassword(password);
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA foreign_keys = ON');
  try {
    db.prepare("INSERT INTO users VALUES (?, ?, ?, 'site_manager', 1, 1000, 1000)")
      .run('reseller-login', 'reseller-login', encoded);
    db.prepare("INSERT INTO users VALUES (?, ?, ?, 'site_manager', 1, 1000, 1000)")
      .run('customer-login', 'customer-login', encoded);
    db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)')
      .run('reseller-login', 'reseller', null);
    db.prepare('INSERT INTO auth_reseller_limits VALUES (?, NULL, NULL)').run('reseller-login');
    db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)')
      .run('customer-login', 'customer', 'reseller-login');
  } finally { db.close(); }

  const first = await store.login({ username: 'customer-login', password });
  const second = await store.login({ username: 'customer-login', password });
  assert.ok(store.getSession(first.token));
  assert.ok(store.getSessionById(second.session.id));

  const suspend = new DatabaseSync(filePath);
  suspend.exec('PRAGMA foreign_keys = ON');
  try {
    suspend.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)')
      .run('reseller-login', 0, ownerUser.id, 2000);
    suspend.exec("UPDATE users SET active = 0 WHERE id = 'reseller-login'");
    assert.equal(suspend.prepare("SELECT active FROM users WHERE id = 'customer-login'").get().active, 1);
  } finally { suspend.close(); }

  assert.equal(store.getSession(first.token), null);
  assert.equal(store.getSessionById(second.session.id), null);
  assert.equal(notifications.filter((entry) => entry[2] === 'hosting_scope_inactive').length, 2);
  await assert.rejects(
    store.login({ username: 'customer-login', password }),
    { code: 'invalid_credentials', status: 401 },
  );

  const reactivate = new DatabaseSync(filePath);
  reactivate.exec('PRAGMA foreign_keys = ON');
  try {
    reactivate.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)')
      .run('reseller-login', 1, ownerUser.id, 3000);
    reactivate.exec("UPDATE users SET active = 1 WHERE id = 'reseller-login'");
  } finally { reactivate.close(); }

  const restored = await store.login({ username: 'customer-login', password });
  assert.equal(restored.session.user.username, 'customer-login');
  assert.deepEqual(restored.session.user.hosting, { kind: 'customer', resellerId: 'reseller-login' });
});

test('successful login rotates an existing browser session', async (t) => {
  const { store } = fixture(t);
  await owner(store);
  const first = await login(store);
  const second = await login(store, { previousToken: first.token });
  assert.notEqual(first.token, second.token);
  assert.equal(store.getSession(first.token), null);
  assert.ok(store.getSession(second.token));
});

test('background session checks do not reset idle timeout', async (t) => {
  let now = 0;
  const { store } = fixture(t, { now: () => now, idleMs: 1000, absoluteMs: 5000 });
  await owner(store);
  const { token } = await login(store);
  now = 900;
  assert.ok(store.getSession(token));
  now = 1000;
  assert.equal(store.getSession(token), null);
});

test('explicit activity extends idle lifetime but not absolute lifetime', async (t) => {
  let now = 0;
  const { store } = fixture(t, { now: () => now, idleMs: 1000, absoluteMs: 2000 });
  await owner(store);
  const { token } = await login(store);
  now = 900;
  assert.ok(store.getSession(token, { touch: true }));
  now = 1800;
  assert.equal(store.getSession(token, { touch: true }).idleExpiresAt, 2000);
  now = 2000;
  assert.equal(store.getSession(token), null);
});

test('individual and all-session revocation take effect immediately', async (t) => {
  const { store } = fixture(t);
  await owner(store);
  const one = await login(store);
  const two = await login(store);
  assert.equal(store.listSessions(one.token).length, 2);
  store.revokeSession(one.token, two.session.id);
  assert.equal(store.getSession(two.token), null);
  store.revokeAll(one.token);
  assert.equal(store.getSession(one.token), null);
});

test('session rotation logout-all and password changes notify live connection revocation', async (t) => {
  const notifications = [];
  const liveSessions = {
    revokeSession(sessionId, reason) { notifications.push(['session', sessionId, reason]); },
    revokeUser(userId, reason) { notifications.push(['user', userId, reason]); },
  };
  const { store } = fixture(t, { liveSessions });
  const user = await owner(store);
  const first = await login(store);
  const rotated = await login(store, { previousToken: first.token });
  assert.deepEqual(notifications.shift(), ['session', first.session.id, 'session_rotated']);

  const second = await login(store);
  store.revokeSession(rotated.token, second.session.id);
  assert.deepEqual(notifications.shift(), ['session', second.session.id, 'session_revoked']);
  store.revokeAll(rotated.token);
  assert.deepEqual(notifications.shift(), ['user', user.id, 'user_sessions_revoked']);

  const next = await login(store);
  await store.changePassword(next.token, password, secondPassword);
  assert.deepEqual(notifications.shift(), ['user', user.id, 'password_changed']);
  assert.deepEqual(notifications, []);
});

test('password changes require current credentials and revoke every session', async (t) => {
  const { store } = fixture(t);
  await owner(store);
  const one = await login(store);
  const two = await login(store);
  await assert.rejects(store.changePassword(one.token, 'wrong', secondPassword), { code: 'invalid_credentials' });
  await store.changePassword(one.token, password, secondPassword);
  assert.equal(store.getSession(one.token), null);
  assert.equal(store.getSession(two.token), null);
  await assert.rejects(login(store), { code: 'invalid_credentials' });
  assert.ok(await login(store, { password: secondPassword }));
});

test('local password recovery works across processes without restarting the API', async (t) => {
  const { store, filePath } = fixture(t);
  await owner(store);
  const old = await login(store);
  const cli = createAuthStore({ filePath });
  try { await cli.resetPassword('admin', secondPassword); } finally { cli.close(); }
  assert.equal(store.getSession(old.token), null);
  assert.ok(await login(store, { password: secondPassword }));
});

test('login throttling is durable and survives opening a new connection', async (t) => {
  const { store, filePath } = fixture(t);
  await owner(store);
  for (let i = 0; i < 10; i += 1) await assert.rejects(login(store, { password: 'wrong' }), { code: 'invalid_credentials' });
  const second = createAuthStore({ filePath });
  try { await assert.rejects(login(second), { code: 'rate_limited', status: 429 }); } finally { second.close(); }
});

test('disabled accounts invalidate existing sessions and cannot log in', async (t) => {
  const { store, filePath } = fixture(t);
  await owner(store);
  const result = await login(store);
  const admin = new DatabaseSync(filePath);
  admin.exec('UPDATE users SET active = 0');
  admin.close();
  assert.equal(store.getSession(result.token), null);
  await assert.rejects(login(store), { code: 'invalid_credentials' });
});

test('unsafe auth database directory is rejected without changing its permissions', (t) => {
  const { root } = fixture(t);
  const directory = path.join(root, 'shared');
  mkdirSync(directory, { mode: 0o755 });
  assert.throws(() => createAuthStore({ filePath: path.join(directory, 'auth.sqlite') }), /private directory/);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
});
