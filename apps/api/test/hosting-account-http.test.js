import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { handleHostingAccountAdmin, hostingAccountQuery, isHostingAccountPath } from '../src/hosting-account-http.js';

const code = (expected) => (error) => error.code === expected;
function fixture(options = {}) {
  let session = { id: 'session-owner', user: { id: 'owner', role: 'owner' } };
  const calls = [];
  const defaultRequireManagement = (current) => {
    if (!current) throw new AuthError('unauthorized', 'Sign in.', 401);
    if (current.user.role !== 'owner') throw new AuthError('forbidden', 'Owner only.', 403);
    return current;
  };
  const requireManagement = options.requireManagement ?? defaultRequireManagement;
  const accounts = {
    authorizeActor(token, policy) {
      assert.equal(token, 'cookie-token'); assert.equal(policy, requireManagement);
      if (!session) throw new AuthError('unauthorized', 'Sign in.', 401);
      if (session.user.role === 'owner') {
        const approved = policy(session);
        if (approved?.id !== session.id || approved?.user?.id !== session.user.id || approved.user.role !== 'owner') {
          throw new AuthError('forbidden', 'Owner only.', 403);
        }
        return { id: session.user.id, role: 'owner', active: true };
      }
      if (session.user.role === 'site_manager' && session.user.id === 'reseller-a') {
        return { id: 'reseller-a', role: 'reseller', active: true };
      }
      throw new AuthError('reseller_scope_forbidden', 'Scoped reseller access denied.', 403);
    },
  };
  for (const name of ['list', 'get', 'registerCustomer', 'registerReseller', 'createCustomerLogin', 'updateCustomerLogin', 'updateLimits', 'setActive', 'unregister']) {
    accounts[name] = (token, policy, ...args) => {
      accounts.authorizeActor(token, policy);
      calls.push({ name, args });
      return name === 'unregister' ? { id: args[0], unregistered: true } : { id: ['get', 'updateCustomerLogin', 'updateLimits', 'setActive'].includes(name) ? args[0] : 'customer-a', kind: 'customer', active: name === 'setActive' ? args[1]?.active : true, stage: 'profile_only' };
    };
  }
  const headers = {};
  const store = { users: { hostingAccounts: accounts } };
  const run = async (method, path = '/api/users/hosting/accounts', body = {}) => {
    const url = new URL(path, 'http://local');
    return handleHostingAccountAdmin({ request: { method }, response: { setHeader: (key, value) => { headers[key] = value; } },
      pathname: url.pathname, query: url.searchParams, store, rawToken: 'cookie-token', requireManagement,
      readJson: options.readJson ?? (async () => body), json: (_, status, payload) => ({ status, ...payload }) });
  };
  return { run, calls, accounts, store, headers, setSession: (value) => { session = value; }, requireManagement };
}

