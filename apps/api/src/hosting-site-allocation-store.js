import { createHash } from 'node:crypto';
import { AuthError } from './auth-error.js';
import { assertResellerCapacity } from './reseller-limits.js';
import { hostingWebsitesForCapacity } from './hosting-site-allocation-schema.js';

const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const invalid = () => new AuthError('invalid_hosting_site_input', 'Use the verified site-create plan and an explicit customer.');
const conflict = () => new AuthError('hosting_site_identity_conflict', 'This operation or Website belongs to a different allocation.', 409);
const fields = ['operationId', 'websiteId', 'customerId', 'serverId', 'intentDigest', 'websiteDigest'];
const columns = ['operation_id', 'website_id', 'customer_id', 'server_id', 'intent_digest', 'website_digest'];
const websiteFields = ['id', 'serverId', 'name', 'applicationId', 'dockerWorkloadId', 'managedComposeBinding', 'runtimeType', 'documentRoot', 'unixUser', 'proxyTarget', 'revision'];
function input(value) {
  if (!plain(value) || Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))
    || !['operationId', 'websiteId', 'serverId'].every((key) => uuid(value[key])) || !identifier(value.customerId)
    || !digest(value.intentDigest) || !digest(value.websiteDigest)) throw invalid();
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  throw invalid();
}
export function hostingPlanDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function hostingWebsiteDigest(website) {
  if (!plain(website) || !websiteFields.every((key) => Object.hasOwn(website, key))
    || !uuid(website.id) || !uuid(website.serverId) || !Number.isSafeInteger(website.revision) || website.revision < 1) throw invalid();
  return hostingPlanDigest(Object.fromEntries(websiteFields.map((key) => [key, website[key]])));
}
function view(row) {
  return Object.freeze({ ...Object.fromEntries(fields.map((key, index) => [key, row[columns[index]]])),
    state: row.state, createdAt: row.created_at, attachedAt: row.attached_at, accessGranted: false });
}

/** Private Owner-only store; receives the PARENT store's live policy and transaction.
 * This does not dispatch host work, grant site access, or accept a request-body actor.
 * Registry evidence is loaded by hosting-site-create-service, not an HTTP caller.
 */
export function createHostingSiteAllocationStore({ db, now, transaction, owner, existing, projection, limits, usage, invalidate, audit, revokeLiveUser }) {
  const read = (operationId) => db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE operation_id = ?').get(operationId);
  function customer(id) {
    const current = projection(existing(id));
    if (current.kind !== 'customer') throw new AuthError('hosting_site_requires_customer', 'Select a customer account.', 409);
    const parent = current.resellerId === null ? null : existing(current.resellerId);
    if (!current.active || (parent && (projection(parent).kind !== 'reseller' || !projection(parent).active))) {
      throw new AuthError('hosting_account_inactive', 'The customer and its reseller must be active.', 403);
    }
    return { current, parent };
  }
  function check(rawToken, policy, value, requireExisting = false) {
    const actor = owner(rawToken, policy);
    const plan = input(value);
    const chain = customer(plan.customerId);
    hostingWebsitesForCapacity(db);
    const prior = read(plan.operationId);
    if (prior) {
      if (!fields.every((key, index) => plan[key] === prior[columns[index]])) throw conflict();
      return { actor, plan, chain, prior };
    }
    if (requireExisting) throw new AuthError('hosting_site_allocation_not_found', 'Reserve site capacity before attaching ownership.', 404);
    if (db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ?').get(plan.websiteId)
      || db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE website_id = ?').get(plan.websiteId)) throw conflict();
    // Existing site-manager grants are never silently promoted to customer ownership.
    if (db.prepare('SELECT 1 FROM auth_user_websites WHERE website_id = ?').get(plan.websiteId)) {
      throw new AuthError('hosting_site_migration_required', 'Existing Website grants require explicit ownership migration.', 409);
    }
    if (chain.parent) assertResellerCapacity({ limits: limits(chain.parent.user_id), usage: usage(chain.parent), resource: 'websites' });
    return { actor, plan, chain, prior: null };
  }
  return Object.freeze({
    preview(rawToken, policy, value) {
      return transaction(() => {
        const { plan, prior } = check(rawToken, policy, value);
        return prior ? view(prior) : Object.freeze({ ...plan, state: 'available', accessGranted: false });
      });
    },
    reserve(rawToken, policy, value) {
      return transaction(() => {
        const { actor, plan, prior } = check(rawToken, policy, value);
        if (prior) return view(prior);
        db.prepare(`INSERT INTO auth_hosting_site_allocations
          (operation_id, website_id, customer_id, server_id, intent_digest, website_digest, state, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?)`).run(...fields.map((key) => plan[key]), now());
        audit(actor.id, 'hosting.website_reserved', { type: 'website', id: plan.websiteId });
        return view(read(plan.operationId));
      });
    },
    complete(rawToken, policy, value, verifiedWebsite) {
      const result = transaction(() => {
        const { actor, plan, chain, prior } = check(rawToken, policy, value, true);
        if (hostingWebsiteDigest(verifiedWebsite) !== plan.websiteDigest
          || verifiedWebsite.id !== plan.websiteId || verifiedWebsite.serverId !== plan.serverId) throw conflict();
        if (prior.state === 'attached') return { allocation: view(prior), revoke: [] };
        if (db.prepare('SELECT 1 FROM auth_user_websites WHERE website_id = ?').get(plan.websiteId)) {
          throw new AuthError('hosting_site_migration_required', 'Website grants changed during creation; reconcile ownership.', 409);
        }
        db.prepare('INSERT INTO auth_customer_websites VALUES (?, ?, ?)').run(plan.websiteId, plan.customerId, now());
        db.prepare("UPDATE auth_hosting_site_allocations SET state = 'attached', attached_at = ? WHERE operation_id = ?")
          .run(now(), plan.operationId);
        const revoke = [chain.current.id, ...(chain.parent ? [chain.parent.user_id] : [])];
        for (const id of revoke) invalidate(id);
        audit(actor.id, 'hosting.website_attached', { type: 'website', id: plan.websiteId });
        return { allocation: view(read(plan.operationId)), revoke };
      });
      for (const id of result.revoke) revokeLiveUser(id, 'hosting_website_attached');
      return result.allocation;
    },
    // There is intentionally no timer, catch-delete or release API. A site may
    // already exist after a timeout; cleanup evidence must precede quota release.
  });
}
