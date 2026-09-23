import { AuthError } from './auth-error.js';
import { validateHostingAccount } from './reseller-scope.js';

const fields = Object.freeze({ customers: 'maxCustomers', websites: 'maxWebsites' });
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const invalid = () => new AuthError('invalid_reseller_limits', 'Provide explicit customer/site limits and complete usage counts.');
const badInventory = () => new AuthError('invalid_reseller_inventory', 'A complete, unambiguous account and Website inventory is required.');
const record = (value) => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function exactFields(input, keys) {
  if (!record(input) || Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key))) throw invalid();
}

/** Full replacement values, not a partial PATCH. Missing never means unlimited. */
export function validateResellerLimits(input) {
  exactFields(input, Object.values(fields));
  for (const key of Object.values(fields)) if (input[key] !== null && !count(input[key])) throw invalid();
  return { maxCustomers: input.maxCustomers, maxWebsites: input.maxWebsites };
}

/** Pure capacity check. Run AFTER scope authorization with server-calculated usage,
 * inside the SAME transaction/resource lock as insertion. A prior preview is not
 * a reservation; this helper alone cannot prevent concurrent over-allocation.
 */
export function assertResellerCapacity({ limits, usage, resource, amount = 1 } = {}) {
  const currentLimits = validateResellerLimits(limits);
  exactFields(usage, Object.keys(fields));
  if (!Object.values(usage).every(count) || typeof resource !== 'string' || !Object.hasOwn(fields, resource)
    || !Number.isSafeInteger(amount) || amount < 1) throw invalid();
  const next = usage[resource] + amount;
  if (!Number.isSafeInteger(next)) throw invalid();
  const limit = currentLimits[fields[resource]];
  if (limit !== null && next > limit) {
    throw new AuthError('reseller_limit_reached', 'The reseller account limit does not allow this addition.', 409);
  }
}

/** Count every existing customer/site, including inactive/suspended records.
 * Inputs must be complete trusted inventories from one consistent snapshot, not
 * a paginated UI list. Orphan and duplicate identities fail closed, never as zero.
 * This neither measures disk/traffic nor changes or deletes existing resources.
 */
export function countResellerUsage({ reseller, customers, websites } = {}) {
  const current = validateHostingAccount(reseller, 'reseller');
  if (!Array.isArray(customers) || !Array.isArray(websites)) throw badInventory();
  const accounts = new Map();
  let customerCount = 0;
  for (const entry of customers) {
    const customer = validateHostingAccount(entry, 'customer');
    if (customer.id === current.id || accounts.has(customer.id)) throw badInventory();
    accounts.set(customer.id, customer);
    if (customer.resellerId === current.id) customerCount += 1;
  }
  const seen = new Set();
  let websiteCount = 0;
  for (const website of websites) {
    if (!record(website) || !['id', 'customerId'].every((key) => Object.hasOwn(website, key))
      || !identifier(website.id) || !identifier(website.customerId) || seen.has(website.id)
      || !accounts.has(website.customerId)) throw badInventory();
    seen.add(website.id);
    if (accounts.get(website.customerId).resellerId === current.id) websiteCount += 1;
  }
  return { customers: customerCount, websites: websiteCount };
}
