import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { usageThreshold, usagePercent } from '../src/workspace/ui/console-model.js';
import { navigationGroups } from '../src/workspace/ui/ux-model.js';

const source = (relPath) => readFile(new URL(`../src/${relPath}`, import.meta.url), 'utf8');

test('YP-16: Site-centric entry is preserved; dashboard is not forced into primary navigation', async () => {
  const appSrc = await source('workspace/WorkspaceApp.jsx');
  // Root index redirects directly to websites
  assert.match(appSrc, /index:\s*true,\s*element:\s*<Navigate to="\/websites" replace \/>/);

  // Navigation groups for owner and customer preserve Plesk hierarchy without top-level /dashboard
  const ownerNav = navigationGroups(true, true, false, false);
  const ownerItems = ownerNav.flatMap((group) => group.items.map(([path]) => path));
  assert.ok(ownerItems.includes('/websites'), 'Must include /websites');
  assert.ok(!ownerItems.includes('/dashboard'), 'Dashboard must not replace site-centric entry in primary navigation');

  const customerNav = navigationGroups(false, false, false, false);
  const customerItems = customerNav.flatMap((group) => group.items.map(([path]) => path));
  assert.ok(customerItems.includes('/websites'), 'Customer nav must include /websites');
  assert.ok(!customerItems.includes('/dashboard'), 'Customer nav must not have dashboard as primary entry');

  // /dashboard remains accessible as an explicit route
  assert.match(appSrc, /path:\s*['"]dashboard['"]/);
});

test('YP-16: usageThreshold helper correctly classifies normal, high, critical and unknown states', () => {
  // Edge case 0%
  assert.equal(usageThreshold(0), 'normal');
  assert.equal(usageThreshold(50), 'normal');
  assert.equal(usageThreshold(84), 'normal');
  assert.equal(usageThreshold(84.9), 'normal');

  // Warning threshold >= 85%
  assert.equal(usageThreshold(85), 'high');
  assert.equal(usageThreshold(89), 'high');
  assert.equal(usageThreshold(89.9), 'high');

  // Critical threshold >= 90% (including 91% requirement)
  assert.equal(usageThreshold(90), 'critical');
  assert.equal(usageThreshold(91), 'critical');
  assert.equal(usageThreshold(100), 'critical');

  // Unknown / invalid values
  assert.equal(usageThreshold(null), 'unknown');
  assert.equal(usageThreshold(undefined), 'unknown');
  assert.equal(usageThreshold(NaN), 'unknown');
  assert.equal(usageThreshold(-1), 'unknown');
  assert.equal(usageThreshold(101), 'unknown');
  assert.equal(usageThreshold('invalid'), 'unknown');
});

test('YP-16: UsageRing component handles 0%, 91% critical, and unknown data with accessibility semantics', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');

  // UsageRing must be exported for modular reuse
  assert.match(dashSrc, /export function UsageRing\(\{ label, value, detail \}\)/);

  // Accessible progressbar attributes
  assert.match(dashSrc, /role="progressbar"/);
  assert.match(dashSrc, /tabIndex=\{0\}/, 'Keyboard navigable via tabIndex');
  assert.match(dashSrc, /aria-label=\{`\$\{label\} kullanımı`\}/);
  assert.match(dashSrc, /aria-valuemin=\{0\}/);
  assert.match(dashSrc, /aria-valuemax=\{100\}/);
  assert.match(dashSrc, /aria-valuenow=\{rounded \?\? undefined\}/);
  assert.match(dashSrc, /aria-valuetext=\{ariaState\}/);

  // Distinguishes critical (>= 90%), high (>= 85%), normal, and unknown
  assert.match(dashSrc, /value >= 90/);
  assert.match(dashSrc, /value >= 85/);
  assert.match(dashSrc, /is-critical/);
  assert.match(dashSrc, /is-unknown/);
  assert.match(dashSrc, /Kritik doluluk/);
  assert.match(dashSrc, /kullanım verisi bilinmiyor/);

  // Zero percent is treated as valid number (%0), not falling back to unknown dash
  assert.match(dashSrc, /strong>\{valid \? `%\$\{rounded\}` : '—'\}<\/strong>/);
});

test('YP-16: ServerSummary safely formats real system metrics with fallback for null/partial data', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');
  assert.match(dashSrc, /export function ServerSummary\(\{ server \}\)/);

  // Uses real inventory values: cpu.usagePercent, memory, filesystem
  assert.match(dashSrc, /cpu\?\.usagePercent/);
  assert.match(dashSrc, /usagePercent\(memory\.usedBytes,\s*memory\.totalBytes\)/);
  assert.match(dashSrc, /usagePercent\(disk\.usedBytes,\s*disk\.totalBytes\)/);

  // Safe formatting for memory and disk detail bytes
  assert.match(dashSrc, /formatBytes/);
});

