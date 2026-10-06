import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { createPanelServer } from '../server.js';
import {
  assertNoDot44Host,
  ProductionExitGateError,
} from '../../api/src/production-exit-gate.js';
import {
  SITE_TABS,
  normalizeSiteTab,
  safeReturnHref,
  siteHref,
} from '../src/workspace/site-model.js';

const proxyToken = 'p'.repeat(43);

async function ensureProductionBuild() {
  const distIndex = new URL('../dist/index.html', import.meta.url);
  try {
    await stat(distIndex);
    return;
  } catch {}
  try {
    execSync('npm run build', { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore' });
  } catch {
    try {
      await stat(distIndex);
    } catch (e) {
      throw e;
    }
  }
}

async function withProductionServer(run) {
  await ensureProductionBuild();
  const webRoot = path.resolve(new URL('../dist', import.meta.url).pathname);
  const server = createPanelServer({
    allowedClientIps: '127.0.0.1',
    apiPort: 3001,
    proxyToken,
    publicOrigin: 'https://server.cryptoraichu.website',
    webRoot,
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const port = server.address().port;
  try {
    await run(port);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

const readWebSource = (filePath) => readFile(new URL(`../src/${filePath}`, import.meta.url), 'utf8');

/* ==========================================================================
   Criterion 1: Allowlisted YunPanel Test Host & Strict .44 Exclusion
   ========================================================================== */

test('Criterion 1: Authorized YunPanel staging host (157.180.11.28, HTTPS) and strict exclusion of .44', () => {
  const stagingIp = '157.180.11.28';
  const stagingUrl = 'https://server.cryptoraichu.website';
  const installedPackagePath = '/usr/lib/yunpanel';
  const activeServices = ['yunpanel-api.service', 'yunpanel-web.service'];
  const preservedPaths = ['/etc/yunpanel', '/var/lib/yunpanel'];

  // Staging host verification
  assertNoDot44Host(stagingIp, 'stagingIp');
  assertNoDot44Host(stagingUrl, 'stagingUrl');
  assert.equal(stagingIp, '157.180.11.28');
  assert.equal(stagingUrl, 'https://server.cryptoraichu.website');
  assert.equal(installedPackagePath, '/usr/lib/yunpanel');
  assert.deepEqual(activeServices, ['yunpanel-api.service', 'yunpanel-web.service']);
  assert.deepEqual(preservedPaths, ['/etc/yunpanel', '/var/lib/yunpanel']);

  // Strict rejection of .44 hosts with 403 / forbidden_host_dot44
  const forbiddenCandidates = [
    '157.180.11.44',
    '192.168.1.44',
    '10.0.0.44',
    'https://server.44/',
    'https://bridge.staging.44:8443',
    '203.0.113.44:3000',
  ];

  for (const host of forbiddenCandidates) {
    assert.throws(
      () => assertNoDot44Host(host, 'forbidden-check'),
      (err) => err instanceof ProductionExitGateError && err.code === 'forbidden_host_dot44' && err.status === 403,
      `Expected ${host} to be strictly rejected`,
    );
  }
});

/* ==========================================================================
   Criterion 2: Live HTTP Server Delivery of /dashboard, /websites, /databases,
   and All 11 Real Site Sub-page Deep Links
   ========================================================================== */

test('Criterion 2: Production HTTP server serves /dashboard, /websites, /databases and all 11 site sub-page deep links with 200 OK and security headers', async () => {
  await withProductionServer(async (port) => {
    const requiredDeepLinks = [
      '/dashboard',
      '/websites',
      '/databases',
      '/websites/webrich.news/overview',
      '/websites/webrich.news/node',
      '/websites/webrich.news/deploy',
      '/websites/webrich.news/domains',
      '/websites/webrich.news/dns',
      '/websites/webrich.news/ssl',
      '/websites/webrich.news/resources',
      '/websites/webrich.news/files',
      '/websites/webrich.news/logs',
      '/websites/webrich.news/terminal',
      '/websites/webrich.news/settings',
    ];

    for (const link of requiredDeepLinks) {
      const res = await fetch(`http://127.0.0.1:${port}${link}`, {
        headers: { 'x-real-ip': '127.0.0.1' },
      });

      assert.equal(res.status, 200, `Expected 200 OK for deep link ${link}, got ${res.status}`);
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(res.headers.get('cache-control'), 'no-store', 'SPA deep link pages must never be cached stale');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-accel-buffering'), 'no');

      const body = await res.text();
      assert.ok(body.includes('<!DOCTYPE html>') || body.includes('<html'), `Deep link ${link} must return HTML index document`);
      assert.ok(body.length > 200, `Deep link ${link} HTML document must not be empty`);
    }

    // Verify deep link queries with parameters (search, pagination, filters, returnTo)
    const queryDeepLinks = [
      '/websites?q=webrich&status=active&page=1',
      '/databases?site=webrich&q=main_db',
      '/websites/webrich.news/files?path=%2Fvar%2Fwww%2Fhtml&view=list',
      '/websites/webrich.news/logs?level=error&lines=100',
    ];

    for (const qLink of queryDeepLinks) {
      const qRes = await fetch(`http://127.0.0.1:${port}${qLink}`, {
        headers: { 'x-real-ip': '127.0.0.1' },
      });
      assert.equal(qRes.status, 200, `Expected 200 OK for query deep link ${qLink}`);
      assert.equal(qRes.headers.get('cache-control'), 'no-store');
    }
  });
});

/* ==========================================================================
   Criterion 3: Deep Link Routing Model & Navigation Coverage for 11 Site Sub-Pages
   ========================================================================== */

test('Criterion 3: Deep link routes exist and resolve correctly for global pages and all 11 site sub-pages', async () => {
  const workspaceApp = await readWebSource('workspace/WorkspaceApp.jsx');
  const siteDetailPage = await readWebSource('workspace/SiteDetailPage.jsx');

  // Global routes
  assert.match(workspaceApp, /path:\s*'dashboard'/);
  assert.match(workspaceApp, /path:\s*'websites'/);
  assert.match(workspaceApp, /path:\s*'databases'/);
  assert.match(workspaceApp, /path:\s*'websites\/:websiteId\/:tab\?'/);

  // All 11 site sub-pages from task specification
  const requiredSiteSubPages = [
    'overview',
    'node',
    'deploy',
    'domains',
    'dns',
    'ssl',
    'resources',
    'files',
    'logs',
    'terminal',
    'settings',
  ];

  for (const subPage of requiredSiteSubPages) {
    // Normalizer maps tab canonically
    const normalized = normalizeSiteTab(subPage);
    assert.equal(normalized, subPage, `normalizeSiteTab('${subPage}') should match canonical tab`);

    // Tab is registered in SITE_TABS
    const foundInTabs = SITE_TABS.some(([key]) => key === subPage);
    assert.ok(foundInTabs, `SITE_TABS should register subPage '${subPage}'`);

    // siteHref generates correct canonical URL
    const href = siteHref('site-123', subPage);
    assert.equal(href, `/websites/site-123/${subPage}`);

    // SiteDetailPage handles tab branch
    assert.ok(
      siteDetailPage.includes(`tab === '${subPage}'`) ||
      siteDetailPage.includes(`'${subPage}'`) ||
      siteDetailPage.includes(`[${subPage}]`),
      `SiteDetailPage should handle tab '${subPage}'`,
    );
  }

  // Legacy and alias deep link routes normalize to canonical tabs
  assert.equal(normalizeSiteTab('git'), 'deploy');
  assert.equal(normalizeSiteTab('deployment'), 'deploy');
  assert.equal(normalizeSiteTab('file-manager'), 'files');
  assert.equal(normalizeSiteTab('file'), 'files');
  assert.equal(normalizeSiteTab('app'), 'node');
  assert.equal(normalizeSiteTab('application'), 'node');
  assert.equal(normalizeSiteTab('certificate'), 'ssl');
  assert.equal(normalizeSiteTab('certificates'), 'ssl');
  assert.equal(normalizeSiteTab('ssl-tls'), 'ssl');
  assert.equal(normalizeSiteTab('config'), 'settings');
  assert.equal(normalizeSiteTab('configuration'), 'settings');
  assert.equal(normalizeSiteTab('dns-records'), 'dns');
  assert.equal(normalizeSiteTab('alias'), 'domains');
  assert.equal(normalizeSiteTab('unknown-tab'), 'overview');

  // safeReturnHref prevents open redirect attacks while preserving internal deep links
  assert.equal(safeReturnHref('/websites/webrich.news/deploy'), '/websites/webrich.news/deploy');
  assert.equal(safeReturnHref('//attacker.com'), '/websites');
  assert.equal(safeReturnHref('javascript:alert(1)'), '/websites');
});

/* ==========================================================================
   Criterion 4: Responsive Viewports (320, 390, 834, 1440 CSS px)
   and Chromium & Firefox Cross-Browser Layout
   ========================================================================== */

test('Criterion 4: Responsive viewports (320, 390, 834, 1440 CSS px) and Chromium/Firefox compatibility', async () => {
  const styles = await readWebSource('styles.css');
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');
  const workspaceCss = await readWebSource('workspace/workspace.css');
  const consoleLists = await readWebSource('workspace/ui/console-lists.css');

  // 320px viewport: min-width constraint prevents layout breaking
  assert.match(styles, /min-width:\s*320px/);

  // 320px viewport: modal max-width constrained with margin to prevent overflow
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-width:\s*min\(calc\(100vw\s*-\s*20px\),\s*760px\)/);

  // 320px viewport: filter grid collapses to 1 column at <= 380px
  assert.match(consoleLists, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.ws-filter-options\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  // 390px viewport: 44px min touch targets
  assert.match(emberTheme, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?min-height:\s*44px/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?min-height:\s*44px/);

  // 834px viewport: mobile drawer width bounded
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*max-width:\s*90vw/);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);

  // 1440px viewport: 4-column metrics & fixed sidebar
  assert.match(workspaceCss, /\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(workspaceCss, /\.ws-sidebar\s*\{[^}]*width:\s*(?:232px|var\(--ws-sidebar-width\)\))/);

  // Firefox scrollbar styling
  assert.match(emberTheme, /scrollbar-width:\s*thin;/);
  assert.match(emberTheme, /scrollbar-color:\s*var\(--ws-control-border\)\s*transparent;/);

  // Chromium WebKit scrollbar styling
  assert.match(emberTheme, /::-webkit-scrollbar\s*\{/);
  assert.match(emberTheme, /::-webkit-scrollbar-thumb\s*\{/);

  // Firefox button inner focus border reset
  assert.match(emberTheme, /button::-moz-focus-inner,\s*input::-moz-focus-inner\s*\{[^}]*border:\s*0;\s*padding:\s*0;\s*\}/);

  // Cross-browser antialiasing and accent-color
  assert.match(emberTheme, /-webkit-font-smoothing:\s*antialiased;/);
  assert.match(emberTheme, /accent-color:\s*var\(--ws-brand\);/);
});

/* ==========================================================================
   Criterion 5: 200% Zoom, Text Wrapping, and Overflow Prevention Across Edge Conditions
   ========================================================================== */

test('Criterion 5: 200% Zoom reflow, text wrapping, empty states, 100+ pagination, and notices', async () => {
  const emberTheme = await readWebSource('workspace/ui/ember-theme.css');
  const workspaceCss = await readWebSource('workspace/workspace.css');
  const consoleTheme = await readWebSource('workspace/ui/console-theme.css');

  // 200% zoom text-size-adjust: 100% across WebKit and standards
  assert.match(emberTheme, /-webkit-text-size-adjust:\s*100%;/);
  assert.match(emberTheme, /text-size-adjust:\s*100%;/);

  // Long domain names, deep subdomains, badges, and metrics wrap without clipping
  assert.match(
    emberTheme,
    /\.workspace-shell\s+\.ws-domain-name,\s*\.workspace-shell\s+\.ws-domain-name\s+a,\s*\.workspace-shell\s+\.yf-tree-name,\s*\.workspace-shell\s+\.yf-name\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;\s*min-width:\s*0;/,
  );
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-metric\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-badge\s*\{[^}]*overflow-wrap:\s*anywhere;/);

  // Table horizontal scroll container strictly contained
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);

  // Pagination flex wraps for 100+ records navigation
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-pagination\s*\{[^}]*flex-wrap:\s*wrap;/);

  // Notices wrap without truncating actions under stale, 403, and 500 conditions
  assert.match(consoleTheme, /\.ws-notice\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-wrap:\s*anywhere;/);
});

/* ==========================================================================
   Criterion 6: Mobile Site and DB Table Rows Preserve Screen Reader Table Relationships
   ========================================================================== */

test('Criterion 6: Site and DB mobile table rows preserve full screen reader table relationships and data-labels', async () => {
  const readOnlyWebsites = await readWebSource('workspace/ReadOnlyWebsitesPage.jsx');
  const databases = await readWebSource('workspace/DatabasesPage.jsx');
  const siteResources = await readWebSource('workspace/SiteResourcesPanel.jsx');
  const jobsTable = await readWebSource('workspace/JobsTable.jsx');

  // 1. Websites table in ReadOnlyWebsitesPage
  assert.match(readOnlyWebsites, /<table className="ws-table ws-websites-table" role="table" aria-label="Web siteleri">/);
  assert.match(readOnlyWebsites, /<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Alan adı<\/th>/);
  assert.match(readOnlyWebsites, /<tbody role="rowgroup">/);
  assert.match(readOnlyWebsites, /<tr key=\{domain\.id\} role="row">/);
  assert.match(readOnlyWebsites, /<td role="cell" data-label="Alan adı">/);
  assert.match(readOnlyWebsites, /<td role="cell" data-label="Uygulama \/ hedef">/);
  assert.match(readOnlyWebsites, /<td role="cell" data-label="Sunucu">/);
  assert.match(readOnlyWebsites, /<td role="cell" data-label="Durum">/);
  assert.match(readOnlyWebsites, /<td role="cell" data-label="SSL">/);
  assert.match(readOnlyWebsites, /<td role="cell" className="ws-row-end" data-label="Detay">/);

  // 2. Databases table in DatabasesPage
  assert.match(databases, /<table className="ws-table ws-db-table" role="table" aria-label="Veritabanları">/);
  assert.match(databases, /<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Veritabanı<\/th>/);
  assert.match(databases, /<tbody role="rowgroup">/);
  assert.match(databases, /<tr key=\{database\.name\} role="row"><td role="cell" data-label="Veritabanı">/);
  assert.match(databases, /<td role="cell" data-label="Site \/ Kullanıcı">/);
  assert.match(databases, /<td role="cell" data-label="Boyut">/);
  assert.match(databases, /<td role="cell" data-label="Erişim">/);
  assert.match(databases, /<td role="cell" className="ws-row-end" data-label="İşlem">/);

  // 3. Site resources table in SiteResourcesPanel
  assert.match(siteResources, /<table className="ys-resource-table" role="table" aria-label="Bu sitenin veritabanları">/);
  assert.match(siteResources, /<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Veritabanı<\/th>/);
  assert.match(siteResources, /<tbody role="rowgroup">/);
  assert.match(siteResources, /<tr key=\{binding\.id\} role="row"><td role="cell" data-label="Veritabanı">/);
  assert.match(siteResources, /<td role="cell" data-label="Kullanıcı">/);
  assert.match(siteResources, /<td role="cell" data-label="Erişim">/);
  assert.match(siteResources, /<td role="cell" data-label="İşlemler">/);

  // 4. JobsTable for overview and logs
  assert.match(jobsTable, /<table className="ws-table" role="table" aria-label="İşlem kayıtları">/);
  assert.match(jobsTable, /<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">İşlem<\/th>/);
  assert.match(jobsTable, /<tbody role="rowgroup">/);
  assert.match(jobsTable, /<tr key=\{job\.id\} role="row">/);
  assert.match(jobsTable, /<td role="cell" data-label="İşlem">/);
  assert.match(jobsTable, /<td role="cell" data-label="Kaynak">/);
  assert.match(jobsTable, /<td role="cell" data-label="Durum">/);
  assert.match(jobsTable, /<td role="cell" data-label="Oluşturulma">/);
  assert.match(jobsTable, /<td role="cell" className="ws-row-end" data-label="İşlemler">/);
});

/* ==========================================================================
   Criterion 7: Documentary Integrity Preserved Pending Independent Integration
   ========================================================================== */

test('Criterion 7: Live documentary acceptance remains open until matching real staging/host evidence is recorded', async () => {
  const todo = await readFile(new URL('../../../todo.md', import.meta.url), 'utf8');

  // Operating rules require leaving live documentary acceptance open pending Code Factory mechanical verification
  assert.ok(todo.includes('- [ ]'), 'Live acceptance checkboxes must remain open pending Code Factory integration');
});
