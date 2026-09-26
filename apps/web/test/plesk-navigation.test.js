import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { navigationGroups, navigationItemActive, TOOLS_SETTINGS_GROUPS, commandEntries, groupSiteTabs, normalizePreferences, readPreferences, writePreferences, websiteCount } from '../src/workspace/ui/ux-model.js';
import { SITE_TABS, siteHref, selectedApplication } from '../src/workspace/site-model.js';
const menu = (manage, owner, reseller = false) => navigationGroups(manage, owner, reseller).flatMap((group) => group.items).map(([to]) => to);
const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

test('Owner menu puts site tasks first in Plesk order, not runtime inventory', () => {
  assert.deepEqual(menu(true, true), ['/websites', '/mail', '/files', '/databases', '/tools-settings', '/settings/users']);
  assert.equal(navigationGroups(true, true)[0].items[0][1], 'Web Siteleri ve Alan Adları');
});
test('site manager gets the four scoped task entries without Owner tools', () => {
  assert.deepEqual(menu(true, false), ['/websites', '/mail', '/files', '/databases']);
});
test('reseller gets Müşterilerim without changing the ordinary site-manager menu', () => {
  assert.deepEqual(menu(true, false, true), ['/customers', '/websites', '/mail', '/files', '/databases']);
  assert.equal(navigationGroups(true, false, true)[0].items[0][1], 'Müşterilerim');
});
test('read-only states do not receive management or file handoff links', () => {
  assert.deepEqual(menu(false, false), ['/websites']);
  assert.deepEqual(menu(false, true), ['/websites', '/dashboard']);
});
test('mutating a returned menu does not change subsequent navigation', () => {
  navigationGroups(true, true)[0].items[0][1] = 'changed';
  assert.equal(navigationGroups(true, true)[0].items[0][1], 'Web Siteleri ve Alan Adları');
});
test('old Owner tools remain discoverable without promoting placeholders', () => {
  const links = TOOLS_SETTINGS_GROUPS.flatMap((group) => group.items).map(([to]) => to);
  for (const link of ['/servers', '/dashboard', '/docker', '/applications', '/domains', '/jobs', '/audit', '/settings/users']) assert.ok(links.includes(link), link);
  for (const link of ['/backups', '/statistics', '/subscriptions', '/service-plans']) assert.ok(!links.includes(link), link);
  assert.ok(Object.isFrozen(TOOLS_SETTINGS_GROUPS[0].items[0]));
});
test('nested legacy tool paths highlight Tools & Settings; Users is distinct', () => {
  for (const path of ['/servers', '/settings', '/docker/one', '/applications/new', '/jobs', '/audit']) assert.equal(navigationItemActive('/tools-settings', path), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings/users'), false);
  assert.equal(navigationItemActive('/settings/users', '/settings/users'), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings/users/detail'), false);
  assert.equal(navigationItemActive('/websites', '/websites/domain/files'), true);
  for (const path of ['/websites-other', null, '/webs']) assert.equal(navigationItemActive('/websites', path), false);
});
test('command search is Owner-aware and defaults to the restricted context', () => {
  for (const isOwner of [false, undefined]) {
    const entries = commandEntries({ canManage: true, isOwner });
    assert.ok(entries.some((entry) => entry.to === '/mail'));
    assert.ok(!entries.some((entry) => ['/servers', '/settings/users', '/tools-settings', '/docker'].includes(entry.to)));
  }
  assert.ok(commandEntries({ canManage: true, isOwner: true, query: 'Docker' }).some((entry) => entry.to === '/docker'));
  assert.ok(!commandEntries({ canManage: false, isOwner: true, query: 'Docker' }).some((entry) => entry.to === '/docker'));
  assert.ok(commandEntries({ canManage: true, isReseller: true, query: 'müşteri' }).some((entry) => entry.to === '/customers'));
  assert.ok(!commandEntries({ canManage: true, isReseller: false, query: 'müşteri' }).some((entry) => entry.to === '/customers'));
});
test('Owner directory and sidebar search results are deduplicated by destination', () => {
  const entries = commandEntries({ canManage: true, isOwner: true });
  assert.equal(entries.filter((entry) => entry.to === '/settings/users').length, 1);
  assert.ok(commandEntries({ canManage: true, isOwner: true, query: 'müşteriler' }).some((entry) => entry.to === '/settings/users'));
});
test('domain navigation uses encoded Domain ID and preserves bounded search', () => {
  const entries = commandEntries({ domains: { status: 'ready', items: [{ id: 'id /?#', primaryDomain: 'example.test' }] }, query: 'example' });
  assert.equal(entries.find((entry) => entry.id.startsWith('domain:')).to, '/websites/id%20%2F%3F%23/overview');
  assert.equal(commandEntries({ query: 'a'.repeat(400) }).at(-1).to, `/websites?q=${'a'.repeat(253)}`);
  assert.equal(commandEntries({ domains: { status: 'forbidden', items: [{ id: 'secret', primaryDomain: 'secret.test' }] } }).some((entry) => entry.id === 'domain:secret'), false);
});
test('site tools follow three task families and expose DNS, Git and logs', () => {
  const groups = groupSiteTabs(SITE_TABS);
  assert.deepEqual(groups.map((group) => group.id), ['dashboard', 'hosting', 'mail']);
  assert.deepEqual(groups[0].tabs.map(([key]) => key), ['overview', 'files', 'databases', 'ssl', 'node', 'deploy', 'logs']);
  assert.deepEqual(groups[1].tabs.map(([key]) => key), ['hosting', 'dns', 'settings', 'domains', 'terminal']);
  assert.deepEqual(groups[2].tabs.map(([key]) => key), ['mail']);
});
test('unsupported runtime tools are not invented; unknown implemented tabs remain reachable', () => {
  const filtered = SITE_TABS.filter(([key]) => !['node', 'deploy', 'terminal', 'mail'].includes(key));
  const groups = groupSiteTabs(filtered);
  assert.equal(groups.some((group) => group.id === 'mail'), false);
  assert.equal(groups.flatMap((group) => group.tabs).some(([key]) => key === 'node'), false);
  assert.equal(groupSiteTabs([...filtered, ['custom', 'Installed tool']]).at(-1).tabs[0][0], 'custom');
});
test('every supported old site URL remains stable and hosting has its own URL', () => {
  for (const key of ['overview', 'resources', 'node', 'deploy', 'domains', 'dns', 'ssl', 'files', 'databases', 'mail', 'logs', 'terminal', 'settings', 'hosting']) {
    assert.equal(siteHref('domain-a', key), `/websites/domain-a/${key}`);
  }
  assert.equal(siteHref('domain/a', 'bogus'), '/websites/domain%2Fa/overview');
});
test('legacy application matching retains same-server and explicit target safety', () => {
  const domain = { targetType: 'proxy', serverId: 'local', target: { upstreamPort: 3000 } };
  const apps = [{ id: 'one', serverId: 'local', type: 'node', runtime: { port: 3000 } }, { id: 'two', serverId: 'remote', type: 'node', runtime: { port: 3000 } }];
  assert.equal(selectedApplication(domain, apps, null).id, 'one');
  assert.equal(selectedApplication(domain, apps, 'two'), null);
});
test('appearance preferences and unknown site counts keep their contract', () => {
  assert.deepEqual(normalizePreferences({ theme: 'dark', density: 'compact' }), { theme: 'dark', density: 'compact' });
  assert.deepEqual(readPreferences({ getItem() { throw Error('blocked'); } }), { theme: 'system', density: 'comfortable' });
  assert.equal(writePreferences({ setItem() { throw Error('blocked'); } }, {}), false);
  assert.equal(websiteCount({ status: 'loading', items: [] }), null);
  assert.equal(websiteCount({ status: 'ready', items: [{ id: 'one' }, { id: 'one' }] }), 1);
});
test('source: home is websites, legacy URLs and Owner guards stay mounted', async () => {
  const app = await source('WorkspaceApp.jsx');
  assert.match(app, /index: true, element: <Navigate to="\/websites" replace/);
  assert.match(app, /path: 'tools-settings', element: owner\(<ToolsSettingsPage \/>\)/);
  for (const path of ['dashboard', 'applications', 'domains', 'servers', 'settings', 'settings/users', 'backups', 'customers', 'mail/:mailDomainId', 'websites/:websiteId/:tab?']) assert.ok(app.includes(`path: '${path}'`), path);
  assert.match(app, /path: 'customers', element: reseller\(<ResellerCustomersPage \/>\)/);
  assert.match(app, /function ResellerRoute/);
  for (const tool of ['mail', 'databases']) assert.ok(app.includes(`manage(<GlobalSiteTool tool="${tool}"`));
  assert.match(app, /return isOwner \? ownerView : <SiteToolEntryPage tool=\{tool\}/);
});
test('source: global chooser does not render server mail/database consoles', async () => {
  const page = await source('SiteToolEntryPage.jsx');
  assert.match(page, /<Navigate to=\{entry.target.href\} replace/);
  assert.match(page, /params.has\('site'\)/);
  assert.doesNotMatch(page, /MailDomainsPage|DatabasesPage|panelRequest|fetch\(|localStorage/);
});
test('source: command palette uses actual Owner context and preferences are not open by default', async () => {
  const layout = await source('WorkspaceLayout.jsx');
  assert.match(layout, /<CommandPalette[^>]+isOwner=\{isOwner\}[^>]+isReseller=\{isReseller\}/);
  assert.match(layout, /<details className="ws-appearance">/);
  assert.match(layout, /<Preferences \/>/);
  assert.match(layout, /inert=\{narrow && !menuOpen\}/);
  const palette = await source('ui/CommandPalette.jsx');
  assert.match(palette, /commandEntries\(\{ query, canManage, isOwner, isReseller, domains \}\)/);
});
test('source: no More-only site navigation and tools wrap on narrow screens', async () => {
  const nav = await source('ui/SiteNavigation.jsx');
  assert.match(nav, /groupSiteTabs\(tabs\)/);
  assert.match(nav, /activeTab === 'resources' \? 'databases'/);
  assert.doesNotMatch(nav, /<details|<summary|Diğer/);
  assert.match(nav, /siteHref\(domainId, key\)/);
  const css = await source('ui/plesk-navigation.css');
  assert.match(css, /flex-wrap: wrap/);
  assert.match(css, /white-space: normal/);
  assert.doesNotMatch(css, /#[a-f0-9]{3,8}\b|font-family:|--ws-[\w-]+\s*:/i);
});
test('source: real tools precede recovery; file engine and scope are preserved', async () => {
  const page = await source('SiteDetailPage.jsx');
  assert.ok(page.indexOf('<Section title="Site araçları">') < page.indexOf('<ProvisioningRecoveryPanel '));
  assert.ok(page.includes("tab === 'hosting'"));
  assert.match(page, /<SiteFilesPanel domainId=\{domain.id\}/);
  assert.match(page, /target=\{\{ scope: 'site', websiteId: domain.websiteId \}\}/);
  assert.match(page, /\['resources', 'databases', 'mail'\]\.includes\(tab\)/);
  const settings = page.slice(page.indexOf("{tab === 'settings'"));
  assert.ok(settings.indexOf('<summary>Teknik kayıt kimlikleri</summary>') < settings.indexOf("['Alan adı kimliği'"));
  for (const key of ['files', 'databases', 'ssl', 'deploy', 'logs', 'dns', 'mail']) assert.ok(page.slice(page.indexOf('const shortcuts'), page.indexOf('const hostingTools')).includes(`['${key}'`), key);
});
