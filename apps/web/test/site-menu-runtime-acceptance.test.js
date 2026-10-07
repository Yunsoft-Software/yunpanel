import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router';
import { SITE_TABS, normalizeSiteTab, siteHref } from '../src/workspace/site-model.js';
import { groupSiteTabs, tabKey } from '../src/workspace/ui/ux-model.js';

const { PanelSessionProvider } = await import('../src/panel-session.jsx');
const { WorkspaceContext } = await import('../src/workspace/WorkspaceContext.jsx');
const { default: SiteDetailPage } = await import('../src/workspace/SiteDetailPage.jsx');
const { default: SiteNavigation } = await import('../src/workspace/ui/SiteNavigation.jsx');

const readSource = (relPath) => readFile(new URL(`../src/workspace/${relPath}`, import.meta.url), 'utf8');

const defaultOwnerSession = Object.freeze({
  user: Object.freeze({ id: 'owner-id', username: 'owner', role: 'owner' }),
  access: Object.freeze({ mode: 'management', permissions: Object.freeze(['*']) }),
});

function createMockWorkspace(overrides = {}) {
  return {
    domains: { status: 'ready', items: [{ id: 'dom-1', primaryDomain: 'example.com', serverId: 'srv-1', websiteId: 'web-1' }] },
    websites: { status: 'ready', items: [{ id: 'web-1', domainId: 'dom-1', runtimeType: 'static', state: 'active' }] },
    applications: { status: 'ready', items: [] },
    certificates: { status: 'ready', items: [] },
    servers: { status: 'ready', items: [{ id: 'srv-1', name: 'Server 1' }] },
    jobs: { status: 'ready', items: [] },
    refreshAll: () => {},
    resourceBusy: () => false,
    runJob: async () => {},
    observe: () => {},
    updateJob: () => {},
    can: () => true,
    canManage: true,
    isOwner: true,
    isSiteManager: false,
    isReseller: false,
    isCustomer: false,
    ...overrides,
  };
}

function renderSiteDetailPage(initialEntry, workspace = createMockWorkspace(), session = defaultOwnerSession) {
  return renderToString(
    React.createElement(
      PanelSessionProvider,
      { session },
      React.createElement(
        WorkspaceContext.Provider,
        { value: workspace },
        React.createElement(
          MemoryRouter,
          { initialEntries: [initialEntry] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, { path: '/websites/:websiteId/:tab?', element: React.createElement(SiteDetailPage) })
          )
        )
      )
    )
  );
}

// ----------------------------------------------------------------------------
// 1. Site ana ve alt menülerinin eski URL ve application query'sini koruması
// ----------------------------------------------------------------------------

