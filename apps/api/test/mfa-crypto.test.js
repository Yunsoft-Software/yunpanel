import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { createMfaVault, createTotpEnrollment, matchTotp, createRecoveryCodes, recoveryDigest } from '../src/mfa-crypto.js';

test('MFA envelopes are randomized and bound to a user and master key', () => {
  const key = randomBytes(32);
  const vault = createMfaVault(key);
  const { secret } = createTotpEnrollment('owner');
  const one = vault.encrypt('user-one', secret);
  assert.notEqual(one, vault.encrypt('user-one', secret));
  assert.equal(one.includes(secret), false);
  assert.equal(vault.decrypt('user-one', one), secret);
  assert.throws(() => vault.decrypt('user-two', one), { code: 'mfa_key_unavailable' });
  assert.throws(() => createMfaVault(randomBytes(32)).decrypt('user-one', one), { code: 'mfa_key_unavailable' });
  const tampered = JSON.parse(one); tampered.tag = randomBytes(16).toString('base64');
  assert.throws(() => vault.decrypt('user-one', JSON.stringify(tampered)), { code: 'mfa_key_unavailable' });
});

test('missing/invalid master keys fail closed; existing hex/base64 formats interoperate', () => {
  assert.equal(createMfaVault(null).configured, false);
  assert.throws(() => createMfaVault(null).encrypt('u', 'secret'), { code: 'mfa_key_unavailable' });
  for (const key of ['short', Buffer.alloc(31), {}, 5]) assert.throws(() => createMfaVault(key), { code: 'invalid_secret_master_key' });
  const key = randomBytes(32);
  const ciphertext = createMfaVault(key.toString('hex')).encrypt('u', 'secret');
  assert.equal(createMfaVault(key.toString('base64')).decrypt('u', ciphertext), 'secret');
});

test('TOTP follows the RFC 6238 SHA1 vector, retaining the six-digit suffix', () => {
  const secret = Secret.fromLatin1('12345678901234567890').base32;
  assert.equal(matchTotp(secret, '287082', 59_000), 1);
  assert.equal(matchTotp(secret, '287082', 89_000), 1);
  assert.equal(matchTotp(secret, '287082', 119_000), null);
  for (const code of [null, 287082, '2', '２８７０８２', ' 287082', '2870820']) assert.equal(matchTotp(secret, code, 59_000), null);
});

test('enrollment has a 160-bit secret and safely encoded account label', () => {
  const enrollment = createTotpEnrollment('owner+test@example.test');
  assert.match(enrollment.secret, /^[A-Z2-7]{32}$/);
  assert.ok(enrollment.uri.startsWith('otpauth://totp/YunPanel:owner%2Btest%40example.test?'));
  const code = new TOTP({ secret: enrollment.secret }).generate({ timestamp: 90_000 });
  assert.equal(matchTotp(enrollment.secret, code, 90_000), 3);
});

test('recovery codes have 128 random bits each and user-scoped digests', () => {
  const codes = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const code of codes) assert.match(code, /^(?:[a-f0-9]{4}-){7}[a-f0-9]{4}$/);
  assert.equal(recoveryDigest('u', codes[0]), recoveryDigest('u', codes[0].toUpperCase().replaceAll('-', '')));
  assert.notEqual(recoveryDigest('u', codes[0]), recoveryDigest('v', codes[0]));
  assert.equal(recoveryDigest('u', 'bad'), null);
});
