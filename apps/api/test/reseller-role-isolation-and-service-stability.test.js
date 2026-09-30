import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import {
  TenantBoundaryError,
  assertCustomerBelongsToReseller,
  assertEntityTenantBoundary,
  assertWebsiteBelongsToTenant,
  createTenantBoundaryMiddleware,
  extractActorTenant,
  sanitizeTenantCollection,
} from '../src/tenant-boundary.js';
import {
  validateCustomerQuotas,
  assertCustomerQuotaCapacity,
  assertCustomerQuotaWithinResellerCapacity,
} from '../src/customer-quotas.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingWebsiteDigest } from '../src/hosting-site-allocation-store.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { handleHostingAccountAdmin } from '../src/hosting-account-http.js';
import {
  createSystemWatchdogService,
  SystemWatchdogError,
  mountSystemWatchdogRoutes,
} from '../src/local-api-health.js';

// ============================================================================
// PART 1: Role and Tenant Isolation Violation Scenarios
// ============================================================================

const owner = Object.freeze({ id: 'owner-user', role: 'owner', active: true });
const readOnly = Object.freeze({ id: 'readonly-user', role: 'read_only', active: true });

const resellerA = Object.freeze({
  id: 'reseller-a',
  role: 'reseller',
  hosting: { kind: 'reseller', resellerId: null },
  active: true,
  websiteIds: ['site-a1', 'site-a2'],
});

const resellerB = Object.freeze({
  id: 'reseller-b',
  role: 'reseller',
  hosting: { kind: 'reseller', resellerId: null },
  active: true,
  websiteIds: ['site-b1'],
});

const customerA1 = Object.freeze({
  id: 'customer-a1',
  kind: 'customer',
  resellerId: 'reseller-a',
  active: true,
});

const customerA2 = Object.freeze({
  id: 'customer-a2',
  kind: 'customer',
  resellerId: 'reseller-a',
  active: true,
});

const customerB1 = Object.freeze({
  id: 'customer-b1',
  kind: 'customer',
  resellerId: 'reseller-b',
  active: true,
});

const customerDirect = Object.freeze({
  id: 'customer-direct',
  kind: 'customer',
  resellerId: null,
  active: true,
});

const customerA1Actor = Object.freeze({
  id: customerA1.id,
  role: 'customer',
  hosting: { kind: 'customer', resellerId: 'reseller-a' },
  active: true,
  websiteIds: ['site-a1'],
});

const customerB1Actor = Object.freeze({
  id: customerB1.id,
  role: 'customer',
  hosting: { kind: 'customer', resellerId: 'reseller-b' },
  active: true,
  websiteIds: ['site-b1'],
});

const customerDirectActor = Object.freeze({
  id: customerDirect.id,
  role: 'customer',
  hosting: { kind: 'customer', resellerId: null },
  active: true,
  websiteIds: ['site-direct'],
});

const websiteA1 = Object.freeze({ id: 'site-a1', customerId: customerA1.id, resellerId: 'reseller-a' });
const websiteB1 = Object.freeze({ id: 'site-b1', customerId: customerB1.id, resellerId: 'reseller-b' });
const websiteDirect = Object.freeze({ id: 'site-direct', customerId: customerDirect.id, resellerId: null });

test('Tenant Isolation: Reseller cannot access server management, watchdog, package, settings or global backup routes', async () => {
  const middleware = createTenantBoundaryMiddleware({});

  const checkPath = async (actor, url, method = 'GET') => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const forbiddenPaths = [
    '/api/system/watchdog/status',
    '/api/system/watchdog/check',
    '/api/system/watchdog/recover',
    '/api/servers/srv-1/watchdog/status',
    '/api/servers/srv-1/watchdog/check',
    '/api/servers/srv-1/watchdog/recover',
    '/api/panel/settings',
    '/api/settings',
    '/api/system/packages',
    '/api/system/upgrade',
    '/api/servers/srv-1/system/packages',
    '/api/servers/srv-1/services',
    '/api/backups',
    '/api/backups/repositories',
    '/api/backups/remotes',
    '/api/servers/srv-1/databases',
  ];

  for (const path of forbiddenPaths) {
    // Reseller is denied
    const rRes = await checkPath(resellerA, path);
    assert.equal(rRes.called, false, `Expected ${path} to be blocked for reseller`);
    assert.equal(rRes.statusCode, 403);
    assert.equal(rRes.responseBody.error.code, 'tenant_boundary_forbidden');

    // Customer is also denied
    const cRes = await checkPath(customerA1Actor, path);
    assert.equal(cRes.called, false, `Expected ${path} to be blocked for customer`);
    assert.equal(cRes.statusCode, 403);
    assert.equal(cRes.responseBody.error.code, 'tenant_boundary_forbidden');
  }
});

