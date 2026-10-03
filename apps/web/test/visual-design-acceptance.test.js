import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { navigationGroups, commandEntries, TOOLS_SETTINGS_GROUPS } from '../src/workspace/ui/ux-model.js';
import { requireSession } from '../src/auth-protocol.js';

const source = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

/* ==========================================================================
   Criterion 1: Mevcut renk, font ve radius tokenları değiştirilmeden korunur.
   ========================================================================== */

test('Criterion 1: Ember visual design tokens (color, font, radius) remain preserved without modification', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const typography = await source('workspace/ui/ember-typography.css');

  // Exact light theme root color tokens
  const requiredLightTokens = [
    '--ws-brand: #f77749',
    '--ws-brand-hover: #ff9169',
    '--ws-on-brand: #21130d',
    '--ws-canvas: #f2f0eb',
    '--ws-surface: #fffefa',
    '--ws-surface-raised: #ffffff',
    '--ws-surface-subtle: #e9e6df',
    '--ws-surface-hover: #e5e1d9',
    '--ws-text: #272721',
    '--ws-muted: #635f56',
    '--ws-border: #ddd8ce',
    '--ws-control-border: #858074',
    '--ws-accent: #9c3e1e',
    '--ws-accent-soft: #f9e2d5',
    '--ws-accent-hover: #76311b',
    '--ws-focus: #9b421e',
    '--ws-on-accent: #ffffff',
    '--ws-success: #2f644b',
    '--ws-success-soft: #dfede3',
    '--ws-warning: #75521c',
    '--ws-warning-soft: #f8ebce',
    '--ws-danger: #a42e42',
    '--ws-danger-soft: #f9e0e6',
    '--ws-info: #465d6b',
    '--ws-info-soft: #e0e9ee',
    '--ws-unknown: #62615a',
    '--ws-unknown-soft: #e9e6df',
    '--ws-nav: #e9e6df',
    '--ws-nav-text: #47463e',
    '--ws-nav-muted: #625f56',
    '--ws-nav-hover: #dedad0',
    '--ws-nav-active: #292a25',
    '--ws-nav-on-active: #fffaf0',
    '--ws-pill: #30312b',
    '--ws-on-pill: #fffaf2',
    '--ws-chart-cpu: #a44020',
    '--ws-chart-memory: #357052',
    '--ws-chart-disk: #76651d',
    '--ws-folder: #896229',
    '--ws-file: #576d66',
  ];

  for (const token of requiredLightTokens) {
    assert.ok(emberTheme.includes(token), `Missing light theme token: ${token}`);
  }

  // Exact dark theme root color tokens
  const requiredDarkTokens = [
    "--ws-canvas: #171816",
    "--ws-surface: #222320",
    "--ws-surface-raised: #2b2c28",
    "--ws-surface-subtle: #1c1d1a",
    "--ws-surface-hover: #30312c",
    "--ws-text: #f3f0e8",
    "--ws-muted: #b6b3a9",
    "--ws-border: #373831",
    "--ws-control-border: #76786c",
    "--ws-accent: #ff9a70",
    "--ws-accent-soft: #453026",
    "--ws-accent-hover: #ffc09a",
    "--ws-on-accent: #24170f",
    "--ws-focus: #ffb88a",
    "--ws-success: #a9d4b5",
    "--ws-success-soft: #293d30",
    "--ws-warning: #e5c278",
    "--ws-warning-soft: #423724",
    "--ws-danger: #f4a8b5",
    "--ws-danger-soft: #472c32",
    "--ws-info: #b6cbd1",
    "--ws-info-soft: #29393d",
    "--ws-unknown: #c0bdb3",
    "--ws-unknown-soft: #34352f",
    "--ws-nav: #171816",
    "--ws-nav-text: #c5c1b6",
    "--ws-nav-muted: #a4a296",
    "--ws-nav-hover: #272823",
    "--ws-nav-active: #f0ede4",
    "--ws-nav-on-active: #25251f",
    "--ws-pill: #eeece2",
    "--ws-on-pill: #272821",
    "--ws-chart-cpu: #ff9a70",
    "--ws-chart-memory: #acd2b1",
    "--ws-chart-disk: #e7ce87",
    "--ws-folder: #d7bd80",
    "--ws-file: #afc8b8",
  ];

  for (const token of requiredDarkTokens) {
    assert.ok(emberTheme.includes(token), `Missing dark theme token: ${token}`);
  }

  // Exact radius tokens in :root
  assert.match(emberTheme, /--ws-radius:\s*22px/);
  assert.match(emberTheme, /--ws-radius-control:\s*13px/);
  assert.match(emberTheme, /--ws-radius-small:\s*9px/);

  // Exact font tokens in typography
  assert.match(typography, /--ws-font-body:\s*'Yun Manrope',\s*'Manrope'/);
  assert.match(typography, /--ws-font-display:\s*'Yun Outfit',\s*'Outfit'/);
  assert.match(typography, /--ws-font-code:\s*ui-monospace/);
  assert.match(typography, /font-family:\s*'Yun Manrope'/);
  assert.match(typography, /font-family:\s*'Yun Outfit'/);
  assert.equal([...typography.matchAll(/font-display:\s*swap/g)].length, 2);
  assert.doesNotMatch(typography, /url\(['"]?https?:/);
});

test('Criterion 1: Color tokens maintain required contrast >= 4.5:1 across both themes', async () => {
  const css = await source('workspace/ui/ember-theme.css');
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
   Criterion 2: React/Vite build işlemi hatasız tamamlanır.
   ========================================================================== */

test('Criterion 2: Entry point stylesheet import order and runtime dependencies are verified', async () => {
  const main = await source('main.jsx');
  const cssImports = [...main.matchAll(/import\s+['"]([^'"]+\.css)['\"]/g)].map((m) => m[1]);
  assert.deepEqual(cssImports, [
    './styles.css',
    './server-cards.css',
    './domain-list.css',
    './workspace/ui/console-theme.css',
    './workspace/ui/ember-theme.css',
  ]);

  const pkg = JSON.parse(await source('../package.json'));
  assert.equal(pkg.scripts.build, 'vite build');
  assert.equal(pkg.scripts.prebuild, 'npm run fonts');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    '@xterm/addon-fit',
    '@xterm/xterm',
    'react',
    'react-dom',
    'react-router',
  ]);
});

/* ==========================================================================
   Criterion 3: Owner ve iki farklı site kullanıcısı üzerinden ana görev
   ekranları doğru rol sınırları ve bağlamla doğrulanır.
   ========================================================================== */

test('Criterion 3: Owner role has full server management context and all task screens', async () => {
  // Owner navigation items
  const ownerNav = navigationGroups(true, true, false, false);
  assert.equal(ownerNav.length, 1);
  assert.equal(ownerNav[0].label, 'Panel');
  const paths = ownerNav[0].items.map(([path]) => path);
  assert.deepEqual(paths, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
    '/tools-settings',
    '/settings/users',
  ]);

  // Owner branding and footer
  const layout = await source('workspace/WorkspaceLayout.jsx');
  assert.match(layout, /isOwner \? 'SUNUCU YÖNETİMİ'/);
  assert.match(layout, /isOwner \? \(canManage \? 'Sunucu yönetimi' : 'Salt okunur görünüm'\)/);
  assert.match(layout, /isOwner \? \(canManage \? 'Yerel sunucu çalışma alanı'/);

  // Owner actions in toolbar
  assert.match(layout, /isOwner && <LinkButton to="\/websites\/new" variant="primary"/);
  assert.match(layout, /isOwner && <Button icon="terminal" aria-label="AI asistanı aç \(Ürün uzantısı\)"/);

  // Owner can access all tools in command palette
  const ownerCommands = commandEntries({ canManage: true, isOwner: true }).map((c) => c.to);
  assert.ok(ownerCommands.includes('/websites'));
  assert.ok(ownerCommands.includes('/tools-settings'));
  assert.ok(ownerCommands.includes('/settings/users'));

  // Websites page heading for Owner
  const websitesPage = await source('workspace/WebsitesPage.jsx');
  assert.match(websitesPage, /isReseller \? 'Sitelerim' : 'Web Siteleri ve Alan Adları'/);
  assert.match(websitesPage, /isOwner && canManage && <LinkButton to="\/websites\/new" icon="plus" variant="primary">Web sitesi ekle<\/LinkButton>/);
  assert.match(websitesPage, /isOwner && canManage && <WebsiteRemovalRecoveryPanel \/>/);
});

test('Criterion 3: Site User Role 1 (Reseller) has isolated Bayi Menüsü and customer site tools', async () => {
  // Reseller navigation items
  const resellerNav = navigationGroups(true, false, true, false);
  assert.equal(resellerNav.length, 1);
  assert.equal(resellerNav[0].label, 'Bayi Menüsü');
  const paths = resellerNav[0].items.map(([path]) => path);
  assert.deepEqual(paths, [
    '/customers',
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);
  assert.equal(resellerNav[0].items.find(([p]) => p === '/websites')[1], 'Sitelerim');
  assert.equal(resellerNav[0].items.find(([p]) => p === '/customers')[1], 'Müşterilerim');

  // Reseller forbidden paths
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/dashboard'));

  // Reseller branding
  const layout = await source('workspace/WorkspaceLayout.jsx');
  assert.match(layout, /isReseller \? 'BAYİ PANELİ'/);
  assert.match(layout, /isReseller \? 'Bayi yönetimi'/);
  assert.match(layout, /isReseller \? 'Müşterileriniz ve izinli site araçları'/);

  // Websites page heading for Reseller
  const websitesPage = await source('workspace/WebsitesPage.jsx');
  assert.match(websitesPage, /isReseller && <LinkButton to="\/customers" icon="user" variant="primary">Müşterilerim<\/LinkButton>/);
});

test('Criterion 3: Site User Role 2 (Customer) has isolated Müşteri Menüsü, quotas and resource lock boundaries', async () => {
  // Customer navigation items
  const customerNav = navigationGroups(true, false, false, true);
  assert.equal(customerNav.length, 1);
  assert.equal(customerNav[0].label, 'Müşteri Menüsü');
  const paths = customerNav[0].items.map(([path]) => path);
  assert.deepEqual(paths, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);
  assert.equal(customerNav[0].items.find(([p]) => p === '/websites')[1], 'Web Siteleri ve Alan Adları');

  // Customer forbidden paths
  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
  assert.ok(!paths.includes('/docker'));
  assert.ok(!paths.includes('/dashboard'));

  // Customer branding
  const layout = await source('workspace/WorkspaceLayout.jsx');
  assert.match(layout, /isCustomer \? 'MÜŞTERİ PANELİ'/);
  assert.match(layout, /isCustomer \? 'Müşteri paneli'/);
  assert.match(layout, /isCustomer \? 'Web siteleriniz ve barındırma araçları'/);

  // Customer quota and resource cards
  const websitesPage = await source('workspace/WebsitesPage.jsx');
  assert.match(websitesPage, /Barındırma Kaynakları ve Kotalar/);
  assert.match(websitesPage, /Kaynaklar Kilitli/);
  assert.match(websitesPage, /Kota Sınırı/);
  assert.match(websitesPage, /ws-quota-cards/);
  assert.match(websitesPage, /var\(--ws-surface-subtle\)/);
  assert.match(websitesPage, /var\(--ws-border\)/);
});

test('Criterion 3: Site User Role 3 (Site Manager) has scoped Panel navigation without administrative tools', () => {
  const siteManagerNav = navigationGroups(true, false, false, false);
  assert.equal(siteManagerNav.length, 1);
  assert.equal(siteManagerNav[0].label, 'Panel');
  const paths = siteManagerNav[0].items.map(([path]) => path);
  assert.deepEqual(paths, [
    '/websites',
    '/mail',
    '/files',
    '/databases',
    '/statistics',
  ]);
  assert.ok(!paths.includes('/customers'));
  assert.ok(!paths.includes('/tools-settings'));
  assert.ok(!paths.includes('/settings/users'));
});

/* ==========================================================================
   Criterion 4: 320px, 390px, 834px, 1440px görünüm genişliklerinde ve %200
   yakınlaştırmada görsel taşma olmaksızın düzenli yerleşim sağlanır.
   ========================================================================== */

test('Criterion 4: 1440px (Desktop) maintains multi-column layout, fixed sidebar, and full tables', async () => {
  const workspaceCss = await source('workspace/workspace.css');
  const emberTheme = await source('workspace/ui/ember-theme.css');

  // Sidebar positioning at desktop
  assert.match(workspaceCss, /\.ws-sidebar\s*\{[^}]*width:\s*(?:232px|var\(--ws-sidebar-width\))/);
  assert.match(workspaceCss, /\.ws-main\s*\{[^}]*margin-left:\s*(?:232px|var\(--ws-sidebar-width\))/);

  // Multi-column metrics and grids
  assert.match(workspaceCss, /\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(workspaceCss, /\.ws-two-columns\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.8fr\)\s*minmax\(280px,\s*1fr\)/);

  // Desktop table headers visible and expanded
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table\s*\{[^}]*border-collapse:\s*separate/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table\s+th\s*\{[^}]*background:\s*transparent/);
});

test('Criterion 4: 834px (Tablet / <= 900px) collapses sidebar to drawer and reflows grids', async () => {
  const workspaceCss = await source('workspace/workspace.css');
  const consoleTheme = await source('workspace/ui/console-theme.css');
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const layout = await source('workspace/WorkspaceLayout.jsx');

  // React listener for 900px breakpoint
  assert.match(layout, /window\.matchMedia\('\(max-width:\s*900px\)'\)/);

  // CSS transforms sidebar off-screen and resets main margin
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-sidebar\s*\{[^}]*transform:\s*translateX\(-100%\)/);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-main\s*\{[^}]*margin-left:\s*0/);
  assert.match(workspaceCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-mobile-menu,\s*\.ws-nav-close\s*\{[^}]*display:\s*inline-flex/);

  // Overlay shadow and surface styling for open drawer in Ember theme
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*background:\s*var\(--ws-surface\)/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-nav-backdrop\s*\{[^}]*background:/);

  // Metrics grid collapses to 2 columns
  assert.match(consoleTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('Criterion 4: 390px (Mobile / <= 640px) transforms tables to cards and optimizes headers and buttons', async () => {
  const workspaceCss = await source('workspace/workspace.css');
  const consoleTheme = await source('workspace/ui/console-theme.css');
  const consoleLists = await source('workspace/ui/console-lists.css');
  const emberTheme = await source('workspace/ui/ember-theme.css');

  // Page heading stacks vertically
  assert.match(workspaceCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-page-heading\s*\{[^}]*flex-direction:\s*column/);

  // Table header clipped out and rows displayed as cards
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-db-table\s+thead\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.match(consoleLists, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.ws-websites-table\s+thead\s*\{[^}]*clip-path:\s*inset\(50%\)/);
  assert.match(consoleLists, /@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.ws-websites-table\s+td\[data-label\]::before/);

  // Ember card styling on mobile
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-db-table\s+tr,\s*\.workspace-shell\s+\.ws-websites-table\s+tbody\s+tr\s*\{[^}]*background:\s*var\(--ws-surface-subtle\)/);

  // Minimum touch target 44px
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?--ws-control-height:\s*44px/);
  assert.match(emberTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?min-height:\s*44px/);

  // Modal fits within viewport
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-modal\s*\{[^}]*width:\s*calc\(100vw\s*-\s*20px\)/);
});

test('Criterion 4: 320px (Narrow Mobile / <= 380px) guarantees overflow prevention and single-column filters', async () => {
  const styles = await source('styles.css');
  const consoleLists = await source('workspace/ui/console-lists.css');
  const consoleTheme = await source('workspace/ui/console-theme.css');

  // Body has min-width 320px
  assert.match(styles, /body\s*\{[^}]*min-width:\s*320px/);

  // Filters collapse to 1 column at <= 380px
  assert.match(consoleLists, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.ws-filter-options\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);

  // Domain symbol hidden on narrow screens to preserve domain name width
  assert.match(consoleLists, /@media\s*\(max-width:\s*380px\)\s*\{[\s\S]*?\.ws-site-list\s+\.ws-domain-symbol\s*\{[^}]*display:\s*none/);

  // Toolbar actions hide count and extension badge at <= 360px
  assert.match(consoleTheme, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.ws-toolbar-actions\s+\.ws-button\[title="İşlemler"\]\s+\.ws-nav-count\s*\{[^}]*display:\s*none/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.ws-toolbar-actions\s+\.ws-badge\s*\{[^}]*display:\s*none/);
});

test('Criterion 4: 200% zoom scaling behaves consistently with responsive breakpoints', async () => {
  const workspaceCss = await source('workspace/workspace.css');
  const consoleTheme = await source('workspace/ui/console-theme.css');
  const emberTheme = await source('workspace/ui/ember-theme.css');

  // Text uses clamp and responsive sizing
  assert.match(emberTheme, /font-size:\s*clamp\(27px,\s*2\.1vw,\s*34px\)/);

  // Overflow wrap is set across headings, tables, and notices
  assert.match(workspaceCss, /\.ws-page-heading\s+h1\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(workspaceCss, /\.ws-notice\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(workspaceCss, /\.ws-keyvalues\s+dd\s*\{[^}]*overflow-wrap:\s*anywhere/);

  // Modal dialog has calc-based max height and auto scrolling
  assert.match(workspaceCss, /\.ws-modal\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*40px\)/);
  assert.match(consoleTheme, /\.ws-modal\s*\{[^}]*max-height:\s*calc\(100dvh\s*-\s*24px\)/);
});

/* ==========================================================================
   Criterion 5: Klavye gezintisi, uzun listeler ve hata durumları görsel
   bütünlüğü bozmadan doğrulanır.
   ========================================================================== */

test('Criterion 5: Keyboard navigation has visible focus, skip link, and mobile focus trap', async () => {
  const layout = await source('workspace/WorkspaceLayout.jsx');
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const workspaceCss = await source('workspace/workspace.css');

  // Skip-to-content link
  assert.match(layout, /<a href="#workspace-main" className="ws-skip">İçeriğe geç<\/a>/);
  assert.match(workspaceCss, /\.ws-skip\s*\{[^}]*position:\s*fixed/);
  assert.match(workspaceCss, /\.ws-skip:focus\s*\{[^}]*top:\s*8px/);

  // Focus visible styling with Ember focus token
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(button,a,input,select,textarea,summary\):focus-visible,\s*\.ws-modal\s+:is\(button,a,input,select,textarea,summary\):focus-visible\s*\{[^}]*outline:\s*2px\s*solid\s*var\(--ws-focus\)/
  );

  // Mobile menu focus trap and inert handling
  assert.match(layout, /inert=\{narrow && !menuOpen\}/);
  assert.match(layout, /inert=\{narrow && menuOpen\}/);
  assert.match(layout, /event\.key === 'Escape'/);
  assert.match(layout, /event\.shiftKey && \(document\.activeElement === first/);

  // Command palette keyboard shortcut (Ctrl/Cmd + K)
  assert.match(layout, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === 'k'/);
});

test('Criterion 5: Long lists support pagination, scrolling containers, and text wrapping', async () => {
  const websitesPage = await source('workspace/WebsitesPage.jsx');
  const resellerPage = await source('workspace/ResellerCustomersPage.jsx');
  const workspaceCss = await source('workspace/workspace.css');
  const consoleLists = await source('workspace/ui/console-lists.css');

  // Pagination controls with prev/next buttons
  assert.match(websitesPage, /<footer className="ws-pagination">/);
  assert.match(websitesPage, /Button disabled=\{result\.page <= 1\}/);
  assert.match(websitesPage, /Button disabled=\{result\.page >= result\.pageCount\}/);

  assert.match(resellerPage, /<footer className="ws-pagination">/);
  assert.match(resellerPage, /Button disabled=\{locked \|\| !page \|\| offset === 0\}/);

  // Long table scroll container
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(resellerPage, /className="ws-table-scroll"/);

  // Domain tree toggling
  assert.match(websitesPage, /domainTreeRows/);
  assert.match(consoleLists, /\.ws-site-list\s+\.ws-tree-toggle/);
});

test('Criterion 5: Error states, notices, and empty states maintain design integrity without Plesk conflation', async () => {
  const websitesPage = await source('workspace/WebsitesPage.jsx');
  const resellerPage = await source('workspace/ResellerCustomersPage.jsx');
  const consoleTheme = await source('workspace/ui/console-theme.css');
  const emberTheme = await source('workspace/ui/ember-theme.css');

  // Semantic notices
  assert.match(consoleTheme, /\.ws-notice-error,\s*\.ws-notice-danger\s*\{[^}]*color:\s*var\(--ws-danger\)/);
  assert.match(consoleTheme, /\.ws-notice-warn,\s*\.ws-notice-warning\s*\{[^}]*color:\s*var\(--ws-warning\)/);

  // Ember notice visual language
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-notice,\s*\.ws-modal\s+\.ws-notice\s*\{[^}]*border-left:\s*3px\s*solid\s*currentColor/);

  // Empty states present for zero items
  assert.match(websitesPage, /<EmptyState title="Henüz web sitesi yok"/);
  assert.match(websitesPage, /<EmptyState title="Eşleşen alan adı bulunamadı"/);
  assert.match(resellerPage, /<EmptyState title="Henüz müşteri yok"/);

  // No mock or conflated Plesk visuals in CSS
  assert.doesNotMatch(emberTheme, /plesk\.com|plesk-mock|sample-screenshot/i);
});
