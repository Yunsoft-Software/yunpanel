import test from 'node:test';
import assert from 'node:assert/strict';
import { authRequest, requestJson, setSession, sessionHeaders, isSessionChangePending } from '../src/session-client.js';
const response = (data, status = 200) => new Response(JSON.stringify({ data }), { status });
const unauthorized = () => new Response(JSON.stringify({ error: { code: 'unauthorized' } }), { status: 401 });

test('an old unauthorized response cannot clear a newer session', async (t) => {
  setSession({ csrfToken: 'old' }); let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finish = resolve; }));
  const pending = requestJson('/api/panel/servers');
  setSession({ csrfToken: 'new' }); finish(unauthorized());
  await assert.rejects(pending, { code: 'session_superseded' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'new');
});

test('same-session polling does not mask genuine expiry', async (t) => {
  setSession({ csrfToken: 'same' }); let finish;
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => { finish = resolve; }));
  const pending = requestJson('/api/panel/servers');
  setSession({ csrfToken: 'same' }); finish(unauthorized());
  await assert.rejects(pending, { code: 'unauthorized' });
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('MFA session rotation supersedes background reads and installs new CSRF before returning', async (t) => {
  setSession({ csrfToken: 'before' }); const callbacks = [];
  t.mock.method(globalThis, 'fetch', () => new Promise((resolve) => callbacks.push(resolve)));
  const background = authRequest('session', { notifyExpired: false });
  const rotating = authRequest('mfa/confirm', { method: 'POST', body: { code: '123456' }, changesSession: true });
  assert.equal(isSessionChangePending(), true);
  callbacks[0](unauthorized());
  await assert.rejects(background, { code: 'session_superseded' });
  callbacks[1](response({ session: { user: { id: 'u' }, csrfToken: 'after' }, recoveryCodes: [] }));
  await rotating;
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'after');
  assert.equal(isSessionChangePending(), false);
});

test('wrong MFA proof retains a valid session and releases the mutation lock', async (t) => {
  setSession({ csrfToken: 'still-valid' });
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'mfa_invalid_code' } }), { status: 401 }));
  await assert.rejects(authRequest('mfa/recovery', { method: 'POST', changesSession: true }), { code: 'mfa_invalid_code' });
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'still-valid');
  assert.equal(isSessionChangePending(), false);
});

test('password-only MFA response is not treated as a full session', async (t) => {
  setSession({ csrfToken: 'previous' });
  t.mock.method(globalThis, 'fetch', async () => response({ mfaRequired: true, expiresAt: 123 }, 202));
  assert.equal((await authRequest('login', { method: 'POST', changesSession: true })).mfaRequired, true);
  assert.deepEqual(sessionHeaders('POST'), {});
});

test('network failure releases session-change lock and does not discard the prior session', async (t) => {
  setSession({ csrfToken: 'existing' });
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network unavailable'); });
  await assert.rejects(authRequest('mfa/confirm', { method: 'POST', changesSession: true }), /Network/);
  assert.equal(isSessionChangePending(), false);
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'existing');
});