test('site-model: canonical and legacy tab URLs normalize correctly and generate stable hrefs', () => {
  // Canonical routes
  assert.equal(siteHref('dom-1', 'overview'), '/websites/dom-1/overview');
  assert.equal(siteHref('dom-1', 'files'), '/websites/dom-1/files');
  assert.equal(siteHref('dom-1', 'databases'), '/websites/dom-1/databases');
  assert.equal(siteHref('dom-1', 'mail'), '/websites/dom-1/mail');
  assert.equal(siteHref('dom-1', 'ssl'), '/websites/dom-1/ssl');
  assert.equal(siteHref('dom-1', 'dns'), '/websites/dom-1/dns');
  assert.equal(siteHref('dom-1', 'domains'), '/websites/dom-1/domains');
  assert.equal(siteHref('dom-1', 'logs'), '/websites/dom-1/logs');
  assert.equal(siteHref('dom-1', 'analytics'), '/websites/dom-1/analytics');
  assert.equal(siteHref('dom-1', 'cron'), '/websites/dom-1/cron');
  assert.equal(siteHref('dom-1', 'backup'), '/websites/dom-1/backup');
  assert.equal(siteHref('dom-1', 'terminal'), '/websites/dom-1/terminal');
  assert.equal(siteHref('dom-1', 'php'), '/websites/dom-1/php');
  assert.equal(siteHref('dom-1', 'access'), '/websites/dom-1/access');
  assert.equal(siteHref('dom-1', 'settings'), '/websites/dom-1/settings');
  assert.equal(siteHref('dom-1', 'hosting'), '/websites/dom-1/hosting');

  // Legacy URLs and aliases
  assert.equal(normalizeSiteTab('resources'), 'resources');
  assert.equal(siteHref('dom-1', 'resources'), '/websites/dom-1/resources');

  assert.equal(normalizeSiteTab('statistics'), 'analytics');
  assert.equal(siteHref('dom-1', 'statistics'), '/websites/dom-1/analytics');
  assert.equal(normalizeSiteTab('stats'), 'analytics');

  assert.equal(normalizeSiteTab('scheduled-tasks'), 'cron');
  assert.equal(siteHref('dom-1', 'scheduled-tasks'), '/websites/dom-1/cron');
  assert.equal(normalizeSiteTab('tasks'), 'cron');

  assert.equal(normalizeSiteTab('backup-restore'), 'backup');
  assert.equal(siteHref('dom-1', 'backup-restore'), '/websites/dom-1/backup');
  assert.equal(normalizeSiteTab('backups'), 'backup');

  assert.equal(normalizeSiteTab('git'), 'deploy');
  assert.equal(siteHref('dom-1', 'git'), '/websites/dom-1/deploy');

  assert.equal(normalizeSiteTab('sftp'), 'access');
  assert.equal(siteHref('dom-1', 'sftp'), '/websites/dom-1/access');
  assert.equal(normalizeSiteTab('ssh'), 'access');

  assert.equal(normalizeSiteTab('wp'), 'php');
  assert.equal(siteHref('dom-1', 'wp'), '/websites/dom-1/php');
  assert.equal(normalizeSiteTab('wordpress'), 'php');

  assert.equal(normalizeSiteTab('file-manager'), 'files');
  assert.equal(siteHref('dom-1', 'file-manager'), '/websites/dom-1/files');

  assert.equal(normalizeSiteTab('database'), 'databases');
  assert.equal(siteHref('dom-1', 'database'), '/websites/dom-1/databases');

  assert.equal(normalizeSiteTab('email'), 'mail');
  assert.equal(siteHref('dom-1', 'email'), '/websites/dom-1/mail');

  // Fallback for unknown
  assert.equal(normalizeSiteTab('unknown-tab'), 'overview');
  assert.equal(siteHref('dom-1', 'unknown-tab'), '/websites/dom-1/overview');
});

test('groupSiteTabs: legacy resources maps cleanly without creating duplicate menu tabs', () => {
  const groups = groupSiteTabs(SITE_TABS);
  const dashboardGroup = groups.find((g) => g.id === 'dashboard');
  const hostingGroup = groups.find((g) => g.id === 'hosting');
  const mailGroup = groups.find((g) => g.id === 'mail');

  assert.ok(dashboardGroup);
  assert.ok(hostingGroup);
  assert.ok(mailGroup);

  // Legacy resources is recognized and excluded from duplicate extension tabs
  const extensionsGroup = groups.find((g) => g.id === 'extensions');
  assert.ok(!extensionsGroup, 'extensions group should not be created for standard tabs including resources');

  // Verify dashboard tools
  const dashboardKeys = dashboardGroup.tabs.map(([k]) => k);
  assert.ok(dashboardKeys.includes('overview'));
  assert.ok(dashboardKeys.includes('files'));
  assert.ok(dashboardKeys.includes('databases'));
  assert.ok(dashboardKeys.includes('ssl'));
  assert.ok(dashboardKeys.includes('logs'));
  assert.ok(dashboardKeys.includes('analytics'));

  // Verify hosting tools
  const hostingKeys = hostingGroup.tabs.map(([k]) => k);
  assert.ok(hostingKeys.includes('hosting'));
  assert.ok(hostingKeys.includes('dns'));
  assert.ok(hostingKeys.includes('settings'));
  assert.ok(hostingKeys.includes('domains'));
  assert.ok(hostingKeys.includes('access'));
  assert.ok(hostingKeys.includes('terminal'));
  assert.ok(hostingKeys.includes('cron'));
  assert.ok(hostingKeys.includes('backup'));
});

test('SiteNavigation: passes query parameter to both main task groups and sub-menu tool links', async () => {
  const navSource = await readSource('ui/SiteNavigation.jsx');

  // Main task groups carry query parameter
  assert.match(
    navSource,
    /to=\{`\$\{siteHref\(domainId, landing\(group\)\)\}\$\{query\}`\}/,
    'Main task groups links must preserve query parameter',
  );

  // Sub-menu tool links carry query parameter
  assert.match(
    navSource,
    /to=\{`\$\{siteHref\(domainId, key\)\}\$\{query\}`\}/,
    'Sub-menu tool links must preserve query parameter',
  );

  // Legacy resources maps to databases active key
  assert.match(
    navSource,
    /const activeKey = activeTab === 'resources' \? 'databases' : activeTab;/,
    'resources tab must highlight databases activeKey',
  );
});

