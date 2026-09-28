import assert from 'node:assert/strict';
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
import { handleAuditRead } from '../src/audit-http.js';
import { mountTerminalCapabilityRoutes } from '../src/terminal-capability-http.js';
import { classifyManagementMutation, attachManagementAudit } from '../src/management-audit.js';
import { withAuditActor, currentAuditTenant } from '../src/audit-request-context.js';

const owner = Object.freeze({ id: 'owner-user', role: 'owner', active: true });
const readOnly = Object.freeze({ id: 'readonly-user', role: 'read_only', active: true });

const resellerA = Object.freeze({
  id: 'reseller-a',
  role: 'site_manager',
  hosting: { kind: 'reseller', resellerId: null },
  active: true,
  websiteIds: ['site-a1', 'site-a2'],
});

const resellerB = Object.freeze({
  id: 'reseller-b',
  role: 'site_manager',
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
  role: 'site_manager',
  hosting: { kind: 'customer', resellerId: 'reseller-a' },
  active: true,
  websiteIds: ['site-a1'],
});

const customerDirectActor = Object.freeze({
  id: customerDirect.id,
  role: 'site_manager',
  hosting: { kind: 'customer', resellerId: null },
  active: true,
  websiteIds: ['site-direct'],
});

const legacySmActor = Object.freeze({
  id: 'legacy-sm',
  role: 'site_manager',
  active: true,
  websiteIds: ['site-legacy'],
});

const websiteA1 = Object.freeze({ id: 'site-a1', customerId: customerA1.id });
const websiteB1 = Object.freeze({ id: 'site-b1', customerId: customerB1.id });
const websiteDirect = Object.freeze({ id: 'site-direct', customerId: customerDirect.id });

test('extractActorTenant correctly classifies Owner, Reseller, Customer, and legacy SM', () => {
  const o = extractActorTenant(owner);
  assert.equal(o.isOwner, true);
  assert.equal(o.isGlobal, true);
  assert.equal(o.actorId, 'owner-user');

  const ro = extractActorTenant(readOnly);
  assert.equal(ro.isReadOnly, true);
  assert.equal(ro.isGlobal, true);

  const r = extractActorTenant(resellerA);
  assert.equal(r.isReseller, true);
  assert.equal(r.kind, 'reseller');
  assert.equal(r.resellerId, null);
  assert.deepEqual(r.websiteIds, ['site-a1', 'site-a2']);

  const c = extractActorTenant(customerA1Actor);
  assert.equal(c.isCustomer, true);
  assert.equal(c.kind, 'customer');
  assert.equal(c.resellerId, 'reseller-a');
  assert.equal(c.isDirectOwnerCustomer, false);

  const cd = extractActorTenant(customerDirectActor);
  assert.equal(cd.isCustomer, true);
  assert.equal(cd.isDirectOwnerCustomer, true);
  assert.equal(cd.resellerId, null);

  const l = extractActorTenant(legacySmActor);
  assert.equal(l.isLegacySiteManager, true);
  assert.equal(l.kind, null);
});

test('assertCustomerBelongsToReseller allows owner and direct parent, denies cross-tenant', () => {
  // Owner can manage all
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: owner, customer: customerA1 }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: owner, customer: customerB1 }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: owner, customer: customerDirect }));

  // Reseller A can manage direct child customer A1 & A2
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: resellerA, customer: customerA1 }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: resellerA, customer: customerA2 }));

  // Reseller A cannot manage Reseller B customer
  assert.throws(
    () => assertCustomerBelongsToReseller({ actor: resellerA, customer: customerB1 }),
    (error) => error instanceof AuthError && error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller A cannot manage direct Owner customer
  assert.throws(
    () => assertCustomerBelongsToReseller({ actor: resellerA, customer: customerDirect }),
    (error) => error instanceof AuthError && error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Customer cannot manage other customers
  assert.throws(
    () => assertCustomerBelongsToReseller({ actor: customerA1Actor, customer: customerA2 }),
    (error) => error instanceof AuthError && error.status === 403,
  );

  // Inactive reseller cannot manage customers
  assert.throws(
    () => assertCustomerBelongsToReseller({ actor: { ...resellerA, active: false }, customer: customerA1 }),
    (error) => error instanceof AuthError && error.status === 403 && error.code === 'tenant_actor_inactive',
  );
});

