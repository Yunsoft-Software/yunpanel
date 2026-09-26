import assert from 'node:assert/strict';
import test from 'node:test';
import { createHostingAccountClient, readHostingAccount, readHostingPage, hostingLimitsInput, hostingRegistrationInput, hostingCustomerCreateInput, hostingCustomerLoginInput, hostingAccountMessage } from '../src/workspace/hosting-account-client.js';
const reseller = { id: 'bayi', username: 'bayi', kind: 'reseller', resellerId: null, active: true, revision: 1, userRevision: 2, createdAt: 1000, updatedAt: 1000, stage: 'profile_only', limits: { maxCustomers: 2, maxWebsites: null }, usage: { customers: 1, websites: 3 }, usageScope: 'registered_and_reserved_ownership' };
const customer = { id: 'customer', username: 'customer', kind: 'customer', resellerId: 'bayi', active: true, revision: 1, userRevision: 2, createdAt: 1000, updatedAt: 1000, stage: 'profile_only' };
const user = { id: 'customer', role: 'site_manager', revision: 1, websiteIds: [] };
const form = { kind: 'customer', resellerId: 'bayi' };
const page = (accounts = [reseller], offset = 0, total = accounts.length) => ({ accounts, offset, total, limit: 25 });
const error = (status, code) => Object.assign(new Error('private server message'), { status, code });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, request) {
  let generation = 1, lost = 0; const calls = [];
  const client = createHostingAccountClient({ request: (...args) => { calls.push(args); return request(...args); }, generation: () => generation,
    onAccessLost: () => { lost++; },
  });
  t.after(() => client.dispose());
  return { client, calls, changeSession: () => generation++, lost: () => lost };
}
const register = (f) => f.client.mutate({ action: 'register', user, form });

test('account parsing strips credentials including nested accidental fields', () => {
  const value = { ...reseller, token: 'hidden', limits: { ...reseller.limits, secret: 'hidden' }, usage: { ...reseller.usage, password: 'hidden' } };
  assert.deepEqual(readHostingAccount(value), reseller);
  assert.doesNotMatch(JSON.stringify(readHostingAccount(value)), /hidden|password|token/);
});
for (const change of [{ id: '../x' }, { username: null }, { active: 1 }, { kind: 'owner' }, { resellerId: 'parent' }, { stage: 'active' }, { userRevision: 0 }, { revision: 0 }, { limits: {} }, { usage: { customers: null, websites: 0 } }, { usageScope: 'disk' }]) {
  test(`malformed profile rejected: ${JSON.stringify(change)}`, () => assert.throws(() => readHostingAccount({ ...reseller, ...change }), { code: 'hosting_result_invalid' }));
}
test('zero, null and over-limit usage remain distinct and legal response states', () => {
  const result = readHostingAccount({ ...reseller, limits: { maxCustomers: 0, maxWebsites: null } });
  assert.equal(result.limits.maxCustomers, 0); assert.equal(result.limits.maxWebsites, null); assert.equal(result.usage.customers, 1);
});
test('page checks kind, count, offset, duplicate identity and parent filters', () => {
  const filters = { kind: 'reseller', offset: 0, limit: 25 };
  assert.deepEqual(readHostingPage(page(), filters), page());
  for (const value of [page([reseller,reseller]), page([customer]), page([], 0, 1), page([reseller], 25)]) assert.throws(() => readHostingPage(value, filters));
  assert.throws(() => readHostingPage(page([customer]), { kind: 'customer', resellerId: null, offset: 0, limit: 25 }));
});
for (const value of ['', ' ', '-1', '1.2', '1e3', undefined, 3, '9007199254740992']) {
  test(`no implicit unlimited/number coercion: ${String(value)}`, () => {
    assert.throws(() => hostingLimitsInput({ maxCustomers: value, maxWebsites: null }), { code: 'invalid_reseller_limits' });
  });
}
test('explicit unlimited and zero input', () => assert.deepEqual(hostingLimitsInput({ maxCustomers: ' 0 ', maxWebsites: null }), { maxCustomers: 0, maxWebsites: null }));
test('registration whitelist contains login identity/revision and no actor/password/grants', () => {
  assert.deepEqual(hostingRegistrationInput(user, { ...form, actor: 'owner', password: 'hidden' }), { kind: 'customer', userId: 'customer', expectedUserRevision: 1, resellerId: 'bayi' });
  assert.deepEqual(hostingRegistrationInput(user, { kind: 'customer', resellerId: null }).resellerId, null);
  assert.equal(hostingRegistrationInput(user, { kind: 'customer', resellerId: 'null' }).resellerId, 'null');
});
for (const change of [{ role: 'owner' }, { role: 'read_only' }, { revision: 0 }, { websiteIds: ['site-a'] }, { websiteIds: undefined }]) {
  test(`registration rejects ineligible login: ${JSON.stringify(change)}`, () => assert.throws(() => hostingRegistrationInput({ ...user, ...change }, form)));
}
test('customer needs explicit parent and cannot choose itself', () => {
  for (const resellerId of [undefined, '', '../x', 'customer']) assert.throws(() => hostingRegistrationInput(user, { kind: 'customer', resellerId }));
});
test('reseller customer credential inputs normalize username and never pass role, parent or grants', () => {
  assert.deepEqual(
    hostingCustomerCreateInput({ username: ' CHILD.User ', password: 'long-enough-password', role: 'owner', resellerId: 'other', websiteIds: ['site'] }),
    { username: 'child.user', password: 'long-enough-password' },
  );
  assert.deepEqual(hostingCustomerLoginInput(customer, { username: ' CHILD-RENAMED ', password: '' }), { revision: 1, username: 'child-renamed' });
  assert.deepEqual(hostingCustomerLoginInput(customer, { username: 'renamed', password: 'new-long-password', active: false }), {
    revision: 1, username: 'renamed', password: 'new-long-password',
  });
  for (const form of [
    { username: 'x', password: 'long-enough-password' },
    { username: 'valid-user', password: 'short' },
  ]) assert.throws(() => hostingCustomerCreateInput(form));
  assert.throws(() => hostingCustomerLoginInput(customer, { username: 'customer', password: '' }), { code: 'empty_hosting_customer_update' });
});

