import { AuthError } from './auth-error.js';
import { createHostingSiteAllocationStore } from './hosting-site-allocation-store.js';
import { hostingWebsitesForCapacity } from './hosting-site-allocation-schema.js';
import { initializeHostingAccountSchema } from './hosting-account-schema.js';
import { assertCustomerCreationScope, assertResellerManagement, validateHostingAccount } from './reseller-scope.js';
import { assertResellerCapacity, countResellerUsage, validateResellerLimits } from './reseller-limits.js';

const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const error = (code, message, status = 400) => new AuthError(code, message, status);
const missing = () => error('hosting_account_not_found', 'Hosting account not found.', 404);
const conflict = () => error('hosting_account_revision_conflict', 'Reload the hosting account before changing it.', 409);
function fields(input, allowed, required = allowed) {
  if (!plain(input) || Object.keys(input).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(input, key))) {
    throw error('invalid_hosting_account_input', 'Send only the documented hosting account fields.');
  }
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw error('invalid_revision', 'A current account revision is required.');
  return value;
}
function active(value) {
  if (typeof value !== 'boolean') throw error('invalid_active', 'Active must be a boolean.');
  return value;
}

/** RS-02 storage integration, deliberately Owner-only and NOT mounted as HTTP.
 * Same auth DB/BEGIN IMMEDIATE transaction; no duplicated users or new login roles.
 * Website enrollment/provisioning and reseller access stay closed until the existing
 * Website registry, jobs, gateways and live sessions share the ownership boundary.
 */
