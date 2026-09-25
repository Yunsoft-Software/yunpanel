import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';

const code = (expected) => (error) => error.code === expected;
function setup(t, options = {}) {
  const f = hostingAuthFixture();
  t.after(() => f.db.close());
  f.addUser('owner', { role: 'owner' });
  for (const id of ['reseller-a', 'reseller-b', 'customer-a', 'customer-b', 'customer-c', 'direct', 'legacy']) f.addUser(id);
  f.addUser('viewer', { role: 'read_only' });
  f.token = f.session('owner');
  const dependencies = { ...f, ...options };
  f.store = createHostingAccountStore(dependencies);
  f.reseller = (id = 'reseller-a', limits = { maxCustomers: 2, maxWebsites: 3 }) => f.store.registerReseller(f.token, f.requireManagement, { userId: id, expectedUserRevision: 1, limits });
  f.customer = (id = 'customer-a', resellerId = 'reseller-a') => f.store.registerCustomer(f.token, f.requireManagement, { userId: id, expectedUserRevision: 1, resellerId });
  f.get = (id = 'reseller-a') => f.store.get(f.token, f.requireManagement, id);
  return f;
}

test('profile uses the existing login ID without changing its password, role or grants', (t) => {
  const f = setup(t);
  const before = f.db.prepare('SELECT * FROM users').all();
  const result = f.reseller();
  assert.equal(result.id, 'reseller-a'); assert.equal(result.stage, 'profile_only');
  assert.equal(result.userRevision, 2); assert.equal(result.revision, 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_user_websites').get().n, 0);
  assert.doesNotMatch(JSON.stringify(result), /fixture-hash|token-|secret|password_hash/);
});
test('registration revokes only target sessions and pending MFA, preserves enrollment, and notifies after commit', (t) => {
  const f = setup(t); const targetToken = f.session('reseller-a');
  const otherToken = f.session('reseller-b');
  f.db.exec("INSERT INTO fixture_pending_mfa VALUES ('reseller-a'); INSERT INTO auth_mfa VALUES ('reseller-a', 'fixture-enrollment');");
  const store = createHostingAccountStore({ ...f, revokeLiveUser: (id, reason) => {
    assert.equal(f.getSession(targetToken), null);
    f.transaction(() => assert.equal(f.db.prepare('SELECT user_id FROM auth_hosting_accounts WHERE user_id = ?').get(id).user_id, id));
    f.revoked.push({ id, reason });
  } });
  store.registerReseller(f.token, f.requireManagement, { userId: 'reseller-a', expectedUserRevision: 1, limits: { maxCustomers: 2, maxWebsites: 3 } });
  assert.ok(f.getSession(otherToken)); assert.ok(f.getSession(f.token));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_pending_mfa').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_mfa').get().n, 1);
  assert.deepEqual(f.revoked, [{ id: 'reseller-a', reason: 'hosting_account_linked' }]);
});
test('active status is read from users, not supplied as profile data', (t) => {
  const f = setup(t); f.db.exec("UPDATE users SET active = 0 WHERE id = 'customer-a'");
  f.reseller(); assert.equal(f.customer().active, false);
});
test('Owner can suspend and reactivate a hosting account without changing profile identity', (t) => {
  const f = setup(t);
  const profile = f.customer('direct', null);
  const targetToken = f.session('direct');
  f.db.exec("INSERT INTO fixture_pending_mfa VALUES ('direct'); INSERT INTO auth_mfa VALUES ('direct', 'fixture-enrollment');");
  f.revoked.length = 0;

  const suspended = f.store.setActive(f.token, f.requireManagement, 'direct', {
    revision: profile.revision,
    active: false,
  });
  assert.equal(suspended.active, false);
  assert.equal(suspended.revision, 2);
  assert.equal(suspended.userRevision, 3);
  assert.equal(f.getSession(targetToken), null);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'direct'").get().active, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM fixture_pending_mfa WHERE user_id = 'direct'").get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM auth_mfa WHERE user_id = 'direct'").get().n, 1);
  assert.deepEqual(f.revoked, [{ id: 'direct', reason: 'hosting_account_suspended' }]);

  const staleWhileInactive = f.session('direct');
  assert.equal(f.getSession(staleWhileInactive), null);
  f.revoked.length = 0;
  const reactivated = f.store.setActive(f.token, f.requireManagement, 'direct', {
    revision: suspended.revision,
    active: true,
  });
  assert.equal(reactivated.active, true);
  assert.equal(reactivated.revision, 3);
  assert.equal(reactivated.userRevision, 4);
  assert.equal(f.getSession(staleWhileInactive), null);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'direct'").get().active, 1);
  assert.deepEqual(f.revoked, [{ id: 'direct', reason: 'hosting_account_reactivated' }]);
});