test('Tenant Isolation: Reseller cross-tenant violations on customers, websites, and allocation are blocked', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const customerLookup = async (id) => customers[id] ?? null;
  const middleware = createTenantBoundaryMiddleware({ customerLookup });

  const runRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  // 1. Reseller A accessing Reseller B customer -> 403
  const foreignCust = await runRequest(resellerA, '/api/customers/customer-b1');
  assert.equal(foreignCust.called, false);
  assert.equal(foreignCust.statusCode, 403);
  assert.equal(foreignCust.responseBody.error.code, 'tenant_boundary_forbidden');

  // 2. Reseller A accessing direct Owner customer -> 403
  const directCust = await runRequest(resellerA, '/api/customers/customer-direct');
  assert.equal(directCust.called, false);
  assert.equal(directCust.statusCode, 403);
  assert.equal(directCust.responseBody.error.code, 'tenant_boundary_forbidden');

  // 3. Reseller A accessing child customer A1 -> Allowed
  const childCust = await runRequest(resellerA, '/api/customers/customer-a1');
  assert.equal(childCust.called, true);

  // 4. Reseller A allocating website to foreign customer -> 403
  const foreignAlloc = await runRequest(resellerA, '/api/sites/hosted', 'POST', { customerId: 'customer-b1' });
  assert.equal(foreignAlloc.called, false);
  assert.equal(foreignAlloc.statusCode, 403);

  // 5. Reseller A allocating website to child customer -> Allowed to proceed to inner handler
  const childAlloc = await runRequest(resellerA, '/api/sites/hosted', 'POST', { customerId: 'customer-a1' });
  assert.equal(childAlloc.called, true);

  // 6. Direct top-level website creation without hosted customer -> 403
  const directSite = await runRequest(resellerA, '/api/websites', 'POST', {});
  assert.equal(directSite.called, false);
  assert.equal(directSite.statusCode, 403);

  // 7. Reseller A accessing foreign website -> 403
  const foreignSite = await runRequest(resellerA, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);

  // 8. Reseller A accessing foreign website through nested server route -> 403
  const foreignServerSite = await runRequest(resellerA, '/api/servers/srv-1/websites/site-b1/files');
  assert.equal(foreignServerSite.called, false);
  assert.equal(foreignServerSite.statusCode, 403);

  // 9. Root terminal requested by reseller -> 403 terminal_server_forbidden
  const rootTerminal = await runRequest(resellerA, '/api/terminal/capabilities', 'POST', { scope: 'server' });
  assert.equal(rootTerminal.called, false);
  assert.equal(rootTerminal.statusCode, 403);
  assert.equal(rootTerminal.responseBody.error.code, 'terminal_server_forbidden');
});

test('Tenant Isolation: Customer role violations and cross-customer boundary violations are blocked', async () => {
  const middleware = createTenantBoundaryMiddleware({});

  const runRequest = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  // 1. Customer listing customers collection -> 403
  const custColl = await runRequest(customerA1Actor, '/api/customers');
  assert.equal(custColl.called, false);
  assert.equal(custColl.statusCode, 403);

  // 2. Customer accessing sibling customer profile -> 403
  const siblingCust = await runRequest(customerA1Actor, '/api/customers/customer-a2');
  assert.equal(siblingCust.called, false);
  assert.equal(siblingCust.statusCode, 403);

  // 3. Customer accessing foreign customer profile -> 403
  const foreignCust = await runRequest(customerA1Actor, '/api/customers/customer-b1');
  assert.equal(foreignCust.called, false);
  assert.equal(foreignCust.statusCode, 403);

  // 4. Customer attempting to allocate site -> 403
  const custAlloc = await runRequest(customerA1Actor, '/api/sites/hosted', 'POST', { customerId: 'customer-a1' });
  assert.equal(custAlloc.called, false);
  assert.equal(custAlloc.statusCode, 403);

  // 5. Customer accessing foreign website -> 403
  const foreignSite = await runRequest(customerA1Actor, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);

  // 6. Customer accessing direct Owner website -> 403
  const directSite = await runRequest(customerA1Actor, '/api/websites/site-direct');
  assert.equal(directSite.called, false);
  assert.equal(directSite.statusCode, 403);

  // 7. Customer accessing own assigned website -> Allowed
  const ownSite = await runRequest(customerA1Actor, '/api/websites/site-a1');
  assert.equal(ownSite.called, true);
});

