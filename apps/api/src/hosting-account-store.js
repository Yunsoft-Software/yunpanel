import { createHash, randomUUID } from 'node:crypto';
import { AuthError } from './auth-error.js';
import { createHostingSiteAllocationStore } from './hosting-site-allocation-store.js';
import { hostingWebsitesForCapacity } from './hosting-site-allocation-schema.js';
import { initializeHostingAccountSchema } from './hosting-account-schema.js';
import { assertCustomerCreationScope, assertCustomerManagement, assertResellerManagement, validateHostingAccount } from './reseller-scope.js';
import { assertResellerCapacity, countResellerUsage, validateResellerLimits } from './reseller-limits.js';
import {
  initializeCustomerQuotaSchema,
  validateCustomerQuotas,
  assertCustomerQuotaWithinResellerCapacity,
} from './customer-quotas.js';

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

/** RS-02 storage integration on the existing auth DB and login roles.
 * Owner keeps full profile administration. A persisted, active reseller profile may
 * read itself/its direct customers and change only those customers' login lifecycle.
 * Registration, limits, unlinking and Website allocation remain Owner-only here.
 */
export function createHostingAccountStore({
  db,
  now,
  transaction,
  getSession,
  mfa,
  audit,
  revokeLiveUser,
  hashPassword = null,
  normalizeUsername = null,
  activeResourceChecker = null,
  websiteRegistry = null,
  domainRegistry = null,
  databaseBindingRegistry = null,
  mailboxRegistry = null,
}) {
  if (![now, transaction, getSession, mfa?.invalidateUser, audit, revokeLiveUser].every((value) => typeof value === 'function')) {
    throw new TypeError('Hosting accounts require the live auth transaction, MFA, audit and revocation services');
  }
  initializeHostingAccountSchema({ db, transaction });
  initializeCustomerQuotaSchema(db);
  const select = `SELECT h.*, u.username, u.role, u.active, COALESCE(r.revision, 1) AS user_revision
    FROM auth_hosting_accounts h LEFT JOIN users u ON u.id = h.user_id
    LEFT JOIN auth_user_revisions r ON r.user_id = h.user_id`;
  const raw = (id) => db.prepare(`${select} WHERE h.user_id = ?`).get(id);
  function projection(row) {
    if (!row || !['site_manager', 'reseller', 'customer'].includes(row.role) || ![0, 1].includes(row.active)) {
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
    if (!current?.id || !current?.user?.id) throw error('unauthorized', 'Sign in to continue.', 401);
    const approved = requireManagement(current);
    if (approved?.id !== current.id || approved?.user?.id !== current.user?.id
      || current.user?.role !== 'owner' || approved.user.role !== 'owner') {
      throw error('forbidden', 'Owner access is required.', 403);
    }
    const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(current.user.id);
    if (user?.role !== 'owner' || user.active !== 1) throw error('forbidden', 'Owner access is required.', 403);
    return { id: user.id, role: 'owner', active: true };
  }
  const scopeDenied = () => error('reseller_scope_forbidden', 'This account operation is not permitted.', 403);
  function managementActor(rawToken, requireManagement) {
    const current = getSession(rawToken);
    if (!current?.id || !current.user?.id) throw error('unauthorized', 'Sign in to continue.', 401);
    if (current.user.role === 'owner') return owner(rawToken, requireManagement);
    const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(current.user.id);
    if (!['site_manager', 'reseller', 'customer'].includes(user?.role) || user.active !== 1) throw scopeDenied();
    const row = raw(user.id);
    if (!row) throw scopeDenied();
    const profile = projection(row);
    if (profile.kind === 'reseller' && profile.resellerId === null && profile.active) {
      return { id: user.id, role: 'reseller', active: true };
    }
    if (profile.kind === 'customer' && profile.active) {
      return { id: user.id, role: 'customer', active: true };
    }
    throw scopeDenied();
  }
  function assertReadScope(actor, row) {
    const account = projection(row);
    if (actor.role === 'owner') return;
    if (account.kind === 'reseller' && account.id === actor.id) return;
    if (account.kind === 'customer' && account.id === actor.id) return;
    if (account.kind !== 'customer') throw scopeDenied();
    const parent = account.resellerId === null ? null : existing(account.resellerId);
    assertCustomerManagement({ actor, customer: account, reseller: parent ? projection(parent) : null });
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
  function customerQuotas(id) {
    const row = db.prepare('SELECT max_websites AS maxWebsites, max_disk_mb AS maxDiskMb, max_traffic_mb AS maxTrafficMb, max_databases AS maxDatabases FROM auth_customer_quotas WHERE customer_id = ?').get(id);
    if (!row) return { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null };
    return validateCustomerQuotas(row);
  }
  function customerUsage(id) {
    const websiteRow = db.prepare(`SELECT count(DISTINCT website_id) AS total FROM (
      SELECT website_id FROM auth_customer_websites WHERE customer_id = ?
      UNION
      SELECT website_id FROM auth_hosting_site_allocations WHERE customer_id = ? AND state = 'reserved'
    )`).get(id, id);
    return {
      websites: websiteRow?.total ?? 0,
      diskMb: 0,
      trafficMb: 0,
      databases: 0,
    };
  }
  function view(row) {
    const hasReservedSites = row.kind === 'reseller' && db.prepare(`SELECT 1 FROM auth_hosting_site_allocations a
      JOIN auth_hosting_accounts h ON h.user_id = a.customer_id
      WHERE h.reseller_id = ? AND a.state = 'reserved' LIMIT 1`).get(row.user_id);
    return {
      ...projection(row), username: row.username, revision: row.revision, userRevision: row.user_revision,
      createdAt: row.created_at, updatedAt: row.updated_at, stage: 'profile_only',
      ...(row.kind === 'reseller' ? { limits: limits(row.user_id), usage: usage(row), usageScope: hasReservedSites ? 'registered_and_reserved_ownership' : 'registered_ownership' } : {}),
      ...(row.kind === 'customer' ? { quotas: customerQuotas(row.user_id), usage: customerUsage(row.user_id) } : {}),
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
  function customerCredentialServices() {
    if (typeof hashPassword !== 'function' || typeof normalizeUsername !== 'function') {
      throw error('hosting_customer_credentials_unavailable', 'Customer login administration is unavailable.', 503);
    }
    return { hashPassword, normalizeUsername };
  }
  function uniqueUsername(name, excludingId = '') {
    if (db.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').get(name, excludingId)) {
      throw error('username_taken', 'An account with that username already exists.', 409);
    }
  }
  function customerScope(actor, row) {
    if (row.kind !== 'customer') throw scopeDenied();
    const parent = row.reseller_id === null ? null : existing(row.reseller_id);
    assertCustomerManagement({ actor, customer: projection(row), reseller: parent ? projection(parent) : null });
  }
  function assertSafeDeletion(id, row) {
    if (row.kind === 'reseller') {
      const hasChildren = db.prepare('SELECT 1 FROM auth_hosting_accounts WHERE reseller_id = ? LIMIT 1').get(id);
      if (hasChildren) {
        throw error('hosting_account_in_use', 'Cannot delete reseller entity while child customers exist.', 409);
      }
    }
    const hasCustomerWebsites = db.prepare('SELECT 1 FROM auth_customer_websites WHERE customer_id = ? LIMIT 1').get(id);
    const hasAllocations = db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE customer_id = ? LIMIT 1').get(id);
    const hasUserWebsites = db.prepare('SELECT 1 FROM auth_user_websites WHERE user_id = ? LIMIT 1').get(id);
    const hasOpTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_operation_users'").get());
    const hasOperationUsers = hasOpTable && Boolean(db.prepare('SELECT 1 FROM auth_operation_users WHERE user_id = ? LIMIT 1').get(id));
    if (hasCustomerWebsites || hasAllocations || hasUserWebsites || hasOperationUsers) {
      throw error('hosting_account_in_use', 'Detach account resources through an explicit migration before removing this profile.', 409);
    }
    if (typeof activeResourceChecker === 'function') {
      const check = activeResourceChecker({ id, customerId: id, resellerId: id, kind: row.kind, role: row.role });
      if (check && (check.safe === false || check.blocked)) {
        const res = check.resource || check.resourceType || 'attached resources';
        throw error('hosting_account_in_use', check.message || `Cannot delete ${row.kind} entity while attached active resources (${res}) exist.`, 409);
      }
    }
    if (websiteRegistry) {
      if (typeof websiteRegistry.hasResources === 'function' && websiteRegistry.hasResources(id)) {
        throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active websites exist.`, 409);
      }
      if (typeof websiteRegistry.listWebsites === 'function') {
        const list = websiteRegistry.listWebsites();
        if (Array.isArray(list) && list.some((s) => s.customerId === id || s.resellerId === id || (row.kind === 'customer' && s.ownerId === id))) {
          throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active websites exist.`, 409);
        }
      }
    }
    if (domainRegistry) {
      if (typeof domainRegistry.hasResources === 'function' && domainRegistry.hasResources(id)) {
        throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active domains exist.`, 409);
      }
      if (typeof domainRegistry.listDomains === 'function') {
        const list = domainRegistry.listDomains();
        if (Array.isArray(list) && list.some((d) => d.customerId === id || d.resellerId === id || d.userId === id)) {
          throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active domains exist.`, 409);
        }
      }
    }
    if (databaseBindingRegistry) {
      if (typeof databaseBindingRegistry.hasResources === 'function' && databaseBindingRegistry.hasResources(id)) {
        throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active databases exist.`, 409);
      }
      if (typeof databaseBindingRegistry.listBindings === 'function') {
        const list = databaseBindingRegistry.listBindings();
        if (Array.isArray(list) && list.some((b) => b.customerId === id || b.resellerId === id || b.userId === id)) {
          throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active databases exist.`, 409);
        }
      }
    }
    if (mailboxRegistry) {
      if (typeof mailboxRegistry.hasResources === 'function' && mailboxRegistry.hasResources(id)) {
        throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active mailboxes exist.`, 409);
      }
      if (typeof mailboxRegistry.listMailboxes === 'function') {
        const list = mailboxRegistry.listMailboxes();
        if (Array.isArray(list) && list.some((m) => m.customerId === id || m.resellerId === id || m.userId === id)) {
          throw error('hosting_account_in_use', `Cannot delete ${row.kind} entity while attached active mailboxes exist.`, 409);
        }
      }
    }
  }
  const siteAllocations = createHostingSiteAllocationStore({
    db, now, transaction, owner, existing, projection, limits, usage, invalidate, audit, revokeLiveUser, managementActor,
  });
  return {
    siteAllocations,
    authorizeActor(rawToken, requireManagement) {
      return transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        return { id: actor.id, role: actor.role, active: actor.active };
      });
    },
    allocateCustomerSite(rawToken, requireManagement, input) {
      return siteAllocations.allocateCustomerSite(rawToken, requireManagement, input);
    },
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
        fields(input, ['userId', 'expectedUserRevision', 'resellerId', 'quotas'], ['userId', 'expectedUserRevision', 'resellerId']);
        const user = candidate(input.userId, input.expectedUserRevision);
        const parent = input.resellerId === null ? null : existing(input.resellerId);
        assertCustomerCreationScope({ actor, reseller: parent ? projection(parent) : null });
        if (parent) assertResellerCapacity({ limits: limits(parent.user_id), usage: usage(parent), resource: 'customers' });
        const account = insert(actor, user, 'customer', input.resellerId);
        if (input.quotas) {
          const validated = validateCustomerQuotas(input.quotas);
          if (parent) assertCustomerQuotaWithinResellerCapacity({ customerQuotas: validated, resellerLimits: limits(parent.user_id) });
          const timestamp = now();
          db.prepare('INSERT INTO auth_customer_quotas VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            user.id, validated.maxWebsites, validated.maxDiskMb, validated.maxTrafficMb, validated.maxDatabases, timestamp, timestamp,
          );
        }
        return view(existing(user.id));
      });
      revokeLiveUser(result.id, 'hosting_account_linked');
      return result;
    },
    async createCustomerLogin(rawToken, requireManagement, input) {
      // Authenticate before parsing credentials, then recheck after the expensive KDF.
      transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        if (actor.role !== 'reseller') throw scopeDenied();
      });
      const credentials = customerCredentialServices();
      fields(input, ['username', 'password', 'quotas'], ['username', 'password']);
      const name = credentials.normalizeUsername(input.username);
      const passwordHash = await credentials.hashPassword(input.password);
      return transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        if (actor.role !== 'reseller') throw scopeDenied();
        const parent = existing(actor.id);
        assertCustomerCreationScope({ actor, reseller: projection(parent) });
        assertResellerCapacity({ limits: limits(parent.user_id), usage: usage(parent), resource: 'customers' });
        uniqueUsername(name);
        const id = randomUUID();
        const timestamp = now();
        db.prepare('INSERT INTO users(id, username, password_hash, role, active, created_at, password_changed_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
          .run(id, name, passwordHash, 'site_manager', timestamp, timestamp);
        insert(actor, { id }, 'customer', actor.id);
        if (input.quotas) {
          const validated = validateCustomerQuotas(input.quotas);
          assertCustomerQuotaWithinResellerCapacity({ customerQuotas: validated, resellerLimits: limits(parent.user_id) });
          db.prepare('INSERT INTO auth_customer_quotas VALUES (?, ?, ?, ?, ?, ?, ?)').run(
            id, validated.maxWebsites, validated.maxDiskMb, validated.maxTrafficMb, validated.maxDatabases, timestamp, timestamp,
          );
        }
        audit(actor.id, 'hosting.customer_login_created', { type: 'user', id });
        return view(existing(id));
      });
    },
    async updateCustomerLogin(rawToken, requireManagement, id, input) {
      // Actor existence is checked before input details; target scope is checked again
      // with the supplied revision before and after any asynchronous password hashing.
      transaction(() => managementActor(rawToken, requireManagement));
      const credentials = customerCredentialServices();
      fields(input, ['revision', 'username', 'email', 'password'], ['revision']);
      if (!Object.hasOwn(input, 'username') && !Object.hasOwn(input, 'email') && !Object.hasOwn(input, 'password')) {
        throw error('empty_hosting_customer_update', 'Choose a customer login field to change.');
      }
      const expectedRevision = revision(input.revision);
      const name = Object.hasOwn(input, 'email')
        ? credentials.normalizeUsername(input.email)
        : (Object.hasOwn(input, 'username') ? credentials.normalizeUsername(input.username) : null);
      transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        const row = existing(id, expectedRevision);
        customerScope(actor, row);
      });
      const passwordHash = Object.hasOwn(input, 'password') ? await credentials.hashPassword(input.password) : null;
      const outcome = transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        const row = existing(id, expectedRevision);
        customerScope(actor, row);
        const nextName = name ?? row.username;
        uniqueUsername(nextName, id);
        if (nextName === row.username && passwordHash === null) return { account: view(row), changed: false };
        if (row.revision === Number.MAX_SAFE_INTEGER) throw conflict();
        if (passwordHash !== null) {
          db.prepare('UPDATE users SET username = ?, password_hash = ?, password_changed_at = ? WHERE id = ?')
            .run(nextName, passwordHash, now(), id);
        } else {
          db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nextName, id);
        }
        db.prepare('UPDATE auth_hosting_accounts SET revision = revision + 1, updated_at = ? WHERE user_id = ?')
          .run(now(), id);
        invalidate(id);
        audit(actor.id, passwordHash !== null ? 'hosting.customer_password_reset' : 'hosting.customer_login_updated', { type: 'user', id });
        return { account: view(existing(id)), changed: true };
      });
      if (outcome.changed) revokeLiveUser(id, 'hosting_customer_login_changed');
      return outcome.account;
    },
    get(rawToken, requireManagement, id) {
      return transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        const row = existing(id);
        assertReadScope(actor, row);
        return view(row);
      });
    },
    list(rawToken, requireManagement, input = {}) {
      return transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        if (actor.role !== 'owner' && actor.role !== 'reseller') throw scopeDenied();
        fields(input, ['kind', 'resellerId', 'offset', 'limit'], []);
        const { kind, offset = 0, limit = 50 } = input;
        if (kind !== undefined && !['reseller', 'customer'].includes(kind)) throw error('invalid_hosting_kind', 'Choose reseller or customer.');
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw error('invalid_pagination', 'Use a nonnegative offset and a limit from 1 to 100.');
        }
        const where = []; const args = [];
        if (actor.role === 'reseller') {
          if ((kind !== undefined && kind !== 'customer')
            || (Object.hasOwn(input, 'resellerId') && input.resellerId !== actor.id)) throw scopeDenied();
          where.push("h.kind = 'customer'", 'h.reseller_id = ?'); args.push(actor.id);
        } else {
          if (kind !== undefined) { where.push('h.kind = ?'); args.push(kind); }
          if (Object.hasOwn(input, 'resellerId')) {
            if (kind !== 'customer' || (input.resellerId !== null && !identifier(input.resellerId))) {
              throw error('invalid_hosting_parent', 'A parent filter requires customer kind and an explicit reseller ID or null.');
            }
            where.push('h.reseller_id IS ?'); args.push(input.resellerId);
          }
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
    updateCustomerQuotas(rawToken, requireManagement, id, input) {
      return transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        fields(input, ['revision', 'quotas']);
        const row = existing(id, revision(input.revision));
        if (row.kind !== 'customer') throw scopeDenied();
        const parent = row.reseller_id === null ? null : existing(row.reseller_id);
        assertCustomerManagement({ actor, customer: projection(row), reseller: parent ? projection(parent) : null });

        const nextQuotas = validateCustomerQuotas(input.quotas);
        if (parent) {
          assertCustomerQuotaWithinResellerCapacity({ customerQuotas: nextQuotas, resellerLimits: limits(parent.user_id) });
        }

        const previous = customerQuotas(id);
        const unchanged = ['maxWebsites', 'maxDiskMb', 'maxTrafficMb', 'maxDatabases'].every(
          (key) => nextQuotas[key] === previous[key],
        );
        if (unchanged) return view(row);

        if (row.revision === Number.MAX_SAFE_INTEGER) throw conflict();
        const timestamp = now();
        db.prepare(`INSERT INTO auth_customer_quotas
          (customer_id, max_websites, max_disk_mb, max_traffic_mb, max_databases, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(customer_id) DO UPDATE SET
            max_websites = excluded.max_websites,
            max_disk_mb = excluded.max_disk_mb,
            max_traffic_mb = excluded.max_traffic_mb,
            max_databases = excluded.max_databases,
            updated_at = excluded.updated_at
        `).run(
          id,
          nextQuotas.maxWebsites,
          nextQuotas.maxDiskMb,
          nextQuotas.maxTrafficMb,
          nextQuotas.maxDatabases,
          timestamp,
          timestamp,
        );

        db.prepare('UPDATE auth_hosting_accounts SET revision = revision + 1, updated_at = ? WHERE user_id = ?')
          .run(timestamp, id);
        audit(actor.id, 'hosting.customer_quotas_updated', { type: 'user', id });
        return view(existing(id));
      });
    },
    setActive(rawToken, requireManagement, id, input) {
      const outcome = transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        fields(input, ['revision', 'active']);
        const row = existing(id, revision(input.revision));
        if (actor.role === 'reseller') {
          if (row.kind !== 'customer') throw scopeDenied();
          const parent = row.reseller_id === null ? null : existing(row.reseller_id);
          assertCustomerManagement({ actor, customer: projection(row), reseller: parent ? projection(parent) : null });
        }
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
        const row = existing(id, revision(input.revision));
        assertSafeDeletion(id, row);
        db.prepare('DELETE FROM auth_customer_quotas WHERE customer_id = ?').run(id);
        db.prepare('DELETE FROM auth_reseller_limits WHERE reseller_id = ?').run(id);
        db.prepare('DELETE FROM auth_hosting_accounts WHERE user_id = ?').run(id);
        invalidate(id);
        audit(actor.id, 'hosting.account_unregistered', { type: 'user', id });
      });
      revokeLiveUser(id, 'hosting_account_unlinked');
      return { id, unregistered: true };
    },
    async deleteCustomerLogin(rawToken, requireManagement, id, input = {}) {
      const outcome = transaction(() => {
        const actor = managementActor(rawToken, requireManagement);
        if (input && typeof input === 'object' && input.revision !== undefined) {
          fields(input, ['revision']);
        }
        const row = existing(id, input?.revision !== undefined ? revision(input.revision) : undefined);
        if (row.kind !== 'customer') throw scopeDenied();
        const parent = row.reseller_id === null ? null : existing(row.reseller_id);
        assertCustomerManagement({ actor, customer: projection(row), reseller: parent ? projection(parent) : null });
        assertSafeDeletion(id, row);

        const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
        mfa.invalidateUser(id);
        if (hasTable('sessions')) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        if (hasTable('auth_customer_quotas')) db.prepare('DELETE FROM auth_customer_quotas WHERE customer_id = ?').run(id);
        if (hasTable('auth_hosting_accounts')) db.prepare('DELETE FROM auth_hosting_accounts WHERE user_id = ?').run(id);
        if (hasTable('auth_mfa_recovery')) db.prepare('DELETE FROM auth_mfa_recovery WHERE user_id = ?').run(id);
        if (hasTable('auth_mfa')) db.prepare('DELETE FROM auth_mfa WHERE user_id = ?').run(id);
        if (hasTable('auth_recovery_emails')) db.prepare('DELETE FROM auth_recovery_emails WHERE user_id = ?').run(id);
        if (hasTable('auth_operation_users')) db.prepare('DELETE FROM auth_operation_users WHERE user_id = ?').run(id);
        if (hasTable('auth_user_revisions')) db.prepare('DELETE FROM auth_user_revisions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
        audit(actor.id, 'hosting.customer_login_deleted', { type: 'user', id });
        return { id, deleted: true };
      });
      revokeLiveUser(id, 'hosting_customer_deleted');
      return outcome;
    },
    /** Called inside the legacy user store's authorized write transaction. Not an API. */
    assertLegacyMutationAllowed(id, input = null) {
      if (raw(id) && (input === null || ['role', 'active', 'websiteIds'].some((key) => Object.hasOwn(input, key)))) {
        throw error('hosting_account_managed', 'Hosting profiles cannot change role, activation, site grants or be deleted through the general users API.', 409);
      }
    },
    getCustomer(id) {
      if (!identifier(id)) return null;
      return transaction(() => {
        const row = raw(id);
        if (!row || row.kind !== 'customer') return null;
        return projection(row);
      });
    },
    listChildCustomerIds(resellerId) {
      if (!identifier(resellerId)) return [];
      return transaction(() => {
        const rows = db.prepare("SELECT user_id FROM auth_hosting_accounts WHERE kind = 'customer' AND reseller_id = ?").all(resellerId);
        return rows.map((r) => r.user_id);
      });
    },
    migrateLegacyUserToCustomer(rawToken, requireManagement, input) {
      const outcome = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['userId', 'expectedUserRevision', 'resellerId', 'quotas', 'websites', 'serverId'], ['userId', 'expectedUserRevision', 'resellerId']);
        if (!identifier(input.userId)) throw error('invalid_hosting_user_id', 'A valid existing user identifier is required.');
        const expRev = revision(input.expectedUserRevision);

        const user = db.prepare(`SELECT u.*, COALESCE(r.revision, 1) AS revision FROM users u
          LEFT JOIN auth_user_revisions r ON r.user_id = u.id WHERE u.id = ?`).get(input.userId);
        if (!user) throw error('hosting_user_not_found', 'Existing login account not found.', 404);
        if (user.revision !== expRev) throw error('user_revision_conflict', 'Reload the login account before linking it.', 409);
        if (user.role !== 'site_manager') throw error('hosting_profile_requires_site_manager', 'Use an existing site-scoped login, not an Owner or global read-only account.', 409);
        if (raw(input.userId)) throw error('hosting_account_exists', 'This login already has a hosting profile.', 409);

        const parent = input.resellerId === null ? null : existing(input.resellerId);
        assertCustomerCreationScope({ actor, reseller: parent ? projection(parent) : null });
        if (parent) assertResellerCapacity({ limits: limits(parent.user_id), usage: usage(parent), resource: 'customers' });

        const existingGrants = db.prepare('SELECT website_id FROM auth_user_websites WHERE user_id = ? ORDER BY website_id')
          .all(input.userId).map((r) => r.website_id);
        const websiteIds = input.websites !== undefined ? input.websites : existingGrants;
        if (!Array.isArray(websiteIds)) throw error('invalid_hosting_account_input', 'Websites must be an array.');

        for (const wid of websiteIds) {
          if (db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ?').get(wid)
            || db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE website_id = ?').get(wid)) {
            throw conflict();
          }
        }

        if (input.quotas) {
          const validated = validateCustomerQuotas(input.quotas);
          if (parent) assertCustomerQuotaWithinResellerCapacity({ customerQuotas: validated, resellerLimits: limits(parent.user_id) });
          if (validated.maxWebsites !== null && websiteIds.length > validated.maxWebsites) {
            throw error('customer_quota_exceeded', 'The customer website quota has been reached.', 409);
          }
        }

        if (parent) {
          const resLimits = limits(parent.user_id);
          const resUsage = usage(parent);
          if (resLimits.maxWebsites !== null && (resUsage.websites + websiteIds.length) > resLimits.maxWebsites) {
            throw error('reseller_limit_reached', 'Customer website quota cannot exceed the reseller maximum websites limit.', 409);
          }
        }

        const timestamp = now();
        const serverId = input.serverId ?? '00000000-0000-4000-8000-000000000001';

        // 1. Delete legacy grants for user first so trigger auth_hosting_account_insert allows insert
        db.prepare('DELETE FROM auth_user_websites WHERE user_id = ?').run(input.userId);

        // 2. Insert into auth_hosting_accounts
        db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, ?, ?)')
          .run(input.userId, 'customer', input.resellerId, timestamp, timestamp);

        // 3. Insert customer quotas if provided
        if (input.quotas) {
          const validated = validateCustomerQuotas(input.quotas);
          db.prepare('INSERT INTO auth_customer_quotas VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(input.userId, validated.maxWebsites, validated.maxDiskMb, validated.maxTrafficMb, validated.maxDatabases, timestamp, timestamp);
        }

        // 4. Create allocations and customer website records
        const allocations = [];
        for (const wid of websiteIds) {
          const opId = randomUUID();
          const intentDigest = createHash('sha256').update(`migration:intent:${input.userId}:${wid}`).digest('hex');
          const websiteDigest = createHash('sha256').update(`migration:website:${wid}:${serverId}`).digest('hex');

          db.prepare(`INSERT INTO auth_hosting_site_allocations
            (operation_id, website_id, customer_id, server_id, intent_digest, website_digest, state, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(opId, wid, input.userId, serverId, intentDigest, websiteDigest, timestamp);
          db.prepare('INSERT INTO auth_customer_websites (website_id, customer_id, created_at) VALUES (?, ?, ?)')
            .run(wid, input.userId, timestamp);
          db.prepare("UPDATE auth_hosting_site_allocations SET state = 'attached', attached_at = ? WHERE operation_id = ?")
            .run(timestamp, opId);

          allocations.push({ operationId: opId, websiteId: wid, serverId, intentDigest, websiteDigest });
        }

        invalidate(input.userId);
        if (parent) invalidate(parent.user_id);
        audit(actor.id, 'hosting.legacy_user_migrated', { type: 'user', id: input.userId });

        const receipt = Object.freeze({
          migrationId: randomUUID(),
          customerId: input.userId,
          resellerId: input.resellerId,
          serverId,
          previousGrants: existingGrants,
          migratedWebsites: [...websiteIds],
          allocations,
          quotas: input.quotas ? validateCustomerQuotas(input.quotas) : null,
          migratedAt: timestamp,
        });

        const revokes = [input.userId, ...(parent ? [parent.user_id] : [])];
        return { receipt, revokes };
      });

      for (const id of outcome.revokes) revokeLiveUser(id, 'hosting_legacy_user_migrated');
      return outcome.receipt;
    },
    rollbackLegacyUserMigration(rawToken, requireManagement, receipt) {
      const outcome = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        if (!plain(receipt) || !identifier(receipt.customerId) || !Array.isArray(receipt.migratedWebsites)
          || !Array.isArray(receipt.previousGrants) || !Array.isArray(receipt.allocations)) {
          throw error('invalid_hosting_rollback_receipt', 'A valid migration receipt is required.');
        }

        const account = existing(receipt.customerId);
        if (account.kind !== 'customer') throw error('hosting_account_state_invalid', 'Account is not a customer.', 503);

        for (const alloc of receipt.allocations) {
          const row = db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE operation_id = ?').get(alloc.operationId);
          if (!row || row.website_id !== alloc.websiteId || row.customer_id !== receipt.customerId || row.state !== 'attached') {
            throw error('hosting_site_state_invalid', 'Allocation state drift detected during rollback.', 503);
          }
          const owned = db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?')
            .get(alloc.websiteId, receipt.customerId);
          if (!owned) throw error('hosting_site_state_invalid', 'Website ownership drift detected during rollback.', 503);
        }

        for (const alloc of receipt.allocations) {
          db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?')
            .run(alloc.websiteId, receipt.customerId);
          db.prepare('DELETE FROM auth_hosting_site_allocations WHERE operation_id = ?').run(alloc.operationId);
        }

        db.prepare('DELETE FROM auth_customer_quotas WHERE customer_id = ?').run(receipt.customerId);
        db.prepare('DELETE FROM auth_hosting_accounts WHERE user_id = ?').run(receipt.customerId);

        for (const wid of receipt.previousGrants) {
          db.prepare('INSERT INTO auth_user_websites (user_id, website_id) VALUES (?, ?)').run(receipt.customerId, wid);
        }

        invalidate(receipt.customerId);
        if (receipt.resellerId) invalidate(receipt.resellerId);
        audit(actor.id, 'hosting.legacy_user_migration_rolled_back', { type: 'user', id: receipt.customerId });

        const revokes = [receipt.customerId, ...(receipt.resellerId ? [receipt.resellerId] : [])];
        return {
          result: {
            rolledBack: true,
            customerId: receipt.customerId,
            restoredWebsites: [...receipt.previousGrants],
          },
          revokes,
        };
      });

      for (const id of outcome.revokes) revokeLiveUser(id, 'hosting_legacy_user_migration_rolled_back');
      return outcome.result;
    },
    migrateWebsiteOwnership(rawToken, requireManagement, input) {
      const outcome = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        fields(input, ['websiteId', 'targetCustomerId', 'expectedSourceCustomerId']);
        if (!identifier(input.websiteId) || !identifier(input.targetCustomerId) || !identifier(input.expectedSourceCustomerId)) {
          throw error('invalid_hosting_account_input', 'Valid website and customer identifiers are required.');
        }

        const sourceCustomer = existing(input.expectedSourceCustomerId);
        if (sourceCustomer.kind !== 'customer') throw error('hosting_account_state_invalid', 'Source must be customer.', 409);
        const targetCustomer = existing(input.targetCustomerId);
        if (targetCustomer.kind !== 'customer' || !targetCustomer.active) throw error('hosting_account_inactive', 'Target customer must be active.', 403);

        const currentOwnership = db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(input.websiteId);
        if (!currentOwnership || currentOwnership.customer_id !== input.expectedSourceCustomerId) {
          throw error('hosting_site_identity_conflict', 'Website is not currently owned by expected source customer.', 409);
        }

        const currentAllocation = db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE website_id = ?').get(input.websiteId);
        if (!currentAllocation || currentAllocation.customer_id !== input.expectedSourceCustomerId || currentAllocation.state !== 'attached') {
          throw error('hosting_site_state_invalid', 'Current site allocation requires reconciliation.', 503);
        }

        const targetQuotas = customerQuotas(input.targetCustomerId);
        if (targetQuotas.maxWebsites !== null) {
          const currentUsage = customerUsage(input.targetCustomerId);
          if (currentUsage.websites >= targetQuotas.maxWebsites) {
            throw error('customer_quota_exceeded', 'Target customer website quota reached.', 409);
          }
        }

        const targetParent = targetCustomer.reseller_id ? existing(targetCustomer.reseller_id) : null;
        if (targetParent) {
          assertResellerCapacity({ limits: limits(targetParent.user_id), usage: usage(targetParent), resource: 'websites' });
        }

        const timestamp = now();
        const newOpId = randomUUID();

        db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?')
          .run(input.websiteId, input.expectedSourceCustomerId);
        db.prepare('DELETE FROM auth_hosting_site_allocations WHERE operation_id = ?').run(currentAllocation.operation_id);

        db.prepare(`INSERT INTO auth_hosting_site_allocations
          (operation_id, website_id, customer_id, server_id, intent_digest, website_digest, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(
            newOpId, input.websiteId, input.targetCustomerId, currentAllocation.server_id,
            currentAllocation.intent_digest, currentAllocation.website_digest, timestamp,
          );
        db.prepare('INSERT INTO auth_customer_websites (website_id, customer_id, created_at) VALUES (?, ?, ?)')
          .run(input.websiteId, input.targetCustomerId, timestamp);
        db.prepare("UPDATE auth_hosting_site_allocations SET state = 'attached', attached_at = ? WHERE operation_id = ?")
          .run(timestamp, newOpId);

        const revokes = [input.expectedSourceCustomerId, input.targetCustomerId];
        if (sourceCustomer.reseller_id) revokes.push(sourceCustomer.reseller_id);
        if (targetCustomer.reseller_id) revokes.push(targetCustomer.reseller_id);

        for (const id of revokes) invalidate(id);
        audit(actor.id, 'hosting.website_ownership_migrated', {
          type: 'website',
          id: input.websiteId,
          from: input.expectedSourceCustomerId,
          to: input.targetCustomerId,
        });

        const receipt = Object.freeze({
          migrationId: randomUUID(),
          websiteId: input.websiteId,
          previousCustomerId: input.expectedSourceCustomerId,
          targetCustomerId: input.targetCustomerId,
          previousAllocation: {
            operationId: currentAllocation.operation_id,
            serverId: currentAllocation.server_id,
            intentDigest: currentAllocation.intent_digest,
            websiteDigest: currentAllocation.website_digest,
          },
          newAllocation: {
            operationId: newOpId,
            serverId: currentAllocation.server_id,
          },
          migratedAt: timestamp,
        });

        return { receipt, revokes };
      });

      for (const id of outcome.revokes) revokeLiveUser(id, 'hosting_website_ownership_migrated');
      return outcome.receipt;
    },
    rollbackWebsiteOwnershipMigration(rawToken, requireManagement, receipt) {
      const outcome = transaction(() => {
        const actor = owner(rawToken, requireManagement);
        if (!plain(receipt) || !identifier(receipt.websiteId) || !identifier(receipt.previousCustomerId)
          || !identifier(receipt.targetCustomerId) || !plain(receipt.previousAllocation)) {
          throw error('invalid_hosting_rollback_receipt', 'A valid migration receipt is required.');
        }

        const currentOwnership = db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(receipt.websiteId);
        if (!currentOwnership || currentOwnership.customer_id !== receipt.targetCustomerId) {
          throw error('hosting_site_state_invalid', 'Website ownership drifted before rollback.', 503);
        }

        const currentAlloc = db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE website_id = ?').get(receipt.websiteId);
        if (!currentAlloc || currentAlloc.customer_id !== receipt.targetCustomerId || currentAlloc.state !== 'attached') {
          throw error('hosting_site_state_invalid', 'Website allocation drifted before rollback.', 503);
        }

        const sourceCustomer = existing(receipt.previousCustomerId);
        const targetCustomer = existing(receipt.targetCustomerId);

        const timestamp = now();
        db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?')
          .run(receipt.websiteId, receipt.targetCustomerId);
        db.prepare('DELETE FROM auth_hosting_site_allocations WHERE operation_id = ?').run(currentAlloc.operation_id);

        const restoredOpId = receipt.previousAllocation.operationId;
        db.prepare(`INSERT INTO auth_hosting_site_allocations
          (operation_id, website_id, customer_id, server_id, intent_digest, website_digest, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(
            restoredOpId, receipt.websiteId, receipt.previousCustomerId,
            receipt.previousAllocation.serverId, receipt.previousAllocation.intentDigest,
            receipt.previousAllocation.websiteDigest, timestamp,
          );
        db.prepare('INSERT INTO auth_customer_websites (website_id, customer_id, created_at) VALUES (?, ?, ?)')
          .run(receipt.websiteId, receipt.previousCustomerId, timestamp);
        db.prepare("UPDATE auth_hosting_site_allocations SET state = 'attached', attached_at = ? WHERE operation_id = ?")
          .run(timestamp, restoredOpId);

        const revokes = [receipt.previousCustomerId, receipt.targetCustomerId];
        if (sourceCustomer.reseller_id) revokes.push(sourceCustomer.reseller_id);
        if (targetCustomer.reseller_id) revokes.push(targetCustomer.reseller_id);

        for (const id of revokes) invalidate(id);
        audit(actor.id, 'hosting.website_ownership_migration_rolled_back', {
          type: 'website',
          id: receipt.websiteId,
          restoredCustomer: receipt.previousCustomerId,
        });

        return {
          result: {
            rolledBack: true,
            websiteId: receipt.websiteId,
            restoredCustomerId: receipt.previousCustomerId,
          },
          revokes,
        };
      });

      for (const id of outcome.revokes) revokeLiveUser(id, 'hosting_website_ownership_migration_rolled_back');
      return outcome.result;
    },
    reauthorizeTenantWebsite(rawTokenOrActor, websiteId, { throwOnError = false } = {}) {
      if (!identifier(websiteId)) {
        if (throwOnError) throw error('site_scope_forbidden', 'Invalid website identifier.', 403);
        return null;
      }

      let actor = null;
      let session = null;
      if (typeof rawTokenOrActor === 'string') {
        session = getSession(rawTokenOrActor);
        if (!session?.user?.id) {
          if (throwOnError) throw error('unauthorized', 'Sign in to continue.', 401);
          return null;
        }
        actor = session.user;
      } else if (rawTokenOrActor && typeof rawTokenOrActor === 'object') {
        if (rawTokenOrActor.rawToken) {
          session = getSession(rawTokenOrActor.rawToken);
          if (!session?.user?.id) {
            if (throwOnError) throw error('unauthorized', 'Sign in to continue.', 401);
            return null;
          }
          actor = session.user;
        } else {
          actor = rawTokenOrActor.user || rawTokenOrActor;
        }
      }

      if (!actor || !identifier(actor.id)) {
        if (throwOnError) throw error('unauthorized', 'Sign in to continue.', 401);
        return null;
      }

      return transaction(() => {
        const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(actor.id);
        if (!user || user.active !== 1) {
          if (throwOnError) throw error('account_suspended', 'Account is suspended.', 403);
          return null;
        }

        if (user.role === 'owner') {
          const alloc = db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE website_id = ?').get(websiteId);
          if (!alloc || alloc.state !== 'attached') {
            if (throwOnError) throw error('site_scope_forbidden', 'Site is not attached or allocated.', 403);
            return null;
          }
          return {
            authorized: true,
            actorId: user.id,
            role: 'owner',
            kind: 'owner',
            websiteId,
            customerId: alloc.customer_id,
            resellerId: null,
          };
        }

        const hostingRow = raw(user.id);
        if (hostingRow) {
          if (!hostingRow.active) {
            if (throwOnError) throw error('account_suspended', 'Hosting account is suspended.', 403);
            return null;
          }

          if (hostingRow.kind === 'customer') {
            if (hostingRow.reseller_id) {
              const parent = raw(hostingRow.reseller_id);
              const parentUser = db.prepare('SELECT active FROM users WHERE id = ?').get(hostingRow.reseller_id);
              if (!parent || !parent.active || !parentUser || parentUser.active !== 1) {
                if (throwOnError) throw error('account_suspended', 'Parent reseller is suspended.', 403);
                return null;
              }
            }

            const owned = db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?').get(websiteId, user.id);
            const alloc = db.prepare("SELECT 1 FROM auth_hosting_site_allocations WHERE website_id = ? AND customer_id = ? AND state = 'attached'").get(websiteId, user.id);
            if (!owned || !alloc) {
              if (throwOnError) throw error('site_scope_forbidden', 'Website is not attached to this customer account.', 403);
              return null;
            }

            return {
              authorized: true,
              actorId: user.id,
              role: user.role,
              kind: 'customer',
              websiteId,
              customerId: user.id,
              resellerId: hostingRow.reseller_id,
            };
          }

          if (hostingRow.kind === 'reseller') {
            const childOwnership = db.prepare(`SELECT w.website_id, w.customer_id, h.active AS child_active, u.active AS user_active
              FROM auth_customer_websites w
              JOIN auth_hosting_accounts h ON h.user_id = w.customer_id
              JOIN users u ON u.id = w.customer_id
              WHERE w.website_id = ? AND h.reseller_id = ?`).get(websiteId, user.id);

            const alloc = db.prepare("SELECT 1 FROM auth_hosting_site_allocations WHERE website_id = ? AND state = 'attached'").get(websiteId);

            if (!childOwnership || !alloc || !childOwnership.child_active || childOwnership.user_active !== 1) {
              if (throwOnError) throw error('site_scope_forbidden', 'Website is not owned by an active child customer.', 403);
              return null;
            }

            return {
              authorized: true,
              actorId: user.id,
              role: user.role,
              kind: 'reseller',
              websiteId,
              customerId: childOwnership.customer_id,
              resellerId: user.id,
            };
          }
        }

        if (user.role === 'site_manager') {
          const grant = db.prepare('SELECT 1 FROM auth_user_websites WHERE user_id = ? AND website_id = ?').get(user.id, websiteId);
          if (!grant) {
            if (throwOnError) throw error('site_scope_forbidden', 'Website is not granted to this login.', 403);
            return null;
          }
          return {
            authorized: true,
            actorId: user.id,
            role: 'site_manager',
            kind: 'legacy_user',
            websiteId,
            customerId: null,
            resellerId: null,
          };
        }

        if (throwOnError) throw error('site_scope_forbidden', 'Access to website is not permitted.', 403);
        return null;
      });
    },
    reauthorizeJobActor(authorization, { throwOnError = false } = {}) {
      if (!authorization || typeof authorization !== 'object') {
        if (throwOnError) throw error('unauthorized', 'Job authorization is missing or invalid.', 401);
        return null;
      }
      const actorId = authorization.actorId || authorization.userId || authorization.customerId;
      const websiteId = authorization.websiteId || authorization.resourceId;
      if (!actorId) {
        if (throwOnError) throw error('unauthorized', 'Job authorization actor is missing.', 401);
        return null;
      }
      if (websiteId) {
        return this.reauthorizeTenantWebsite({ id: actorId }, websiteId, { throwOnError });
      }
      return transaction(() => {
        const user = db.prepare('SELECT id, role, active FROM users WHERE id = ?').get(actorId);
        if (!user || user.active !== 1) {
          if (throwOnError) throw error('account_suspended', 'Account is suspended.', 403);
          return null;
        }
        const hostingRow = raw(user.id);
        if (hostingRow) {
          if (!hostingRow.active) {
            if (throwOnError) throw error('account_suspended', 'Hosting account is suspended.', 403);
            return null;
          }
          if (hostingRow.kind === 'customer' && hostingRow.reseller_id) {
            const parent = raw(hostingRow.reseller_id);
            const parentUser = db.prepare('SELECT active FROM users WHERE id = ?').get(hostingRow.reseller_id);
            if (!parent || !parent.active || !parentUser || parentUser.active !== 1) {
              if (throwOnError) throw error('account_suspended', 'Parent reseller is suspended.', 403);
              return null;
            }
          }
        }
        return {
          authorized: true,
          actorId: user.id,
          role: user.role,
          kind: hostingRow?.kind || user.role,
        };
      });
    },
  };
}
