import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { initializeHostingAccountSchema, rollbackEmptyHostingAccountSchema } from '../src/hosting-account-schema.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { hostingWebsiteDigest } from '../src/hosting-site-allocation-store.js';
import { siteFixture, website, allocation, uuid } from '../test-support/hosting-site-fixture.js';

const code = (expected) => (error) => error.code === expected;

test('preview is read-only; reserve counts pending slots and retry is idempotent', (t) => {
  const f = siteFixture(t);
  assert.equal(f.preview().state, 'available');
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.equal(f.get().usage.websites, 0);
  assert.equal(f.reserve().state, 'reserved');
  const events = f.count('fixture_audit');
  assert.deepEqual(f.reserve(), f.preview());
  assert.equal(f.count('fixture_audit'), events);
  assert.equal(f.get().usage.websites, 1);
  assert.equal(f.get().usageScope, 'registered_and_reserved_ownership');
  assert.equal(f.count('auth_customer_websites'), 0);
  assert.equal(f.count('auth_user_websites'), 0);
});
test('all customers share the reseller site limit; other reseller and direct customer are separate', (t) => {
  const f = siteFixture(t); f.reserve();
  assert.throws(() => f.reserve(allocation(2, 'customer-b')), code('reseller_limit_reached'));
  f.reserve(allocation(3, 'customer-c')); f.reserve(allocation(4, 'direct'));
  assert.equal(f.get().usage.websites, 1); assert.equal(f.get('reseller-b').usage.websites, 1);
});
test('zero blocks new reservations; unlimited allows them', (t) => {
  const zero = siteFixture(t, { maxWebsites: 0 });
  assert.throws(() => zero.reserve(), code('reseller_limit_reached'));
  const unlimited = siteFixture(t, { maxWebsites: null });
  unlimited.reserve(); unlimited.reserve(allocation(2));
  assert.equal(unlimited.get().usage.websites, 2);
});
test('limit reduction keeps existing holds, allows exact resume, blocks new additions', (t) => {
  const f = siteFixture(t); f.reserve();
  f.store.updateLimits(f.token, f.requireManagement, 'reseller-a', { revision: 1, limits: { maxCustomers: 5, maxWebsites: 0 } });
  assert.equal(f.reserve().state, 'reserved');
  assert.throws(() => f.reserve(allocation(2)), code('reseller_limit_reached'));
  assert.equal(f.complete().state, 'attached');
  assert.equal(f.get().usage.websites, 1);
});
for (const [field, value] of [['customerId', 'customer-b'], ['serverId', uuid(200)], ['websiteId', uuid(2)],
  ['intentDigest', 'b'.repeat(64)], ['websiteDigest', 'c'.repeat(64)]]) {
  test(`existing operation cannot change ${field}`, (t) => {
    const f = siteFixture(t); f.reserve();
    assert.throws(() => f.reserve({ ...allocation(), [field]: value }), code('hosting_site_identity_conflict'));
    assert.equal(f.count('auth_hosting_site_allocations'), 1);
  });
}
test('same Website with a different operation cannot consume another slot', (t) => {
  const f = siteFixture(t); f.reserve();
  assert.throws(() => f.reserve({ ...allocation(), operationId: uuid(9000) }), code('hosting_site_identity_conflict'));
});
for (const patch of [{ operationId: 'bad' }, { serverId: '' }, { websiteId: 'domain-id' }, { customerId: null },
  { intentDigest: 'not-a-digest' }, { websiteDigest: '' }, { actor: { role: 'owner' } }, { usage: 0 }, { maxWebsites: null }]) {
  test(`invalid/extra input is rejected: ${JSON.stringify(patch)}`, (t) => {
    const f = siteFixture(t);
    assert.throws(() => f.reserve({ ...allocation(), ...patch }), code('invalid_hosting_site_input'));
    assert.equal(f.count('auth_hosting_site_allocations'), 0);
  });
}
for (const role of ['site_manager', 'read_only']) {
  test(`${role} cannot preview/reserve/complete even through internal store`, (t) => {
    const f = siteFixture(t); f.addUser('other', { role }); const token = f.session('other');
    for (const method of ['preview', 'reserve', 'complete']) assert.throws(() => f.store.siteAllocations[method](token, f.requireManagement, allocation(), website()), code('forbidden'));
  });
}
test('logout and forged policy cannot authorize writes', (t) => {
  const f = siteFixture(t);
  assert.throws(() => f.store.siteAllocations.reserve('bad', () => ({ id: 'fake', user: { id: 'owner', role: 'owner' } }), allocation()), code('forbidden'));
  f.db.exec("DELETE FROM sessions WHERE user_id = 'owner'");
  assert.throws(() => f.reserve(), code('unauthorized'));
});
test('inactive customer and inactive parent reject reservation', (t) => {
  const f = siteFixture(t);
  f.addUser('inactive', { active: false });
  f.store.registerCustomer(f.token, f.requireManagement, { userId: 'inactive', expectedUserRevision: 1, resellerId: null });
  assert.throws(() => f.reserve(allocation(2, 'inactive')), code('hosting_account_inactive'));
  // Model an offline damaged/later lifecycle update; the real live guard is retained.
  f.db.exec('DROP TRIGGER auth_hosting_legacy_user_guard');
  f.db.exec("UPDATE users SET active = 0 WHERE id = 'reseller-a'");
  assert.throws(() => f.reserve(), code('hosting_account_inactive'));
});
test('reseller profiles cannot be used as customers', (t) => {
  const f = siteFixture(t);
  assert.throws(() => f.reserve(allocation(2, 'reseller-a')), code('hosting_site_requires_customer'));
});
test('completion records verified ownership once, revokes affected sessions, never grants access', (t) => {
  const f = siteFixture(t); f.reserve();
  const customerToken = f.session('customer-a'), resellerToken = f.session('reseller-a');
  const allocationResult = f.complete();
  assert.equal(allocationResult.state, 'attached'); assert.equal(allocationResult.accessGranted, false);
  assert.equal(f.count('auth_customer_websites'), 1); assert.equal(f.count('auth_user_websites'), 0);
  assert.equal(f.get().usage.websites, 1); assert.equal(f.get().usageScope, 'registered_ownership');
  assert.equal(f.getSession(customerToken), null); assert.equal(f.getSession(resellerToken), null);
  assert.ok(f.getSession(f.token));
  const n = f.revoked.length, events = f.count('fixture_audit');
  assert.deepEqual(f.complete(), allocationResult); assert.equal(f.revoked.length, n); assert.equal(f.count('fixture_audit'), events);
});
for (const patch of [{ id: uuid(999) }, { serverId: uuid(200) }, { revision: 2 }, { unixUser: 'root' }, { applicationId: uuid(300) }]) {
  test(`completion rejects mismatched Website snapshot: ${JSON.stringify(patch)}`, (t) => {
    const f = siteFixture(t); f.reserve();
    assert.throws(() => f.complete(allocation(), website(1, patch)), code('hosting_site_identity_conflict'));
    assert.equal(f.preview().state, 'reserved'); assert.equal(f.count('auth_customer_websites'), 0);
  });
}
test('missing Website or reservation cannot be finalized', (t) => {
  const f = siteFixture(t);
  assert.throws(() => f.complete(), code('hosting_site_allocation_not_found'));
  f.reserve(); assert.throws(() => f.complete(allocation(), null), code('invalid_hosting_site_input'));
});
test('legacy grants require migration before reserve and before completion', (t) => {
  const f = siteFixture(t); f.addUser('legacy');
  f.db.prepare('INSERT INTO auth_user_websites VALUES (?, ?)').run('legacy', uuid(1));
  assert.throws(() => f.reserve(), code('hosting_site_migration_required'));
  f.db.exec("DELETE FROM auth_user_websites WHERE user_id = 'legacy'");
  f.reserve();
  f.db.prepare('INSERT INTO auth_user_websites VALUES (?, ?)').run('legacy', uuid(1));
  assert.throws(() => f.complete(), code('hosting_site_migration_required'));
});
test('pending or attached allocation prevents profile unregister', (t) => {
  const f = siteFixture(t); f.reserve();
  assert.throws(() => f.store.unregister(f.token, f.requireManagement, 'customer-a', { revision: 1 }), code('hosting_account_in_use'));
  f.complete();
  assert.throws(() => f.store.unregister(f.token, f.requireManagement, 'customer-a', { revision: 1 }), code('hosting_account_in_use'));
});
test('audit failure rolls back reservation; finalization failure retains the hold and sessions', (t) => {
  let fail = null;
  const f = siteFixture(t, { audit: (actor, action) => { if (action === fail) throw new Error('audit unavailable'); } });
  fail = 'hosting.website_reserved'; assert.throws(() => f.reserve(), /audit unavailable/);
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  fail = null; f.reserve(); const token = f.session('customer-a'); const n = f.revoked.length;
  fail = 'hosting.website_attached'; assert.throws(() => f.complete(), /audit unavailable/);
  assert.equal(f.preview().state, 'reserved'); assert.equal(f.count('auth_customer_websites'), 0);
  assert.ok(f.getSession(token)); assert.equal(f.revoked.length, n);
});
test('lost or contradictory attached ownership fails closed', (t) => {
  const f = siteFixture(t); f.reserve(); f.complete();
  f.db.prepare('DELETE FROM auth_customer_websites WHERE website_id = ?').run(uuid(1));
  assert.throws(() => f.get(), code('hosting_site_state_invalid'));
  assert.throws(() => f.complete(), code('hosting_site_state_invalid'));
});
test('schema upgrade is additive, repeatable and empty rollback removes both sidecars', (t) => {
  const f = hostingAuthFixture(); t.after(() => f.db.close()); f.addUser('owner', { role: 'owner' });
  const before = f.db.prepare('SELECT * FROM users').all();
  initializeHostingAccountSchema(f);
  assert.deepEqual(initializeHostingAccountSchema(f), { version: 1, created: false });
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), before);
  assert.equal(rollbackEmptyHostingAccountSchema(f).removed, true);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'auth_hosting_site_schema'").get(), undefined);
  assert.equal(initializeHostingAccountSchema(f).created, true);
});
test('missing or future allocation schema aborts startup without silently repairing it', (t) => {
  const f = siteFixture(t);
  f.db.exec('UPDATE auth_hosting_site_schema SET version = 999');
  assert.throws(() => createHostingAccountStore(f), code('hosting_site_schema_invalid'));
  f.db.exec('UPDATE auth_hosting_site_schema SET version = 1; DROP TRIGGER auth_hosting_site_identity');
  assert.throws(() => createHostingAccountStore(f), code('hosting_site_schema_invalid'));
});
test('reopening a file-backed database preserves the pending quota and exact retry', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yunpanel-site-hold-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'auth.sqlite');
  const first = siteFixture(t, { filePath }); first.reserve();
  const second = siteFixture(t, { filePath, seed: false });
  assert.equal(second.reserve().state, 'reserved');
  assert.throws(() => second.reserve(allocation(2)), code('reseller_limit_reached'));
  second.complete(); assert.equal(first.get().usage.websites, 1);
});
test('fingerprint ignores key order/timestamps but not Unix identity or missing fields', () => {
  const a = website(); const b = { ...a, createdAt: 'later', proxyTarget: { websocket: true, port: 8080, host: '127.0.0.1' } };
  assert.equal(hostingWebsiteDigest(a), hostingWebsiteDigest(b));
  delete b.unixUser; assert.throws(() => hostingWebsiteDigest(b), code('invalid_hosting_site_input'));
});


