import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createMfaStore } from '../src/mfa-store.js';
import { AuthError } from '../src/auth-error.js';
import { newToken, tokenDigest } from '../src/mfa-crypto.js';

/** Real SQLite/crypto fixture; ONLY the pre-existing password KDF is a test double. */
export function mfaFixture(t, { filePath = ':memory:', masterKey = randomBytes(32), clock = { value: 1_700_000_010_000 }, seed = true, passwordVerifier } = {}) {
  const db = new DatabaseSync(filePath);
  t.after(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, user_id TEXT REFERENCES users(id), expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS auth_limits(key TEXT PRIMARY KEY, attempts INTEGER, expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS auth_events(actor_id TEXT, action TEXT);
  `);
  const now = () => clock.value;
  const transaction = (action) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const getSession = (raw) => {
    if (typeof raw !== 'string') return null;
    const row = db.prepare('SELECT s.*, u.username, u.active FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.token_hash=?').get(tokenDigest(raw));
    return row?.active && row.expires_at > now() ? { id: row.id, user: { id: row.user_id, username: row.username, role: 'owner' }, csrfToken: 'fixture-csrf' } : null;
  };
  const createSession = (userId) => {
    const token = newToken();
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(randomUUID(), tokenDigest(token), userId, now() + 12 * 60 * 60_000);
    return { token, session: getSession(token) };
  };
  const rateLimit = (keys) => {
    db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').run(now());
    for (const [key, maximum] of keys) {
      if (db.prepare('SELECT attempts FROM auth_limits WHERE key=?').get(key)?.attempts >= maximum) throw new AuthError('rate_limited', 'Rate limited', 429);
    }
    for (const [key] of keys) db.prepare('INSERT INTO auth_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1').run(key, now() + 15 * 60_000);
  };
  const mfa = createMfaStore({ db, now, masterKey, getSession, createSession, transaction, rateLimit,
    verifyPassword: passwordVerifier ?? (async (password, expected) => password === expected),
    audit: (actor, action) => db.prepare('INSERT INTO auth_events VALUES (?,?)').run(actor, action),
  });
  const userId = randomUUID();
  const password = randomBytes(32).toString('base64url');
  if (seed) db.prepare('INSERT INTO users VALUES (?,?,?,1)').run(userId, 'owner', password);
  return { db, mfa, now, clock, userId, password, getSession, createSession, transaction, ...(seed ? createSession(userId) : {}) };
}
