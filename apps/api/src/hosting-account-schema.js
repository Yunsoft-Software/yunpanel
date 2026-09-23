import { AuthError } from './auth-error.js';

const version = 1;
const safeInteger = '9007199254740991';
const objects = [
  ['table', 'auth_hosting_schema', `CREATE TABLE auth_hosting_schema (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )`],
  ['table', 'auth_hosting_accounts', `CREATE TABLE auth_hosting_accounts (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK(kind IN ('reseller', 'customer')),
    reseller_id TEXT REFERENCES auth_hosting_accounts(user_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND ${safeInteger}),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK(kind != 'reseller' OR reseller_id IS NULL),
    CHECK(reseller_id IS NULL OR reseller_id != user_id)
  )`],
  ['index', 'idx_auth_hosting_parent', 'CREATE INDEX idx_auth_hosting_parent ON auth_hosting_accounts(reseller_id)'],
  ['table', 'auth_reseller_limits', `CREATE TABLE auth_reseller_limits (
    reseller_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE RESTRICT,
    max_customers INTEGER CHECK(max_customers IS NULL OR (typeof(max_customers) = 'integer' AND max_customers BETWEEN 0 AND ${safeInteger})),
    max_websites INTEGER CHECK(max_websites IS NULL OR (typeof(max_websites) = 'integer' AND max_websites BETWEEN 0 AND ${safeInteger}))
  )`],
  ['table', 'auth_customer_websites', `CREATE TABLE auth_customer_websites (
    website_id TEXT PRIMARY KEY NOT NULL,
    customer_id TEXT NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL
  )`],
  ['index', 'idx_auth_hosting_website_customer', 'CREATE INDEX idx_auth_hosting_website_customer ON auth_customer_websites(customer_id)'],
  ['trigger', 'auth_hosting_account_insert', `CREATE TRIGGER auth_hosting_account_insert BEFORE INSERT ON auth_hosting_accounts BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'site_manager')
      THEN RAISE(ABORT, 'hosting_profile_requires_site_manager') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM auth_user_websites WHERE user_id = NEW.user_id)
      THEN RAISE(ABORT, 'hosting_profile_requires_explicit_site_migration') END;
    SELECT CASE WHEN NEW.reseller_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM auth_hosting_accounts WHERE user_id = NEW.reseller_id AND kind = 'reseller')
      THEN RAISE(ABORT, 'hosting_parent_must_be_reseller') END;
  END`],
  ['trigger', 'auth_hosting_identity_immutable', `CREATE TRIGGER auth_hosting_identity_immutable BEFORE UPDATE ON auth_hosting_accounts
    WHEN NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind OR NEW.reseller_id IS NOT OLD.reseller_id BEGIN
      SELECT RAISE(ABORT, 'hosting_ownership_transfer_not_enabled');
  END`],
  ['trigger', 'auth_reseller_limits_insert', `CREATE TRIGGER auth_reseller_limits_insert BEFORE INSERT ON auth_reseller_limits
    WHEN NOT EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = NEW.reseller_id AND kind = 'reseller') BEGIN
      SELECT RAISE(ABORT, 'hosting_limits_require_reseller');
  END`],
  ['trigger', 'auth_reseller_limits_identity', `CREATE TRIGGER auth_reseller_limits_identity BEFORE UPDATE OF reseller_id ON auth_reseller_limits
    WHEN NEW.reseller_id IS NOT OLD.reseller_id BEGIN SELECT RAISE(ABORT, 'hosting_limits_identity_immutable'); END`],
  ['trigger', 'auth_customer_website_insert', `CREATE TRIGGER auth_customer_website_insert BEFORE INSERT ON auth_customer_websites
    WHEN NOT EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = NEW.customer_id AND kind = 'customer') BEGIN
      SELECT RAISE(ABORT, 'hosting_website_requires_customer');
  END`],
  ['trigger', 'auth_customer_website_identity', `CREATE TRIGGER auth_customer_website_identity BEFORE UPDATE ON auth_customer_websites
    WHEN NEW.website_id IS NOT OLD.website_id OR NEW.customer_id IS NOT OLD.customer_id BEGIN
      SELECT RAISE(ABORT, 'hosting_ownership_transfer_not_enabled');
  END`],
  // Staged rollout: no legacy endpoint may activate/reassign these profiles.
  // A later, versioned integration replaces these guards after all resource paths are scoped.
  ['trigger', 'auth_hosting_legacy_user_guard', `CREATE TRIGGER auth_hosting_legacy_user_guard BEFORE UPDATE OF role, active ON users
    WHEN (NEW.role IS NOT OLD.role OR NEW.active IS NOT OLD.active)
      AND EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
      SELECT RAISE(ABORT, 'hosting_account_lifecycle_not_enabled');
  END`],
  ['trigger', 'auth_hosting_legacy_grant_guard', `CREATE TRIGGER auth_hosting_legacy_grant_guard BEFORE INSERT ON auth_user_websites
    WHEN EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = NEW.user_id) BEGIN
      SELECT RAISE(ABORT, 'hosting_website_grants_not_enabled');
  END`],
  ['trigger', 'auth_hosting_legacy_grant_update_guard', `CREATE TRIGGER auth_hosting_legacy_grant_update_guard BEFORE UPDATE ON auth_user_websites
    WHEN EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id IN (OLD.user_id, NEW.user_id)) BEGIN
      SELECT RAISE(ABORT, 'hosting_website_grants_not_enabled');
  END`],
];
const normalized = (sql) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
const invalid = () => new AuthError('hosting_schema_invalid', 'Hosting account schema requires an explicit migration or recovery.', 503);

