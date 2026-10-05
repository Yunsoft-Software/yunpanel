import assert from 'node:assert/strict';
import test from 'node:test';
import './site-manager-auth-csrf.test.js';
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
import { mountWebsiteRoutes } from '../src/website-http.js';
import { createApp } from '../src/core-app.js';

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

const customerA2Actor = Object.freeze({
  id: customerA2.id,
  role: 'site_manager',
  hosting: { kind: 'customer', resellerId: 'reseller-a' },
  active: true,
  websiteIds: ['site-a2'],
});

const customerB1Actor = Object.freeze({
  id: customerB1.id,
  role: 'site_manager',
  hosting: { kind: 'customer', resellerId: 'reseller-b' },
  active: true,
  websiteIds: ['site-b1'],
});

const websiteA2 = Object.freeze({ id: 'site-a2', customerId: customerA2.id });

test('cross-tenant negative scenarios: cross-customer data leakage attempts under same reseller', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const customerLookup = async (id) => customers[id] ?? null;
  const middleware = createTenantBoundaryMiddleware({ customerLookup });

  const run = async (actor, url, method = 'GET', body = null) => {
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    let responseBody = null;
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  // 1. Customer A1 attempts to access Customer A2's customer account (same reseller)
  const custRes = await run(customerA1Actor, '/api/customers/customer-a2');
  assert.equal(custRes.called, false);
  assert.equal(custRes.statusCode, 403);
  assert.equal(custRes.headers['Cache-Control'], 'no-store');
  assert.equal(custRes.responseBody.error.code, 'tenant_boundary_forbidden');

  // 2. Customer A1 attempts to access Customer A2's website
  const siteRes = await run(customerA1Actor, '/api/websites/site-a2');
  assert.equal(siteRes.called, false);
  assert.equal(siteRes.statusCode, 403);
  assert.equal(siteRes.headers['Cache-Control'], 'no-store');
  assert.equal(siteRes.responseBody.error.code, 'tenant_boundary_forbidden');

  // 3. Customer A1 attempts to access Customer A2's server website route
  const serverSiteRes = await run(customerA1Actor, '/api/servers/srv-1/websites/site-a2/files');
  assert.equal(serverSiteRes.called, false);
  assert.equal(serverSiteRes.statusCode, 403);
  assert.equal(serverSiteRes.headers['Cache-Control'], 'no-store');

  // 4. Customer A1 attempts to create a domain on Customer A2's website
  const domainRes = await run(customerA1Actor, '/api/domains', 'POST', { websiteId: 'site-a2' });
  assert.equal(domainRes.called, false);
  assert.equal(domainRes.statusCode, 403);
  assert.equal(domainRes.headers['Cache-Control'], 'no-store');

  // 5. Customer A1 attempts to query audit log for Customer A2
  const auditActorRes = await run(customerA1Actor, '/api/audit?actorId=customer-a2');
  assert.equal(auditActorRes.called, false);
  assert.equal(auditActorRes.statusCode, 403);
  assert.equal(auditActorRes.headers['Cache-Control'], 'no-store');

  // 6. Customer A1 attempts to query audit log for Customer A2's website
  const auditSiteRes = await run(customerA1Actor, '/api/audit?resourceType=website&resourceId=site-a2');
  assert.equal(auditSiteRes.called, false);
  assert.equal(auditSiteRes.statusCode, 403);
  assert.equal(auditSiteRes.headers['Cache-Control'], 'no-store');

  // 7. Customer A1 attempts to query audit log for Customer A2's customer profile
  const auditCustRes = await run(customerA1Actor, '/api/audit?resourceType=customer&resourceId=customer-a2');
  assert.equal(auditCustRes.called, false);
  assert.equal(auditCustRes.statusCode, 403);
  assert.equal(auditCustRes.headers['Cache-Control'], 'no-store');

  // 8. Terminal capability: Customer A1 targeting Customer A2's website
  const routeHandlers = {};
  const mockApp = { post: (path, guard, handler) => { routeHandlers[path] = { handler }; } };
  mountTerminalCapabilityRoutes(mockApp, {
    terminalCapabilityRegistry: { issue: () => ({}) },
    serverRegistry: { getServer: async () => ({ id: 'local-server' }) },
    websiteRegistry: {
      getWebsite: async (id) => ({
        id,
        serverId: 'local-server',
        runtimeType: 'node',
        unixUser: 'yunapp-112233445566',
        documentRoot: `/var/www/yunpanel/apps/${id}/current`,
      }),
    },
    localServerId: 'local-server',
  });
  await assert.rejects(
    routeHandlers['/api/terminal/capabilities'].handler(
      { body: { scope: 'site', websiteId: 'site-a2' }, auth: { id: 's-1', user: customerA1Actor } },
      { status() { return this; }, json() { return this; } },
    ),
    (err) => err.status === 403 && err.code === 'terminal_site_forbidden',
  );

  // 9. Customer A1 targeting server terminal
  await assert.rejects(
    routeHandlers['/api/terminal/capabilities'].handler(
      { body: { scope: 'server', serverId: 'local-server' }, auth: { id: 's-1', user: customerA1Actor } },
      { status() { return this; }, json() { return this; } },
    ),
    (err) => err.status === 403 && err.code === 'terminal_server_forbidden',
  );
});