test('Tenant Isolation: Inactive / Suspended account rejection fails closed', async () => {
  const middleware = createTenantBoundaryMiddleware({});

  const inactiveReseller = { ...resellerA, active: false };
  const inactiveCustomer = { ...customerA1Actor, active: false };

  const runRequest = async (actor, url) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method: 'GET', auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  const rRes = await runRequest(inactiveReseller, '/api/websites/site-a1');
  assert.equal(rRes.called, false);
  assert.equal(rRes.statusCode, 403);
  assert.equal(rRes.responseBody.error.code, 'tenant_actor_inactive');

  const cRes = await runRequest(inactiveCustomer, '/api/websites/site-a1');
  assert.equal(cRes.called, false);
  assert.equal(cRes.statusCode, 403);
  assert.equal(cRes.responseBody.error.code, 'tenant_actor_inactive');
});

test('Tenant Isolation: sanitizeTenantCollection strips out foreign entities without disclosing metadata', () => {
  const items = [
    { id: 'site-a1', websiteId: 'site-a1', customerId: 'customer-a1', resellerId: 'reseller-a' },
    { id: 'site-a2', websiteId: 'site-a2', customerId: 'customer-a2', resellerId: 'reseller-a' },
    { id: 'site-b1', websiteId: 'site-b1', customerId: 'customer-b1', resellerId: 'reseller-b' },
    { id: 'site-direct', websiteId: 'site-direct', customerId: 'customer-direct', resellerId: null },
  ];

  // Owner sees everything
  assert.equal(sanitizeTenantCollection(items, owner).length, 4);

  // Reseller A sees only child customer sites
  const rA = sanitizeTenantCollection(items, resellerA);
  assert.deepEqual(rA.map((i) => i.id), ['site-a1', 'site-a2']);

  // Reseller B sees only site-b1
  const rB = sanitizeTenantCollection(items, resellerB);
  assert.deepEqual(rB.map((i) => i.id), ['site-b1']);

  // Customer A1 sees only site-a1
  const cA1 = sanitizeTenantCollection(items, customerA1Actor);
  assert.deepEqual(cA1.map((i) => i.id), ['site-a1']);
});

// ============================================================================
// PART 2: Quota Overflow and Resource Restriction Unit Tests
// ============================================================================

test('Customer Quotas Unit: validateCustomerQuotas strictly verifies all fields, types, and bounds', () => {
  // Valid object with integers
  const valid = validateCustomerQuotas({
    maxWebsites: 5,
    maxDiskMb: 4096,
    maxTrafficMb: 20480,
    maxDatabases: 3,
  });
  assert.deepEqual(valid, { maxWebsites: 5, maxDiskMb: 4096, maxTrafficMb: 20480, maxDatabases: 3 });

  // Valid object with nulls (unlimited)
  const unlimited = validateCustomerQuotas({
    maxWebsites: null,
    maxDiskMb: null,
    maxTrafficMb: null,
    maxDatabases: null,
  });
  assert.deepEqual(unlimited, { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null });

  // Rejection: Negative numbers for each individual field
  assert.throws(() => validateCustomerQuotas({ maxWebsites: -1, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1, maxDiskMb: -1, maxTrafficMb: 100, maxDatabases: 1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1, maxDiskMb: 100, maxTrafficMb: -1, maxDatabases: 1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: -1 }), (err) => err.code === 'invalid_customer_quotas');

  // Rejection: Non-integers (strings, floats, booleans)
  assert.throws(() => validateCustomerQuotas({ maxWebsites: '3', maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1.5, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1 }), (err) => err.code === 'invalid_customer_quotas');

  // Rejection: Missing required quota fields
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1, maxDiskMb: 100 }), (err) => err.code === 'invalid_customer_quotas');

  // Rejection: Extra unauthorized fields
  assert.throws(() => validateCustomerQuotas({ maxWebsites: 1, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1, extraField: 99 }), (err) => err.code === 'invalid_customer_quotas');

  // Rejection: Non-objects, null, arrays
  assert.throws(() => validateCustomerQuotas(null), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas('invalid'), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => validateCustomerQuotas([]), (err) => err.code === 'invalid_customer_quotas');
});

