import { DatabaseSync } from 'node:sqlite';
import { AuthError } from '../src/auth-error.js';

/** Real SQLite / deterministic auth-policy fixture; no password KDF or HTTP server. */
export function hostingAuthFixture(filePath = ':memory:') {
  const db = new DatabaseSync(filePath);
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'read_only', 'site_manager')), active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_user_websites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, website_id TEXT NOT NULL,
      PRIMARY KEY(user_id, website_id)
    );
    CREATE TABLE IF NOT EXISTS auth_user_revisions (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision >= 1), updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_mfa (user_id TEXT PRIMARY KEY REFERENCES users(id), secret TEXT);
    CREATE TABLE IF NOT EXISTS auth_mfa_recovery (user_id TEXT REFERENCES users(id), code TEXT);
    CREATE TABLE IF NOT EXISTS fixture_pending_mfa (user_id TEXT REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS fixture_audit (actor TEXT, action TEXT, resource TEXT);
  `);
  const now = () => 1000;
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function addUser(id, { role = 'site_manager', active = true } = {}) {
    db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 1000, 1000)').run(id, id, 'fixture-hash-not-a-password', role, Number(active));
  }
  function session(id) {
    db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, 1000, 1000, 99999)').run(`session-${id}`, `token-${id}`, id);
    return `token-${id}`;
  }
  const getSession = (token) => {
    const row = db.prepare('SELECT s.id, u.id AS userId, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').get(token ?? '');
    return row?.active ? { id: row.id, user: { id: row.userId, role: row.role } } : null;
  };
  const requireManagement = (current) => {
    if (!current) throw new AuthError('unauthorized', 'Sign in.', 401);
    if (current.user.role !== 'owner') throw new AuthError('forbidden', 'Owner only.', 403);
    return current;
  };
  const revoked = [];
  const revokeLiveUser = (id, reason) => revoked.push({ id, reason });
  const mfa = { invalidateUser: (id) => db.prepare('DELETE FROM fixture_pending_mfa WHERE user_id = ?').run(id) };
  const audit = (actor, action, resource) => db.prepare('INSERT INTO fixture_audit VALUES (?, ?, ?)').run(actor, action, resource?.id ?? null);
  return { db, now, transaction, addUser, session, getSession, requireManagement, mfa, audit, revoked, revokeLiveUser };
}
