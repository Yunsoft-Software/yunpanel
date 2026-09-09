import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TOTP } from 'otpauth';
import { createAuthStore } from '../src/auth-store.js';
import { createAuthenticatedApi } from '../src/auth-http.js';

const origin = 'https://panel.example.test';
const password = randomBytes(32).toString('base64url');
async function fixture(t) {
  const clock = { value: 1_700_000_010_000 };
  const store = createAuthStore({ filePath: ':memory:', now: () => clock.value, masterKey: randomBytes(32) });
  t.after(() => store.close());
  await store.completeSetup({ setupToken: store.issueSetupToken().token, username: 'owner', password });
  const listener = createAuthenticatedApi({ store, publicOrigin: origin, createHandler: () => (_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"data":[]}'); } });
  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const request = (url, { method = 'GET', body, cookie, csrf, headers = {} } = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, {
    method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const login = () => request('auth/login', { method: 'POST', body: { username: 'owner', password } });
  return { store, request, login, clock };
}
const cookieValue = (response, name = '__Host-yunpanel_session') => response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`)).split(';')[0];
async function enable(f) {
  const login = await f.login(); const session = (await login.json()).data;
  const firstCookie = cookieValue(login);
  const enrollment = await f.request('auth/mfa/enroll', { method: 'POST', cookie: firstCookie, csrf: session.csrfToken, body: { password } });
  assert.equal(enrollment.status, 200);
  const { secret } = (await enrollment.json()).data;
  const confirmation = await f.request('auth/mfa/confirm', { method: 'POST', cookie: firstCookie, csrf: session.csrfToken, body: { code: new TOTP({ secret }).generate({ timestamp: f.clock.value }) } });
  assert.equal(confirmation.status, 200);
  return { ...(await confirmation.json()).data, cookie: cookieValue(confirmation), firstCookie, secret };
}

test('HTTP second-factor challenge is HttpOnly, not a management session or JSON bearer', async (t) => {
  const f = await fixture(t); const e = await enable(f);
  assert.equal((await f.request('servers', { cookie: e.firstCookie })).status, 401);
  const login = await f.login(); assert.equal(login.status, 202);
  const body = (await login.json()).data;
  assert.equal(body.mfaRequired, true); assert.equal(body.token, undefined); assert.equal(body.challengeToken, undefined); assert.equal(body.csrfToken, undefined);
  const cookie = cookieValue(login, '__Host-yunpanel_mfa');
  const header = login.headers.getSetCookie().find((value) => value.startsWith('__Host-yunpanel_mfa='));
  assert.match(header, /HttpOnly/); assert.match(header, /Secure/); assert.match(header, /SameSite=Strict/); assert.match(header, /Max-Age=300/); assert.ok(!header.includes('Domain='));
  assert.equal((await f.request('servers', { cookie })).status, 401);
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', cookie, body: { code: 'invalid' } })).status, 401);
  const verified = await f.request('auth/mfa/verify', { method: 'POST', cookie, body: { code: e.recoveryCodes[0], method: 'recovery' } });
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).data.user.username, 'owner');
  assert.equal((await f.request('servers', { cookie: cookieValue(verified) })).status, 200);
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', cookie, body: { code: e.recoveryCodes[1], method: 'recovery' } })).status, 401);
});

test('factor endpoints require Origin, cookie binding and CSRF for settings', async (t) => {
  const f = await fixture(t); const e = await enable(f);
  const login = await f.login(); const cookie = cookieValue(login, '__Host-yunpanel_mfa');
  const proof = { code: e.recoveryCodes[0], method: 'recovery' };
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', cookie, body: proof, headers: { origin: 'https://outside.example.test' } })).status, 403);
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', body: { ...proof, challengeToken: cookie.split('=')[1] } })).status, 401);
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', cookie: `${cookie}; ${cookie}`, body: proof })).status, 400);
  assert.equal((await f.request('auth/mfa/disable', { method: 'POST', cookie: e.cookie, body: { password, ...proof } })).status, 403);
  assert.equal((await f.request('auth/mfa/verify', { cookie })).status, 405);
  assert.equal((await f.request('auth/mfa/cancel', { method: 'POST', cookie })).status, 204);
  assert.equal((await f.request('auth/mfa/verify', { method: 'POST', cookie, body: proof })).status, 401);
});

test('password reset invalidates pending MFA login without disabling the factor', async (t) => {
  const f = await fixture(t); const e = await enable(f);
  const pending = await f.store.login({ username: 'owner', password });
  const nextPassword = randomBytes(32).toString('base64url');
  await f.store.resetPassword('owner', nextPassword);
  assert.throws(() => f.store.mfa.completeLogin(pending.challengeToken, { method: 'recovery', code: e.recoveryCodes[0] }), { code: 'mfa_challenge_expired' });
  assert.equal((await f.store.login({ username: 'owner', password: nextPassword })).mfaRequired, true);
  assert.equal(f.store.getSession(e.cookie.split('=')[1]), null);
});

test('regeneration rotates cookies and codes; disable signs out instead of leaving an old session', async (t) => {
  const f = await fixture(t); const e = await enable(f);
  const regeneration = await f.request('auth/mfa/recovery', { method: 'POST', cookie: e.cookie, csrf: e.session.csrfToken, body: { password, code: e.recoveryCodes[0], method: 'recovery' } });
  assert.equal(regeneration.status, 200);
  const next = (await regeneration.json()).data; const cookie = cookieValue(regeneration);
  assert.equal((await f.request('servers', { cookie: e.cookie })).status, 401);
  const disabled = await f.request('auth/mfa/disable', { method: 'POST', cookie, csrf: next.session.csrfToken, body: { password, code: next.recoveryCodes[0], method: 'recovery' } });
  assert.equal(disabled.status, 204);
  assert.equal((await f.request('servers', { cookie })).status, 401);
  assert.equal((await f.login()).status, 200);
});

test('MFA attempts survive new password login challenges', async (t) => {
  const f = await fixture(t); await enable(f);
  for (let round = 0; round < 2; round++) {
    const pending = await f.store.login({ username: 'owner', password });
    for (let i = 0; i < 5; i++) assert.throws(() => f.store.mfa.completeLogin(pending.challengeToken, { code: 'invalid' }), { code: 'mfa_invalid_code' });
  }
  const pending = await f.store.login({ username: 'owner', password });
  assert.throws(() => f.store.mfa.completeLogin(pending.challengeToken, { code: 'invalid' }), { code: 'rate_limited' });
});

test('version-one auth data and existing sessions survive the version-two migration', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-mfa-migrate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'private', 'auth.sqlite');
  const first = createAuthStore({ filePath });
  await first.completeSetup({ setupToken: first.issueSetupToken().token, username: 'owner', password });
  const old = await first.login({ username: 'owner', password }); first.close();
  const legacy = new DatabaseSync(filePath);
  legacy.exec('DROP TABLE auth_mfa_pending; DROP TABLE auth_mfa_recovery; DROP TABLE auth_mfa_challenges; DROP TABLE auth_mfa; PRAGMA user_version = 1;'); legacy.close();
  const migrated = createAuthStore({ filePath }); t.after(() => migrated.close());
  assert.equal(migrated.getSession(old.token).user.username, 'owner');
  assert.equal(migrated.mfa.status(old.token).enabled, false);
  assert.ok((await migrated.login({ username: 'owner', password })).session);
});
