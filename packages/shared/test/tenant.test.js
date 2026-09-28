import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_KINDS,
  ALL_SYSTEM_ROLES,
  SUPPORTED_ACCOUNT_KINDS,
  SUPPORTED_TENANT_ROLES,
  TENANT_ROLES,
  TenantValidationError,
  assertTenantAccess,
  assertTenantIdentifier,
  createTenantContext,
  filterByTenantBoundary,
  isCustomerAccount,
  isCustomerRole,
  isOwnerRole,
  isReadOnlyRole,
  isResellerAccount,
  isResellerRole,
  isSiteManagerRole,
  isValidTenantIdentifier,
  normalizeCustomerAccount,
  normalizeHostingAccount,
  normalizeResellerAccount,
  normalizeWebsiteOwnership,
  resolveEntityTenantScope,
} from '../src/index.js';

test('tenant constants and role classification predicates', () => {
  assert.equal(TENANT_ROLES.OWNER, 'owner');
  assert.equal(TENANT_ROLES.RESELLER, 'reseller');
  assert.equal(TENANT_ROLES.CUSTOMER, 'customer');
  assert.equal(TENANT_ROLES.SITE_MANAGER, 'site_manager');
  assert.equal(TENANT_ROLES.READ_ONLY, 'read_only');

  assert.equal(ACCOUNT_KINDS.RESELLER, 'reseller');
  assert.equal(ACCOUNT_KINDS.CUSTOMER, 'customer');

  assert.deepEqual(SUPPORTED_ACCOUNT_KINDS, ['reseller', 'customer']);
  assert.deepEqual(SUPPORTED_TENANT_ROLES, ['owner', 'reseller', 'customer']);
  assert.equal(ALL_SYSTEM_ROLES.length, 5);

  assert.equal(isOwnerRole('owner'), true);
  assert.equal(isOwnerRole('reseller'), false);
  assert.equal(isResellerRole('reseller'), true);
  assert.equal(isResellerRole('customer'), false);
  assert.equal(isCustomerRole('customer'), true);
  assert.equal(isCustomerRole('site_manager'), false);
  assert.equal(isSiteManagerRole('site_manager'), true);
  assert.equal(isSiteManagerRole('owner'), false);
  assert.equal(isReadOnlyRole('read_only'), true);
  assert.equal(isReadOnlyRole('customer'), false);
});

test('assertTenantIdentifier and isValidTenantIdentifier', () => {
  assert.equal(isValidTenantIdentifier('valid_id-123'), true);
  assert.equal(isValidTenantIdentifier('reseller-a'), true);
  assert.equal(isValidTenantIdentifier(''), false);
  assert.equal(isValidTenantIdentifier(null), false);
  assert.equal(isValidTenantIdentifier(123), false);
  assert.equal(isValidTenantIdentifier('id with spaces'), false);
  assert.equal(isValidTenantIdentifier('bad/slash'), false);
  assert.equal(isValidTenantIdentifier('../traversal'), false);

  assert.equal(assertTenantIdentifier('reseller-1'), 'reseller-1');
  assert.throws(
    () => assertTenantIdentifier('invalid/id', 'customField'),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_identifier',
  );
});

