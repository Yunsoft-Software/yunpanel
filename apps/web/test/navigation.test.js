import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  navigationGroups,
  navigationItemActive,
  commandEntries,
  TOOLS_SETTINGS_GROUPS,
  groupSiteTabs,
} from '../src/workspace/ui/ux-model.js';
import { resolveSiteToolEntry } from '../src/workspace/site-tool-entry-model.js';
import { siteHref, SITE_TABS, normalizeSiteTab } from '../src/workspace/site-model.js';
import { workspaceResources } from '../src/workspace/workspace-resources.js';

const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

// --- 1. Plesk Task Hierarchy and Item Ordering by Role ---

test('navigationGroups: Owner sees Plesk task hierarchy in exact canonical order', () => {
  const groups = navigationGroups(true, true, false, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'panel');
  assert.equal(groups[0].title, 'Panel');
  assert.equal(groups[0].label, 'Panel');

  const expectedItems = [
    ['/websites', 'Web Siteleri ve Alan Adları', 'globe'],
    ['/mail', 'Posta', 'mail'],
    ['/files', 'Dosyalar', 'folder'],
    ['/databases', 'Veritabanları', 'database'],
    ['/statistics', 'İstatistikler', 'dashboard'],
    ['/tools-settings', 'Araçlar ve Ayarlar', 'settings'],
    ['/settings/users', 'Kullanıcılar', 'user'],
  ];
  assert.deepEqual(groups[0].items, expectedItems);

  // Global inventory surfaces must not be top-level navigation items
  const paths = groups[0].items.map(([path]) => path);
  assert.ok(!paths.includes('/applications'), 'Applications inventory must not replace site management in main nav');
  assert.ok(!paths.includes('/servers'), 'Raw server management must not be in primary navigation');
  assert.ok(!paths.includes('/docker'), 'Docker project inventory must not be in primary navigation');
  assert.ok(!paths.includes('/audit'), 'Audit log must not be in primary navigation');
  assert.ok(!paths.includes('/jobs'), 'Jobs inventory must not be in primary navigation');
  assert.ok(!paths.includes('/domains'), 'Advanced domains must not replace Web Siteleri ve Alan Adları');
});

test('navigationGroups: Reseller sees Bayi Menüsü with Müşterilerim, Sitelerim and isolated site tools', () => {
  const groups = navigationGroups(true, false, true, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Bayi Menüsü');
  assert.equal(groups[0].label, 'Bayi Menüsü');

  const expectedItems = [
    ['/customers', 'Müşterilerim', 'user'],
    ['/websites', 'Sitelerim', 'globe'],
    ['/mail', 'Posta', 'mail'],
    ['/files', 'Dosyalar', 'folder'],
    ['/databases', 'Veritabanları', 'database'],
    ['/statistics', 'İstatistikler', 'dashboard'],
  ];
  assert.deepEqual(groups[0].items, expectedItems);

  const paths = groups[0].items.map(([path]) => path);
  // Reseller must NOT have access to owner server management or user admin
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/dashboard'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/applications'));
  assert.ok(!paths.includes('/servers'));
});

test('navigationGroups: Customer sees Müşteri Menüsü with Web Siteleri ve Alan Adları and self-service tools', () => {
  const groups = navigationGroups(true, false, false, true);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Müşteri Menüsü');
  assert.equal(groups[0].label, 'Müşteri Menüsü');

  const expectedItems = [
    ['/websites', 'Web Siteleri ve Alan Adları', 'globe'],
    ['/mail', 'Posta', 'mail'],
    ['/files', 'Dosyalar', 'folder'],
    ['/databases', 'Veritabanları', 'database'],
    ['/statistics', 'İstatistikler', 'dashboard'],
  ];
  assert.deepEqual(groups[0].items, expectedItems);

  const paths = groups[0].items.map(([path]) => path);
  // Customer must NOT have access to customer management, owner server management or users
  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/dashboard'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/applications'));
  assert.ok(!paths.includes('/servers'));
});

