import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { createHostingAccountStore } from '../src/hosting-account-store.js';

const credentials = {
  hashPassword: async (pass) => `fixture-hash:${pass}`,
  normalizeUsername: (name) => name.trim().toLowerCase(),
};

function setupFixture(options = {}) {
  const f = hostingAuthFixture();
  f.addUser('owner', { role: 'owner' });
  const ownerToken = f.session('owner');
  const store = createHostingAccountStore({
    ...f,
    ...credentials,
    ...options,
  });

  const createReseller = (id, limits = { maxCustomers: 5, maxWebsites: 10 }) => {
    f.addUser(id, { role: 'site_manager' });
    store.registerReseller(ownerToken, f.requireManagement, {
      userId: id,
      expectedUserRevision: 1,
      limits,
    });
    return f.session(id);
  };

  const createCustomer = (id, resellerId = null, quotas = { maxWebsites: 2, maxDiskMb: 1024, maxTrafficMb: 5000, maxDatabases: 2 }) => {
    f.addUser(id, { role: 'site_manager' });
    store.registerCustomer(ownerToken, f.requireManagement, {
      userId: id,
      expectedUserRevision: 1,
      resellerId,
      quotas,
    });
    return f.session(id);
  };

  return { ...f, ownerToken, store, createReseller, createCustomer };
}

test('PAR-02 Acceptance 1: Owner manages resellers and customers (creation, limits, quotas, listing, detail)', async () => {
  const f = setupFixture();

  f.addUser('reseller-1', { role: 'site_manager' });
  f.addUser('cust-direct', { role: 'site_manager' });
  f.addUser('cust-child', { role: 'site_manager' });

  // Owner registers reseller-1
  const res1 = f.store.registerReseller(f.ownerToken, f.requireManagement, {
    userId: 'reseller-1',
    expectedUserRevision: 1,
    limits: { maxCustomers: 3, maxWebsites: 6 },
  });
  assert.equal(res1.id, 'reseller-1');
  assert.equal(res1.kind, 'reseller');
  assert.equal(res1.limits.maxCustomers, 3);
  assert.equal(res1.limits.maxWebsites, 6);

  // Owner registers direct customer
  const directCust = f.store.registerCustomer(f.ownerToken, f.requireManagement, {
    userId: 'cust-direct',
    expectedUserRevision: 1,
    resellerId: null,
    quotas: { maxWebsites: 5, maxDiskMb: 2048, maxTrafficMb: 10000, maxDatabases: 3 },
  });
  assert.equal(directCust.id, 'cust-direct');
  assert.equal(directCust.kind, 'customer');
  assert.equal(directCust.resellerId, null);
  assert.equal(directCust.quotas.maxWebsites, 5);

  // Owner registers customer under reseller-1
  const childCust = f.store.registerCustomer(f.ownerToken, f.requireManagement, {
    userId: 'cust-child',
    expectedUserRevision: 1,
    resellerId: 'reseller-1',
    quotas: { maxWebsites: 2, maxDiskMb: 1024, maxTrafficMb: 5000, maxDatabases: 1 },
  });
  assert.equal(childCust.id, 'cust-child');
  assert.equal(childCust.kind, 'customer');
  assert.equal(childCust.resellerId, 'reseller-1');

  // Owner updates limits for reseller-1
  const updatedRes1 = f.store.updateLimits(f.ownerToken, f.requireManagement, 'reseller-1', {
    revision: res1.revision,
    limits: { maxCustomers: 5, maxWebsites: 12 },
  });
  assert.equal(updatedRes1.limits.maxCustomers, 5);
  assert.equal(updatedRes1.limits.maxWebsites, 12);

  // Owner updates quotas for childCust
  const updatedChildCust = f.store.updateCustomerQuotas(f.ownerToken, f.requireManagement, 'cust-child', {
    revision: childCust.revision,
    quotas: { maxWebsites: 4, maxDiskMb: 2048, maxTrafficMb: 8000, maxDatabases: 2 },
  });
  assert.equal(updatedChildCust.quotas.maxWebsites, 4);

  // Owner lists all accounts
  const allAccounts = f.store.list(f.ownerToken, f.requireManagement);
  assert.equal(allAccounts.total, 3);
  assert.deepEqual(allAccounts.accounts.map((a) => a.id).sort(), ['cust-child', 'cust-direct', 'reseller-1']);

  // Owner filters by direct customers
  const directList = f.store.list(f.ownerToken, f.requireManagement, { kind: 'customer', resellerId: null });
  assert.equal(directList.total, 1);
  assert.equal(directList.accounts[0].id, 'cust-direct');

  // Owner filters by reseller-1's customers
  const res1List = f.store.list(f.ownerToken, f.requireManagement, { kind: 'customer', resellerId: 'reseller-1' });
  assert.equal(res1List.total, 1);
  assert.equal(res1List.accounts[0].id, 'cust-child');

  // Owner views individual account detail
  const detail = f.store.get(f.ownerToken, f.requireManagement, 'reseller-1');
  assert.equal(detail.id, 'reseller-1');
  assert.equal(detail.usage.customers, 1);
});

