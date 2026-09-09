import test from 'node:test';
import assert from 'node:assert/strict';
import { loginOutcome, passwordLogin, proofInput, requireSession, rotateMfa, sessionDeadline, verifyMfa } from '../src/auth-protocol.js';
import { setSession } from '../src/session-client.js';
const session = { id: 's', user: { id: 'u', username: 'owner', role: 'owner' }, csrfToken: 'csrf', expiresAt: 8000, idleExpiresAt: 5000 };

test('an MFA challenge is not an authenticated session and exposes no bearer credential', () => {
  assert.deepEqual(loginOutcome({ mfaRequired: true, expiresAt: 9000, challengeToken: 'must-not-escape' }), { status: 'mfa', expiresAt: 9000 });
  assert.throws(() => requireSession({ mfaRequired: true, expiresAt: 9000 }));
});

test('malformed or partial login responses fail closed', () => {
  for (const value of [undefined, {}, { mfaRequired: true }, { ...session, user: null }, { ...session, csrfToken: '' }, { ...session, user: { ...session.user, role: 'unknown' } }]) assert.throws(() => loginOutcome(value));
  assert.equal(loginOutcome(session).session, session);
});

test('password request preserves 202 MFA step without logging the user in', async (t) => {
  setSession(null);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/login');
    assert.deepEqual(JSON.parse(options.body), { username: 'owner', password: 'test-value' });
    return new Response(JSON.stringify({ data: { mfaRequired: true, expiresAt: 9000 } }), { status: 202 });
  });
  assert.deepEqual(await passwordLogin('owner', 'test-value'), { status: 'mfa', expiresAt: 9000 });
});

test('proof validation keeps leading zeroes and supports one-time recovery codes', () => {
  assert.deepEqual(proofInput(' 012345 '), { code: '012345', method: 'totp' });
  assert.equal(proofInput('ABCD-1234-ABCD-1234-ABCD-1234-ABCD-1234', 'recovery').method, 'recovery');
  for (const code of ['12345', '1234567', 'a12345', 123456]) assert.throws(() => proofInput(code));
  assert.throws(() => proofInput('123456', 'other'));
  assert.throws(() => proofInput('123456', 'recovery'));
});

test('MFA verification sends only proof and receives a complete session', async (t) => {
  setSession(null);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/mfa/verify');
    assert.deepEqual(JSON.parse(options.body), { code: '012345', method: 'totp' });
    assert.equal(options.headers.authorization, undefined);
    return new Response(JSON.stringify({ data: session }));
  });
  assert.deepEqual(await verifyMfa('012345', 'totp'), session);
});

test('rotation accepts only expected endpoints and a complete recovery-code response', async (t) => {
  setSession({ csrfToken: 'old' });
  const codes = Array.from({ length: 10 }, () => 'abcd-1234-abcd-1234-abcd-1234-abcd-1234');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { session, recoveryCodes: codes } })));
  assert.deepEqual(await rotateMfa('mfa/confirm', { code: '012345' }), { session, recoveryCodes: codes });
  await assert.rejects(rotateMfa('unexpected', {}), /Invalid MFA/);
});

test('invalid recovery-code response never returns success', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: { session, recoveryCodes: ['short'] } })));
  await assert.rejects(rotateMfa('mfa/confirm', { code: '012345' }), /Kurtarma/);
});

test('session warning uses the earlier of idle and absolute expiry', () => {
  assert.deepEqual(sessionDeadline(session, 4000), { remainingMs: 1000, expired: false, warning: true, absolute: false });
  assert.equal(sessionDeadline(session, 5000).expired, true);
  assert.equal(sessionDeadline({ ...session, idleExpiresAt: 9000 }, 7000).absolute, true);
  assert.equal(sessionDeadline({ ...session, idleExpiresAt: 300000, expiresAt: 400000 }, 0).warning, false);
});

test('failed security mutation releases the transition and preserves current CSRF', async (t) => {
  const { endAuthenticatedSession } = await import('../src/auth-protocol.js');
  const { sessionTransitionPending, sessionHeaders } = await import('../src/session-client.js');
  setSession({ csrfToken: 'still-active' });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(sessionTransitionPending(), true);
    assert.equal(options.headers['x-csrf-token'], 'still-active');
    return new Response('{"error":{"code":"invalid_credentials"}}', { status: 401 });
  });
  await assert.rejects(endAuthenticatedSession('password', {}), { code: 'invalid_credentials' });
  assert.equal(sessionTransitionPending(), false);
  assert.equal(sessionHeaders('POST')['x-csrf-token'], 'still-active');
});

test('unsupported session termination actions do not start a transition', async () => {
  const { endAuthenticatedSession } = await import('../src/auth-protocol.js');
  const { sessionTransitionPending } = await import('../src/session-client.js');
  await assert.rejects(endAuthenticatedSession('servers/delete', {}), /Invalid session/);
  assert.equal(sessionTransitionPending(), false);
});
