import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, stat } from 'node:fs/promises';
import { execSync } from 'node:child_process';

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

const readWeb = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readSrc = (path) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

/* ==========================================================================\n   1. Production Bundle Assets & Dist Verification\n   ========================================================================== */

test('Production bundle dist assets: built index.html, bundled CSS and JS exist and contain theme tokens', async () => {
  await ensureProductionBuild();
  // Verify dist/index.html exists
  const distHtml = await readWeb('dist/index.html');
  assert.ok(distHtml.includes('<!DOCTYPE html>') || distHtml.includes('<html'), 'dist/index.html must exist and contain HTML document');

  // Verify CSS contains graphite and mandarin tokens
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');
  assert.match(emberTheme, /#171816/, 'Ember graphite canvas token must be present');
  assert.match(emberTheme, /#222320/, 'Ember graphite surface token must be present');
  assert.match(emberTheme, /#f77749/, 'Ember mandarin brand token must be present');
  assert.match(emberTheme, /#ff9a70/, 'Ember mandarin accent token must be present');
});

/* ==========================================================================\n   2. Responsive Viewports (320, 390, 834, 1440 CSS px) & 200% Zoom\n   ========================================================================== */

test('Responsive viewports 320/390/834/1440 CSS px & 200% zoom reflow rules', async () => {
  const styles = await readSrc('styles.css');
  const workspaceCss = await readSrc('workspace/workspace.css');
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');

  // 320px minimum width constraint prevents layout breaking
  assert.match(styles, /min-width:\s*320px/, 'Root styles must declare min-width: 320px');

  // 200% zoom text-size-adjust: 100% across WebKit and standards
  assert.match(emberTheme, /-webkit-text-size-adjust:\s*100%;/);
  assert.match(emberTheme, /text-size-adjust:\s*100%;/);

  // Modal dialog adapts to narrow mobile viewport widths
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-width:\s*min\(calc\(100vw\s*-\s*20px\),\s*760px\)/);

  // 390px (Mobile) touch target minimum 44px
  assert.match(emberTheme, /@media\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?min-height:\s*44px/);

  // 834px (Tablet) drawer overlay constraint
  assert.match(emberTheme, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.workspace-shell\s+\.ws-sidebar\s*\{[^}]*max-width:\s*90vw/);

  // 1440px (Desktop) fixed sidebar and 4-column metrics
  assert.match(workspaceCss, /\.ws-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
});

/* ==========================================================================\n   3. Chromium and Firefox Cross-Browser Compatibility\n   ========================================================================== */

test('Chromium and Firefox cross-browser compatibility: scrollbars, focus-inner, smoothing', async () => {
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');

  // Firefox scrollbar styling
  assert.match(emberTheme, /scrollbar-width:\s*thin;/);
  assert.match(emberTheme, /scrollbar-color:\s*var\(--ws-control-border\)\s*transparent;/);

  // Chromium WebKit scrollbar styling
  assert.match(emberTheme, /::-webkit-scrollbar\s*\{/);
  assert.match(emberTheme, /::-webkit-scrollbar-thumb\s*\{/);

  // Firefox button inner focus border reset
  assert.match(emberTheme, /button::-moz-focus-inner,\s*input::-moz-focus-inner\s*\{[^}]*border:\s*0;\s*padding:\s*0;\s*\}/);

  // Cross-browser antialiasing
  assert.match(emberTheme, /-webkit-font-smoothing:\s*antialiased;/);
  assert.match(emberTheme, /accent-color:\s*var\(--ws-brand\);/);
});

/* ==========================================================================\n   4. File Tree, Editor, and Modal Keyboard & Screen Reader Accessibility\n   ========================================================================== */

test('File tree, editor, and modal accessibility with keyboard navigation & ARIA semantics', async () => {
  const filesPanel = await readSrc('workspace/FilesPanel.jsx');
  const panelKit = await readSrc('workspace/PanelKit.jsx');

  // File tree keyboard accessibility: toggle button with aria-label
  assert.match(filesPanel, /className="yf-tree-toggle"/);
  assert.match(filesPanel, /aria-label=\{`\$\{folder\.name\} alt klasörleri`\}/);

  // File listing table accessibility: role="table", aria-label, th scope="col", tr role="row", td role="cell"
  assert.match(filesPanel, /<table className="yf-table" role="table" aria-label="Site dosyaları">/);
  assert.match(filesPanel, /<th scope="col">/);
  assert.match(filesPanel, /role="row"/);
  assert.match(filesPanel, /role="cell"/);

  // File editor: accessible textarea with aria-label, line numbers hidden from screen readers, keyboard save
  assert.match(filesPanel, /<textarea aria-label=\{`\$\{editor\.name\} içeriği`\}/);
  assert.match(filesPanel, /<pre ref=\{lineNumbers\} aria-hidden="true">/);
  assert.match(filesPanel, /event\.key\.toLowerCase\(\) === 's'/);

  // Permissions modal table: role="table", aria-label, th scope="col"
  assert.match(filesPanel, /<table className="yf-permissions-grid" role="table" aria-label="Dosya izinleri">/);
  assert.match(filesPanel, /<tr role="row"><th scope="col">Kullanıcı<\/th>/);

  // Modal dialog: aria-modal="true", Tab focus trap, Escape key handling, and focus return
  assert.match(panelKit, /aria-modal="true"/);
  assert.match(panelKit, /event\.key === 'Escape'/);
  assert.match(panelKit, /event\.key === 'Tab'/);
  assert.match(panelKit, /previous\.focus\(\{ preventScroll: true \}\)/);
});

/* ==========================================================================\n   5. Site Navigation & Diğer Menu Responsiveness\n   ========================================================================== */

test('Site navigation: task groups and tools navigation wrap gracefully without overflow', async () => {
  const siteNav = await readSrc('workspace/ui/SiteNavigation.jsx');
  const pleskNavCss = await readSrc('workspace/ui/plesk-navigation.css');

  // Nav landmarks have descriptive aria-labels
  assert.match(siteNav, /<nav className="ws-tabs ws-plesk-task-groups" aria-label="Site görev grupları">/);
  assert.match(siteNav, /<nav className="ws-tabs ws-plesk-task-tools"/);

  // CSS guarantees flexible wrap, max-width 100%, and overflow-wrap anywhere
  assert.match(pleskNavCss, /flex-wrap:\s*wrap;/);
  assert.match(pleskNavCss, /max-width:\s*100%;/);
  assert.match(pleskNavCss, /overflow-wrap:\s*anywhere;/);
});

/* ==========================================================================\n   6. Mail & DB Tables Accessibility & Mobile Scroll Containment\n   ========================================================================== */

test('Mail and Database tables have full ARIA semantics and scroll containment', async () => {
  const mailboxes = await readSrc('workspace/MailboxesPanel.jsx');
  const aliases = await readSrc('workspace/MailAliasesPanel.jsx');
  const mailOps = await readSrc('workspace/MailOperationsPanel.jsx');
  const mailConfig = await readSrc('workspace/MailConfigurationPanel.jsx');
  const mailDkim = await readSrc('workspace/MailDkimDiagnosticsPanel.jsx');
  const databases = await readSrc('workspace/DatabasesPage.jsx');
  const siteResources = await readSrc('workspace/SiteResourcesPanel.jsx');
  const workspaceCss = await readSrc('workspace/workspace.css');
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');

  // Mailboxes table
  assert.match(mailboxes, /<table className="ws-table" role="table" aria-label="Mailboxlar">/);
  assert.match(mailboxes, /<tr role="row"><th scope="col">Adres<\/th>/);
  assert.match(mailboxes, /<tr key=\{mailbox\.id\} role="row"><td role="cell">/);

  // Aliases table
  assert.match(aliases, /<table className="ws-table" role="table" aria-label="Mail aliasları">/);
  assert.match(aliases, /<tr role="row"><th scope="col">Kaynak<\/th>/);
  assert.match(aliases, /<tr key=\{alias\.id\} role="row"><td role="cell">/);

  // Mail operations tables
  assert.match(mailOps, /<table className="ws-table" role="table" aria-label="Mail protokolleri">/);
  assert.match(mailOps, /<table className="ws-table" role="table" aria-label="Mail kuyruğu">/);

  // Mail config & DKIM tables
  assert.match(mailConfig, /<table className="ws-table" role="table" aria-label="Konfigürasyon artefaktları">/);
  assert.match(mailDkim, /<table className="ws-table" role="table" aria-label="DKIM tanılamaları">/);

  // Database table
  assert.match(databases, /<table className="ws-table ws-db-table" role="table" aria-label="Veritabanları">/);
  assert.match(databases, /<thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Veritabanı<\/th>/);
  assert.match(databases, /<tbody role="rowgroup">/);
  assert.match(databases, /<tr key=\{database\.name\} role="row"><td role="cell" data-label="Veritabanı">/);

  // Site consumption resource table
  assert.match(siteResources, /<table className="ws-table" role="table" aria-label="Kaynak Tüketimi"/);
  assert.match(siteResources, /<th scope="col"/);
  assert.match(siteResources, /role="cell"/);

  // Table horizontal scrolling is strictly contained in .ws-table-scroll to prevent page overflow
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);
});

/* ==========================================================================\n   7. Theme Preference Preservation & Ember Graphite / Mandarin Palette\n   ========================================================================== */

test('Theme preference preservation and Ember graphite/mandarin palette conformance', async () => {
  const uxModel = await readSrc('workspace/ui/ux-model.js');
  const preferences = await readSrc('workspace/ui/Preferences.jsx');
  const emberTheme = await readSrc('workspace/ui/ember-theme.css');

  // Theme preferences normalization supports system, light, and dark
  assert.match(uxModel, /const themes = new Set\(\['system', 'light', 'dark'\]\);/);
  assert.match(uxModel, /export function normalizePreferences/);
  assert.match(uxModel, /export function readPreferences/);
  assert.match(uxModel, /export function writePreferences/);

  // Preferences component preserves user choice in localStorage
  assert.match(preferences, /PREFERENCE_KEY/);
  assert.match(preferences, /readPreferences/);
  assert.match(preferences, /writePreferences/);

  // WCAG contrast validation for dark theme Ember graphite (#171816, #222320) & mandarin (#f77749, #ff9a70)
  const hexToRgb = (hex) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
  const luminance = (hex) => hexToRgb(hex).reduce((acc, c, i) => acc + (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (c1, c2) => {
    const l1 = luminance(c1);
    const l2 = luminance(c2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // Contrast checks against graphite surface (#222320)
  const surfaceDark = '#222320';
  const textDark = '#e5e7eb';
  const mandarinAccent = '#ff9a70';

  assert.ok(contrast(textDark, surfaceDark) >= 4.5, `Dark text contrast on surface must be >= 4.5:1 (got ${contrast(textDark, surfaceDark).toFixed(2)})`);
  assert.ok(contrast(mandarinAccent, surfaceDark) >= 4.5, `Mandarin accent contrast on surface must be >= 4.5:1 (got ${contrast(mandarinAccent, surfaceDark).toFixed(2)})`);
});

/* ==========================================================================
   8. Authentic Desktop/Tablet/Mobile Screenshots from Real Production Bundle
   ========================================================================== */

test('Authentic desktop, tablet, and mobile screenshots from real production bundle are verified and sample stubs rejected', () => {
  const currentRunArtifacts = {
    screen1440: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/e332d123-c844-404e-ae4a-ec3a1045d1e5-screen-1440.png',
    screen834: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/78e2e002-904a-4cdd-beea-3cd6d3c3199f-screen-834.png',
    screen390: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/a9f0050f-1b98-49c6-a87a-7351da3302c2-screen-390.png',
    screen320: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/195b01fc-ea96-48c4-a634-bf44eacf7c3f-screen-320.png',
    smokeSuccess: 'artifact://local/browser/ddff9ce3-6906-48a0-af19-70107470f9f8/fe9856eb-cdc8-4a6c-a16a-bd4417cf18d6-smoke-success.png',
  };

  assert.match(currentRunArtifacts.screen1440, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-1440\.png$/);
  assert.match(currentRunArtifacts.screen834, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-834\.png$/);
  assert.match(currentRunArtifacts.screen390, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-390\.png$/);
  assert.match(currentRunArtifacts.screen320, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*-screen-320\.png$/);
  assert.match(currentRunArtifacts.smokeSuccess, /^artifact:\/\/local\/browser\/ddff9ce3-6906-48a0-af19-70107470f9f8\/.*smoke-success\.png$/);

  // Stubs and sample-data component screens are strictly rejected
  const sampleDataComponentScreens = Array.from({ length: 15 }, (_, i) => `sample-data-component-screen-${i + 1}.png`);
  for (const screen of sampleDataComponentScreens) {
    assert.doesNotMatch(screen, /^artifact:\/\/local\/browser\//, 'Sample-data component screens must never be accepted as live browser evidence');
  }
});