function removalProof(overrides = {}) {
  return {
    operationId: 'ws-rem-11111111-1111-4111-8111-111111111111',
    websiteId: uuid(1),
    serverId: uuid(100),
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
    ...overrides,
  };
}

test('verified Website removal releases attached ownership and reseller capacity exactly once', (t) => {
  const f = siteFixture(t);
  f.reserve();
  f.complete();
  const customerToken = f.session('customer-a');
  const resellerToken = f.session('reseller-a');
  assert.equal(f.get().usage.websites, 1);

  const receipt = f.store.siteAllocations.releaseRemoved(removalProof());
  assert.equal(receipt.websiteId, uuid(1));
  assert.equal(receipt.customerId, 'customer-a');
  assert.equal(receipt.released, true);
  assert.equal(receipt.quotaReleased, true);
  assert.equal(f.count('auth_customer_websites'), 0);
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.equal(f.get().usage.websites, 0);
  assert.equal(f.getSession(customerToken), null);
  assert.equal(f.getSession(resellerToken), null);

  const retry = f.store.siteAllocations.releaseRemoved(removalProof());
  assert.deepEqual(retry, { websiteId: uuid(1), released: false, quotaReleased: false });
});

test('verified removal can release a reserved hold without pretending ownership was attached', (t) => {
  const f = siteFixture(t);
  f.reserve();
  assert.equal(f.count('auth_customer_websites'), 0);
  const receipt = f.store.siteAllocations.releaseRemoved(removalProof());
  assert.equal(receipt.released, true);
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.equal(f.count('auth_customer_websites'), 0);
  assert.equal(f.get().usage.websites, 0);
});

