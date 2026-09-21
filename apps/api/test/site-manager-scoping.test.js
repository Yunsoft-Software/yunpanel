import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthStore } from '../src/auth-store.js';
import { createOwnerMfaPolicy } from '../src/owner-mfa-policy.js';
import { describePanelAccess } from '../src/panel-access.js';

test('site_manager role has site_management access mode and scoped permissions', async () => {
  const store = createAuthStore({ filePath: ':memory:' });
  const ownerPolicy = createOwnerMfaPolicy({ store, required: false });

  await store.completeSetup({ setupToken: (await store.issueSetupToken()).token, username: 'admin', password: 'password-12345678' });
  const loginResult = await store.login({ username: 'admin', password: 'password-12345678' });

  // Create a site_manager user assigned to website-123
  const manager = await store.users.create(loginResult.token, ownerPolicy.requireManagement, {
    username: 'sitemanager',
    password: 'password-12345678',
    role: 'site_manager',
    active: true,
    websiteIds: ['website-123'],
  });

  assert.equal(manager.username, 'sitemanager');
  assert.equal(manager.role, 'site_manager');
  assert.deepEqual(manager.websiteIds, ['website-123']);

  // Log in as site_manager
  const managerLogin = await store.login({ username: 'sitemanager', password: 'password-12345678' });
  const session = store.getSession(managerLogin.token);

  assert.equal(session.user.role, 'site_manager');
  assert.deepEqual(session.user.websiteIds, ['website-123']);

  const described = ownerPolicy.describe(session);
  assert.equal(described.access.mode, 'site_management');
  assert.equal(described.security.managementAllowed, true);

  // Updating assigned websites
  const updated = store.users.update(loginResult.token, ownerPolicy.requireManagement, manager.id, {
    revision: manager.revision,
    websiteIds: ['website-123', 'website-456'],
  });
  assert.deepEqual(updated.websiteIds.sort(), ['website-123', 'website-456'].sort());

  store.close();
});