test('current namespace, direct=true and literal null ID query', async (t) => {
  const f = fixture(t, async () => page([]));
  await f.client.list({ kind: 'customer', resellerId: null });
  assert.equal(f.calls[0][0], '/users/hosting/accounts?kind=customer&offset=0&limit=25&direct=true');
  await f.client.list({ kind: 'customer', resellerId: 'null' });
  assert.match(f.calls[1][0], /resellerId=null/); assert.doesNotMatch(f.calls[1][0], /direct=/);
});
test('only documented missing-profile 404 opens registration', async (t) => {
  const f = fixture(t, async () => { throw error(404, 'hosting_account_not_found'); });
  assert.equal(await f.client.get('customer'), null);
  for (const failure of [error(404, 'not_found'), error(500, 'hosting_account_not_found'), new TypeError('network')]) {
    const g = fixture(t, async () => { throw failure; }); await assert.rejects(g.client.get('customer'));
  }
});
test('get rejects a wrong target response', async (t) => {
  const f = fixture(t, async () => reseller);
  await assert.rejects(f.client.get('customer'), { code: 'hosting_result_invalid' });
});
test('newer list supersedes older even when network ignores abort', async (t) => {
  const first = deferred(), second = deferred(); let calls = 0;
  const f = fixture(t, () => ++calls === 1 ? first.promise : second.promise);
  const old = f.client.list({ kind: 'reseller' }); const rejected = assert.rejects(old, { name: 'AbortError' });
  const fresh = f.client.list({ kind: 'customer' });
  second.resolve(page([customer])); assert.equal((await fresh).accounts[0].kind, 'customer');
  first.resolve(page()); await rejected; assert.equal(f.calls[0][1].signal.aborted, true);
});
test('profile and picker have independent read lanes', async (t) => {
  const f = fixture(t, async (path) => path.includes('?') ? page() : customer);
  const values = await Promise.all([f.client.get('customer'), f.client.list({ kind: 'reseller' }, 'resellers')]);
  assert.equal(values[0].id, 'customer'); assert.equal(values[1].accounts[0].id, 'bayi');
});
test('previous session and disposal reject late reads', async (t) => {
  for (const dispose of [false, true]) {
    const wait = deferred(); const f = fixture(t, () => wait.promise);
    const pending = f.client.get('customer'); const rejected = assert.rejects(pending, { name: 'AbortError' });
    if (dispose) f.client.dispose(); else f.changeSession();
    wait.resolve(customer); await rejected;
  }
});
test('write is single-flight and cancels earlier reads', async (t) => {
  const read = deferred(), write = deferred();
  const f = fixture(t, (_path, options) => options.method ? write.promise : read.promise);
  const reading = f.client.get('customer'); const rejected = assert.rejects(reading, { name: 'AbortError' });
  const saving = register(f);
  await assert.rejects(register(f), { code: 'hosting_request_busy' });
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0][1].signal.aborted, true);
  read.resolve(customer); await rejected;
  write.resolve({ account: customer, accessGranted: false }); assert.deepEqual(await saving, { account: customer, accessGranted: false });
});
test('register binds exact identity and parent and snapshots form before awaiting', async (t) => {
  const wait = deferred(); const mutable = { ...form };
  const f = fixture(t, () => wait.promise); const saving = f.client.mutate({ action: 'register', user, form: mutable });
  mutable.resellerId = 'other';
  assert.deepEqual(f.calls[0][1].body, { kind: 'customer', userId: 'customer', expectedUserRevision: 1, resellerId: 'bayi' });
  wait.resolve({ account: customer, accessGranted: false }); await saving;
});
test('successful limits response must match submitted limits', async (t) => {
  const f = fixture(t, async () => ({ account: reseller, accessGranted: false }));
  await assert.rejects(f.client.mutate({ action: 'limits', account: reseller, form: { maxCustomers: '5', maxWebsites: '8' } }), (failure) => failure.code === 'hosting_result_invalid' && failure.reconcile);
});
test('status mutation binds revision, exact target state and explicit non-host-suspension result', async (t) => {
  const suspended = { ...customer, active: false, revision: 2, userRevision: 3, updatedAt: 1001 };
  const f = fixture(t, async () => ({ account: suspended, accessGranted: false, hostSitesSuspended: false }));
  assert.deepEqual(
    await f.client.mutate({ action: 'status', account: customer, form: { active: false } }),
    { account: suspended, accessGranted: false, hostSitesSuspended: false },
  );
  assert.equal(f.calls[0][0], '/users/hosting/accounts/customer/status');
  assert.equal(f.calls[0][1].method, 'PATCH');
  assert.deepEqual(f.calls[0][1].body, { revision: 1, active: false });

  const wrongHostClaim = fixture(t, async () => ({ account: suspended, accessGranted: false, hostSitesSuspended: true }));
  await assert.rejects(
    wrongHostClaim.client.mutate({ action: 'status', account: customer, form: { active: false } }),
    (failure) => failure.code === 'hosting_result_invalid' && failure.reconcile === true,
  );

  const wrongState = fixture(t, async () => ({ account: { ...suspended, active: true }, accessGranted: false, hostSitesSuspended: false }));
  await assert.rejects(
    wrongState.client.mutate({ action: 'status', account: customer, form: { active: false } }),
    (failure) => failure.code === 'hosting_result_invalid' && failure.reconcile === true,
  );
});

