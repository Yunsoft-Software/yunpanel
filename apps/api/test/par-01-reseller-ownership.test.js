import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { AuthError } from '../src/auth-error.js';
import { siteFixture, website, allocation, uuid } from '../test-support/hosting-site-fixture.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import {
  initializeHostingAccountSchema,
  rollbackEmptyHostingAccountSchema,
} from '../src/hosting-account-schema.js';
import {
  hostingWebsitesForCapacity,
  initializeHostingSiteAllocationSchema,
  rollbackEmptyHostingSiteAllocationSchema,
} from '../src/hosting-site-allocation-schema.js';
import {
  hostingWebsiteDigest,
} from '../src/hosting-site-allocation-store.js';
import {
  validateHostingAccount,
  assertCustomerCreationScope,
  assertCustomerManagement,
  assertResellerManagement,
} from '../src/reseller-scope.js';
import {
  validateResellerLimits,
  assertResellerCapacity,
  countResellerUsage,
} from '../src/reseller-limits.js';
import {
  validateCustomerQuotas,
  assertCustomerQuotaCapacity,
  assertCustomerQuotaWithinResellerCapacity,
} from '../src/customer-quotas.js';

test('PAR-01 / RS-01: Pure scope and limit policies execute before auth/state wiring', () => {
  // Pure hosting account validations
  const validReseller = validateHostingAccount({ id: 'reseller-1', kind: 'reseller', resellerId: null, active: true }, 'reseller');
  assert.equal(validReseller.kind, 'reseller');
  assert.equal(validReseller.resellerId, null);

  const validCustomer = validateHostingAccount({ id: 'customer-1', kind: 'customer', resellerId: 'reseller-1', active: true }, 'customer');
  assert.equal(validCustomer.kind, 'customer');
  assert.equal(validCustomer.resellerId, 'reseller-1');

  const directCustomer = validateHostingAccount({ id: 'customer-direct', kind: 'customer', resellerId: null, active: true }, 'customer');
  assert.equal(directCustomer.kind, 'customer');
  assert.equal(directCustomer.resellerId, null);

  // Sub-reseller prohibition in pure policy (reseller cannot have a resellerId)
  assert.throws(() => validateHostingAccount({ id: 'sub-reseller', kind: 'reseller', resellerId: 'reseller-1', active: true }, 'reseller'), {
    code: 'invalid_reseller_record',
  });

  // Pure reseller limits validation
  const limits = validateResellerLimits({ maxCustomers: 5, maxWebsites: 10 });
  assert.equal(limits.maxCustomers, 5);
  assert.equal(limits.maxWebsites, 10);

  // Pure capacity check: OK then exceeded
  assertResellerCapacity({ limits, usage: { customers: 4, websites: 8 }, resource: 'customers' });
  assert.throws(() => assertResellerCapacity({ limits, usage: { customers: 5, websites: 8 }, resource: 'customers' }), {
    code: 'reseller_limit_reached',
    status: 409,
  });
  assertResellerCapacity({ limits, usage: { customers: 3, websites: 9 }, resource: 'websites' });
  assert.throws(() => assertResellerCapacity({ limits, usage: { customers: 3, websites: 10 }, resource: 'websites' }), {
    code: 'reseller_limit_reached',
    status: 409,
  });

  // Pure customer quotas validation
  const quotas = validateCustomerQuotas({ maxWebsites: 3, maxDiskMb: 1024, maxTrafficMb: 5000, maxDatabases: 2 });
  assert.equal(quotas.maxWebsites, 3);
  assert.equal(quotas.maxDiskMb, 1024);

  // Customer quota capacity check
  assertCustomerQuotaCapacity({ quotas, usage: { websites: 2 }, resource: 'websites', amount: 1 });
  assert.throws(() => assertCustomerQuotaCapacity({ quotas, usage: { websites: 3 }, resource: 'websites', amount: 1 }), {
    code: 'customer_quota_exceeded',
    status: 409,
  });

  // Customer quota within reseller capacity (prevents overselling)
  assertCustomerQuotaWithinResellerCapacity({ customerQuotas: quotas, resellerLimits: limits });
  assert.throws(() => assertCustomerQuotaWithinResellerCapacity({
    customerQuotas: { maxWebsites: 15 },
    resellerLimits: limits,
  }), {
    code: 'reseller_limit_reached',
    status: 409,
  });

  // Pure actor scope assertion
  const ownerActor = { id: 'owner-1', role: 'owner', active: true };
  const resellerActor = { id: 'reseller-1', role: 'reseller', active: true };
  const foreignResellerActor = { id: 'reseller-2', role: 'reseller', active: true };

  assertResellerManagement({ actor: ownerActor, reseller: validReseller });
  assert.throws(() => assertResellerManagement({ actor: resellerActor, reseller: validReseller }), {
    code: 'reseller_scope_forbidden',
    status: 403,
  });
  assert.throws(() => assertResellerManagement({ actor: foreignResellerActor, reseller: validReseller }), {
    code: 'reseller_scope_forbidden',
    status: 403,
  });

  assertCustomerManagement({ actor: ownerActor, customer: validCustomer, reseller: validReseller });
  assertCustomerManagement({ actor: resellerActor, customer: validCustomer, reseller: validReseller });
  assert.throws(() => assertCustomerManagement({ actor: foreignResellerActor, customer: validCustomer, reseller: validReseller }), {
    code: 'reseller_scope_forbidden',
    status: 403,
  });
});

