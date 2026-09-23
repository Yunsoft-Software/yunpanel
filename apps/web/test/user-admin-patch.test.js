import assert from 'node:assert/strict';
import test from 'node:test';
import { userAdminInput, userAdminMessage } from '../src/workspace/user-admin-client.js';
const user = { id: 'customer', username: 'customer', role: 'site_manager', active: true, websiteIds: ['site-a','site-b'], revision: 3 };
const form = (patch = {}) => ({ ...user, password: '', ...patch });

test('name edit omits unchanged managed hosting fields and passwords', () => {
  assert.deepEqual(userAdminInput(form({ username: ' NEW.NAME ' }), user), { revision: 3, username: 'new.name' });
});
test('reordered identical site selection is not a mutation', () => {
  assert.throws(() => userAdminInput(form({ websiteIds: ['site-b', 'site-a'] }), user), { code: 'empty_user_update' });
});
test('name edit with empty managed-profile grants omits them', () => {
  assert.deepEqual(userAdminInput(form({ username: 'renamed', websiteIds: [] }), { ...user, websiteIds: [] }), { revision: 3, username: 'renamed' });
});
test('actual site changes and intentional clearing are retained', () => {
  assert.deepEqual(userAdminInput(form({ websiteIds: [] }), user), { revision: 3, websiteIds: [] });
  assert.deepEqual(userAdminInput(form({ websiteIds: ['site-c','site-c'] }), user), { revision: 3, websiteIds: ['site-c'] });
});
test('actual role and activation changes still go to backend authorization', () => {
  assert.deepEqual(userAdminInput(form({ role: 'read_only', active: false }), user), { revision: 3, role: 'read_only', active: false });
});
test('changing into site_manager includes explicit site selection', () => {
  assert.deepEqual(userAdminInput(form({ websiteIds: [] }), { ...user, role: 'read_only' }), { revision: 3, role: 'site_manager', websiteIds: [] });
});
test('create remains a full explicit input including first password', () => {
  assert.deepEqual(userAdminInput(form({ password: 'test-only-long-password' })), {
    username: 'customer', role: 'site_manager', active: true, websiteIds: ['site-a', 'site-b'], password: 'test-only-long-password',
  });
});
for (const websiteIds of [null, 'site-a', [null], ['../escape'], [3]]) {
  test(`malformed site selection is rejected: ${JSON.stringify(websiteIds)}`, () => {
    assert.throws(() => userAdminInput(form({ websiteIds }), user), { code: 'invalid_website_ids' });
  });
}
test('form arrays and baseline are not mutated', () => {
  const baseline = Object.freeze({ ...user, websiteIds: Object.freeze([...user.websiteIds]) });
  const edited = Object.freeze({ ...form({ websiteIds: Object.freeze(['site-c','site-a']) }) });
  assert.deepEqual(userAdminInput(edited, baseline).websiteIds, ['site-a','site-c']);
  assert.deepEqual(baseline.websiteIds, ['site-a','site-b']);
  assert.deepEqual(edited.websiteIds, ['site-c','site-a']);
});
test('missing revision is never inferred', () => {
  assert.throws(() => userAdminInput(form({ username: 'renamed' }), { ...user, revision: 0 }), { code: 'invalid_revision' });
});
test('hosting guard gets a useful message without echoing server details', () => {
  const message = userAdminMessage({ code: 'hosting_account_managed', message: 'private diagnostic' });
  assert.match(message, /Bayi \/ müşteri/); assert.doesNotMatch(message, /private diagnostic/);
});
