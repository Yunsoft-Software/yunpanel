import { AuthError } from './auth-error.js';
import { initializeHostingSiteAllocationSchema, rollbackEmptyHostingSiteAllocationSchema } from './hosting-site-allocation-schema.js';

const version = 3;
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
  ['table', 'auth_hosting_lifecycle_intents', `CREATE TABLE auth_hosting_lifecycle_intents (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE CASCADE,
    target_active INTEGER NOT NULL CHECK(target_active IN (0, 1)),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL
  )`],
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
  // General user writes remain blocked. Hosting lifecycle changes require a
  // same-transaction intent from an active Owner or the exact active parent reseller
  // of a direct customer; the active-state update consumes that one-shot intent.
  ['trigger', 'auth_hosting_lifecycle_intent_insert', `CREATE TRIGGER auth_hosting_lifecycle_intent_insert BEFORE INSERT ON auth_hosting_lifecycle_intents BEGIN
    SELECT CASE WHEN NOT (
      EXISTS(SELECT 1 FROM users WHERE id = NEW.actor_id AND role = 'owner' AND active = 1)
      OR EXISTS(
        SELECT 1 FROM users actor
        JOIN auth_hosting_accounts reseller ON reseller.user_id = actor.id
        JOIN auth_hosting_accounts customer ON customer.user_id = NEW.user_id
        WHERE actor.id = NEW.actor_id AND actor.role = 'site_manager' AND actor.active = 1
          AND reseller.kind = 'reseller' AND reseller.reseller_id IS NULL
          AND customer.kind = 'customer' AND customer.reseller_id = reseller.user_id
      )
    ) THEN RAISE(ABORT, 'hosting_lifecycle_actor_required') END;
  END`],
  ['trigger', 'auth_hosting_lifecycle_intent_immutable', `CREATE TRIGGER auth_hosting_lifecycle_intent_immutable BEFORE UPDATE ON auth_hosting_lifecycle_intents BEGIN
      SELECT RAISE(ABORT, 'hosting_lifecycle_intent_immutable');
  END`],
  ['trigger', 'auth_hosting_legacy_user_guard', `CREATE TRIGGER auth_hosting_legacy_user_guard BEFORE UPDATE OF role, active ON users
    WHEN EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
      SELECT CASE WHEN NEW.role IS NOT OLD.role
        THEN RAISE(ABORT, 'hosting_account_lifecycle_not_enabled') END;
      SELECT CASE WHEN NEW.active IS NOT OLD.active AND NOT EXISTS(
        SELECT 1 FROM auth_hosting_lifecycle_intents i
        JOIN users actor ON actor.id = i.actor_id
        LEFT JOIN auth_hosting_accounts reseller ON reseller.user_id = actor.id
        LEFT JOIN auth_hosting_accounts customer ON customer.user_id = OLD.id
        WHERE i.user_id = OLD.id AND i.target_active = NEW.active
          AND (
            (actor.role = 'owner' AND actor.active = 1)
            OR (
              actor.role = 'site_manager' AND actor.active = 1
              AND reseller.kind = 'reseller' AND reseller.reseller_id IS NULL
              AND customer.kind = 'customer' AND customer.reseller_id = reseller.user_id
            )
          )
      ) THEN RAISE(ABORT, 'hosting_account_lifecycle_not_enabled') END;
  END`],
  ['trigger', 'auth_hosting_lifecycle_intent_consume', `CREATE TRIGGER auth_hosting_lifecycle_intent_consume AFTER UPDATE OF active ON users
    WHEN NEW.active IS NOT OLD.active
      AND EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
      DELETE FROM auth_hosting_lifecycle_intents WHERE user_id = OLD.id;
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
const v2LifecycleIntentInsert = ['trigger', 'auth_hosting_lifecycle_intent_insert', `CREATE TRIGGER auth_hosting_lifecycle_intent_insert BEFORE INSERT ON auth_hosting_lifecycle_intents
    WHEN NOT EXISTS(SELECT 1 FROM users WHERE id = NEW.actor_id AND role = 'owner' AND active = 1) BEGIN
      SELECT RAISE(ABORT, 'hosting_lifecycle_owner_required');
  END`];
const v2LegacyUserGuard = ['trigger', 'auth_hosting_legacy_user_guard', `CREATE TRIGGER auth_hosting_legacy_user_guard BEFORE UPDATE OF role, active ON users
    WHEN EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
      SELECT CASE WHEN NEW.role IS NOT OLD.role
        THEN RAISE(ABORT, 'hosting_account_lifecycle_not_enabled') END;
      SELECT CASE WHEN NEW.active IS NOT OLD.active AND NOT EXISTS(
        SELECT 1 FROM auth_hosting_lifecycle_intents i
        JOIN users actor ON actor.id = i.actor_id
        WHERE i.user_id = OLD.id AND i.target_active = NEW.active
          AND actor.role = 'owner' AND actor.active = 1
      ) THEN RAISE(ABORT, 'hosting_account_lifecycle_not_enabled') END;
  END`];
const v2Objects = objects.map((entry) => {
  if (entry[1] === 'auth_hosting_lifecycle_intent_insert') return v2LifecycleIntentInsert;
  if (entry[1] === 'auth_hosting_legacy_user_guard') return v2LegacyUserGuard;
  return entry;
});
const legacyV1Guard = ['trigger', 'auth_hosting_legacy_user_guard', `CREATE TRIGGER auth_hosting_legacy_user_guard BEFORE UPDATE OF role, active ON users
    WHEN (NEW.role IS NOT OLD.role OR NEW.active IS NOT OLD.active)
      AND EXISTS(SELECT 1 FROM auth_hosting_accounts WHERE user_id = OLD.id) BEGIN
      SELECT RAISE(ABORT, 'hosting_account_lifecycle_not_enabled');
  END`];
const v1Objects = v2Objects
  .filter(([, name]) => ![
    'auth_hosting_lifecycle_intents',
    'auth_hosting_lifecycle_intent_insert',
    'auth_hosting_lifecycle_intent_immutable',
    'auth_hosting_lifecycle_intent_consume',
  ].includes(name))
  .map((entry) => entry[1] === 'auth_hosting_legacy_user_guard' ? legacyV1Guard : entry);
const normalized = (sql) => sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');
const invalid = () => new AuthError('hosting_schema_invalid', 'Hosting account schema requires an explicit migration or recovery.', 503);

function expectedObjects(schemaVersion) {
  if (schemaVersion === 1) return v1Objects;
  if (schemaVersion === 2) return v2Objects;
  if (schemaVersion === version) return objects;
  throw invalid();
}

function inspect(db) {
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw invalid();
  for (const table of ['users', 'auth_user_websites']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) throw invalid();
  }
  const marker = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_hosting_schema'").get();
  const knownNames = [...new Set(objects.map(([, name]) => name))];
  if (!marker) {
    const partial = db.prepare("SELECT 1 FROM sqlite_master WHERE name IN (" + knownNames.map(() => '?').join(',') + ') LIMIT 1')
      .get(...knownNames);
    if (partial) throw invalid();
    return false;
  }
  const metadata = db.prepare('SELECT id, version FROM auth_hosting_schema').all();
  if (metadata.length !== 1 || metadata[0].id !== 1) throw invalid();
  const schemaVersion = metadata[0].version;
  const expected = expectedObjects(schemaVersion);
  const found = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name IN (" + knownNames.map(() => '?').join(',') + ')')
    .all(...knownNames);
  if (found.length !== expected.length) throw invalid();
  for (const [type, name, sql] of expected) {
    const entry = found.find((item) => item.name === name);
    if (entry?.type !== type || normalized(entry.sql) !== normalized(sql)) throw invalid();
  }
  if (found.some((entry) => !expected.some(([, name]) => name === entry.name))) throw invalid();
  const foreignKeyTables = ['auth_hosting_accounts', 'auth_reseller_limits', 'auth_customer_websites'];
  if (schemaVersion === version) foreignKeyTables.push('auth_hosting_lifecycle_intents');
  for (const table of foreignKeyTables) {
    if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) throw invalid();
  }
  return schemaVersion;
}

function migrateV1ToV2(db) {
  db.exec('DROP TRIGGER auth_hosting_legacy_user_guard');
  const additions = v2Objects.filter(([, name]) => [
    'auth_hosting_lifecycle_intents',
    'auth_hosting_lifecycle_intent_insert',
    'auth_hosting_lifecycle_intent_immutable',
    'auth_hosting_legacy_user_guard',
    'auth_hosting_lifecycle_intent_consume',
  ].includes(name));
  for (const [, , sql] of additions) db.exec(sql);
  db.prepare('UPDATE auth_hosting_schema SET version = 2 WHERE id = 1 AND version = 1').run();
}

function migrateV2ToV3(db) {
  db.exec('DROP TRIGGER auth_hosting_lifecycle_intent_insert; DROP TRIGGER auth_hosting_legacy_user_guard;');
  for (const [, , sql] of objects.filter(([, name]) => [
    'auth_hosting_lifecycle_intent_insert',
    'auth_hosting_legacy_user_guard',
  ].includes(name))) db.exec(sql);
  db.prepare('UPDATE auth_hosting_schema SET version = 3 WHERE id = 1 AND version = 2').run();
}

/** Additive sidecar in the EXISTING auth DB. Never rebuild users, change their IDs,
 * roles, passwords, sessions, grants, PRAGMA user_version or Website/Unix identities.
 * The supplied transaction is the auth store's synchronous BEGIN IMMEDIATE writer.
 */
export function initializeHostingAccountSchema({ db, transaction }) {
  return transaction(() => {
    const current = inspect(db);
    const created = current === false;
    if (created) {
      for (const [, , sql] of objects) db.exec(sql);
      db.prepare('INSERT INTO auth_hosting_schema VALUES (1, ?)').run(version);
    } else {
      let migrated = current;
      if (migrated === 1) {
        migrateV1ToV2(db);
        migrated = 2;
      }
      if (migrated === 2) migrateV2ToV3(db);
    }
    initializeHostingSiteAllocationSchema(db);
    if (inspect(db) !== version) throw invalid();
    return { version, created };
  });
}

/** Offline, empty-only rollback; never silently discard registered accounts/sites.
 * Caller must stop API/CLI writers and take a verified backup. This is not an HTTP API.
 */
export function rollbackEmptyHostingAccountSchema({ db, transaction }) {
  return transaction(() => {
    const current = inspect(db);
    if (current === false) return { removed: false };
    const dataTables = ['auth_hosting_accounts', 'auth_reseller_limits', 'auth_customer_websites'];
    if (current >= 2) dataTables.push('auth_hosting_lifecycle_intents');
    for (const table of dataTables) {
      if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
        throw new AuthError('hosting_schema_in_use', 'Hosting account data must be migrated before rollback.', 409);
      }
    }
    rollbackEmptyHostingSiteAllocationSchema(db);
    const expected = expectedObjects(current);
    for (const [type, name] of [...expected].reverse().filter(([type]) => type === 'trigger')) db.exec(`DROP ${type} ${name}`);
    if (current >= 2) db.exec('DROP TABLE auth_hosting_lifecycle_intents');
    for (const name of ['auth_customer_websites', 'auth_reseller_limits', 'auth_hosting_accounts', 'auth_hosting_schema']) db.exec(`DROP TABLE ${name}`);
    return { removed: true };
  });
}

