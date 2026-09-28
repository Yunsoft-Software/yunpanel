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

test('resolveEntityTenantScope handles application, database, mail_alias, job variations and lookup errors', () => {
  const websites = {
    'site-a': { id: 'site-a', customerId: 'cust-1' },
    'site-direct': { id: 'site-direct', customerId: 'cust-direct' },
  };
  const customers = {
    'cust-1': { id: 'cust-1', resellerId: 'reseller-1' },
    'cust-direct': { id: 'cust-direct', resellerId: null },
  };
  const domains = {
    'dom-a': { id: 'dom-a', websiteId: 'site-a' },
  };
  const mailDomains = {
    'md-a': { id: 'md-a', webDomainId: 'dom-a' },
    'md-direct-site': { id: 'md-direct-site', websiteId: 'site-a' },
  };

  const websiteLookup = (arg) => {
    if (typeof arg === 'string') return websites[arg] ?? null;
    if (arg?.applicationId === 'app-lookup') return websites['site-a'];
    return null;
  };
  const customerLookup = (id) => customers[id] ?? null;
  const domainLookup = (id) => domains[id] ?? null;
  const mailDomainLookup = (id) => mailDomains[id] ?? null;

  // 1. Application with direct websiteId
  const appScope = resolveEntityTenantScope({
    entityType: 'application',
    entity: { id: 'app-1', websiteId: 'site-a' },
    customerLookup,
    websiteLookup,
  });
  assert.equal(appScope.websiteId, 'site-a');
  assert.equal(appScope.customerId, 'cust-1');
  assert.equal(appScope.resellerId, 'reseller-1');
  assert.equal(appScope.isDirectOwner, false);

  // 2. Application resolved via websiteLookup({ applicationId })
  const appLookupScope = resolveEntityTenantScope({
    entityType: 'application',
    entity: { id: 'app-lookup' },
    websiteLookup,
    customerLookup,
  });
  assert.equal(appLookupScope.websiteId, 'site-a');
  assert.equal(appLookupScope.customerId, 'cust-1');
  assert.equal(appLookupScope.resellerId, 'reseller-1');

  // 3. Database with direct websiteId
  const dbScope = resolveEntityTenantScope({
    entityType: 'database',
    entity: { id: 'db-1', websiteId: 'site-a' },
    websiteLookup,
    customerLookup,
  });
  assert.equal(dbScope.websiteId, 'site-a');
  assert.equal(dbScope.customerId, 'cust-1');

  // 4. Mail alias with direct websiteId
  const aliasDirectScope = resolveEntityTenantScope({
    entityType: 'mail_alias',
    entity: { id: 'alias-1', websiteId: 'site-a' },
    customerLookup,
    websiteLookup,
  });
  assert.equal(aliasDirectScope.websiteId, 'site-a');

  // 5. Mail alias with mailDomainId (via mailDomainLookup with websiteId)
  const aliasMdScope = resolveEntityTenantScope({
    entityType: 'mail_alias',
    entity: { id: 'alias-2', mailDomainId: 'md-direct-site' },
    mailDomainLookup,
    websiteLookup,
    customerLookup,
  });
  assert.equal(aliasMdScope.websiteId, 'site-a');

  // 6. Mail alias with mailDomainId (via mailDomainLookup -> webDomainId -> domainLookup)
  const aliasFullScope = resolveEntityTenantScope({
    entityType: 'mail_alias',
    entity: { id: 'alias-3', mailDomainId: 'md-a' },
    mailDomainLookup,
    domainLookup,
    websiteLookup,
    customerLookup,
  });
  assert.equal(aliasFullScope.websiteId, 'site-a');
  assert.equal(aliasFullScope.customerId, 'cust-1');

  // 7. Job with payload.websiteId
  const jobPayloadScope = resolveEntityTenantScope({
    entityType: 'job',
    entity: { id: 'job-payload', payload: { websiteId: 'site-a' } },
    websiteLookup,
    customerLookup,
  });
  assert.equal(jobPayloadScope.websiteId, 'site-a');

  // 8. Job with payload.mailDomainId
  const jobMailScope = resolveEntityTenantScope({
    entityType: 'job',
    entity: { id: 'job-mail', payload: { mailDomainId: 'md-a' } },
    mailDomainLookup,
    domainLookup,
    websiteLookup,
    customerLookup,
  });
  assert.equal(jobMailScope.websiteId, 'site-a');

  // 9. Direct Owner customer resolution
  const directScope = resolveEntityTenantScope({
    entityType: 'website',
    entity: { id: 'site-direct', customerId: 'cust-direct' },
    customerLookup,
  });
  assert.equal(directScope.customerId, 'cust-direct');
  assert.equal(directScope.resellerId, null);
  assert.equal(directScope.isDirectOwner, true);

  // 10. Unsupported entity type throws TenantValidationError
  assert.throws(
    () => resolveEntityTenantScope({ entityType: 'invalid_type', entity: { id: 'x' } }),
    (error) => error instanceof TenantValidationError && error.code === 'unsupported_entity_type',
  );

  // 11. Invalid entity record (null or non-object) throws TenantValidationError
  assert.throws(
    () => resolveEntityTenantScope({ entityType: 'website', entity: null }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_entity_record',
  );
  assert.throws(
    () => resolveEntityTenantScope({ entityType: 'website', entity: 'not-an-object' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_entity_record',
  );
});

test('assertTenantAccess negative scenarios: cross-tenant data leakage prevention', () => {
  const resellerA = {
    id: 'reseller-a',
    role: 'site_manager',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-a1'],
  };
  const customerA1 = {
    id: 'cust-a1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a1'],
  };
  const customerA2 = {
    id: 'cust-a2',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a2'],
  };
  const customerB1 = {
    id: 'cust-b1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-b' },
    active: true,
    websiteIds: ['site-b1'],
  };
  const customerDirect = {
    id: 'cust-direct',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: null },
    active: true,
    websiteIds: ['site-direct'],
  };

  // Cross-Customer under Same Reseller (Customer A1 vs Customer A2):
  // 1. Customer A1 attempts to access Customer A2 website
  assert.throws(
    () => assertTenantAccess({
      actor: customerA1,
      entityScope: { entityType: 'website', websiteId: 'site-a2', customerId: 'cust-a2', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 2. Customer A1 attempts to access Customer A2 account entity (no websiteId)
  assert.throws(
    () => assertTenantAccess({
      actor: customerA1,
      entityScope: { entityType: 'account', entityId: 'cust-a2', customerId: 'cust-a2', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 3. Customer A1 attempts to access parent Reseller A account entity
  assert.throws(
    () => assertTenantAccess({
      actor: customerA1,
      entityScope: { entityType: 'account', entityId: 'reseller-a', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 4. Customer A1 attempts to spoof customerId while accessing a site not in its websiteIds
  assert.throws(
    () => assertTenantAccess({
      actor: customerA1,
      entityScope: { entityType: 'website', websiteId: 'site-a2', customerId: 'cust-a1', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Reseller Boundary Negative Scenarios:
  // 5. Reseller A attempts to access Reseller B customer account
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { entityType: 'account', entityId: 'cust-b1', customerId: 'cust-b1', resellerId: 'reseller-b' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 6. Reseller A attempts to access Reseller B account entity
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { entityType: 'account', entityId: 'reseller-b', resellerId: null },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 7. Reseller A attempts to access Direct Owner Customer account entity (resellerId === null)
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { entityType: 'account', entityId: 'cust-direct', customerId: 'cust-direct', resellerId: null, isDirectOwner: true },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 8. Reseller A attempts to access Direct Owner Customer website
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { entityType: 'website', websiteId: 'site-direct', customerId: 'cust-direct', resellerId: null, isDirectOwner: true },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // 9. Reseller A attempts to access resource of own customer but with websiteId missing from allowed list
  assert.throws(
    () => assertTenantAccess({
      actor: resellerA,
      entityScope: { entityType: 'website', websiteId: 'site-foreign', customerId: 'cust-a1', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_boundary_forbidden',
  );

  // Inactive Account Rejection (Fail-closed):
  // 10. Inactive customer rejected
  assert.throws(
    () => assertTenantAccess({
      actor: { ...customerA1, active: false },
      entityScope: { entityType: 'website', websiteId: 'site-a1', customerId: 'cust-a1', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_actor_inactive',
  );

  // 11. Inactive reseller rejected
  assert.throws(
    () => assertTenantAccess({
      actor: { ...resellerA, active: false },
      entityScope: { entityType: 'website', websiteId: 'site-a1', customerId: 'cust-a1', resellerId: 'reseller-a' },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_actor_inactive',
  );

  // 12. Inactive direct owner customer rejected
  assert.throws(
    () => assertTenantAccess({
      actor: { ...customerDirect, active: false },
      entityScope: { entityType: 'website', websiteId: 'site-direct', customerId: 'cust-direct', resellerId: null },
    }),
    (error) => error instanceof TenantValidationError && error.code === 'tenant_actor_inactive',
  );

  // Input Validation Rejection:
  assert.throws(
    () => assertTenantAccess({ actor: null, entityScope: { websiteId: 'site-a1' } }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_actor',
  );
  assert.throws(
    () => assertTenantAccess({ actor: customerA1, entityScope: null }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_entity_scope',
  );
});

test('filterByTenantBoundary negative scenarios: prevents cross-tenant data leakage in collections', () => {
  const dataset = [
    { id: 'site-a1', entityType: 'website', websiteId: 'site-a1', customerId: 'cust-a1', resellerId: 'reseller-a' },
    { id: 'site-a2', entityType: 'website', websiteId: 'site-a2', customerId: 'cust-a2', resellerId: 'reseller-a' },
    { id: 'site-b1', entityType: 'website', websiteId: 'site-b1', customerId: 'cust-b1', resellerId: 'reseller-b' },
    { id: 'site-direct', entityType: 'website', websiteId: 'site-direct', customerId: 'cust-direct', resellerId: null, isDirectOwner: true },
    { id: 'account-cust-a1', entityType: 'account', entityId: 'cust-a1', customerId: 'cust-a1', resellerId: 'reseller-a' },
    { id: 'account-cust-a2', entityType: 'account', entityId: 'cust-a2', customerId: 'cust-a2', resellerId: 'reseller-a' },
    { id: 'account-cust-b1', entityType: 'account', entityId: 'cust-b1', customerId: 'cust-b1', resellerId: 'reseller-b' },
    { id: 'account-cust-direct', entityType: 'account', entityId: 'cust-direct', customerId: 'cust-direct', resellerId: null, isDirectOwner: true },
    { id: 'server-resource', entityType: 'server', entityId: 'srv-1' },
    null,
    { id: 'malformed' },
  ];

  const customerA1 = {
    id: 'cust-a1',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a1'],
  };
  const customerA2 = {
    id: 'cust-a2',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: 'reseller-a' },
    active: true,
    websiteIds: ['site-a2'],
  };
  const resellerA = {
    id: 'reseller-a',
    role: 'site_manager',
    hosting: { kind: 'reseller', resellerId: null },
    active: true,
    websiteIds: ['site-a1', 'site-a2'],
  };
  const customerDirect = {
    id: 'cust-direct',
    role: 'site_manager',
    hosting: { kind: 'customer', resellerId: null },
    active: true,
    websiteIds: ['site-direct'],
  };

  // 1. Customer A1 receives ONLY self items (site-a1 and account-cust-a1)
  const a1Results = filterByTenantBoundary(dataset, customerA1);
  assert.deepEqual(a1Results.map((i) => i.id), ['site-a1', 'account-cust-a1']);
  assert.equal(a1Results.some((i) => i.id.includes('a2')), false);
  assert.equal(a1Results.some((i) => i.id.includes('b1')), false);
  assert.equal(a1Results.some((i) => i.id.includes('direct')), false);

  // 2. Customer A2 receives ONLY self items (site-a2 and account-cust-a2)
  const a2Results = filterByTenantBoundary(dataset, customerA2);
  assert.deepEqual(a2Results.map((i) => i.id), ['site-a2', 'account-cust-a2']);
  assert.equal(a2Results.some((i) => i.id.includes('a1')), false);

  // 3. Reseller A receives both child customer items (site-a1, site-a2, account-cust-a1, account-cust-a2)
  const resResults = filterByTenantBoundary(dataset, resellerA);
  assert.deepEqual(resResults.map((i) => i.id), [
    'site-a1',
    'site-a2',
    'account-cust-a1',
    'account-cust-a2',
  ]);
  assert.equal(resResults.some((i) => i.id.includes('b1')), false);
  assert.equal(resResults.some((i) => i.id.includes('direct')), false);

  // 4. Direct Owner Customer receives ONLY self items
  const directResults = filterByTenantBoundary(dataset, customerDirect);
  assert.deepEqual(directResults.map((i) => i.id), ['site-direct', 'account-cust-direct']);

  // 5. Inactive actor receives empty array
  const inactiveResults = filterByTenantBoundary(dataset, { ...customerA1, active: false });
  assert.deepEqual(inactiveResults, []);

  // 6. Non-array inputs safely return empty array
  assert.deepEqual(filterByTenantBoundary(null, customerA1), []);
  assert.deepEqual(filterByTenantBoundary('not-an-array', customerA1), []);
});

test('tenant context creation and account normalization security edge cases', () => {
  // 1. Path traversal or illegal identifier rejection
  for (const badId of ['../traversal', 'id/slash', 'id with spaces', 'id\0null', '']) {
    assert.throws(
      () => createTenantContext({ id: badId, role: 'owner' }),
      (error) => error instanceof TenantValidationError && error.code === 'invalid_identifier',
    );
  }

  // 2. Non-object actor or missing id rejection
  assert.throws(
    () => createTenantContext(null),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_actor',
  );
  assert.throws(
    () => createTenantContext({ role: 'owner' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_actor',
  );

  // 3. Unsupported role in createTenantContext
  assert.throws(
    () => createTenantContext({ id: 'user-1', role: 'superadmin' }),
    (error) => error instanceof TenantValidationError && error.code === 'unsupported_tenant_role',
  );

  // 4. normalizeWebsiteOwnership unassigned handling
  assert.throws(
    () => normalizeWebsiteOwnership({ id: 'site-x' }),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_identifier',
  );
  const unassigned = normalizeWebsiteOwnership({ id: 'site-x' }, { allowUnassigned: true });
  assert.equal(unassigned.id, 'site-x');
  assert.equal(unassigned.customerId, null);

  // 5. Non-object website record
  assert.throws(
    () => normalizeWebsiteOwnership('not-an-object'),
    (error) => error instanceof TenantValidationError && error.code === 'invalid_website_record',
  );
});