export function createHostingAccountStore({ db, now, transaction, getSession, mfa, audit, revokeLiveUser }) {
  if (![now, transaction, getSession, mfa?.invalidateUser, audit, revokeLiveUser].every((value) => typeof value === 'function')) {
    throw new TypeError('Hosting accounts require the live auth transaction, MFA, audit and revocation services');
  }
  initializeHostingAccountSchema({ db, transaction });
  const select = `SELECT h.*, u.username, u.role, u.active, COALESCE(r.revision, 1) AS user_revision
    FROM auth_hosting_accounts h LEFT JOIN users u ON u.id = h.user_id
    LEFT JOIN auth_user_revisions r ON r.user_id = h.user_id`;
  const raw = (id) => db.prepare(`${select} WHERE h.user_id = ?`).get(id);
  function projection(row) {
    if (!row || row.role !== 'site_manager' || ![0, 1].includes(row.active)) {
      throw error('hosting_account_state_invalid', 'Hosting account state requires recovery.', 503);
    }
    return validateHostingAccount({ id: row.user_id, kind: row.kind, resellerId: row.reseller_id, active: row.active === 1 }, row.kind);
  }
  function existing(id, expectedRevision) {
    if (!identifier(id)) throw missing();
    const row = raw(id);
    if (!row) throw missing();
    projection(row);
    if (expectedRevision !== undefined && row.revision !== revision(expectedRevision)) throw conflict();
    return row;
  }
  function owner(rawToken, requireManagement) {
    if (typeof requireManagement !== 'function') throw new TypeError('A live Owner/MFA policy is required');
    const current = getSession(rawToken);
    const approved = requireManagement(current);
    if (!current?.id || approved?.id !== current.id || approved?.user?.id !== current.user?.id
      || current.user?.role !== 'owner' || approved.user.role !== 'owner') {
      throw error('forbidden', 'Owner access is required.', 403);
    }
    const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(current.user.id);
    if (user?.role !== 'owner' || user.active !== 1) throw error('forbidden', 'Owner access is required.', 403);
    return { id: user.id, role: 'owner', active: true };
  }
  function limits(id) {
    const row = db.prepare('SELECT max_customers AS maxCustomers, max_websites AS maxWebsites FROM auth_reseller_limits WHERE reseller_id = ?').get(id);
    if (!row) throw error('hosting_account_state_invalid', 'Explicit reseller limits are missing.', 503);
    return validateResellerLimits(row);
  }
  function usage(row) {
    return countResellerUsage({
      reseller: projection(row),
      customers: db.prepare(`${select} WHERE h.kind = 'customer'`).all().map(projection),
      websites: hostingWebsitesForCapacity(db),
    });
  }
  function view(row) {
    const hasReservedSites = row.kind === 'reseller' && db.prepare(`SELECT 1 FROM auth_hosting_site_allocations a
      JOIN auth_hosting_accounts h ON h.user_id = a.customer_id
      WHERE h.reseller_id = ? AND a.state = 'reserved' LIMIT 1`).get(row.user_id);
    return {
      ...projection(row), username: row.username, revision: row.revision, userRevision: row.user_revision,
      createdAt: row.created_at, updatedAt: row.updated_at, stage: 'profile_only',
      ...(row.kind === 'reseller' ? { limits: limits(row.user_id), usage: usage(row), usageScope: hasReservedSites ? 'registered_and_reserved_ownership' : 'registered_ownership' } : {}),
    };
  }
  function candidate(id, expectedUserRevision) {
    if (!identifier(id)) throw error('invalid_hosting_user_id', 'A valid existing user identifier is required.');
    revision(expectedUserRevision);
    const user = db.prepare(`SELECT u.*, COALESCE(r.revision, 1) AS revision FROM users u
      LEFT JOIN auth_user_revisions r ON r.user_id = u.id WHERE u.id = ?`).get(id);
    if (!user) throw error('hosting_user_not_found', 'Existing login account not found.', 404);
    if (user.revision !== expectedUserRevision) throw error('user_revision_conflict', 'Reload the login account before linking it.', 409);
    if (user.role !== 'site_manager') throw error('hosting_profile_requires_site_manager', 'Use an existing site-scoped login, not an Owner or global read-only account.', 409);
    if (raw(id)) throw error('hosting_account_exists', 'This login already has a hosting profile.', 409);
    if (db.prepare('SELECT 1 FROM auth_user_websites WHERE user_id = ? LIMIT 1').get(id)) {
      throw error('hosting_site_migration_required', 'Existing site memberships require an explicit ownership migration.', 409);
    }
    return user;
  }
  function invalidate(id) {
    const current = db.prepare('SELECT revision FROM auth_user_revisions WHERE user_id = ?').get(id)?.revision ?? 1;
    if (!Number.isSafeInteger(current) || current < 1 || current === Number.MAX_SAFE_INTEGER) throw conflict();
    db.prepare(`INSERT INTO auth_user_revisions VALUES (?, ?, ?) ON CONFLICT(user_id)
      DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`).run(id, current + 1, now());
    mfa.invalidateUser(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  function insert(actor, user, kind, parent, assignedLimits = null) {
    const timestamp = now();
    db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, ?, ?)').run(user.id, kind, parent, timestamp, timestamp);
    if (kind === 'reseller') db.prepare('INSERT INTO auth_reseller_limits VALUES (?, ?, ?)').run(user.id, assignedLimits.maxCustomers, assignedLimits.maxWebsites);
    invalidate(user.id);
    audit(actor.id, `hosting.${kind}_registered`, { type: 'user', id: user.id });
    return view(existing(user.id));
  }
  const siteAllocations = createHostingSiteAllocationStore({
    db, now, transaction, owner, existing, projection, limits, usage, invalidate, audit, revokeLiveUser,
  });
  return {
    siteAllocations,
    registerReseller(rawToken, requireManagement, input) {
      const result = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['userId', 'expectedUserRevision', 'limits']);
        const user = candidate(input.userId, input.expectedUserRevision);
        const assignedLimits = validateResellerLimits(input.limits);
        return insert(actor, user, 'reseller', null, assignedLimits);
      });
      revokeLiveUser(result.id, 'hosting_account_linked');
      return result;
    },
    registerCustomer(rawToken, requireManagement, input) {
      const result = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['userId', 'expectedUserRevision', 'resellerId']);
        const user = candidate(input.userId, input.expectedUserRevision);
        const parent = input.resellerId === null ? null : existing(input.resellerId);
        assertCustomerCreationScope({ actor, reseller: parent ? projection(parent) : null });
        if (parent) assertResellerCapacity({ limits: limits(parent.user_id), usage: usage(parent), resource: 'customers' });
        return insert(actor, user, 'customer', input.resellerId);
      });
      revokeLiveUser(result.id, 'hosting_account_linked');
      return result;
    },
    get(rawToken, requireManagement, id) {
      return transaction(() => { owner(rawToken, requireManagement); return view(existing(id)); });
    },
    list(rawToken, requireManagement, input = {}) {
      return transaction(() => {
        owner(rawToken, requireManagement);
        fields(input, ['kind', 'resellerId', 'offset', 'limit'], []);
        const { kind, offset = 0, limit = 50 } = input;
        if (kind !== undefined && !['reseller', 'customer'].includes(kind)) throw error('invalid_hosting_kind', 'Choose reseller or customer.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw error('invalid_pagination', 'Use a nonnegative offset and a limit from 1 to 100.');
        }
        const where = []; const args = [];
        if (kind !== undefined) { where.push('h.kind = ?'); args.push(kind); }
        if (Object.hasOwn(input, 'resellerId')) {
          if (kind !== 'customer' || (input.resellerId !== null && !identifier(input.resellerId))) {
            throw error('invalid_hosting_parent', 'A parent filter requires customer kind and an explicit reseller ID or null.');
          }
          where.push('h.reseller_id IS ?'); args.push(input.resellerId);
        }
        const filter = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const total = db.prepare(`SELECT count(*) AS total FROM auth_hosting_accounts h${filter}`).get(...args).total;
        const accounts = db.prepare(`${select}${filter} ORDER BY h.user_id LIMIT ? OFFSET ?`).all(...args, limit, offset).map(view);
        return { accounts, total, offset, limit };
      });
    },
    updateLimits(rawToken, requireManagement, id, input) {
      return transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['revision', 'limits']);
        const row = existing(id, revision(input.revision));
        assertResellerManagement({ actor, reseller: projection(row) });
        const next = validateResellerLimits(input.limits);
        const previous = limits(id);
        if (next.maxCustomers === previous.maxCustomers && next.maxWebsites === previous.maxWebsites) return view(row);
        if (row.revision === Number.MAX_SAFE_INTEGER) throw conflict();
        db.prepare('UPDATE auth_reseller_limits SET max_customers = ?, max_websites = ? WHERE reseller_id = ?').run(next.maxCustomers, next.maxWebsites, id);
        db.prepare('UPDATE auth_hosting_accounts SET revision = revision + 1, updated_at = ? WHERE user_id = ?').run(now(), id);
        audit(actor.id, 'hosting.limits_updated', { type: 'user', id });
        return view(existing(id));
      });
    },
    setActive(rawToken, requireManagement, id, input) {
      const outcome = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['revision', 'active']);
        const row = existing(id, revision(input.revision));
        const nextActive = active(input.active);
        if (Boolean(row.active) === nextActive) {
          return { account: view(row), revoked: [] };
        }
        if (row.revision === Number.MAX_SAFE_INTEGER) throw conflict();

        db.prepare('INSERT INTO auth_hosting_lifecycle_intents VALUES (?, ?, ?, ?)')
          .run(id, Number(nextActive), actor.id, now());
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(Number(nextActive), id);
        if (db.prepare('SELECT 1 FROM auth_hosting_lifecycle_intents WHERE user_id = ?').get(id)) {
          throw error('hosting_account_state_invalid', 'Hosting lifecycle intent was not consumed.', 503);
        }

        db.prepare('UPDATE auth_hosting_accounts SET revision = revision + 1, updated_at = ? WHERE user_id = ?')
          .run(now(), id);
        invalidate(id);
        const revoked = [{ id, reason: nextActive ? 'hosting_account_reactivated' : 'hosting_account_suspended' }];

        if (row.kind === 'reseller' && !nextActive) {
          const children = db.prepare("SELECT user_id FROM auth_hosting_accounts WHERE kind = 'customer' AND reseller_id = ? ORDER BY user_id")
            .all(id);
          for (const child of children) {
            invalidate(child.user_id);
            revoked.push({ id: child.user_id, reason: 'hosting_parent_suspended' });
          }
        }

        audit(actor.id, nextActive ? 'hosting.account_reactivated' : 'hosting.account_suspended', { type: 'user', id });
        return { account: view(existing(id)), revoked };
      });
      for (const item of outcome.revoked) revokeLiveUser(item.id, item.reason);
      return outcome.account;
    },
    unregister(rawToken, requireManagement, id, input) {
      transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['revision']);
        existing(id, revision(input.revision));
        if (db.prepare('SELECT 1 FROM auth_hosting_accounts WHERE reseller_id = ? LIMIT 1').get(id)
          || db.prepare('SELECT 1 FROM auth_customer_websites WHERE customer_id = ? LIMIT 1').get(id)
          || db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE customer_id = ? LIMIT 1').get(id)
          || db.prepare('SELECT 1 FROM auth_user_websites WHERE user_id = ? LIMIT 1').get(id)) {
          throw error('hosting_account_in_use', 'Detach account resources through an explicit migration before removing this profile.', 409);
        }
        db.prepare('DELETE FROM auth_reseller_limits WHERE reseller_id = ?').run(id);
        db.prepare('DELETE FROM auth_hosting_accounts WHERE user_id = ?').run(id);
        invalidate(id);
        audit(actor.id, 'hosting.account_unregistered', { type: 'user', id });
      });
      revokeLiveUser(id, 'hosting_account_unlinked');
      return { id, unregistered: true };
    },
    /** Called inside the legacy user store's authorized write transaction. Not an API. */
    assertLegacyMutationAllowed(id, input = null) {
      if (raw(id) && (input === null || ['role', 'active', 'websiteIds'].some((key) => Object.hasOwn(input, key)))) {
        throw error('hosting_account_managed', 'Hosting profiles cannot change role, activation, site grants or be deleted through the general users API.', 409);
      }
    },
  };
}
