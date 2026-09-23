import { AuthError } from './auth-error.js';

// A quota hold, NOT a second provisioning/job engine. The existing lifecycle owns
// create/retry/cleanup. A failed or interrupted operation must not free its hold.
const objects = [
  ['table', 'auth_hosting_site_schema', `CREATE TABLE auth_hosting_site_schema (
    id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL
  )`],
  ['table', 'auth_hosting_site_allocations', `CREATE TABLE auth_hosting_site_allocations (
    operation_id TEXT PRIMARY KEY NOT NULL, website_id TEXT UNIQUE NOT NULL,
    customer_id TEXT NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE RESTRICT,
    server_id TEXT NOT NULL, intent_digest TEXT NOT NULL, website_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved', 'attached')),
    created_at INTEGER NOT NULL, attached_at INTEGER,
    CHECK((state = 'reserved' AND attached_at IS NULL) OR (state = 'attached' AND attached_at IS NOT NULL))
  )`],
  ['index', 'idx_auth_hosting_site_customer', 'CREATE INDEX idx_auth_hosting_site_customer ON auth_hosting_site_allocations(customer_id, state)'],
  ['trigger', 'auth_hosting_site_insert', `CREATE TRIGGER auth_hosting_site_insert BEFORE INSERT ON auth_hosting_site_allocations BEGIN
    SELECT CASE WHEN NEW.state != 'reserved' OR NOT EXISTS(
      SELECT 1 FROM auth_hosting_accounts WHERE user_id = NEW.customer_id AND kind = 'customer')
      THEN RAISE(ABORT, 'hosting_site_requires_customer_reservation') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM auth_customer_websites WHERE website_id = NEW.website_id)
      THEN RAISE(ABORT, 'hosting_site_already_owned') END;
  END`],
  ['trigger', 'auth_hosting_site_identity', `CREATE TRIGGER auth_hosting_site_identity BEFORE UPDATE ON auth_hosting_site_allocations
    WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.website_id IS NOT OLD.website_id
      OR NEW.customer_id IS NOT OLD.customer_id OR NEW.server_id IS NOT OLD.server_id
      OR NEW.intent_digest IS NOT OLD.intent_digest OR NEW.website_digest IS NOT OLD.website_digest
      OR NEW.created_at IS NOT OLD.created_at BEGIN
      SELECT RAISE(ABORT, 'hosting_site_identity_immutable');
  END`],
  ['trigger', 'auth_hosting_site_transition', `CREATE TRIGGER auth_hosting_site_transition BEFORE UPDATE OF state, attached_at ON auth_hosting_site_allocations
    WHEN OLD.state != 'reserved' OR NEW.state != 'attached' OR NOT EXISTS(
      SELECT 1 FROM auth_customer_websites WHERE website_id = NEW.website_id AND customer_id = NEW.customer_id) BEGIN
      SELECT RAISE(ABORT, 'hosting_site_transition_invalid');
  END`],
];
const invalid = () => new AuthError('hosting_site_schema_invalid', 'Site allocation schema requires an explicit migration or recovery.', 503);
const normalized = (sql) => sql?.trim().replace(/;$/, '').replace(/\s+/g, ' ');
function inspect(db) {
  if (db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) throw invalid();
  const found = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name IN (${objects.map(() => '?').join(',')})`)
    .all(...objects.map(([, name]) => name));
  if (!found.length) return false;
  if (found.length !== objects.length) throw invalid();
  for (const [type, name, sql] of objects) {
    const current = found.find((item) => item.name === name);
    if (current?.type !== type || normalized(current.sql) !== normalized(sql)) throw invalid();
  }
  const metadata = db.prepare('SELECT id, version FROM auth_hosting_site_schema').all();
  if (metadata.length !== 1 || metadata[0].id !== 1 || metadata[0].version !== 1
    || db.prepare('PRAGMA foreign_key_check(auth_hosting_site_allocations)').all().length) throw invalid();
  return true;
}

/** Called INSIDE the existing auth schema transaction; never starts/nests one. */
export function initializeHostingSiteAllocationSchema(db) {
  if (inspect(db)) return;
  for (const [, , sql] of objects) db.exec(sql);
  db.exec('INSERT INTO auth_hosting_site_schema VALUES (1, 1)');
  inspect(db);
}

/** Offline empty-only rollback inside the parent's existing transaction. */
export function rollbackEmptyHostingSiteAllocationSchema(db) {
  if (!inspect(db)) return;
  if (db.prepare('SELECT 1 FROM auth_hosting_site_allocations LIMIT 1').get()) {
    throw new AuthError('hosting_schema_in_use', 'Site allocations require reconciliation before rollback.', 409);
  }
  for (const [type, name] of [...objects].reverse()) db.exec(`DROP ${type} ${name}`);
}

/** Caller holds the auth transaction. Count retained reservations as well as owned
 * sites, once each; missing or contradictory receipts are never treated as zero.
 */
export function hostingWebsitesForCapacity(db) {
  const inconsistent = db.prepare(`SELECT 1 FROM auth_hosting_site_allocations a
    LEFT JOIN auth_customer_websites w ON w.website_id = a.website_id
    WHERE (a.state = 'attached' AND (w.website_id IS NULL OR w.customer_id != a.customer_id))
       OR (a.state = 'reserved' AND w.website_id IS NOT NULL) LIMIT 1`).get();
  if (inconsistent) throw new AuthError('hosting_site_state_invalid', 'Site allocation state requires reconciliation.', 503);
  return db.prepare(`SELECT website_id AS id, customer_id AS customerId FROM auth_customer_websites
    UNION ALL SELECT website_id AS id, customer_id AS customerId FROM auth_hosting_site_allocations WHERE state = 'reserved'`).all();
}