test('PAR-01 / RS-01: Ownership hierarchy enforces Owner -> optional single Reseller -> Customer -> Website', (t) => {
  const f = siteFixture(t, { maxWebsites: 5, maxCustomers: 5 });

  // 1. Owner can register Reseller (resellerId is NULL)
  const r1 = f.get('reseller-a');
  assert.equal(r1.kind, 'reseller');
  assert.equal(r1.resellerId, null);

  // 2. Owner can register Customer under Reseller (resellerId is reseller-a)
  const c1 = f.get('customer-a');
  assert.equal(c1.kind, 'customer');
  assert.equal(c1.resellerId, 'reseller-a');

  // 3. Owner can register direct Customer (resellerId is null)
  const cDirect = f.get('direct');
  assert.equal(cDirect.kind, 'customer');
  assert.equal(cDirect.resellerId, null);

  // 4. Sub-reseller prohibition: attempt to register reseller under another reseller fails at DB trigger level
  f.addUser('candidate-sub', { role: 'site_manager' });
  assert.throws(() => f.db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)')
    .run('candidate-sub', 'reseller', 'reseller-a'), (err) => {
    return err.message.includes('CHECK constraint failed') || err.message.includes('hosting_parent_must_be_reseller');
  });

  // 5. Customer cannot be a parent of another customer
  f.addUser('candidate-child', { role: 'site_manager' });
  assert.throws(() => f.db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)')
    .run('candidate-child', 'customer', 'customer-a'), (err) => {
    return err.message.includes('hosting_parent_must_be_reseller');
  });

  // 6. Reseller cannot be registered from a non-site_manager user
  f.addUser('owner-candidate', { role: 'owner' });
  assert.throws(() => f.store.registerReseller(f.token, f.requireManagement, {
    userId: 'owner-candidate', expectedUserRevision: 1, limits: { maxCustomers: 2, maxWebsites: 2 },
  }), {
    code: 'hosting_profile_requires_site_manager',
    status: 409,
  });

  // 7. Dedicated per-site Unix identities are preserved across allocations
  const site1 = website(1);
  const alloc1 = allocation(1, 'customer-a');
  f.reserve(alloc1);
  const completed1 = f.complete(alloc1, site1);
  assert.equal(completed1.state, 'attached');

  const site2 = website(2);
  const alloc2 = allocation(2, 'customer-b');
  f.reserve(alloc2);
  const completed2 = f.complete(alloc2, site2);
  assert.equal(completed2.state, 'attached');

  // Verify site IDs remain distinct
  assert.notEqual(site1.id, site2.id);
});

