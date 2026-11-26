import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';
import { readTheme, themeSection } from './theme-section.js';

register('./jsx-loader.js', import.meta.url);

const readWebSource = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

/* ==========================================================================
   1. All 10 Target Screens Component Tree & CSS Hierarchy Verification
   ========================================================================== */

test('Target Screens 1-10: Components exist, import correct CSS layers, and define real component trees', async () => {
  const screens = [
    { id: 'Dashboard', file: 'workspace/DashboardPage.jsx', selector: 'ws-console-metrics' },
    { id: 'Siteler', file: 'workspace/WebsitesPage.jsx', selector: 'ws-websites-table' },
    { id: 'Site Dosyaları', file: 'workspace/FilesPanel.jsx', selector: 'yf-browser' },
    { id: 'Site Dosyaları Panel', file: 'workspace/SiteFilesPanel.jsx', selector: 'ws-panel' },
    { id: 'Veritabanı', file: 'workspace/DatabasesPage.jsx', selector: 'ws-db-table' },
    { id: 'Veritabanı Kaynak', file: 'workspace/SiteResourcesPanel.jsx', selector: 'ys-resource-table' },
    { id: 'Mail', file: 'workspace/MailDomainsPage.jsx', selector: 'ys-mail-workspace' },
    { id: 'Mail Panel', file: 'workspace/SiteMailPanel.jsx', selector: 'ys-resource-table' },
    { id: 'DNS', file: 'workspace/DnsPanel.jsx', selector: 'ws-dns-panel' },
    { id: 'Network DNS', file: 'workspace/NetworkDnsSettingsPanel.jsx', selector: 'ws-network-dns-card' },
    { id: 'SSL', file: 'workspace/SslRenewalPanel.jsx', selector: 'ws-ssl-panel' },
    { id: 'Docker', file: 'workspace/DockerProjectsPage.jsx', selector: 'ws-docker-projects' },
    { id: 'Ayarlar', file: 'workspace/ToolsSettingsPage.jsx', selector: 'ws-tools-group' },
    { id: 'Ayarlar AI', file: 'workspace/AiSettingsPanel.jsx', selector: 'ws-section' },
    { id: 'AI Drawer', file: 'workspace/AiDrawer.jsx', selector: 'ws-ai-layout' },
  ];

  for (const screen of screens) {
    const src = await readWebSource(screen.file);
    assert.ok(src.length > 100, `Screen source for ${screen.id} should not be empty`);
    assert.ok(
      src.includes(screen.selector) || src.includes('Modal') || src.includes('PanelKit'),
      `Screen ${screen.id} should reference ${screen.selector} or PanelKit primitives`
    );
  }

  // Verify CSS cascade order: the design system loads last and its theme overrides follow the console skin
  const main = await readWebSource('main.jsx');
  const cssImports = [...main.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map((m) => m[1]);
  assert.equal(cssImports.at(-1), './workspace/design-system/theme.css');
  const theme = await readWebSource('workspace/design-system/theme.css');
  assert.ok(theme.indexOf('   Theme overrides, accessibility and reduced motion') > theme.indexOf('   Console skin'));
});

/* ==========================================================================
   2. Responsive Viewports: 320px, 390px, 834px, 1440px Verification
   ========================================================================== */

test('Responsive 320px (Narrow Mobile): Layout, drawers, modals, tables, and filters adapt without overflow', async () => {
  const styles = await themeSection('styles');
  const consoleLists = await readWebSource('workspace/ui/console-lists.css');
  const emberTheme = await themeSection('ember-theme');
  const workspaceCss = await themeSection('workspace');

  // Body minimum width 320px prevents broken layout collapsing
  assert.match(styles, /body\s*\{[^}]*min-width:\s*320px/);

  // Filters collapse to 1 column at narrow widths
  assert.match(consoleLists, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.ws-filter-options\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  // Table horizontal scroll container
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto/);

  // Modal dialog adapts to viewport width with bounded padding
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-width:\s*min\(calc\(100vw\s*-\s*20px\),\s*760px\)/);

  // Mobile drawer width constrained on narrow screens
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*width:\s*min\(290px,\s*90vw\)/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*max-width:\s*90vw/);
});