test('assertWebsiteBelongsToTenant validates website ownership against tenant boundaries', () => {
  // Owner allowed on all sites
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: owner, website: websiteA1 }));
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: owner, website: websiteB1 }));
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: owner, website: websiteDirect }));

  // Reseller A allowed on website A1 (attached child website)
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({
    actor: resellerA,
    website: websiteA1,
    customer: customerA1,
  }));

  // Reseller A DENIED on website B1
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: resellerA, website: websiteB1 }),
    (error) => error instanceof AuthError && error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller A DENIED on direct Owner customer site
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: resellerA, website: websiteDirect }),
    (error) => error instanceof AuthError && error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Customer A1 allowed on own site
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: customerA1Actor, website: websiteA1 }));

  // Customer A1 DENIED on website B1 and direct Owner website
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: customerA1Actor, website: websiteB1 }),
    (error) => error instanceof AuthError && error.status === 403,
  );
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: customerA1Actor, website: websiteDirect }),
    (error) => error instanceof AuthError && error.status === 403,
  );

  // Legacy site manager allowed on websiteIds (even without customerId)
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({
    actor: legacySmActor,
    website: { id: 'site-legacy', customerId: 'c-legacy' },
  }));
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({
    actor: legacySmActor,
    website: { id: 'site-legacy' },
  }));
  assert.throws(
    () => assertWebsiteBelongsToTenant({ actor: legacySmActor, website: websiteA1 }),
    (error) => error instanceof AuthError && error.status === 403,
  );
});

