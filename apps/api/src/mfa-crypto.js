import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { AuthError } from './auth-error.js';

export const tokenDigest = (value) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export function createMfaVault(masterKey) {
  let key = null;
  if (masterKey != null && masterKey !== '') {
    const raw = Buffer.isBuffer(masterKey) ? masterKey
      : typeof masterKey === 'string' && /^[a-f0-9]{64}$/i.test(masterKey) ? Buffer.from(masterKey, 'hex')
        : typeof masterKey === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(masterKey) ? Buffer.from(masterKey, 'base64') : null;
    if (raw?.length !== 32) throw new AuthError('invalid_secret_master_key', 'MFA requires a 32-byte master key encoded as hex or base64.', 503);
    // Separate the MFA encryption key from application-environment encryption.
    key = Buffer.from(hkdfSync('sha256', raw, 'yunpanel:mfa:v1', 'totp-secrets', 32));
  }
  const requireKey = () => {
    if (!key) throw new AuthError('mfa_key_unavailable', 'The server MFA encryption key is not configured.', 503);
  };
  return {
    configured: key !== null,
    encrypt(userId, secret) {
      requireKey();
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`yunpanel:mfa:v1:${userId}`));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
    },
    decrypt(userId, envelope) {
      requireKey();
      try {
        if (typeof envelope !== 'string' || envelope.length > 1024) throw new Error('Invalid envelope');
        const record = JSON.parse(envelope);
        const iv = Buffer.from(record.iv, 'base64');
        const tag = Buffer.from(record.tag, 'base64');
        if (record.version !== 1 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid envelope');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`yunpanel:mfa:v1:${userId}`));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      } catch {
        throw new AuthError('mfa_key_unavailable', 'The stored MFA secret cannot be decrypted. Use the documented recovery procedure.', 503);
      }
    },
  };
}

export function createTotpEnrollment(label) {
  const totp = new TOTP({ issuer: 'YunPanel', label, algorithm: 'SHA1', digits: 6, period: 30, secret: new Secret({ size: 20 }) });
  return { secret: totp.secret.base32, uri: totp.toString() };
}

/** Returns the absolute matched time step, not a truthy/falsy delta. Zero is valid. */
export function matchTotp(secret, code, timestamp) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const totp = new TOTP({ secret, algorithm: 'SHA1', digits: 6, period: 30 });
  const delta = totp.validate({ token: code, timestamp, window: 1 });
  return delta === null ? null : totp.counter({ timestamp }) + delta;
}

export function createRecoveryCodes() {
  return Array.from({ length: 10 }, () => randomBytes(16).toString('hex').match(/.{4}/g).join('-'));
}

export function recoveryDigest(userId, code) {
  if (typeof code !== 'string' || code.length > 64) return null;
  const normalized = code.trim().toLowerCase().replaceAll('-', '');
  return /^[a-f0-9]{32}$/.test(normalized) ? tokenDigest(`yunpanel:mfa:recovery:${userId}:${normalized}`) : null;
}