test('PAR-02 Acceptance 2: Reseller manages only direct-child customers and their attached sites', async () => {
  const f = setupFixture();
  const tokenRes1 = f.createReseller('reseller-1', { maxCustomers: 2, maxWebsites: 5 });
  const tokenRes2 = f.createReseller('reseller-2', { maxCustomers: 2, maxWebsites: 5 });
  f.createCustomer('cust-direct', null);
  f.createCustomer('cust-res1-a', 'reseller-1');
  f.createCustomer('cust-res2-a', 'reseller-2');

  // Reseller-1 lists accounts: sees ONLY their own direct customers
  const listRes1 = f.store.list(tokenRes1, f.requireManagement);
  assert.equal(listRes1.total, 1);
  assert.deepEqual(listRes1.accounts.map((a) => a.id), ['cust-res1-a']);

  // Reseller-1 gets detail of own child customer
  const ownChild = f.store.get(tokenRes1, f.requireManagement, 'cust-res1-a');
  assert.equal(ownChild.id, 'cust-res1-a');
  assert.equal(ownChild.resellerId, 'reseller-1');

  // Reseller-1 creates customer login for new child customer
  const createdLogin = await f.store.createCustomerLogin(tokenRes1, f.requireManagement, {
    username: 'cust-res1-b',
    password: 'Password123456!',
    quotas: { maxWebsites: 2, maxDiskMb: 512, maxTrafficMb: 2000, maxDatabases: 1 },
  });
  assert.equal(createdLogin.kind, 'customer');
  assert.equal(createdLogin.resellerId, 'reseller-1');

  // Reseller-1 cannot exceed maxCustomers capacity (was 2, now 2)
  await assert.rejects(
    () => f.store.createCustomerLogin(tokenRes1, f.requireManagement, {
      username: 'cust-res1-c',
      password: 'Password123456!',
    }),
    { code: 'reseller_limit_reached', status: 409 },
  );

  // Reseller-1 updates own child customer login (username and password)
  const updatedLogin = await f.store.updateCustomerLogin(tokenRes1, f.requireManagement, createdLogin.id, {
    revision: createdLogin.revision,
    username: 'cust-res1-b-renamed',
    password: 'NewPassword123456!',
  });
  assert.equal(updatedLogin.id, createdLogin.id);

  // Reseller-1 updates child customer quotas within reseller capacity
  const updatedQuotas = f.store.updateCustomerQuotas(tokenRes1, f.requireManagement, createdLogin.id, {
    revision: updatedLogin.revision,
    quotas: { maxWebsites: 3, maxDiskMb: 1024, maxTrafficMb: 4000, maxDatabases: 2 },
  });
  assert.equal(updatedQuotas.quotas.maxWebsites, 3);

  // Reseller-1 cannot assign customer quota exceeding reseller limits (maxWebsites: 5)
  assert.throws(
    () => f.store.updateCustomerQuotas(tokenRes1, f.requireManagement, createdLogin.id, {
      revision: updatedQuotas.revision,
      quotas: { maxWebsites: 10, maxDiskMb: 1024, maxTrafficMb: 4000, maxDatabases: 2 },
    }),
    { code: 'reseller_limit_reached', status: 409 },
  );
});