test('SiteDetailPage: preserves application query parameter and returnTo across navigation', async () => {
  const detailSource = await readSource('SiteDetailPage.jsx');

  // Application query parameter is extracted and preserved
  assert.match(
    detailSource,
    /const applicationParam = params\.get\('application'\);/,
    'params.get(application) must be extracted',
  );
  assert.match(
    detailSource,
    /if \(applicationParam\) queryParts\.push\(`application=\$\{encodeURIComponent\(applicationParam\)\}`\);/,
    'application query param must be added to queryParts',
  );

  // Query is passed to SiteNavigation
  assert.match(
    detailSource,
    /<SiteNavigation tabs=\{tabs\} activeTab=\{tab\} domainId=\{domain\.id\} query=\{query\} \/>/,
    'query must be passed to SiteNavigation',
  );

  // Shortcuts and hosting tools links carry query
  assert.match(
    detailSource,
    /to=\{`\$\{siteHref\(domain\.id, key\)\}\$\{query\}`\}/,
    'Quick links must preserve query',
  );

  // Return to site link in EmptyState carries query
  assert.match(
    detailSource,
    /<LinkButton to=\{`\$\{siteHref\(domain\.id\)\}\$\{query\}`\}>Siteye dön<\/LinkButton>/,
    'EmptyState return button must preserve query',
  );

  // Internal page navigation links carry query
  assert.match(
    detailSource,
    /<Link to=\{`\$\{siteHref\(domain\.id, 'hosting'\)\}\$\{query\}`\}>Barındırma ve DNS<\/Link>/,
  );
  assert.match(
    detailSource,
    /<Link to=\{`\$\{siteHref\(domain\.id, 'logs'\)\}\$\{query\}`\}>Tümünü gör<\/Link>/,
  );
  assert.match(
    detailSource,
    /<LinkButton to=\{`\$\{siteHref\(domain\.id, 'settings'\)\}\$\{query\}`\} icon="trash">Siteyi sil…<\/LinkButton>/,
  );
});

test('runtime execution: SiteDetailPage and SiteNavigation render real DOM preserving application query and returnTo', () => {
  const html = renderSiteDetailPage('/websites/dom-1/overview?application=app-prod&returnTo=%2Fwebsites');

  // Navigation and shortcuts preserve query params
  assert.ok(html.includes('application=app-prod'), 'Rendered HTML must contain application query');
  assert.ok(html.includes('returnTo=%2Fwebsites'), 'Rendered HTML must contain returnTo query');
  assert.ok(html.includes('/websites/dom-1/files?application=app-prod&amp;returnTo=%2Fwebsites'), 'Files link carries preserved queries');
  assert.ok(html.includes('/websites/dom-1/databases?application=app-prod&amp;returnTo=%2Fwebsites'), 'Databases link carries preserved queries');
  assert.ok(html.includes('/websites/dom-1/ssl?application=app-prod&amp;returnTo=%2Fwebsites'), 'SSL link carries preserved queries');
  assert.ok(html.includes('/websites/dom-1/settings?application=app-prod&amp;returnTo=%2Fwebsites'), 'Settings link carries preserved queries');
});

// ----------------------------------------------------------------------------
// 2. Runtime türüne göre desteklenmeyen araçların menüde/arayüzde görünmemesi
// ----------------------------------------------------------------------------

