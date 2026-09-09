import { argon2, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { AuthError, safeEqual } from './auth-error.js';
import { createMfaStore } from './mfa-store.js';
export { AuthError, safeEqual } from './auth-error.js';

const derive = promisify(argon2);
const PASSWORD_PREFIX = '$argon2id$v=19$m=65536,t=3,p=1$';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
let activeHashes = 0;

export function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length < 12 || Buffer.byteLength(password) > 1024) {
    throw new AuthError('invalid_password', 'Use at least 12 characters and no more than 1024 bytes.');
  }
}

function username(value) {
  if (typeof value !== 'string') throw new AuthError('invalid_username', 'Enter a valid username.');
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@+-]{2,127}$/.test(normalized)) {
    throw new AuthError('invalid_username', 'Use 3–128 letters, numbers, or . _ @ + - characters.');
  }
  return normalized;
}

async function passwordBytes(password, salt) {
  if (activeHashes >= 2) throw new AuthError('auth_busy', 'Authentication is busy. Try again shortly.', 503, 2);
  activeHashes += 1;
  try {
    return await derive('argon2id', {
      message: password, nonce: salt, parallelism: 1, tagLength: 32, memory: 65536, passes: 3,
    });
  } finally {
    activeHashes -= 1;
  }
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const hash = await passwordBytes(password, salt);
  return `${PASSWORD_PREFIX}${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || !encoded?.startsWith(PASSWORD_PREFIX)) return false;
  const [saltText, hashText, extra] = encoded.slice(PASSWORD_PREFIX.length).split('$');
  if (!saltText || !hashText || extra !== undefined) return false;
  const salt = Buffer.from(saltText, 'base64');
  const expected = Buffer.from(hashText, 'base64');
  if (salt.length !== 16 || expected.length !== 32) return false;
  return timingSafeEqual(await passwordBytes(password, salt), expected);
}

export function csrfForSession(rawToken) {
  return createHmac('sha256', rawToken).update('yunpanel:csrf:v1').digest('base64url');
}

export function defaultAuthPath() {
  return process.env.YUNPANEL_AUTH_DB ?? path.resolve('.data/auth/auth.sqlite');
}

/** One SQLite transaction per mutation also coordinates the API with the local recovery CLI. */
export function createAuthStore({ filePath = defaultAuthPath(), now = Date.now, idleMs = 30 * 60_000, absoluteMs = 12 * 60 * 60_000, masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null } = {}) {
  if (![idleMs, absoluteMs].every((value) => Number.isSafeInteger(value) && value > 0) || idleMs > absoluteMs) {
    throw new Error('Invalid authentication session lifetime');
  }
  if (filePath !== ':memory:') {
    filePath = path.resolve(filePath);
    const directory = path.dirname(filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
      throw new Error('Auth database requires a private directory owned by the service user');
    }
    const fd = openSync(filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
      throw new Error('Auth database requires a service-owned regular file with mode 0600');
    }
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1, 2].includes(version)) { db.close(); throw new Error('Unsupported auth database version'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'read_only')), active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS setup (id INTEGER PRIMARY KEY CHECK(id = 1), token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_events (id INTEGER PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  let dummyHash;
  const publicUser = (row) => ({ id: row.id, username: row.username, role: row.role });
  const event = (actorId, action) => db.prepare('INSERT INTO auth_events(actor_id, action, created_at) VALUES (?, ?, ?)').run(actorId, action, now());
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const invalid = () => new AuthError('invalid_credentials', 'The credentials are invalid.', 401);

  function rateLimit(keys) {
    transaction(() => {
      db.prepare('DELETE FROM auth_limits WHERE expires_at <= ?').run(now());
      db.prepare('DELETE FROM auth_events WHERE created_at < ?').run(now() - 90 * 24 * 60 * 60_000);
      for (const [key, maximum] of keys) {
        const row = db.prepare('SELECT * FROM auth_limits WHERE key = ?').get(key);
        if (row?.attempts >= maximum) {
          throw new AuthError('rate_limited', 'Too many attempts. Try again later.', 429, Math.max(1, Math.ceil((row.expires_at - now()) / 1000)));
        }
      }
      for (const [key] of keys) {
        db.prepare('INSERT INTO auth_limits(key, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1').run(key, now() + 15 * 60_000);
      }
    });
  }

  function getSession(rawToken, { touch = false } = {}) {
    if (typeof rawToken !== 'string' || !TOKEN_PATTERN.test(rawToken)) return null;
    const row = db.prepare(`SELECT s.*, u.username, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(digest(rawToken));
    if (!row) return null;
    if (!row.active || row.expires_at <= now() || row.last_active_at + idleMs <= now()) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      return null;
    }
    if (touch) {
      db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now(), row.id);
      row.last_active_at = now();
    }
    return { id: row.id, user: { id: row.user_id, username: row.username, role: row.role }, expiresAt: row.expires_at, idleExpiresAt: Math.min(row.expires_at, row.last_active_at + idleMs), csrfToken: csrfForSession(rawToken) };
  }

  function createSession(userId) {
    const rawToken = token();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_active_at <= ?').run(now(), now() - idleMs);
    db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 9)').run(userId);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), digest(rawToken), userId, now(), now(), now() + absoluteMs);
    return { token: rawToken, session: getSession(rawToken) };
  }

  let mfa;
  try {
    mfa = createMfaStore({ db, now, masterKey, getSession, verifyPassword, createSession, transaction, rateLimit, audit: event });
  } catch (error) { db.close(); throw error; }

  return {
    mfa,
    close: () => db.close(),
    configured: () => Boolean(db.prepare('SELECT 1 FROM users LIMIT 1').get()),
    issueSetupToken() {
      return transaction(() => {
        if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new AuthError('already_configured', 'An owner already exists.', 409);
        const rawToken = token();
        const expiresAt = now() + 10 * 60_000;
        db.prepare('INSERT OR REPLACE INTO setup VALUES (1, ?, ?)').run(digest(rawToken), expiresAt);
        return { token: rawToken, expiresAt };
      });
    },
    async completeSetup({ setupToken, username: input, password, peer = 'local' }) {
      rateLimit([['setup:global', 30], [`setup:${digest(peer)}`, 10]]);
      const check = () => {
        if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new AuthError('already_configured', 'An owner already exists.', 409);
        const row = db.prepare('SELECT * FROM setup WHERE id = 1').get();
        if (typeof setupToken !== 'string' || !TOKEN_PATTERN.test(setupToken) || !row || row.expires_at <= now() || !safeEqual(row.token_hash, digest(setupToken))) throw invalid();
      };
      check();
      const name = username(input);
      const passwordHash = await hashPassword(password);
      return transaction(() => {
        check();
        const id = randomUUID();
        db.prepare("INSERT INTO users VALUES (?, ?, ?, 'owner', 1, ?, ?)").run(id, name, passwordHash, now(), now());
        db.prepare('DELETE FROM setup').run();
        event(id, 'owner.setup');
        return publicUser({ id, username: name, role: 'owner' });
      });
    },
    async login({ username: input, password, peer = 'local', previousToken = null }) {
      const name = typeof input === 'string' ? input.trim().toLowerCase().slice(0, 128) : '';
      rateLimit([['login:global', 120], [`login:peer:${digest(peer)}`, 40], [`login:user:${digest(name)}`, 10]]);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
      // Unknown users still pay the same KDF cost; no username-existence response.
      dummyHash ??= hashPassword(token()).catch((error) => { dummyHash = null; throw error; });
      const fallback = await dummyHash;
      const expected = user?.password_hash ?? fallback;
      const valid = await verifyPassword(password, expected);
      const result = transaction(() => {
        const current = user && db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        if (!valid || !current?.active || current.password_hash !== expected) return null;
        if (typeof previousToken === 'string' && TOKEN_PATTERN.test(previousToken)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(previousToken));
        if (mfa.enabled(current.id)) {
          event(current.id, 'login.password_verified');
          return mfa.createLoginChallenge(current.id);
        }
        db.prepare('DELETE FROM auth_limits WHERE key = ?').run(`login:user:${digest(name)}`);
        const result = createSession(current.id);
        event(current.id, 'login.succeeded');
        return result;
      });
      if (!result) { event(null, 'login.failed'); throw invalid(); }
      return result;
    },
    getSession,
    listSessions(rawToken) {
      const current = getSession(rawToken);
      if (!current) throw invalid();
      return db.prepare('SELECT id, created_at AS createdAt, last_active_at AS lastActiveAt, expires_at AS expiresAt FROM sessions WHERE user_id = ? AND expires_at > ? AND last_active_at > ? ORDER BY created_at DESC').all(current.user.id, now(), now() - idleMs).map((session) => ({ ...session, current: session.id === current.id }));
    },
    revokeSession(rawToken, sessionId = null) {
      const current = getSession(rawToken);
      if (!current) return;
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(current.user.id, sessionId ?? current.id);
        event(current.user.id, 'session.revoked');
      });
    },
    revokeAll(rawToken) {
      const current = getSession(rawToken);
      if (!current) throw invalid();
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.user.id);
        mfa.invalidateUser(current.user.id);
        event(current.user.id, 'sessions.revoked');
      });
    },
    async changePassword(rawToken, currentPassword, newPassword) {
      const current = getSession(rawToken);
      if (!current) throw invalid();
      rateLimit([[`password:${current.user.id}`, 10]]);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(current.user.id);
      if (!(await verifyPassword(currentPassword, user.password_hash))) throw invalid();
      const encoded = await hashPassword(newPassword);
      transaction(() => {
        if (!getSession(rawToken) || db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id)?.password_hash !== user.password_hash) throw invalid();
        db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(encoded, now(), user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        mfa.invalidateUser(user.id);
        event(user.id, 'password.changed');
      });
    },
    async resetPassword(input, newPassword) {
      const name = username(input);
      const encoded = await hashPassword(newPassword);
      transaction(() => {
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(name);
        if (!user) throw new AuthError('user_not_found', 'Active user not found.', 404);
        db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(encoded, now(), user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM auth_limits').run();
        mfa.invalidateUser(user.id);
        event(user.id, 'password.recovered_locally');
      });
    },
  };
}