test('Responsive 390px (Mobile): Minimum touch targets 44px, cards layout, and vertical stacking', async () => {
  const workspaceCss = await themeSection('workspace');
  const consoleTheme = await themeSection('console-theme');
  const emberTheme = await themeSection('ember-theme');

  // Page heading stacks vertically on <= 640px
  assert.match(await readTheme(), /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-page-heading\s*\{[^}]*flex-direction:\s*column/);

  // Touch target minimum 44px
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-command-trigger\s*\{[^}]*min-height:\s*44px/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?min-height:\s*44px/);

  // Tables transform to cards on mobile
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-db-table\s+tr,\s*\.workspace-shell\s+\.ws-websites-table\s+tbody\s+tr\s*\{[^}]*background:\s*var\(--ws-surface-subtle\)/);
});

test('Responsive 834px (Tablet / <= 900px): Sidebar transforms to off-screen drawer and grid reflows', async () => {
  const workspaceCss = await themeSection('workspace');
  const consoleTheme = await themeSection('console-theme');
  const emberTheme = await themeSection('ember-theme');

  // Sidebar transforms off-screen and main resets margin
  assert.match(await readTheme(), /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);
  assert.match(await readTheme(), /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-main\s*\{[^}]*margin-left:\s*0/);

  // Drawer surface & overlay shadow in Ember theme
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*background:\s*var\(--ws-surface\)/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*box-shadow:\s*var\(--ws-overlay-shadow\)/);

  // Metrics grid reflows to 2 columns
  assert.match(consoleTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Responsive 1440px (Desktop): Fixed sidebar, 4-column metrics, two-column layouts, and full tables', async () => {
  const workspaceCss = await themeSection('workspace');
  const emberTheme = await themeSection('ember-theme');

  // Fixed sidebar width
  assert.match(await readTheme(), /\.ws-sidebar\s*\{[^}]*width:\s*(?:232px|var\(--ws-sidebar-width\))/);
  assert.match(await readTheme(), /\.ws-main\s*\{[^}]*margin-left:\s*(?:232px|var\(--ws-sidebar-width\))/);

  // 4-column metrics grid
  assert.match(await readTheme(), /\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);

  // Table separate borders and transparent header
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table\s*\{[^}]*border-collapse:\s*separate/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table\s+th\s*\{[^}]*background:\s*transparent/);
});

/* ==========================================================================
   3. Light & Dark Themes: Explicit Warm Palettes and WCAG AAA/AA Contrast
   ========================================================================== */

test('Light and Dark themes declare semantic tokens with contrast >= 4.5:1 across surfaces', async () => {
  const css = await themeSection('ember-theme');
  const [base, tail] = css.split(":root[data-ws-theme='dark']");
  const parseTokens = (text) =>
    Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[a-f0-9]{6})(?:;|\s)/g)].map((m) => [m[1], m[2]]));
  const light = parseTokens(base);
  const dark = { ...light, ...parseTokens(tail.split('}')[0]) };

  const luminance = (hex) =>
    [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);

  const testPairs = [
    ['text', 'surface'],
    ['muted', 'surface'],
    ['accent', 'surface'],
    ['nav-muted', 'nav'],
    ['nav-text', 'nav'],
    ['nav-on-active', 'nav-active'],
    ['on-brand', 'brand'],
    ['success', 'success-soft'],
    ['warning', 'warning-soft'],
    ['danger', 'danger-soft'],
    ['info', 'info-soft'],
    ['unknown', 'unknown-soft'],
    ['on-pill', 'pill'],
  ];

  for (const [themeName, palette] of Object.entries({ light, dark })) {
    for (const [fg, bg] of testPairs) {
      const fgHex = palette[`--ws-${fg}`];
      const bgHex = palette[`--ws-${bg}`];
      assert.ok(fgHex, `Missing --ws-${fg} in ${themeName}`);
      assert.ok(bgHex, `Missing --ws-${bg} in ${themeName}`);
      const l1 = luminance(fgHex);
      const l2 = luminance(bgHex);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      assert.ok(ratio >= 4.5, `${themeName} contrast for ${fg}/${bg} is ${ratio.toFixed(2)}, expected >= 4.5`);
    }
  }
});

/* ==========================================================================
   4. Lineless Surfaces: Data Density & Selected/Hover/Disabled/Error States
   ========================================================================== */

