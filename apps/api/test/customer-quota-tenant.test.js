import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import {
  validateCustomerQuotas,
  assertCustomerQuotaCapacity,
  assertCustomerQuotaWithinResellerCapacity,
} from '../src/customer-quotas.js';
import { handleHostingAccountAdmin } from '../src/hosting-account-http.js';

function setup(t) {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());
  f.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-1', 'reseller-2', 'customer-1a', 'customer-1b', 'customer-2a', 'direct-customer']) {
    f.addUser(id);
  }
  f.token = f.session('owner');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });
  // Register Resellers
  f.r1 = f.store.registerReseller(f.token, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 4 },
  });
  f.r2 = f.store.registerReseller(f.token, f.requireManagement, {
    userId: 'reseller-2',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 4 },
  });
  // Register Customers under Reseller 1
  f.c1a = f.store.registerCustomer(f.token, f.requireManagement, {
    userId: 'customer-1a',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  f.c1b = f.store.registerCustomer(f.token, f.requireManagement, {
    userId: 'customer-1b',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 1, maxDiskMb: 1024, maxTrafficMb: 5120, maxDatabases: 1 },
  });
  // Register Customer under Reseller 2
  f.c2a = f.store.registerCustomer(f.token, f.requireManagement, {
    userId: 'customer-2a',
    expectedUserRevision: 1,
    resellerId: 'reseller-2',
    quotas: { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 },
  });
  // Register direct customer under Owner
  f.direct = f.store.registerCustomer(f.token, f.requireManagement, {
    userId: 'direct-customer',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 5, maxDiskMb: 5120, maxTrafficMb: 20480, maxDatabases: 5 },
  });

  f.r1Token = f.session('reseller-1');
  f.r2Token = f.session('reseller-2');
  f.c1aToken = f.session('customer-1a');
  return f;
}

test('Customer Quota Helper: validateCustomerQuotas validates correct types and bounds', () => {
  const valid = validateCustomerQuotas({
    maxWebsites: 3,
    maxDiskMb: 1024,
    maxTrafficMb: 5000,
    maxDatabases: 2,
  });
  assert.deepEqual(valid, { maxWebsites: 3, maxDiskMb: 1024, maxTrafficMb: 5000, maxDatabases: 2 });

  const withNulls = validateCustomerQuotas({
    maxWebsites: null,
    maxDiskMb: null,
    maxTrafficMb: null,
    maxDatabases: null,
  });
  assert.deepEqual(withNulls, { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null });

  assert.throws(() => validateCustomerQuotas({ maxWebsites: -1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxDiskMb: 'invalid' }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas(null), (err) => err.code === 'invalid_customer_quotas');
});

test('Customer Quota Helper: assertCustomerQuotaCapacity throws customer_quota_exceeded on limit breach', () => {
  const quotas = { maxWebsites: 2, maxDiskMb: 1000, maxTrafficMb: null, maxDatabases: 1 };
  // Under limit
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 1 }, resource: 'websites', amount: 1 }));
  // Exact limit
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 0 }, resource: 'websites', amount: 2 }));
  // Exceeded
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { websites: 2 }, resource: 'websites', amount: 1 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  // Disk under limit and exceeded
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 500 }, resource: 'diskMb', amount: 500 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 900 }, resource: 'diskMb', amount: 200 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  // Databases under limit and exceeded
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { databases: 0 }, resource: 'databases', amount: 1 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { databases: 1 }, resource: 'databases', amount: 1 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  // Unlimited resource allows any amount
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { trafficMb: 99999 }, resource: 'trafficMb', amount: 5000 }));
});

test('Customer Quota Helper: assertCustomerQuotaWithinResellerCapacity checks reseller limits', () => {
  const resellerLimits = { maxCustomers: 10, maxWebsites: 4 };
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 4 },
    resellerLimits,
  }));
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: 5 },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: null },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );
});