test('SiteDetailPage: runtime filtering strictly hides unsupported tools', async () => {
  const detailSource = await readSource('SiteDetailPage.jsx');

  // PHP tool is ONLY available when runtime or application is php (no escape hatch)
  assert.match(
    detailSource,
    /if \(key === 'php'\) return canManage && \(website\?\.runtimeType === 'php' \|\| application\?\.type === 'php'\);/,
    'PHP tool must only be available for PHP runtimes without bypass',
  );
  assert.doesNotMatch(
    detailSource,
    /if \(key === 'php'\)[^;]*tab === 'php'/,
    'PHP tool must NOT use tab === php bypass',
  );

  // Node and deploy tools require application or docker
  assert.match(
    detailSource,
    /if \(\['node', 'deploy'\]\.includes\(key\)\) return Boolean\(application\) \|\| website\?\.runtimeType === 'docker';/,
  );

  // Terminal tool is restricted to static, node, php
  assert.match(
    detailSource,
    /const managedTerminalWebsite = website && \['static', 'node', 'php'\]\.includes\(website\.runtimeType\);/,
  );
  assert.match(
    detailSource,
    /if \(key === 'terminal'\) return canManage && \(managedTerminalWebsite \|\| legacyManagedTarget\);/,
  );

  // Databases and mail require website entity
  assert.match(
    detailSource,
    /if \(\['databases', 'mail'\]\.includes\(key\)\) return canManage && Boolean\(website\);/,
  );

  // Shortcuts and hosting tools strictly filter against tabs
  assert.match(
    detailSource,
    /shortcuts = \[[\s\S]*?\]\.filter\(\(\[key\]\) => tabs\.some\(\(\[tabKey\]\) => key === tabKey\)\);/,
  );
  assert.match(
    detailSource,
    /hostingTools = \[[\s\S]*?\]\.filter\(\(\[key\]\) => tabs\.some\(\(\[tabKey\]\) => key === tabKey\)\);/,
  );

  // Unsupported tab access yields EmptyState
  assert.match(
    detailSource,
    /if \(!tabs\.some\(\(\[key\]\) => key === tab\)\) return <EmptyState title="Bu hedefte bu araç kullanılamaz" detail="Yalnız bu sitenin çalışma türüyle desteklenen yönetim araçları gösterilir\."/,
  );
});

test('runtime execution [TDZ check]: navigating to unsupported runtime tab executes without TDZ ReferenceError and renders EmptyState with preserved query', () => {
  // Static site navigating to unsupported 'php' tab with query params
  // Prior to fix, accessing `query` on line 105 caused ReferenceError: Cannot access 'query' before initialization
  let html;
  assert.doesNotThrow(() => {
    html = renderSiteDetailPage('/websites/dom-1/php?application=app-legacy&returnTo=%2Fwebsites');
  }, 'Must not throw ReferenceError / TDZ error when accessing unsupported tab');

  assert.ok(html.includes('Bu hedefte bu araç kullanılamaz'), 'Must render unsupported tab empty state title');
  assert.ok(html.includes('Yalnız bu sitenin çalışma türüyle desteklenen yönetim araçları gösterilir.'), 'Must render unsupported detail');
  assert.ok(html.includes('href="/websites/dom-1/overview?application=app-legacy&amp;returnTo=%2Fwebsites"'), 'Fallback button must preserve query parameters');
  assert.ok(html.includes('Siteye dön'), 'Fallback action button must exist');
});

test('runtime execution: runtime-based tool availability hides unsupported tools and shows supported ones in DOM', () => {
  // 1. Static runtime: PHP is unsupported, terminal and files are supported
  const staticWorkspace = createMockWorkspace({
    websites: { status: 'ready', items: [{ id: 'web-1', domainId: 'dom-1', runtimeType: 'static', state: 'active' }] },
  });
  const staticOverviewHtml = renderSiteDetailPage('/websites/dom-1/overview', staticWorkspace);
  assert.ok(!staticOverviewHtml.includes('/websites/dom-1/php'), 'PHP tool must NOT appear in menu or shortcuts for static site');
  assert.ok(staticOverviewHtml.includes('/websites/dom-1/files'), 'Files tool must appear for static site');

  // Terminal tool appears in hosting group and is accessible directly for static site
  const staticHostingHtml = renderSiteDetailPage('/websites/dom-1/hosting', staticWorkspace);
  assert.ok(staticHostingHtml.includes('/websites/dom-1/terminal'), 'Terminal tool link must appear in hosting tools for static site');
  const staticTerminalHtml = renderSiteDetailPage('/websites/dom-1/terminal', staticWorkspace);
  assert.ok(!staticTerminalHtml.includes('Bu hedefte bu araç kullanılamaz'), 'Accessing /terminal on static site must NOT show EmptyState');

  // Visiting unsupported php tab on static site shows EmptyState
  const staticPhpHtml = renderSiteDetailPage('/websites/dom-1/php', staticWorkspace);
  assert.ok(staticPhpHtml.includes('Bu hedefte bu araç kullanılamaz'), 'Accessing /php on static site must show EmptyState');

  // 2. PHP runtime: PHP is supported
  const phpWorkspace = createMockWorkspace({
    websites: { status: 'ready', items: [{ id: 'web-1', domainId: 'dom-1', runtimeType: 'php', state: 'active' }] },
  });
  const phpOverviewHtml = renderSiteDetailPage('/websites/dom-1/overview', phpWorkspace);
  assert.ok(phpOverviewHtml.includes('/websites/dom-1/php'), 'PHP tool must appear for php site');

  // Visiting php tab on PHP site renders PHP tools panel without EmptyState
  const phpHtml = renderSiteDetailPage('/websites/dom-1/php?application=app-php', phpWorkspace);
  assert.ok(!phpHtml.includes('Bu hedefte bu araç kullanılamaz'), 'Accessing /php on php site must NOT show EmptyState');
  assert.ok(phpHtml.includes('PHP / WordPress'), 'PHP tools panel must be rendered');

  // 3. Custom runtime (python) without application: terminal and php are unsupported
  const pythonWorkspace = createMockWorkspace({
    websites: { status: 'ready', items: [{ id: 'web-1', domainId: 'dom-1', runtimeType: 'python', state: 'active' }] },
  });
  const pythonTerminalHtml = renderSiteDetailPage('/websites/dom-1/terminal?application=app-py', pythonWorkspace);
  assert.ok(pythonTerminalHtml.includes('Bu hedefte bu araç kullanılamaz'), 'Terminal on python site must show EmptyState');
  assert.ok(pythonTerminalHtml.includes('href="/websites/dom-1/overview?application=app-py"'), 'Terminal fallback button must preserve application query');
});

