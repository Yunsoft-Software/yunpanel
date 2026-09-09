import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserAdminClient, readAdminUser, readUserPage, userAdminInput, userAdminMessage } from '../src/workspace/user-admin-client.js';

const user = { id: 'account-one', username: 'owner', role: 'owner', active: true, mfaEnabled: true, revision: 1, createdAt: 1000, updatedAt: 1000 };
const page = (users = [user], offset = 0, total = users.length) => ({ users, offset, total, limit: 25 });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(t, request) {
  const states = []; let generation = 1; let lost = 0;
  const client = createUserAdminClient({ request, generation: () => generation, onPage: (state) => states.push(state), onAccessLost: () => { lost += 1; generation += 1; } });
  t.after(() => client.dispose());
  return { client, states, state: () => states.at(-1), advance: () => { generation += 1; }, lost: () => lost };
}
const failure = (status, code) => Object.assign(new Error('private server detail must not be displayed'), { status, code });

test('public account parser whitelists fields and rejects malformed records', () => {
  assert.deepEqual(readAdminUser({ ...user, password_hash: 'must-not-retain', token: 'must-not-retain' }), user);
  for (const field of [{ id: '../escape' }, { username: null }, { role: 'admin' }, { active: 1 }, { revision: 0 }, { mfaEnabled: null }, { createdAt: Infinity }]) {
    assert.throws(() => readAdminUser({ ...user, ...field }), { code: 'user_result_invalid' });
  }
});

test('page parser checks pagination identity, counts and duplicate IDs', () => {
  assert.deepEqual(readUserPage(page(), { offset: 0, limit: 25 }), page());
  for (const data of [{ ...page(), offset: 25 }, { ...page(), limit: 100 }, { ...page(), total: 2 }, { ...page(), users: null }, page([user, user])]) {
    assert.throws(() => readUserPage(data, { offset: 0, limit: 25 }), { code: 'user_page_invalid' });
  }
  assert.deepEqual(readUserPage(page([], 25, 1), { offset: 25, limit: 25 }).users, []);
});

test('create/edit inputs normalize names without persisting or resubmitting passwords on edit', () => {
  const form = { username: ' OWNER ', password: 'test-only-long-password', active: false, role: 'read_only' };
  assert.deepEqual(userAdminInput(form), { username: 'owner', password: form.password, active: false, role: 'read_only' });
  assert.deepEqual(userAdminInput(form, user), { username: 'owner', active: false, role: 'read_only', revision: 1 });
  assert.throws(() => userAdminInput({ ...form, password: 'short' }), { code: 'invalid_password' });
  assert.throws(() => userAdminInput({ ...form, password: '🦉'.repeat(257) }), { code: 'invalid_password' });
  assert.throws(() => userAdminInput({ ...form, username: 'bad/name' }), { code: 'invalid_username' });
  assert.throws(() => userAdminInput({ ...form, active: 'false' }), { code: 'invalid_active' });
});

test('new list request aborts old one and ignores its late result', async (t) => {
  const first = deferred(), second = deferred(); const calls = [];
  const f = fixture(t, (url, options) => { calls.push({ url, options }); return calls.length === 1 ? first.promise : second.promise; });
  const old = f.client.load(); const fresh = f.client.load({ offset: 25 });
  assert.equal(calls[0].options.signal.aborted, true);
  second.resolve(page([], 25, 1)); await fresh;
  first.resolve(page()); await old;
  assert.equal(f.state().data.offset, 25);
});

test('previous-session and disposed requests never refill the page', async (t) => {
  const waiting = deferred(); const f = fixture(t, () => waiting.promise);
  const loading = f.client.load(); f.advance(); waiting.resolve(page()); await loading;
  assert.equal(f.state().data, null); assert.equal(f.states.length, 1);
  const next = deferred(); const g = fixture(t, () => next.promise);
  const pending = g.client.load(); g.client.dispose(); next.resolve(page()); await pending;
  assert.equal(g.states.length, 1);
});

