import { argon2, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, lstatSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createAuditStore } from './audit-store.js';
import { AuthError, safeEqual } from './auth-error.js';
import { createAuthMailer, validateEmail } from './auth-mailer.js';
import { createMfaStore } from './mfa-store.js';
import { createProcessStoreLock, ProcessStoreLockError } from './process-store-lock.js';
import { createUserAdminStore } from './user-admin-store.js';
export { AuthError, safeEqual } from './auth-error.js';
export { validateEmail } from './auth-mailer.js';
export { ProcessStoreLockError } from './process-store-lock.js';

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
export function createAuthStore({
  filePath = defaultAuthPath(),
  now = Date.now,
  idleMs = 30 * 60_000,
  absoluteMs = 12 * 60 * 60_000,
  masterKey = process.env.YUNPANEL_SECRET_MASTER_KEY ?? null,
  liveSessions = null,
  revokeLiveUser: customRevokeLiveUser = null,
  mailer: customMailer = null,
  storeLockFactory = null,
  websiteLookup = null,
} = {}) {
  const mailer = customMailer ?? createAuthMailer();
  if (![idleMs, absoluteMs].every((value) => Number.isSafeInteger(value) && value > 0) || idleMs > absoluteMs) {
    throw new Error('Invalid authentication session lifetime');
  }
  if (liveSessions !== null && (!liveSessions || typeof liveSessions.revokeSession !== 'function'
    || typeof liveSessions.revokeUser !== 'function')) {
    throw new TypeError('Live session registry is invalid');
  }
  const revokeLiveSession = (sessionId, reason) => {
    if (!sessionId || !liveSessions) return;
    try { liveSessions.revokeSession(sessionId, reason); } catch {}
  };
  const revokeLiveUser = (userId, reason) => {
    if (typeof customRevokeLiveUser === 'function') {
      try { customRevokeLiveUser(userId, reason); } catch {}
    }
    if (!userId || !liveSessions) return;
    try { liveSessions.revokeUser(userId, reason); } catch {}
  };
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
  const resolvedLockFactory = storeLockFactory ?? createProcessStoreLock;
  let storeLock;
  if (filePath !== ':memory:') {
    try {
      storeLock = resolvedLockFactory({ filePath: path.resolve(filePath), now });
    } catch (err) {
      if (err instanceof ProcessStoreLockError) throw err;
      throw new Error(`Process store lock initialization failed: ${err.message}`);
    }
  } else {
    storeLock = storeLockFactory && storeLockFactory !== createProcessStoreLock
      ? storeLockFactory({ filePath: ':memory:', now })
      : { withLock: async (action) => action() };
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (![0, 1, 2].includes(version)) { db.close(); throw new Error('Unsupported auth database version'); }
  const userTable = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (userTable?.sql && !userTable.sql.includes("'site_manager'")) {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'read_only', 'site_manager', 'reseller', 'customer')), active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL, password_changed_at INTEGER NOT NULL
      );
      INSERT INTO users_new SELECT id, username, password_hash, role, active, created_at, password_changed_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      PRAGMA foreign_keys = ON;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'read_only', 'site_manager', 'reseller', 'customer')), active INTEGER NOT NULL DEFAULT 1,
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
    CREATE TABLE IF NOT EXISTS auth_user_websites (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      website_id TEXT NOT NULL,
      PRIMARY KEY (user_id, website_id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_user_websites_user ON auth_user_websites(user_id);
    CREATE TABLE IF NOT EXISTS auth_operation_users (
      operation_id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      website_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_operation_users_website ON auth_operation_users(website_id);
    CREATE INDEX IF NOT EXISTS idx_auth_operation_users_user ON auth_operation_users(user_id);
    CREATE TABLE IF NOT EXISTS auth_recovery_emails (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_recovery_emails_email ON auth_recovery_emails(email);
    CREATE TABLE IF NOT EXISTS auth_password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_password_resets_user ON auth_password_resets(user_id);
  `);
  let dummyHash;
  const publicUser = (row) => ({ id: row.id, username: row.username, role: row.role });
  const audit = createAuditStore({ db, now });
  const event = (actorId, action, resource = null, outcome = null, code = null) => {
    db.prepare('INSERT INTO auth_events(actor_id, action, created_at) VALUES (?, ?, ?)').run(actorId, action, now());
    const resourceType = resource?.type ?? (actorId ? 'user' : null);
    const resourceId = resource?.id ?? (actorId ?? null);
    audit.record({
      actorId,
      action,
      resourceType,
      resourceId,
      outcome: outcome ?? (action.endsWith('.failed') ? 'failed' : 'succeeded'),
      code,
    });
  };
  const transaction = (operation) => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const invalid = () => new AuthError('invalid_credentials', 'The credentials are invalid.', 401);

  function hostingLoginAllowed(userId) {
    const state = db.prepare(`SELECT h.kind, h.reseller_id,
        u.role AS user_role, u.active AS user_active,
        parent.kind AS parent_kind,
        parent_user.role AS parent_role,
        parent_user.active AS parent_active
      FROM auth_hosting_accounts h
      JOIN users u ON u.id = h.user_id
      LEFT JOIN auth_hosting_accounts parent ON parent.user_id = h.reseller_id
      LEFT JOIN users parent_user ON parent_user.id = parent.user_id
      WHERE h.user_id = ?`).get(userId);
    if (!state) return true;
    if (!['site_manager', 'reseller', 'customer'].includes(state.user_role) || state.user_active !== 1) return false;
    if (state.kind === 'reseller') return state.reseller_id === null;
    if (state.kind !== 'customer') return false;
    if (state.reseller_id === null) return true;
    return state.parent_kind === 'reseller'
      && ['site_manager', 'reseller'].includes(state.parent_role)
      && state.parent_active === 1;
  }

  function hostingSessionProfile(userId) {
    const row = db.prepare('SELECT kind, reseller_id AS resellerId FROM auth_hosting_accounts WHERE user_id = ?').get(userId);
    if (!row) return null;
    if (!['reseller', 'customer'].includes(row.kind)
      || (row.kind === 'reseller' && row.resellerId !== null)
      || (row.resellerId !== null && (typeof row.resellerId !== 'string' || !row.resellerId))) {
      throw new AuthError('hosting_account_state_invalid', 'Hosting account state requires recovery.', 503);
    }
    const profile = { kind: row.kind, resellerId: row.resellerId };
    if (row.kind === 'customer') {
      const quotaTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_customer_quotas'").get();
      if (quotaTable) {
        const quotaRow = db.prepare('SELECT max_websites AS maxWebsites, max_disk_mb AS maxDiskMb, max_traffic_mb AS maxTrafficMb, max_databases AS maxDatabases FROM auth_customer_quotas WHERE customer_id = ?').get(userId);
        if (quotaRow) {
          profile.quotas = {
            maxWebsites: quotaRow.maxWebsites,
            maxDiskMb: quotaRow.maxDiskMb,
            maxTrafficMb: quotaRow.maxTrafficMb,
            maxDatabases: quotaRow.maxDatabases,
          };
        }
      }
    }
    return profile;
  }

  function verifiedWebsiteIds(owned, attached) {
    if (owned.length !== attached.length || owned.some((websiteId, index) => websiteId !== attached[index])) {
      throw new AuthError('hosting_site_state_invalid', 'Site ownership state requires reconciliation.', 503);
    }
    return owned;
  }

  function websiteIdsForSession(userId, hosting) {
    if (hosting?.kind === 'reseller') {
      const owned = db.prepare(`SELECT w.website_id FROM auth_customer_websites w
        JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
        WHERE h.kind = 'customer' AND h.reseller_id = ? ORDER BY w.website_id`)
        .all(userId).map((row) => row.website_id);
      const attached = db.prepare(`SELECT a.website_id FROM auth_hosting_site_allocations a
        JOIN auth_hosting_accounts h ON h.user_id = a.customer_id
        WHERE h.kind = 'customer' AND h.reseller_id = ? AND a.state = 'attached' ORDER BY a.website_id`)
        .all(userId).map((row) => row.website_id);
      return verifiedWebsiteIds(owned, attached);
    }
    if (hosting?.kind === 'customer') {
      const owned = db.prepare('SELECT website_id FROM auth_customer_websites WHERE customer_id = ? ORDER BY website_id')
        .all(userId).map((row) => row.website_id);
      const attached = db.prepare("SELECT website_id FROM auth_hosting_site_allocations WHERE customer_id = ? AND state = 'attached' ORDER BY website_id")
        .all(userId).map((row) => row.website_id);
      return verifiedWebsiteIds(owned, attached);
    }
    return db.prepare('SELECT website_id FROM auth_user_websites WHERE user_id = ? ORDER BY website_id')
      .all(userId).map((row) => row.website_id);
  }

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
      revokeLiveSession(row.id, row.active ? 'session_expired' : 'user_disabled');
      return null;
    }
    if (!hostingLoginAllowed(row.user_id)) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
      revokeLiveSession(row.id, 'hosting_scope_inactive');
      return null;
    }
    if (touch) {
      db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now(), row.id);
      row.last_active_at = now();
    }
    const isHostingRole = ['site_manager', 'reseller', 'customer'].includes(row.role);
    const hosting = isHostingRole ? hostingSessionProfile(row.user_id) : null;
    const websiteIds = isHostingRole ? websiteIdsForSession(row.user_id, hosting) : null;
    const recovery = db.prepare('SELECT email, verified FROM auth_recovery_emails WHERE user_id = ?').get(row.user_id);
    return {
      id: row.id,
      user: {
        id: row.user_id,
        username: row.username,
        role: row.role,
        ...(recovery?.email ? { email: recovery.email, emailVerified: Boolean(recovery.verified) } : {}),
        ...(websiteIds !== null ? { websiteIds } : {}),
        ...(hosting !== null ? { hosting } : {}),
      },
      expiresAt: row.expires_at,
      idleExpiresAt: Math.min(row.expires_at, row.last_active_at + idleMs),
      csrfToken: csrfForSession(rawToken),
    };
  }

  function createSession(userId) {
    if (!hostingLoginAllowed(userId)) throw invalid();
    const rawToken = token();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_active_at <= ?').run(now(), now() - idleMs);
    db.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 9)').run(userId);
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), digest(rawToken), userId, now(), now(), now() + absoluteMs);
    return { token: rawToken, session: getSession(rawToken) };
  }

  let mfa;
  let users;
  try {
    mfa = createMfaStore({
      db, now, masterKey, getSession, verifyPassword, createSession, transaction, rateLimit, audit: event, revokeLiveUser,
    });
    users = createUserAdminStore({
      db, now, transaction, getSession, hashPassword, normalizeUsername: username, mfa, audit: event, revokeLiveUser,
    });
  } catch (error) { db.close(); throw error; }

  const adminUserSelect = `SELECT u.id, u.username, u.role, u.active, u.created_at,
    COALESCE(r.revision, 1) AS revision, COALESCE(r.updated_at, u.created_at) AS updated_at,
    EXISTS(SELECT 1 FROM auth_mfa m WHERE m.user_id = u.id) AS mfa_enabled
    FROM users u LEFT JOIN auth_user_revisions r ON r.user_id = u.id`;
  const readAdminUser = (userId) => db.prepare(`${adminUserSelect} WHERE u.id = ?`).get(userId);
  const formatAdminUser = (row) => {
    if (!row) return null;
    const websiteIds = row.role === 'site_manager'
      ? db.prepare('SELECT website_id FROM auth_user_websites WHERE user_id = ? ORDER BY website_id').all(row.id).map((r) => r.website_id)
      : undefined;
    return {
      id: row.id,
      username: row.username,
      role: row.role,
      active: Boolean(row.active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
      mfaEnabled: Boolean(row.mfa_enabled),
      ...(websiteIds !== undefined ? { websiteIds } : {}),
    };
  };

  function getOperationUser(operationId) {
    if (typeof operationId !== 'string' || !operationId) {
      throw new AuthError('invalid_operation_id', 'operationId must be a non-empty string.');
    }
    const row = db.prepare('SELECT operation_id, user_id, website_id, created_at FROM auth_operation_users WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    const user = formatAdminUser(readAdminUser(row.user_id));
    return {
      operationId: row.operation_id,
      userId: row.user_id,
      websiteId: row.website_id,
      createdAt: row.created_at,
      user,
    };
  }

  function reconcileOperationUser(operationId, websiteId) {
    if (typeof operationId !== 'string' || !operationId) {
      throw new AuthError('invalid_operation_id', 'operationId must be a non-empty string.');
    }
    if (typeof websiteId !== 'string' || !websiteId) {
      throw new AuthError('invalid_website_ids', 'websiteId must be a non-empty string.');
    }
    const row = db.prepare('SELECT operation_id, user_id, website_id, created_at FROM auth_operation_users WHERE operation_id = ?').get(operationId);
    if (!row) return null;
    if (row.website_id !== websiteId) {
      throw new AuthError('operation_user_conflict', 'Operation is already associated with a different website.', 409);
    }
    const user = formatAdminUser(readAdminUser(row.user_id));
    if (!user || user.role !== 'site_manager' || !user.active) {
      throw new AuthError('operation_user_invalid', 'Reconciled user is inactive or not a site manager.', 409);
    }
    if (!Array.isArray(user.websiteIds) || !user.websiteIds.includes(websiteId)) {
      throw new AuthError('operation_user_invalid', 'Reconciled user is not attached to the target website.', 409);
    }
    return user;
  }

  async function createSiteManager({
    username: inputUsername,
    password: inputPassword,
    websiteId,
    actorId = 'system',
    operationId = null,
    rawToken = null,
    requireManagement = null,
    websiteLookup: customWebsiteLookup = null,
  } = {}) {
    const activeWebsiteLookup = customWebsiteLookup ?? websiteLookup;
    return storeLock.withLock(async () => {
      const name = username(inputUsername);
      if (typeof websiteId !== 'string' || !websiteId) {
        throw new AuthError('invalid_website_ids', 'websiteId is required.');
      }
      if (operationId !== null && (typeof operationId !== 'string' || !operationId)) {
        throw new AuthError('invalid_operation_id', 'operationId must be a non-empty string.');
      }

      if (operationId) {
        const reconciled = reconcileOperationUser(operationId, websiteId);
        if (reconciled) {
          if (reconciled.username !== name) {
            throw new AuthError('operation_user_conflict', 'Operation is already associated with a different username.', 409);
          }
          return reconciled;
        }
      }

      // Pre-hash live actor check
      if (rawToken) {
        const session = getSession(rawToken);
        if (!session) throw invalid();
        if (typeof requireManagement === 'function') requireManagement(session);
      } else if (actorId && actorId !== 'system') {
        const actor = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(actorId);
        if (!actor || actor.active !== 1) {
          throw new AuthError('forbidden', 'Actor is inactive or not found.', 403);
        }
      }

      // Pre-hash live website check
      if (typeof activeWebsiteLookup === 'function') {
        const exists = await activeWebsiteLookup(websiteId);
        if (!exists) {
          throw new AuthError('website_not_found', 'Target website does not exist.', 404);
        }
      }

      if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
        throw new AuthError('username_taken', 'This username is already taken.', 409);
      }

      const passwordHash = await hashPassword(inputPassword);

      // Post-hash live actor check (fail-closed)
      if (rawToken) {
        const session = getSession(rawToken);
        if (!session) {
          throw new AuthError('forbidden', 'Actor authorization was revoked during password hashing.', 403);
        }
        if (typeof requireManagement === 'function') requireManagement(session);
      } else if (actorId && actorId !== 'system') {
        const actor = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(actorId);
        if (!actor || actor.active !== 1) {
          throw new AuthError('forbidden', 'Actor authorization was revoked during password hashing.', 403);
        }
      }

      // Post-hash live website check (fail-closed)
      if (typeof activeWebsiteLookup === 'function') {
        const stillExists = await activeWebsiteLookup(websiteId);
        if (!stillExists) {
          throw new AuthError('website_not_found', 'Target website was removed during password hashing.', 404);
        }
      }

      return transaction(() => {
        if (db.prepare('SELECT id FROM users WHERE username = ?').get(name)) {
          throw new AuthError('username_taken', 'This username is already taken.', 409);
        }
        if (operationId) {
          const opRow = db.prepare('SELECT operation_id, user_id, website_id FROM auth_operation_users WHERE operation_id = ?').get(operationId);
          if (opRow) {
            if (opRow.website_id !== websiteId) {
              throw new AuthError('operation_user_conflict', 'Operation is already associated with a different website.', 409);
            }
            return formatAdminUser(readAdminUser(opRow.user_id));
          }
        }

        const id = randomUUID();
        db.prepare('INSERT INTO users(id, username, password_hash, role, active, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, name, passwordHash, 'site_manager', 1, now(), now());
        db.prepare('INSERT OR IGNORE INTO auth_user_websites(user_id, website_id) VALUES (?, ?)').run(id, websiteId);
        if (operationId) {
          db.prepare('INSERT INTO auth_operation_users(operation_id, user_id, website_id, created_at) VALUES (?, ?, ?, ?)')
            .run(operationId, id, websiteId, now());
        }
        try {
          db.prepare('DELETE FROM auth_user_admin_events WHERE created_at < ?').run(now() - 90 * 24 * 60 * 60_000);
          db.prepare('INSERT INTO auth_user_admin_events(actor_id, target_id, action, created_at) VALUES (?, ?, ?, ?)').run(actorId, id, 'user.created', now());
        } catch {}
        event(actorId, 'user.created', { type: 'user', id });
        return formatAdminUser(readAdminUser(id));
      });
    });
  }

  users.createSiteManager = createSiteManager;
  users.getOperationUser = getOperationUser;
  users.reconcileOperationUser = reconcileOperationUser;
  users.storeLock = storeLock;
  users.withLock = (fn) => storeLock.withLock(fn);

  return {
    mfa,
    users,
    hostingAccounts: users.hostingAccounts,
    audit,
    getOperationUser,
    reconcileOperationUser,
    storeLock,
    withLock: (fn) => storeLock.withLock(fn),
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
    async completeSetup({ setupToken, username: input, password, email = null, peer = 'local' }) {
      rateLimit([['setup:global', 30], [`setup:${digest(peer)}`, 10]]);
      const check = () => {
        if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new AuthError('already_configured', 'An owner already exists.', 409);
        const row = db.prepare('SELECT * FROM setup WHERE id = 1').get();
        if (typeof setupToken !== 'string' || !TOKEN_PATTERN.test(setupToken) || !row || row.expires_at <= now() || !safeEqual(row.token_hash, digest(setupToken))) throw invalid();
      };
      check();
      const name = username(input);
      const validatedEmail = email ? validateEmail(email) : null;
      const passwordHash = await hashPassword(password);
      return transaction(() => {
        check();
        const id = randomUUID();
        db.prepare("INSERT INTO users VALUES (?, ?, ?, 'owner', 1, ?, ?)").run(id, name, passwordHash, now(), now());
        if (validatedEmail) {
          db.prepare('INSERT INTO auth_recovery_emails(user_id, email, verified, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(id, validatedEmail, now(), now());
        }
        db.prepare('DELETE FROM setup').run();
        event(id, 'owner.setup');
        return publicUser({ id, username: name, role: 'owner' });
      });
    },
    async login({ username: input, password, peer = 'local', previousToken = null }) {
      const name = typeof input === 'string' ? input.trim().toLowerCase().slice(0, 128) : '';
      rateLimit([['login:global', 120], [`login:peer:${digest(peer)}`, 40], [`login:user:${digest(name)}`, 10]]);
      const user = db.prepare(`SELECT u.*, COALESCE(r.revision, 1) AS admin_revision
        FROM users u LEFT JOIN auth_user_revisions r ON r.user_id = u.id WHERE u.username = ?`).get(name);
      const userRevision = user?.admin_revision ?? null;
      dummyHash ??= hashPassword(token()).catch((error) => { dummyHash = null; throw error; });
      const fallback = await dummyHash;
      const expected = user?.password_hash ?? fallback;
      const valid = await verifyPassword(password, expected);
      const previousSession = getSession(previousToken);
      const result = transaction(() => {
        const current = user && db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        if (!valid || !current?.active || current.password_hash !== expected
          || users.revision(current.id) !== userRevision || !hostingLoginAllowed(current.id)) return null;
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
      if (previousSession) revokeLiveSession(previousSession.id, 'session_rotated');
      return result;
    },
    getSession,
    getSessionById(sessionId) {
      if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) return null;
      const row = db.prepare(`SELECT s.*, u.username, u.role, u.active FROM sessions s
        JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(sessionId);
      if (!row) return null;
      if (!row.active || row.expires_at <= now() || row.last_active_at + idleMs <= now()) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
        revokeLiveSession(row.id, row.active ? 'session_expired' : 'user_disabled');
        return null;
      }
      if (!hostingLoginAllowed(row.user_id)) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
        revokeLiveSession(row.id, 'hosting_scope_inactive');
        return null;
      }
      const isHostingRole = ['site_manager', 'reseller', 'customer'].includes(row.role);
      const hosting = isHostingRole ? hostingSessionProfile(row.user_id) : null;
      const websiteIds = isHostingRole ? websiteIdsForSession(row.user_id, hosting) : null;
      const recovery = db.prepare('SELECT email, verified FROM auth_recovery_emails WHERE user_id = ?').get(row.user_id);
      return Object.freeze({
        id: row.id,
        user: Object.freeze({
          id: row.user_id,
          username: row.username,
          role: row.role,
          ...(recovery?.email ? { email: recovery.email, emailVerified: Boolean(recovery.verified) } : {}),
          ...(websiteIds !== null ? { websiteIds: Object.freeze(websiteIds) } : {}),
          ...(hosting !== null ? { hosting: Object.freeze(hosting) } : {}),
        }),
        expiresAt: row.expires_at,
        idleExpiresAt: Math.min(row.expires_at, row.last_active_at + idleMs),
      });
    },
    listSessions(rawToken) {
      const current = getSession(rawToken);
      if (!current) throw invalid();
      return db.prepare('SELECT id, created_at AS createdAt, last_active_at AS lastActiveAt, expires_at AS expiresAt FROM sessions WHERE user_id = ? AND expires_at > ? AND last_active_at > ? ORDER BY created_at DESC').all(current.user.id, now(), now() - idleMs).map((session) => ({ ...session, current: session.id === current.id }));
    },
    revokeSession(rawToken, sessionId = null, reason = 'session_revoked') {
      const current = getSession(rawToken);
      if (!current) return;
      const targetSessionId = sessionId ?? current.id;
      const revoked = transaction(() => {
        const changed = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(current.user.id, targetSessionId).changes === 1;
        event(current.user.id, 'session.revoked');
        return changed;
      });
      if (revoked) revokeLiveSession(targetSessionId, reason);
    },
    revokeAll(rawToken, reason = 'user_sessions_revoked') {
      const current = getSession(rawToken);
      if (!current) throw invalid();
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(current.user.id);
        mfa.invalidateUser(current.user.id);
        event(current.user.id, 'sessions.revoked');
      });
      revokeLiveUser(current.user.id, reason);
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
      revokeLiveUser(user.id, 'password_changed');
    },
    async resetPassword(input, newPassword) {
      const name = username(input);
      const encoded = await hashPassword(newPassword);
      const userId = transaction(() => {
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(name);
        if (!user) throw new AuthError('user_not_found', 'Active user not found.', 404);
        db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(encoded, now(), user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
        db.prepare('DELETE FROM auth_limits').run();
        mfa.invalidateUser(user.id);
        event(user.id, 'password.recovered_locally');
        return user.id;
      });
      revokeLiveUser(userId, 'password_recovered');
    },
    mailer,
    getRecoveryEmail(userId) {
      if (typeof userId !== 'string' || !userId) throw new AuthError('invalid_user', 'A valid user ID is required.');
      const row = db.prepare('SELECT email, verified, updated_at FROM auth_recovery_emails WHERE user_id = ?').get(userId);
      return {
        email: row?.email ?? null,
        verified: Boolean(row?.verified),
        updatedAt: row?.updated_at ?? null,
      };
    },
    setRecoveryEmail(userId, inputEmail, { verified = true } = {}) {
      if (typeof userId !== 'string' || !userId) throw new AuthError('invalid_user', 'A valid user ID is required.');
      const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(userId);
      if (!user || user.role !== 'owner' || !user.active) {
        throw new AuthError('forbidden', 'Owner access is required.', 403);
      }
      if (inputEmail === null || inputEmail === undefined || inputEmail === '') {
        return transaction(() => {
          db.prepare('DELETE FROM auth_recovery_emails WHERE user_id = ?').run(userId);
          event(userId, 'owner.recovery_email_removed');
          return { email: null, verified: false };
        });
      }
      const normalized = validateEmail(inputEmail);
      return transaction(() => {
        const existing = db.prepare('SELECT user_id FROM auth_recovery_emails WHERE email = ? AND user_id != ?').get(normalized, userId);
        if (existing) {
          throw new AuthError('email_in_use', 'Bu e-posta adresi başka bir hesap tarafından kullanılıyor.', 409);
        }
        db.prepare('INSERT INTO auth_recovery_emails (user_id, email, verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified = excluded.verified, updated_at = excluded.updated_at')
          .run(userId, normalized, verified ? 1 : 0, now(), now());
        event(userId, 'owner.recovery_email_updated');
        return { email: normalized, verified: Boolean(verified) };
      });
    },
    getRecoveryEmailByUsername(input) {
      const name = username(input);
      const user = db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(name);
      if (!user) throw new AuthError('user_not_found', 'Active user not found.', 404);
      return this.getRecoveryEmail(user.id);
    },
    setRecoveryEmailByUsername(input, emailInput, options) {
      const name = username(input);
      const user = db.prepare('SELECT id FROM users WHERE username = ? AND active = 1').get(name);
      if (!user) throw new AuthError('user_not_found', 'Active user not found.', 404);
      return this.setRecoveryEmail(user.id, emailInput, options);
    },
    async requestPasswordReset({ identifier, peer = 'local', origin = null }) {
      if (typeof identifier !== 'string' || !identifier.trim()) {
        throw new AuthError('invalid_identifier', 'Kullanıcı adı veya kurtarma e-postası girin.');
      }
      const cleanId = identifier.trim().toLowerCase();
      rateLimit([
        ['reset_request:global', 30],
        [`reset_request:peer:${digest(peer)}`, 10],
        [`reset_request:user:${digest(cleanId)}`, 5],
      ]);

      const smtpReady = await mailer.isAvailable();
      if (!smtpReady) {
        throw new AuthError('smtp_unavailable', 'E-posta servisi şu anda kullanılamıyor. Parola sıfırlama e-postası gönderilemiyor.', 503);
      }

      const candidate = db.prepare(`
        SELECT u.id, u.username, u.role, u.active, r.email AS recovery_email, r.verified AS email_verified
        FROM users u
        LEFT JOIN auth_recovery_emails r ON r.user_id = u.id
        WHERE (u.username = ? OR LOWER(r.email) = ?)
          AND u.role = 'owner'
          AND u.active = 1
      `).get(cleanId, cleanId);

      if (candidate?.recovery_email && candidate.email_verified) {
        const rawToken = token();
        const tokenHash = digest(rawToken);
        const expiresAt = now() + 15 * 60_000;

        transaction(() => {
          db.prepare('DELETE FROM auth_password_resets WHERE user_id = ? OR expires_at <= ?').run(candidate.id, now());
          db.prepare('INSERT INTO auth_password_resets (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(randomUUID(), candidate.id, tokenHash, expiresAt, now());
          event(candidate.id, 'password_reset.requested');
        });

        const effectiveOrigin = origin || 'http://localhost:5173';
        const resetUrl = `${effectiveOrigin}/#reset-token=${encodeURIComponent(rawToken)}`;
        try {
          await mailer.sendPasswordResetEmail({
            to: candidate.recovery_email,
            username: candidate.username,
            token: rawToken,
            resetUrl,
            expiresAt,
            origin: effectiveOrigin,
          });
        } catch (error) {
          db.prepare('DELETE FROM auth_password_resets WHERE token_hash = ?').run(tokenHash);
          event(candidate.id, 'password_reset.delivery_failed', null, 'failed', 'delivery_failed');
          throw new AuthError('mail_delivery_failed', 'Kurtarma e-postası gönderilemedi.', 503);
        }
      } else {
        dummyHash ??= hashPassword(token()).catch((error) => { dummyHash = null; throw error; });
        await dummyHash;
      }

      return { sent: true };
    },
    async resetPasswordWithToken({ token: rawToken, newPassword, peer = 'local' }) {
      if (typeof rawToken !== 'string' || !TOKEN_PATTERN.test(rawToken)) {
        throw new AuthError('invalid_reset_token', 'Geçersiz veya süresi dolmuş parola sıfırlama bağlantısı.', 400);
      }
      validatePassword(newPassword);
      rateLimit([
        ['reset_confirm:global', 60],
        [`reset_confirm:peer:${digest(peer)}`, 20],
        [`reset_confirm:token:${digest(rawToken)}`, 5],
      ]);

      const tokenHash = digest(rawToken);
      const row = db.prepare(`
        SELECT r.id AS reset_id, r.expires_at, u.id AS user_id, u.username, u.role, u.active
        FROM auth_password_resets r
        JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = ?
      `).get(tokenHash);

      if (!row) {
        throw new AuthError('invalid_reset_token', 'Geçersiz veya süresi dolmuş parola sıfırlama bağlantısı.', 400);
      }
      if (row.expires_at <= now()) {
        db.prepare('DELETE FROM auth_password_resets WHERE id = ?').run(row.reset_id);
        throw new AuthError('reset_token_expired', 'Parola sıfırlama bağlantısının süresi dolmuş. Lütfen yeni bir bağlantı talep edin.', 400);
      }
      if (!row.active || row.role !== 'owner') {
        db.prepare('DELETE FROM auth_password_resets WHERE id = ?').run(row.reset_id);
        throw new AuthError('invalid_reset_token', 'Bu hesap devre dışı veya yetkisiz.', 401);
      }

      const encoded = await hashPassword(newPassword);

      const result = transaction(() => {
        const current = db.prepare('SELECT * FROM auth_password_resets WHERE token_hash = ?').get(tokenHash);
        if (!current || current.expires_at <= now()) {
          throw new AuthError('invalid_reset_token', 'Geçersiz veya süresi dolmuş parola sıfırlama bağlantısı.', 400);
        }
        db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
          .run(encoded, now(), row.user_id);
        db.prepare('DELETE FROM auth_password_resets WHERE user_id = ?').run(row.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
        mfa.invalidateUser(row.user_id);
        try {
          const revRow = db.prepare('SELECT revision FROM auth_user_revisions WHERE user_id = ?').get(row.user_id);
          if (revRow) {
            db.prepare('UPDATE auth_user_revisions SET revision = revision + 1, updated_at = ? WHERE user_id = ?')
              .run(now(), row.user_id);
          }
        } catch {}
        db.prepare('DELETE FROM auth_limits WHERE key = ?').run(`login:user:${digest(row.username)}`);
        event(row.user_id, 'password.reset_via_token');
        return { userId: row.user_id, username: row.username };
      });

      revokeLiveUser(result.userId, 'password_reset');
      return { reset: true, username: result.username };
    },
  };
}