test('Customer Quotas Unit: assertCustomerQuotaCapacity verifies capacity and enforces limits for all resources', () => {
  const quotas = {
    maxWebsites: 2,
    maxDiskMb: 2048,
    maxTrafficMb: 10240,
    maxDatabases: 2,
  };

  // 1. Websites resource: Under limit -> passes; At limit -> fails 409
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 1 }, resource: 'websites', amount: 1 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { websites: 2 }, resource: 'websites', amount: 1 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 2. Disk resource: Under limit -> passes; Exceeded -> fails 409
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 1024 }, resource: 'diskMb', amount: 512 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { diskMb: 1800 }, resource: 'diskMb', amount: 300 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 3. Traffic resource: Under limit -> passes; Exceeded -> fails 409
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { trafficMb: 5000 }, resource: 'trafficMb', amount: 2000 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { trafficMb: 10000 }, resource: 'trafficMb', amount: 500 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 4. Databases resource: Under limit -> passes; Exceeded -> fails 409
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas, usage: { databases: 1 }, resource: 'databases', amount: 1 }));
  assert.throws(
    () => assertCustomerQuotaCapacity({ quotas, usage: { databases: 2 }, resource: 'databases', amount: 1 }),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 5. Unlimited resources (null) allow any allocation amount
  const unlimitedQuotas = { maxWebsites: null, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null };
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas: unlimitedQuotas, usage: { websites: 9999 }, resource: 'websites', amount: 50 }));
  assert.doesNotThrow(() => assertCustomerQuotaCapacity({ quotas: unlimitedQuotas, usage: { diskMb: 500000 }, resource: 'diskMb', amount: 100000 }));

  // 6. Invalid amount or usage parameters throw invalid_customer_quotas
  assert.throws(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 0 }, resource: 'websites', amount: 0 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 0 }, resource: 'websites', amount: -1 }), (err) => err.code === 'invalid_customer_quotas');
  assert.throws(() => assertCustomerQuotaCapacity({ quotas, usage: null, resource: 'websites', amount: 1 }), (err) => err.code === 'invalid_customer_quotas');
});

test('Customer Quotas Unit: assertCustomerQuotaWithinResellerCapacity blocks unlimited quota or exceeding reseller limit', () => {
  const resellerLimits = { maxCustomers: 10, maxWebsites: 4 };

  // Allowed: within limits
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 4 },
    resellerLimits,
  }));

  // Blocked: exceeds reseller limit
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: 5 },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // Blocked: customer cannot have unlimited websites (null) when reseller has a finite limit
  assert.throws(
    () => assertCustomerQuotaWithinResellerCapacity({
      customerQuotas: { maxWebsites: null },
      resellerLimits,
    }),
    (err) => err.code === 'reseller_limit_reached' && err.status === 409,
  );

  // Allowed: reseller itself has unlimited websites (null)
  assert.doesNotThrow(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 100 },
    resellerLimits: { maxCustomers: 10, maxWebsites: null },
  }));
});