// ----------------------------------------------------------------------------
// 3. Site Ayarları'na taşınan izolasyon audit/migration/rollback akışları
// ----------------------------------------------------------------------------

test('SiteDetailPage: tab === settings mounts WebsiteIsolationPanel with audit, migration, and rollback', async () => {
  const detailSource = await readSource('SiteDetailPage.jsx');
  const settingsBlock = detailSource.slice(detailSource.indexOf("{tab === 'settings'"));

  // WebsiteIsolationPanel is mounted under settings for owner
  assert.match(
    settingsBlock,
    /\{website && isOwner && <WebsiteIsolationPanel websiteId=\{website\.id\} onChanged=\{refreshAll\} \/>\}/,
    'WebsiteIsolationPanel must be mounted in tab === settings',
  );

  // Settings block also contains Barındırma bilgileri, DomainHostingPanel, WebsiteSuspensionPanel, WebsiteRemovalPanel
  assert.match(settingsBlock, /<DomainHostingPanel domain=\{domain\} \/>/);
  assert.match(settingsBlock, /<WebsiteSuspensionPanel domainId=\{domain\.id\} onChanged=\{refreshAll\} \/>/);
  assert.match(settingsBlock, /<Section title="Barındırma bilgileri">/);
  assert.match(settingsBlock, /<WebsiteRemovalPanel domainId=\{domain\.id\} onChanged=\{refreshAll\} \/>/);
  assert.match(settingsBlock, /<summary>Teknik kayıt kimlikleri<\/summary>/);
});

test('WebsiteIsolationPanel: provides audit, migration apply, and receipt rollback flows', async () => {
  const panelSource = await readSource('WebsiteIsolationPanel.jsx');

  // Audit
  assert.match(panelSource, /title="Website izolasyon denetimi"/);
  assert.match(panelSource, /getWebsiteIsolationAudit/);
  assert.match(panelSource, /audit\.inspectedSteps/);
  assert.match(panelSource, /audit\.findings/);

  // Migration apply
  assert.match(panelSource, /applyWebsiteIsolationMigration/);
  assert.match(panelSource, /Exact değişiklikleri uygula/);
  assert.match(panelSource, /Unix identity migration/);
  assert.match(panelSource, /SFTP migration/);
  assert.match(panelSource, /PHP-FPM pool migration/);
  assert.match(panelSource, /PHP container metadata migration/);
  assert.match(panelSource, /Static control metadata migration/);

  // Receipt rollback
  assert.match(panelSource, /rollbackWebsiteIsolationMigration/);
  assert.match(panelSource, /Receipt rollback/);
  assert.match(panelSource, /websiteIsolationRollbackConfirmation/);

  // Passenger handoff
  assert.match(panelSource, /getPassengerMigrationPreview/);
  assert.match(panelSource, /applyPassengerMigration/);
  assert.match(panelSource, /Passenger migration başlat/);
});

