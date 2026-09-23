import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthError } from '../src/auth-error.js';
import { handleHostingAccountAdmin, hostingAccountQuery, isHostingAccountPath } from '../src/hosting-account-http.js';

const code = (expected) => (error) => error.code === expected;
function fixture(options = {}) {
  let session = { id: 'session-owner', user: { id: 'owner', role: 'owner' } };
  const calls = [];
  const requireManagement = (current) => {
    if (!current) throw new AuthError('unauthorized', 'Sign in.', 401);
    if (current.user.role !== 'owner') throw new AuthError('forbidden', 'Owner only.', 403);
    return current;
  };
  const accounts = Object.fromEntries(['list', 'get', 'registerCustomer', 'registerReseller', 'updateLimits', 'unregister'].map((name) => [name, (token, policy, ...args) => {
    assert.equal(token, 'cookie-token'); assert.equal(policy, requireManagement);
    requireManagement(session); calls.push({ name, args });
    return name === 'unregister' ? { id: args[0], unregistered: true } : { id: name === 'get' || name === 'updateLimits' ? args[0] : 'customer-a', kind: 'customer', stage: 'profile_only' };
  }]));
  const headers = {};
  const store = { getSession: () => session, users: { hostingAccounts: accounts } };
  const run = async (method, path = '/api/users/hosting/accounts', body = {}) => {
    const url = new URL(path, 'http://local');
    return handleHostingAccountAdmin({ request: { method }, response: { setHeader: (key, value) => { headers[key] = value; } },
      pathname: url.pathname, query: url.searchParams, store, rawToken: 'cookie-token', requireManagement,
      readJson: async () => body, json: (_, status, payload) => ({ status, ...payload }), ...options });
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
  ['POST', '/api/users/hosting/accounts/a/limits', 'method_not_allowed'], ['PATCH', '/api/users/hosting/accounts/a/profile', 'method_not_allowed'],
  ['GET', '/api/users/hosting/accounts/a/transfer', 'not_found'], ['POST', '/api/users/hosting/accounts/a/sites', 'not_found'],
  ['GET', '/api/users/hosting/accounts/a%2Fb', 'not_found'], ['HEAD', '/api/users/hosting/accounts', 'method_not_allowed']]) {
  test(`unsupported operation cannot fall through: ${method} ${path}`, async () => {
    const f = fixture(); await assert.rejects(f.run(method, path), code(expected)); assert.equal(f.calls.length, 0);
    if (expected === 'method_not_allowed') assert.ok(f.headers.allow);
  });
}
for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
  test(`${method} rechecks live Owner before route parsing, reads or writes`, async () => {
    const f = fixture(); f.setSession(null); await assert.rejects(f.run(method), code('unauthorized'));
    for (const role of ['site_manager', 'read_only', 'reseller', 'customer']) {
      f.setSession({ id: 'session-other', user: { id: 'other', role } }); await assert.rejects(f.run(method), code('forbidden'));
    }
    assert.equal(f.calls.length, 0);
  });
}
test('forged policy return cannot bless a different user or missing session', async () => {
  const f = fixture({ requireManagement: () => ({ id: 'other-session', user: { id: 'owner', role: 'owner' } }) });
  await assert.rejects(f.run('GET'), code('forbidden'));
});
test('expired session after body read is rechecked by the store before mutation', async () => {
  const f = fixture({ readJson: async () => { f.setSession(null); return { kind: 'customer' }; } });
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