test('assertEntityTenantBoundary handles cross-entity boundaries without metadata leakage', () => {
  // Reseller scope check for child entity
  assert.equal(assertEntityTenantBoundary({
    actor: resellerA,
    entityType: 'domain',
    websiteId: 'site-a1',
    resellerId: 'reseller-a',
  }), true);

  // Reseller scope check for foreign entity fails
  assert.throws(
    () => assertEntityTenantBoundary({
      actor: resellerA,
      entityType: 'domain',
      websiteId: 'site-b1',
      resellerId: 'reseller-b',
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'tenant_boundary_forbidden');
      // Verify message does not disclose foreign IDs
      assert.equal(error.message.includes('reseller-b'), false);
      assert.equal(error.message.includes('site-b1'), false);
      return true;
    },
  );

  // Reseller scope check for direct Owner entity fails (resellerId === null)
  assert.throws(
    () => assertEntityTenantBoundary({
      actor: resellerA,
      entityType: 'domain',
      websiteId: 'site-direct',
      resellerId: null,
    }),
    (error) => error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller scope check for non-website entity with null resellerId fails
  assert.throws(
    () => assertEntityTenantBoundary({
      actor: resellerA,
      entityType: 'customer',
      entityId: 'customer-direct',
      resellerId: null,
    }),
    (error) => error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // Customer scope check for foreign entity fails
  assert.throws(
    () => assertEntityTenantBoundary({
      actor: customerA1Actor,
      entityType: 'database',
      websiteId: 'site-b1',
      customerId: 'customer-b1',
    }),
    (error) => error.status === 403,
  );
});

test('sanitizeTenantCollection filters out items outside tenant boundary', () => {
  const items = [
    { id: 'site-a1', websiteId: 'site-a1', customerId: 'customer-a1', resellerId: 'reseller-a' },
    { id: 'site-a2', websiteId: 'site-a2', customerId: 'customer-a2', resellerId: 'reseller-a' },
    { id: 'site-b1', websiteId: 'site-b1', customerId: 'customer-b1', resellerId: 'reseller-b' },
    { id: 'site-direct', websiteId: 'site-direct', customerId: 'customer-direct', resellerId: null },
  ];

  // Owner gets all
  assert.equal(sanitizeTenantCollection(items, owner).length, 4);

  // Reseller A gets only site-a1 and site-a2
  const resellerItems = sanitizeTenantCollection(items, resellerA);
  assert.deepEqual(resellerItems.map((i) => i.id), ['site-a1', 'site-a2']);

  // Customer A1 gets only site-a1
  const customerItems = sanitizeTenantCollection(items, customerA1Actor);
  assert.deepEqual(customerItems.map((i) => i.id), ['site-a1']);
});

test('createTenantBoundaryMiddleware enforces boundary on HTTP requests', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const customerLookup = async (id) => customers[id] ?? null;

  const middleware = createTenantBoundaryMiddleware({ customerLookup });

  const run = async (actor, url) => {
    const req = { url, originalUrl: url, method: 'GET', auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    let responseBody = null;
    const headers = {};
    const res = {
      status(code) { statusCode = code; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(body) { responseBody = body; return this; },
    };
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  // Reseller A accessing own customer
  const ownCust = await run(resellerA, '/api/customers/customer-a1');
  assert.equal(ownCust.called, true);

  // Reseller A accessing foreign customer (403)
  const foreignCust = await run(resellerA, '/api/customers/customer-b1');
  assert.equal(foreignCust.called, false);
  assert.equal(foreignCust.statusCode, 403);
  assert.equal(foreignCust.headers['Cache-Control'], 'no-store');

  // Reseller A accessing direct Owner customer (403)
  const directCust = await run(resellerA, '/api/customers/customer-direct');
  assert.equal(directCust.called, false);
  assert.equal(directCust.statusCode, 403);

  // Customer A1 accessing own website
  const ownSite = await run(customerA1Actor, '/api/websites/site-a1');
  assert.equal(ownSite.called, true);

  // Customer A1 accessing foreign website (403)
  const foreignSite = await run(customerA1Actor, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);

  // Owner allowed everywhere
  const ownerSite = await run(owner, '/api/websites/site-b1');
  assert.equal(ownerSite.called, true);

  // Unauthorized role (legacy site_manager) accessing customer route is denied (403)
  const legacyCust = await run(legacySmActor, '/api/customers/customer-a1');
  assert.equal(legacyCust.called, false);
  assert.equal(legacyCust.statusCode, 403);
  assert.equal(legacyCust.headers['Cache-Control'], 'no-store');

  // Reseller accessing customer route when customerLookup is omitted fails closed (503)
  const noLookupMiddleware = createTenantBoundaryMiddleware({});
  const runNoLookup = async (actor, url) => {
    const req = { url, originalUrl: url, method: 'GET', auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    const headers = {};
    const res = {
      status(code) { statusCode = code; return this; },
      setHeader(k, v) { headers[k] = v; },
      json() { return this; },
    };
    await noLookupMiddleware(req, res, () => { called = true; });
    return { called, statusCode, headers };
  };
  const missingCust = await runNoLookup(resellerA, '/api/customers/customer-a1');
  assert.equal(missingCust.called, false);
  assert.equal(missingCust.statusCode, 503);
  assert.equal(missingCust.headers['Cache-Control'], 'no-store');

  // Reseller accessing customer route when customerLookup is not a function fails closed (503)
  const invalidLookupMiddleware = createTenantBoundaryMiddleware({ customerLookup: 'not-a-fn' });
  let invalidCalled = false;
  let invalidStatus = 200;
  await invalidLookupMiddleware(
    { url: '/api/customers/customer-a1', originalUrl: '/api/customers/customer-a1', method: 'GET', auth: { user: resellerA } },
    { status(c) { invalidStatus = c; return this; }, setHeader() {}, json() { return this; } },
    () => { invalidCalled = true; },
  );
  assert.equal(invalidCalled, false);
  assert.equal(invalidStatus, 503);

  // Reseller accessing customer route when customerLookup throws fails closed (503)
  const failingLookupMiddleware = createTenantBoundaryMiddleware({
    customerLookup: async () => { throw new Error('database connection refused'); },
  });
  let failingCalled = false;
  let failingStatus = 200;
  await failingLookupMiddleware(
    { url: '/api/customers/customer-a1', originalUrl: '/api/customers/customer-a1', method: 'GET', auth: { user: resellerA } },
    { status(c) { failingStatus = c; return this; }, setHeader() {}, json() { return this; } },
    () => { failingCalled = true; },
  );
  assert.equal(failingCalled, false);
  assert.equal(failingStatus, 503);

  // Owner accessing customer route even without customerLookup proceeds (global)
  const ownerNoLookup = await runNoLookup(owner, '/api/customers/customer-a1');
  assert.equal(ownerNoLookup.called, true);
});

test('tenant boundary middleware enforces inactive account rejection', async () => {
  const inactiveReseller = { ...resellerA, active: false };
  const inactiveCustomer = { ...customerA1Actor, active: false };
  const middleware = createTenantBoundaryMiddleware({});

  const run = async (actor, url) => {
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

  const resReseller = await run(inactiveReseller, '/api/websites/site-a1');
  assert.equal(resReseller.called, false);
  assert.equal(resReseller.statusCode, 403);
  assert.equal(resReseller.responseBody.error.code, 'tenant_actor_inactive');

  const resCust = await run(inactiveCustomer, '/api/websites/site-a1');
  assert.equal(resCust.called, false);
  assert.equal(resCust.statusCode, 403);
  assert.equal(resCust.responseBody.error.code, 'tenant_actor_inactive');
});

test('tenant boundary middleware enforces Plesk permission boundaries on endpoints', async () => {
  const middleware = createTenantBoundaryMiddleware({});

  const run = async (actor, url, method = 'GET', body = null) => {
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

  // 1. Panel settings are forbidden for non-global accounts
  for (const path of ['/api/panel/settings', '/api/settings']) {
    const r = await run(resellerA, path);
    assert.equal(r.called, false);
    assert.equal(r.statusCode, 403);
    assert.equal(r.responseBody.error.code, 'tenant_boundary_forbidden');

    const c = await run(customerA1Actor, path);
    assert.equal(c.called, false);
    assert.equal(c.statusCode, 403);
  }

  // 2. System packages and upgrades are forbidden
  for (const path of ['/api/system/packages', '/api/system/upgrade', '/api/servers/srv-1/system/packages', '/api/servers/srv-1/services']) {
    const r = await run(resellerA, path);
    assert.equal(r.called, false);
    assert.equal(r.statusCode, 403);
  }

  // 3. Global backups are forbidden
  for (const path of ['/api/backups', '/api/backups/repositories', '/api/backups/remotes']) {
    const r = await run(resellerA, path);
    assert.equal(r.called, false);
    assert.equal(r.statusCode, 403);
  }

  // 4. Unmanaged top-level website and application creation is forbidden
  for (const path of ['/api/websites', '/api/applications']) {
    const r = await run(resellerA, path, 'POST', {});
    assert.equal(r.called, false);
    assert.equal(r.statusCode, 403);
  }

  // 5. Unbound server-level databases are forbidden
  const dbRes = await run(resellerA, '/api/servers/srv-1/databases');
  assert.equal(dbRes.called, false);
  assert.equal(dbRes.statusCode, 403);

  // 6. Generic user admin forbidden, but self hosting accounts allowed
  const userAdminRes = await run(resellerA, '/api/users');
  assert.equal(userAdminRes.called, false);
  assert.equal(userAdminRes.statusCode, 403);

  const selfHostingRes = await run(resellerA, '/api/users/hosting/accounts/self/customers');
  assert.equal(selfHostingRes.called, true);

  // 7. Customer collection access
  const custCollForCust = await run(customerA1Actor, '/api/customers');
  assert.equal(custCollForCust.called, false);
  assert.equal(custCollForCust.statusCode, 403);

  const custCollForSm = await run(legacySmActor, '/api/customers');
  assert.equal(custCollForSm.called, false);
  assert.equal(custCollForSm.statusCode, 403);

  const custCollForReseller = await run(resellerA, '/api/customers');
  assert.equal(custCollForReseller.called, true);

  // 8. Domain creation with website validation
  const validDomain = await run(resellerA, '/api/domains', 'POST', { websiteId: 'site-a1' });
  assert.equal(validDomain.called, true);

  const forgedDomain = await run(resellerA, '/api/domains', 'POST', { websiteId: 'site-b1' });
  assert.equal(forgedDomain.called, false);
  assert.equal(forgedDomain.statusCode, 403);

  const emptyDomain = await run(resellerA, '/api/domains', 'POST', {});
  assert.equal(emptyDomain.called, false);
  assert.equal(emptyDomain.statusCode, 403);

  // 9. Nested server website routes
  const validServerSite = await run(resellerA, '/api/servers/srv-1/websites/site-a1/files');
  assert.equal(validServerSite.called, true);

  const foreignServerSite = await run(resellerA, '/api/servers/srv-1/websites/site-b1/files');
  assert.equal(foreignServerSite.called, false);
  assert.equal(foreignServerSite.statusCode, 403);
});

test('audit queries and results enforce tenant isolation', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-b1': customerB1,
  };
  const middleware = createTenantBoundaryMiddleware({
    customerLookup: async (id) => customers[id] ?? null,
  });

  const run = async (actor, url) => {
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

  // Legacy site manager cannot query audit
  const smAudit = await run(legacySmActor, '/api/audit');
  assert.equal(smAudit.called, false);
  assert.equal(smAudit.statusCode, 403);

  // Customer querying own actions
  const custOwn = await run(customerA1Actor, '/api/audit?actorId=customer-a1');
  assert.equal(custOwn.called, true);

  // Customer querying foreign actor (403)
  const custForeign = await run(customerA1Actor, '/api/audit?actorId=customer-b1');
  assert.equal(custForeign.called, false);
  assert.equal(custForeign.statusCode, 403);

  // Customer querying assigned website
  const custOwnSite = await run(customerA1Actor, '/api/audit?resourceType=website&resourceId=site-a1');
  assert.equal(custOwnSite.called, true);

  // Customer querying foreign website (403)
  const custForeignSite = await run(customerA1Actor, '/api/audit?resourceType=website&resourceId=site-b1');
  assert.equal(custForeignSite.called, false);
  assert.equal(custForeignSite.statusCode, 403);

  // Customer querying server-level resource (403)
  const custServerResource = await run(customerA1Actor, '/api/audit?resourceType=server&resourceId=srv-1');
  assert.equal(custServerResource.called, false);
  assert.equal(custServerResource.statusCode, 403);

  // Reseller querying own child customer actions
  const resChild = await run(resellerA, '/api/audit?actorId=customer-a1');
  assert.equal(resChild.called, true);

  // Reseller querying foreign child customer actions (403)
  const resForeignChild = await run(resellerA, '/api/audit?actorId=customer-b1');
  assert.equal(resForeignChild.called, false);
  assert.equal(resForeignChild.statusCode, 403);
});

test('audit queries support synchronous customerLookup without TypeError', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-b1': customerB1,
  };
  // Synchronous lookup function, like (id) => hostingAccounts.getCustomer(id)
  const syncMiddleware = createTenantBoundaryMiddleware({
    customerLookup: (id) => customers[id] ?? null,
  });

  const run = async (actor, url) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method: 'GET', auth: { user: actor } };
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader() {},
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await syncMiddleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody };
  };

  // Reseller querying child actor with sync lookup -> 200
  const childActor = await run(resellerA, '/api/audit?actorId=customer-a1');
  assert.equal(childActor.called, true);

  // Reseller querying foreign actor with sync lookup -> 403
  const foreignActor = await run(resellerA, '/api/audit?actorId=customer-b1');
  assert.equal(foreignActor.called, false);
  assert.equal(foreignActor.statusCode, 403);

  // Reseller querying child customer resource with sync lookup -> 200
  const childRes = await run(resellerA, '/api/audit?resourceType=customer&resourceId=customer-a1');
  assert.equal(childRes.called, true);

  // Reseller querying foreign customer resource with sync lookup -> 403
  const foreignRes = await run(resellerA, '/api/audit?resourceType=customer&resourceId=customer-b1');
  assert.equal(foreignRes.called, false);
  assert.equal(foreignRes.statusCode, 403);

  // Reseller querying self id as customer resource -> 403 (reseller is not a customer)
  const selfRes = await run(resellerA, '/api/audit?resourceType=customer&resourceId=reseller-a');
  assert.equal(selfRes.called, false);
  assert.equal(selfRes.statusCode, 403);

  // Sync lookup throwing error -> fail closed safely (403), does not crash with TypeError
  const throwingMiddleware = createTenantBoundaryMiddleware({
    customerLookup: () => { throw new Error('DB error'); },
  });
  let throwingCalled = false;
  let throwingStatus = 200;
  await throwingMiddleware(
    { url: '/api/audit?actorId=customer-a1', originalUrl: '/api/audit?actorId=customer-a1', method: 'GET', auth: { user: resellerA } },
    { status(c) { throwingStatus = c; return this; }, setHeader() {}, json() {} },
    () => { throwingCalled = true; },
  );
  assert.equal(throwingCalled, false);
  assert.equal(throwingStatus, 403);
});

test('handleAuditRead enforces tenant scoping and filters returned items', () => {
  const auditRecords = [
    { id: '1', actorId: 'owner-user', action: 'system.upgrade', resourceType: 'server', resourceId: 'srv-1' },
    { id: '2', actorId: 'reseller-a', action: 'hosting.customer.create', resourceType: 'customer', resourceId: 'customer-a1' },
    { id: '3', actorId: 'customer-a1', action: 'website.update', resourceType: 'website', resourceId: 'site-a1' },
    { id: '4', actorId: 'customer-b1', action: 'website.update', resourceType: 'website', resourceId: 'site-b1' },
    { id: '5', actorId: 'reseller-b', action: 'hosting.customer.create', resourceType: 'customer', resourceId: 'customer-b1' },
  ];

  const mockStore = {
    audit: {
      list: (query) => {
        let items = [...auditRecords];
        if (query.actorId) items = items.filter((i) => i.actorId === query.actorId);
        if (query.resourceType) items = items.filter((i) => i.resourceType === query.resourceType);
        if (query.resourceId) items = items.filter((i) => i.resourceId === query.resourceId);
        return { items, total: items.length };
      },
    },
    users: {
      hostingAccounts: {
        listChildCustomerIds: (resellerId) => (resellerId === 'reseller-a' ? ['customer-a1'] : ['customer-b1']),
      },
    },
  };

  const jsonHelper = (res, status, payload) => {
    res.statusCode = status;
    res.body = payload;
    return payload;
  };

  // 1. Owner sees all records
  const ownerRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: owner } },
    response: ownerRes,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.equal(ownerRes.body.data.items.length, 5);

  // 2. Legacy site manager gets 403
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: legacySmActor } },
      response: { setHeader() {} },
      query: new URLSearchParams(),
      store: mockStore,
      json: jsonHelper,
    }),
    (error) => error.status === 403,
  );

  // 3. Customer A1 sees only their own actions and website
  const custRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: customerA1Actor } },
    response: custRes,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.equal(custRes.body.data.items.length, 1);
  assert.equal(custRes.body.data.items[0].id, '3');

  // 4. Reseller A sees reseller-a actions, customer-a1 actions, and site-a1 actions
  const resellerRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: resellerA } },
    response: resellerRes,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.deepEqual(resellerRes.body.data.items.map((i) => i.id), ['2', '3']);

  // 5. Inactive reseller gets 403
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: { ...resellerA, active: false } } },
      response: { setHeader() {} },
      query: new URLSearchParams(),
      store: mockStore,
      json: jsonHelper,
    }),
    (error) => error.status === 403 && error.code === 'tenant_actor_inactive',
  );

  // 6. Reseller querying foreign actor gets 403
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ actorId: 'customer-b1' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (error) => error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // 6b. Reseller querying foreign customer resource gets 403
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ resourceType: 'customer', resourceId: 'customer-b1' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (error) => error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // 6c. Reseller querying self id as customer resource gets 403 (reseller is not a customer)
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ resourceType: 'customer', resourceId: 'reseller-a' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (error) => error.status === 403 && error.code === 'tenant_boundary_forbidden',
  );

  // 7. Store returning { events, total } (standard AuditStore format) is also filtered
  const storeWithEvents = {
    audit: {
      list: () => ({ events: [...auditRecords], total: auditRecords.length }),
    },
    users: mockStore.users,
  };
  const resellerEventsRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: resellerA } },
    response: resellerEventsRes,
    query: new URLSearchParams(),
    store: storeWithEvents,
    json: jsonHelper,
  });
  assert.deepEqual(resellerEventsRes.body.data.events.map((e) => e.id), ['2', '3']);
  assert.equal(resellerEventsRes.body.data.total, 2);

  // 8. Top-level store.hostingAccounts is supported (API store structure)
  const storeWithTopLevelHosting = {
    audit: mockStore.audit,
    hostingAccounts: mockStore.users.hostingAccounts,
  };
  const resellerTopHostingRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: resellerA } },
    response: resellerTopHostingRes,
    query: new URLSearchParams(),
    store: storeWithTopLevelHosting,
    json: jsonHelper,
  });
  assert.deepEqual(resellerTopHostingRes.body.data.items.map((i) => i.id), ['2', '3']);

  // Reseller querying own child customer via store.hostingAccounts
  const resellerQueryChildRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: resellerA } },
    response: resellerQueryChildRes,
    query: new URLSearchParams({ actorId: 'customer-a1' }),
    store: storeWithTopLevelHosting,
    json: jsonHelper,
  });
  assert.deepEqual(resellerQueryChildRes.body.data.items.map((i) => i.id), ['3']);
});

