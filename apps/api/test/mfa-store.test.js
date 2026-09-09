import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOTP } from 'otpauth';
import { mfaFixture } from '../test-support/mfa-fixture.js';

const otp = (secret, f) => new TOTP({ secret }).generate({ timestamp: f.now() });
async function enrolled(f) {
  const enrollment = await f.mfa.beginEnrollment(f.token, f.password);
  const result = f.mfa.confirmEnrollment(f.token, otp(enrollment.secret, f));
  f.token = result.token;
  f.clock.value += 30_000;
  return { ...enrollment, ...result };
}
const challenge = (f) => f.transaction(() => f.mfa.createLoginChallenge(f.userId)).challengeToken;

test('MFA setup stores only ciphertext and rotates every existing session', async (t) => {
  const f = mfaFixture(t);
  const first = f.token;
  const other = f.createSession(f.userId);
  const enrollment = await f.mfa.beginEnrollment(first, f.password);
  assert.equal(f.mfa.enabled(f.userId), false);
  const pending = f.db.prepare('SELECT * FROM auth_mfa_pending').get();
  assert.equal(pending.secret.includes(enrollment.secret), false);
  const result = f.mfa.confirmEnrollment(first, otp(enrollment.secret, f));
  assert.equal(f.getSession(first), null); assert.equal(f.getSession(other.token), null);
  assert.ok(f.getSession(result.token));
  assert.equal(f.mfa.status(result.token).recoveryCodesRemaining, 10);
  const stored = JSON.stringify(f.db.prepare('SELECT * FROM auth_mfa_recovery').all());
  for (const code of result.recoveryCodes) assert.equal(stored.includes(code), false);
  assert.equal(JSON.stringify(f.mfa.status(result.token)).includes(enrollment.secret), false);
});

test('setup rejects wrong password, cross-session confirmation, expiry and reused confirmation', async (t) => {
  const f = mfaFixture(t);
  await assert.rejects(f.mfa.beginEnrollment(f.token, 'wrong'), { code: 'invalid_credentials' });
  const enrollment = await f.mfa.beginEnrollment(f.token, f.password);
  const other = f.createSession(f.userId);
  assert.throws(() => f.mfa.confirmEnrollment(other.token, otp(enrollment.secret, f)), { code: 'mfa_enrollment_expired' });
  assert.throws(() => f.mfa.confirmEnrollment(f.token, 'invalid'), { code: 'mfa_invalid_code' });
  f.clock.value = enrollment.expiresAt;
  assert.throws(() => f.mfa.confirmEnrollment(f.token, otp(enrollment.secret, f)), { code: 'mfa_enrollment_expired' });
  const next = await enrolled(f);
  assert.throws(() => f.mfa.confirmEnrollment(f.token, otp(next.secret, f)), { code: 'mfa_enrollment_expired' });
  await assert.rejects(f.mfa.beginEnrollment(f.token, f.password), { code: 'mfa_already_enabled' });
});

test('a superseded pending key cannot be confirmed and cancellation erases it', async (t) => {
  const f = mfaFixture(t);
  await f.mfa.beginEnrollment(f.token, f.password);
  const current = await f.mfa.beginEnrollment(f.token, f.password);
  f.mfa.cancelEnrollment(f.token);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM auth_mfa_pending').get().count, 0);
  assert.throws(() => f.mfa.confirmEnrollment(f.token, otp(current.secret, f)), { code: 'mfa_enrollment_expired' });
});

test('TOTP login creates no session before proof and prevents replay across challenges', async (t) => {
  const f = mfaFixture(t); const e = await enrolled(f);
  const count = () => f.db.prepare('SELECT count(*) AS count FROM sessions').get().count;
  const before = count(); const one = challenge(f); const two = challenge(f);
  assert.equal(count(), before);
  const code = otp(e.secret, f);
  const result = f.mfa.completeLogin(one, { code });
  assert.ok(f.getSession(result.token));
  assert.throws(() => f.mfa.completeLogin(one, { code }), { code: 'mfa_challenge_expired' });
  assert.throws(() => f.mfa.completeLogin(two, { code }), { code: 'mfa_invalid_code' });
  f.clock.value += 30_000;
  assert.ok(f.mfa.completeLogin(two, { code: otp(e.secret, f) }).token);
});

test('enrollment proof is also marked used', async (t) => {
  const f = mfaFixture(t); const e = await enrolled(f);
  f.clock.value -= 30_000;
  assert.throws(() => f.mfa.completeLogin(challenge(f), { code: otp(e.secret, f) }), { code: 'mfa_invalid_code' });
});

test('five wrong proofs exhaust one challenge; creating a new one does not reset account throttling', async (t) => {
  const f = mfaFixture(t); await enrolled(f);
  const one = challenge(f);
  for (let i = 0; i < 5; i++) assert.throws(() => f.mfa.completeLogin(one, { code: 'invalid' }), { code: 'mfa_invalid_code' });
  assert.throws(() => f.mfa.completeLogin(one, { code: 'invalid' }), { code: 'mfa_challenge_expired' });
  for (let i = 0; i < 5; i++) assert.throws(() => f.mfa.completeLogin(challenge(f), { code: 'invalid' }), { code: 'mfa_invalid_code' });
  assert.throws(() => f.mfa.completeLogin(challenge(f), { code: 'invalid' }), { code: 'rate_limited' });
});