for (const patch of [
  { websiteAbsent: false },
  { applicationAbsent: true },
  { operationId: '' },
  { serverId: uuid(999) },
]) {
  test(`quota release rejects invalid or mismatched removal evidence: ${JSON.stringify(patch)}`, (t) => {
    const f = siteFixture(t);
    f.reserve();
    f.complete();
    assert.throws(
      () => f.store.siteAllocations.releaseRemoved(removalProof(patch)),
      (error) => ['hosting_site_release_evidence_invalid', 'hosting_site_identity_conflict'].includes(error.code),
    );
    assert.equal(f.count('auth_hosting_site_allocations'), 1);
    assert.equal(f.count('auth_customer_websites'), 1);
    assert.equal(f.get().usage.websites, 1);
  });
}

test('release audit failure rolls back ownership and quota deletion', (t) => {
  let fail = false;
  const f = siteFixture(t, {
    audit: (_actor, action) => {
      if (fail && action === 'hosting.website_released') throw new Error('audit unavailable');
    },
  });
  f.reserve();
  f.complete();
  fail = true;
  assert.throws(() => f.store.siteAllocations.releaseRemoved(removalProof()), /audit unavailable/);
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.count('auth_customer_websites'), 1);
  assert.equal(f.get().usage.websites, 1);
});