test('reseller customer create requires exact parent, normalized login and no site-access claim', async (t) => {
  const created = { ...customer, id: 'child-new', username: 'child.new', revision: 1, userRevision: 2 };
  const f = fixture(t, async () => ({ account: created, accessGranted: false, siteAccessGranted: false }));
  assert.deepEqual(
    await f.client.mutate({ action: 'createCustomer', account: reseller, form: { username: ' CHILD.NEW ', password: 'long-enough-password', role: 'owner' } }),
    { account: created, accessGranted: false, siteAccessGranted: false },
  );
  assert.equal(f.calls[0][0], '/users/hosting/accounts/self/customers');
  assert.equal(f.calls[0][1].method, 'POST');
  assert.deepEqual(f.calls[0][1].body, { username: 'child.new', password: 'long-enough-password' });

  for (const result of [
    { account: { ...created, resellerId: 'other' }, accessGranted: false, siteAccessGranted: false },
    { account: { ...created, id: 'bayi' }, accessGranted: false, siteAccessGranted: false },
    { account: created, accessGranted: false, siteAccessGranted: true },
  ]) {
    const bad = fixture(t, async () => result);
    await assert.rejects(
      bad.client.mutate({ action: 'createCustomer', account: reseller, form: { username: 'child.new', password: 'long-enough-password' } }),
      (failure) => failure.code === 'hosting_result_invalid' && failure.reconcile === true,
    );
  }
});

test('reseller customer login edit binds profile revision and rejects stale or unverified results', async (t) => {
  const renamed = { ...customer, username: 'renamed', revision: 2, userRevision: 3, updatedAt: 1001 };
  const f = fixture(t, async () => ({ account: renamed, accessGranted: false, siteAccessGranted: false }));
  assert.deepEqual(
    await f.client.mutate({ action: 'login', account: customer, form: { username: ' RENAMED ', password: '' } }),
    { account: renamed, accessGranted: false, siteAccessGranted: false },
  );
  assert.equal(f.calls[0][0], '/users/hosting/accounts/customer/login');
  assert.deepEqual(f.calls[0][1].body, { revision: 1, username: 'renamed' });

  const stale = fixture(t, async () => ({ account: { ...renamed, revision: 1, userRevision: 2 }, accessGranted: false, siteAccessGranted: false }));
  await assert.rejects(
    stale.client.mutate({ action: 'login', account: customer, form: { password: 'new-long-password' } }),
    (failure) => failure.code === 'hosting_result_invalid' && failure.reconcile === true,
  );
});