test('terminal capability routes enforce Plesk isolation and tenant website boundaries', async () => {
  let issuedCapability = null;
  const mockRegistry = {
    issue: (cap) => {
      issuedCapability = cap;
      return { token: 'term-tok', ...cap };
    },
  };
  const mockServerRegistry = {
    getServer: async (id) => (id === 'local-server' ? { id: 'local-server' } : null),
  };
  const mockWebsiteRegistry = {
    getWebsite: async (id) => {
      if (id === 'site-a1') {
        return {
          id: 'site-a1',
          serverId: 'local-server',
          runtimeType: 'node',
          unixUser: 'yunapp-112233445566',
          documentRoot: '/var/www/yunpanel/apps/site-a1/current',
        };
      }
      if (id === 'site-b1') {
        return {
          id: 'site-b1',
          serverId: 'local-server',
          runtimeType: 'node',
          unixUser: 'yunapp-aabbccddeeff',
          documentRoot: '/var/www/yunpanel/apps/site-b1/current',
        };
      }
      return null;
    },
  };

  const routeHandlers = {};
  const mockApp = {
    post: (path, guard, handler) => {
      routeHandlers[path] = { guard, handler };
    },
  };

  mountTerminalCapabilityRoutes(mockApp, {
    terminalCapabilityRegistry: mockRegistry,
    serverRegistry: mockServerRegistry,
    websiteRegistry: mockWebsiteRegistry,
    localServerId: 'local-server',
  });

  const postHandler = routeHandlers['/api/terminal/capabilities'].handler;

  const invoke = async (actor, body) => {
    let statusCode = 200;
    let responseBody = null;
    const req = {
      body,
      auth: { id: 'sess-1', user: actor },
    };
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { responseBody = b; return this; },
    };
    await postHandler(req, res);
    return { statusCode, responseBody };
  };

  // 1. Owner can issue server terminal
  const ownerServer = await invoke(owner, { scope: 'server', serverId: 'local-server' });
  assert.equal(ownerServer.statusCode, 201);
  assert.equal(issuedCapability.target.scope, 'server');
  assert.equal(issuedCapability.target.user, 'root');

  // 2. Reseller cannot issue server terminal (403)
  await assert.rejects(
    invoke(resellerA, { scope: 'server', serverId: 'local-server' }),
    (err) => err.status === 403 && err.code === 'terminal_server_forbidden',
  );

  // 3. Customer cannot issue server terminal (403)
  await assert.rejects(
    invoke(customerA1Actor, { scope: 'server', serverId: 'local-server' }),
    (err) => err.status === 403 && err.code === 'terminal_server_forbidden',
  );

  // 4. Customer can issue site terminal for own attached website
  const custSite = await invoke(customerA1Actor, { scope: 'site', websiteId: 'site-a1' });
  assert.equal(custSite.statusCode, 201);
  assert.equal(issuedCapability.target.scope, 'site');
  assert.equal(issuedCapability.target.websiteId, 'site-a1');

  // 5. Customer cannot issue site terminal for foreign website (403)
  await assert.rejects(
    invoke(customerA1Actor, { scope: 'site', websiteId: 'site-b1' }),
    (err) => err.status === 403 && err.code === 'terminal_site_forbidden',
  );

  // 6. Inactive customer rejected (403)
  await assert.rejects(
    invoke({ ...customerA1Actor, active: false }, { scope: 'site', websiteId: 'site-a1' }),
    (err) => err.status === 403 && err.code === 'tenant_actor_inactive',
  );

  // 7. Reseller can issue site terminal for own attached website
  const resSite = await invoke(resellerA, { scope: 'site', websiteId: 'site-a1' });
  assert.equal(resSite.statusCode, 201);
  assert.equal(issuedCapability.target.scope, 'site');
  assert.equal(issuedCapability.target.websiteId, 'site-a1');

  // 8. Reseller cannot issue site terminal for foreign website (403)
  await assert.rejects(
    invoke(resellerA, { scope: 'site', websiteId: 'site-b1' }),
    (err) => err.status === 403 && err.code === 'terminal_site_forbidden',
  );

  // 9. Inactive reseller rejected (403)
  await assert.rejects(
    invoke({ ...resellerA, active: false }, { scope: 'site', websiteId: 'site-a1' }),
    (err) => err.status === 403 && err.code === 'tenant_actor_inactive',
  );
});