test('expired, cancelled and deactivated-user challenges never create sessions', async (t) => {
  const f = mfaFixture(t); const e = await enrolled(f);
  const expired = challenge(f); f.clock.value += 5 * 60_000;
  assert.throws(() => f.mfa.completeLogin(expired, { code: otp(e.secret, f) }), { code: 'mfa_challenge_expired' });
  const cancelled = challenge(f); f.mfa.cancelLogin(cancelled);
  assert.throws(() => f.mfa.completeLogin(cancelled, { code: otp(e.secret, f) }), { code: 'mfa_challenge_expired' });
  const disabled = challenge(f); f.db.exec('UPDATE users SET active=0');
  assert.throws(() => f.mfa.completeLogin(disabled, { code: otp(e.secret, f) }), { code: 'mfa_challenge_expired' });
});

test('recovery code consumption persists across SQLite connections', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-mfa-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'auth.sqlite'); const masterKey = randomBytes(32);
  const f = mfaFixture(t, { filePath, masterKey }); const e = await enrolled(f);
  const other = mfaFixture(t, { filePath, masterKey, clock: f.clock, seed: false });
  assert.ok(f.mfa.completeLogin(challenge(f), { method: 'recovery', code: e.recoveryCodes[0] }).token);
  assert.throws(() => other.mfa.completeLogin(challenge(f), { method: 'recovery', code: e.recoveryCodes[0] }), { code: 'mfa_invalid_code' });
  assert.equal(other.mfa.status(f.token).recoveryCodesRemaining, 9);
  assert.equal(other.db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('regeneration requires password and proof, retires codes, sessions and login challenges', async (t) => {
  const f = mfaFixture(t); const e = await enrolled(f); const pending = challenge(f); const old = f.token;
  await assert.rejects(f.mfa.regenerateRecovery(old, 'wrong', { method: 'recovery', code: e.recoveryCodes[0] }), { code: 'invalid_credentials' });
  const result = await f.mfa.regenerateRecovery(old, f.password, { method: 'recovery', code: e.recoveryCodes[0] });
  assert.equal(f.getSession(old), null); assert.ok(f.getSession(result.token));
  assert.throws(() => f.mfa.completeLogin(pending, { code: otp(e.secret, f) }), { code: 'mfa_challenge_expired' });
  assert.throws(() => f.mfa.completeLogin(challenge(f), { method: 'recovery', code: e.recoveryCodes[1] }), { code: 'mfa_invalid_code' });
  assert.ok(f.mfa.completeLogin(challenge(f), { method: 'recovery', code: result.recoveryCodes[0] }).token);
});

test('disable requires both factors and revokes all sessions', async (t) => {
  const f = mfaFixture(t); const e = await enrolled(f);
  await assert.rejects(f.mfa.disable(f.token, f.password, { code: 'invalid' }), { code: 'mfa_invalid_code' });
  assert.equal(f.mfa.enabled(f.userId), true);
  await f.mfa.disable(f.token, f.password, { method: 'recovery', code: e.recoveryCodes[0] });
  assert.equal(f.mfa.enabled(f.userId), false); assert.equal(f.getSession(f.token), null);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM auth_mfa_recovery').get().count, 0);
});

test('local MFA recovery revokes sessions/challenges but does not change the password', async (t) => {
  const f = mfaFixture(t); await enrolled(f); const pending = challenge(f);
  f.mfa.resetLocal(' OWNER ');
  assert.equal(f.mfa.enabled(f.userId), false); assert.equal(f.getSession(f.token), null);
  assert.equal(f.db.prepare('SELECT password_hash FROM users').get().password_hash, f.password);
  assert.throws(() => f.mfa.completeLogin(pending, { code: '123456' }), { code: 'mfa_challenge_expired' });
  assert.throws(() => f.mfa.resetLocal('unknown'), { code: 'user_not_found' });
});

test('missing key cannot create an enrollment', async (t) => {
  const f = mfaFixture(t, { masterKey: null });
  assert.equal(f.mfa.status(f.token).keyConfigured, false);
  await assert.rejects(f.mfa.beginEnrollment(f.token, f.password), { code: 'mfa_key_unavailable' });
});

test('logout during async password verification prevents enrollment', async (t) => {
  let unblock;
  const f = mfaFixture(t, { passwordVerifier: () => new Promise((resolve) => { unblock = resolve; }) });
  const pending = f.mfa.beginEnrollment(f.token, f.password);
  f.db.exec('DELETE FROM sessions'); unblock(true);
  await assert.rejects(pending, { code: 'unauthorized' });
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM auth_mfa_pending').get().count, 0);
});

test('pending enrollment is removed when its session is revoked', async (t) => {
  const f = mfaFixture(t);
  await f.mfa.beginEnrollment(f.token, f.password);
  f.db.exec('DELETE FROM sessions');
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM auth_mfa_pending').get().count, 0);
});
