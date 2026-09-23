import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionSiteAdmin } from '../src/site-admin-provisioning.js';

const websiteId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';
const serverId = '44444444-4444-4444-8444-444444444444';
const input = () => ({ operationId, serverId, siteAdmin: { email: ' Admin@Example.test ', password: 'fixture-password-only' } });
const result = () => ({ created: true, resumed: false, operationId, website: { id: websiteId, serverId }, primaryDomain: { websiteId } });
const user = () => ({ id: userId, username: 'admin@example.test', role: 'site_manager', active: true, websiteIds: [websiteId] });
function options(extra = {}) { return { input: input(), result: result(), actorId: 'owner-id', userAdminStore: { createSiteManager: async () => user() }, ...extra }; }
const attention = (code) => ({ status: 'attention', websiteId, code });

test('awaits account completion and passes the actual username/actorId store contract', async () => {
  let resolve; let called; let done = false;
  const promise = provisionSiteAdmin(options({ userAdminStore: { createSiteManager: (value) => {
    called = value; return new Promise((complete) => { resolve = complete; });
  } } })).then((value) => { done = true; return value; });
  await new Promise(setImmediate); assert.equal(done, false);
  assert.deepEqual(called, { username: 'admin@example.test', password: 'fixture-password-only', websiteId, actorId: 'owner-id' });
  resolve(user());
  assert.deepEqual(await promise, { status: 'created', websiteId, code: null });
});

test('unrequested account never accesses the user store', async () => {
  assert.deepEqual(await provisionSiteAdmin(options({ input: { operationId, serverId }, userAdminStore: {
    createSiteManager: () => { throw new Error('must not run'); },
  } })), { status: 'not_requested', websiteId, code: null });
});

for (const patch of [{ created: false }, { resumed: true }, { created: undefined }]) {
  test(`replayed or unverified creation never recreates, resets or reassigns an account: ${JSON.stringify(patch)}`, async () => {
    let calls = 0;
    const actual = await provisionSiteAdmin(options({ result: { ...result(), ...patch }, userAdminStore: { createSiteManager: () => { calls++; } } }));
    assert.deepEqual(actual, attention('site_admin_replay_requires_review'));
    assert.equal(calls, 0);
  });
}

for (const [errorCode, code] of [
  ['username_taken', 'site_admin_conflict'], ['invalid_password', 'site_admin_input_invalid'],
  ['auth_busy', 'site_admin_busy'], ['SQLITE_IOERR', 'site_admin_result_unverified'], ['__proto__', 'site_admin_result_unverified'],
]) {
  test(`async rejection ${errorCode} is awaited and projected without raw error or credentials`, async () => {
    const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => {
      throw Object.assign(new Error('fixture-password-only / private failure'), { code: errorCode });
    } } }));
    assert.deepEqual(value, attention(code));
    assert.equal(JSON.stringify(value).includes('private'), false);
  });
}

test('synchronous store throws are also contained without claiming account success', async () => {
  const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: () => { throw new Error('private'); } } }));
  assert.deepEqual(value, attention('site_admin_result_unverified'));
});

for (const bad of [null, {}, { ...user(), role: 'owner' }, { ...user(), active: false },
  { ...user(), websiteIds: [serverId] }, { ...user(), websiteIds: [websiteId, serverId] },
  { ...user(), username: 'someone-else@example.test' }, { ...user(), id: '' }]) {
  test(`unverified account projection cannot become successful: ${JSON.stringify(bad)}`, async () => {
    assert.deepEqual(await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => bad } })), attention('site_admin_result_unverified'));
  });
}

test('missing dependency and actor stay visible, never falling back to a system principal', async () => {
  assert.deepEqual(await provisionSiteAdmin(options({ userAdminStore: null })), attention('site_admin_unavailable'));
  assert.deepEqual(await provisionSiteAdmin(options({ actorId: undefined })), attention('site_admin_actor_unavailable'));
});

test('malformed account input and wrong site binding cannot invoke a write', async () => {
  let calls = 0;
  const store = { createSiteManager: () => { calls++; } };
  for (const siteAdmin of [{}, [], { email: 'bad/name', password: 'fixture' }, { email: 'admin@example.test' }]) {
    const value = await provisionSiteAdmin(options({ input: { ...input(), siteAdmin }, userAdminStore: store }));
    assert.equal(value.status, 'attention');
  }
  for (const patch of [{ operationId: userId }, { website: { id: websiteId, serverId: userId } }, { primaryDomain: { websiteId: serverId } }]) {
    const value = await provisionSiteAdmin(options({ result: { ...result(), ...patch }, userAdminStore: store }));
    assert.equal(value.status, 'attention');
  }
  assert.equal(calls, 0);
});

test('successful public outcome contains only bounded status and site identity', async () => {
  const value = await provisionSiteAdmin(options({ userAdminStore: { createSiteManager: async () => ({ ...user(), passwordHash: 'private-hash', password: 'private-password' }) } }));
  assert.deepEqual(Object.keys(value), ['status', 'websiteId', 'code']);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(JSON.stringify(value).includes('private'), false);
});
