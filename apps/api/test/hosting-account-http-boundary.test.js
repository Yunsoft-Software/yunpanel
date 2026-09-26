import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createHostingAccountStore } from '../src/hosting-account-store.js';
import { hostingAuthFixture } from '../test-support/hosting-auth-fixture.js';
import { loadHostingHttpBoundary } from '../test-support/hosting-http-boundary-loader.js';

const { createAuthenticatedApi } = await loadHostingHttpBoundary();
const root = '/api/users/hosting/accounts';
const origin = 'https://panel.example';
const seller = (id = 'reseller-a') => ({ kind: 'reseller', userId: id, expectedUserRevision: 1, limits: { maxCustomers: 1, maxWebsites: 1 } });
const customer = (id = 'customer-a', resellerId = 'reseller-a') => ({ kind: 'customer', userId: id, expectedUserRevision: 1, resellerId });

async function fixture(t) {
  const f = hostingAuthFixture();
  f.addUser('owner', { role: 'owner' }); f.addUser('reader', { role: 'read_only' });
  for (const id of ['reseller-a', 'reseller-b', 'customer-a', 'customer-b', 'direct', 'legacy']) f.addUser(id);
  for (const id of ['owner', 'reader', 'reseller-a', 'customer-a']) f.session(id);
  f.db.exec("INSERT INTO auth_mfa VALUES ('owner', 'test-enrolled-factor')");
  const getSession = (token) => { const session = f.getSession(token); return session ? { ...session, csrfToken: 'fixture-csrf' } : null; };
  const mfa = { ...f.mfa, enabled: (id) => Boolean(f.db.prepare('SELECT 1 FROM auth_mfa WHERE user_id = ?').get(id)) };
  let auditFailure = false;
  const accounts = createHostingAccountStore({ ...f, getSession, mfa, audit: (...args) => {
    if (auditFailure) throw new Error('private database details must not reach HTTP');
    return f.audit(...args);
  } });
  const store = { getSession, mfa, users: { hostingAccounts: accounts } };
  let fallbackCalls = 0;
  const handler = createAuthenticatedApi({ publicOrigin: origin, store, createHandler: () => (_, response) => {
    fallbackCalls += 1; response.writeHead(404); response.end();
  } });
  const server = createServer(handler);
  server.on('request', (request) => f.afterHeaders?.(request));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); f.db.close(); });
  f.request = async (method = 'GET', path = root, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { cookie: '__Host-yunpanel_session=token-owner', origin, 'x-csrf-token': 'fixture-csrf', 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  f.count = () => f.db.prepare('SELECT count(*) AS n FROM auth_hosting_accounts').get().n;
  f.auditCount = () => f.db.prepare('SELECT count(*) AS n FROM fixture_audit').get().n;
  f.failAudit = () => { auditFailure = true; };
  f.fallbackCalls = () => fallbackCalls;
  f.store = store;
  return f;
}

test('Owner HTTP registration persists real profiles and keeps unrelated logins/sites unchanged', async (t) => {
  const f = await fixture(t); const before = f.db.prepare('SELECT * FROM users').all();
  const response = await f.request('POST', root, seller());
  assert.equal(response.status, 201); assert.equal(response.body.data.account.kind, 'reseller');
  assert.equal(response.body.data.account.stage, 'profile_only'); assert.equal(response.body.data.accessGranted, false);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(f.getSession('token-reseller-a'), null); assert.ok(f.getSession('token-owner'));
  assert.deepEqual(f.db.prepare('SELECT * FROM users').all(), before);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_user_websites').get().n, 0);
  assert.equal(f.count(), 1); assert.equal(f.auditCount(), 1);
  assert.doesNotMatch(JSON.stringify(response.body), /fixture-hash|token-owner|password_hash|test-enrolled-factor/);
});
test('both direct and panel compatibility URLs use the same live account API', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', '/api/panel/users/hosting/accounts', seller())).status, 201);
  const list = await f.request('GET'); assert.equal(list.body.data.total, 1);
  assert.equal((await f.request('GET', `${root}/reseller-a`)).body.data.id, 'reseller-a');
  assert.equal(f.fallbackCalls(), 0);
});
test('customer limit is enforced in the real store through HTTP; direct customers are separate', async (t) => {
  const f = await fixture(t); await f.request('POST', root, seller());
  assert.equal((await f.request('POST', root, customer())).status, 201);
  const denied = await f.request('POST', root, customer('customer-b'));
  assert.equal(denied.status, 409); assert.equal(denied.body.error.code, 'reseller_limit_reached');
  assert.equal((await f.request('POST', root, customer('direct', null))).status, 201);
  const list = await f.request('GET', `${root}?kind=customer&direct=true&limit=1&offset=0`);
  assert.equal(list.body.data.total, 1); assert.equal(list.body.data.accounts[0].id, 'direct');
  assert.equal(f.count(), 3);
});
test('limit updates preserve optimistic revision and stale changes do not apply', async (t) => {
  const f = await fixture(t); await f.request('POST', root, seller());
  const input = { revision: 1, limits: { maxCustomers: 3, maxWebsites: 0 } };
  assert.equal((await f.request('PATCH', `${root}/reseller-a/limits`, input)).body.data.account.revision, 2);
  const stale = await f.request('PATCH', `${root}/reseller-a/limits`, { ...input, limits: { maxCustomers: null, maxWebsites: null } });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'hosting_account_revision_conflict');
  assert.equal((await f.request('GET', `${root}/reseller-a`)).body.data.limits.maxWebsites, 0);
});
test('Owner status HTTP suspends login access without claiming Website suspension', async (t) => {
  const f = await fixture(t);
  await f.request('POST', root, seller());
  const targetToken = f.session('reseller-a');
  assert.ok(f.getSession(targetToken));

  const response = await f.request('PATCH', `${root}/reseller-a/status`, { revision: 1, active: false });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.account.active, false);
  assert.equal(response.body.data.account.revision, 2);
  assert.equal(response.body.data.hostSitesSuspended, false);
  assert.equal(response.body.data.accessGranted, false);
  assert.equal(f.getSession(targetToken), null);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'reseller-a'").get().active, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM auth_hosting_accounts WHERE user_id = 'reseller-a'").get().n, 1);

  const stale = await f.request('PATCH', `${root}/reseller-a/status`, { revision: 1, active: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'hosting_account_revision_conflict');
});