test('Customer Quota & Resource Restriction: Site allocation, suspension locking, and quota release lifecycle', (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  f.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-1', 'customer-1']) f.addUser(id);

  f.token = f.session('owner');
  f.store = createHostingAccountStore({
    ...f,
    hashPassword: async (pwd) => `hashed-${pwd}`,
    normalizeUsername: (u) => u.trim().toLowerCase(),
  });

  // Reseller with limit of 3 websites
  f.store.registerReseller(f.token, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 5, maxWebsites: 3 },
  });

  // Customer with quota of 1 website
  const c1 = f.store.registerCustomer(f.token, f.requireManagement, {
    userId: 'customer-1',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 1, maxDiskMb: 1024, maxTrafficMb: 2048, maxDatabases: 1 },
  });

  let r1Token = f.session('reseller-1');
  const siteAllocations = f.store.siteAllocations;

  const plan1 = {
    operationId: '11111111-1111-4111-8111-111111111111',
    websiteId: '22222222-2222-4222-8222-222222222222',
    customerId: 'customer-1',
    serverId: '33333333-3333-4333-8333-333333333333',
    intentDigest: 'a'.repeat(64),
    websiteDigest: 'b'.repeat(64),
  };

  // 1. First allocation: Reserve succeeds
  const r1 = siteAllocations.reserve(r1Token, f.requireManagement, plan1);
  assert.equal(r1.state, 'reserved');

  // 2. Second allocation for customer-1 (exceeding customer maxWebsites quota of 1) -> 409 customer_quota_exceeded
  const site2 = {
    id: '55555555-5555-4555-8555-555555555555',
    serverId: '33333333-3333-4333-8333-333333333333',
    name: 'Customer Site 2',
    applicationId: null,
    dockerWorkloadId: null,
    managedComposeBinding: null,
    runtimeType: 'proxy',
    documentRoot: null,
    unixUser: null,
    proxyTarget: { host: '127.0.0.1', port: 8080, websocket: true },
    revision: 1,
  };

  const plan2 = {
    operationId: '44444444-4444-4444-8444-444444444444',
    websiteId: site2.id,
    customerId: 'customer-1',
    serverId: site2.serverId,
    intentDigest: 'c'.repeat(64),
    websiteDigest: hostingWebsiteDigest(site2),
  };

  assert.throws(
    () => siteAllocations.preview(r1Token, f.requireManagement, plan2),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );
  assert.throws(
    () => siteAllocations.reserve(r1Token, f.requireManagement, plan2),
    (err) => err.code === 'customer_quota_exceeded' && err.status === 409,
  );

  // 3. Quota release lifecycle (uncreated reservation release):
  // When plan1 reservation is cancelled/released, customer quota capacity is freed!
  const released = siteAllocations.releaseUncreated({
    operationId: plan1.operationId,
    websiteId: plan1.websiteId,
    serverId: plan1.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(released.released, true);
  assert.equal(released.quotaReleased, true);

  // Session invalidation security lifecycle: releaseUncreated revokes live sessions for customer and reseller.
  // Re-authenticate reseller before subsequent operations.
  r1Token = f.session('reseller-1');

  // Now plan2 can be reserved because quota was restored!
  const r2 = siteAllocations.reserve(r1Token, f.requireManagement, plan2);
  assert.equal(r2.state, 'reserved');

  // Complete plan2 allocation to attach ownership to customer
  const attached = siteAllocations.complete(r1Token, f.requireManagement, plan2, site2);
  assert.equal(attached.state, 'attached');

  // 4. Resource restriction: Suspend customer-1 -> locked, rejects allocation
  // complete() also revokes live sessions upon attachment; refresh session for reseller.
  r1Token = f.session('reseller-1');
  const account = f.store.get(f.token, f.requireManagement, 'customer-1');
  f.store.setActive(r1Token, f.requireManagement, 'customer-1', {
    revision: account.revision,
    active: false,
  });

  const plan3 = {
    operationId: '77777777-7777-4777-8777-777777777777',
    websiteId: '88888888-8888-4888-8888-888888888888',
    customerId: 'customer-1',
    serverId: '33333333-3333-4333-8333-333333333333',
    intentDigest: 'e'.repeat(64),
    websiteDigest: 'f'.repeat(64),
  };

  assert.throws(
    () => siteAllocations.preview(r1Token, f.requireManagement, plan3),
    (err) => err.code === 'hosting_account_inactive' && err.status === 403,
  );
  assert.throws(
    () => siteAllocations.reserve(r1Token, f.requireManagement, plan3),
    (err) => err.code === 'hosting_account_inactive' && err.status === 403,
  );

  // 5. Quota release lifecycle (website removal release):
  // When attached website is removed, capacity is cleanly released
  const removedResult = siteAllocations.releaseRemoved({
    operationId: 'removal-op-plan2-1',
    websiteId: plan2.websiteId,
    serverId: plan2.serverId,
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
  });
  assert.equal(removedResult.released, true);
  assert.equal(removedResult.quotaReleased, true);

  // Capacity release verification: both customer and reseller usage are restored to 0
  const c1AfterRemoval = f.store.get(f.token, f.requireManagement, 'customer-1');
  assert.equal(c1AfterRemoval.usage.websites, 0);
  const r1AfterRemoval = f.store.get(f.token, f.requireManagement, 'reseller-1');
  assert.equal(r1AfterRemoval.usage.websites, 0);
});

// ============================================================================
// PART 3: Service Monitoring & Auto-Recovery Integration Tests
// ============================================================================

const TEST_SERVER = 'srv-test-stability-99';