test('suspending a reseller revokes descendant sessions without silently disabling customer accounts or sites', (t) => {
  const f = setup(t);
  const reseller = f.reseller();
  f.customer('customer-a', 'reseller-a');
  f.customer('customer-b', 'reseller-a');
  f.customer('direct', null);
  const resellerToken = f.session('reseller-a');
  const customerAToken = f.session('customer-a');
  const customerBToken = f.session('customer-b');
  const directToken = f.session('direct');
  f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'customer-a', 1000)");
  f.revoked.length = 0;

  const result = f.store.setActive(f.token, f.requireManagement, 'reseller-a', {
    revision: reseller.revision,
    active: false,
  });
  assert.equal(result.active, false);
  assert.equal(f.getSession(resellerToken), null);
  assert.equal(f.getSession(customerAToken), null);
  assert.equal(f.getSession(customerBToken), null);
  assert.ok(f.getSession(directToken));
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'customer-a'").get().active, 1);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'customer-b'").get().active, 1);
  assert.equal(f.db.prepare("SELECT customer_id FROM auth_customer_websites WHERE website_id = 'site-a'").get().customer_id, 'customer-a');
  assert.deepEqual(f.revoked, [
    { id: 'reseller-a', reason: 'hosting_account_suspended' },
    { id: 'customer-a', reason: 'hosting_parent_suspended' },
    { id: 'customer-b', reason: 'hosting_parent_suspended' },
  ]);
});

test('unchanged hosting active state is a no-op without revision, session or audit churn', (t) => {
  const f = setup(t);
  const reseller = f.reseller();
  const targetToken = f.session('reseller-a');
  f.revoked.length = 0;
  const audits = f.db.prepare('SELECT count(*) AS n FROM fixture_audit').get().n;
  const same = f.store.setActive(f.token, f.requireManagement, 'reseller-a', {
    revision: reseller.revision,
    active: true,
  });
  assert.equal(same.revision, reseller.revision);
  assert.ok(f.getSession(targetToken));
  assert.deepEqual(f.revoked, []);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_audit').get().n, audits);
});

test('hosting lifecycle validates revision, active value and mass-assignment fields', (t) => {
  const f = setup(t); f.reseller();
  assert.throws(() => f.store.setActive(f.token, f.requireManagement, 'reseller-a', { revision: 2, active: false }), code('hosting_account_revision_conflict'));
  assert.throws(() => f.store.setActive(f.token, f.requireManagement, 'reseller-a', { revision: 1, active: 0 }), code('invalid_active'));
  assert.throws(() => f.store.setActive(f.token, f.requireManagement, 'reseller-a', { revision: 1, active: false, role: 'owner' }), code('invalid_hosting_account_input'));
});

test('hosting lifecycle audit failure rolls back active state, revision, sessions and lifecycle intent', (t) => {
  const f = setup(t);
  const reseller = f.reseller();
  const targetToken = f.session('reseller-a');
  f.revoked.length = 0;
  const store = createHostingAccountStore({ ...f, audit: () => { throw new Error('audit unavailable'); } });
  assert.throws(
    () => store.setActive(f.token, f.requireManagement, 'reseller-a', { revision: reseller.revision, active: false }),
    /audit unavailable/,
  );
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'reseller-a'").get().active, 1);
  assert.equal(f.get().revision, reseller.revision);
  assert.ok(f.getSession(targetToken));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_lifecycle_intents').get().n, 0);
  assert.deepEqual(f.revoked, []);
});

