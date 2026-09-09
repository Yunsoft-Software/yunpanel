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
