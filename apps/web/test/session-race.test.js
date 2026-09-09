import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJson, setSession, sessionHeaders, sessionVersion } from '../src/session-client.js';

const reply = (status, payload) => new Response(JSON.stringify(payload), { status });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('late 401 from a previous session cannot clear a freshly rotated session', async (t) => {
  setSession({ csrfToken: 'old' });
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const request = requestJson('/api/panel/servers');
  setSession({ csrfToken: 'new' });
  pending.resolve(reply(401, { error: { code: 'unauthorized' } }));
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'new');
});

test('late success from an old login/refresh cannot restore a logged-out session', async (t) => {
  setSession({ csrfToken: 'session-a' });
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const request = requestJson('/api/auth/session', { notifyExpired: false });
  setSession(null);
  pending.resolve(reply(200, { data: { csrfToken: 'session-a' } }));
  await assert.rejects(request, { name: 'AbortError' });
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('re-reading the same session does not abort current operations', async (t) => {
  setSession({ csrfToken: 'same' });
  const before = sessionVersion();
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const request = requestJson('/api/panel/servers');
  setSession({ csrfToken: 'same' });
  assert.equal(sessionVersion(), before);
  pending.resolve(reply(200, { data: ['server'] }));
  assert.deepEqual(await request, ['server']);
});

test('session replacement during JSON parsing rejects the stale body', async (t) => {
  setSession({ csrfToken: 'old-body' });
  const body = deferred();
  t.mock.method(globalThis, 'fetch', async () => ({ status: 200, ok: true, json: () => body.promise }));
  const request = requestJson('/api/auth/session');
  await new Promise((resolve) => setImmediate(resolve));
  setSession({ csrfToken: 'new-body' });
  body.resolve({ data: { csrfToken: 'old-body' } });
  await assert.rejects(request, { name: 'AbortError' });
});

test('an active-session 401 still clears the session', async (t) => {
  setSession({ csrfToken: 'expired' });
  t.mock.method(globalThis, 'fetch', async () => reply(401, { error: { code: 'unauthorized' }, setupRequired: false }));
  await assert.rejects(requestJson('/api/panel/servers'), { status: 401, code: 'unauthorized' });
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('an incorrect MFA proof does not clear an otherwise valid session', async (t) => {
  setSession({ csrfToken: 'valid' });
  t.mock.method(globalThis, 'fetch', async () => reply(401, { error: { code: 'mfa_invalid_code' } }));
  await assert.rejects(requestJson('/api/auth/mfa/recovery', { method: 'POST', body: {} }), { code: 'mfa_invalid_code' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'valid');
});

test('aborted and obsolete network errors cannot change a new session', async (t) => {
  setSession({ csrfToken: 'before' });
  const pending = deferred();
  t.mock.method(globalThis, 'fetch', () => pending.promise);
  const request = requestJson('/api/auth/session');
  setSession({ csrfToken: 'after' });
  pending.reject(new TypeError('Network unavailable'));
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'after');
});

test('aborted signal rejects without starting an HTTP request', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls += 1; });
  const signal = AbortSignal.abort();
  await assert.rejects(requestJson('/api/auth/session', { signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('only canonical same-origin paths are accepted and retry delay is exposed', async (t) => {
  for (const url of ['https://other.test/api', '//other.test/api', '/api/\\other', null]) await assert.rejects(requestJson(url), /same-origin/);
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"code":"rate_limited"}}', { status: 429, headers: { 'retry-after': '15' } }));
  await assert.rejects(requestJson('/api/auth/login'), { status: 429, retryAfter: 15 });
});