test('denied access clears the list and notifies auth once', async (t) => {
  let denied = false;
  const f = fixture(t, async () => { if (denied) throw failure(403, 'mfa_enrollment_required'); return page(); });
  await f.client.load(); assert.equal(f.state().data.users.length, 1);
  denied = true; await f.client.load();
  assert.equal(f.state().data, null); assert.equal(f.lost(), 1);
});

test('network and malformed list responses do not retain an earlier privileged list', async (t) => {
  let response = page(); const f = fixture(t, async () => { if (response instanceof Error) throw response; return response; });
  await f.client.load(); response = new TypeError('network'); await f.client.load();
  assert.equal(f.state().data, null); assert.equal(f.lost(), 0);
  response = { users: [] }; await f.client.load();
  assert.equal(f.state().error.code, 'user_page_invalid');
});

test('mutation is single-flight, supersedes reads and does not auto-retry', async (t) => {
  const read = deferred(), write = deferred(); const calls = [];
  const f = fixture(t, (url, options) => { calls.push({ url, options }); return options.method ? write.promise : read.promise; });
  const loading = f.client.load();
  const saving = f.client.mutate({ method: 'PATCH', id: user.id, body: { revision: 1, active: false } });
  await assert.rejects(f.client.mutate({ method: 'POST', body: {} }), { code: 'user_request_busy' });
  await f.client.load(); assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  read.resolve(page()); await loading; assert.equal(f.state().data, null);
  write.resolve({ user: { ...user, active: false, revision: 2 }, sessionRevoked: false });
  const result = await saving; assert.equal(result.user.revision, 2); assert.equal(f.lost(), 0);
});

test('self-change revocation is handled but stale response cannot revoke a newer session', async (t) => {
  const f = fixture(t, async () => ({ user, sessionRevoked: true }));
  assert.equal((await f.client.mutate({ method: 'PATCH', id: user.id, body: {} })).sessionRevoked, true);
  assert.equal(f.lost(), 1);
  const wait = deferred(); const g = fixture(t, () => wait.promise);
  const saving = g.client.mutate({ method: 'PATCH', id: user.id, body: {} });
  g.advance(); wait.resolve({ user, sessionRevoked: true });
  await assert.rejects(saving, { name: 'AbortError' }); assert.equal(g.lost(), 0);
});

test('mutation conflict preserves the error and requires caller reconciliation', async (t) => {
  const error = failure(409, 'user_revision_conflict'); const f = fixture(t, async () => { throw error; });
  await assert.rejects(f.client.mutate({ method: 'DELETE', id: user.id, body: { revision: 1 } }), { code: 'user_revision_conflict' });
  assert.equal(f.state().data, null); assert.equal(f.lost(), 0);
  assert.match(userAdminMessage(error), /Formu kapatıp/);
});

test('unknown mutation outcome and wrong target response must not be blindly retried', async (t) => {
  for (const response of [new TypeError('network'), { user: { ...user, id: 'other' }, sessionRevoked: false }, { deleted: false, sessionRevoked: false }]) {
    let calls = 0;
    const f = fixture(t, async () => { calls += 1; if (response instanceof Error) throw response; return response; });
    await assert.rejects(f.client.mutate({ method: response.deleted === false ? 'DELETE' : 'PATCH', id: user.id, body: {} }), (error) => error.reconcile === true);
    assert.equal(calls, 1); assert.equal(f.state().data, null);
  }
});

test('successful delete has explicit confirmation and safe messages do not echo server content', async (t) => {
  const f = fixture(t, async () => ({ deleted: true, sessionRevoked: false, secret: 'must-not-retain' }));
  assert.deepEqual(await f.client.mutate({ method: 'DELETE', id: user.id, body: { revision: 1 } }), { deleted: true, sessionRevoked: false });
  assert.equal(userAdminMessage(failure(500, 'unexpected')).includes('private server'), false);
});