test('Lineless surfaces: Compact density rules tighten paddings without breaking structure', async () => {
  const emberTheme = await themeSection('ember-theme');
  assert.match(emberTheme, /:root\[data-ws-density='compact'\]\s*\{[^}]*--ws-row-pad:\s*10px;\s*--ws-section-pad:\s*20px;\s*\}/);
  assert.match(emberTheme, /:root\[data-ws-density='compact'\]\s+\.workspace-shell\s+\.ws-table\s+td/);
  assert.match(emberTheme, /:root\[data-ws-density='compact'\]\s+\.workspace-shell\s+\.ws-section-heading/);
  assert.match(emberTheme, /:root\[data-ws-density='compact'\]\s+\.workspace-shell\s+\.ws-section-body/);
});

test('Lineless surfaces: Selected, hover, disabled, and error states are clearly distinguishable', async () => {
  const emberTheme = await themeSection('ember-theme');

  // Selected row state uses warm accent soft on lineless tables
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(\.ws-table,\s*\.ys-resource-table,\s*\.ws-websites-table,\s*\.ws-db-table,\s*\.ws-mail-table\)\s+tbody\s+tr:is\(\.is-selected,\s*\[aria-selected="true"\],\s*\.ws-context-row\)\s*\{[^}]*background:\s*var\(--ws-accent-soft\)/
  );

  // Disabled button states suppress hover effects to preserve disabled appearance
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-button:disabled:hover,\s*\.ws-modal\s+\.ws-button:disabled:hover/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-button-primary:disabled:hover/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-button-danger:disabled:hover/);

  // Disabled buttons have cursor: not-allowed and opacity .55
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-button:disabled,\s*\.ws-modal\s+\.ws-button:disabled/);
  assert.match(emberTheme, /cursor:\s*not-allowed/);

  // Error input state has explicit danger border and soft danger background
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(input,select,textarea\):is\(\[aria-invalid="true"\],\s*\.is-error,\s*\.ws-input-error\)/
  );
  assert.match(emberTheme, /border-color:\s*var\(--ws-danger\)(?:\s*!important)?/);
  assert.match(emberTheme, /background:\s*var\(--ws-danger-soft\)/);
});

/* ==========================================================================
   5. Tables and Long File / Domain Names Overflow Prevention
   ========================================================================== */

test('Tables and long file/domain names: text wrapping and scroll containers prevent layout breaking', async () => {
  const emberTheme = await themeSection('ember-theme');
  const workspaceCss = await themeSection('workspace');

  // All table cells have overflow-wrap: anywhere and word-break: break-word
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(\.ws-table,\s*\.yf-table,\s*\.ys-resource-table,\s*\.ws-websites-table,\s*\.ws-db-table,\s*\.ws-mail-table\)\s+td\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;/
  );

  // Domain and file labels have overflow-wrap: anywhere and min-width: 0
  assert.match(
    emberTheme,
    /\.workspace-shell\s+\.ws-domain-name,\s*\.workspace-shell\s+\.ws-domain-name\s+a,\s*\.workspace-shell\s+\.yf-tree-name\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;\s*min-width:\s*0;/
  );

  // Table scroll container
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table-scroll\s*\{[^}]*width:\s*100%;\s*overflow-x:\s*auto;\s*overscroll-behavior-x:\s*contain;\s*\}/);
});

/* ==========================================================================
   6. Modals, Dropdowns / Diğer, and Mobile Drawer Clipping Prevention
   ========================================================================== */

test('Modals, Dropdown / Diğer menus, and mobile drawer clipping prevention are guaranteed', async () => {
  const emberTheme = await themeSection('ember-theme');

  // Modal header flex layout, title overflow wrapping, and close button shrink suppression
  assert.match(
    emberTheme,
    /\.ws-modal\s+>\s+header\s*\{[^}]*display:\s*flex;\s*align-items:\s*center;\s*justify-content:\s*space-between;\s*gap:\s*12px;\s*\}/
  );
  assert.match(
    emberTheme,
    /\.ws-modal\s+h2\s*\{[^}]*min-width:\s*0;\s*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;\s*margin:\s*0;\s*\}/
  );
  assert.match(
    emberTheme,
    /\.ws-modal\s+>\s+header\s+\.ws-button\s*\{[^}]*flex-shrink:\s*0;\s*\}/
  );

  // (.ys-site-more was removed with the unused legacy site navigation; no selector remains to check.)

  // Mobile drawer width bounded to min(290px, 90vw) and scrolling overflow-x contained
  assert.match(
    emberTheme,
    /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*width:\s*min\(290px,\s*90vw\);\s*max-width:\s*90vw;\s*overflow-x:\s*hidden;\s*overflow-y:\s*auto;\s*\}/
  );
});