test('cross-tenant negative scenarios: reseller boundary violations against foreign reseller and direct owner resources', async () => {
  const customers = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const customerLookup = async (id) => customers[id] ?? null;
  const middleware = createTenantBoundaryMiddleware({ customerLookup });

  const run = async (actor, url, method = 'GET', body = null) => {
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    let responseBody = null;
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  // 1. Reseller A attempts to access Reseller B's customer
  const foreignCust = await run(resellerA, '/api/customers/customer-b1');
  assert.equal(foreignCust.called, false);
  assert.equal(foreignCust.statusCode, 403);
  assert.equal(foreignCust.headers['Cache-Control'], 'no-store');
  assert.equal(foreignCust.responseBody.error.code, 'tenant_boundary_forbidden');

  // 2. Reseller A attempts to access direct Owner customer
  const directCust = await run(resellerA, '/api/customers/customer-direct');
  assert.equal(directCust.called, false);
  assert.equal(directCust.statusCode, 403);
  assert.equal(directCust.headers['Cache-Control'], 'no-store');
  assert.equal(directCust.responseBody.error.code, 'tenant_boundary_forbidden');

  // 3. Reseller A attempts to access Reseller B's website
  const foreignSite = await run(resellerA, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);
  assert.equal(foreignSite.headers['Cache-Control'], 'no-store');

  // 4. Reseller A attempts to access direct Owner website
  const directSite = await run(resellerA, '/api/websites/site-direct');
  assert.equal(directSite.called, false);
  assert.equal(directSite.statusCode, 403);
  assert.equal(directSite.headers['Cache-Control'], 'no-store');

  // 5. Reseller A attempts to access server website route for direct Owner site
  const directServerSite = await run(resellerA, '/api/servers/srv-1/websites/site-direct/files');
  assert.equal(directServerSite.called, false);
  assert.equal(directServerSite.statusCode, 403);

  // 6. Reseller A attempts to create domain on direct Owner website
  const directDomain = await run(resellerA, '/api/domains', 'POST', { websiteId: 'site-direct' });
  assert.equal(directDomain.called, false);
  assert.equal(directDomain.statusCode, 403);

  // 7. Reseller A attempts to create domain on foreign reseller website
  const foreignDomain = await run(resellerA, '/api/domains', 'POST', { websiteId: 'site-b1' });
  assert.equal(foreignDomain.called, false);
  assert.equal(foreignDomain.statusCode, 403);

  // 8. Reseller A attempts to query audit log for direct Owner customer
  const directAuditActor = await run(resellerA, '/api/audit?actorId=customer-direct');
  assert.equal(directAuditActor.called, false);
  assert.equal(directAuditActor.statusCode, 403);

  // 9. Reseller A attempts to query audit log for direct Owner website
  const directAuditSite = await run(resellerA, '/api/audit?resourceType=website&resourceId=site-direct');
  assert.equal(directAuditSite.called, false);
  assert.equal(directAuditSite.statusCode, 403);

  // 10. Reseller A attempts to query audit log for direct Owner customer resource
  const directAuditCust = await run(resellerA, '/api/audit?resourceType=customer&resourceId=customer-direct');
  assert.equal(directAuditCust.called, false);
  assert.equal(directAuditCust.statusCode, 403);

  // 11. Reseller A attempts to query audit log for Owner actor
  const ownerAuditActor = await run(resellerA, '/api/audit?actorId=owner-user');
  assert.equal(ownerAuditActor.called, false);
  assert.equal(ownerAuditActor.statusCode, 403);

  // 12. Reseller A attempts to query audit log for foreign Reseller actor
  const foreignResellerAudit = await run(resellerA, '/api/audit?actorId=reseller-b');
  assert.equal(foreignResellerAudit.called, false);
  assert.equal(foreignResellerAudit.statusCode, 403);

  // 13. Reseller A attempts to query audit log for foreign Reseller website
  const foreignSiteAudit = await run(resellerA, '/api/audit?resourceType=website&resourceId=site-b1');
  assert.equal(foreignSiteAudit.called, false);
  assert.equal(foreignSiteAudit.statusCode, 403);

  // 14. Reseller A attempts to query audit log for server resource
  const serverAudit = await run(resellerA, '/api/audit?resourceType=server&resourceId=srv-1');
  assert.equal(serverAudit.called, false);
  assert.equal(serverAudit.statusCode, 403);

  // 15. Terminal capability negative tests for Reseller
  const routeHandlers = {};
  const mockApp = { post: (path, guard, handler) => { routeHandlers[path] = { handler }; } };
  mountTerminalCapabilityRoutes(mockApp, {
    terminalCapabilityRegistry: { issue: () => ({}) },
    serverRegistry: { getServer: async () => ({ id: 'local-server' }) },
    websiteRegistry: {
      getWebsite: async (id) => ({
        id,
        serverId: 'local-server',
        runtimeType: 'node',
        unixUser: 'yunapp-112233445566',
        documentRoot: `/var/www/yunpanel/apps/${id}/current`,
      }),
    },
    localServerId: 'local-server',
  });

  // Reseller targeting direct Owner website
  await assert.rejects(
    routeHandlers['/api/terminal/capabilities'].handler(
      { body: { scope: 'site', websiteId: 'site-direct' }, auth: { id: 's-1', user: resellerA } },
      { status() { return this; }, json() { return this; } },
    ),
    (err) => err.status === 403 && err.code === 'terminal_site_forbidden',
  );

  // Reseller targeting foreign website
  await assert.rejects(
    routeHandlers['/api/terminal/capabilities'].handler(
      { body: { scope: 'site', websiteId: 'site-b1' }, auth: { id: 's-1', user: resellerA } },
      { status() { return this; }, json() { return this; } },
    ),
    (err) => err.status === 403 && err.code === 'terminal_site_forbidden',
  );

  // Reseller targeting server terminal
  await assert.rejects(
    routeHandlers['/api/terminal/capabilities'].handler(
      { body: { scope: 'server', serverId: 'local-server' }, auth: { id: 's-1', user: resellerA } },
      { status() { return this; }, json() { return this; } },
    ),
    (err) => err.status === 403 && err.code === 'terminal_server_forbidden',
  );
});

test('audit read negative scenarios: comprehensive multi-tenant event filtering preventing cross-tenant leakage', () => {
  const auditRecords = [
    { id: '1', actorId: 'owner-user', action: 'system.upgrade', resourceType: 'server', resourceId: 'srv-1' },
    { id: '2', actorId: 'reseller-a', action: 'hosting.customer.create', resourceType: 'customer', resourceId: 'customer-a1' },
    { id: '3', actorId: 'customer-a1', action: 'website.update', resourceType: 'website', resourceId: 'site-a1' },
    { id: '4', actorId: 'customer-a2', action: 'website.update', resourceType: 'website', resourceId: 'site-a2' },
    { id: '5', actorId: 'customer-b1', action: 'website.update', resourceType: 'website', resourceId: 'site-b1' },
    { id: '6', actorId: 'reseller-b', action: 'hosting.customer.create', resourceType: 'customer', resourceId: 'customer-b1' },
    { id: '7', actorId: 'customer-direct', action: 'website.update', resourceType: 'website', resourceId: 'site-direct' },
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
        listChildCustomerIds: (resellerId) => (resellerId === 'reseller-a' ? ['customer-a1', 'customer-a2'] : ['customer-b1']),
      },
    },
  };

  const jsonHelper = (res, status, payload) => {
    res.statusCode = status;
    res.body = payload;
    return payload;
  };

  // 1. Customer A1 reads audit: receives ONLY self event (site-a1 / customer-a1)
  const custA1Res = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: customerA1Actor } },
    response: custA1Res,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.equal(custA1Res.body.data.items.length, 1);
  assert.equal(custA1Res.body.data.items[0].id, '3');
  // Strict non-leakage assertions:
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '1'), false); // No Owner
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '2'), false); // No Reseller A
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '4'), false); // No Customer A2 (sibling!)
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '5'), false); // No Customer B1
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '6'), false); // No Reseller B
  assert.equal(custA1Res.body.data.items.some((i) => i.id === '7'), false); // No Customer Direct

  // 2. Customer A2 reads audit: receives ONLY self event (site-a2 / customer-a2)
  const custA2Res = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: customerA2Actor } },
    response: custA2Res,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.equal(custA2Res.body.data.items.length, 1);
  assert.equal(custA2Res.body.data.items[0].id, '4');
  assert.equal(custA2Res.body.data.items.some((i) => i.id === '3'), false); // Zero leakage of sibling Customer A1

  // 3. Reseller A reads audit: receives ONLY self and direct child customer events (2, 3, 4)
  const resellerRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: resellerA } },
    response: resellerRes,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.deepEqual(resellerRes.body.data.items.map((i) => i.id), ['2', '3', '4']);
  assert.equal(resellerRes.body.data.items.some((i) => i.id === '1'), false); // No Owner
  assert.equal(resellerRes.body.data.items.some((i) => i.id === '5'), false); // No Customer B1
  assert.equal(resellerRes.body.data.items.some((i) => i.id === '6'), false); // No Reseller B
  assert.equal(resellerRes.body.data.items.some((i) => i.id === '7'), false); // No Customer Direct

  // 4. Customer Direct reads audit: receives ONLY self event (7)
  const directCustRes = { setHeader() {} };
  handleAuditRead({
    request: { method: 'GET', auth: { user: customerDirectActor } },
    response: directCustRes,
    query: new URLSearchParams(),
    store: mockStore,
    json: jsonHelper,
  });
  assert.equal(directCustRes.body.data.items.length, 1);
  assert.equal(directCustRes.body.data.items[0].id, '7');

  // 5. Negative query parameters checks for Reseller A:
  // Querying direct owner customer actor
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ actorId: 'customer-direct' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Querying direct owner customer resource
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ resourceType: 'customer', resourceId: 'customer-direct' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Querying direct owner website resource
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ resourceType: 'website', resourceId: 'site-direct' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Querying foreign reseller actor
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ actorId: 'reseller-b' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Querying owner actor
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ actorId: 'owner-user' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Querying server resource
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: resellerA } },
      response: { setHeader() {} },
      query: new URLSearchParams({ resourceType: 'server', resourceId: 'srv-1' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Customer A1 querying sibling Customer A2
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: customerA1Actor } },
      response: { setHeader() {} },
      query: new URLSearchParams({ actorId: 'customer-a2' }),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // Inactive accounts querying audit
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: { ...resellerA, active: false } } },
      response: { setHeader() {} },
      query: new URLSearchParams(),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_actor_inactive',
  );
  assert.throws(
    () => handleAuditRead({
      request: { method: 'GET', auth: { user: { ...customerA1Actor, active: false } } },
      response: { setHeader() {} },
      query: new URLSearchParams(),
      store: mockStore,
      json: jsonHelper,
    }),
    (err) => err.status === 403 && err.code === 'tenant_actor_inactive',
  );
});