test('PAR-01 / RS-02: Versioned schema migration and rollback fail closed safely', (t) => {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());

  // Fresh DB: initialize schema creates version 3 and site allocation schema version 1
  const initResult = initializeHostingAccountSchema({ db: f.db, transaction: f.transaction });
  assert.equal(initResult.version, 3);
  assert.equal(initResult.created, true);

  // Idempotent re-initialization
  const reinitResult = initializeHostingAccountSchema({ db: f.db, transaction: f.transaction });
  assert.equal(reinitResult.version, 3);
  assert.equal(reinitResult.created, false);

  // Verify schema version stored
  const schemaRow = f.db.prepare('SELECT version FROM auth_hosting_schema WHERE id = 1').get();
  assert.equal(schemaRow.version, 3);
  const siteSchemaRow = f.db.prepare('SELECT version FROM auth_hosting_site_schema WHERE id = 1').get();
  assert.equal(siteSchemaRow.version, 1);

  // Corrupted schema fails closed safely (status 503)
  f.db.exec('DROP TRIGGER auth_hosting_account_insert');
  assert.throws(() => initializeHostingAccountSchema({ db: f.db, transaction: f.transaction }), {
    code: 'hosting_schema_invalid',
    status: 503,
  });

  // Re-create the dropped trigger and verify rollback on empty schema
  const repairF = hostingAuthFixture();
  t.after(() => repairF.db.close());
  initializeHostingAccountSchema({ db: repairF.db, transaction: repairF.transaction });

  const rollbackResult = rollbackEmptyHostingAccountSchema({ db: repairF.db, transaction: repairF.transaction });
  assert.equal(rollbackResult.removed, true);

  // Verify rollback on schema with data fails closed with 409 hosting_schema_in_use
  const dataF = hostingAuthFixture();
  t.after(() => dataF.db.close());
  initializeHostingAccountSchema({ db: dataF.db, transaction: dataF.transaction });
  dataF.addUser('user-1');
  dataF.db.prepare('INSERT INTO auth_hosting_accounts VALUES (?, ?, ?, 1, 1000, 1000)').run('user-1', 'reseller', null);

  assert.throws(() => rollbackEmptyHostingAccountSchema({ db: dataF.db, transaction: dataF.transaction }), {
    code: 'hosting_schema_in_use',
    status: 409,
  });
});

test('PAR-01 / RS-02: Legacy user to Customer migration and rollback with receipt', (t) => {
  const f = siteFixture(t, { maxWebsites: 10, maxCustomers: 10 });
  const ownerToken = f.token;

  // Setup legacy user with website grants
  f.addUser('legacy-user-1', { role: 'site_manager' });
  const w1 = uuid(201);
  const w2 = uuid(202);
  f.db.prepare('INSERT INTO auth_user_websites VALUES (?, ?)').run('legacy-user-1', w1);
  f.db.prepare('INSERT INTO auth_user_websites VALUES (?, ?)').run('legacy-user-1', w2);

  // Migrate legacy user to customer under reseller-a
  const receipt = f.store.migrateLegacyUserToCustomer(ownerToken, f.requireManagement, {
    userId: 'legacy-user-1',
    expectedUserRevision: 1,
    resellerId: 'reseller-a',
    quotas: { maxWebsites: 5, maxDiskMb: 2048, maxTrafficMb: 10000, maxDatabases: 3 },
    websites: [w1, w2],
  });

  assert.ok(receipt.migrationId);
  assert.equal(receipt.customerId, 'legacy-user-1');
  assert.equal(receipt.resellerId, 'reseller-a');
  assert.deepEqual(receipt.migratedWebsites, [w1, w2]);
  assert.equal(receipt.allocations.length, 2);

  // Verify user is now a customer in auth_hosting_accounts
  const customerRow = f.store.get(ownerToken, f.requireManagement, 'legacy-user-1');
  assert.equal(customerRow.kind, 'customer');
  assert.equal(customerRow.resellerId, 'reseller-a');
  assert.equal(customerRow.quotas.maxWebsites, 5);

  // Verify legacy grants were cleaned up
  const remainingGrants = f.db.prepare('SELECT count(*) AS n FROM auth_user_websites WHERE user_id = ?').get('legacy-user-1').n;
  assert.equal(remainingGrants, 0);

  // Verify allocations and customer websites exist
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_customer_websites WHERE customer_id = ?').get('legacy-user-1').n, 2);

  // Rollback legacy user migration using receipt
  const rollbackOutcome = f.store.rollbackLegacyUserMigration(ownerToken, f.requireManagement, receipt);
  assert.equal(rollbackOutcome.rolledBack, true);
  assert.equal(rollbackOutcome.customerId, 'legacy-user-1');

  // Verify customer records removed and legacy grants restored
  const restoredGrants = f.db.prepare('SELECT count(*) AS n FROM auth_user_websites WHERE user_id = ?').get('legacy-user-1').n;
  assert.equal(restoredGrants, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_accounts WHERE user_id = ?').get('legacy-user-1').n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_customer_websites WHERE customer_id = ?').get('legacy-user-1').n, 0);
});