test('route family matching captures unknown children without matching another namespace', () => {
  for (const path of ['/api/users/hosting/accounts', '/api/users/hosting/accounts/a/transfer', '/api/users/hosting/accounts/']) assert.equal(isHostingAccountPath(path), true);
  for (const path of [null, {}, '/api/users/hosting/accounts-else', '/api/users/hosting/accountsX']) assert.equal(isHostingAccountPath(path), false);
});
test('query parses explicit kind, literal IDs and bounded pagination', () => {
  assert.deepEqual(hostingAccountQuery(new URLSearchParams('kind=customer&resellerId=null&limit=25&offset=50')), { kind: 'customer', resellerId: 'null', limit: 25, offset: 50 });
  assert.deepEqual(hostingAccountQuery(new URLSearchParams('kind=customer&direct=true')), { kind: 'customer', resellerId: null });
  assert.deepEqual(hostingAccountQuery(new URLSearchParams()), {});
});
for (const query of ['role=owner', 'kind=owner', 'kind=reseller&direct=true', 'resellerId=a', 'kind=customer&resellerId=',
  'kind=customer&direct=false', 'kind=customer&direct=true&resellerId=a', 'kind=customer&resellerId=a&resellerId=b',
  'limit=0', 'limit=101', 'limit=1&limit=2', 'limit=01', 'limit=1e1', 'offset=-1', 'offset=9007199254740992', 'offset=',
  'kind=reseller&kind=reseller', 'kind=customer&direct=true&direct=true', 'kind=customer&resellerId=../owner']) {
  test(`rejects ambiguous/invalid query ${query}`, () => assert.throws(() => hostingAccountQuery(new URLSearchParams(query)), code('invalid_hosting_account_query')));
}
test('GET list delegates filtered query; item GET delegates the exact ID', async () => {
  const f = fixture();
  assert.equal((await f.run('GET', '/api/users/hosting/accounts?kind=customer&direct=true')).status, 200);
  assert.deepEqual(f.calls[0], { name: 'list', args: [{ kind: 'customer', resellerId: null }] });
  await f.run('GET', '/api/users/hosting/accounts/customer-a');
  assert.deepEqual(f.calls[1], { name: 'get', args: ['customer-a'] });
});
for (const kind of ['reseller', 'customer']) {
  test(`POST registers an existing ${kind} login without silently dropping extra fields`, async () => {
    const f = fixture(); const input = { userId: 'existing', expectedUserRevision: 2, role: 'spoofed' };
    const result = await f.run('POST', undefined, { kind, ...input });
    assert.equal(result.status, 201); assert.equal(result.data.accessGranted, false);
    assert.deepEqual(f.calls[0], { name: kind === 'reseller' ? 'registerReseller' : 'registerCustomer', args: [input] });
    // Production store rejects role; the HTTP layer must not remove it and accept.
  });
}
for (const body of [null, [], {}, { kind: 'owner' }, { kind: 'Customer' }]) {
  test(`invalid register discriminator ${JSON.stringify(body)}`, async () => {
    const f = fixture(); await assert.rejects(f.run('POST', undefined, body), code('invalid_hosting_kind')); assert.equal(f.calls.length, 0);
  });
}
test('PATCH limits keeps revision and fields for the existing store to validate', async () => {
  const f = fixture(); const body = { revision: 4, limits: { maxCustomers: 2, maxWebsites: 0 } };
  const result = await f.run('PATCH', '/api/users/hosting/accounts/reseller-a/limits', body);
  assert.equal(result.data.accessGranted, false);
  assert.deepEqual(f.calls[0], { name: 'updateLimits', args: ['reseller-a', body] });
});
test('PATCH status delegates exact lifecycle input and does not claim Website suspension', async () => {
  const f = fixture();
  const body = { revision: 3, active: false };
  const result = await f.run('PATCH', '/api/users/hosting/accounts/customer-a/status', body);
  assert.equal(result.status, 200);
  assert.equal(result.data.account.active, false);
  assert.equal(result.data.accessGranted, false);
  assert.equal(result.data.hostSitesSuspended, false);
  assert.deepEqual(f.calls[0], { name: 'setActive', args: ['customer-a', body] });
});

test('reseller self customer create and child login edit delegate exact credential bodies without exposing site access', async () => {
  const f = fixture();
  f.setSession({ id: 'session-reseller-a', user: { id: 'reseller-a', role: 'site_manager' } });
  const createBody = { username: 'child-a', password: 'secret-password' };
  const created = await f.run('POST', '/api/users/hosting/accounts/self/customers', createBody);
  assert.equal(created.status, 201);
  assert.equal(created.data.accessGranted, false);
  assert.equal(created.data.siteAccessGranted, false);
  assert.deepEqual(f.calls[0], { name: 'createCustomerLogin', args: [createBody] });

  const updateBody = { revision: 2, username: 'child-renamed', password: 'new-secret-password' };
  const updated = await f.run('PATCH', '/api/users/hosting/accounts/customer-a/login', updateBody);
  assert.equal(updated.status, 200);
  assert.equal(updated.data.accessGranted, false);
  assert.equal(updated.data.siteAccessGranted, false);
  assert.deepEqual(f.calls[1], { name: 'updateCustomerLogin', args: ['customer-a', updateBody] });
});

test('Owner cannot use reseller self-customer creation route while generic Owner registration stays separate', async () => {
  const f = fixture();
  await assert.rejects(
    f.run('POST', '/api/users/hosting/accounts/self/customers', { username: 'child-a', password: 'secret-password' }),
    code('reseller_scope_forbidden'),
  );
  assert.equal(f.calls.length, 0);
});

