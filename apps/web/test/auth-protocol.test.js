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

test('optional hosting session context is accepted only for valid site-manager reseller/customer profiles', () => {
  const site = { ...session, user: { id: 'site-user', username: 'site-user', role: 'site_manager', websiteIds: [] } };
  assert.equal(requireSession(site), site);
  const reseller = { ...site, user: { ...site.user, hosting: { kind: 'reseller', resellerId: null } } };
  const customer = { ...site, user: { ...site.user, hosting: { kind: 'customer', resellerId: 'reseller-a' } } };
  assert.equal(requireSession(reseller), reseller);
  assert.equal(requireSession(customer), customer);
  for (const hosting of [
    { kind: 'reseller', resellerId: 'parent' },
    { kind: 'customer' },
    { kind: 'customer', resellerId: '../bad' },
    { kind: 'customer', resellerId: 'site-user' },
    { kind: 'owner', resellerId: null },
  ]) assert.throws(() => requireSession({ ...site, user: { ...site.user, hosting } }));
  assert.throws(() => requireSession({ ...session, user: { ...session.user, hosting: { kind: 'reseller', resellerId: null } } }));
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

test('requestPasswordReset validates input and calls reset-password/request endpoint', async (t) => {
  const { requestPasswordReset } = await import('../src/auth-protocol.js');
  await assert.rejects(requestPasswordReset(''), /Kullanıcı adı/);
  await assert.rejects(requestPasswordReset('   '), /Kullanıcı adı/);

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/reset-password/request');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { identifier: 'owner@example.com' });
    return new Response(JSON.stringify({ data: { sent: true } }), { status: 200 });
  });

  const res = await requestPasswordReset('  owner@example.com  ');
  assert.deepEqual(res, { sent: true });
});

test('resetPasswordWithToken validates token length, password length and terminates session', async (t) => {
  const { resetPasswordWithToken } = await import('../src/auth-protocol.js');
  const { sessionTransitionPending } = await import('../src/session-client.js');
  setSession({ csrfToken: 'active-token' });

  await assert.rejects(resetPasswordWithToken('', 'new-password-1234'), /Sıfırlama anahtarı/);
  await assert.rejects(resetPasswordWithToken('some-token', 'short'), /en az 12/);

  let fetchCalled = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    fetchCalled = true;
    assert.equal(url, '/api/auth/reset-password');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { token: 'reset-token-123', newPassword: 'long-secure-password-123' });
    return new Response(JSON.stringify({ data: { reset: true } }), { status: 200 });
  });

  const res = await resetPasswordWithToken(' reset-token-123 ', 'long-secure-password-123');
  assert.equal(fetchCalled, true);
  assert.deepEqual(res, { reset: true });
  assert.equal(sessionTransitionPending(), false);
});

test('recovery email helpers query and mutate recovery-email endpoint', async (t) => {
  const { getRecoveryEmail, setRecoveryEmail } = await import('../src/auth-protocol.js');

  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === '/api/auth/recovery-email' && options.method === 'GET') {
      return new Response(JSON.stringify({ data: { email: 'owner@example.com', verified: true } }), { status: 200 });
    }
    if (url === '/api/auth/recovery-email' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { email: 'new-owner@example.com' });
      return new Response(JSON.stringify({ data: { email: 'new-owner@example.com', verified: true } }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  const current = await getRecoveryEmail();
  assert.deepEqual(current, { email: 'owner@example.com', verified: true });

  const updated = await setRecoveryEmail('  new-owner@example.com  ');
  assert.deepEqual(updated, { email: 'new-owner@example.com', verified: true });
});