test('negative scenarios: response sanitization and information disclosure prevention across collections and errors', () => {
  const collection = [
    { id: 'site-a1', websiteId: 'site-a1', customerId: 'customer-a1', resellerId: 'reseller-a' },
    { id: 'site-a2', websiteId: 'site-a2', customerId: 'customer-a2', resellerId: 'reseller-a' },
    { id: 'site-b1', websiteId: 'site-b1', customerId: 'customer-b1', resellerId: 'reseller-b' },
    { id: 'site-direct', websiteId: 'site-direct', customerId: 'customer-direct', resellerId: null },
  ];

  // 1. Customer A1 sanitization: returns ONLY site-a1
  const custA1Filtered = sanitizeTenantCollection(collection, customerA1Actor);
  assert.deepEqual(custA1Filtered.map((i) => i.id), ['site-a1']);
  assert.equal(custA1Filtered.some((i) => i.id === 'site-a2'), false);
  assert.equal(custA1Filtered.some((i) => i.id === 'site-b1'), false);
  assert.equal(custA1Filtered.some((i) => i.id === 'site-direct'), false);

  // 2. Customer A2 sanitization: returns ONLY site-a2
  const custA2Filtered = sanitizeTenantCollection(collection, customerA2Actor);
  assert.deepEqual(custA2Filtered.map((i) => i.id), ['site-a2']);
  assert.equal(custA2Filtered.some((i) => i.id === 'site-a1'), false);

  // 3. Reseller A sanitization: returns ONLY site-a1 and site-a2
  const resellerFiltered = sanitizeTenantCollection(collection, resellerA);
  assert.deepEqual(resellerFiltered.map((i) => i.id), ['site-a1', 'site-a2']);
  assert.equal(resellerFiltered.some((i) => i.id === 'site-b1'), false);
  assert.equal(resellerFiltered.some((i) => i.id === 'site-direct'), false);

  // 4. Customer Direct sanitization: returns ONLY site-direct
  const directFiltered = sanitizeTenantCollection(collection, customerDirectActor);
  assert.deepEqual(directFiltered.map((i) => i.id), ['site-direct']);

  // 5. Inactive actor receives empty array
  assert.deepEqual(sanitizeTenantCollection(collection, { ...customerA1Actor, active: false }), []);
  assert.deepEqual(sanitizeTenantCollection(collection, { ...resellerA, active: false }), []);

  // 6. Non-array inputs safely return empty array
  assert.deepEqual(sanitizeTenantCollection(null, customerA1Actor), []);
  assert.deepEqual(sanitizeTenantCollection('invalid', customerA1Actor), []);

  // 7. Input array is not mutated
  assert.equal(collection.length, 4);

  // 8. assertEntityTenantBoundary error message disclosure prevention
  assert.throws(
    () => assertEntityTenantBoundary({
      actor: resellerA,
      entityType: 'customer',
      entityId: 'customer-b1',
      resellerId: 'reseller-b',
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'tenant_boundary_forbidden');
      assert.equal(error.message.includes('reseller-b'), false);
      assert.equal(error.message.includes('customer-b1'), false);
      return true;
    },
  );

  assert.throws(
    () => assertEntityTenantBoundary({
      actor: resellerA,
      entityType: 'website',
      websiteId: 'site-direct',
      customerId: 'customer-direct',
      resellerId: null,
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'tenant_boundary_forbidden');
      assert.equal(error.message.includes('customer-direct'), false);
      assert.equal(error.message.includes('site-direct'), false);
      return true;
    },
  );

  assert.throws(
    () => assertEntityTenantBoundary({
      actor: customerA1Actor,
      entityType: 'website',
      websiteId: 'site-a2',
      customerId: 'customer-a2',
    }),
    (error) => {
      assert.equal(error.status, 403);
      assert.equal(error.code, 'tenant_boundary_forbidden');
      assert.equal(error.message.includes('customer-a2'), false);
      assert.equal(error.message.includes('site-a2'), false);
      return true;
    },
  );
});

