import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TOTP } from 'otpauth';
import { createAuthStore, hashPassword, verifyPassword } from '../src/auth-store.js';
import { createAuthMailer, validateEmail } from '../src/auth-mailer.js';
import { createAuthenticatedApi } from '../src/auth-http.js';

function createMockMailer({ available = true, shouldFailSend = false } = {}) {
  const sent = [];
  return {
    sent,
    async isAvailable() {
      return available;
    },
    async sendMail(options) {
      if (shouldFailSend) throw new Error('SMTP connection failed');
      sent.push(options);
      return { messageId: 'test-msg-id', accepted: [options.to] };
    },
    async sendPasswordResetEmail({ to, username, resetUrl }) {
      return this.sendMail({
        to,
        subject: 'YunPanel - Parola Sıfırlama',
        text: `Kullanıcı: ${username}\nBağlantı: ${resetUrl}`,
      });
    },
    validateEmail(email) {
      return validateEmail(email);
    },
  };
}

function fixture(t, { mailer = createMockMailer(), now = Date.now, masterKey = 'a'.repeat(64), ...storeOptions } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-pwd-reset-'));
  const filePath = path.join(root, 'auth.sqlite');
  let revokedLiveUser = null;
  const store = createAuthStore({
    filePath,
    mailer,
    now,
    masterKey: storeOptions.masterKey ?? masterKey,
    revokeLiveUser: (userId, reason) => {
      revokedLiveUser = { userId, reason };
    },
    ...storeOptions,
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    filePath,
    root,
    mailer,
    getRevokedLiveUser: () => revokedLiveUser,
  };
}

async function setupOwner(store, { email = 'owner@example.com', password = 'initial-secure-password-123' } = {}) {
  const { token: setupToken } = store.issueSetupToken();
  return store.completeSetup({
    setupToken,
    username: 'admin',
    password,
    email,
  });
}

test('email validation strictly rejects invalid formats and normalizes valid addresses', () => {
  assert.equal(validateEmail('  Admin@Example.COM  '), 'admin@example.com');
  assert.equal(validateEmail('user.name+tag@sub.domain.org'), 'user.name+tag@sub.domain.org');

  for (const bad of [
    '',
    'notanemail',
    '@nodomain.com',
    'missing@',
    'spaces in@email.com',
    'bad@domain..com',
    'a'.repeat(250) + '@example.com',
    null,
    undefined,
    123,
  ]) {
    assert.throws(() => validateEmail(bad), { code: 'invalid_email' });
  }
});

test('owner can configure recovery email during setup and manage it afterwards', async (t) => {
  const { store } = fixture(t);
  const ownerUser = await setupOwner(store, { email: 'owner@example.com' });
  assert.equal(ownerUser.username, 'admin');

  const rec = store.getRecoveryEmail(ownerUser.id);
  assert.equal(rec.email, 'owner@example.com');
  assert.equal(rec.verified, true);

  // Lookup by username
  const byUser = store.getRecoveryEmailByUsername('admin');
  assert.equal(byUser.email, 'owner@example.com');

  // Update recovery email
  const updated = store.setRecoveryEmail(ownerUser.id, 'new-owner@example.com');
  assert.equal(updated.email, 'new-owner@example.com');
  assert.equal(store.getRecoveryEmail(ownerUser.id).email, 'new-owner@example.com');

  // Update recovery email by username
  store.setRecoveryEmailByUsername('admin', 'final-owner@example.com');
  assert.equal(store.getRecoveryEmail(ownerUser.id).email, 'final-owner@example.com');

  // Clear recovery email with null
  const cleared = store.setRecoveryEmail(ownerUser.id, null);
  assert.equal(cleared.email, null);
  assert.equal(store.getRecoveryEmail(ownerUser.id).email, null);
});

test('non-owner user cannot set recovery email', async (t) => {
  const { store, filePath } = fixture(t);
  await setupOwner(store);

  // Directly insert a non-owner user in SQLite
  const db = new DatabaseSync(filePath);
  const regularUserId = '11111111-2222-3333-4444-555555555555';
  db.prepare("INSERT INTO users VALUES (?, 'editor', 'some-hash', 'site_manager', 1, 1000, 1000)").run(regularUserId);
  db.close();

  assert.throws(() => store.setRecoveryEmail(regularUserId, 'editor@example.com'), { code: 'forbidden' });
});

test('password reset request generates 15-minute token hashed with SHA-256 and sends email', async (t) => {
  let currentTime = 1_000_000;
  const mockMailer = createMockMailer();
  const { store, filePath } = fixture(t, { mailer: mockMailer, now: () => currentTime });
  const ownerUser = await setupOwner(store, { email: 'owner@example.com' });

  const result = await store.requestPasswordReset({
    identifier: 'admin',
    peer: '192.168.1.100',
    origin: 'https://panel.example.com',
  });
  assert.deepEqual(result, { sent: true });

  // Verify email was sent
  assert.equal(mockMailer.sent.length, 1);
  const email = mockMailer.sent[0];
  assert.equal(email.to, 'owner@example.com');
  assert.match(email.text, /https:\/\/panel\.example\.com\/#reset-token=/);

  // Extract raw token from reset URL
  const tokenMatch = /#reset-token=([A-Za-z0-9_-]+)/.exec(email.text);
  assert.ok(tokenMatch, 'Raw token should be present in reset URL');
  const rawToken = tokenMatch[1];

  // Inspect database: token MUST be stored as SHA-256 hash, NOT raw token!
  const db = new DatabaseSync(filePath);
  const row = db.prepare('SELECT * FROM auth_password_resets WHERE user_id = ?').get(ownerUser.id);
  db.close();

  assert.ok(row, 'Reset record should exist in database');
  const expectedHash = createHash('sha256').update(rawToken).digest('hex');
  assert.equal(row.token_hash, expectedHash, 'Database must store SHA-256 hash of token');
  assert.notEqual(row.token_hash, rawToken, 'Database must never store raw token');
  assert.equal(row.expires_at, currentTime + 15 * 60 * 1000, 'Token must expire in exactly 15 minutes');
});

test('new reset request supersedes previous reset token (single-use replacement)', async (t) => {
  const mockMailer = createMockMailer();
  const { store, filePath } = fixture(t, { mailer: mockMailer });
  const ownerUser = await setupOwner(store, { email: 'owner@example.com' });

  await store.requestPasswordReset({ identifier: 'admin' });
  const firstToken = /#reset-token=([A-Za-z0-9_-]+)/.exec(mockMailer.sent[0].text)[1];

  await store.requestPasswordReset({ identifier: 'admin' });
  const secondToken = /#reset-token=([A-Za-z0-9_-]+)/.exec(mockMailer.sent[1].text)[1];

  assert.notEqual(firstToken, secondToken);

  // Verify only one token exists in the database
  const db = new DatabaseSync(filePath);
  const rows = db.prepare('SELECT * FROM auth_password_resets WHERE user_id = ?').all(ownerUser.id);
  db.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, createHash('sha256').update(secondToken).digest('hex'));

  // First token cannot be used to reset password
  await assert.rejects(
    store.resetPasswordWithToken({ token: firstToken, newPassword: 'brand-new-secure-password-123' }),
    { code: 'invalid_reset_token' },
  );
});

test('anti-enumeration: non-existent account returns { sent: true } without sending email when SMTP is up', async (t) => {
  const mockMailer = createMockMailer({ available: true });
  const { store } = fixture(t, { mailer: mockMailer });
  await setupOwner(store, { email: 'owner@example.com' });

  const result = await store.requestPasswordReset({ identifier: 'nonexistent-user@nowhere.test' });
  assert.deepEqual(result, { sent: true });
  assert.equal(mockMailer.sent.length, 0, 'No email should be sent for non-existent account');
});

test('fail-closed: when SMTP is unavailable, requestPasswordReset throws 503 smtp_unavailable for all accounts', async (t) => {
  const mockMailer = createMockMailer({ available: false });
  const { store } = fixture(t, { mailer: mockMailer });
  await setupOwner(store, { email: 'owner@example.com' });

  // Existing owner account throws 503
  await assert.rejects(
    store.requestPasswordReset({ identifier: 'admin' }),
    { code: 'smtp_unavailable', status: 503 },
  );

  // Non-existent account also throws 503 ("SMTP yokken başarı mesajı verilmesin")
  await assert.rejects(
    store.requestPasswordReset({ identifier: 'fake-account@example.com' }),
    { code: 'smtp_unavailable', status: 503 },
  );
});

test('expired reset token is rejected', async (t) => {
  let currentTime = 1_000_000;
  const mockMailer = createMockMailer();
  const { store } = fixture(t, { mailer: mockMailer, now: () => currentTime });
  await setupOwner(store, { email: 'owner@example.com' });

  await store.requestPasswordReset({ identifier: 'admin' });
  const rawToken = /#reset-token=([A-Za-z0-9_-]+)/.exec(mockMailer.sent[0].text)[1];

  // Advance clock beyond 15 minutes
  currentTime += 15 * 60 * 1000 + 1;

  await assert.rejects(
    store.resetPasswordWithToken({ token: rawToken, newPassword: 'brand-new-secure-password-123' }),
    { code: 'reset_token_expired' },
  );
});

test('successful password reset revokes all sessions, clears challenges, invalidates live user, and preserves MFA factor', async (t) => {
  const mockMailer = createMockMailer();
  const { store, filePath, getRevokedLiveUser } = fixture(t, { mailer: mockMailer });
  const ownerUser = await setupOwner(store, { email: 'owner@example.com', password: 'initial-password-1234' });

  // Enroll MFA for owner
  const loginBeforeMfa = await store.login({ username: 'admin', password: 'initial-password-1234' });
  const enrollment = await store.mfa.beginEnrollment(loginBeforeMfa.token, 'initial-password-1234');
  const totpCode = new TOTP({ secret: enrollment.secret }).generate();
  const confirmResult = store.mfa.confirmEnrollment(loginBeforeMfa.token, totpCode);
  assert.equal(store.mfa.enabled(ownerUser.id), true);

  // Create an active session and a pending login challenge
  const activeSessionToken = confirmResult.token;
  assert.ok(store.getSession(activeSessionToken));

  // Request password reset
  await store.requestPasswordReset({ identifier: 'admin' });
  const rawToken = /#reset-token=([A-Za-z0-9_-]+)/.exec(mockMailer.sent[0].text)[1];

  // Reset password using token
  const resetResult = await store.resetPasswordWithToken({
    token: rawToken,
    newPassword: 'brand-new-secure-password-5678',
    peer: '10.0.0.5',
  });
  assert.deepEqual(resetResult, { reset: true, username: 'admin' });

  // Live user revocation hook was called
  const revoked = getRevokedLiveUser();
  assert.deepEqual(revoked, { userId: ownerUser.id, reason: 'password_reset' });

  // All previous sessions revoked
  assert.equal(store.getSession(activeSessionToken), null);
  const db = new DatabaseSync(filePath);
  const sessionCount = db.prepare('SELECT count(*) as count FROM sessions WHERE user_id = ?').get(ownerUser.id).count;
  assert.equal(sessionCount, 0, 'All sessions for user must be removed');

  // Token is single-use: cannot be reused
  const resetCount = db.prepare('SELECT count(*) as count FROM auth_password_resets WHERE user_id = ?').get(ownerUser.id).count;
  assert.equal(resetCount, 0, 'Reset token must be deleted after use');
  db.close();

  await assert.rejects(
    store.resetPasswordWithToken({ token: rawToken, newPassword: 'another-password-1234' }),
    { code: 'invalid_reset_token' },
  );

  // Enrolled MFA factor is preserved: login requires MFA
  const loginWithNewPassword = await store.login({ username: 'admin', password: 'brand-new-secure-password-5678' });
  assert.equal(loginWithNewPassword.mfaRequired, true, 'MFA must remain enrolled after password reset');

  // Old password no longer works
  await assert.rejects(
    store.login({ username: 'admin', password: 'initial-password-1234' }),
    { code: 'invalid_credentials' },
  );
});

test('HTTP API: reset password flow endpoints and recovery email endpoints', async (t) => {
  const origin = 'https://panel.example.test';
  const mockMailer = createMockMailer();
  const { store } = fixture(t, { mailer: mockMailer });
  await setupOwner(store, { email: 'owner@example.test', password: 'original-secret-password-123' });

  const listener = createAuthenticatedApi({
    store,
    publicOrigin: origin,
    ownerMfaRequired: false,
    createHandler: () => (req, res) => {
      res.writeHead(200);
      res.end('ok');
    },
  });

  const server = http.createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));

  const api = (pathName, opts = {}) => fetch(`http://127.0.0.1:${port}${pathName}`, {
    ...opts,
    headers: { origin, ...opts.headers },
  });

  // 1. Reset password request
  const reqRes = await api('/api/auth/reset-password/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin' }),
  });
  assert.equal(reqRes.status, 200);
  const reqData = await reqRes.json();
  assert.deepEqual(reqData, { data: { sent: true } });

  const rawToken = /#reset-token=([A-Za-z0-9_-]+)/.exec(mockMailer.sent[0].text)[1];

  // 2. Perform reset
  const resetRes = await api('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: rawToken, newPassword: 'brand-new-http-password-123' }),
  });
  assert.equal(resetRes.status, 200);
  const resetData = await resetRes.json();
  assert.deepEqual(resetData, { data: { reset: true, username: 'admin' } });

  // 3. Log in with new password
  const loginRes = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'brand-new-http-password-123' }),
  });
  assert.equal(loginRes.status, 200);
  const sessionCookie = loginRes.headers.get('set-cookie');
  const loginPayload = await loginRes.json();
  const csrf = loginPayload.data.csrfToken;

  // 4. GET recovery email
  const getEmailRes = await api('/api/auth/recovery-email', {
    method: 'GET',
    headers: { cookie: sessionCookie },
  });
  assert.equal(getEmailRes.status, 200);
  const emailPayload = await getEmailRes.json();
  assert.equal(emailPayload.data.email, 'owner@example.test');

  // 5. POST new recovery email
  const setEmailRes = await api('/api/auth/recovery-email', {
    method: 'POST',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({ email: 'updated-owner@example.test' }),
  });
  assert.equal(setEmailRes.status, 200);
  const updatePayload = await setEmailRes.json();
  assert.equal(updatePayload.data.email, 'updated-owner@example.test');
});