function createMockServices() {
  let services = [
    {
      id: 'nginx',
      label: 'Nginx',
      category: 'web',
      installed: true,
      active: true,
      units: [{ unit: 'nginx.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'mariadb',
      label: 'MariaDB',
      category: 'database',
      installed: true,
      active: true,
      units: [{ unit: 'mariadb.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
  ];

  const controlCalls = [];

  return {
    getServices: () => services,
    setServices: (s) => { services = s; },
    inspectServices: async () => services.map((s) => ({ ...s, units: s.units.map((u) => ({ ...u })) })),
    serviceControl: async (serviceId, action) => {
      controlCalls.push({ serviceId, action });
      const target = services.find((s) => s.id === serviceId);
      if (target) {
        if (action === 'restart' || action === 'start') {
          target.active = true;
          target.units.forEach((u) => { u.activeState = 'active'; u.subState = 'running'; });
          target.health = { status: 'ready' };
        } else if (action === 'stop') {
          target.active = false;
          target.units.forEach((u) => { u.activeState = 'inactive'; u.subState = 'dead'; });
          target.health = { status: 'inactive' };
        }
      }
      return { id: serviceId, action, active: target?.active ?? true };
    },
    getControlCalls: () => [...controlCalls],
  };
}

function createMockJobs(initialJobs = []) {
  let jobs = [...initialJobs];
  const completions = [];

  return {
    listJobs: async (filter = {}) => {
      return jobs.filter((j) => {
        if (filter.serverId && j.serverId !== filter.serverId) return false;
        if (filter.status && j.status !== filter.status) return false;
        return true;
      });
    },
    complete: async ({ serverId, jobId, status, error, result }) => {
      completions.push({ serverId, jobId, status, error, result });
      const target = jobs.find((j) => j.id === jobId);
      if (!target) throw new Error('job_not_found');
      target.status = status;
      target.error = error;
      target.result = result;
      return { ...target };
    },
    getCompletions: () => [...completions],
  };
}

test('Service Monitoring Integration: Multi-subsystem health telemetry aggregates failures into comprehensive status', async () => {
  const serviceMock = createMockServices();
  // Service failure: MariaDB dead
  serviceMock.setServices([
    {
      id: 'nginx',
      label: 'Nginx',
      category: 'web',
      installed: true,
      active: true,
      units: [{ unit: 'nginx.service', activeState: 'active', subState: 'running' }],
      health: { status: 'ready' },
    },
    {
      id: 'mariadb',
      label: 'MariaDB',
      category: 'database',
      installed: true,
      active: false,
      units: [{ unit: 'mariadb.service', activeState: 'inactive', subState: 'failed' }],
      health: { status: 'inactive' },
    },
  ]);

  let time = 1_700_000_000_000;
  // Job failure: Stalled job
  const jobMock = createMockJobs([
    {
      id: 'stalled-job-1',
      serverId: TEST_SERVER,
      operation: 'database.create',
      status: 'running',
      startedAt: new Date(time - 500_000).toISOString(),
      createdAt: new Date(time - 500_000).toISOString(),
    },
  ]);

  // Daemon failure
  const daemons = {
    renewalDaemon: {
      name: 'Renewal Daemon',
      status: async () => ({ healthy: false, status: 'error', message: 'socket closed' }),
    },
  };

  const watchdog = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    daemons,
    stalledJobTimeoutMs: 300_000,
    now: () => time,
  });

  const report = await watchdog.inspect({ serverId: TEST_SERVER });

  // Overall status is unhealthy
  assert.equal(report.status, 'unhealthy');
  assert.equal(report.summary.servicesHealthy, false);
  assert.equal(report.summary.queueHealthy, false);
  assert.equal(report.summary.daemonsHealthy, false);
  assert.equal(report.incidents.length, 3);

  // Check specific incidents
  assert.ok(report.incidents.some((i) => i.code === 'service_inactive' && i.targetId === 'mariadb'));
  assert.ok(report.incidents.some((i) => i.code === 'job_stalled' && i.targetId === 'stalled-job-1'));
  assert.ok(report.incidents.some((i) => i.code === 'daemon_unhealthy' && i.targetId === 'renewalDaemon'));
});

test('Service Auto-Recovery Integration: Remediates inactive service, terminates stalled jobs, and tracks recovery events', async () => {
  const serviceMock = createMockServices();
  // Start with nginx inactive
  serviceMock.setServices([
    {
      id: 'nginx',
      label: 'Nginx',
      category: 'web',
      installed: true,
      active: false,
      units: [{ unit: 'nginx.service', activeState: 'inactive', subState: 'dead' }],
      health: { status: 'inactive' },
    },
  ]);

  let time = 1_700_000_000_000;
  const jobMock = createMockJobs([
    {
      id: 'stalled-job-2',
      serverId: TEST_SERVER,
      operation: 'dns.update',
      status: 'running',
      startedAt: new Date(time - 600_000).toISOString(),
      createdAt: new Date(time - 600_000).toISOString(),
    },
  ]);

  const watchdog = createSystemWatchdogService({
    jobRegistry: jobMock,
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
    autoRecoveryEnabled: true,
    stalledJobTimeoutMs: 300_000,
    now: () => time,
  });

  // check() triggers inspect -> auto-recovery -> re-inspect
  const report = await watchdog.check({ serverId: TEST_SERVER });

  // Verified post-recovery status
  assert.equal(report.status, 'healthy');
  assert.equal(report.lastRecoveryResults.recovered.length, 2);

  // 1. Service recovered by restart
  const serviceRecovery = report.lastRecoveryResults.recovered.find((r) => r.targetType === 'service');
  assert.ok(serviceRecovery);
  assert.equal(serviceRecovery.targetId, 'nginx');
  assert.equal(serviceRecovery.action, 'restart');
  assert.equal(serviceRecovery.status, 'succeeded');

  // 2. Job recovered by failing stalled job
  const jobRecovery = report.lastRecoveryResults.recovered.find((r) => r.targetType === 'job');
  assert.ok(jobRecovery);
  assert.equal(jobRecovery.targetId, 'stalled-job-2');
  assert.equal(jobRecovery.action, 'fail_stalled');
  assert.equal(jobRecovery.status, 'succeeded');

  // Verify completions recorded failure code
  const completions = jobMock.getCompletions();
  assert.equal(completions.length, 1);
  assert.equal(completions[0].error.code, 'job_stalled_timeout');
});

test('Service Auto-Recovery Integration: Flapping protection suppresses excessive restarts within window', async () => {
  let restartCount = 0;
  // A service that keeps failing immediately after restart
  const inspectServices = async () => [
    {
      id: 'cron',
      label: 'Cron',
      category: 'scheduler',
      installed: true,
      active: false,
      units: [{ unit: 'cron.service', activeState: 'inactive', subState: 'failed' }],
      health: { status: 'inactive' },
    },
  ];
  const serviceControl = async (id, action) => {
    restartCount++;
    return { id, action, active: false };
  };

  let time = 1_700_000_000_000;
  const watchdog = createSystemWatchdogService({
    inspectServices,
    serviceControl,
    maxRecoveriesPerWindow: 2, // limit to 2 recoveries
    recoveryWindowMs: 600_000,  // 10 minutes window
    now: () => time,
  });

  // Attempt 1: recovered
  await watchdog.check({ serverId: TEST_SERVER });
  assert.equal(restartCount, 1);

  // Attempt 2: recovered (limit reached)
  time += 20_000;
  await watchdog.check({ serverId: TEST_SERVER });
  assert.equal(restartCount, 2);

  // Attempt 3: flapping threshold reached -> SUPPRESSED!
  time += 20_000;
  const report3 = await watchdog.check({ serverId: TEST_SERVER });
  assert.equal(restartCount, 2, 'Recovery must be suppressed and not call serviceControl');
  assert.equal(report3.lastRecoveryResults.suppressed.length, 1);
  assert.equal(report3.lastRecoveryResults.suppressed[0].status, 'suppressed_flapping');
  assert.equal(report3.services[0].flapping, true);

  // Attempt 4: after window expires (11 minutes later), recovery is permitted again
  time += 11 * 60 * 1000;
  await watchdog.check({ serverId: TEST_SERVER });
  assert.equal(restartCount, 3, 'Recovery should be permitted after window expires');
});

test('Watchdog On-Demand Recovery: Requires exact confirmation token and handles targets', async () => {
  const serviceMock = createMockServices();
  const watchdog = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });

  // 1. Success with format recover:service:nginx
  const r1 = await watchdog.recoverComponent({
    serverId: TEST_SERVER,
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(r1.recovered, true);
  assert.equal(r1.targetId, 'nginx');

  // 2. Success with format recover:nginx
  const r2 = await watchdog.recoverComponent({
    serverId: TEST_SERVER,
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:nginx',
  });
  assert.equal(r2.recovered, true);

  // 3. Rejects invalid confirmation token
  await assert.rejects(
    watchdog.recoverComponent({
      serverId: TEST_SERVER,
      targetType: 'service',
      targetId: 'nginx',
      confirmation: 'wrong-token',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'watchdog_confirmation_required' && err.status === 400,
  );

  // 4. Rejects invalid target type
  await assert.rejects(
    watchdog.recoverComponent({
      serverId: TEST_SERVER,
      targetType: 'unknown_type',
      targetId: 'nginx',
      confirmation: 'recover:nginx',
    }),
    (err) => err instanceof SystemWatchdogError && err.code === 'invalid_target_type' && err.status === 400,
  );
});

test('Watchdog HTTP Routes Integration: Role authorization strictly isolates watchdog from reseller and customer', async () => {
  const serviceMock = createMockServices();
  const watchdogService = createSystemWatchdogService({
    inspectServices: serviceMock.inspectServices,
    serviceControl: serviceMock.serviceControl,
  });

  const routes = [];
  const fakeApp = {
    get(pathPattern, ...handlers) { routes.push({ method: 'GET', pathPattern, handlers }); },
    post(pathPattern, ...handlers) { routes.push({ method: 'POST', pathPattern, handlers }); },
  };

  mountSystemWatchdogRoutes(fakeApp, {
    watchdogService,
    localServerId: TEST_SERVER,
  });

  const executeRoute = async (method, path, userRole, body = {}) => {
    let statusCode = 200;
    let responseBody = null;
    const req = {
      method,
      url: path,
      originalUrl: path,
      params: { serverId: TEST_SERVER },
      body,
      auth: {
        user: { id: `user-${userRole}`, role: userRole },
        access: {
          mode: userRole === 'owner' ? 'management' : userRole === 'read_only' ? 'read_only' : 'site_management',
          permissions: userRole === 'owner' ? ['*'] : userRole === 'read_only' ? ['servers.read'] : ['sites.manage'],
        },
        security: { managementAllowed: userRole !== 'read_only' },
      },
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { responseBody = b; return this; },
    };

    const route = routes.find((r) => r.method === method && (r.pathPattern === path || r.pathPattern.includes(':serverId')));
    if (!route) throw new Error(`Route not found: ${method} ${path}`);

    let handlerIdx = 0;
    const next = async (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
        return;
      }
      handlerIdx++;
      if (handlerIdx < route.handlers.length) {
        await route.handlers[handlerIdx](req, res, next);
      }
    };
    await route.handlers[0](req, res, next);
    return { statusCode, responseBody };
  };

  // 1. Owner can access status, check, and recover
  const ownerStatus = await executeRoute('GET', '/api/system/watchdog/status', 'owner');
  assert.equal(ownerStatus.statusCode, 200);

  const ownerCheck = await executeRoute('POST', '/api/system/watchdog/check', 'owner');
  assert.equal(ownerCheck.statusCode, 200);

  const ownerRecover = await executeRoute('POST', '/api/system/watchdog/recover', 'owner', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(ownerRecover.statusCode, 200);

  // 2. Read-only can view status, but cannot run check or recover
  const roStatus = await executeRoute('GET', '/api/system/watchdog/status', 'read_only');
  assert.equal(roStatus.statusCode, 200);

  const roCheck = await executeRoute('POST', '/api/system/watchdog/check', 'read_only');
  assert.equal(roCheck.statusCode, 403);

  const roRecover = await executeRoute('POST', '/api/system/watchdog/recover', 'read_only', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(roRecover.statusCode, 403);

  // 3. Reseller is forbidden from running check and recover
  const resellerCheck = await executeRoute('POST', '/api/system/watchdog/check', 'reseller');
  assert.equal(resellerCheck.statusCode, 403);

  const resellerRecover = await executeRoute('POST', '/api/system/watchdog/recover', 'reseller', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(resellerRecover.statusCode, 403);

  // 4. Customer is forbidden from running check and recover
  const customerCheck = await executeRoute('POST', '/api/system/watchdog/check', 'customer');
  assert.equal(customerCheck.statusCode, 403);

  const customerRecover = await executeRoute('POST', '/api/system/watchdog/recover', 'customer', {
    targetType: 'service',
    targetId: 'nginx',
    confirmation: 'recover:service:nginx',
  });
  assert.equal(customerRecover.statusCode, 403);
});