test('runtime execution: tab === settings renders WebsiteIsolationPanel with audit and migration sections in DOM', () => {
  const settingsHtml = renderSiteDetailPage('/websites/dom-1/settings?application=app-1');

  // WebsiteIsolationPanel rendered in DOM
  assert.ok(settingsHtml.includes('Website izolasyon denetimi'), 'Settings must render WebsiteIsolationPanel title');
  assert.ok(settingsHtml.includes('Barındırma bilgileri'), 'Settings must render Barındırma bilgileri section');
  assert.ok(settingsHtml.includes('Teknik kayıt kimlikleri'), 'Settings must render technical records summary');
});

// ----------------------------------------------------------------------------
// 4. Overview ekranında kalan provisioning recovery akışları
// ----------------------------------------------------------------------------

test('SiteDetailPage: tab === overview mounts ProvisioningRecoveryPanel after daily tools', async () => {
  const detailSource = await readSource('SiteDetailPage.jsx');
  const overviewBlock = detailSource.slice(
    detailSource.indexOf("{tab === 'overview'"),
    detailSource.indexOf("{tab === 'hosting'"),
  );

  // ProvisioningRecoveryPanel is mounted under overview for owner
  assert.match(
    overviewBlock,
    /\{website && isOwner && <ProvisioningRecoveryPanel websiteId=\{website\.id\} canManage=\{canManage\} onChanged=\{refreshAll\} \/>\}/,
    'ProvisioningRecoveryPanel must be mounted in tab === overview',
  );

  // ProvisioningRecoveryPanel appears after daily tools and publication info
  const toolsIndex = overviewBlock.indexOf('<Section title="Site araçları">');
  const pubIndex = overviewBlock.indexOf('<Section title="Yayın bilgileri"');
  const provIndex = overviewBlock.indexOf('<ProvisioningRecoveryPanel');
  const jobsIndex = overviewBlock.indexOf('<Section title="Bu siteye ait son işlemler"');

  assert.ok(toolsIndex !== -1, 'Site araçları section must exist in overview');
  assert.ok(pubIndex !== -1, 'Yayın bilgileri section must exist in overview');
  assert.ok(provIndex !== -1, 'ProvisioningRecoveryPanel must exist in overview');
  assert.ok(jobsIndex !== -1, 'Recent jobs section must exist in overview');

  assert.ok(toolsIndex < provIndex, 'Daily tools must precede provisioning recovery');
  assert.ok(pubIndex < provIndex, 'Publication info must precede provisioning recovery');
  assert.ok(provIndex < jobsIndex, 'Provisioning recovery must precede recent jobs');
});

test('ProvisioningRecoveryPanel: provides recovery flows with continue, retry, and compensate actions', async () => {
  const panelSource = await readSource('ProvisioningRecoveryPanel.jsx');

  // Recovery actions
  assert.match(panelSource, /prepare\('continue'/);
  assert.match(panelSource, /prepare\('retry'/);
  assert.match(panelSource, /prepare\('compensate'/);

  // Client helper calls
  assert.match(panelSource, /continueWebsiteProvisioning/);
  assert.match(panelSource, /retryWebsiteProvisioningStep/);
  assert.match(panelSource, /compensateWebsiteProvisioningStep/);

  // Session guard
  assert.match(panelSource, /usePanelSession/);
  assert.match(panelSource, /sessionVersion\(\)/);
});

test('runtime execution: tab === overview renders ProvisioningRecoveryPanel and daily tools in correct order in DOM', () => {
  const overviewHtml = renderSiteDetailPage('/websites/dom-1/overview?application=app-1');

  // Sections rendered in DOM
  const toolsPos = overviewHtml.indexOf('Site araçları');
  const provPos = overviewHtml.indexOf('Site kurulumu');
  const jobsPos = overviewHtml.indexOf('Bu siteye ait son işlemler');

  assert.ok(toolsPos !== -1, 'Overview DOM must render Site araçları section');
  assert.ok(provPos !== -1, 'Overview DOM must render Site kurulumu (Provisioning recovery) section');
  assert.ok(jobsPos !== -1, 'Overview DOM must render Recent jobs section');

  // Order assertion in rendered HTML
  assert.ok(toolsPos < provPos, 'Daily tools must render before provisioning recovery in DOM');
  assert.ok(provPos < jobsPos, 'Provisioning recovery must render before recent jobs in DOM');
});