test('normalizeResellerAccount validates reseller models and enforces no nesting', () => {
  const valid = { id: 'reseller-alpha', kind: 'reseller', resellerId: null, active: true, maxCustomers: 5, maxWebsites: 10 };
  const normalized = normalizeResellerAccount(valid);

  assert.deepEqual(normalized, {
    id: 'reseller-alpha',
    kind: 'reseller',
    resellerId: null,
    active: true,
    maxCustomers: 5,
    maxWebsites: 10,
  });
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(isResellerAccount(normalized), true);
  assert.equal(isCustomerAccount(normalized), false);

  // Nested reseller is rejected
  assert.throws(
    () => normalizeResellerAccount({ ...valid, resellerId: 'parent-reseller' }),
    (error) => error instanceof TenantValidationError && error.code === 'nested_reseller_not_supported',
  );

  // Invalid kind
  assert.throws(
    () => normalizeResellerAccount({ ...valid, kind: 'customer' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_reseller_kind',
  );

  // Invalid active boolean
  assert.throws(
    () => normalizeResellerAccount({ ...valid, active: 'true' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_reseller_active',
  );

  // Invalid limits
  assert.throws(
    () => normalizeResellerAccount({ ...valid, maxCustomers: -1 }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_reseller_limits',
  );
  assert.throws(
    () => normalizeResellerAccount({ ...valid, maxWebsites: 'unlimited' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_reseller_limits',
  );
});

test('normalizeCustomerAccount validates customer under reseller and direct Owner customer', () => {
  // Customer under reseller
  const child = { id: 'customer-1', kind: 'customer', resellerId: 'reseller-alpha', active: true };
  const normalizedChild = normalizeCustomerAccount(child);
  assert.deepEqual(normalizedChild, {
    id: 'customer-1',
    kind: 'customer',
    resellerId: 'reseller-alpha',
    active: true,
  });
  assert.equal(isCustomerAccount(normalizedChild), true);
  assert.equal(isResellerAccount(normalizedChild), false);

  // Direct Owner customer (resellerId is null)
  const direct = { id: 'customer-direct', kind: 'customer', resellerId: null, active: true };
  const normalizedDirect = normalizeCustomerAccount(direct);
  assert.equal(normalizedDirect.resellerId, null);
  assert.equal(normalizedDirect.id, 'customer-direct');

  // Customer cannot be its own reseller
  assert.throws(
    () => normalizeCustomerAccount({ id: 'cust-x', kind: 'customer', resellerId: 'cust-x', active: true }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_customer_parent',
  );

  // Invalid kind
  assert.throws(
    () => normalizeCustomerAccount({ ...child, kind: 'reseller' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_customer_kind',
  );

  // Invalid active
  assert.throws(
    () => normalizeCustomerAccount({ ...child, active: 1 }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_customer_active',
  );
});

test('normalizeHostingAccount delegates and verifies expectedKind', () => {
  const reseller = normalizeHostingAccount(
    { id: 'reseller-1', kind: 'reseller', resellerId: null, active: true },
    'reseller',
  );
  assert.equal(reseller.kind, 'reseller');

  const customer = normalizeHostingAccount(
    { id: 'cust-1', kind: 'customer', resellerId: null, active: true },
    'customer',
  );
  assert.equal(customer.kind, 'customer');

  // Mismatch throws
  assert.throws(
    () => normalizeHostingAccount(reseller, 'customer'),
    (error) => error instanceof TenantValidationError && error.code === 'kind_mismatch',
  );

  // Unknown kind throws
  assert.throws(
    () => normalizeHostingAccount({ id: 'unknown-1', kind: 'admin', active: true }),
    (error) => error instanceof TenantValidationError && error.code === 'unknown_account_kind',
  );
});

test('normalizeWebsiteOwnership validates website-to-customer ownership projection', () => {
  const ownership = normalizeWebsiteOwnership({ id: 'site-a', customerId: 'cust-a' });
  assert.deepEqual(ownership, { id: 'site-a', customerId: 'cust-a' });

  assert.throws(
    () => normalizeWebsiteOwnership({ id: '', customerId: 'cust-a' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_identifier',
  );
  assert.throws(
    () => normalizeWebsiteOwnership({ id: 'site-a', customerId: null }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_identifier',
  );

  const unassigned = normalizeWebsiteOwnership({ id: 'site-unassigned' }, { allowUnassigned: true });
  assert.deepEqual(unassigned, { id: 'site-unassigned', customerId: null });
});

test('createTenantContext builds accurate tenant context for all roles', () => {
  // Owner
  const ownerCtx = createTenantContext({ id: 'owner-user', role: 'owner' });
  assert.equal(ownerCtx.type, 'owner');
  assert.equal(ownerCtx.isGlobal, true);
  assert.equal(ownerCtx.actorId, 'owner-user');

  // Reseller
  const resellerCtx = createTenantContext({
    id: 'reseller-1',
    role: 'site_manager',
    hosting: { kind: 'reseller', resellerId: null },
    websiteIds: ['site-1', 'site-2'],
  });
  assert.equal(resellerCtx.type, 'reseller');
  assert.equal(resellerCtx.isGlobal, false);
  assert.equal(resellerCtx.tenantId, 'reseller-1');
  assert.equal(resellerCtx.resellerId, null);
  assert.deepEqual(resellerCtx.websiteIds, ['site-1', 'site-2']);

  // Customer under reseller
  const customerCtx = createTenantContext({
    id: 'cust-1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-1' },
    websiteIds: ['site-1'],
  });
  assert.equal(customerCtx.type, 'customer');
  assert.equal(customerCtx.isGlobal, false);
  assert.equal(customerCtx.customerId, 'cust-1');
  assert.equal(customerCtx.resellerId, 'reseller-1');
  assert.equal(customerCtx.isDirectOwner, false);
  assert.equal(customerCtx.tenantId, 'reseller-1');

  // Direct Owner customer
  const directCustomerCtx = createTenantContext({
    id: 'cust-direct',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: null },
    websiteIds: ['site-d'],
  });
  assert.equal(directCustomerCtx.type, 'customer');
  assert.equal(directCustomerCtx.isDirectOwner, true);
  assert.equal(directCustomerCtx.tenantId, 'cust-direct');

  // Legacy site_manager
  const legacyCtx = createTenantContext({
    id: 'legacy-sm',
    role: 'site_manager',
    websiteIds: ['site-legacy'],
  });
  assert.equal(legacyCtx.type, 'legacy_site_manager');
  assert.equal(legacyCtx.isGlobal, false);
  assert.deepEqual(legacyCtx.websiteIds, ['site-legacy']);
});

test('resolveEntityTenantScope maps all entity types to their tenant scope', () => {
  const websites = { 'site-a': { id: 'site-a', customerId: 'cust-1' } };
  const customers = { 'cust-1': { id: 'cust-1', resellerId: 'reseller-1' } };
  const domains = { 'domain-a': { id: 'domain-a', websiteId: 'site-a' } };
  const mailDomains = { 'mail-a': { id: 'mail-a', webDomainId: 'domain-a' } };

  const websiteLookup = (id) => websites[id] ?? null;
  const customerLookup = (id) => customers[id] ?? null;
  const domainLookup = (id) => domains[id] ?? null;
  const mailDomainLookup = (id) => mailDomains[id] ?? null;

  // Website
  const siteScope = resolveEntityTenantScope({
    entityType: 'website',
    entity: { id: 'site-a', customerId: 'cust-1' },
    customerLookup,
  });
  assert.equal(siteScope.websiteId, 'site-a');
  assert.equal(siteScope.customerId, 'cust-1');
  assert.equal(siteScope.resellerId, 'reseller-1');

  // Domain
  const domScope = resolveEntityTenantScope({
    entityType: 'domain',
    entity: { id: 'domain-a', websiteId: 'site-a' },
    websiteLookup,
    customerLookup,
  });
  assert.equal(domScope.websiteId, 'site-a');
  assert.equal(domScope.customerId, 'cust-1');
  assert.equal(domScope.resellerId, 'reseller-1');

  // MailDomain
  const mailScope = resolveEntityTenantScope({
    entityType: 'mail_domain',
    entity: { id: 'mail-a', webDomainId: 'domain-a' },
    domainLookup,
    websiteLookup,
    customerLookup,
  });
  assert.equal(mailScope.websiteId, 'site-a');
  assert.equal(mailScope.customerId, 'cust-1');
  assert.equal(mailScope.resellerId, 'reseller-1');

  // Mailbox
  const boxScope = resolveEntityTenantScope({
    entityType: 'mailbox',
    entity: { id: 'box-1', mailDomainId: 'mail-a' },
    mailDomainLookup,
    domainLookup,
    websiteLookup,
    customerLookup,
  });
  assert.equal(boxScope.websiteId, 'site-a');
  assert.equal(boxScope.customerId, 'cust-1');
  assert.equal(boxScope.resellerId, 'reseller-1');

  // Job
  const jobScope = resolveEntityTenantScope({
    entityType: 'job',
    entity: { id: 'job-1', resourceType: 'website', resourceId: 'site-a' },
    websiteLookup,
    customerLookup,
  });
  assert.equal(jobScope.websiteId, 'site-a');
  assert.equal(jobScope.customerId, 'cust-1');
  assert.equal(jobScope.resellerId, 'reseller-1');
});

test('assertTenantAccess enforces boundaries across Owner, Reseller, Customer, and legacy SM', () => {
  const owner = { id: 'owner-1', role: 'owner', active: true };
  const resellerA = {
    id: 'reseller-a',
    role: 'site_manager',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-a1'],
  };
  const customerA = {
    id: 'customer-a1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a1'],
  };
  const customerDirect = {
    id: 'customer-direct',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: null },
    active: true,
    websiteIds: ['site-direct'],
  };
  const legacySm = {
    id: 'sm-legacy',
    role: 'site_manager',
    active: true,
    websiteIds: ['site-legacy'],
  };

  const scopeSiteA = {
    entityType: 'website',
    entityId: 'site-a1',
    websiteId: 'site-a1',
    customerId: 'customer-a1',
    resellerId: 'reseller-a',
  };
  const scopeSiteB = {
    entityType: 'website',
    entityId: 'site-b1',
    websiteId: 'site-b1',
    customerId: 'customer-b1',
    resellerId: 'reseller-b',
  };
  const scopeSiteDirect = {
    entityType: 'website',
    entityId: 'site-direct',
    websiteId: 'site-direct',
    customerId: 'customer-direct',
    resellerId: null,
  };

  // Owner can access all
  assert.equal(assertTenantAccess({ actor: owner, entityScope: scopeSiteA }), true);
  assert.equal(assertTenantAccess({ actor: owner, entityScope: scopeSiteB }), true);
  assert.equal(assertTenantAccess({ actor: owner, entityScope: scopeSiteDirect }), true);

  // Reseller A can access child customer site
  assert.equal(assertTenantAccess({ actor: resellerA, entityScope: scopeSiteA }), true);

  // Reseller A is DENIED access to Reseller B site
  assert.throws(
    () => assertTenantAccess({ actor: resellerA, entityScope: scopeSiteB }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller A is DENIED access to direct Owner customer site
  assert.throws(
    () => assertTenantAccess({ actor: resellerA, entityScope: scopeSiteDirect }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Customer A can access own site
  assert.equal(assertTenantAccess({ actor: customerA, entityScope: scopeSiteA }), true);

  // Customer A is DENIED access to foreign sites
  assert.throws(
    () => assertTenantAccess({ actor: customerA, entityScope: scopeSiteB }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );
  assert.throws(
    () => assertTenantAccess({ actor: customerA, entityScope: scopeSiteDirect }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Direct Owner customer can access own site
  assert.equal(assertTenantAccess({ actor: customerDirect, entityScope: scopeSiteDirect }), true);
  assert.throws(
    () => assertTenantAccess({ actor: customerDirect, entityScope: scopeSiteA }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Legacy site manager allowed on websiteIds, denied elsewhere
  assert.equal(assertTenantAccess({ actor: legacySm, entityScope: { websiteId: 'site-legacy' } }), true);
  assert.throws(
    () => assertTenantAccess({ actor: legacySm, entityScope: scopeSiteA }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller cannot access site outside allowed websiteIds even if it belongs to own customer
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { ...scopeSiteA, websiteId: 'site-a2' }, // resellerA only has ['site-a1']
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Customer cannot access site outside allowed websiteIds even if customerId matches self
  assert.throws(
    () => assertTenantAccess({
      actor: customerA,
      entityScope: { ...scopeSiteA, websiteId: 'site-a2' }, // customerA only has ['site-a1']
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Inactive actor fails closed
  assert.throws(
    () => assertTenantAccess({ actor: { ...resellerA, active: false }, entityScope: scopeSiteA }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_actor_inactive',
  );
});

test('filterByTenantBoundary filters resources according to actor tenant boundary', () => {
  const items = [
    { id: 'site-a1', customerId: 'customer-a1', resellerId: 'reseller-a', websiteId: 'site-a1' },
    { id: 'site-a2', customerId: 'customer-a2', resellerId: 'reseller-a', websiteId: 'site-a2' },
    { id: 'site-b1', customerId: 'customer-b1', resellerId: 'reseller-b', websiteId: 'site-b1' },
    { id: 'site-direct', customerId: 'customer-direct', resellerId: null, websiteId: 'site-direct' },
  ];

  const owner = { id: 'owner-1', role: 'owner' };
  const resellerA = {
    id: 'reseller-a',
    role: 'site_manager',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-a1', 'site-a2'],
  };
  const customerA1 = {
    id: 'customer-a1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a1'],
  };

  // Owner sees all 4
  assert.equal(filterByTenantBoundary(items, owner).length, 4);

  // Reseller A sees only their 2 sites
  const resellerSites = filterByTenantBoundary(items, resellerA);
  assert.deepEqual(resellerSites.map((s) => s.id), ['site-a1', 'site-a2']);

  // Customer A1 sees only their 1 site
  const customerSites = filterByTenantBoundary(items, customerA1);
  assert.deepEqual(customerSites.map((s) => s.id), ['site-a1']);
});
