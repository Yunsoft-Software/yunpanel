import { AuthError } from './auth-error.js';

const quotaFields = Object.freeze(['maxWebsites', 'maxDiskMb', 'maxTrafficMb', 'maxDatabases']);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const invalid = () => new AuthError('invalid_customer_quotas', 'Customer quotas must specify maxWebsites, maxDiskMb, maxTrafficMb, and maxDatabases as non-negative integers or null.', 400);

export function initializeCustomerQuotaSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_customer_quotas (
      customer_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_hosting_accounts(user_id) ON DELETE CASCADE,
      max_websites INTEGER CHECK(max_websites IS NULL OR (typeof(max_websites) = 'integer' AND max_websites >= 0)),
      max_disk_mb INTEGER CHECK(max_disk_mb IS NULL OR (typeof(max_disk_mb) = 'integer' AND max_disk_mb >= 0)),
      max_traffic_mb INTEGER CHECK(max_traffic_mb IS NULL OR (typeof(max_traffic_mb) = 'integer' AND max_traffic_mb >= 0)),
      max_databases INTEGER CHECK(max_databases IS NULL OR (typeof(max_databases) = 'integer' AND max_databases >= 0)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

export function validateCustomerQuotas(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  for (const key of Object.keys(input)) {
    if (!quotaFields.includes(key)) throw invalid();
  }
  for (const key of quotaFields) {
    if (!Object.hasOwn(input, key)) throw invalid();
    if (input[key] !== null && !count(input[key])) throw invalid();
  }
  return {
    maxWebsites: input.maxWebsites,
    maxDiskMb: input.maxDiskMb,
    maxTrafficMb: input.maxTrafficMb,
    maxDatabases: input.maxDatabases,
  };
}

export function assertCustomerQuotaCapacity({ quotas, usage, resource = 'websites', amount = 1 } = {}) {
  const currentQuotas = validateCustomerQuotas(quotas);
  if (!usage || typeof usage !== 'object' || !count(usage[resource])) throw invalid();
  if (!Number.isSafeInteger(amount) || amount < 1) throw invalid();
  const next = usage[resource] + amount;
  const field = resource === 'websites' ? 'maxWebsites' : resource === 'diskMb' ? 'maxDiskMb' : resource === 'trafficMb' ? 'maxTrafficMb' : 'maxDatabases';
  const limit = currentQuotas[field];
  if (limit !== null && next > limit) {
    throw new AuthError('customer_quota_exceeded', 'The customer account quota does not allow this addition.', 409);
  }
}

export function assertCustomerQuotaWithinResellerCapacity({ customerQuotas, resellerLimits } = {}) {
  if (resellerLimits?.maxWebsites !== null && customerQuotas?.maxWebsites !== null && customerQuotas.maxWebsites > resellerLimits.maxWebsites) {
    throw new AuthError('reseller_limit_reached', 'Customer website quota cannot exceed the reseller maximum websites limit.', 409);
  }
}