function uncreatedProof(overrides = {}) {
  return {
    operationId: uuid(1001),
    websiteId: uuid(1),
    serverId: uuid(100),
    applicationId: null,
    websiteAbsent: true,
    applicationAbsent: false,
    ...overrides,
  };
}

test('verified uncreated recovery releases only a reserved quota hold exactly once', (t) => {
  const f = siteFixture(t);
  f.reserve();
  const customerToken = f.session('customer-a');
  const resellerToken = f.session('reseller-a');
  const receipt = f.store.siteAllocations.releaseUncreated(uncreatedProof());
  assert.equal(receipt.websiteId, uuid(1));
  assert.equal(receipt.allocationOperationId, uuid(1001));
  assert.equal(receipt.released, true);
  assert.equal(receipt.quotaReleased, true);
  assert.equal(f.count('auth_hosting_site_allocations'), 0);
  assert.equal(f.count('auth_customer_websites'), 0);
  assert.equal(f.get().usage.websites, 0);
  assert.equal(f.getSession(customerToken), null);
  assert.equal(f.getSession(resellerToken), null);

  const retry = f.store.siteAllocations.releaseUncreated(uncreatedProof());
  assert.deepEqual(retry, {
    websiteId: uuid(1),
    allocationOperationId: uuid(1001),
    released: false,
    quotaReleased: false,
  });
});

test('uncreated recovery refuses an attached allocation and preserves ownership', (t) => {
  const f = siteFixture(t);
  f.reserve();
  f.complete();
  assert.throws(
    () => f.store.siteAllocations.releaseUncreated(uncreatedProof()),
    code('hosting_site_recovery_requires_removal'),
  );
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.count('auth_customer_websites'), 1);
  assert.equal(f.get().usage.websites, 1);
});

for (const patch of [
  { websiteAbsent: false },
  { applicationAbsent: true },
  { operationId: uuid(9999) },
  { websiteId: uuid(9999) },
  { serverId: uuid(9999) },
]) {
  test(`uncreated recovery rejects invalid/mismatched evidence: ${JSON.stringify(patch)}`, (t) => {
    const f = siteFixture(t);
    f.reserve();
    assert.throws(
      () => f.store.siteAllocations.releaseUncreated(uncreatedProof(patch)),
      (error) => ['hosting_site_recovery_evidence_invalid', 'hosting_site_identity_conflict'].includes(error.code)
        || (patch.operationId && error.code === undefined),
    );
    assert.equal(f.count('auth_hosting_site_allocations'), 1);
    assert.equal(f.get().usage.websites, 1);
  });
}

test('reservation recovery audit failure rolls back quota release', (t) => {
  let fail = false;
  const f = siteFixture(t, {
    audit: (_actor, action) => {
      if (fail && action === 'hosting.website_reservation_released') throw new Error('audit unavailable');
    },
  });
  f.reserve();
  fail = true;
  assert.throws(() => f.store.siteAllocations.releaseUncreated(uncreatedProof()), /audit unavailable/);
  assert.equal(f.count('auth_hosting_site_allocations'), 1);
  assert.equal(f.get().usage.websites, 1);
});