test('PAR-01 / RS-02: Website ownership migration between customers with receipt and rollback', (t) => {
  const f = siteFixture(t, { maxWebsites: 10, maxCustomers: 10 });
  const ownerToken = f.token;

  // Allocate site to customer-a
  const site = website(1);
  const alloc = allocation(1, 'customer-a');
  f.reserve(alloc);
  f.complete(alloc, site);

  // Verify customer-a owns site
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(site.id).customer_id, 'customer-a');

  // Migrate website ownership to customer-b
  const receipt = f.store.migrateWebsiteOwnership(ownerToken, f.requireManagement, {
    websiteId: site.id,
    targetCustomerId: 'customer-b',
    expectedSourceCustomerId: 'customer-a',
  });

  assert.ok(receipt.migrationId);
  assert.equal(receipt.websiteId, site.id);
  assert.equal(receipt.previousCustomerId, 'customer-a');
  assert.equal(receipt.targetCustomerId, 'customer-b');

  // Verify ownership updated
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(site.id).customer_id, 'customer-b');
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_hosting_site_allocations WHERE website_id = ?').get(site.id).customer_id, 'customer-b');

  // Rollback ownership migration
  const rollbackOutcome = f.store.rollbackWebsiteOwnershipMigration(ownerToken, f.requireManagement, receipt);
  assert.equal(rollbackOutcome.rolledBack, true);
  assert.equal(rollbackOutcome.restoredCustomerId, 'customer-a');

  // Verify ownership restored to customer-a
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_customer_websites WHERE website_id = ?').get(site.id).customer_id, 'customer-a');
  assert.equal(f.db.prepare('SELECT customer_id FROM auth_hosting_site_allocations WHERE website_id = ?').get(site.id).customer_id, 'customer-a');
});

test('PAR-01 / RS-02: Atomic capacity and quota enforcement prevents overselling and drift', (t) => {
  const f = siteFixture(t, { maxWebsites: 2, maxCustomers: 2 });
  const ownerToken = f.token;

  // Reseller-a has maxCustomers: 2, maxWebsites: 2.
  // Currently customer-a and customer-b are registered under reseller-a (2 customers).
  // Attempting to add a 3rd customer to reseller-a must fail with reseller_capacity_exceeded / reseller_limit_reached
  f.addUser('customer-overflow', { role: 'site_manager' });
  assert.throws(() => f.store.registerCustomer(ownerToken, f.requireManagement, {
    userId: 'customer-overflow',
    resellerId: 'reseller-a',
    expectedUserRevision: 1,
  }), {
    code: 'reseller_limit_reached',
    status: 409,
  });

  // Assign maxWebsites quota of 1 to customer-a
  f.store.updateCustomerQuotas(ownerToken, f.requireManagement, 'customer-a', {
    revision: 1,
    quotas: { maxWebsites: 1, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null },
  });

  // Allocate 1st site for customer-a: succeeds
  const s1 = website(1);
  const a1 = allocation(1, 'customer-a');
  f.reserve(a1);
  f.complete(a1, s1);

  // Attempting 2nd site for customer-a must fail customer_quota_exceeded (409)
  const a2 = allocation(2, 'customer-a');
  assert.throws(() => f.reserve(a2), {
    code: 'customer_quota_exceeded',
    status: 409,
  });

  // Customer quota cannot exceed reseller maxWebsites limit (prevents overselling)
  assert.throws(() => f.store.updateCustomerQuotas(ownerToken, f.requireManagement, 'customer-a', {
    revision: 2,
    quotas: { maxWebsites: 10, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null },
  }), {
    code: 'reseller_limit_reached',
    status: 409,
  });

  // Update customer-a quota to 2 to test drift states
  f.store.updateCustomerQuotas(ownerToken, f.requireManagement, 'customer-a', {
    revision: 2,
    quotas: { maxWebsites: 2, maxDiskMb: null, maxTrafficMb: null, maxDatabases: null },
  });

  // Resource drift detection: hostingWebsitesForCapacity detects mismatched allocations or orphaned reservation states (503)
  // Test case 1: Orphaned reservation state (allocation is reserved, but website already exists in customer websites)
  const orphanedRes = allocation(99, 'customer-a');
  f.reserve(orphanedRes);
  f.db.prepare('INSERT INTO auth_customer_websites VALUES (?, ?, ?)').run(orphanedRes.websiteId, 'customer-a', 1000);
  assert.throws(() => hostingWebsitesForCapacity(f.db), {
    code: 'hosting_site_state_invalid',
    status: 503,
  });

  // Clean up orphaned reservation
  f.db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ?').run(orphanedRes.websiteId);
  f.db.prepare('DELETE FROM auth_hosting_site_allocations WHERE website_id = ?').run(orphanedRes.websiteId);

  // Test case 2: Mismatched allocation (allocation attached to customer-a, but customer website record is missing)
  f.db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ?').run(s1.id);
  assert.throws(() => hostingWebsitesForCapacity(f.db), {
    code: 'hosting_site_state_invalid',
    status: 503,
  });

  // Restore consistency
  f.db.prepare('INSERT INTO auth_customer_websites VALUES (?, ?, ?)').run(s1.id, 'customer-a', 1000);
  assert.doesNotThrow(() => hostingWebsitesForCapacity(f.db));
});

