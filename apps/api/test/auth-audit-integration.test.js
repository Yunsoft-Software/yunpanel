import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { createAuthStore } from '../src/auth-store.js';

const ownerPassword = randomBytes(32).toString('base64url');
const userPassword = randomBytes(32).toString('base64url');

async function setupOwner(store) {
  const { token } = store.issueSetupToken();
  return store.completeSetup({ setupToken: token, username: 'audit-owner', password: ownerPassword });
}

test('auth and user lifecycle dual-write into the bounded common audit model', async (t) => {
  const store = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => store.close());

  const owner = await setupOwner(store);
  const login = await store.login({ username: 'audit-owner', password: ownerPassword });
  const created = await store.users.create(
    login.token,
    (session) => session,
    { username: 'audit-user', password: userPassword, role: 'read_only', active: true },
  );
  store.revokeSession(login.token);

  const page = store.audit.list({ limit: 100 });
  const setup = page.events.find((event) => event.action === 'owner.setup');
  const loginEvent = page.events.find((event) => event.action === 'login.succeeded');
  const userCreated = page.events.find((event) => event.action === 'user.created');
  const revoked = page.events.find((event) => event.action === 'session.revoked');

  assert.deepEqual(
    { actorId: setup.actorId, resourceType: setup.resourceType, resourceId: setup.resourceId, outcome: setup.outcome },
    { actorId: owner.id, resourceType: 'user', resourceId: owner.id, outcome: 'succeeded' },
  );
  assert.equal(loginEvent.actorId, owner.id);
  assert.equal(loginEvent.outcome, 'succeeded');
  assert.deepEqual(
    { actorId: userCreated.actorId, resourceType: userCreated.resourceType, resourceId: userCreated.resourceId, outcome: userCreated.outcome },
    { actorId: owner.id, resourceType: 'user', resourceId: created.id, outcome: 'succeeded' },
  );
  assert.equal(revoked.actorId, owner.id);
  assert.equal(revoked.outcome, 'succeeded');

  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes(ownerPassword), false);
  assert.equal(serialized.includes(userPassword), false);
  for (const event of page.events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      ['id', 'actorId', 'action', 'resourceType', 'resourceId', 'outcome', 'code', 'createdAt'].sort(),
    );
  }
});

test('failed anonymous login records only generic failure metadata', async (t) => {
  const store = createAuthStore({ filePath: ':memory:', masterKey: randomBytes(32) });
  t.after(() => store.close());
  await setupOwner(store);

  await assert.rejects(
    store.login({ username: 'missing-user', password: 'wrong-password-value' }),
    { code: 'invalid_credentials' },
  );
  const [failure] = store.audit.list({ limit: 100 }).events.filter((event) => event.action === 'login.failed');
  assert.deepEqual(
    { actorId: failure.actorId, resourceType: failure.resourceType, resourceId: failure.resourceId, outcome: failure.outcome, code: failure.code },
    { actorId: null, resourceType: null, resourceId: null, outcome: 'failed', code: null },
  );
});
