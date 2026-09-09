import test from 'node:test';
import assert from 'node:assert/strict';
import { authRequest, requestJson, sessionHeaders, setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });
const unauthorized = () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' }, setupRequired: true }), { status: 401 });

test('CSRF state is in memory, omitted from safe reads, and cleared on logout', () => {
  setSession({ csrfToken: 'csrf-fixture' });
  assert.deepEqual(sessionHeaders('GET'), {});
  assert.deepEqual(sessionHeaders('POST'), { 'x-csrf-token': 'csrf-fixture' });
  setSession(null);
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('requests use same-origin cookies and reject cross-origin API destinations', async (t) => {
  setSession({ csrfToken: 'csrf-fixture' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/password');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-csrf-token'], 'csrf-fixture');
    assert.equal(options.headers.authorization, undefined);
    return ok({ success: true });
  });
  assert.deepEqual(await authRequest('password', { method: 'POST', body: {} }), { success: true });
  await assert.rejects(requestJson('https://outside.example/api'), /same-origin/);
});

test('an unauthenticated session check exposes setupRequired without clearing a newer login', async (t) => {
  setSession({ csrfToken: 'newer-session-csrf' });
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  await assert.rejects(authRequest('session', { notifyExpired: false }), { status: 401, setupRequired: true });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'newer-session-csrf');
});

test('a rejected management session clears CSRF state', async (t) => {
  setSession({ csrfToken: 'old-session-csrf' });
  t.mock.method(globalThis, 'fetch', async () => unauthorized());
  await assert.rejects(requestJson('/api/panel/servers'), { status: 401 });
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('wrong current password does not discard the otherwise valid session', async (t) => {
  setSession({ csrfToken: 'existing-session-csrf' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'invalid_credentials', message: 'Wrong current password' } }), { status: 401 }));
  await assert.rejects(authRequest('password', { method: 'POST', body: {} }), { code: 'invalid_credentials' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'existing-session-csrf');
});

test('empty responses and non-JSON gateway errors remain usable', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await authRequest('logout', { method: 'POST' }), undefined);
  t.mock.method(globalThis, 'fetch', async () => new Response('Forbidden by gateway', { status: 403 }));
  await assert.rejects(authRequest('session'), { status: 403, code: 'http_403' });
});
