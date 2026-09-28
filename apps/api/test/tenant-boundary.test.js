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
