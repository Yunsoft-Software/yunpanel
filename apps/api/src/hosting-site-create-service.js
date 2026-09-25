import { AuthError } from './auth-error.js';
import { hostingPlanDigest, hostingWebsiteDigest } from './hosting-site-allocation-store.js';

const plain = (value) => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const NEW_APPLICATION_SOURCES = new Set(['new_static', 'new_node', 'new_php', 'new_python']);
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
export function createHostingSiteCreateService({
  hostingAccounts,
  websiteRegistry,
  applicationRegistry = null,
  domainRegistry = null,
  mailDomainRegistry = null,
  siteMutationLock = null,
  localServerId,
  previewSiteCreate,
  createSite,
}) {
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
  // Local promise serialization remains useful for duplicate calls, while the
  // shared site lock closes the cross-process reserve/create/attach race.
  const pending = new Map();

  function lockIdentity(prepared) {
    return Object.freeze({
      applicationId: prepared.base?.plan?.website?.applicationId ?? null,
      websiteId: prepared.allocationInput.websiteId,
    });
  }

  function validateSubmission(submitted, prepared) {
    if (submitted.previewDigest !== prepared.previewDigest || submitted.confirmation !== prepared.confirmation) {
      throw fail('hosting_site_preview_stale', 'Confirm the current site plan for this customer before creating it.');
    }
    if (prepared.base.blockers.length) {
      throw fail('hosting_site_blocked', 'Resolve the site-create blockers before allocating capacity.');
    }
  }

  async function performPreparedCreate(rawToken, policy, submitted, prepared, { outerLock = false } = {}) {
    validateSubmission(submitted, prepared);
    if (prepared.allocation.state === 'available' && await websiteRegistry.getWebsite(prepared.allocationInput.websiteId)) {
      throw fail('hosting_site_migration_required', 'An existing Website requires explicit ownership migration.');
    }
    // Rechecks live Owner, account chain and capacity atomically AFTER all reads.
    const reserved = allocations.reserve(rawToken, policy, prepared.allocationInput);
    let created = false;
    if (reserved.state !== 'attached') {
      const result = await createSite({
        input: submitted.input,
        previewDigest: prepared.base.previewDigest,
        confirmation: prepared.base.confirmation,
        ...(outerLock ? { siteMutationLock: null } : {}),
      });
      if (!result || typeof result.created !== 'boolean' || result.website?.id !== reserved.websiteId) {
        throw fail('hosting_site_result_invalid', 'Site creation did not return the allocated Website.', 503);
      }
      created = result.created;
    }
    // Never accept createSite's response object as persistence evidence.
    const website = await websiteRegistry.getWebsite(reserved.websiteId);
    if (!website) {
      throw fail('hosting_site_persistence_unverified', 'The allocated Website could not be verified in persistent state.', 503);
    }
    const allocation = allocations.complete(rawToken, policy, prepared.allocationInput, website);
    return Object.freeze({
      website,
      ownership: allocation,
      created,
      accessGranted: false,
      stage: 'ownership_recorded',
      provisioningReady: false,
    });
  }

  async function performCreate(rawToken, policy, submitted) {
    const initial = await prepare(rawToken, policy, submitted);
    validateSubmission(submitted, initial);
    if (siteMutationLock === null) {
      return performPreparedCreate(rawToken, policy, submitted, initial);
    }
    if (typeof siteMutationLock.withSiteLock !== 'function') {
      throw fail('hosting_site_lock_unavailable', 'Hosted site mutation lock is unavailable.', 503);
    }
    return siteMutationLock.withSiteLock(lockIdentity(initial), async () => {
      // All preview/allocation reads are repeated under the same lock that owns
      // reserve -> metadata create -> persistent verification -> ownership attach.
      const locked = await prepare(rawToken, policy, submitted);
      return performPreparedCreate(rawToken, policy, submitted, locked, { outerLock: true });
    });
  }
  function operationOwnedApplicationId(prepared) {
    const sourceKind = prepared.base?.source?.kind;
    if (!NEW_APPLICATION_SOURCES.has(sourceKind)) return null;
    const applicationId = prepared.base?.plan?.application?.id;
    if (!uuid(applicationId)
      || prepared.base?.plan?.website?.applicationId !== applicationId
      || prepared.base?.ids?.applicationId !== applicationId) {
      throw fail(
        'hosting_site_recovery_plan_invalid',
        'The site-create plan does not contain a canonical operation-owned Application.',
        503,
      );
    }
    return applicationId;
  }

  function requireRecoveryDependencies(prepared) {
    if (typeof allocations?.releaseUncreated !== 'function'
      || typeof websiteRegistry?.getWebsite !== 'function'
      || typeof domainRegistry?.getDomain !== 'function'
      || typeof siteMutationLock?.withSiteLock !== 'function') {
      throw fail('hosting_site_recovery_unavailable', 'Hosted site reservation recovery is unavailable.', 503);
    }
    if (operationOwnedApplicationId(prepared) !== null
      && typeof applicationRegistry?.getApplication !== 'function') {
      throw fail('hosting_site_recovery_unavailable', 'Application recovery inspection is unavailable.', 503);
    }
    if (prepared.base?.ids?.mailDomainId !== null
      && prepared.base?.ids?.mailDomainId !== undefined
      && typeof mailDomainRegistry?.getMailDomain !== 'function') {
      throw fail('hosting_site_recovery_unavailable', 'Mail Domain recovery inspection is unavailable.', 503);
    }
  }

  async function inspectRecoveryResiduals(prepared) {
    requireRecoveryDependencies(prepared);
    const applicationId = operationOwnedApplicationId(prepared);
    const websiteId = prepared.allocationInput.websiteId;
    const primaryDomainId = prepared.base?.ids?.primaryDomainId ?? null;
    const wwwDomainId = prepared.base?.ids?.wwwDomainId ?? null;
    const mailDomainId = prepared.base?.ids?.mailDomainId ?? null;
    if (!uuid(websiteId) || !uuid(primaryDomainId)
      || (wwwDomainId !== null && !uuid(wwwDomainId))
      || (mailDomainId !== null && !uuid(mailDomainId))) {
      throw fail('hosting_site_recovery_plan_invalid', 'The site-create recovery identities are invalid.', 503);
    }

    const [website, application, primaryDomain, wwwDomain, mailDomain] = await Promise.all([
      websiteRegistry.getWebsite(websiteId),
      applicationId === null ? Promise.resolve(null) : applicationRegistry.getApplication(applicationId),
      domainRegistry.getDomain(primaryDomainId),
      wwwDomainId === null ? Promise.resolve(null) : domainRegistry.getDomain(wwwDomainId),
      mailDomainId === null ? Promise.resolve(null) : mailDomainRegistry.getMailDomain(mailDomainId),
    ]);
    return Object.freeze({
      applicationId,
      websitePresent: website !== null,
      applicationPresent: application !== null,
      primaryDomainPresent: primaryDomain !== null,
      wwwDomainPresent: wwwDomain !== null,
      mailDomainPresent: mailDomain !== null,
    });
  }

  async function recoverReservation(rawToken, policy, submitted) {
    const initial = await prepare(rawToken, policy, submitted);
    validateSubmission(submitted, initial);
    requireRecoveryDependencies(initial);
    if (initial.allocation.state === 'available') {
      throw fail('hosting_site_recovery_not_found', 'There is no reserved site capacity to recover.', 404);
    }
    if (initial.allocation.state !== 'reserved') {
      throw fail(
        'hosting_site_recovery_requires_removal',
        'Persisted Website ownership must use the Website removal lifecycle.',
        409,
      );
    }

    return siteMutationLock.withSiteLock(lockIdentity(initial), async () => {
      const prepared = await prepare(rawToken, policy, submitted);
      validateSubmission(submitted, prepared);
      if (prepared.allocation.state !== 'reserved') {
        throw fail(
          'hosting_site_recovery_requires_removal',
          'The site allocation changed and can no longer use reservation recovery.',
          409,
        );
      }
      const residuals = await inspectRecoveryResiduals(prepared);
      if (residuals.websitePresent || residuals.applicationPresent
        || residuals.primaryDomainPresent || residuals.wwwDomainPresent || residuals.mailDomainPresent) {
        throw fail(
          'hosting_site_recovery_partial_resources_present',
          'Site resources exist for this reservation; compensate or remove them before releasing capacity.',
          409,
        );
      }

      const receipt = allocations.releaseUncreated({
        operationId: prepared.allocationInput.operationId,
        websiteId: prepared.allocationInput.websiteId,
        serverId: prepared.allocationInput.serverId,
        applicationId: residuals.applicationId,
        websiteAbsent: true,
        applicationAbsent: residuals.applicationId !== null,
      });
      if (!receipt || receipt.websiteId !== prepared.allocationInput.websiteId
        || receipt.allocationOperationId !== prepared.allocationInput.operationId
        || receipt.released !== true || receipt.quotaReleased !== true) {
        throw fail('hosting_site_recovery_unverified', 'Site reservation recovery could not be verified.', 503);
      }
      return Object.freeze({
        websiteId: receipt.websiteId,
        ownership: receipt,
        recovered: true,
        stage: 'reservation_released',
        accessGranted: false,
      });
    });
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
    async recoverReservation(rawToken, policy, value) {
      const submitted = request(value, true);
      hostingAccounts.get(rawToken, policy, submitted.customerId);
      return recoverReservation(rawToken, policy, submitted);
    },
  });
}
