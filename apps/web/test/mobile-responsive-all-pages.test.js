import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const readSrc = (relPath) => readFile(new URL(`../src/${relPath}`, import.meta.url), 'utf8');

test('SCN-MOB-01: Mobile sessionbar, toolbar theme icon, and slide-over sidebar drawer rules exist in centralized design system', async () => {
  const { Icon } = await import('../src/workspace/PanelKit.jsx');
  const [themeCss, layoutSrc] = await Promise.all([
    readSrc('workspace/design-system/theme.css'),
    readSrc('workspace/WorkspaceLayout.jsx'),
  ]);

  // 1. Mobile sessionbar resets 260px desktop padding and prevents vertical overflow covering toolbar
  assert.match(themeCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?html\s+\.authenticated-panel\s+\.auth-sessionbar\s*\{[\s\S]*?padding:\s*4px\s+12px\s*!important/);
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?html\s+\.authenticated-panel\s+\.auth-sessionbar\s+>\s+span\s*\{\s*display:\s*none\s*!important/);

  // 2. Theme toggle button has sun/moon SVG icon so it never renders as an empty square when .ws-toolbar-label is hidden
  assert.match(layoutSrc, /icon=\{themeMode === 'light' \? 'moon' : 'sun'\}/);
  const sunSvg = renderToStaticMarkup(createElement(Icon, { name: 'sun' }));
  const moonSvg = renderToStaticMarkup(createElement(Icon, { name: 'moon' }));
  assert.match(sunSvg, /<svg[^>]*>[\s\S]*12 7a5 5/);
  assert.match(moonSvg, /<svg[^>]*>[\s\S]*21 12\.79A9/);

  // 3. Mobile slide-over sidebar drawer has fixed positioning and high z-index above sessionbar/toolbar
  assert.match(themeCss, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?html\s+\.workspace-shell\s+\.ws-sidebar\s*\{[\s\S]*?position:\s*fixed\s*!important[\s\S]*?z-index:\s*160\s*!important/);
});

test('SCN-MOB-02: WebsitesPage & WebsiteTaskCard use 2-column symmetrical quick tool grid and compact subdomain indent on mobile', async () => {
  const themeCss = await readSrc('workspace/design-system/theme.css');

  // Subdomain card left indent reduced from 24px to 10px on mobile
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-website-task-card\.yp-subdomain-task-card\s*\{[\s\S]*?margin-inline-start:\s*10px\s*!important/);

  // Quick tools form a 2-column symmetrical grid on mobile
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-website-task-quick-primary\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/);
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.ws-website-task-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/);
});