test('PAR-02 Acceptance 3: Cross-tenant operations fail closed (403 reseller_scope_forbidden) without leaking foreign metadata', async () => {
  const f = setupFixture();
  const tokenRes1 = f.createReseller('reseller-1');
  f.createReseller('reseller-2');
  f.createCustomer('cust-direct', null);
  f.createCustomer('cust-res1-a', 'reseller-1');
  f.createCustomer('cust-res2-a', 'reseller-2');

  // Reseller-1 cannot get foreign reseller
  assert.throws(
    () => f.store.get(tokenRes1, f.requireManagement, 'reseller-2'),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller-1 cannot get foreign customer
  assert.throws(
    () => f.store.get(tokenRes1, f.requireManagement, 'cust-res2-a'),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller-1 cannot get direct Owner customer
  assert.throws(
    () => f.store.get(tokenRes1, f.requireManagement, 'cust-direct'),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller-1 cannot list foreign reseller's customers
  assert.throws(
    () => f.store.list(tokenRes1, f.requireManagement, { kind: 'customer', resellerId: 'reseller-2' }),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller-1 cannot list direct customers
  assert.throws(
    () => f.store.list(tokenRes1, f.requireManagement, { kind: 'customer', resellerId: null }),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );

  // Reseller-1 cannot register new reseller
  assert.throws(
    () => f.store.registerReseller(tokenRes1, f.requireManagement, { userId: 'reseller-3', expectedUserRevision: 1, limits: { maxCustomers: 1, maxWebsites: 1 } }),
    (err) => err instanceof AuthError && (err.code === 'forbidden' || err.code === 'reseller_scope_forbidden') && err.status === 403,
  );

  // Reseller-1 cannot update reseller limits
  assert.throws(
    () => f.store.updateLimits(tokenRes1, f.requireManagement, 'reseller-1', { revision: 1, limits: { maxCustomers: 10, maxWebsites: 10 } }),
    (err) => err instanceof AuthError && err.code === 'forbidden' && err.status === 403,
  );

  // Reseller-1 cannot update quotas of foreign customer
  assert.throws(
    () => f.store.updateCustomerQuotas(tokenRes1, f.requireManagement, 'cust-res2-a', { revision: 1, quotas: { maxWebsites: 1, maxDiskMb: 100, maxTrafficMb: 100, maxDatabases: 1 } }),
    (err) => err instanceof AuthError && err.code === 'reseller_scope_forbidden' && err.status === 403,
  );
});

test('PAR-02 Acceptance 4: Suspension (askı) prevents customer/reseller access while retaining existing data and configurations', async () => {
  const f = setupFixture();
  const tokenRes1 = f.createReseller('reseller-1');
  const tokenCust1 = f.createCustomer('cust-res1-a', 'reseller-1');
  f.db.exec("INSERT INTO auth_customer_websites (website_id, customer_id, created_at) VALUES ('site-res1-a', 'cust-res1-a', 1000)");

  // 1. Reseller suspends own child customer
  const childAcc = f.store.get(tokenRes1, f.requireManagement, 'cust-res1-a');
  const suspendedCust = f.store.setActive(tokenRes1, f.requireManagement, 'cust-res1-a', {
    revision: childAcc.revision,
    active: false,
  });
  assert.equal(suspendedCust.active, false);

  // Customer session was revoked
  const revokedCustSession = f.revoked.find((r) => r.id === 'cust-res1-a' && r.reason === 'hosting_account_suspended');
  assert.ok(revokedCustSession);
  assert.equal(revokedCustSession.reason, 'hosting_account_suspended');

  // Customer cannot log in or perform actions (session invalid)
  assert.equal(f.getSession(tokenCust1), null);

  // But customer websites and quotas are strictly RETAINED intact in the database
  const siteAttached = f.db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?').get('site-res1-a', 'cust-res1-a');
  assert.ok(siteAttached);
  const quotasRetained = f.db.prepare('SELECT * FROM auth_customer_quotas WHERE customer_id = ?').get('cust-res1-a');
  assert.ok(quotasRetained);
  assert.equal(quotasRetained.max_websites, 2);

  // Reactivating customer restores active state
  const reactivatedCust = f.store.setActive(tokenRes1, f.requireManagement, 'cust-res1-a', {
    revision: suspendedCust.revision,
    active: true,
  });
  assert.equal(reactivatedCust.active, true);

  // 2. Owner suspends reseller: cascades session invalidation to child customers
  const resAcc = f.store.get(f.ownerToken, f.requireManagement, 'reseller-1');
  const suspendedRes = f.store.setActive(f.ownerToken, f.requireManagement, 'reseller-1', {
    revision: resAcc.revision,
    active: false,
  });
  assert.equal(suspendedRes.active, false);

  // Reseller session revoked
  assert.ok(f.revoked.some((r) => r.id === 'reseller-1' && r.reason === 'hosting_account_suspended'));
  // Child customer session revoked due to parent suspension
  assert.ok(f.revoked.some((r) => r.id === 'cust-res1-a' && r.reason === 'hosting_parent_suspended'));

  // Suspended reseller cannot perform management mutations
  assert.throws(
    () => f.store.list(tokenRes1, f.requireManagement),
    (err) => err instanceof AuthError && (err.code === 'reseller_scope_forbidden' || err.code === 'unauthorized'),
  );

  // Child customer data and sites remain intact
  const siteStillAttached = f.db.prepare('SELECT 1 FROM auth_customer_websites WHERE website_id = ? AND customer_id = ?').get('site-res1-a', 'cust-res1-a');
  assert.ok(siteStillAttached);
});

test('PAR-02 Acceptance 5: Safe deletion blocking prevents deleting customer or reseller entities while attached active resources exist', async () => {
  let activeCheckerState = { blocked: false, resource: '' };
  const f = setupFixture({
    activeResourceChecker: (ctx) => {
      if (activeCheckerState.blocked) {
        return { safe: false, blocked: true, resource: activeCheckerState.resource };
      }
      return { safe: true };
    },
  });

  const tokenRes1 = f.createReseller('reseller-1');
  const tokenCust1 = f.createCustomer('cust-res1-a', 'reseller-1');

  // --- Reseller safe deletion blocking ---
  // Attempting to unregister reseller with child customers is blocked (409)
  const resAcc = f.store.get(f.ownerToken, f.requireManagement, 'reseller-1');
  assert.throws(
    () => f.store.unregister(f.ownerToken, f.requireManagement, 'reseller-1', { revision: resAcc.revision }),
    { code: 'hosting_account_in_use', status: 409 },
  );

  // --- Customer safe deletion blocking via attached websites ---
  f.db.exec("INSERT INTO auth_customer_websites (website_id, customer_id, created_at) VALUES ('site-res1-a', 'cust-res1-a', 1000)");
  const custAcc = f.store.get(f.ownerToken, f.requireManagement, 'cust-res1-a');

  // unregister blocked by attached website
  assert.throws(
    () => f.store.unregister(f.ownerToken, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision }),
    { code: 'hosting_account_in_use', status: 409 },
  );

  // deleteCustomerLogin blocked by attached website
  await assert.rejects(
    () => f.store.deleteCustomerLogin(tokenRes1, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision }),
    { code: 'hosting_account_in_use', status: 409 },
  );

  // Detach website from auth_customer_websites
  f.db.exec("DELETE FROM auth_customer_websites WHERE customer_id = 'cust-res1-a'");

  // --- Customer safe deletion blocking via active domains ---
  activeCheckerState = { blocked: true, resource: 'domains' };
  await assert.rejects(
    () => f.store.deleteCustomerLogin(tokenRes1, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision }),
    (err) => err instanceof AuthError && err.code === 'hosting_account_in_use' && err.message.includes('domains'),
  );

  // --- Customer safe deletion blocking via active databases ---
  activeCheckerState = { blocked: true, resource: 'databases' };
  await assert.rejects(
    () => f.store.deleteCustomerLogin(tokenRes1, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision }),
    (err) => err instanceof AuthError && err.code === 'hosting_account_in_use' && err.message.includes('databases'),
  );

  // --- Customer safe deletion blocking via active mailboxes ---
  activeCheckerState = { blocked: true, resource: 'mailboxes' };
  await assert.rejects(
    () => f.store.deleteCustomerLogin(tokenRes1, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision }),
    (err) => err instanceof AuthError && err.code === 'hosting_account_in_use' && err.message.includes('mailboxes'),
  );

  // Clear all blockers: now safe deletion succeeds
  activeCheckerState = { blocked: false, resource: '' };
  const deleteResult = await f.store.deleteCustomerLogin(tokenRes1, f.requireManagement, 'cust-res1-a', { revision: custAcc.revision });
  assert.deepEqual(deleteResult, { id: 'cust-res1-a', deleted: true });

  // Customer record and quotas deleted
  assert.equal(f.db.prepare('SELECT 1 FROM users WHERE id = ?').get('cust-res1-a'), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM auth_hosting_accounts WHERE user_id = ?').get('cust-res1-a'), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM auth_customer_quotas WHERE customer_id = ?').get('cust-res1-a'), undefined);

  // Now reseller has 0 child customers: reseller unregister succeeds
  const unregisterResResult = f.store.unregister(f.ownerToken, f.requireManagement, 'reseller-1', { revision: resAcc.revision });
  assert.deepEqual(unregisterResResult, { id: 'reseller-1', unregistered: true });
});

