import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

register('./jsx-loader.js', import.meta.url);

const { navigationGroups, TOOLS_SETTINGS_GROUPS, groupSiteTabs } = await import('../src/workspace/ui/ux-model.js');
const { DesignSystemConfig, DEFAULT_DOCKER_STACK_TEMPLATES } = await import('../src/workspace/design-system/primitives.jsx');

const source = (path) => readFile(new URL(`../src/workspace/${path}`, import.meta.url), 'utf8');

test('Centralized Design System: swappable tokens and primitives are exported via PanelKit', async () => {
  assert.equal(DesignSystemConfig.id, 'shadcn-zinc-indigo');
  assert.equal(DesignSystemConfig.swappable, true);
  assert.ok(Array.isArray(DEFAULT_DOCKER_STACK_TEMPLATES));
  assert.ok(DEFAULT_DOCKER_STACK_TEMPLATES.length >= 6);

  const panelKit = await source('PanelKit.jsx');
  assert.match(panelKit, /from '\.\/design-system\/primitives\.jsx'/);
});

test('Equal-height desktop cards, spinner spacing, sidebar collapse, and symmetrical grids in theme.css', async () => {
  const themeCss = await source('design-system/theme.css');

  // 1. Zero gradients
  assert.match(themeCss, /background-image:\s*none\s*!important/);
  assert.doesNotMatch(themeCss, /radial-gradient|linear-gradient/);

  // 2. Equal-height desktop card grids
  assert.match(themeCss, /\.ws-equal-columns,\s*\.ws-two-columns,\s*\.ws-console-grid,\s*\.ws-console-bottom,\s*\.ws-metrics/);
  assert.match(themeCss, /align-items:\s*stretch\s*!important/);
  assert.match(themeCss, /height:\s*100%\s*!important/);

  // 3. Spinner & worker status spacing
  assert.match(themeCss, /\.ws-spinner[\s\S]*?margin-right:\s*8px\s*!important/);
  assert.match(themeCss, /\.ws-loading[\s\S]*?gap:\s*10px\s*!important/);
  assert.match(themeCss, /\.ws-section-body[\s\S]*?gap:\s*12px\s*!important/);

  // 4. Desktop sidebar collapse support
  assert.match(themeCss, /\.workspace-shell\.is-sidebar-collapsed/);
  assert.match(themeCss, /\.workspace-shell\.is-sidebar-collapsed\s+\.ws-sidebar\s*\{\s*display:\s*none\s*!important/);

  // 5. Symmetrical CSS Grid for expanded WebsiteTaskCard tools
  assert.match(themeCss, /\.ws-website-task-grid\s*\{\s*display:\s*grid\s*!important/);
  assert.match(themeCss, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(1(?:85|90)px,\s*1fr\)\)\s*!important/);

  // 6. Compact horizontal SiteNavigation & Plesk Categorized Quicklinks
  assert.match(themeCss, /\.ws-plesk-site-navigation\s*\{\s*display:\s*flex\s*!important/);
  assert.match(themeCss, /\.ws-console-quicklinks\s*\{\s*display:\s*grid\s*!important/);
  assert.match(themeCss, /\.yp-plesk-tool-groups/);
  assert.match(themeCss, /\.ws-db-access[\s\S]*?flex-direction:\s*row\s*!important/);
});

test('Navigation & headings use clean "Web Siteleri" label and zero AI-slop developer disclaimers', async () => {
  assert.equal(navigationGroups(true, true)[0].items[0][1], 'Web Siteleri');
  assert.equal(navigationGroups(true, false, false, true)[0].items[0][1], 'Web Siteleri');

  const allSettingsLabels = TOOLS_SETTINGS_GROUPS.flatMap((g) => g.items.map(([, label]) => label));
  for (const label of allSettingsLabels) {
    assert.ok(!label.includes('Ürün uzantısı'), `Unexpected AI-slop label: ${label}`);
  }

  const extraGroup = groupSiteTabs([{ id: 'custom-tool', label: 'Özel Araç' }]).find((g) => g.id === 'extensions');
  assert.equal(extraGroup.label, 'Ek Araçlar');

  const [aiDrawer, websitesPage, sslPanel, recoveryPanel, primitives, dockerPage, siteDetail, dbPage] = await Promise.all([
    source('AiDrawer.jsx'),
    source('WebsitesPage.jsx'),
    source('SslRenewalPanel.jsx'),
    source('ProvisioningRecoveryPanel.jsx'),
    source('design-system/primitives.jsx'),
    source('DockerProjectsPage.jsx'),
    source('SiteDetailPage.jsx'),
    source('DatabasesPage.jsx'),
  ]);

  assert.doesNotMatch(aiDrawer, /En yeni oluşturulanlar önce/);
  assert.doesNotMatch(aiDrawer, /Ürün uzantısı/i);
  assert.doesNotMatch(websitesPage, /canlı servis sağlık testi değildir/);
  assert.doesNotMatch(sslPanel, /yalnız kayıt okur; yenilemeyi tekrar göndermez/);
  assert.match(sslPanel, /className="ws-loading"\s+role="status"/);
  assert.doesNotMatch(recoveryPanel, /Bu sayı deneme sınırı değildir/);
  assert.match(recoveryPanel, /<details className="ws-disclosure" open=\{!operation\.ready\}>/);
  assert.doesNotMatch(primitives, /ortak kök/);
  assert.match(dockerPage, /getDockerCatalog\(debouncedQuery,\s*\{\s*live:\s*true/);
  assert.match(siteDetail, /yp-plesk-tool-groups/);
  assert.doesNotMatch(dbPage, /Aksiyon gerekli/);
});