test('navigationGroups: Site Manager / limited non-owner sees site-scoped tools under Panel label', () => {
  const groups = navigationGroups(true, false, false, false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, 'Panel');
  assert.equal(groups[0].label, 'Panel');

  const expectedItems = [
    ['/websites', 'Web Siteleri ve Alan Adları', 'globe'],
    ['/mail', 'Posta', 'mail'],
    ['/files', 'Dosyalar', 'folder'],
    ['/databases', 'Veritabanları', 'database'],
    ['/statistics', 'İstatistikler', 'dashboard'],
  ];
  assert.deepEqual(groups[0].items, expectedItems);

  const paths = groups[0].items.map(([path]) => path);
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/dashboard'));
});

test('navigationGroups: Read-only Owner sees non-management overview', () => {
  const groups = navigationGroups(false, true, false, false);
  const paths = groups[0].items.map(([path]) => path);
  assert.deepEqual(paths, ['/websites', '/dashboard']);
  assert.ok(!paths.includes('/mail'));
  assert.ok(!paths.includes('/files'));
  assert.ok(!paths.includes('/databases'));
  assert.ok(!paths.includes('/statistics'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
});

test('navigationGroups: Read-only non-owner sees only websites without management tools', () => {
  const customerReadOnly = navigationGroups(false, false, false, true);
  assert.deepEqual(customerReadOnly[0].items.map(([path]) => path), ['/websites']);

  const siteManagerReadOnly = navigationGroups(false, false, false, false);
  assert.deepEqual(siteManagerReadOnly[0].items.map(([path]) => path), ['/websites']);
});

test('navigationGroups: backward compatibility for 2 arguments (canManage, isOwner)', () => {
  const owner = navigationGroups(true, true);
  assert.equal(owner[0].title, 'Panel');
  const ownerPaths = owner[0].items.map(([path]) => path);
  assert.ok(ownerPaths.includes('/websites'));
  assert.ok(ownerPaths.includes('/mail'));
  assert.ok(ownerPaths.includes('/files'));
  assert.ok(ownerPaths.includes('/databases'));
  assert.ok(ownerPaths.includes('/statistics'));
  assert.ok(ownerPaths.includes('/tools-settings'));
  assert.ok(ownerPaths.includes('/settings/users'));

  const nonOwner = navigationGroups(true, false);
  assert.equal(nonOwner[0].title, 'Panel');
  const nonOwnerPaths = nonOwner[0].items.map(([path]) => path);
  assert.ok(!nonOwnerPaths.includes('/tools-settings'));
  assert.ok(!nonOwnerPaths.includes('/settings/users'));
  assert.ok(nonOwnerPaths.includes('/statistics'));
});

// --- 2. Functional Tool Resolution (No Dead Links or Buttons) ---

test('resolveSiteToolEntry: statistics resolves to existing analytics route', () => {
  const site = { id: 'site-1', serverId: 'srv-1', name: 'Site 1', runtimeType: 'php' };
  const domain = { id: 'domain-1', serverId: 'srv-1', websiteId: 'site-1', primaryDomain: 'example.com' };
  const ready = (items) => ({ status: 'ready', items });

  // Single site -> ready with destination
  const resultSingle = resolveSiteToolEntry({
    tool: 'statistics',
    websites: ready([site]),
    domains: ready([domain]),
    canManage: true,
  });
  assert.equal(resultSingle.state, 'ready');
  assert.equal(resultSingle.target.href, '/websites/domain-1/analytics');

  // Explicit requestedSiteId matches site
  const resultExplicit = resolveSiteToolEntry({
    tool: 'statistics',
    websites: ready([site]),
    domains: ready([domain]),
    canManage: true,
    requestedSiteId: 'site-1',
  });
  assert.equal(resultExplicit.state, 'ready');
  assert.equal(resultExplicit.target.href, '/websites/domain-1/analytics');

  // Multiple sites -> choose
  const site2 = { id: 'site-2', serverId: 'srv-1', name: 'Site 2', runtimeType: 'node' };
  const domain2 = { id: 'domain-2', serverId: 'srv-1', websiteId: 'site-2', primaryDomain: 'other.com' };
  const resultMultiple = resolveSiteToolEntry({
    tool: 'statistics',
    websites: ready([site, site2]),
    domains: ready([domain, domain2]),
    canManage: true,
  });
  assert.equal(resultMultiple.state, 'choose');
  assert.equal(resultMultiple.targets.length, 2);
  assert.equal(resultMultiple.targets[0].href, '/websites/domain-1/analytics');
  assert.equal(resultMultiple.targets[1].href, '/websites/domain-2/analytics');

  // Unbound site has href: null (no dead link)
  const resultUnbound = resolveSiteToolEntry({
    tool: 'statistics',
    websites: ready([site]),
    domains: ready([]),
    canManage: true,
  });
  assert.equal(resultUnbound.state, 'unbound');
  assert.equal(resultUnbound.target.href, null);

  // Read-only user produces forbidden
  const resultForbidden = resolveSiteToolEntry({
    tool: 'statistics',
    websites: ready([site]),
    domains: ready([domain]),
    canManage: false,
  });
  assert.equal(resultForbidden.state, 'forbidden');

  // Unsupported tool produces unsupported
  const resultUnsupported = resolveSiteToolEntry({
    tool: 'terminal',
    websites: ready([site]),
    domains: ready([domain]),
    canManage: true,
  });
  assert.equal(resultUnsupported.state, 'unsupported');
});

test('siteHref: supports analytics and normalizes statistics tab alias', () => {
  assert.equal(siteHref('dom-1', 'analytics'), '/websites/dom-1/analytics');
  assert.equal(siteHref('dom-1', 'statistics'), '/websites/dom-1/analytics');
  assert.equal(siteHref('dom-1', 'overview'), '/websites/dom-1/overview');
  assert.equal(siteHref('dom-1', 'files'), '/websites/dom-1/files');
  assert.equal(siteHref('dom-1', 'databases'), '/websites/dom-1/databases');
  assert.equal(siteHref('dom-1', 'mail'), '/websites/dom-1/mail');
  assert.equal(siteHref('dom-1', 'nonexistent'), '/websites/dom-1/overview');
});

test('workspaceResources: statistics demands domain and website inventories', () => {
  const statsRes = workspaceResources('/statistics');
  assert.equal(statsRes.domains, true);
  assert.equal(statsRes.websites, true);
  assert.equal(statsRes.applications, false);
  assert.equal(statsRes.servers, false);
  assert.equal(statsRes.jobs, false);
});

// --- 3. Global Application/Deploy/Debug Isolation vs Site Management ---

test('TOOLS_SETTINGS_GROUPS: isolates server management, diagnostics and product extensions for Owner', () => {
  const groupIds = TOOLS_SETTINGS_GROUPS.map((g) => g.id);
  assert.deepEqual(groupIds, ['server', 'panel', 'diagnostics']);

  const serverGroup = TOOLS_SETTINGS_GROUPS.find((g) => g.id === 'server');
  assert.ok(serverGroup.items.some(([to]) => to === '/servers'));
  assert.ok(serverGroup.items.some(([to]) => to === '/dashboard'));
  assert.ok(serverGroup.items.some(([to]) => to === '/docker'));

  const diagGroup = TOOLS_SETTINGS_GROUPS.find((g) => g.id === 'diagnostics');
  // Applications inventory is isolated in diagnostics, never in main nav
  assert.ok(diagGroup.items.some(([to]) => to === '/applications'));
  assert.ok(diagGroup.items.some(([to]) => to === '/jobs'));
  assert.ok(diagGroup.items.some(([to]) => to === '/audit'));
  assert.ok(diagGroup.items.some(([to]) => to === '/domains'));
});

// --- 4. Role Isolation in Command Palette and Active Navigation ---

test('commandEntries: customer cannot search or access owner/reseller management entries', () => {
  const customerEntries = commandEntries({ canManage: true, isCustomer: true });
  const paths = customerEntries.map((c) => c.to);

  assert.ok(paths.includes('/websites'));
  assert.ok(paths.includes('/mail'));
  assert.ok(paths.includes('/files'));
  assert.ok(paths.includes('/databases'));
  assert.ok(paths.includes('/statistics'));

  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/servers'));
  assert.ok(!paths.includes('/applications'));
  assert.ok(!paths.includes('/dashboard'));
});

test('commandEntries: reseller can search site tools and customers but not owner tools', () => {
  const resellerEntries = commandEntries({ canManage: true, isReseller: true });
  const paths = resellerEntries.map((c) => c.to);

  assert.ok(paths.includes('/customers'));
  assert.ok(paths.includes('/websites'));
  assert.ok(paths.includes('/mail'));
  assert.ok(paths.includes('/files'));
  assert.ok(paths.includes('/databases'));
  assert.ok(paths.includes('/statistics'));

  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/servers'));
  assert.ok(!paths.includes('/applications'));
});

test('commandEntries: owner can search all Plesk task entries and tools-settings items', () => {
  const ownerEntries = commandEntries({ canManage: true, isOwner: true });
  const paths = ownerEntries.map((c) => c.to);

  assert.ok(paths.includes('/websites'));
  assert.ok(paths.includes('/mail'));
  assert.ok(paths.includes('/files'));
  assert.ok(paths.includes('/databases'));
  assert.ok(paths.includes('/statistics'));
  assert.ok(paths.includes('/tools-settings'));
  assert.ok(paths.includes('/settings/users'));
  assert.ok(paths.includes('/servers'));
  assert.ok(paths.includes('/applications'));
});

test('navigationItemActive: correctly identifies active routes and handles users/statistics aliases', () => {
  assert.equal(navigationItemActive('/websites', '/websites'), true);
  assert.equal(navigationItemActive('/websites', '/websites/dom-1/overview'), true);
  assert.equal(navigationItemActive('/websites', '/mail'), false);

  assert.equal(navigationItemActive('/statistics', '/statistics'), true);
  assert.equal(navigationItemActive('/statistics', '/statistics?site=1'), true);
  assert.equal(navigationItemActive('/statistics', '/websites'), false);

  // Users active state
  assert.equal(navigationItemActive('/settings/users', '/settings/users'), true);
  assert.equal(navigationItemActive('/settings/users', '/users'), true);
  assert.equal(navigationItemActive('/users', '/users'), true);
  assert.equal(navigationItemActive('/users', '/settings/users'), true);

  // Tools & Settings is active on server/settings tools, but NOT on /users or /settings/users
  assert.equal(navigationItemActive('/tools-settings', '/tools-settings'), true);
  assert.equal(navigationItemActive('/tools-settings', '/servers'), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings?section=dns'), true);
  assert.equal(navigationItemActive('/tools-settings', '/settings/users'), false);
  assert.equal(navigationItemActive('/tools-settings', '/users'), false);
});

// --- 5. Source Wiring, Routing Structure and Guard Integrity ---

test('source: WorkspaceApp wires statistics and users routes with proper role guards', async () => {
  const appSource = await source('WorkspaceApp.jsx');
  assert.match(appSource, /path: 'statistics', element: manage\(<GlobalSiteTool tool="statistics" ownerView=\{<SiteToolEntryPage tool="statistics" \/>\} \/>\)/);
  assert.match(appSource, /path: 'users', element: owner\(<UsersPage \/>\)/);
  assert.match(appSource, /path: 'settings\/users', element: owner\(<UsersPage \/>\)/);
  assert.match(appSource, /path: 'tools-settings', element: owner\(<ToolsSettingsPage \/>\)/);
  assert.match(appSource, /path: 'files', element: manage\(<FilesPage \/>\)/);
  assert.match(appSource, /path: 'databases', element: manage\(<GlobalSiteTool tool="databases"/);
  assert.match(appSource, /path: 'mail', element: manage\(<GlobalSiteTool tool="mail"/);
  assert.match(appSource, /path: 'applications', element: owner\(<ApplicationsPage \/>\)/);
  assert.match(appSource, /path: 'customers', element: reseller\(<ResellerCustomersPage \/>\)/);
});

test('source: WorkspaceLayout renders role branding and sidebar navigation groups', async () => {
  const layoutSource = await source('WorkspaceLayout.jsx');
  assert.match(layoutSource, /isOwner \? 'SUNUCU YÖNETİMİ' : isReseller \? 'BAYİ PANELİ' : isCustomer \? 'MÜŞTERİ PANELİ' : 'SİTE YÖNETİMİ'/);
  assert.match(layoutSource, /groups\.map\(\(group\) =>/);
  assert.match(layoutSource, /group\.items\.map\(\(\[to, label, icon\]\) =>/);
});

test('source: SiteDetailPage normalizes statistics tab to analytics', async () => {
  const siteDetailSource = await source('SiteDetailPage.jsx');
  assert.match(siteDetailSource, /const normalizedTab = tab === 'statistics' \? 'analytics' : tab;/);
  assert.match(siteDetailSource, /tab === 'analytics' && <SiteAnalyticsPanel domainId=\{domain\.id\} \/>/);
});

test('source: SiteToolEntryPage supports statistics with title and icon metadata', async () => {
  const toolEntrySource = await source('SiteToolEntryPage.jsx');
  assert.match(toolEntrySource, /statistics: \{ title: 'İstatistikler', icon: 'dashboard' \}/);
  assert.match(toolEntrySource, /const meta = TOOL_META\[tool\]/);
});

// --- 6. UX-PL-06: Unified Site Tool Screen Transitions and Routing Matrix ---

test('site-model: normalizeSiteTab and siteHref support all 11 Plesk site tools and legacy aliases', () => {
  // Mail
  assert.equal(normalizeSiteTab('mail'), 'mail');
  assert.equal(siteHref('dom-1', 'mail'), '/websites/dom-1/mail');

  // Databases
  assert.equal(normalizeSiteTab('databases'), 'databases');
  assert.equal(siteHref('dom-1', 'databases'), '/websites/dom-1/databases');

  // SSL/TLS
  assert.equal(normalizeSiteTab('ssl'), 'ssl');
  assert.equal(siteHref('dom-1', 'ssl'), '/websites/dom-1/ssl');

  // DNS
  assert.equal(normalizeSiteTab('dns'), 'dns');
  assert.equal(siteHref('dom-1', 'dns'), '/websites/dom-1/dns');

  // Hosting / PHP
  assert.equal(normalizeSiteTab('hosting'), 'hosting');
  assert.equal(siteHref('dom-1', 'hosting'), '/websites/dom-1/hosting');
  assert.equal(normalizeSiteTab('php'), 'php');
  assert.equal(siteHref('dom-1', 'php'), '/websites/dom-1/php');
  assert.equal(normalizeSiteTab('wp'), 'php');
  assert.equal(siteHref('dom-1', 'wp'), '/websites/dom-1/php');
  assert.equal(normalizeSiteTab('wordpress'), 'php');
  assert.equal(siteHref('dom-1', 'wordpress'), '/websites/dom-1/php');

  // Node.js
  assert.equal(normalizeSiteTab('node'), 'node');
  assert.equal(siteHref('dom-1', 'node'), '/websites/dom-1/node');

  // Git / Deploy
  assert.equal(normalizeSiteTab('deploy'), 'deploy');
  assert.equal(siteHref('dom-1', 'deploy'), '/websites/dom-1/deploy');
  assert.equal(normalizeSiteTab('git'), 'deploy');
  assert.equal(siteHref('dom-1', 'git'), '/websites/dom-1/deploy');

  // Logs
  assert.equal(normalizeSiteTab('logs'), 'logs');
  assert.equal(siteHref('dom-1', 'logs'), '/websites/dom-1/logs');

  // Cron
  assert.equal(normalizeSiteTab('cron'), 'cron');
  assert.equal(siteHref('dom-1', 'cron'), '/websites/dom-1/cron');
  assert.equal(normalizeSiteTab('scheduled-tasks'), 'cron');
  assert.equal(siteHref('dom-1', 'scheduled-tasks'), '/websites/dom-1/cron');

  // Backup / Restore
  assert.equal(normalizeSiteTab('backup'), 'backup');
  assert.equal(siteHref('dom-1', 'backup'), '/websites/dom-1/backup');
  assert.equal(normalizeSiteTab('backups'), 'backup');
  assert.equal(siteHref('dom-1', 'backups'), '/websites/dom-1/backup');

  // Access Accounts
  assert.equal(normalizeSiteTab('access'), 'access');
  assert.equal(siteHref('dom-1', 'access'), '/websites/dom-1/access');
  assert.equal(normalizeSiteTab('sftp'), 'access');
  assert.equal(siteHref('dom-1', 'sftp'), '/websites/dom-1/access');
  assert.equal(normalizeSiteTab('ssh'), 'access');
  assert.equal(siteHref('dom-1', 'ssh'), '/websites/dom-1/access');

  // Analytics / Statistics
  assert.equal(normalizeSiteTab('analytics'), 'analytics');
  assert.equal(siteHref('dom-1', 'analytics'), '/websites/dom-1/analytics');
  assert.equal(normalizeSiteTab('statistics'), 'analytics');
  assert.equal(siteHref('dom-1', 'statistics'), '/websites/dom-1/analytics');

  // Unknown fallback
  assert.equal(siteHref('dom-1', 'unknown-tool'), '/websites/dom-1/overview');
});

test('ux-model: groupSiteTabs places php in dashboard and access in hosting', () => {
  const groups = groupSiteTabs(SITE_TABS);
  const dashboardGroup = groups.find((g) => g.id === 'dashboard');
  const hostingGroup = groups.find((g) => g.id === 'hosting');
  const mailGroup = groups.find((g) => g.id === 'mail');

  assert.ok(dashboardGroup);
  assert.ok(hostingGroup);
  assert.ok(mailGroup);

  const dashboardTabKeys = dashboardGroup.tabs.map(([k]) => k);
  const hostingTabKeys = hostingGroup.tabs.map(([k]) => k);

  assert.ok(dashboardTabKeys.includes('php'));
  assert.ok(dashboardTabKeys.includes('node'));
  assert.ok(dashboardTabKeys.includes('deploy'));
  assert.ok(dashboardTabKeys.includes('databases'));
  assert.ok(dashboardTabKeys.includes('ssl'));
  assert.ok(dashboardTabKeys.includes('logs'));

  assert.ok(hostingTabKeys.includes('access'));
  assert.ok(hostingTabKeys.includes('cron'));
  assert.ok(hostingTabKeys.includes('backup'));
  assert.ok(hostingTabKeys.includes('dns'));
  assert.ok(hostingTabKeys.includes('hosting'));
});

test('source: SiteDetailPage integrates all 11 Plesk site tool panels and access controls', async () => {
  const siteDetailSource = await source('SiteDetailPage.jsx');
  assert.match(siteDetailSource, /import SiteAccessPanel from '\.\/SiteAccessPanel\.jsx';/);
  assert.match(siteDetailSource, /tab === 'php' && <SitePhpToolsPanel domainId=\{domain\.id\} \/>/);
  assert.match(siteDetailSource, /tab === 'access' && <SiteAccessPanel/);
  assert.match(siteDetailSource, /\['resources', 'databases', 'mail'\]\.includes\(tab\) && <SiteResourcesPanel/);
  assert.match(siteDetailSource, /tab === 'ssl' && <><CollectionNotice resource=\{certificates\} label="Sertifikalar" \/><SslOperations/);
  assert.match(siteDetailSource, /tab === 'dns' && <DnsPanel/);
  assert.match(siteDetailSource, /<DomainHostingPanel domain=\{domain\} \/>/);
  assert.match(siteDetailSource, /tab === 'cron' && <SiteCronPanel/);
  assert.match(siteDetailSource, /tab === 'backup' && <SiteBackupPanel/);
  assert.match(siteDetailSource, /tab === 'logs' && <><LogsPanel/);
  assert.match(siteDetailSource, /tab === 'files' && <SiteFilesPanel/);
});

test('source: MailboxRemovalPanel preserves active site context and return navigation', async () => {
  const removalSource = await source('MailboxRemovalPanel.jsx');
  assert.match(removalSource, /\/websites\/\$\{encodeURIComponent\(domainId\)\}\/mail\?mailTab=mailboxes/);
  assert.match(removalSource, /Posta kutularına dön/);
});

test('source: SiteAccessPanel provides diagnostic and access control states', async () => {
  const accessSource = await source('SiteAccessPanel.jsx');
  assert.match(accessSource, /Site bağlantısı gerekli/);
  assert.match(accessSource, /WebsiteIsolationPanel/);
  assert.match(accessSource, /SFTP \/ SSH/);
});