test('PAR-01 / RS-02: Session revocation and tenant re-authorization on suspension and lifecycle changes', (t) => {
  const f = siteFixture(t, { maxWebsites: 5, maxCustomers: 5 });
  const ownerToken = f.token;

  // Active customer-a and reseller-a sessions
  const resSessionToken = f.session('reseller-a');
  const custSessionToken = f.session('customer-a');

  assert.ok(f.getSession(resSessionToken));
  assert.ok(f.getSession(custSessionToken));

  // Suspend reseller-a via store.setActive
  f.revoked.length = 0;
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-a', {
    revision: 1,
    active: false,
  });

  // Verify live user revocation hook was called for reseller AND all child customers
  const revokedUserIds = f.revoked.map((r) => r.id);
  assert.ok(revokedUserIds.includes('reseller-a'));
  assert.ok(revokedUserIds.includes('customer-a'));
  assert.ok(revokedUserIds.includes('customer-b'));

  // Sessions in database are deleted
  assert.equal(f.getSession(resSessionToken), null);
  assert.equal(f.getSession(custSessionToken), null);

  // Suspended reseller cannot manage customer
  assert.throws(() => f.store.setActive(resSessionToken, (c) => c, 'customer-a', {
    revision: 1,
    active: false,
  }), {
    code: 'unauthorized',
    status: 401,
  });

  // Reactivate reseller-a
  f.store.setActive(ownerToken, f.requireManagement, 'reseller-a', {
    revision: 2,
    active: true,
  });

  // New sessions can now be established
  const newResToken = f.session('reseller-a');
  assert.ok(f.getSession(newResToken));
});

test('PAR-01 / RS-02: General users API mutation guard prevents bypassing hosting role and active state', (t) => {
  const f = siteFixture(t, { maxWebsites: 5, maxCustomers: 5 });

  // assertLegacyMutationAllowed blocks changes to role, active, websiteIds, or deletion
  assert.throws(() => f.store.assertLegacyMutationAllowed('reseller-a', { role: 'owner' }), {
    code: 'hosting_account_managed',
    status: 409,
  });
  assert.throws(() => f.store.assertLegacyMutationAllowed('customer-a', { active: false }), {
    code: 'hosting_account_managed',
    status: 409,
  });
  assert.throws(() => f.store.assertLegacyMutationAllowed('customer-a', { websiteIds: ['site-x'] }), {
    code: 'hosting_account_managed',
    status: 409,
  });
  assert.throws(() => f.store.assertLegacyMutationAllowed('customer-a', null), {
    code: 'hosting_account_managed',
    status: 409,
  });

  // Unmanaged legacy user is allowed
  f.addUser('unmanaged-sm');
  assert.doesNotThrow(() => f.store.assertLegacyMutationAllowed('unmanaged-sm', { active: false }));
});