test('profile removal requires bound confirmation and does not claim login deletion', async () => {
  const f = fixture(); const result = await f.run('DELETE', '/api/users/hosting/accounts/customer-a/profile', { revision: 2, confirmation: 'unregister-hosting-profile:customer-a:2' });
  assert.deepEqual(result, { status: 200, data: { id: 'customer-a', unregistered: true, loginDeleted: false, accessGranted: false } });
  assert.deepEqual(f.calls[0], { name: 'unregister', args: ['customer-a', { revision: 2 }] });
});
for (const body of [{ revision: 2 }, { revision: 2, confirmation: 'unregister-hosting-profile:other:2' },
  { revision: 2, confirmation: 'unregister-hosting-profile:customer-a:1' }, { revision: '2', confirmation: 'unregister-hosting-profile:customer-a:2' },
  { revision: 2, confirmation: 'unregister-hosting-profile:customer-a:2', cascade: true }]) {
  test(`rejects invalid unregister confirmation ${JSON.stringify(body)}`, async () => {
    const f = fixture(); await assert.rejects(f.run('DELETE', '/api/users/hosting/accounts/customer-a/profile', body), code('hosting_profile_confirmation_required')); assert.equal(f.calls.length, 0);
  });
}
for (const [method, path, expected] of [['DELETE', '/api/users/hosting/accounts/a', 'method_not_allowed'],
  ['POST', '/api/users/hosting/accounts/a/limits', 'method_not_allowed'], ['POST', '/api/users/hosting/accounts/a/status', 'method_not_allowed'], ['GET', '/api/users/hosting/accounts/self/customers', 'method_not_allowed'], ['POST', '/api/users/hosting/accounts/a/login', 'method_not_allowed'], ['PATCH', '/api/users/hosting/accounts/a/profile', 'method_not_allowed'],
  ['GET', '/api/users/hosting/accounts/a/transfer', 'not_found'], ['POST', '/api/users/hosting/accounts/a/sites', 'not_found'],
  ['GET', '/api/users/hosting/accounts/a%2Fb', 'not_found'], ['HEAD', '/api/users/hosting/accounts', 'method_not_allowed']]) {
  test(`unsupported operation cannot fall through: ${method} ${path}`, async () => {
    const f = fixture(); await assert.rejects(f.run(method, path), code(expected)); assert.equal(f.calls.length, 0);
    if (expected === 'method_not_allowed') assert.ok(f.headers.allow);
  });
}
test('active persisted reseller can read scoped accounts and change customer status but not use Owner-only mutations', async () => {
  const f = fixture();
  f.setSession({ id: 'session-reseller-a', user: { id: 'reseller-a', role: 'site_manager' } });
  assert.equal((await f.run('GET', '/api/users/hosting/accounts?kind=customer')).status, 200);
  assert.equal((await f.run('GET', '/api/users/hosting/accounts/customer-a')).status, 200);
  assert.equal((await f.run('PATCH', '/api/users/hosting/accounts/customer-a/status', { revision: 1, active: false })).status, 200);
  assert.deepEqual(f.calls.map((item) => item.name), ['list', 'get', 'setActive']);
  for (const [method, path, body] of [
    ['POST', '/api/users/hosting/accounts', { kind: 'customer' }],
    ['PATCH', '/api/users/hosting/accounts/reseller-a/limits', { revision: 1, limits: { maxCustomers: 1, maxWebsites: 1 } }],
    ['DELETE', '/api/users/hosting/accounts/customer-a/profile', { revision: 1, confirmation: 'unregister-hosting-profile:customer-a:1' }],
  ]) {
    await assert.rejects(f.run(method, path, body), code('reseller_scope_forbidden'));
  }
  assert.deepEqual(f.calls.map((item) => item.name), ['list', 'get', 'setActive']);
});

for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
  test(`${method} rechecks a live persisted hosting actor before route parsing, reads or writes`, async () => {
    const f = fixture(); f.setSession(null); await assert.rejects(f.run(method), code('unauthorized'));
    for (const role of ['read_only', 'reseller', 'customer']) {
      f.setSession({ id: 'session-other', user: { id: 'other', role } }); await assert.rejects(f.run(method), code('reseller_scope_forbidden'));
    }
    f.setSession({ id: 'session-other', user: { id: 'other', role: 'site_manager' } });
    await assert.rejects(f.run(method), code('reseller_scope_forbidden'));
    assert.equal(f.calls.length, 0);
  });
}
test('forged Owner policy return cannot bless a different live session', async () => {
  const f = fixture({ requireManagement: () => ({ id: 'other-session', user: { id: 'owner', role: 'owner' } }) });
  await assert.rejects(f.run('GET'), code('forbidden'));
});
test('expired session after body read is rechecked by the store before mutation', async () => {
  let f;
  f = fixture({ readJson: async () => { f.setSession(null); return { kind: 'customer' }; } });
  await assert.rejects(f.run('POST'), code('unauthorized')); assert.equal(f.calls.length, 0);
});
test('missing store gives unavailable instead of a fabricated empty/success response', async () => {
  const f = fixture(); delete f.store.users;
  await assert.rejects(f.run('GET'), code('hosting_accounts_unavailable'));
});
test('non-list requests reject query modifiers', async () => {
  const f = fixture(); await assert.rejects(f.run('POST', '/api/users/hosting/accounts?kind=customer'), code('invalid_hosting_account_query'));
  await assert.rejects(f.run('GET', '/api/users/hosting/accounts/a?direct=true'), code('invalid_hosting_account_query'));
  assert.equal(f.calls.length, 0);
});