test('SCN-MOB-03: SiteNavigation renders as a single-row horizontally scrollable tab strip on mobile and code blocks never overflow', async () => {
  const themeCss = await readSrc('workspace/design-system/theme.css');

  // Single-row horizontal scroll on <= 768px
  assert.match(themeCss, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?html\s+\.workspace-shell\s+\.ws-plesk-site-navigation\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*!important[\s\S]*?overflow-x:\s*auto\s*!important/);
  assert.match(themeCss, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?\.ws-plesk-site-navigation\s+\.ws-site-tool-select\s*\{\s*display:\s*none\s*!important/);

  // Code block containment for /hosting Nginx preview
  assert.match(themeCss, /html\s+\.workspace-shell\s+pre\.ws-code-block[\s\S]*?max-width:\s*100%\s*!important[\s\S]*?white-space:\s*pre-wrap\s*!important/);
});

test('SCN-MOB-04: FilesPanel uses 2x2 action grid on mobile and separates .yf-size and .yf-perm-cell to prevent text overlap', async () => {
  const [themeCss, filesPanelSrc] = await Promise.all([
    readSrc('workspace/design-system/theme.css'),
    readSrc('workspace/FilesPanel.jsx'),
  ]);

  // Permissions cell has dedicated .yf-perm-cell class
  assert.match(filesPanelSrc, /className="yf-size yf-perm-cell"/);

  // 2x2 grid for Yeni Dosya / Yeni Klasör / Yükle / elFinder ile Aç on mobile
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?html\s+\.workspace-shell\s+\.yf-main-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*!important/);

  // Non-overlapping padding offsets for size vs permissions on mobile
  assert.match(themeCss, /td:nth-child\(3\)\.yf-size\s*\{[\s\S]*?padding-left:\s*39px\s*!important/);
  assert.match(themeCss, /td\.yf-perm-cell\s*\{[\s\S]*?padding-left:\s*104px\s*!important/);
});

test('SCN-MOB-05 & SCN-MOB-06: Databases, Firewall, Settings, 1-Click Marketplace, Notification Drawer, and Modals adapt to mobile', async () => {
  const [themeCss, dashboardSrc, firewallSrc] = await Promise.all([
    readSrc('workspace/design-system/theme.css'),
    readSrc('workspace/DashboardPage.jsx'),
    readSrc('workspace/FirewallPage.jsx'),
  ]);

  // Dashboard telemetry actions wrap cleanly
  assert.match(dashboardSrc, /flexWrap:\s*'wrap'/);

  // Firewall port filter actions wrap cleanly
  assert.match(firewallSrc, /className="ws-actions"\s+style=\{\{\s*display:\s*'flex',\s*flexWrap:\s*'wrap'/);

  // Long button labels wrap cleanly inside content/modals on mobile
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?html\s+\.workspace-shell\s+\.ws-content\s+\.ws-button,\s*html\s+\.ws-modal\s+\.ws-button\s*\{[\s\S]*?white-space:\s*normal\s*!important/);

  // 1-Click Marketplace category strip scrolls horizontally on mobile
  assert.match(themeCss, /@media\s*\(max-width:\s*768px\)\s*\{[\s\S]*?html\s+\.workspace-shell\s+\.yp-category-pills\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*!important[\s\S]*?overflow-x:\s*auto\s*!important/);

  // Notification drawer and modals fit 100vw on phones
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?\.yp-notification-drawer,\s*\.ws-notification-drawer\)\s*\{[\s\S]*?width:\s*100vw\s*!important/);
  assert.match(themeCss, /@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?html\s+\.ws-modal\s*\{[\s\S]*?width:\s*calc\(100vw\s*-\s*16px\)\s*!important/);
});

test('SCN-MOB-07: Login screen (.auth-page), AccountDialog (.auth-dialog), OwnerEnrollment, and /login route redirect use centralized Shadcn UI design system', async () => {
  const [themeCss, loginSrc, appSrc] = await Promise.all([
    readSrc('workspace/design-system/theme.css'),
    readSrc('LoginForm.jsx'),
    readSrc('workspace/WorkspaceApp.jsx'),
  ]);

  // 1. /login and /signin redirect cleanly to /websites when authenticated
  assert.match(appSrc, /\{\s*path:\s*'login',\s*element:\s*<RedirectWithSearch\s+to="\/websites"\s*\/>\s*\}/);

  // 2. LoginForm exposes theme toggle and zero AI-slop feature bragging pills
  assert.match(loginSrc, /className="auth-theme-toggle"/);
  assert.doesNotMatch(loginSrc, /auth-intro-features|Canlı Telemetri|1-Click Uygulama Marketi/);

  // 3. Centralized design system styles .auth-page, .auth-form, and .auth-dialog with --ws-* tokens
  assert.match(themeCss, /html\s+\.auth-page\s*\{[\s\S]*?background-color:\s*var\(--ws-bg\)\s*!important/);
  assert.match(themeCss, /html\s+\.auth-form\s*\{[\s\S]*?background:\s*var\(--ws-surface\)\s*!important/);
  assert.match(themeCss, /html\s+\.auth-dialog\s*\{[\s\S]*?background:\s*var\(--ws-surface\)\s*!important/);
});

test('SCN-MOB-08: Zero AI-slop, zero feature bragging pills, and zero parenthetical buzzword labels across UI', async () => {
  const [loginSrc, layoutSrc, websitesSrc, dockerPageSrc, dockerDialogSrc, filesSrc, firewallSrc] = await Promise.all([
    readSrc('LoginForm.jsx'),
    readSrc('workspace/WorkspaceLayout.jsx'),
    readSrc('workspace/WebsitesPage.jsx'),
    readSrc('workspace/DockerProjectsPage.jsx'),
    readSrc('workspace/DockerProjectCreateDialog.jsx'),
    readSrc('workspace/FilesPanel.jsx'),
    readSrc('workspace/FirewallPage.jsx'),
  ]);

  assert.doesNotMatch(loginSrc, /Canlı Telemetri|auth-intro-features/);
  assert.doesNotMatch(layoutSrc, /Uygulama Marketi \(1-Click\)|1-Click Market/);
  assert.doesNotMatch(websitesSrc, /Uygulama Marketi \(1-Click\)|alan adı grubu \(/);
  assert.doesNotMatch(dockerPageSrc, /Tek Tıkla Kur \(Easypanel\)|Otomatik Secret & Volume|Easypanel 1-Click/);
  assert.doesNotMatch(dockerDialogSrc, /Tek Tıkla Kur \(Easypanel\)|Otomatik Secret & Volume/);
  assert.doesNotMatch(filesSrc, /Plesk uyumlu|Root kilitli/);
  assert.doesNotMatch(firewallSrc, /Plesk yerleşiminde/);
});

test('SCN-MOB-09: Session expiry warning (.auth-expiry) and .auth-banner clear the fixed left sidebar on desktop and reset on mobile/collapsed', async () => {
  const themeCss = await readSrc('workspace/design-system/theme.css');

  // Desktop: .auth-expiry and .authenticated-panel .auth-banner offset by calc(var(--ws-sidebar-width, 236px) + 24px)
  assert.match(
    themeCss,
    /html\s+\.auth-expiry\s*\{[\s\S]*?margin:\s*12px\s+24px\s+12px\s+calc\(var\(--ws-sidebar-width,\s*236px\)\s*\+\s*24px\)\s*!important/,
  );
  assert.match(
    themeCss,
    /html\s+\.authenticated-panel\s+\.auth-banner\s*\{[\s\S]*?margin:\s*12px\s+24px\s+12px\s+calc\(var\(--ws-sidebar-width,\s*236px\)\s*\+\s*24px\)\s*!important/,
  );

  // Collapsed sidebar on desktop resets margin-left to 24px
  assert.match(
    themeCss,
    /html\s+\.authenticated-panel:has\(\.workspace-shell\.is-sidebar-collapsed\)\s+:is\(\.auth-expiry,\s*\.auth-banner\)\s*\{[\s\S]*?margin-left:\s*24px\s*!important/,
  );

  // Mobile/Tablet <= 900px resets margin so it spans cleanly across the viewport
  assert.match(
    themeCss,
    /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?html\s+\.authenticated-panel\s+:is\(\.auth-expiry,\s*\.auth-banner\)\s*\{[\s\S]*?margin:\s*10px\s+14px\s*!important/,
  );
});