test('management audit classifies customer and hosting account mutations', () => {
  assert.deepEqual(
    classifyManagementMutation('POST', '/api/users/hosting/accounts/self/customers'),
    { action: 'hosting.customer.create', resourceType: 'customer', resourceId: 'new' },
  );

  assert.deepEqual(
    classifyManagementMutation('PATCH', '/api/users/hosting/accounts/self/customers/cust-1/login'),
    { action: 'hosting.customer.login.update', resourceType: 'customer', resourceId: 'cust-1' },
  );

  assert.deepEqual(
    classifyManagementMutation('PATCH', '/api/users/hosting/accounts/self/customers/cust-1/status'),
    { action: 'hosting.customer.status.update', resourceType: 'customer', resourceId: 'cust-1' },
  );

  assert.deepEqual(
    classifyManagementMutation('POST', '/api/customers'),
    { action: 'customer.create', resourceType: 'customer', resourceId: 'new' },
  );

  assert.deepEqual(
    classifyManagementMutation('PATCH', '/api/customers/cust-1'),
    { action: 'customer.update', resourceType: 'customer', resourceId: 'cust-1' },
  );

  assert.deepEqual(
    classifyManagementMutation('DELETE', '/api/customers/cust-1'),
    { action: 'customer.delete', resourceType: 'customer', resourceId: 'cust-1' },
  );

  assert.deepEqual(
    classifyManagementMutation('POST', '/api/users/hosting/accounts/self/sites'),
    { action: 'hosting.site.create', resourceType: 'website', resourceId: 'new' },
  );
});

test('withAuditActor carries tenant context and currentAuditTenant returns it', () => {
  const tenantContext = { actorId: 'reseller-a', role: 'reseller', isReseller: true };
  withAuditActor('reseller-a', () => {
    assert.deepEqual(currentAuditTenant(), tenantContext);
  }, { tenant: tenantContext });
});

test('attachManagementAudit attaches current audit tenant context', () => {
  const tenantContext = { actorId: 'reseller-a', role: 'reseller', isReseller: true };
  withAuditActor('reseller-a', () => {
    const recorded = [];
    const mockAudit = { record: (e) => recorded.push(e) };
    const mockRes = { once: () => {} };
    const result = attachManagementAudit({
      request: { method: 'POST', auth: { user: { id: 'reseller-a' } } },
      response: mockRes,
      pathname: '/api/customers',
      audit: mockAudit,
    });
    assert.equal(result.actorId, 'reseller-a');
    assert.equal(result.action, 'customer.create');
    assert.deepEqual(result.tenant, tenantContext);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].outcome, 'accepted');
  }, { tenant: tenantContext });
});
