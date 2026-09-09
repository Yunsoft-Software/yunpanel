import { authRequest, beginSessionTransition } from './session-client.js';

export function requireSession(value) {
  if (!value || typeof value.id !== 'string' || !value.id || !value.user
    || typeof value.user.id !== 'string' || typeof value.user.username !== 'string'
    || !['owner', 'read_only'].includes(value.user.role)
    || typeof value.csrfToken !== 'string' || !value.csrfToken
    || !Number.isFinite(value.expiresAt) || !Number.isFinite(value.idleExpiresAt)) {
    throw new Error('Sunucudan geçerli bir oturum alınamadı.');
  }
  return value;
}

export function loginOutcome(value) {
  if (value?.mfaRequired === true) {
    if (!Number.isFinite(value.expiresAt)) throw new Error('Doğrulama süresi alınamadı.');
    // Deliberately keep only public challenge metadata. Its credential stays in an HttpOnly cookie.
    return { status: 'mfa', expiresAt: value.expiresAt };
  }
  return { status: 'authenticated', session: requireSession(value) };
}

export async function passwordLogin(username, password, signal) {
  return loginOutcome(await authRequest('login', { method: 'POST', body: { username, password }, signal, notifyExpired: false }));
}

export function proofInput(code, method = 'totp') {
  if (!['totp', 'recovery'].includes(method) || typeof code !== 'string') throw new Error('Doğrulama yöntemini seçin.');
  const normalized = code.trim();
  if (method === 'totp' && !/^\d{6}$/.test(normalized)) throw new Error('Uygulamadaki 6 haneli kodu girin.');
  if (method === 'recovery' && !/^[a-f0-9]{32}$/i.test(normalized.replaceAll('-', ''))) throw new Error('Kurtarma kodunu eksiksiz girin.');
  return { code: normalized, method };
}

export async function verifyMfa(code, method, signal) {
  return requireSession(await authRequest('mfa/verify', { method: 'POST', body: proofInput(code, method), signal, notifyExpired: false }));
}

export async function rotateMfa(operation, body, signal) {
  if (!['mfa/confirm', 'mfa/recovery'].includes(operation)) throw new Error('Invalid MFA operation');
  const finish = beginSessionTransition();
  try {
    const result = await authRequest(operation, { method: 'POST', body, signal, allowDuringTransition: true });
    const session = requireSession(result?.session);
    if (!Array.isArray(result.recoveryCodes) || result.recoveryCodes.length !== 10
      || result.recoveryCodes.some((code) => typeof code !== 'string' || !/^(?:[a-f0-9]{4}-){7}[a-f0-9]{4}$/.test(code))) {
      throw new Error('Kurtarma kodları alınamadı. Oturumunuzu yenileyip yeni kodlar üretin.');
    }
    return { session, recoveryCodes: result.recoveryCodes };
  } finally { finish(); }
}

export function sessionDeadline(session, now = Date.now()) {
  const end = Math.min(session?.idleExpiresAt ?? 0, session?.expiresAt ?? 0);
  const remainingMs = Math.max(0, end - now);
  return { remainingMs, expired: remainingMs === 0, warning: remainingMs > 0 && remainingMs <= 120_000, absolute: end === session?.expiresAt };
}

// Suspend polling during mutations which invalidate the current session.
export async function endAuthenticatedSession(operation, body, signal) {
  if (!['logout', 'logout-all', 'password', 'mfa/disable'].includes(operation)) throw new Error('Invalid session operation');
  const finish = beginSessionTransition();
  try { return await authRequest(operation, { method: 'POST', body, signal, allowDuringTransition: true }); }
  finally { finish(); }
}
