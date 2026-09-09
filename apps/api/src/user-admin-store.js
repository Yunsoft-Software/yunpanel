import { randomUUID } from 'node:crypto';
import { AuthError } from './auth-error.js';

const ROLES = new Set(['owner', 'read_only']);
const conflict = () => new AuthError('user_revision_conflict', 'This account changed. Reload it before saving.', 409);
const missing = () => new AuthError('user_not_found', 'Account not found.', 404);

function fields(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new AuthError('invalid_user_input', 'Send only the documented account fields.');
  }
}
function role(value) {
  if (!ROLES.has(value)) throw new AuthError('invalid_role', 'Choose owner or read_only.');
  return value;
}
function active(value) {
  if (typeof value !== 'boolean') throw new AuthError('invalid_active', 'Active must be a boolean.');
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new AuthError('invalid_revision', 'A current account revision is required.');
  return value;
}

/** Shares the existing auth DB, native password helper and synchronous transaction.
 * The HTTP caller supplies its live Owner/MFA policy, never a client-supplied role.
 * Additive sidecar tables leave the existing users/session/MFA schema compatible.
 */
export function createUserAdminStore({ db, now, transaction, getSession, hashPassword, normalizeUsername, mfa, audit }) {
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_user_admin_schema (
        id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO auth_user_admin_schema VALUES (1, 1);
    `);
    if (db.prepare('SELECT version FROM auth_user_admin_schema WHERE id = 1').get().version !== 1) {
      throw new Error('Unsupported user administration schema');
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_user_revisions (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision >= 1), updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_user_admin_events (
        id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, target_id TEXT NOT NULL,
        action TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  });
  const select = `SELECT u.id, u.username, u.role, u.active, u.created_at,
    COALESCE(r.revision, 1) AS revision, COALESCE(r.updated_at, u.created_at) AS updated_at,
    EXISTS(SELECT 1 FROM auth_mfa m WHERE m.user_id = u.id) AS mfa_enabled
    FROM users u LEFT JOIN auth_user_revisions r ON r.user_id = u.id`;
  const read = (id) => db.prepare(`${select} WHERE u.id = ?`).get(id);
  const publicUser = (row) => ({
    id: row.id, username: row.username, role: row.role, active: Boolean(row.active),
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision, mfaEnabled: Boolean(row.mfa_enabled),
  });
  function requireActor(rawToken, requireManagement, expected = null) {
    if (typeof requireManagement !== 'function') throw new TypeError('A live management policy is required');
    const current = requireManagement(getSession(rawToken));
    if (!current?.id || current.user?.role !== 'owner') throw new AuthError('forbidden', 'Owner access is required.', 403);
    if (expected && (expected.id !== current.id || expected.user.id !== current.user.id)) {
      throw new AuthError('unauthorized', 'Sign in to continue.', 401);
    }
    return current;
  }
  function record(actorId, targetId, action) {
    db.prepare('DELETE FROM auth_user_admin_events WHERE created_at < ?').run(now() - 90 * 24 * 60 * 60_000);
    db.prepare('INSERT INTO auth_user_admin_events(actor_id, target_id, action, created_at) VALUES (?, ?, ?, ?)').run(actorId, targetId, action, now());
    audit(actorId, action);
  }
  function existing(id, expectedRevision) {
    if (typeof id !== 'string' || id.length > 128) throw missing();
    const user = read(id);
    if (!user) throw missing();
    if (user.revision !== revision(expectedRevision)) throw conflict();
    return user;
  }
  function unique(name, excludingId = '') {
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(name, excludingId)) {
      throw new AuthError('username_taken', 'An account with that username already exists.', 409);
    }
  }
  function protectOwner(user, nextRole, nextActive) {
    if (user.role === 'owner' && user.active && (nextRole !== 'owner' || !nextActive)
      && db.prepare("SELECT count(*) AS count FROM users WHERE role = 'owner' AND active = 1").get().count <= 1) {
      throw new AuthError('last_owner', 'The last active Owner cannot be removed, disabled, or demoted.', 409);
    }
  }
  function revoke(userId) {
    mfa.invalidateUser(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  return {
    // Used to reject password logins that race a user lifecycle change.
    revision(userId) { return read(userId)?.revision ?? null; },
    list(rawToken, requireManagement, { offset = 0, limit = 50 } = {}) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new AuthError('invalid_pagination', 'Use a nonnegative offset and a limit from 1 to 100.');
      }
      return transaction(() => {
        requireActor(rawToken, requireManagement);
        const total = db.prepare('SELECT count(*) AS count FROM users').get().count;
        const users = db.prepare(`${select} ORDER BY u.username, u.id LIMIT ? OFFSET ?`).all(limit, offset).map(publicUser);
        return { users, total, offset, limit };
      });
    },
    async create(rawToken, requireManagement, input) {
      const actor = requireActor(rawToken, requireManagement);
      fields(input, ['username', 'password', 'role', 'active']);
      const name = normalizeUsername(input.username);
      const nextRole = role(input.role ?? 'owner');
      const nextActive = active(input.active ?? true);
      unique(name);
      const passwordHash = await hashPassword(input.password);
      return transaction(() => {
        requireActor(rawToken, requireManagement, actor);
        unique(name);
        const id = randomUUID();
        db.prepare('INSERT INTO users(id, username, password_hash, role, active, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(id, name, passwordHash, nextRole, Number(nextActive), now(), now());
        record(actor.user.id, id, 'user.created');
        return publicUser(read(id));
      });
    },
    update(rawToken, requireManagement, id, input) {
      fields(input, ['revision', 'username', 'role', 'active']);
      if (!['username', 'role', 'active'].some((key) => Object.hasOwn(input, key))) throw new AuthError('empty_user_update', 'Choose an account field to change.');
      return transaction(() => {
        const actor = requireActor(rawToken, requireManagement);
        const user = existing(id, input.revision);
        const name = Object.hasOwn(input, 'username') ? normalizeUsername(input.username) : user.username;
        const nextRole = Object.hasOwn(input, 'role') ? role(input.role) : user.role;
        const nextActive = Object.hasOwn(input, 'active') ? active(input.active) : Boolean(user.active);
        unique(name, id);
        protectOwner(user, nextRole, nextActive);
        if (user.username === name && user.role === nextRole && Boolean(user.active) === nextActive) return publicUser(user);
        if (user.revision === Number.MAX_SAFE_INTEGER) throw conflict();
        db.prepare('UPDATE users SET username = ?, role = ?, active = ? WHERE id = ?').run(name, nextRole, Number(nextActive), id);
        db.prepare('INSERT INTO auth_user_revisions VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at')
          .run(id, user.revision + 1, now());
        revoke(id);
        record(actor.user.id, id, 'user.updated');
        return publicUser(read(id));
      });
    },
    remove(rawToken, requireManagement, id, input) {
      fields(input, ['revision']);
      return transaction(() => {
        const actor = requireActor(rawToken, requireManagement);
        const user = existing(id, input.revision);
        protectOwner(user, null, false);
        revoke(id);
        db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM auth_mfa WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        record(actor.user.id, id, 'user.deleted');
      });
    },
  };
}