test('YP-16: Disk full warning handles <85%, 85-89% (warning) and >=90% (critical, e.g. 91%)', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');
  const readOnlySrc = await source('workspace/ReadOnlyDashboardPage.jsx');

  for (const [name, src] of [['DashboardPage', dashSrc], ['ReadOnlyDashboardPage', readOnlySrc]]) {
    // Disk usage calculation
    assert.match(src, /diskUsage !== null && diskUsage >= 90/, `${name} must check >= 90% critical threshold`);
    assert.match(src, /ws-notice-error/, `${name} must use error styling for critical`);
    assert.match(src, /role="alert"/, `${name} must use alert role`);
    assert.match(src, /aria-live="assertive"/, `${name} critical notice must be assertive`);
    assert.match(src, /Kritik disk doluluğu/, `${name} must display critical text`);

    // Warning tier (85-89%)
    assert.match(src, /diskUsage >= 85/, `${name} must check >= 85% warning threshold`);
    assert.match(src, /ws-notice-warn/, `${name} must use warning notice for 85-89%`);
    assert.match(src, /aria-live="polite"/, `${name} warning notice must be polite`);
    assert.match(src, /Disk alanı azalıyor/, `${name} must display warning text`);
  }
});

test('YP-16: SSL status, active jobs and error summaries reflect real data accurately', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');

  // SSL status calculation handles ready and stale states
  assert.match(dashSrc, /certsReadable/);
  assert.match(dashSrc, /aria-label="SSL sertifika uyarıları"/);

  // Job summary badges and error inspection link
  assert.match(dashSrc, /ws-job-summary/);
  assert.match(dashSrc, /activeJobs \?\? '—'\} devam eden/);
  assert.match(dashSrc, /failedJobs \?\? '—'\} başarısız/);
  assert.match(dashSrc, /to="\/jobs\?status=failed"/);

  // UsageHistory keeps real data across revalidations
  assert.match(dashSrc, /\['ready', 'stale'\]\.includes\(servers\.status\) \? server : null/);
});

