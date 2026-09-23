import { AuthError } from './auth-error.js';
import { hostingPlanDigest, hostingWebsiteDigest } from './hosting-site-allocation-store.js';

const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message, status = 409) => new AuthError(code, message, status);
function request(value, apply = false) {
  const keys = apply ? ['customerId', 'input', 'previewDigest', 'confirmation'] : ['customerId', 'input'];
  if (!plain(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))
    || !id(value.customerId) || !plain(value.input)
    || (apply && (!digest(value.previewDigest) || typeof value.confirmation !== 'string'))) {
    throw fail('invalid_hosting_site_request', 'Use an explicit customer and the current hosted-site preview.', 400);
  }
  // The customer already has a login. Never invoke the legacy createSiteManager path.
  if (value.input.siteAdmin != null) throw fail('hosting_site_admin_conflict', 'Use the customer login instead of creating a second site administrator.');
  try { return structuredClone(value); } catch { throw fail('invalid_hosting_site_request', 'Use JSON-compatible site input.', 400); }
}

/** Internal Owner adapter around the EXISTING preview/create functions. Not an HTTP
 * route, provisioning engine, permission grant or cross-store atomic transaction.
 * The auth quota hold survives every await/crash. Existing resource creation keeps
 * its validation/idempotency; its host jobs and cleanup are not reimplemented here.
 */
export function createHostingSiteCreateService({ hostingAccounts, websiteRegistry, localServerId, previewSiteCreate, createSite }) {
  const allocations = hostingAccounts?.siteAllocations;
  if (!id(localServerId) || ![hostingAccounts?.get, allocations?.preview, allocations?.reserve, allocations?.complete,
    websiteRegistry?.getWebsite, previewSiteCreate, createSite].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Hosted site creation requires live accounts, allocation storage, Website registry and local site-create adapters');
  }
  async function prepare(rawToken, policy, value) {
    hostingAccounts.get(rawToken, policy, value.customerId); // Live Owner check before reading runtime state.
    if (value.input.serverId !== localServerId) throw fail('local_server_required', 'Sites can be created only on this panel host.', 404);
    const base = await previewSiteCreate(value.input);
    const website = base?.plan?.website;
    if (!base || base.operationId !== value.input.operationId || website?.id !== base.ids?.websiteId
      || website?.serverId !== localServerId || !digest(base.previewDigest) || typeof base.confirmation !== 'string'
      || !Array.isArray(base.blockers) || !plain(base.steps) || typeof base.steps.websiteReady !== 'boolean') {
      throw fail('hosting_site_preview_invalid', 'The site-create adapter returned an invalid plan.', 503);
    }
    const allocationInput = {
      operationId: base.operationId, websiteId: website.id, customerId: value.customerId, serverId: localServerId,
      intentDigest: hostingPlanDigest({ operationId: base.operationId, customerId: value.customerId, plan: base.plan, source: base.source }),
      websiteDigest: hostingWebsiteDigest(website),
    };
    const allocation = allocations.preview(rawToken, policy, allocationInput);
    if (allocation.state === 'available' && base.steps.websiteReady) {
      throw fail('hosting_site_migration_required', 'An existing Website requires explicit ownership migration.');
    }
    const previewDigest = hostingPlanDigest({ customerId: value.customerId, allocationInput, sitePreviewDigest: base.previewDigest });
    const confirmation = `create-hosted-site:${base.operationId}:${previewDigest}`;
    return { base, allocationInput, allocation, previewDigest, confirmation };
  }
  // In-flight serialization is local to this service, not a cross-process job lock.
  const pending = new Map();
  async function performCreate(rawToken, policy, submitted) {
    const prepared = await prepare(rawToken, policy, submitted);
    if (submitted.previewDigest !== prepared.previewDigest || submitted.confirmation !== prepared.confirmation) {
      throw fail('hosting_site_preview_stale', 'Confirm the current site plan for this customer before creating it.');
    }
    if (prepared.base.blockers.length) throw fail('hosting_site_blocked', 'Resolve the site-create blockers before allocating capacity.');
    if (prepared.allocation.state === 'available' && await websiteRegistry.getWebsite(prepared.allocationInput.websiteId)) {
      throw fail('hosting_site_migration_required', 'An existing Website requires explicit ownership migration.');
    }
    // Rechecks live Owner, account chain and capacity atomically AFTER all reads.
    const reserved = allocations.reserve(rawToken, policy, prepared.allocationInput);
    let created = false;
    if (reserved.state !== 'attached') {
      const result = await createSite({ input: submitted.input,
        previewDigest: prepared.base.previewDigest, confirmation: prepared.base.confirmation });
      if (!result || typeof result.created !== 'boolean' || result.website?.id !== reserved.websiteId) {
        throw fail('hosting_site_result_invalid', 'Site creation did not return the allocated Website.', 503);
      }
      created = result.created;
    }
    // Never accept createSite's response object as persistence evidence.
    const website = await websiteRegistry.getWebsite(reserved.websiteId);
    if (!website) throw fail('hosting_site_persistence_unverified', 'The allocated Website could not be verified in persistent state.', 503);
    const allocation = allocations.complete(rawToken, policy, prepared.allocationInput, website);
    return Object.freeze({ website, ownership: allocation, created, accessGranted: false,
      stage: 'ownership_recorded', provisioningReady: false });
  }
  return Object.freeze({
    async preview(rawToken, policy, value) {
      const prepared = await prepare(rawToken, policy, request(value));
      return Object.freeze({ ...prepared.base, customerId: prepared.allocationInput.customerId,
        previewDigest: prepared.previewDigest, confirmation: prepared.confirmation,
        ownership: prepared.allocation, accessGranted: false });
    },
    async create(rawToken, policy, value) {
      const submitted = request(value, true);
      hostingAccounts.get(rawToken, policy, submitted.customerId);
      const key = submitted.input.operationId;
      const previous = pending.get(key) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(() => performCreate(rawToken, policy, submitted));
      pending.set(key, operation);
      try { return await operation; }
      finally { if (pending.get(key) === operation) pending.delete(key); }
    },
  });
}
