import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source integration checks only, not a React render or browser acceptance suite.
const read = (name) => readFile(new URL(`../src/workspace/${name}`, import.meta.url), 'utf8');
test('existing UsersPage mounts profile collection and current-user dialog', async () => {
  const page = await read('UsersPage.jsx');
  assert.match(page, /import \{ HostingAccountsPanel, HostingProfileDialog \}/);
  assert.match(page, /<HostingAccountsPanel refreshKey=\{profileRevision\}/);
  assert.match(page, /<HostingProfileDialog key=\{dialog.user\?\.id \?\? dialog.accountId\}/);
  assert.match(page, /user.role === 'site_manager'.*Bayi \/ müşteri/);
  assert.match(page, /: dialog && <UserDialog/); // Existing user operations remain.
});
test('profile UI shares the existing API, session, modal and unsaved-change mechanisms', async () => {
  const source = await read('HostingAccountsPanel.jsx');
  assert.match(source, /request: panelRequest, generation: sessionGeneration/);
  assert.match(source, /useUnsavedChanges\(dirty \|\| busy\)/);
  assert.match(source, /<Modal title="Bayi \/ müşteri profili"/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|dangerouslySetInnerHTML/);
});
test('profile removal requires username confirmation and does not delete login', async () => {
  const source = await read('HostingAccountsPanel.jsx');
  assert.match(source, /confirmation !== account.username/);
  assert.match(source, /Giriş hesabı ve siteler silinmedi/);
  assert.match(source, /client.current.mutate\(\{ action, user, account, form \}\)/);
});
test('unknown outcomes block form submission and point to explicit reconciliation', async () => {
  const source = await read('HostingAccountsPanel.jsx');
  assert.match(source, /const reload = Boolean\(error\?\.reconcile\)/);
  assert.match(source, /disabled=\{busy \|\| reload\}/);
  assert.match(source, /İşlemi yeniden göndermeyin/);
  assert.match(source, /pending.current \|\| !ready \|\| !eligible \|\| reload/);
});
test('unsupported access and unchanged theme/Files are not presented as new capabilities', async () => {
  const source = await read('HostingAccountsPanel.jsx');
  assert.match(source, /henüz site erişimi veya bayi paneli açmaz/);
  assert.match(source, /Kayıtlı \/ ayrılmış site/);
  assert.doesNotMatch(source, /style=|#[a-f0-9]{6}|FilesPanel|siteAllocations|createSite|login-as/);
});
test('paging responses must belong to current selected kind/offset', async () => {
  const source = await read('HostingAccountsPanel.jsx');
  assert.match(source, /page.kind === kind && page.offset === offset/);
  assert.match(source, /account.active \|\| account.id === customerId/);
  assert.match(source, /sessionGeneration\(\) === generation/);
});