for (const extra of ['role', 'actor', 'active', 'websiteIds', 'customerCount', 'resellerId']) {
  test(`reseller registration rejects mass-assignment field ${extra}`, (t) => {
    const f = setup(t);
    assert.throws(() => f.store.registerReseller(f.token, f.requireManagement, {
      userId: 'reseller-a', expectedUserRevision: 1, limits: { maxCustomers: 2, maxWebsites: 3 }, [extra]: 'spoofed',
    }), code('invalid_hosting_account_input'));
  });
}
for (const input of [null, [], {}, { userId: 'reseller-a', limits: { maxCustomers: 2, maxWebsites: 3 } }]) {
  test(`invalid/incomplete registration is rejected: ${JSON.stringify(input)}`, (t) => {
    const f = setup(t);
    assert.throws(() => f.store.registerReseller(f.token, f.requireManagement, input), code('invalid_hosting_account_input'));
  });
}
for (const id of ['owner', 'viewer']) {
  test(`profile cannot elevate or reinterpret ${id}`, (t) => {
    const f = setup(t);
    assert.throws(() => f.reseller(id), code('hosting_profile_requires_site_manager'));
  });
}
test('duplicate profile and stale login revision are explicit conflicts', (t) => {
  const f = setup(t); f.reseller();
  assert.throws(() => f.reseller(), code('user_revision_conflict'));
  assert.throws(() => f.store.registerReseller(f.token, f.requireManagement, {
    userId: 'reseller-a', expectedUserRevision: 2, limits: { maxCustomers: null, maxWebsites: null },
  }), code('hosting_account_exists'));
});
test('legacy Website membership is not silently converted into ownership', (t) => {
  const f = setup(t); f.db.exec("INSERT INTO auth_user_websites VALUES ('legacy', 'site-old')");
  assert.throws(() => f.reseller('legacy'), code('hosting_site_migration_required'));
  assert.equal(f.db.prepare('SELECT website_id FROM auth_user_websites').get().website_id, 'site-old');
});
test('owner can register direct customers without a reseller or subscription', (t) => {
  const f = setup(t); const customer = f.customer('direct', null);
  assert.equal(customer.resellerId, null); assert.equal(customer.kind, 'customer');
});
test('customer registration requires an explicit parent or null', (t) => {
  const f = setup(t);
  assert.throws(() => f.store.registerCustomer(f.token, f.requireManagement, { userId: 'direct', expectedUserRevision: 1 }), code('invalid_hosting_account_input'));
});
test('customer cannot be a parent and inactive resellers cannot receive customers', (t) => {
  const f = setup(t); f.customer('direct', null);
  assert.throws(() => f.customer('customer-a', 'direct'), code('invalid_reseller_record'));
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'reseller-a'"); f.reseller();
  assert.throws(() => f.customer(), code('reseller_scope_forbidden'));
});
test('customer limits are enforced from persisted state, including inactive children', (t) => {
  const f = setup(t); f.db.exec("UPDATE users SET active = 0 WHERE id = 'customer-a'");
  f.reseller('reseller-a', { maxCustomers: 1, maxWebsites: 0 }); f.customer();
  assert.throws(() => f.customer('customer-b'), code('reseller_limit_reached'));
  assert.equal(f.get().usage.customers, 1);
  assert.equal(f.db.prepare("SELECT revision FROM auth_user_revisions WHERE user_id = 'customer-b'").get(), undefined);
});
test('different resellers and direct customers do not consume each other\'s allowance', (t) => {
  const f = setup(t); f.reseller('reseller-a', { maxCustomers: 1, maxWebsites: 3 }); f.reseller('reseller-b');
  f.customer('customer-a', 'reseller-b'); f.customer('direct', null); f.customer('customer-b');
  assert.equal(f.get('reseller-a').usage.customers, 1); assert.equal(f.get('reseller-b').usage.customers, 1);
});
test('registered Website usage is explicit ownership, not a pagination count or legacy membership', (t) => {
  const f = setup(t); f.reseller(); f.customer(); f.customer('direct', null);
  f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'customer-a', 1000), ('site-direct', 'direct', 1000); INSERT INTO auth_user_websites VALUES ('legacy', 'legacy-site')");
  assert.deepEqual(f.get().usage, { customers: 1, websites: 1 });
  assert.equal(f.get().usageScope, 'registered_ownership');
});
test('zero limit forbids addition; explicit null allows it', (t) => {
  const f = setup(t); f.reseller('reseller-a', { maxCustomers: 0, maxWebsites: 0 });
  assert.throws(() => f.customer(), code('reseller_limit_reached'));
  f.store.updateLimits(f.token, f.requireManagement, 'reseller-a', { revision: 1, limits: { maxCustomers: null, maxWebsites: null } });
  assert.equal(f.customer().kind, 'customer');
});
for (const limits of [{}, { maxCustomers: 2 }, { maxCustomers: -1, maxWebsites: 2 }, { maxCustomers: '2', maxWebsites: 2 }]) {
  test(`incomplete/invalid limits cannot become unlimited: ${JSON.stringify(limits)}`, (t) => {
    const f = setup(t);
    assert.throws(() => f.reseller('reseller-a', limits), code('invalid_reseller_limits'));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_accounts').get().n, 0);
  });
}
test('reducing limits preserves existing accounts and blocks new additions', (t) => {
  const f = setup(t); f.reseller(); f.customer(); f.customer('customer-b');
  const next = f.store.updateLimits(f.token, f.requireManagement, 'reseller-a', { revision: 1, limits: { maxCustomers: 1, maxWebsites: 0 } });
  assert.equal(next.revision, 2); assert.equal(next.usage.customers, 2);
  assert.throws(() => f.customer('customer-c'), code('reseller_limit_reached'));
});
test('stale limit writes and ownership fields are rejected; unchanged limits do not generate revisions', (t) => {
  const f = setup(t); const initial = f.reseller();
  assert.equal(f.store.updateLimits(f.token, f.requireManagement, initial.id, { revision: 1, limits: initial.limits }).revision, 1);
  f.store.updateLimits(f.token, f.requireManagement, initial.id, { revision: 1, limits: { maxCustomers: 3, maxWebsites: 3 } });
  assert.throws(() => f.store.updateLimits(f.token, f.requireManagement, initial.id, { revision: 1, limits: initial.limits }), code('hosting_account_revision_conflict'));
  assert.throws(() => f.store.updateLimits(f.token, f.requireManagement, initial.id, { revision: 2, limits: initial.limits, resellerId: null }), code('invalid_hosting_account_input'));
});
test('a customer has no reseller quota editor', (t) => {
  const f = setup(t); f.customer('direct', null);
  assert.throws(() => f.store.updateLimits(f.token, f.requireManagement, 'direct', { revision: 1, limits: { maxCustomers: 2, maxWebsites: 2 } }), code('invalid_reseller_record'));
});
test('list filters parent in SQL and applies stable, bounded pagination', (t) => {
  const f = setup(t); f.reseller(); f.reseller('reseller-b'); f.customer(); f.customer('customer-b'); f.customer('direct', null);
  const result = f.store.list(f.token, f.requireManagement, { kind: 'customer', resellerId: 'reseller-a', limit: 1, offset: 1 });
  assert.equal(result.total, 2); assert.deepEqual(result.accounts.map((item) => item.id), ['customer-b']);
  assert.deepEqual(f.store.list(f.token, f.requireManagement, { kind: 'customer', resellerId: null }).accounts.map((item) => item.id), ['direct']);
});
for (const input of [{ limit: 101 }, { offset: -1 }, { limit: '2' }, { kind: 'owner' }, { resellerId: null }, { kind: 'customer', resellerId: '' }, { actor: 'owner' }]) {
  test(`invalid list filter is rejected: ${JSON.stringify(input)}`, (t) => {
    const f = setup(t); assert.throws(() => f.store.list(f.token, f.requireManagement, input));
  });
}
for (const name of ['registerReseller', 'registerCustomer', 'get', 'list', 'updateLimits', 'setActive', 'unregister']) {
  test(`${name} is Owner-only even with valid existing profile IDs`, (t) => {
    const f = setup(t); f.reseller();
    const viewer = f.session('viewer'); const reseller = f.session('reseller-a');
    for (const token of [viewer, reseller]) assert.throws(() => f.store[name](token, f.requireManagement, 'reseller-a', {}), code('forbidden'));
    assert.throws(() => f.store[name]('unknown-token', f.requireManagement, 'reseller-a', {}), code('unauthorized'));
  });
}
test('a forged policy return cannot turn an absent or site-scoped session into Owner', (t) => {
  const f = setup(t); f.reseller();
  const forged = () => ({ id: 'forged', user: { id: 'owner', role: 'owner' } });
  assert.throws(() => f.store.get(null, forged, 'reseller-a'), code('forbidden'));
  assert.throws(() => f.store.get(f.session('customer-a'), forged, 'reseller-a'), code('forbidden'));
});
test('revoked Owner sessions and policy/MFA denial cannot use previously loaded records', (t) => {
  const f = setup(t); f.reseller();
  f.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(f.token);
  assert.throws(() => f.get(), code('unauthorized'));
  f.token = f.session('owner');
  assert.throws(() => f.store.get(f.token, () => { throw new Error('MFA required'); }, 'reseller-a'), /MFA required/);
});
test('missing persisted limits are an error, never unlimited or zero usage', (t) => {
  const f = setup(t); f.reseller(); f.db.exec('DELETE FROM auth_reseller_limits');
  assert.throws(() => f.get(), code('hosting_account_state_invalid'));
  assert.throws(() => f.customer(), code('hosting_account_state_invalid'));
});
test('audit failure rolls back account, quota slot, revision and session/MFA deletion', (t) => {
  const f = setup(t); f.reseller(); const token = f.session('customer-a');
  f.db.exec("INSERT INTO fixture_pending_mfa VALUES ('customer-a')");
  const store = createHostingAccountStore({ ...f, audit: () => { throw new Error('audit unavailable'); } });
  assert.throws(() => store.registerCustomer(f.token, f.requireManagement, { userId: 'customer-a', expectedUserRevision: 1, resellerId: 'reseller-a' }), /audit unavailable/);
  assert.equal(f.get().usage.customers, 0); assert.ok(f.getSession(token));
  assert.equal(f.db.prepare("SELECT revision FROM auth_user_revisions WHERE user_id = 'customer-a'").get(), undefined);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM fixture_pending_mfa').get().n, 1);
  assert.equal(f.revoked.some((entry) => entry.id === 'customer-a'), false);
});
test('audit failure rolls back both limit values and revision', (t) => {
  const f = setup(t); f.reseller();
  const store = createHostingAccountStore({ ...f, audit: () => { throw new Error('audit unavailable'); } });
  assert.throws(() => store.updateLimits(f.token, f.requireManagement, 'reseller-a', { revision: 1, limits: { maxCustomers: 0, maxWebsites: 0 } }), /audit unavailable/);
  assert.deepEqual(f.get().limits, { maxCustomers: 2, maxWebsites: 3 }); assert.equal(f.get().revision, 1);
});
test('profiles with customers/sites cannot be silently cascade-deleted', (t) => {
  const f = setup(t); f.reseller(); f.customer();
  assert.throws(() => f.store.unregister(f.token, f.requireManagement, 'reseller-a', { revision: 1 }), code('hosting_account_in_use'));
  f.db.exec("INSERT INTO auth_customer_websites VALUES ('site-a', 'customer-a', 1000)");
  assert.throws(() => f.store.unregister(f.token, f.requireManagement, 'customer-a', { revision: 1 }), code('hosting_account_in_use'));
});
test('empty unlink preserves the login, restores legacy eligibility and revokes target sessions', (t) => {
  const f = setup(t); f.reseller(); const token = f.session('reseller-a');
  assert.throws(() => f.store.unregister(f.token, f.requireManagement, 'reseller-a', { revision: 2 }), code('hosting_account_revision_conflict'));
  assert.deepEqual(f.store.unregister(f.token, f.requireManagement, 'reseller-a', { revision: 1 }), { id: 'reseller-a', unregistered: true });
  assert.equal(f.getSession(token), null); assert.equal(f.db.prepare("SELECT role FROM users WHERE id = 'reseller-a'").get().role, 'site_manager');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_reseller_limits').get().n, 0);
  assert.doesNotThrow(() => f.store.assertLegacyMutationAllowed('reseller-a', { role: 'read_only' }));
});
test('unlink audit failure restores profile, limits and login session', (t) => {
  const f = setup(t); f.reseller(); const token = f.session('reseller-a');
  const store = createHostingAccountStore({ ...f, audit: () => { throw new Error('audit unavailable'); } });
  assert.throws(() => store.unregister(f.token, f.requireManagement, 'reseller-a', { revision: 1 }), /audit unavailable/);
  assert.ok(f.getSession(token)); assert.equal(f.get().revision, 1);
});
test('login revision overflow rolls registration back instead of losing optimistic locking', (t) => {
  const f = setup(t); f.db.prepare('INSERT INTO auth_user_revisions VALUES (?, ?, 1000)').run('reseller-a', Number.MAX_SAFE_INTEGER);
  assert.throws(() => f.store.registerReseller(f.token, f.requireManagement, { userId: 'reseller-a', expectedUserRevision: Number.MAX_SAFE_INTEGER, limits: { maxCustomers: null, maxWebsites: null } }), code('hosting_account_revision_conflict'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_accounts').get().n, 0);
});