test('Reseller creates customer with quotas and validates within tenant boundary', async (t) => {
  const f = setup(t);
  const newCustomer = await f.store.createCustomerLogin(f.r1Token, f.requireManagement, {
    username: 'cust-new',
    password: 'password123456',
    quotas: { maxWebsites: 2, maxDiskMb: 1024, maxTrafficMb: 2048, maxDatabases: 1 },
  });

  assert.equal(newCustomer.username, 'cust-new');
  assert.equal(newCustomer.kind, 'customer');
  assert.equal(newCustomer.resellerId, 'reseller-1');
  assert.deepEqual(newCustomer.quotas, { maxWebsites: 2, maxDiskMb: 1024, maxTrafficMb: 2048, maxDatabases: 1 });
  assert.equal(newCustomer.usage.websites, 0);

  // Exceeding reseller's website capacity when creating customer fails closed
  await assert.rejects(
    () => f.store.createCustomerLogin(f.r1Token, f.requireManagement, {
      username: 'cust-excessive',
      password: 'password123456',
      quotas: { maxWebsites: 10, maxDiskMb: 1024, maxTrafficMb: 2048, maxDatabases: 1 },
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );
});

test('Tenant boundary: Reseller can update child customer quotas, but cannot touch foreign or Owner customers', (t) => {
  const f = setup(t);

  // Reseller 1 updates customer-1a quotas -> SUCCESS
  const updated = f.store.updateCustomerQuotas(f.r1Token, f.requireManagement, 'customer-1a', {
    revision: f.c1a.revision,
    quotas: { maxWebsites: 3, maxDiskMb: 3000, maxTrafficMb: 15000, maxDatabases: 3 },
  });
  assert.equal(updated.id, 'customer-1a');
  assert.deepEqual(updated.quotas, { maxWebsites: 3, maxDiskMb: 3000, maxTrafficMb: 15000, maxDatabases: 3 });

  // Reseller 2 attempts to update customer-1a (foreign customer) -> 403 Forbidden
  assert.throws(
    () => f.store.updateCustomerQuotas(f.r2Token, f.requireManagement, 'customer-1a', {
      revision: updated.revision,
      quotas: { maxWebsites: 1, maxDiskMb: 1000, maxTrafficMb: 1000, maxDatabases: 1 },
    }),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller 1 attempts to update direct-customer (Owner's customer) -> 403 Forbidden
  assert.throws(
    () => f.store.updateCustomerQuotas(f.r1Token, f.requireManagement, 'direct-customer', {
      revision: f.direct.revision,
      quotas: { maxWebsites: 1, maxDiskMb: 1000, maxTrafficMb: 1000, maxDatabases: 1 },
    }),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Customer attempts to update quotas -> 403 Forbidden
  assert.throws(
    () => f.store.updateCustomerQuotas(f.c1aToken, f.requireManagement, 'customer-1a', {
      revision: updated.revision,
      quotas: { maxWebsites: 99, maxDiskMb: 99999, maxTrafficMb: 99999, maxDatabases: 99 },
    }),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Owner can update any customer's quotas -> SUCCESS
  const ownerUpdated = f.store.updateCustomerQuotas(f.token, f.requireManagement, 'customer-1a', {
    revision: updated.revision,
    quotas: { maxWebsites: 4, maxDiskMb: 4000, maxTrafficMb: 20000, maxDatabases: 4 },
  });
  assert.equal(ownerUpdated.quotas.maxWebsites, 4);
});

test('Customer role visibility: Customer can read their own account with quotas and usage, but not foreign accounts', (t) => {
  const f = setup(t);

  // Customer 1a reads self -> SUCCESS
  const self = f.store.get(f.c1aToken, f.requireManagement, 'customer-1a');
  assert.equal(self.id, 'customer-1a');
  assert.equal(self.username, 'customer-1a');
  assert.deepEqual(self.quotas, { maxWebsites: 2, maxDiskMb: 2048, maxTrafficMb: 10240, maxDatabases: 2 });
  assert.equal(self.usage.websites, 0);

  // Customer 1a tries to read customer-1b (sibling under same reseller) -> 403 Forbidden
  assert.throws(
    () => f.store.get(f.c1aToken, f.requireManagement, 'customer-1b'),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Customer 1a tries to read customer-2a (foreign reseller's customer) -> 403 Forbidden
  assert.throws(
    () => f.store.get(f.c1aToken, f.requireManagement, 'customer-2a'),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Customer 1a tries to list accounts -> 403 Forbidden
  assert.throws(
    () => f.store.list(f.c1aToken, f.requireManagement),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
});

test('Site allocation enforces customer website quota and fails with 409 customer_quota_exceeded', (t) => {
  const f = setup(t);
  const siteAllocations = f.store.siteAllocations;

  // Plan 1 for customer-1b (maxWebsites: 1)
  const plan1 = {
    operationId: '11111111-1111-4111-8111-111111111111',
    websiteId: '22222222-2222-4222-8222-222222222222',
    customerId: 'customer-1b',
    serverId: '33333333-3333-4333-8333-333333333333',
    intentDigest: 'a'.repeat(64),
    websiteDigest: 'b'.repeat(64),
  };

  // Preview plan 1 -> available
  const p1 = siteAllocations.preview(f.r1Token, f.requireManagement, plan1);
  assert.equal(p1.state, 'available');

  // Reserve plan 1 -> reserved
  const r1 = siteAllocations.reserve(f.r1Token, f.requireManagement, plan1);
  assert.equal(r1.state, 'reserved');

  // Plan 2 for customer-1b (exceeding customer-1b's quota of 1)
  const plan2 = {
    operationId: '44444444-4444-4444-8444-444444444444',
    websiteId: '55555555-5555-4555-8555-555555555555',
    customerId: 'customer-1b',
    serverId: '33333333-3333-4333-8333-333333333333',
    intentDigest: 'c'.repeat(64),
    websiteDigest: 'd'.repeat(64),
  };

  // Preview or Reserve plan 2 throws customer_quota_exceeded (409)
  assert.throws(
    () => siteAllocations.preview(f.r1Token, f.requireManagement, plan2),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  assert.throws(
    () => siteAllocations.reserve(f.r1Token, f.requireManagement, plan2),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
});

test('Resource locking: Suspended customer is locked and rejects allocation with 403 hosting_account_inactive', (t) => {
  const f = setup(t);
  const siteAllocations = f.store.siteAllocations;

  // Suspend customer-1a
  f.store.setActive(f.r1Token, f.requireManagement, 'customer-1a', {
    revision: f.c1a.revision,
    active: false,
  });

  const plan = {
    operationId: '66666666-6666-4666-8666-666666666666',
    websiteId: '77777777-7777-4777-8777-777777777777',
    customerId: 'customer-1a',
    serverId: '33333333-3333-4333-8333-333333333333',
    intentDigest: 'e'.repeat(64),
    websiteDigest: 'f'.repeat(64),
  };

  // Allocation fails with hosting_account_inactive (403)
  assert.throws(
    () => siteAllocations.preview(f.r1Token, f.requireManagement, plan),
    (err) => err.code === 'hosting_account_inactive' && err.status === 403,
  );
  assert.throws(
    () => siteAllocations.reserve(f.r1Token, f.requireManagement, plan),
    (err) => err.code === 'hosting_account_inactive' && err.status === 403,
  );
});

test('HTTP endpoint PATCH /api/users/hosting/accounts/:id/quotas enforces permissions', async (t) => {
  const f = setup(t);

  const fakeResponse = () => ({
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    payload: null,
  });
  const json = (res, status, body) => {
    res.statusCode = status;
    res.payload = body;
    return res;
  };

  // Reseller 1 updates customer-1a quotas via HTTP
  const res1 = fakeResponse();
  await handleHostingAccountAdmin({
    request: { method: 'PATCH' },
    response: res1,
    pathname: '/api/users/hosting/accounts/customer-1a/quotas',
    query: new URLSearchParams(),
    store: { users: { hostingAccounts: f.store } },
    rawToken: f.r1Token,
    requireManagement: f.requireManagement,
    readJson: async () => ({
      revision: f.c1a.revision,
      quotas: { maxWebsites: 3, maxDiskMb: 3000, maxTrafficMb: 15000, maxDatabases: 3 },
    }),
    json,
  });
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.payload.data.account.quotas.maxWebsites, 3);

  // Reseller 2 tries to update customer-1a quotas via HTTP -> 403
  const res2 = fakeResponse();
  await assert.rejects(
    () => handleHostingAccountAdmin({
      request: { method: 'PATCH' },
      response: res2,
      pathname: '/api/users/hosting/accounts/customer-1a/quotas',
      query: new URLSearchParams(),
      store: { users: { hostingAccounts: f.store } },
      rawToken: f.r2Token,
      requireManagement: f.requireManagement,
      readJson: async () => ({
        revision: res1.payload.data.account.revision,
        quotas: { maxWebsites: 1, maxDiskMb: 1000, maxTrafficMb: 1000, maxDatabases: 1 },
      }),
      json,
    }),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Customer 1a tries to update quotas via HTTP -> 403
  const res3 = fakeResponse();
  await assert.rejects(
    () => handleHostingAccountAdmin({
      request: { method: 'PATCH' },
      response: res3,
      pathname: '/api/users/hosting/accounts/customer-1a/quotas',
      query: new URLSearchParams(),
      store: { users: { hostingAccounts: f.store } },
      rawToken: f.c1aToken,
      requireManagement: f.requireManagement,
      readJson: async () => ({
        revision: res1.payload.data.account.revision,
        quotas: { maxWebsites: 10, maxDiskMb: 1000, maxTrafficMb: 1000, maxDatabases: 1 },
      }),
      json,
    }),
    (err) => err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
});