test('empty profile removal retains login and refuses a parent with customers', async (t) => {
  const f = await fixture(t); await f.request('POST', root, seller()); await f.request('POST', root, customer());
  const removal = (id) => f.request('DELETE', `${root}/${id}/profile`, { revision: 1, confirmation: `unregister-hosting-profile:${id}:1` });
  assert.equal((await removal('reseller-a')).body.error.code, 'hosting_account_in_use');
  const removed = await removal('customer-a'); assert.equal(removed.status, 200); assert.equal(removed.body.data.loginDeleted, false);
  assert.ok(f.db.prepare("SELECT 1 FROM users WHERE id = 'customer-a'").get());
  assert.equal((await removal('reseller-a')).status, 200); assert.equal(f.count(), 0);
});
test('reserved site capacity prevents HTTP profile removal and is not released', async (t) => {
  const f = await fixture(t); await f.request('POST', root, customer('direct', null));
  f.db.prepare(`INSERT INTO auth_hosting_site_allocations (operation_id,website_id,customer_id,server_id,intent_digest,website_digest,state,created_at)
    VALUES ('operation','site','direct','local','digest','digest','reserved',1000)`).run();
  const response = await f.request('DELETE', `${root}/direct/profile`, { revision: 1, confirmation: 'unregister-hosting-profile:direct:1' });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'hosting_account_in_use');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM auth_hosting_site_allocations').get().n, 1);
});
for (const role of ['reader', 'reseller-a', 'customer-a']) {
  for (const method of ['GET', 'POST']) {
    test(`${role} cannot ${method} accounts through the HTTP boundary`, async (t) => {
      const f = await fixture(t); const response = await f.request(method, root, method === 'POST' ? seller() : undefined, { cookie: `__Host-yunpanel_session=token-${role}` });
      assert.equal(response.status, 403); assert.equal(f.count(), 0); assert.equal(f.fallbackCalls(), 0);
    });
  }
}
test('persisted reseller reaches only own customer reads and child lifecycle through the full auth boundary', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', root, seller('reseller-a'))).status, 201);
  assert.equal((await f.request('POST', root, seller('reseller-b'))).status, 201);
  assert.equal((await f.request('POST', root, customer('customer-a', 'reseller-a'))).status, 201);
  assert.equal((await f.request('POST', root, customer('customer-b', 'reseller-b'))).status, 201);
  assert.equal((await f.request('POST', root, customer('direct', null))).status, 201);
  const resellerToken = f.session('reseller-a');
  const childToken = f.session('customer-a');
  const asReseller = { cookie: `__Host-yunpanel_session=${resellerToken}` };

  const list = await f.request('GET', `${root}?kind=customer`, undefined, asReseller);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.accounts.map((account) => account.id), ['customer-a']);
  assert.equal((await f.request('GET', `${root}/reseller-a`, undefined, asReseller)).status, 200);

  for (const id of ['reseller-b', 'customer-b', 'direct']) {
    const denied = await f.request('GET', `${root}/${id}`, undefined, asReseller);
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'reseller_scope_forbidden');
  }

  const suspended = await f.request('PATCH', `${root}/customer-a/status`, { revision: 1, active: false }, asReseller);
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.data.account.active, false);
  assert.equal(suspended.body.data.hostSitesSuspended, false);
  assert.equal(f.getSession(childToken), null);
  assert.ok(f.getSession(resellerToken));

  for (const [method, path, body] of [
    ['POST', root, customer('legacy', 'reseller-a')],
    ['PATCH', `${root}/reseller-a/limits`, { revision: 1, limits: { maxCustomers: 2, maxWebsites: 2 } }],
    ['DELETE', `${root}/customer-a/profile`, { revision: 2, confirmation: 'unregister-hosting-profile:customer-a:2' }],
  ]) {
    const denied = await f.request(method, path, body, asReseller);
    assert.equal(denied.status, 403); assert.equal(denied.body.error.code, 'reseller_scope_forbidden');
  }
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'customer-b'").get().active, 1);
  assert.equal(f.db.prepare("SELECT active FROM users WHERE id = 'direct'").get().active, 1);
});

