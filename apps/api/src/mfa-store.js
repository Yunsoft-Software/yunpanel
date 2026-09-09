import { AuthError } from './auth-error.js';
import { createMfaVault, createRecoveryCodes, createTotpEnrollment, isToken, matchTotp, newToken, recoveryDigest, tokenDigest } from './mfa-crypto.js';

const CHALLENGE_MS = 5 * 60_000;
const ENROLLMENT_MS = 10 * 60_000;
const invalidProof = () => new AuthError('mfa_invalid_code', 'The verification code is invalid or has already been used.', 401);
const invalidChallenge = () => new AuthError('mfa_challenge_expired', 'Sign in again to start a new verification attempt.', 401);

/** Shares the auth database/transactions; never opens another public authentication channel. */
export function createMfaStore({ db, now, masterKey, getSession, verifyPassword, createSession, transaction, rateLimit, audit }) {
  const vault = createMfaVault(masterKey);
  transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS auth_mfa (
      user_id TEXT PRIMARY KEY REFERENCES users(id), secret TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1
    );
    CREATE TABLE IF NOT EXISTS auth_mfa_pending (
      user_id TEXT PRIMARY KEY REFERENCES users(id), session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      secret TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_mfa_challenges (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS auth_mfa_challenge_user ON auth_mfa_challenges(user_id);
    CREATE TABLE IF NOT EXISTS auth_mfa_recovery (
      user_id TEXT NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL, PRIMARY KEY(user_id, code_hash)
    );
    PRAGMA user_version = 2;
  `));
  const enabled = (userId) => Boolean(db.prepare('SELECT 1 FROM auth_mfa WHERE user_id = ?').get(userId));
  const requireSession = (rawToken) => {
    const session = getSession(rawToken);
    if (!session) throw new AuthError('unauthorized', 'Sign in to continue.', 401);
    return session;
  };
  function invalidateUser(userId) {
    db.prepare('DELETE FROM auth_mfa_challenges WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM auth_mfa_pending WHERE user_id = ?').run(userId);
  }
  function revokeSessions(userId) {
    invalidateUser(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
  function replaceRecovery(userId) {
    const codes = createRecoveryCodes();
    db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ?').run(userId);
    const insert = db.prepare('INSERT INTO auth_mfa_recovery VALUES (?, ?)');
    for (const code of codes) insert.run(userId, recoveryDigest(userId, code));
    return codes;
  }
  async function confirmPassword(rawToken, password) {
    const session = requireSession(rawToken);
    rateLimit([[`mfa:settings:${session.user.id}`, 10]]);
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user.id);
    if (!(await verifyPassword(password, user.password_hash))) throw new AuthError('invalid_credentials', 'The credentials are invalid.', 401);
    // Recheck after the async password KDF; logout/reset in another process must win.
    const current = requireSession(rawToken);
    if (current.id !== session.id || db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user.id)?.password_hash !== user.password_hash) {
      throw new AuthError('unauthorized', 'Sign in to continue.', 401);
    }
    return { session, passwordHash: user.password_hash };
  }
  function recheck(rawToken, checked) {
    const session = requireSession(rawToken);
    if (session.id !== checked.session.id || db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user.id)?.password_hash !== checked.passwordHash) {
      throw new AuthError('unauthorized', 'Sign in to continue.', 401);
    }
    return session;
  }
  // Call only inside a write transaction: proof consumption and the protected action commit together.
  function consumeProof(userId, { code, method = 'totp' }) {
    const record = db.prepare('SELECT * FROM auth_mfa WHERE user_id = ?').get(userId);
    if (!record) return false;
    if (method === 'recovery') {
      const hash = recoveryDigest(userId, code);
      return hash !== null && db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ? AND code_hash = ?').run(userId, hash).changes === 1;
    }
    if (method !== 'totp') return false;
    const counter = matchTotp(vault.decrypt(userId, record.secret), code, now());
    if (counter === null || counter <= record.last_counter) return false;
    db.prepare('UPDATE auth_mfa SET last_counter = ? WHERE user_id = ?').run(counter, userId);
    return true;
  }

  return {
    enabled,
    invalidateUser,
    status(rawToken) {
      const session = requireSession(rawToken);
      const recovery = db.prepare('SELECT count(*) AS count FROM auth_mfa_recovery WHERE user_id = ?').get(session.user.id);
      return { enabled: enabled(session.user.id), keyConfigured: vault.configured, recoveryCodesRemaining: recovery.count };
    },
    async beginEnrollment(rawToken, password) {
      const checked = await confirmPassword(rawToken, password);
      return transaction(() => {
        const { user, id } = recheck(rawToken, checked);
        if (enabled(user.id)) throw new AuthError('mfa_already_enabled', 'Disable the existing authenticator before replacing it.', 409);
        const enrollment = createTotpEnrollment(user.username);
        const expiresAt = now() + ENROLLMENT_MS;
        db.prepare('DELETE FROM auth_mfa_pending WHERE expires_at <= ?').run(now());
        db.prepare('INSERT OR REPLACE INTO auth_mfa_pending VALUES (?, ?, ?, ?)').run(user.id, id, vault.encrypt(user.id, enrollment.secret), expiresAt);
        audit(user.id, 'mfa.enrollment.started');
        return { ...enrollment, expiresAt };
      });
    },
    confirmEnrollment(rawToken, code) {
      const { user } = requireSession(rawToken);
      rateLimit([[`mfa:enrollment:${user.id}`, 10]]);
      return transaction(() => {
        const session = requireSession(rawToken);
        const pending = db.prepare('SELECT * FROM auth_mfa_pending WHERE user_id = ?').get(user.id);
        if (!pending || pending.session_id !== session.id || pending.expires_at <= now() || enabled(user.id)) {
          throw new AuthError('mfa_enrollment_expired', 'Start authenticator setup again.', 409);
        }
        const counter = matchTotp(vault.decrypt(user.id, pending.secret), code, now());
        if (counter === null) throw invalidProof();
        db.prepare('INSERT INTO auth_mfa VALUES (?, ?, ?)').run(user.id, pending.secret, counter);
        const recoveryCodes = replaceRecovery(user.id);
        revokeSessions(user.id);
        const result = createSession(user.id);
        audit(user.id, 'mfa.enabled');
        return { ...result, recoveryCodes };
      });
    },
    cancelEnrollment(rawToken) {
      const session = requireSession(rawToken);
      db.prepare('DELETE FROM auth_mfa_pending WHERE user_id = ? AND session_id = ?').run(session.user.id, session.id);
    },
    // Called in the existing password-login transaction, after credentials were rechecked.
    createLoginChallenge(userId) {
      const challengeToken = newToken();
      const expiresAt = now() + CHALLENGE_MS;
      db.prepare('DELETE FROM auth_mfa_challenges WHERE expires_at <= ?').run(now());
      db.prepare('DELETE FROM auth_mfa_challenges WHERE token_hash IN (SELECT token_hash FROM auth_mfa_challenges WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 2)').run(userId);
      db.prepare('INSERT INTO auth_mfa_challenges VALUES (?, ?, ?, 0, ?)').run(tokenDigest(challengeToken), userId, expiresAt, now());
      return { mfaRequired: true, challengeToken, expiresAt };
    },
    cancelLogin(challengeToken) {
      if (isToken(challengeToken)) db.prepare('DELETE FROM auth_mfa_challenges WHERE token_hash = ?').run(tokenDigest(challengeToken));
    },
    completeLogin(challengeToken, proof, peer = 'local') {
      rateLimit([['mfa:global', 120], [`mfa:peer:${tokenDigest(peer)}`, 40]]);
      if (!isToken(challengeToken)) throw invalidChallenge();
      const hash = tokenDigest(challengeToken);
      const candidate = db.prepare('SELECT user_id FROM auth_mfa_challenges WHERE token_hash = ?').get(hash);
      if (!candidate) throw invalidChallenge();
      rateLimit([[`mfa:login:${candidate.user_id}`, 10]]);
      // Invalid proofs return an error sentinel so attempt increments are not rolled back.
      const result = transaction(() => {
        const challenge = db.prepare('SELECT c.*, u.active, u.username FROM auth_mfa_challenges c JOIN users u ON u.id = c.user_id WHERE c.token_hash = ?').get(hash);
        if (!challenge || !challenge.active || !enabled(challenge.user_id) || challenge.expires_at <= now() || challenge.attempts >= 5) {
          db.prepare('DELETE FROM auth_mfa_challenges WHERE token_hash = ?').run(hash);
          return { failure: invalidChallenge() };
        }
        db.prepare('UPDATE auth_mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(hash);
        if (!consumeProof(challenge.user_id, proof)) {
          if (challenge.attempts + 1 >= 5) db.prepare('DELETE FROM auth_mfa_challenges WHERE token_hash = ?').run(hash);
          audit(challenge.user_id, 'mfa.login.failed');
          return { failure: invalidProof() };
        }
        db.prepare('DELETE FROM auth_mfa_challenges WHERE token_hash = ?').run(hash);
        db.prepare('DELETE FROM auth_limits WHERE key = ?').run(`login:user:${tokenDigest(challenge.username)}`);
        const result = createSession(challenge.user_id);
        audit(challenge.user_id, proof.method === 'recovery' ? 'mfa.login.recovery' : 'mfa.login.succeeded');
        return result;
      });
      if (result.failure) throw result.failure;
      return result;
    },
    async regenerateRecovery(rawToken, password, proof) {
      const checked = await confirmPassword(rawToken, password);
      return transaction(() => {
        const { user } = recheck(rawToken, checked);
        if (!consumeProof(user.id, proof)) throw invalidProof();
        const recoveryCodes = replaceRecovery(user.id);
        revokeSessions(user.id);
        const result = createSession(user.id);
        audit(user.id, 'mfa.recovery.regenerated');
        return { ...result, recoveryCodes };
      });
    },
    async disable(rawToken, password, proof) {
      const checked = await confirmPassword(rawToken, password);
      transaction(() => {
        const { user } = recheck(rawToken, checked);
        if (!consumeProof(user.id, proof)) throw invalidProof();
        db.prepare('DELETE FROM auth_mfa WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ?').run(user.id);
        revokeSessions(user.id);
        audit(user.id, 'mfa.disabled');
      });
    },
    resetLocal(username) {
      if (typeof username !== 'string') throw new AuthError('invalid_username', 'Enter a username.');
      transaction(() => {
        const user = db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(username.trim().toLowerCase());
        if (!user) throw new AuthError('user_not_found', 'Active user not found.', 404);
        db.prepare('DELETE FROM auth_mfa WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ?').run(user.id);
        revokeSessions(user.id);
        db.prepare('DELETE FROM auth_limits WHERE key IN (?, ?, ?)').run(`mfa:login:${user.id}`, `mfa:settings:${user.id}`, `mfa:enrollment:${user.id}`);
        audit(user.id, 'mfa.recovered_locally');
      });
    },
  };
}
