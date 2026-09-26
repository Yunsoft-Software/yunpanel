import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL('../src/' + name, import.meta.url), 'utf8');

test('session exposes only bounded hosting profile context for reseller routing', async () => {
  const auth = await read('auth-protocol.js');
  const session = await read('panel-session.jsx');
  assert.match(auth, /validHostingProfile/);
  assert.match(auth, /\['reseller', 'customer'\]/);
  assert.match(auth, /hosting\.kind === 'reseller'/);
  assert.match(session, /isReseller: session\?\.user\?\.hosting\?\.kind === 'reseller'/);
  assert.match(session, /isCustomer: session\?\.user\?\.hosting\?\.kind === 'customer'/);
});

test('reseller customers page uses scoped account API and never exposes owner-only profile mutations', async () => {
  const page = await read('workspace/ResellerCustomersPage.jsx');
  assert.match(page, /client\.current\.get\(session\.user\.id\)/);
  assert.match(page, /kind: 'customer', resellerId: session\.user\.id/);
  assert.match(page, /action: 'createCustomer'/);
  assert.match(page, /action: 'login'/);
  assert.match(page, /action: 'status'/);
  assert.match(page, /Site erişimi henüz verilmedi/);
  assert.match(page, /Website çalışma durumu değiştirilmedi/);
  assert.doesNotMatch(page, /action: 'unregister'|action: 'limits'|registerReseller|siteAllocations|ownership transfer|fetch\(|localStorage|sessionStorage/);
});

test('reseller route and navigation require server-derived reseller context', async () => {
  const app = await read('workspace/WorkspaceApp.jsx');
  const layout = await read('workspace/WorkspaceLayout.jsx');
  const model = await read('workspace/ui/ux-model.js');
  assert.match(app, /function ResellerRoute/);
  assert.match(app, /return isReseller \? children : <Navigate to="\/websites" replace/);
  assert.match(app, /path: 'customers', element: reseller\(<ResellerCustomersPage \/>/);
  assert.match(layout, /navigationGroups\(canManage, isOwner, isReseller\)/);
  assert.match(model, /isReseller && !isOwner/);
  assert.match(model, /\['\/customers', 'Müşterilerim', 'user'\]/);
});

test('customer credential client whitelists create and edit fields and requires explicit no-site-access response', async () => {
  const client = await read('workspace/hosting-account-client.js');
  assert.match(client, /hostingCustomerCreateInput/);
  assert.match(client, /hostingCustomerLoginInput/);
  assert.match(client, /siteAccessGranted !== false/);
  assert.match(client, /\/self\/customers/);
  assert.match(client, /\/login/);
  assert.doesNotMatch(client.slice(client.indexOf('hostingCustomerCreateInput'), client.indexOf('hostingCustomerLoginInput')), /role|resellerId|websiteIds|active/);
});