function inspect(db) {
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw invalid();
  for (const table of ['users', 'auth_user_websites']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw invalid();
  }
  const found = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name IN (" + objects.map(() => '?').join(',') + ')')
    .all(...objects.map(([, name]) => name));
  if (found.length === 0) return false;
  if (found.length !== objects.length) throw invalid();
  for (const [type, name, sql] of objects) {
    const entry = found.find((item) => item.name === name);
    if (entry?.type !== type || normalized(entry.sql) !== normalized(sql)) throw invalid();
  }
  const metadata = db.prepare('SELECT id, version FROM auth_hosting_schema').all();
  if (metadata.length !== 1 || metadata[0].id !== 1 || metadata[0].version !== version) throw invalid();
  for (const table of ['auth_hosting_accounts', 'auth_reseller_limits', 'auth_customer_websites']) {
    if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) throw invalid();
  }
  return true;
}

/** Additive sidecar in the EXISTING auth DB. Never rebuild users, change their IDs,
 * roles, passwords, sessions, grants, PRAGMA user_version or Website/Unix identities.
 * The supplied transaction is the auth store's synchronous BEGIN IMMEDIATE writer.
 */
export function initializeHostingAccountSchema({ db, transaction }) {
  return transaction(() => {
    if (inspect(db)) return { version, created: false };
    for (const [, , sql] of objects) db.exec(sql);
    db.prepare('INSERT INTO auth_hosting_schema VALUES (1, ?)').run(version);
    inspect(db);
    return { version, created: true };
  });
}

/** Offline, empty-only rollback; never silently discard registered accounts/sites.
 * Caller must stop API/CLI writers and take a verified backup. This is not an HTTP API.
 */
export function rollbackEmptyHostingAccountSchema({ db, transaction }) {
  return transaction(() => {
    if (!inspect(db)) return { removed: false };
    for (const table of ['auth_hosting_accounts', 'auth_reseller_limits', 'auth_customer_websites']) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        throw new AuthError('hosting_schema_in_use', 'Hosting account data must be migrated before rollback.', 409);
      }
    }
    for (const [type, name] of [...objects].reverse().filter(([type]) => type === 'trigger')) db.exec(`DROP ${type} ${name}`);
    for (const name of ['auth_customer_websites', 'auth_reseller_limits', 'auth_hosting_accounts', 'auth_hosting_schema']) db.exec(`DROP TABLE ${name}`);
    return { removed: true };
  });
}
