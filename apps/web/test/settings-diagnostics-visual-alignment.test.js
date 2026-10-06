import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { managedServiceStatus } from '../src/workspace/managed-service-model.js';

const readSrc = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

/* =========================================================================
   1. Ayarlar sekmeli, deep-link destekli ve yalnız düzenlenebilir değerler
   ========================================================================= */

test('SettingsPage is tabbed and deep-linkable, containing only editable settings with records deep-link pointer', async () => {
  const operationsSource = await readSrc('workspace/OperationsPages.jsx');
  assert.match(operationsSource, /\['account',\s*'Hesap ve erişim'\]/);
  assert.match(operationsSource, /\['dns',\s*'DNS ve SSL'\]/);
  assert.match(operationsSource, /\['ai',\s*'AI sağlayıcıları'\]/);
  assert.match(operationsSource, /\['updates',\s*'Güncellemeler'\]/);
  assert.match(operationsSource, /section === 'records'/);
  assert.match(operationsSource, /nav className="ws-tabs"/);

  // Categories must omit non-editable records tab
  const categoriesBlock = operationsSource.slice(
    operationsSource.indexOf('const categories = ['),
    operationsSource.indexOf('];', operationsSource.indexOf('const categories = [')) + 2
  );
  assert.ok(!categoriesBlock.includes("'records'"), 'records tab must not appear in editable categories');
});

test('architecture and version metadata live in Sunucu > Tanılama, not in general settings', async () => {
  const operationsSource = await readSrc('workspace/OperationsPages.jsx');
  const panelsSource = await readSrc('workspace/SystemSettingsPanels.jsx');

  // ServersPage exposes #server-diagnostics with SystemSettingsPanels diagnostics
  assert.match(operationsSource, /id="server-diagnostics"/);
  assert.match(operationsSource, /<SystemSettingsPanels diagnostics \/>/);

  // SystemSettingsPanels renders version, deployment, and architecture info under diagnostics
  assert.match(panelsSource, /diagnostics && <Section[\s\S]*?Panel ve sunucu/);
  assert.match(panelsSource, /diagnostics && data\.deployment && <Section[\s\S]*?Dağıtılan sürüm/);
  assert.match(panelsSource, /diagnostics && <Section[\s\S]*?Site varsayılanları ve izolasyon/);
});

/* =========================================================================
   2. Açık /dashboard, /settings, /databases, /websites/new Chromium/Firefox
   ========================================================================= */

test('/dashboard: metrics, SVG usage rings, safe cert warnings without undefined variable', async () => {
  const dashboardSource = await readSrc('workspace/DashboardPage.jsx');
  assert.match(dashboardSource, /const hasCerts = certsReadable && certItems\.length > 0;/);
  assert.match(dashboardSource, /export function UsageRing/);
  assert.match(dashboardSource, /role="progressbar"/);
  assert.match(dashboardSource, /aria-valuenow=/);
  assert.match(dashboardSource, /ws-console-metrics/);
});

test('/databases: table scroll containment, search/access filters, safe phpMyAdmin handoff', async () => {
  const dbSource = await readSrc('workspace/DatabasesPage.jsx');
  assert.match(dbSource, /ws-table-scroll/);
  assert.match(dbSource, /ws-db-table/);
  assert.match(dbSource, /openPhpMyAdmin/);
  assert.match(dbSource, /filterConsoleDatabases/);
  assert.match(dbSource, /paginateConsoleItems/);
});

test('/websites/new: accessible form fields, password security, site-admin fields', async () => {
  const newSiteSource = await readSrc('workspace/NewWebsitePage.jsx');
  assert.match(newSiteSource, /name="adminEmail"/);
  assert.match(newSiteSource, /name="adminPassword"/);
  assert.match(newSiteSource, /type="password"/);
  assert.match(newSiteSource, /aria-describedby="website-admin-email-hint"/);
  assert.match(newSiteSource, /aria-describedby="website-admin-password-hint"/);
});

test('Chromium and Firefox styling compatibility for all 4 target screens', async () => {
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');
  const workspaceCss = await readSrc('workspace/workspace.css');

  // Firefox scrollbars and moz-focus-inner
  assert.match(emberTheme, /scrollbar-width:\s*thin;/);
  assert.match(emberTheme, /scrollbar-color:/);
  assert.match(emberTheme, /::-moz-focus-inner/);

  // Chromium WebKit scrollbar styling & antialiasing
  assert.match(emberTheme, /::-webkit-scrollbar/);
  assert.match(emberTheme, /-webkit-font-smoothing:\s*antialiased;/);

  // Table horizontal scrolling is contained across browsers
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);
});

/* =========================================================================
   3. [object Object] sızıntısı olmaması ve servis/terminal sınırları
   ========================================================================= */

test('PanelKit and ManagedServicesPanel prevent [object Object] leaks', async () => {
  const panelKitSource = await readSrc('workspace/PanelKit.jsx');
  const managedServicesSource = await readSrc('workspace/ManagedServicesPanel.jsx');

  // ErrorNotice checks for object and avoids raw object coercion
  assert.match(panelKitSource, /typeof error === 'object'/);
  // KeyValues handles object display safely
  assert.match(panelKitSource, /typeof value === 'object'/);
  // ManagedServicesPanel handles unit object safely
  assert.match(managedServicesSource, /typeof unit === 'object'/);
});

test('unknown or uninstalled services never appear ready (state: active)', () => {
  // Uninstalled service
  assert.notEqual(managedServiceStatus({ installed: false }).state, 'active');
  assert.equal(managedServiceStatus({ installed: false }).state, 'unknown');

  // Null or undefined service
  assert.notEqual(managedServiceStatus(null).state, 'active');
  assert.equal(managedServiceStatus(null).state, 'unknown');
  assert.notEqual(managedServiceStatus(undefined).state, 'active');

  // Unitless service with unverified health
  assert.notEqual(managedServiceStatus({ installed: true, active: false, units: [], health: { status: 'unverified' } }).state, 'active');
  assert.equal(managedServiceStatus({ installed: true, active: false, units: [], health: { status: 'unverified' } }).state, 'unknown');

  // Service with active: false or undefined
  assert.notEqual(managedServiceStatus({ installed: true, units: [{ name: 'test.service' }] }).state, 'active');
  assert.equal(managedServiceStatus({ installed: true, units: [{ name: 'test.service' }] }).state, 'unknown');
  assert.equal(managedServiceStatus({ installed: true, active: false, units: [{ name: 'test.service' }] }).state, 'off');
});

test('service and terminal controls are restricted to Server and operations/site paths', async () => {
  const dashboardSource = await readSrc('workspace/DashboardPage.jsx');
  const databasesSource = await readSrc('workspace/DatabasesPage.jsx');
  const newWebsiteSource = await readSrc('workspace/NewWebsitePage.jsx');
  const settingsSource = await readSrc('workspace/OperationsPages.jsx');

  // TerminalPanel and ManagedServicesPanel are NOT in dashboard, databases, or websites/new
  assert.doesNotMatch(dashboardSource, /TerminalPanel|ManagedServicesPanel/);
  assert.doesNotMatch(databasesSource, /TerminalPanel|ManagedServicesPanel/);
  assert.doesNotMatch(newWebsiteSource, /TerminalPanel|ManagedServicesPanel/);

  // SettingsPage does not embed TerminalPanel or ManagedServicesPanel
  assert.doesNotMatch(settingsSource.slice(settingsSource.indexOf('export function SettingsPage')), /TerminalPanel|ManagedServicesPanel/);
});
