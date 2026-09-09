import { DatabaseSync } from 'node:sqlite';
import { createUserAdminStore } from '../../src/user-admin-store.js';
import { AuthError } from '../../src/auth-error.js';

// Real SQLite/FK/transactions; controlled password and session adapters.
// These tests do NOT claim native Argon2 or HTTP/MFA-login integration.
export function fixture(t, hashPassword = async () => 'test-only-encoded-password') {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL, active INTEGER NOT NULL, created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE auth_mfa (user_id TEXT PRIMARY KEY REFERENCES users(id), secret TEXT);
    CREATE TABLE auth_mfa_pending (user_id TEXT PRIMARY KEY REFERENCES users(id), session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE);
    CREATE TABLE auth_mfa_challenges (token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
    CREATE TABLE auth_mfa_recovery (user_id TEXT REFERENCES users(id), code_hash TEXT);
    CREATE TABLE auth_events (actor_id TEXT, action TEXT);
  `);
  function seed(id, role = 'owner', active = 1) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1000, 1000)').run(id, id, 'test-only-hash', role, active);
    db.prepare('INSERT INTO sessions VALUES (?, ?)').run(`session-${id}`, id);
    db.prepare('INSERT INTO auth_mfa VALUES (?, ?)').run(id, 'test-only-ciphertext');
  }
  seed('owner');
  const getSession = (token) => {
    const row = db.prepare('SELECT s.id, u.id AS user_id, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.active = 1').get(token);
    return row ? { id: row.id, csrfToken: 'test-csrf', user: { id: row.user_id, role: row.role } } : null;
  };
  const policy = (session) => {
    if (!session) throw new AuthError('unauthorized', 'Sign in.', 401);
    if (session.user.role !== 'owner') throw new AuthError('forbidden', 'Owner required.', 403);
    if (!db.prepare('SELECT 1 FROM auth_mfa WHERE user_id = ?').get(session.user.id)) throw new AuthError('mfa_enrollment_required', 'Enroll.', 403);
    return session;
  };
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const options = {
    db, now: () => 2000, transaction, getSession, hashPassword,
    normalizeUsername(input) {
      if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9._@+-]{2,127}$/.test(input.trim().toLowerCase())) throw new AuthError('invalid_username', 'Invalid username.');
      return input.trim().toLowerCase();
    },
    mfa: {
      enabled: (id) => Boolean(db.prepare('SELECT 1 FROM auth_mfa WHERE user_id = ?').get(id)),
      invalidateUser(id) {
      db.prepare('DELETE FROM auth_mfa_pending WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM auth_mfa_challenges WHERE user_id = ?').run(id);
    } },
    audit: (actor, action) => db.prepare('INSERT INTO auth_events VALUES (?, ?)').run(actor, action),
  };
  return { db, seed, policy, options, getSession, store: createUserAdminStore(options), token: 'session-owner' };
}
