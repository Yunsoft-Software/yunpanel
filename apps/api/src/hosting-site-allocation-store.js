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
const removalFields = ['operationId', 'websiteId', 'serverId', 'applicationId', 'websiteAbsent', 'applicationAbsent'];
const uncreatedFields = ['operationId', 'websiteId', 'serverId', 'applicationId', 'websiteAbsent', 'applicationAbsent'];
function input(value) {
  if (!plain(value) || Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key))
    || !['operationId', 'websiteId', 'serverId'].every((key) => uuid(value[key])) || !identifier(value.customerId)
    || !digest(value.intentDigest) || !digest(value.websiteDigest)) throw invalid();
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}
function removalEvidence(value) {
  if (!plain(value) || Object.keys(value).length !== removalFields.length
    || !removalFields.every((key) => Object.hasOwn(value, key))
    || !identifier(value.operationId)
    || !uuid(value.websiteId) || !uuid(value.serverId)
    || (value.applicationId !== null && !uuid(value.applicationId))
    || value.websiteAbsent !== true
    || value.applicationAbsent !== (value.applicationId !== null)) {
    throw new AuthError('hosting_site_release_evidence_invalid', 'Verified Website removal evidence is required before releasing capacity.', 409);
  }
  return Object.fromEntries(removalFields.map((key) => [key, value[key]]));
}
function uncreatedEvidence(value) {
  if (!plain(value) || Object.keys(value).length !== uncreatedFields.length
    || !uncreatedFields.every((key) => Object.hasOwn(value, key))
    || !uuid(value.operationId)
    || !uuid(value.websiteId) || !uuid(value.serverId)
    || (value.applicationId !== null && !uuid(value.applicationId))
    || value.websiteAbsent !== true
    || value.applicationAbsent !== (value.applicationId !== null)) {
    throw new AuthError(
      'hosting_site_recovery_evidence_invalid',
      'Verified absence of operation-owned site metadata is required before releasing a reservation.',
      409,
    );
  }
  return Object.fromEntries(uncreatedFields.map((key) => [key, value[key]]));
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
    /** Explicit recovery hook for a quota hold whose site metadata never became
     * durable. This is never called from a catch/timer. The caller must inspect
     * the canonical registries under the shared site mutation lock first.
     */
    releaseUncreated(value) {
      const proof = uncreatedEvidence(value);
      const result = transaction(() => {
        hostingWebsitesForCapacity(db);
        const row = read(proof.operationId);
        if (!row) {
          return { receipt: Object.freeze({
            websiteId: proof.websiteId,
            allocationOperationId: proof.operationId,
            released: false,
            quotaReleased: false,
          }), revoke: [] };
        }
        if (row.website_id !== proof.websiteId || row.server_id !== proof.serverId) throw conflict();
        if (row.state !== 'reserved') {
          throw new AuthError(
            'hosting_site_recovery_requires_removal',
            'Persisted site ownership must use the Website removal lifecycle before capacity can be released.',
            409,
          );
        }
        if (db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ?').get(proof.websiteId)) {
          throw new AuthError(
            'hosting_site_state_invalid',
            'Reserved Website ownership requires reconciliation before recovery.',
            503,
          );
        }

        const account = projection(existing(row.customer_id));
        const revoke = [account.id];
        if (account.resellerId !== null) {
          const parent = projection(existing(account.resellerId));
          if (parent.kind !== 'reseller') {
            throw new AuthError('hosting_site_state_invalid', 'Hosting parent state requires reconciliation.', 503);
          }
          revoke.push(parent.id);
        }

        const deleted = db.prepare(`DELETE FROM auth_hosting_site_allocations
          WHERE operation_id = ? AND website_id = ? AND state = 'reserved'`)
          .run(row.operation_id, proof.websiteId);
        if (deleted.changes !== 1
          || db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE operation_id = ?').get(row.operation_id)
          || db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ?').get(proof.websiteId)) {
          throw new AuthError(
            'hosting_site_recovery_unverified',
            'Site reservation recovery could not be verified.',
            503,
          );
        }

        for (const id of revoke) invalidate(id);
        audit(null, 'hosting.website_reservation_released', { type: 'website', id: proof.websiteId });
        return {
          receipt: Object.freeze({
            websiteId: proof.websiteId,
            customerId: row.customer_id,
            allocationOperationId: row.operation_id,
            released: true,
            quotaReleased: true,
          }),
          revoke,
        };
      });
      for (const id of result.revoke) revokeLiveUser(id, 'hosting_website_reservation_released');
      return result.receipt;
    },
    /** Internal lifecycle hook only. No timer, HTTP endpoint or catch-delete.
     * Capacity is released only after the Website removal runtime independently
     * proves Website absence and, when applicable, Application absence.
     */
    releaseRemoved(value) {
      const proof = removalEvidence(value);
      const result = transaction(() => {
        hostingWebsitesForCapacity(db);
        const row = db.prepare('SELECT * FROM auth_hosting_site_allocations WHERE website_id = ?').get(proof.websiteId);
        if (!row) return { receipt: Object.freeze({ websiteId: proof.websiteId, released: false, quotaReleased: false }), revoke: [] };
        if (row.server_id !== proof.serverId) throw conflict();

        const ownership = db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(proof.websiteId) ?? null;
        if (row.state === 'attached') {
          if (!ownership || ownership.customer_id !== row.customer_id) {
            throw new AuthError('hosting_site_state_invalid', 'Attached Website ownership requires reconciliation before capacity release.', 503);
          }
        } else if (row.state === 'reserved') {
          if (ownership !== null) {
            throw new AuthError('hosting_site_state_invalid', 'Reserved Website ownership requires reconciliation before capacity release.', 503);
          }
        } else {
          throw new AuthError('hosting_site_state_invalid', 'Site allocation state requires reconciliation.', 503);
        }

        const account = projection(existing(row.customer_id));
        const revoke = [account.id];
        if (account.resellerId !== null) {
          const parent = projection(existing(account.resellerId));
          if (parent.kind !== 'reseller') throw new AuthError('hosting_site_state_invalid', 'Hosting parent state requires reconciliation.', 503);
          revoke.push(parent.id);
        }

        if (row.state === 'attached') {
          db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?').run(proof.websiteId, row.customer_id);
        }
        const deleted = db.prepare('DELETE FROM auth_hosting_site_allocations WHERE operation_id = ? AND website_id = ?')
          .run(row.operation_id, proof.websiteId);
        if (deleted.changes !== 1) {
          throw new AuthError('hosting_site_release_unverified', 'Site allocation capacity release could not be verified.', 503);
        }
        if (db.prepare('SELECT 1 FROM auth_hosting_site_allocations WHERE website_id = ?').get(proof.websiteId)
          || db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ?').get(proof.websiteId)) {
          throw new AuthError('hosting_site_release_unverified', 'Site ownership remained after capacity release.', 503);
        }

        for (const id of revoke) invalidate(id);
        audit(null, 'hosting.website_released', { type: 'website', id: proof.websiteId });
        return {
          receipt: Object.freeze({
            websiteId: proof.websiteId,
            customerId: row.customer_id,
            allocationOperationId: row.operation_id,
            removalOperationId: proof.operationId,
            released: true,
            quotaReleased: true,
          }),
          revoke,
        };
      });
      for (const id of result.revoke) revokeLiveUser(id, 'hosting_website_released');
      return result.receipt;
    },
  });
}