test('status mutation rejects no-op or non-boolean target before network write', async (t) => {
  const f = fixture(t, async () => assert.fail('must not request'));
  await assert.rejects(f.client.mutate({ action: 'status', account: customer, form: { active: true } }), { code: 'hosting_result_invalid' });
  await assert.rejects(f.client.mutate({ action: 'status', account: customer, form: { active: 0 } }), { code: 'hosting_result_invalid' });
  assert.equal(f.calls.length, 0);
});

test('profile removal sends revision confirmation and does not accept login deletion', async (t) => {
  const f = fixture(t, async () => ({ id: 'customer', unregistered: true, loginDeleted: false, accessGranted: false, token: 'drop' }));
  assert.deepEqual(await f.client.mutate({ action: 'unregister', account: customer }), { id: 'customer', unregistered: true, loginDeleted: false, accessGranted: false });
  assert.equal(f.calls[0][0], '/users/hosting/accounts/customer/profile');
  assert.equal(f.calls[0][1].body.confirmation, 'unregister-hosting-profile:customer:1');
  const g = fixture(t, async () => ({ id: 'customer', unregistered: true, loginDeleted: true, accessGranted: false }));
  await assert.rejects(g.client.mutate({ action: 'unregister', account: customer }), { code: 'hosting_result_invalid' });
});
for (const result of [{ account: { ...customer, id: 'other' }, accessGranted: false }, { account: { ...customer, resellerId: 'other' }, accessGranted: false }, { account: customer, accessGranted: true }]) {
  test(`wrong result cannot produce success: ${JSON.stringify(result)}`, async (t) => {
    const f = fixture(t, async () => result); await assert.rejects(register(f), (failure) => failure.reconcile === true);
  });
}
test('uncertain write blocks replay until that same target is explicitly reloaded', async (t) => {
  let writes = 0;
  const f = fixture(t, async (path, options) => {
    if (options.method) { writes++; throw new TypeError('offline'); }
    return path.endsWith('/bayi') ? reseller : customer;
  });
  await assert.rejects(register(f), (failure) => failure.reconcile === true);
  await f.client.get('bayi');
  await assert.rejects(register(f), { code: 'hosting_reconciliation_required' });
  assert.equal(writes, 1);
  await f.client.get('customer');
  await assert.rejects(register(f)); assert.equal(writes, 2);
});
test('known quota failure does not pretend success or retry', async (t) => {
  const f = fixture(t, async () => { throw error(409, 'reseller_limit_reached'); });
  await assert.rejects(register(f), (failure) => failure.code === 'reseller_limit_reached' && !failure.reconcile);
  assert.equal(f.calls.length, 1);
});
test('authorization loss is signalled once and closes the client', async (t) => {
  const f = fixture(t, async () => { throw error(403, 'forbidden'); });
  await assert.rejects(f.client.get('customer'), { code: 'forbidden' });
  await assert.rejects(f.client.get('customer'), { name: 'AbortError' });
  assert.equal(f.lost(), 1); assert.equal(f.calls.length, 1);
});
test('stale write cannot act on or log out a newer session', async (t) => {
  const wait = deferred(); const f = fixture(t, () => wait.promise); const saving = register(f);
  f.changeSession(); wait.reject(error(401, 'unauthorized'));
  await assert.rejects(saving, { name: 'AbortError' }); assert.equal(f.lost(), 0);
});
test('friendly errors never echo untrusted server diagnostics', () => {
  for (const failure of [error(500, 'unknown'), error(409, 'hosting_account_in_use')]) assert.doesNotMatch(hostingAccountMessage(failure), /private server message/);
});

test('registration cannot accept a stale login revision or different assigned limits', async (t) => {
  const f = fixture(t, async () => ({ account: { ...customer, userRevision: 1 }, accessGranted: false }));
  await assert.rejects(register(f), { code: 'hosting_result_invalid' });
  const g = fixture(t, async () => ({ account: reseller, accessGranted: false }));
  await assert.rejects(g.client.mutate({ action: 'register', user: { ...user, id: 'bayi' },
    form: { kind: 'reseller', maxCustomers: '5', maxWebsites: null },
  }), { code: 'hosting_result_invalid' });
});