test('negative scenarios: permission boundaries for Plesk non-global roles fail-closed across all endpoints', async () => {
  const middleware = createTenantBoundaryMiddleware({});

  const run = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  const restrictedPaths = [
    { path: '/api/panel/settings', method: 'GET' },
    { path: '/api/settings', method: 'GET' },
    { path: '/api/settings/security', method: 'GET' },
    { path: '/api/system/packages', method: 'GET' },
    { path: '/api/system/upgrade', method: 'POST', body: {} },
    { path: '/api/servers/srv-1/services', method: 'GET' },
    { path: '/api/servers/srv-1/system/packages', method: 'GET' },
    { path: '/api/servers/srv-1/node-runtimes', method: 'GET' },
    { path: '/api/backups', method: 'GET' },
    { path: '/api/backups/repositories', method: 'GET' },
    { path: '/api/backups/remotes', method: 'GET' },
    { path: '/api/servers/srv-1/databases', method: 'GET' },
    { path: '/api/users', method: 'GET' },
    { path: '/api/websites', method: 'POST', body: { name: 'test' } },
    { path: '/api/applications', method: 'POST', body: { name: 'test' } },
    { path: '/api/sites', method: 'POST', body: { input: {} } },
    { path: '/api/sites/create-preview', method: 'POST', body: { input: {} } },
    { path: '/api/sites/hosted', method: 'POST', body: { customerId: 'c1', input: {} } },
    { path: '/api/sites/hosted/create-preview', method: 'POST', body: { customerId: 'c1', input: {} } },
    { path: '/api/sites/hosted/recover-reservation', method: 'POST', body: { customerId: 'c1', input: {} } },
    { path: '/api/sites/recover-reservation', method: 'POST', body: { customerId: 'c1', input: {} } },
  ];

  const testActors = [resellerA, customerA1Actor, legacySmActor];

  for (const actor of testActors) {
    for (const { path, method, body } of restrictedPaths) {
      const res = await run(actor, path, method, body);
      assert.equal(res.called, false, `Expected ${path} to be blocked for actor role ${actor.role}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.headers['Cache-Control'], 'no-store');
      assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    }
  }

  // Customer collection access: customer and legacy SM are blocked (403), reseller is permitted
  const custResForCustomer = await run(customerA1Actor, '/api/customers');
  assert.equal(custResForCustomer.called, false);
  assert.equal(custResForCustomer.statusCode, 403);

  const custResForLegacy = await run(legacySmActor, '/api/customers');
  assert.equal(custResForLegacy.called, false);
  assert.equal(custResForLegacy.statusCode, 403);

  const custResForReseller = await run(resellerA, '/api/customers');
  assert.equal(custResForReseller.called, true);
});

test('RS-03-05: reseller self-service site allocation, customer data isolation and tenant boundary enforcement', async () => {
  const customerDatabase = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };

  const middleware = createTenantBoundaryMiddleware({
    customerLookup: async (id) => customerDatabase[id] ?? null,
  });

  const run = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  // --- 1. Reseller Self-Service Site Allocation ---

  // 1a. Reseller A creates/previews hosted sites for own direct customer (customer-a1) -> allowed
  for (const path of [
    '/api/sites/hosted',
    '/api/sites/hosted/create-preview',
    '/api/sites/hosted/recover-reservation',
    '/api/sites',
    '/api/sites/create-preview',
    '/api/sites/recover-reservation',
  ]) {
    const res = await run(resellerA, path, 'POST', { customerId: 'customer-a1', input: { name: 'mysite' } });
    assert.equal(res.called, true, `Expected reseller to be permitted for hosted route ${path}`);
  }

  // 1b. Reseller A attempting hosted site allocation for another reseller's customer (customer-b1) -> 403
  for (const path of ['/api/sites/hosted', '/api/sites']) {
    const res = await run(resellerA, path, 'POST', { customerId: 'customer-b1', input: {} });
    assert.equal(res.called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    assert.equal(res.responseBody.error.message, 'This customer belongs to another reseller.');
  }

  // 1c. Reseller A attempting hosted site allocation for direct Owner customer -> 403
  for (const path of ['/api/sites/hosted', '/api/sites']) {
    const res = await run(resellerA, path, 'POST', { customerId: 'customer-direct', input: {} });
    assert.equal(res.called, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.responseBody.error.code, 'tenant_boundary_forbidden');
    assert.equal(res.responseBody.error.message, 'Direct Owner customers are outside reseller tenant boundary.');
  }

  // 1d. Reseller A attempting hosted site allocation for non-existent customer -> 404
  const notFoundRes = await run(resellerA, '/api/sites/hosted', 'POST', { customerId: 'unknown-customer', input: {} });
  assert.equal(notFoundRes.called, false);
  assert.equal(notFoundRes.statusCode, 404);
  assert.equal(notFoundRes.responseBody.error.code, 'customer_not_found');

  // 1e. Reseller A attempting unhosted site creation -> 403
  const unhostedSites = await run(resellerA, '/api/sites', 'POST', { input: { name: 'unhosted' } });
  assert.equal(unhostedSites.called, false);
  assert.equal(unhostedSites.statusCode, 403);
  assert.equal(unhostedSites.responseBody.error.code, 'tenant_boundary_forbidden');

  const unhostedWebsites = await run(resellerA, '/api/websites', 'POST', { name: 'test' });
  assert.equal(unhostedWebsites.called, false);
  assert.equal(unhostedWebsites.statusCode, 403);

  const unhostedApps = await run(resellerA, '/api/applications', 'POST', { name: 'test' });
  assert.equal(unhostedApps.called, false);
  assert.equal(unhostedApps.statusCode, 403);

  // 1f. Inactive Reseller is rejected -> 403 tenant_actor_inactive
  const inactiveReseller = { ...resellerA, active: false };
  const inactiveRes = await run(inactiveReseller, '/api/sites/hosted', 'POST', { customerId: 'customer-a1', input: {} });
  assert.equal(inactiveRes.called, false);
  assert.equal(inactiveRes.statusCode, 403);
  assert.equal(inactiveRes.responseBody.error.code, 'tenant_actor_inactive');

  // --- 2. Customer Self-Service & Data Isolation ---

  // 2a. Customer A1 attempting any site creation -> 403
  for (const path of ['/api/sites/hosted', '/api/sites', '/api/websites', '/api/applications']) {
    const custSiteRes = await run(customerA1Actor, path, 'POST', { customerId: 'customer-a1', input: {} });
    assert.equal(custSiteRes.called, false);
    assert.equal(custSiteRes.statusCode, 403);
    assert.equal(custSiteRes.responseBody.error.code, 'tenant_boundary_forbidden');
  }

  // 2b. Customer A1 attempting customer management -> 403
  const custColl = await run(customerA1Actor, '/api/customers');
  assert.equal(custColl.called, false);
  assert.equal(custColl.statusCode, 403);

  const foreignCust = await run(customerA1Actor, '/api/customers/customer-b1');
  assert.equal(foreignCust.called, false);
  assert.equal(foreignCust.statusCode, 403);
  assert.equal(foreignCust.responseBody.error.code, 'tenant_boundary_forbidden');

  // 2c. Customer A1 accessing own customer record -> allowed
  const ownCust = await run(customerA1Actor, '/api/customers/customer-a1');
  assert.equal(ownCust.called, true);

  // 2d. Customer A1 website and domain access
  const ownSite = await run(customerA1Actor, '/api/websites/site-a1');
  assert.equal(ownSite.called, true);

  const foreignSite = await run(customerA1Actor, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);

  const foreignServerSite = await run(customerA1Actor, '/api/servers/srv-1/websites/site-b1/files');
  assert.equal(foreignServerSite.called, false);
  assert.equal(foreignServerSite.statusCode, 403);

  const validDomain = await run(customerA1Actor, '/api/domains', 'POST', { websiteId: 'site-a1' });
  assert.equal(validDomain.called, true);

  const foreignDomain = await run(customerA1Actor, '/api/domains', 'POST', { websiteId: 'site-b1' });
  assert.equal(foreignDomain.called, false);
  assert.equal(foreignDomain.statusCode, 403);

  // 2e. Legacy site manager cannot allocate sites
  const smSiteRes = await run(legacySmActor, '/api/sites/hosted', 'POST', { customerId: 'customer-a1', input: {} });
  assert.equal(smSiteRes.called, false);
  assert.equal(smSiteRes.statusCode, 403);
});

test('RS-03-05: reseller with role: reseller accesses child customer websites and domains via customer relationships', async () => {
  const customerDatabase = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const websiteDatabase = {
    'site-a1': { id: 'site-a1', customerId: 'customer-a1' },
    'site-a2': { id: 'site-a2', customerId: 'customer-a2' },
    'site-b1': { id: 'site-b1', customerId: 'customer-b1' },
    'site-direct': { id: 'site-direct', customerId: 'customer-direct' },
  };

  const middleware = createTenantBoundaryMiddleware({
    customerLookup: async (id) => customerDatabase[id] ?? null,
    websiteLookup: async (id) => websiteDatabase[id] ?? null,
  });

  const run = async (actor, url, method = 'GET', body = null) => {
    let statusCode = 200;
    let responseBody = null;
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    let called = false;
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  // Reseller actor with role: 'reseller' and NO direct websiteIds on user session
  const directResellerActor = Object.freeze({
    id: 'reseller-a',
    role: 'reseller',
    active: true,
  });

  // 1. Reseller accessing child customer websites -> allowed
  const ownSite1 = await run(directResellerActor, '/api/websites/site-a1');
  assert.equal(ownSite1.called, true);

  const ownSite2 = await run(directResellerActor, '/api/websites/site-a2');
  assert.equal(ownSite2.called, true);

  const ownServerSite = await run(directResellerActor, '/api/servers/srv-1/websites/site-a1');
  assert.equal(ownServerSite.called, true);

  // 2. Reseller accessing foreign customer website -> 403
  const foreignSite = await run(directResellerActor, '/api/websites/site-b1');
  assert.equal(foreignSite.called, false);
  assert.equal(foreignSite.statusCode, 403);
  assert.equal(foreignSite.responseBody.error.code, 'tenant_boundary_forbidden');

  // 3. Reseller accessing direct Owner customer website -> 403
  const directSite = await run(directResellerActor, '/api/websites/site-direct');
  assert.equal(directSite.called, false);
  assert.equal(directSite.statusCode, 403);
  assert.equal(directSite.responseBody.error.code, 'tenant_boundary_forbidden');

  // 4. Reseller creating domain for child customer website -> allowed
  const ownDomain = await run(directResellerActor, '/api/domains', 'POST', { websiteId: 'site-a1' });
  assert.equal(ownDomain.called, true);

  // 5. Reseller creating domain for foreign customer website -> 403
  const foreignDomain = await run(directResellerActor, '/api/domains', 'POST', { websiteId: 'site-b1' });
  assert.equal(foreignDomain.called, false);
  assert.equal(foreignDomain.statusCode, 403);
  assert.equal(foreignDomain.responseBody.error.code, 'tenant_boundary_forbidden');

  // 6. Reseller creating domain for direct Owner customer website -> 403
  const directDomain = await run(directResellerActor, '/api/domains', 'POST', { websiteId: 'site-direct' });
  assert.equal(directDomain.called, false);
  assert.equal(directDomain.statusCode, 403);
  assert.equal(directDomain.responseBody.error.code, 'tenant_boundary_forbidden');

  // 7. Audit query for child customer website -> allowed
  const ownAuditSite = await run(directResellerActor, '/api/audit?resourceType=website&resourceId=site-a1');
  assert.equal(ownAuditSite.called, true);

  // 8. Audit query for foreign customer website -> 403
  const foreignAuditSite = await run(directResellerActor, '/api/audit?resourceType=website&resourceId=site-b1');
  assert.equal(foreignAuditSite.called, false);
  assert.equal(foreignAuditSite.statusCode, 403);
});

test('RS-03-05: website-http and core-app enforce tenant boundary for reseller on websites and domains', async () => {
  const customerDatabase = {
    'customer-a1': customerA1,
    'customer-a2': customerA2,
    'customer-b1': customerB1,
    'customer-direct': customerDirect,
  };
  const allWebsites = [
    { id: 'site-a1', serverId: 'server-1', customerId: 'customer-a1', name: 'Site A1' },
    { id: 'site-a2', serverId: 'server-1', customerId: 'customer-a2', name: 'Site A2' },
    { id: 'site-b1', serverId: 'server-1', customerId: 'customer-b1', name: 'Site B1' },
    { id: 'site-direct', serverId: 'server-1', customerId: 'customer-direct', name: 'Site Direct' },
  ];
  const allDomains = [
    { id: 'domain-a1', serverId: 'server-1', websiteId: 'site-a1', primaryDomain: 'a1.example.com' },
    { id: 'domain-a2', serverId: 'server-1', websiteId: 'site-a2', primaryDomain: 'a2.example.com' },
    { id: 'domain-b1', serverId: 'server-1', websiteId: 'site-b1', primaryDomain: 'b1.example.com' },
    { id: 'domain-direct', serverId: 'server-1', websiteId: 'site-direct', primaryDomain: 'direct.example.com' },
  ];

  const websiteRegistry = {
    listWebsites: async () => [...allWebsites],
    getWebsite: async (id) => allWebsites.find((w) => w.id === id) ?? null,
    createWebsite: async (data) => ({ id: 'new-site', ...data }),
    previewWebsiteUpdate: async () => ({}),
    updateWebsite: async () => ({}),
  };
  const domainRegistry = {
    listDomains: async () => [...allDomains],
    getDomain: async (id) => allDomains.find((d) => d.id === id) ?? null,
    createDomain: async (data) => ({ id: 'new-domain', ...data }),
  };

  const fakeAppInstance = () => {
    const routes = { get: new Map(), post: new Map(), patch: new Map() };
    return {
      routes,
      get(path, ...handlers) { routes.get.set(path, handlers.at(-1)); },
      post(path, ...handlers) { routes.post.set(path, handlers.at(-1)); },
      patch(path, ...handlers) { routes.patch.set(path, handlers.at(-1)); },
    };
  };
  const invokeFake = async (handler, req) => {
    let statusCode = 200;
    let responseBody = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { responseBody = b; return this; },
    };
    await handler(req, res, (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
      }
    });
    return { statusCode, responseBody };
  };

  const app = fakeAppInstance();
  mountWebsiteRoutes(app, {
    websiteRegistry,
    domainRegistry,
    localServerId: 'server-1',
    customerLookup: async (id) => customerDatabase[id] ?? null,
  });

  const resellerActor = {
    id: '32345678-1234-4234-8234-123456789012',
    user: {
      id: 'reseller-a',
      role: 'reseller',
      hosting: { kind: 'reseller', resellerId: null },
      websiteIds: ['site-a1', 'site-a2'],
      active: true,
    },
    access: {
      mode: 'site_management',
      permissions: ['site_management'],
    },
    security: {
      managementAllowed: true,
    },
  };

  // 1. GET /api/websites returns only child customer websites for reseller
  const getWebsitesHandler = app.routes.get.get('/api/websites');
  const websitesRes = await invokeFake(getWebsitesHandler, { auth: resellerActor, query: {} });
  assert.equal(websitesRes.statusCode, 200);
  const returnedWebsiteIds = websitesRes.responseBody.data.map((w) => w.id);
  assert.deepEqual(returnedWebsiteIds.sort(), ['site-a1', 'site-a2']);
  assert.equal(returnedWebsiteIds.includes('site-b1'), false);
  assert.equal(returnedWebsiteIds.includes('site-direct'), false);

  // 1b. Customer A1 GET /api/websites returns only attached website
  const custWebsitesRes = await invokeFake(getWebsitesHandler, { auth: { user: customerA1Actor }, query: {} });
  assert.equal(custWebsitesRes.statusCode, 200);
  assert.deepEqual(custWebsitesRes.responseBody.data.map((w) => w.id), ['site-a1']);

  // 1c. Customer Direct GET /api/websites returns only direct owner website
  const directCustWebsitesRes = await invokeFake(getWebsitesHandler, { auth: { user: customerDirectActor }, query: {} });
  assert.equal(directCustWebsitesRes.statusCode, 200);
  assert.deepEqual(directCustWebsitesRes.responseBody.data.map((w) => w.id), ['site-direct']);

  // 1d. Reseller B GET /api/websites returns only Reseller B child site
  const resBWebsitesRes = await invokeFake(getWebsitesHandler, { auth: { user: resellerB }, query: {} });
  assert.equal(resBWebsitesRes.statusCode, 200);
  assert.deepEqual(resBWebsitesRes.responseBody.data.map((w) => w.id), ['site-b1']);

  // 1e. Owner GET /api/websites returns all websites
  const ownerWebsitesRes = await invokeFake(getWebsitesHandler, { auth: { user: owner }, query: {} });
  assert.equal(ownerWebsitesRes.statusCode, 200);
  assert.equal(ownerWebsitesRes.responseBody.data.length, 4);

  // 1f. Inactive customer GET /api/websites returns empty
  const inactiveCustWebsitesRes = await invokeFake(getWebsitesHandler, { auth: { user: { ...customerA1Actor, active: false } }, query: {} });
  assert.equal(inactiveCustWebsitesRes.statusCode, 200);
  assert.deepEqual(inactiveCustWebsitesRes.responseBody.data, []);

  // 2. GET /api/websites/:websiteId allows own child site, rejects foreign and direct sites
  const getSingleWebsiteHandler = app.routes.get.get('/api/websites/:websiteId');
  const ownSiteRes = await invokeFake(getSingleWebsiteHandler, { auth: resellerActor, params: { websiteId: 'site-a1' } });
  assert.equal(ownSiteRes.statusCode, 200);
  assert.equal(ownSiteRes.responseBody.data.id, 'site-a1');

  const foreignSiteRes = await invokeFake(getSingleWebsiteHandler, { auth: resellerActor, params: { websiteId: 'site-b1' } });
  assert.equal(foreignSiteRes.statusCode, 403);
  assert.equal(foreignSiteRes.responseBody.error.code, 'forbidden');

  const directSiteRes = await invokeFake(getSingleWebsiteHandler, { auth: resellerActor, params: { websiteId: 'site-direct' } });
  assert.equal(directSiteRes.statusCode, 403);
  assert.equal(directSiteRes.responseBody.error.code, 'forbidden');

  // 2b. Customer single website and domains route access
  const custOwnSite = await invokeFake(getSingleWebsiteHandler, { auth: { user: customerA1Actor }, params: { websiteId: 'site-a1' } });
  assert.equal(custOwnSite.statusCode, 200);
  assert.equal(custOwnSite.responseBody.data.id, 'site-a1');

  const custSiblingSite = await invokeFake(getSingleWebsiteHandler, { auth: { user: customerA1Actor }, params: { websiteId: 'site-a2' } });
  assert.equal(custSiblingSite.statusCode, 403);
  assert.equal(custSiblingSite.responseBody.error.code, 'forbidden');

  const custForeignSite = await invokeFake(getSingleWebsiteHandler, { auth: { user: customerA1Actor }, params: { websiteId: 'site-b1' } });
  assert.equal(custForeignSite.statusCode, 403);

  const getWebsiteDomainsHandler = app.routes.get.get('/api/websites/:websiteId/domains');
  const custOwnDomains = await invokeFake(getWebsiteDomainsHandler, { auth: { user: customerA1Actor }, params: { websiteId: 'site-a1' } });
  assert.equal(custOwnDomains.statusCode, 200);
  assert.deepEqual(custOwnDomains.responseBody.data.map((d) => d.id), ['domain-a1']);

  const custForeignDomains = await invokeFake(getWebsiteDomainsHandler, { auth: { user: customerA1Actor }, params: { websiteId: 'site-b1' } });
  assert.equal(custForeignDomains.statusCode, 403);

  // 3. Core app domain isolation: GET /api/domains and requireDomain
  const coreApp = createApp({
    localServerId: 'server-1',
    domainRegistry,
    websiteRegistry,
    customerLookup: async (id) => customerDatabase[id] ?? null,
  });

  const requestExpress = (core, { method = 'GET', url = '/', body = null, auth = null }) => {
    return new Promise((resolve) => {
      const u = new URL(url, 'http://panel.internal');
      const req = {
        method,
        url,
        originalUrl: url,
        headers: { host: 'panel.internal', 'content-type': 'application/json' },
        body,
        auth,
        query: Object.fromEntries(u.searchParams),
        params: {},
      };
      let statusCode = 200;
      let responsePayload = null;
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader() {},
        status(code) { statusCode = code; this.statusCode = code; return this; },
        json(payload) { responsePayload = payload; resolve({ statusCode, body: payload }); return this; },
        end() { resolve({ statusCode, body: responsePayload }); return this; },
      };
      core.handle(req, res, (err) => {
        if (err) {
          resolve({ statusCode: err.status || 500, body: { error: { code: err.code, message: err.message } } });
        } else {
          resolve({ statusCode: 404, body: null });
        }
      });
    });
  };

  // GET /api/domains returns only reseller's child customer domains
  const domainsRes = await requestExpress(coreApp, { url: '/api/domains', auth: resellerActor });
  assert.equal(domainsRes.statusCode, 200);
  const returnedDomainIds = domainsRes.body.data.map((d) => d.id);
  assert.deepEqual(returnedDomainIds.sort(), ['domain-a1', 'domain-a2']);
  assert.equal(returnedDomainIds.includes('domain-b1'), false);
  assert.equal(returnedDomainIds.includes('domain-direct'), false);

  // GET /api/domains/:domainId: own allowed, foreign & direct 403
  const ownDomainRes = await requestExpress(coreApp, { url: '/api/domains/domain-a1', auth: resellerActor });
  assert.equal(ownDomainRes.statusCode, 200);
  assert.equal(ownDomainRes.body.data.id, 'domain-a1');

  const foreignDomainRes = await requestExpress(coreApp, { url: '/api/domains/domain-b1', auth: resellerActor });
  assert.equal(foreignDomainRes.statusCode, 403);
  assert.equal(foreignDomainRes.body.error.code, 'forbidden');

  const directDomainRes = await requestExpress(coreApp, { url: '/api/domains/domain-direct', auth: resellerActor });
  assert.equal(directDomainRes.statusCode, 403);
  assert.equal(directDomainRes.body.error.code, 'forbidden');

  // POST /api/domains: cross-reseller blocked, direct owner blocked, own allowed
  const postForeignRes = await requestExpress(coreApp, {
    method: 'POST',
    url: '/api/domains',
    auth: resellerActor,
    body: { websiteId: 'site-b1', primaryDomain: 'new.b1.com' },
  });
  assert.equal(postForeignRes.statusCode, 403);
  assert.equal(postForeignRes.body.error.code, 'forbidden');

  const postDirectRes = await requestExpress(coreApp, {
    method: 'POST',
    url: '/api/domains',
    auth: resellerActor,
    body: { websiteId: 'site-direct', primaryDomain: 'new.direct.com' },
  });
  assert.equal(postDirectRes.statusCode, 403);
  assert.equal(postDirectRes.body.error.code, 'forbidden');

  const postOwnRes = await requestExpress(coreApp, {
    method: 'POST',
    url: '/api/domains',
    auth: resellerActor,
    body: { websiteId: 'site-a1', primaryDomain: 'new.a1.com' },
  });
  assert.equal(postOwnRes.statusCode, 201);
  assert.equal(postOwnRes.body.data.primaryDomain, 'new.a1.com');
});

test('multi-tenant topology (Owner, 2 Resellers, 4 Customers, 1 Direct Owner Customer) full isolation and fail-closed validation', async () => {
  // Test matrix entities
  const ownerUser = Object.freeze({ id: 'matrix-owner', role: 'owner', active: true });

  const reseller1User = Object.freeze({
    id: 'reseller-1',
    role: 'reseller',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-1a', 'site-1b'],
  });

  const reseller2User = Object.freeze({
    id: 'reseller-2',
    role: 'reseller',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-2a', 'site-2b'],
  });

  const customer1A = Object.freeze({
    id: 'customer-1a',
    kind: 'customer',
    resellerId: 'reseller-1',
    active: true,
  });

  const customer1B = Object.freeze({
    id: 'customer-1b',
    kind: 'customer',
    resellerId: 'reseller-1',
    active: true,
  });

  const customer2A = Object.freeze({
    id: 'customer-2a',
    kind: 'customer',
    resellerId: 'reseller-2',
    active: true,
  });

  const customer2B = Object.freeze({
    id: 'customer-2b',
    kind: 'customer',
    resellerId: 'reseller-2',
    active: true,
  });

  const customerDirectRecord = Object.freeze({
    id: 'customer-direct',
    kind: 'customer',
    resellerId: null,
    active: true,
  });

  const customer1AActor = Object.freeze({
    id: 'customer-1a',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    active: true,
    websiteIds: ['site-1a'],
  });

  const customer1BActor = Object.freeze({
    id: 'customer-1b',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    active: true,
    websiteIds: ['site-1b'],
  });

  const customer2AActor = Object.freeze({
    id: 'customer-2a',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-2' },
    active: true,
    websiteIds: ['site-2a'],
  });

  const customer2BActor = Object.freeze({
    id: 'customer-2b',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: 'reseller-2' },
    active: true,
    websiteIds: ['site-2b'],
  });

  const customerDirectActorObj = Object.freeze({
    id: 'customer-direct',
    role: 'customer',
    hosting: { kind: 'customer', resellerId: null },
    active: true,
    websiteIds: ['site-direct'],
  });

  const site1A = Object.freeze({ id: 'site-1a', customerId: 'customer-1a', resellerId: 'reseller-1', serverId: 'srv-1', name: 'Site 1A' });
  const site1B = Object.freeze({ id: 'site-1b', customerId: 'customer-1b', resellerId: 'reseller-1', serverId: 'srv-1', name: 'Site 1B' });
  const site2A = Object.freeze({ id: 'site-2a', customerId: 'customer-2a', resellerId: 'reseller-2', serverId: 'srv-1', name: 'Site 2A' });
  const site2B = Object.freeze({ id: 'site-2b', customerId: 'customer-2b', resellerId: 'reseller-2', serverId: 'srv-1', name: 'Site 2B' });
  const siteDirectRecord = Object.freeze({ id: 'site-direct', customerId: 'customer-direct', resellerId: null, serverId: 'srv-1', name: 'Site Direct' });

  const customerMap = {
    'customer-1a': customer1A,
    'customer-1b': customer1B,
    'customer-2a': customer2A,
    'customer-2b': customer2B,
    'customer-direct': customerDirectRecord,
  };

  const websiteMap = {
    'site-1a': site1A,
    'site-1b': site1B,
    'site-2a': site2A,
    'site-2b': site2B,
    'site-direct': siteDirectRecord,
  };

  // 1. assertCustomerBelongsToReseller
  // Owner can manage all
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: ownerUser, customer: customer1A }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: ownerUser, customer: customer1B }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: ownerUser, customer: customer2A }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: ownerUser, customer: customer2B }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: ownerUser, customer: customerDirectRecord }));

  // Reseller 1 manages own child customers (1A, 1B)
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: reseller1User, customer: customer1A }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: reseller1User, customer: customer1B }));

  // Reseller 1 CANNOT manage Reseller 2 customers (2A, 2B) or Direct Owner customer
  for (const c of [customer2A, customer2B, customerDirectRecord]) {
    assert.throws(
      () => assertCustomerBelongsToReseller({ actor: reseller1User, customer: c }),
      (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
    );
  }

  // Reseller 2 manages own child customers (2A, 2B)
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: reseller2User, customer: customer2A }));
  assert.doesNotThrow(() => assertCustomerBelongsToReseller({ actor: reseller2User, customer: customer2B }));

  // Reseller 2 CANNOT manage Reseller 1 customers (1A, 1B) or Direct Owner customer
  for (const c of [customer1A, customer1B, customerDirectRecord]) {
    assert.throws(
      () => assertCustomerBelongsToReseller({ actor: reseller2User, customer: c }),
      (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
    );
  }

  // Customers cannot manage any customer accounts
  for (const actor of [customer1AActor, customer1BActor, customer2AActor, customer2BActor, customerDirectActorObj]) {
    assert.throws(
      () => assertCustomerBelongsToReseller({ actor, customer: customer1A }),
      (err) => err.status === 403,
    );
  }

  // 2. assertWebsiteBelongsToTenant
  // Owner allowed on all 5 sites
  for (const w of [site1A, site1B, site2A, site2B, siteDirectRecord]) {
    assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: ownerUser, website: w }));
  }

  // Customer 1A: only site-1a
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: customer1AActor, website: site1A }));
  for (const w of [site1B, site2A, site2B, siteDirectRecord]) {
    assert.throws(
      () => assertWebsiteBelongsToTenant({ actor: customer1AActor, website: w }),
      (err) => err.status === 403,
    );
  }

  // Customer 1B: only site-1b
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: customer1BActor, website: site1B }));
  for (const w of [site1A, site2A, site2B, siteDirectRecord]) {
    assert.throws(
      () => assertWebsiteBelongsToTenant({ actor: customer1BActor, website: w }),
      (err) => err.status === 403,
    );
  }

  // Customer Direct: only site-direct
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: customerDirectActorObj, website: siteDirectRecord }));
  for (const w of [site1A, site1B, site2A, site2B]) {
    assert.throws(
      () => assertWebsiteBelongsToTenant({ actor: customerDirectActorObj, website: w }),
      (err) => err.status === 403,
    );
  }

  // Reseller 1: site-1a and site-1b allowed; site-2a, site-2b, site-direct DENIED
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: reseller1User, website: site1A, customer: customer1A }));
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: reseller1User, website: site1B, customer: customer1B }));
  for (const w of [site2A, site2B, siteDirectRecord]) {
    assert.throws(
      () => assertWebsiteBelongsToTenant({ actor: reseller1User, website: w, customer: customerMap[w.customerId] }),
      (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
    );
  }

  // Reseller 2: site-2a and site-2b allowed; site-1a, site-1b, site-direct DENIED
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: reseller2User, website: site2A, customer: customer2A }));
  assert.doesNotThrow(() => assertWebsiteBelongsToTenant({ actor: reseller2User, website: site2B, customer: customer2B }));
  for (const w of [site1A, site1B, siteDirectRecord]) {
    assert.throws(
      () => assertWebsiteBelongsToTenant({ actor: reseller2User, website: w, customer: customerMap[w.customerId] }),
      (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
    );
  }

  // 3. assertEntityTenantBoundary
  // Reseller 1 accessing direct Owner entity (resellerId === null) -> 403
  assert.throws(
    () => assertEntityTenantBoundary({ actor: reseller1User, entityType: 'domain', websiteId: 'site-direct', resellerId: null }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );
  // Reseller 1 accessing Reseller 2 entity -> 403
  assert.throws(
    () => assertEntityTenantBoundary({ actor: reseller1User, entityType: 'domain', websiteId: 'site-2a', resellerId: 'reseller-2' }),
    (err) => err.status === 403 && err.code === 'tenant_boundary_forbidden',
  );

  // 4. sanitizeTenantCollection
  const allItems = [
    { id: 'site-1a', websiteId: 'site-1a', customerId: 'customer-1a', resellerId: 'reseller-1' },
    { id: 'site-1b', websiteId: 'site-1b', customerId: 'customer-1b', resellerId: 'reseller-1' },
    { id: 'site-2a', websiteId: 'site-2a', customerId: 'customer-2a', resellerId: 'reseller-2' },
    { id: 'site-2b', websiteId: 'site-2b', customerId: 'customer-2b', resellerId: 'reseller-2' },
    { id: 'site-direct', websiteId: 'site-direct', customerId: 'customer-direct', resellerId: null },
  ];
  assert.equal(sanitizeTenantCollection(allItems, ownerUser).length, 5);
  assert.deepEqual(sanitizeTenantCollection(allItems, reseller1User).map((i) => i.id).sort(), ['site-1a', 'site-1b']);
  assert.deepEqual(sanitizeTenantCollection(allItems, reseller2User).map((i) => i.id).sort(), ['site-2a', 'site-2b']);
  assert.deepEqual(sanitizeTenantCollection(allItems, customer1AActor).map((i) => i.id), ['site-1a']);
  assert.deepEqual(sanitizeTenantCollection(allItems, customer1BActor).map((i) => i.id), ['site-1b']);
  assert.deepEqual(sanitizeTenantCollection(allItems, customerDirectActorObj).map((i) => i.id), ['site-direct']);

  // 5. createTenantBoundaryMiddleware HTTP enforcement
  const middleware = createTenantBoundaryMiddleware({
    customerLookup: async (id) => customerMap[id] ?? null,
    websiteLookup: async (id) => websiteMap[id] ?? null,
  });

  const runHttp = async (actor, url, { method = 'GET', body = null } = {}) => {
    const req = { url, originalUrl: url, method, body, auth: { user: actor } };
    let called = false;
    let statusCode = 200;
    let responseBody = null;
    const headers = {};
    const res = {
      status(c) { statusCode = c; return this; },
      setHeader(k, v) { headers[k] = v; },
      json(b) { responseBody = b; return this; },
    };
    await middleware(req, res, () => { called = true; });
    return { called, statusCode, responseBody, headers };
  };

  const assertHttpDeniedNoLeak = (result, forbiddenTokens = []) => {
    assert.equal(result.called, false);
    assert.ok(result.statusCode === 403 || result.statusCode === 404);
    assert.equal(result.headers['Cache-Control'], 'no-store');
    const bodyStr = JSON.stringify(result.responseBody ?? {});
    for (const token of forbiddenTokens) {
      assert.equal(bodyStr.includes(token), false, `Response leaked sensitive metadata: ${token}`);
    }
  };

  // Test Customer 1A:
  // - Own site allowed
  const ownReq = await runHttp(customer1AActor, '/api/websites/site-1a');
  assert.equal(ownReq.called, true);
  assert.equal((await runHttp(customer1AActor, '/api/servers/srv-1/websites/site-1a')).called, true);

  // - All 14 resource endpoints with foreign / unauthorized Website IDs rejected with 403/404 and NO metadata leakage:
  const foreignWebsiteIds = ['site-1b', 'site-2a', 'site-2b', 'site-direct', 'site-non-existent'];
  const leakTokens = ['site-1b', 'site-2a', 'site-2b', 'site-direct', 'customer-1b', 'customer-2a', 'customer-direct', 'reseller-2'];

  for (const foreignId of foreignWebsiteIds) {
    // 1. Website
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/domains`), leakTokens);

    // 2. Files
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/files?path=`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/files?path=`), leakTokens);

    // 3. DB
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/database-resources`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/phpmyadmin-handoffs`, { method: 'POST', body: {} }), leakTokens);

    // 4. Mail
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/mail`), leakTokens);

    // 5. DNS (Domain creation with foreign websiteId)
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, '/api/domains', { method: 'POST', body: { websiteId: foreignId } }), leakTokens);

    // 6. Job (Audit for foreign website)
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/audit?resourceType=website&resourceId=${foreignId}`), leakTokens);

    // 7. Log
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/logs`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/logs`), leakTokens);

    // 8. Backup
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/backups`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/backups`), leakTokens);

    // 9. Analytics
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/analytics/status`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/analytics`), leakTokens);

    // 10. PHP
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/wp-cli/status`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/wp-cli/status`), leakTokens);

    // 11. Cron
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/crons`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/crons`), leakTokens);

    // 12. SFTP
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/sftp/keys`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/sftp/keys`), leakTokens);

    // 13. elFinder
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/elfinder-handoffs`, { method: 'POST' }), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/elfinder-handoffs`, { method: 'POST' }), leakTokens);

    // 14. Terminal
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, '/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: foreignId },
    }), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/websites/${foreignId}/terminal`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customer1AActor, `/api/servers/srv-1/websites/${foreignId}/terminal`), leakTokens);
  }

  // Root terminal denied for non-owner
  assertHttpDeniedNoLeak(await runHttp(customer1AActor, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'server', serverId: 'srv-1' } }));
  assertHttpDeniedNoLeak(await runHttp(reseller1User, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'server', serverId: 'srv-1' } }));

  // Test Reseller 1 permissions and boundaries:
  // - Allowed on own child customer sites: site-1a, site-1b
  assert.equal((await runHttp(reseller1User, '/api/websites/site-1a')).called, true);
  assert.equal((await runHttp(reseller1User, '/api/websites/site-1b')).called, true);
  assert.equal((await runHttp(reseller1User, '/api/servers/srv-1/websites/site-1a')).called, true);
  assert.equal((await runHttp(reseller1User, '/api/servers/srv-1/websites/site-1b')).called, true);
  assert.equal((await runHttp(reseller1User, '/api/domains', { method: 'POST', body: { websiteId: 'site-1a' } })).called, true);
  assert.equal((await runHttp(reseller1User, '/api/domains', { method: 'POST', body: { websiteId: 'site-1b' } })).called, true);
  assert.equal((await runHttp(reseller1User, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'site', websiteId: 'site-1a' } })).called, true);
  assert.equal((await runHttp(reseller1User, '/api/terminal/capabilities', { method: 'POST', body: { scope: 'site', websiteId: 'site-1b' } })).called, true);

  // - DENIED on Reseller 2 sites (site-2a, site-2b) and Direct Owner site (site-direct) across all resource types:
  const resellerForeignIds = ['site-2a', 'site-2b', 'site-direct', 'site-non-existent'];
  const resellerLeakTokens = ['site-2a', 'site-2b', 'site-direct', 'customer-2a', 'customer-2b', 'customer-direct', 'reseller-2'];

  for (const foreignId of resellerForeignIds) {
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/servers/srv-1/websites/${foreignId}`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/files?path=`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/servers/srv-1/websites/${foreignId}/files?path=`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/servers/srv-1/websites/${foreignId}/database-resources`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/domains`, { method: 'POST', body: { websiteId: foreignId } }), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/audit?resourceType=website&resourceId=${foreignId}`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/backups`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/analytics/status`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/wp-cli/status`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/crons`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/websites/${foreignId}/sftp/keys`), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, `/api/servers/srv-1/websites/${foreignId}/elfinder-handoffs`, { method: 'POST' }), resellerLeakTokens);
    assertHttpDeniedNoLeak(await runHttp(reseller1User, '/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: foreignId },
    }), resellerLeakTokens);
  }

  // - Direct Owner customer denied on Reseller 1 and Reseller 2 sites
  for (const foreignId of ['site-1a', 'site-1b', 'site-2a', 'site-2b']) {
    assertHttpDeniedNoLeak(await runHttp(customerDirectActorObj, `/api/websites/${foreignId}`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customerDirectActorObj, `/api/servers/srv-1/websites/${foreignId}`), leakTokens);
    assertHttpDeniedNoLeak(await runHttp(customerDirectActorObj, '/api/terminal/capabilities', {
      method: 'POST',
      body: { scope: 'site', websiteId: foreignId },
    }), leakTokens);
  }

  // 6. mountWebsiteRoutes collection filtering and concrete route isolation verification
  const fakeApp = () => {
    const routes = { get: new Map(), post: new Map(), patch: new Map() };
    return {
      routes,
      get(path, ...handlers) { routes.get.set(path, handlers.at(-1)); },
      post(path, ...handlers) { routes.post.set(path, handlers.at(-1)); },
      patch(path, ...handlers) { routes.patch.set(path, handlers.at(-1)); },
    };
  };
  const invokeHandler = async (handler, req) => {
    let statusCode = 200;
    let responseBody = null;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { responseBody = b; return this; },
    };
    await handler(req, res, (err) => {
      if (err) {
        statusCode = err.status || 500;
        responseBody = { error: { code: err.code, message: err.message } };
      }
    });
    return { statusCode, responseBody };
  };

  const matrixApp = fakeApp();
  const allMatrixWebsites = [site1A, site1B, site2A, site2B, siteDirectRecord];
  const matrixWebsiteRegistry = {
    listWebsites: async (filter = {}) => {
      if (filter.serverId) {
        return allMatrixWebsites.filter((w) => w.serverId === filter.serverId);
      }
      return [...allMatrixWebsites];
    },
    getWebsite: async (id) => allMatrixWebsites.find((w) => w.id === id) ?? null,
    createWebsite: async (data) => ({ id: 'new-site', ...data }),
    previewWebsiteUpdate: async () => ({}),
    updateWebsite: async () => ({}),
  };
  const matrixDomainRegistry = {
    listDomains: async () => [],
    getDomain: async () => null,
  };

  mountWebsiteRoutes(matrixApp, {
    websiteRegistry: matrixWebsiteRegistry,
    domainRegistry: matrixDomainRegistry,
    localServerId: 'srv-1',
    customerLookup: async (id) => customerMap[id] ?? null,
  });

  const getWebsitesHandler = matrixApp.routes.get.get('/api/websites');
  const getSingleWebsiteHandler = matrixApp.routes.get.get('/api/websites/:websiteId');

  // Owner GET /api/websites returns all 5 sites
  const ownerListRes = await invokeHandler(getWebsitesHandler, { auth: { user: ownerUser }, query: {} });
  assert.equal(ownerListRes.statusCode, 200);
  assert.equal(ownerListRes.responseBody.data.length, 5);

  // Reseller 1 GET /api/websites returns only site-1a, site-1b
  const res1ListRes = await invokeHandler(getWebsitesHandler, { auth: { user: reseller1User }, query: {} });
  assert.equal(res1ListRes.statusCode, 200);
  assert.deepEqual(res1ListRes.responseBody.data.map((w) => w.id).sort(), ['site-1a', 'site-1b']);

  // Reseller 2 GET /api/websites returns only site-2a, site-2b
  const res2ListRes = await invokeHandler(getWebsitesHandler, { auth: { user: reseller2User }, query: {} });
  assert.equal(res2ListRes.statusCode, 200);
  assert.deepEqual(res2ListRes.responseBody.data.map((w) => w.id).sort(), ['site-2a', 'site-2b']);

  // Customer 1A GET /api/websites returns only site-1a
  const cust1AListRes = await invokeHandler(getWebsitesHandler, { auth: { user: customer1AActor }, query: {} });
  assert.equal(cust1AListRes.statusCode, 200);
  assert.deepEqual(cust1AListRes.responseBody.data.map((w) => w.id), ['site-1a']);

  // Customer 1B GET /api/websites returns only site-1b
  const cust1BListRes = await invokeHandler(getWebsitesHandler, { auth: { user: customer1BActor }, query: {} });
  assert.equal(cust1BListRes.statusCode, 200);
  assert.deepEqual(cust1BListRes.responseBody.data.map((w) => w.id), ['site-1b']);

  // Customer 2A GET /api/websites returns only site-2a
  const cust2AListRes = await invokeHandler(getWebsitesHandler, { auth: { user: customer2AActor }, query: {} });
  assert.equal(cust2AListRes.statusCode, 200);
  assert.deepEqual(cust2AListRes.responseBody.data.map((w) => w.id), ['site-2a']);

  // Customer 2B GET /api/websites returns only site-2b
  const cust2BListRes = await invokeHandler(getWebsitesHandler, { auth: { user: customer2BActor }, query: {} });
  assert.equal(cust2BListRes.statusCode, 200);
  assert.deepEqual(cust2BListRes.responseBody.data.map((w) => w.id), ['site-2b']);

  // Customer Direct GET /api/websites returns only site-direct
  const custDirectListRes = await invokeHandler(getWebsitesHandler, { auth: { user: customerDirectActorObj }, query: {} });
  assert.equal(custDirectListRes.statusCode, 200);
  assert.deepEqual(custDirectListRes.responseBody.data.map((w) => w.id), ['site-direct']);

  // Single website route access checks:
  // Reseller 1: allowed site-1a, site-1b; forbidden 403 on site-2a, site-2b, site-direct
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller1User }, params: { websiteId: 'site-1a' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller1User }, params: { websiteId: 'site-1b' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller1User }, params: { websiteId: 'site-2a' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller1User }, params: { websiteId: 'site-2b' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller1User }, params: { websiteId: 'site-direct' } })).statusCode, 403);

  // Reseller 2: allowed site-2a, site-2b; forbidden 403 on site-1a, site-1b, site-direct
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller2User }, params: { websiteId: 'site-2a' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller2User }, params: { websiteId: 'site-2b' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller2User }, params: { websiteId: 'site-1a' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller2User }, params: { websiteId: 'site-1b' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: reseller2User }, params: { websiteId: 'site-direct' } })).statusCode, 403);

  // Customer 1A: allowed site-1a; forbidden 403 on site-1b, site-2a, site-2b, site-direct
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customer1AActor }, params: { websiteId: 'site-1a' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customer1AActor }, params: { websiteId: 'site-1b' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customer1AActor }, params: { websiteId: 'site-2a' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customer1AActor }, params: { websiteId: 'site-2b' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customer1AActor }, params: { websiteId: 'site-direct' } })).statusCode, 403);

  // Customer Direct: allowed site-direct; forbidden 403 on site-1a, site-1b, site-2a, site-2b
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customerDirectActorObj }, params: { websiteId: 'site-direct' } })).statusCode, 200);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customerDirectActorObj }, params: { websiteId: 'site-1a' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customerDirectActorObj }, params: { websiteId: 'site-1b' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customerDirectActorObj }, params: { websiteId: 'site-2a' } })).statusCode, 403);
  assert.equal((await invokeHandler(getSingleWebsiteHandler, { auth: { user: customerDirectActorObj }, params: { websiteId: 'site-2b' } })).statusCode, 403);
});
