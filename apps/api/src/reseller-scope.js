import { AuthError } from './auth-error.js';

const roles = new Set(['owner', 'reseller', 'customer']);
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const record = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const denied = () => new AuthError('reseller_scope_forbidden', 'This account operation is not permitted.', 403);
const invalid = () => new AuthError('invalid_reseller_record', 'A current, explicit account relationship is required.');

/** Source policy only: callers must load these records from trusted current state.
 * Never use request-body roles/ownership or a cached session role as authority.
 * This does not enable a login role, replace tool RBAC or bypass local-host checks.
 */
export function validateHostingAccount(account, kind) {
  if (!['reseller', 'customer'].includes(kind) || !record(account)
    || !['id', 'kind', 'resellerId', 'active'].every((key) => Object.hasOwn(account, key))
    || !identifier(account.id) || account.kind !== kind || typeof account.active !== 'boolean') throw invalid();
  if (kind === 'reseller' && account.resellerId !== null) throw invalid();
  if (kind === 'customer' && account.resellerId !== null
    && (!identifier(account.resellerId) || account.resellerId === account.id)) throw invalid();
  return { id: account.id, kind, resellerId: account.resellerId, active: account.active };
}

function requireActor(actor) {
  if (!record(actor) || !['id', 'role', 'active'].every((key) => Object.hasOwn(actor, key))
    || !identifier(actor.id) || !roles.has(actor.role) || actor.active !== true) throw denied();
  return actor;
}

function customerChain(customer, reseller) {
  const current = validateHostingAccount(customer, 'customer');
  if (current.resellerId === null) {
    if (reseller !== null) throw denied();
    return { customer: current, reseller: null };
  }
  const parent = validateHostingAccount(reseller, 'reseller');
  if (parent.id !== current.resellerId) throw denied();
  return { customer: current, reseller: parent };
}

/** Only Owner may change a reseller account or its limits, including re-enabling it. */
export function assertResellerManagement({ actor, reseller } = {}) {
  requireActor(actor);
  validateHostingAccount(reseller, 'reseller');
  if (actor.role !== 'owner') throw denied();
}

/** Scope prerequisite for customer creation; capacity and insertion must be atomic. */
export function assertCustomerCreationScope({ actor, reseller = null } = {}) {
  requireActor(actor);
  if (reseller === null) {
    if (actor.role !== 'owner') throw denied();
    return;
  }
  const parent = validateHostingAccount(reseller, 'reseller');
  if (!parent.active || (actor.role !== 'owner' && !(actor.role === 'reseller' && actor.id === parent.id))) throw denied();
}

/** Customer CRUD scope, not permission to transfer ownership, change roles or quotas.
 * A reseller can manage an inactive child (e.g. re-enable it), but an inactive
 * reseller cannot act. Customers use the existing self-service profile route.
 */
export function assertCustomerManagement({ actor, customer, reseller = null } = {}) {
  requireActor(actor);
  const chain = customerChain(customer, reseller);
  if (actor.role === 'owner') return;
  if (actor.role !== 'reseller' || !chain.reseller?.active || actor.id !== chain.reseller.id) throw denied();
}

/** Website ownership scope only. Per-tool grants, Website/Domain resolution, host
 * isolation and live session checks remain mandatory at every execution/handoff.
 * Owner can repair an inactive account's site; customer/reseller access stops.
 */
export function assertCustomerWebsiteAccess({ actor, customer, reseller = null, website } = {}) {
  requireActor(actor);
  const chain = customerChain(customer, reseller);
  if (!record(website) || !['id', 'customerId'].every((key) => Object.hasOwn(website, key))
    || !identifier(website.id) || !identifier(website.customerId)) throw invalid();
  if (website.customerId !== chain.customer.id) throw denied();
  if (actor.role === 'owner') return;
  if (!chain.customer.active || (chain.reseller && !chain.reseller.active)) throw denied();
  if (actor.role === 'customer' && actor.id === chain.customer.id) return;
  if (actor.role === 'reseller' && chain.reseller && actor.id === chain.reseller.id) return;
  throw denied();
}