test('PAR-02 Acceptance 6: Deferred full-parity features remain excluded (multi-tier reseller chains, overselling)', async () => {
  const f = setupFixture();
  f.createReseller('reseller-1', { maxCustomers: 2, maxWebsites: 4 });

  f.addUser('reseller-2', { role: 'site_manager' });
  f.addUser('cust-oversell', { role: 'site_manager' });

  // Multi-tier reseller chains: reseller cannot be registered with a resellerId
  assert.throws(
    () => f.store.registerReseller(f.ownerToken, f.requireManagement, {
      userId: 'reseller-2',
      expectedUserRevision: 1,
      resellerId: 'reseller-1',
      limits: { maxCustomers: 1, maxWebsites: 1 },
    }),
    { code: 'invalid_hosting_account_input' },
  );

  // Overselling: cannot create customer with maxWebsites > reseller maxWebsites
  assert.throws(
    () => f.store.registerCustomer(f.ownerToken, f.requireManagement, {
      userId: 'cust-oversell',
      expectedUserRevision: 1,
      resellerId: 'reseller-1',
      quotas: { maxWebsites: 10, maxDiskMb: 1024, maxTrafficMb: 5000, maxDatabases: 2 },
    }),
    { code: 'reseller_limit_reached', status: 409 },
  );
});