test('YP-16: Accessibility CSS covers .is-critical, keyboard focus-visible, and reduced-motion', async () => {
  const consoleCss = await source('workspace/ui/console-theme.css');
  const emberCss = await source('workspace/ui/ember-theme.css');
  const workspaceCss = await source('workspace/workspace.css');

  // Critical usage ring styling
  assert.match(consoleCss, /\.ws-usage-ring\.is-critical/);
  assert.match(consoleCss, /var\(--ws-danger\)/);
  assert.match(emberCss, /\.ws-usage-ring\.is-critical/);
  assert.match(emberCss, /var\(--ws-danger\)/);

  // Keyboard focus styling
  assert.match(consoleCss, /\.ws-usage-ring:focus-visible/);
  assert.match(consoleCss, /outline:\s*2px solid var\(--ws-focus\)/);
  assert.match(emberCss, /\.ws-usage-ring:focus-visible/);
  assert.match(emberCss, /outline:\s*2px solid var\(--ws-focus\)/);

  // Forced colors / high contrast
  assert.match(consoleCss, /@media \(forced-colors: active\) \{[\s\S]*?\.ws-usage-ring \{ border: 3px solid CanvasText; \}/);
  assert.match(emberCss, /@media \(forced-colors: active\) \{[\s\S]*?\.ws-usage-ring \{ border: 3px solid CanvasText; \}/);

  // Reduced motion
  assert.match(workspaceCss, /@media \(prefers-reduced-motion: reduce\) \{ \.ws-server-metrics \.ws-usage-ring \{ transition: none; \} \}/);
});

test('YP-16 / T-VISUAL: Website list is removed from Overview; replaced by total website count and accessible link', async () => {
  const readOnlySrc = await source('workspace/ReadOnlyDashboardPage.jsx');
  const dashSrc = await source('workspace/DashboardPage.jsx');

  // ReadOnlyDashboardPage must not contain a website table listing individual domains
  assert.doesNotMatch(readOnlySrc, /<table className="ws-table"><thead><tr><th>Alan adı/, 'ReadOnlyDashboardPage must not list websites in a table');
  assert.doesNotMatch(readOnlySrc, /domains\.items\.slice\(0,\s*6\)/, 'ReadOnlyDashboardPage must not slice/list individual website records');

  // ReadOnlyDashboardPage must display the website count and accessible link to /websites
  assert.match(readOnlySrc, /ws-site-count/, 'Must use ws-site-count class for prominent count');
  assert.match(readOnlySrc, /knownCount\(domains\)/, 'Must display known domain count');
  assert.match(readOnlySrc, /to="\/websites"/, 'Must contain link to /websites');
  assert.match(readOnlySrc, /aria-label="Web siteleri listesine git"/, 'Must provide accessible link label');

  // DashboardPage also provides site count and accessible link, without a website list table
  assert.doesNotMatch(dashSrc, /<table[^>]*>[\s\S]*?primaryDomain/, 'DashboardPage must not render a table listing website domains');
  assert.match(dashSrc, /websiteCount\(websites\)/, 'DashboardPage presents website count');
  assert.match(dashSrc, /to="\/websites"/, 'DashboardPage links to /websites');
  assert.match(dashSrc, /aria-label=/, 'DashboardPage links provide accessible aria labels');
});

test('YP-16 / T-VISUAL: UsageRing handles 0%, unknown, 91%, high, error states with gauge arc and accessible text', async () => {
  const dashSrc = await source('workspace/DashboardPage.jsx');
  const consoleCss = await source('workspace/ui/console-theme.css');
  const emberCss = await source('workspace/ui/ember-theme.css');
  const workspaceCss = await source('workspace/workspace.css');

  // UsageRing handles error state and server error fallback
  assert.match(dashSrc, /is-error/, 'UsageRing must support is-error class');
  assert.match(dashSrc, /kullanım verisinde hata/, 'UsageRing must describe error in ariaState');
  assert.match(dashSrc, /server\?\.connectivity === 'error'/, 'ServerSummary handles server error state');

  // CSS arc definitions (conic-gradient gauge/arc)
  for (const [name, css] of [['workspaceCss', workspaceCss], ['consoleCss', consoleCss], ['emberCss', emberCss]]) {
    assert.match(css, /conic-gradient/, `${name} must use conic-gradient for gauge arcs`);
    assert.match(css, /\.ws-usage-ring\.is-high/, `${name} must style high usage arc`);
    assert.match(css, /\.ws-usage-ring\.is-critical/, `${name} must style critical usage arc`);
    assert.match(css, /\.ws-usage-ring\.is-unknown/, `${name} must style unknown usage ring`);
    assert.match(css, /\.ws-usage-ring\.is-error/, `${name} must style error usage ring`);
    assert.match(css, /\.ws-site-count/, `${name} must style ws-site-count`);
  }
});

test('YP-16 / T-VISUAL: Long jobs and logs do not overflow the panel layout and retain full details and access', async () => {
  const consoleCss = await source('workspace/ui/console-theme.css');
  const emberCss = await source('workspace/ui/ember-theme.css');
  const workspaceCss = await source('workspace/workspace.css');

  // Table td and code wrapping
  for (const [name, css] of [['workspaceCss', workspaceCss], ['consoleCss', consoleCss], ['emberCss', emberCss]]) {
    assert.match(css, /\.ws-table td/, `${name} must style .ws-table td`);
    assert.match(css, /overflow-wrap:\s*anywhere/, `${name} must wrap long content anywhere`);
    assert.match(css, /\.ws-table-scroll/, `${name} must support .ws-table-scroll`);
  }

  // JobsTable and LogsPanel use .ws-table-scroll for contained scrolling
  const jobsTableSrc = await source('workspace/JobsTable.jsx');
  const logsPanelSrc = await source('workspace/LogsPanel.jsx');
  assert.match(jobsTableSrc, /className="ws-table-scroll"/);
  assert.match(logsPanelSrc, /className="ws-table-scroll"/);
});