for (const [headers, expected, code] of [
  [{ cookie: '' }, 401, 'unauthorized'], [{ cookie: '__Host-yunpanel_session=bad' }, 401, 'unauthorized'],
  [{ cookie: '__Host-yunpanel_session=token-owner; __Host-yunpanel_session=token-owner' }, 400, 'invalid_cookie'],
  [{ 'x-csrf-token': '' }, 403, 'csrf_invalid'], [{ origin: 'https://other.example' }, 403, 'origin_forbidden'],
  [{ 'sec-fetch-site': 'cross-site' }, 403, 'origin_forbidden'], [{ 'x-forwarded-for': '127.0.0.1' }, 400, 'proxy_headers_forbidden'],
  [{ 'content-type': 'text/plain' }, 415, 'json_required'],
]) {
  test(`HTTP guard ${code} prevents database writes`, async (t) => {
    const f = await fixture(t); const response = await f.request('POST', root, seller(), headers);
    assert.equal(response.status, expected); assert.equal(response.body.error.code, code); assert.equal(f.count(), 0); assert.equal(f.auditCount(), 0);
  });
}
test('MFA enrollment policy is read live, not trusted from a login-time session', async (t) => {
  const f = await fixture(t); f.db.exec('DELETE FROM auth_mfa');
  const response = await f.request('POST', root, seller());
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'mfa_enrollment_required'); assert.equal(f.count(), 0);
});
test('Owner session revoked while reading body cannot commit a profile', async (t) => {
  const f = await fixture(t);
  f.afterHeaders = () => f.db.exec("DELETE FROM sessions WHERE user_id = 'owner'");
  const response = await f.request('POST', root, seller());
  assert.equal(response.status, 401); assert.equal(f.count(), 0);
});
test('body parsing rejects malformed and oversized JSON', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request('POST', root, '{')).body.error.code, 'invalid_json');
  assert.equal((await f.request('POST', root, { ...seller(), padding: 'x'.repeat(17 * 1024) })).status, 413);
  assert.equal(f.count(), 0);
});
for (const field of ['role', 'active', 'websiteIds', 'password', 'actor']) {
  test(`HTTP/store rejects mass-assignment ${field} without persisting a partial profile`, async (t) => {
    const f = await fixture(t); const response = await f.request('POST', root, { ...seller(), [field]: 'spoofed' });
    assert.equal(response.status, 400); assert.equal(response.body.error.code, 'invalid_hosting_account_input'); assert.equal(f.count(), 0);
  });
}
test('legacy site memberships are not silently converted by profile registration', async (t) => {
  const f = await fixture(t); f.db.exec("INSERT INTO auth_user_websites VALUES ('legacy','existing-site')");
  const response = await f.request('POST', root, seller('legacy'));
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'hosting_site_migration_required');
  assert.equal(f.count(), 0); assert.ok(f.db.prepare('SELECT 1 FROM auth_user_websites').get());
});
test('audit failure rolls back profile, revision and session invalidation; HTTP masks details', async (t) => {
  const f = await fixture(t); f.failAudit();
  const response = await f.request('POST', root, seller());
  assert.equal(response.status, 503); assert.equal(f.count(), 0); assert.ok(f.getSession('token-reseller-a'));
  assert.equal(f.db.prepare("SELECT 1 FROM auth_user_revisions WHERE user_id='reseller-a'").get(), undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /private database/);
});
test('unknown hosting child routes never reach the general application handler', async (t) => {
  const f = await fixture(t);
  for (const path of [`${root}/a/sites`, `${root}/a/transfer`, `${root}/a/suspend`, `${root}/a/siteAllocations`, `${root}/a%2Fb`]) {
    assert.equal((await f.request('POST', path, {})).status, 404);
  }
  assert.equal(f.fallbackCalls(), 0); assert.equal(f.count(), 0);
});

test('existing user listing still dispatches to the original user handler', async (t) => {
  const f = await fixture(t); let calls = 0;
  f.store.users.list = (token, policy, options) => {
    assert.equal(token, 'token-owner'); assert.equal(policy(f.store.getSession(token)).user.role, 'owner');
    assert.deepEqual(options, { limit: 25, offset: 0 }); calls += 1;
    return { users: [], total: 0, limit: 25, offset: 0 };
  };
  const response = await f.request('GET', '/api/users?limit=25&offset=0');
  assert.equal(response.status, 200); assert.equal(calls, 1); assert.deepEqual(response.body.data.users, []);
  assert.equal(f.fallbackCalls(), 0);
});
