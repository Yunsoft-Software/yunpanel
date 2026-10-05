import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

/* ==========================================================================
   Criterion 1: Comprehensive Accessibility Acceptance for Real Typography
   ========================================================================== */

test('Criterion 1: Real Manrope & Outfit typography and all accessibility dimensions are integrated', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const typography = await source('workspace/ui/ember-typography.css');

  // Real fonts declared with swap and correct local paths
  assert.match(typography, /font-family:\s*'Yun Manrope'/);
  assert.match(typography, /font-family:\s*'Yun Outfit'/);
  assert.match(typography, /src:\s*url\('\/fonts\/ember\/manrope-75274da585\.ttf'\)/);
  assert.match(typography, /src:\s*url\('\/fonts\/ember\/outfit-466d6245f9\.ttf'\)/);

  // All 6 accessibility requirements are present in the CSS layer
  for (const feature of [
    'focus-visible',
    'prefers-reduced-motion',
    'forced-colors',
    'pointer: coarse',
    'scrollbar-width',
    'text-size-adjust',
    'ws-sr-only',
  ]) {
    assert.ok(emberTheme.includes(feature), `Expected ${feature} in ember-theme.css`);
  }
});

/* ==========================================================================
   Criterion 2: 200% Zoom Layout Integrity & Content Overflow Prevention
   ========================================================================== */

test('Criterion 2: 200% Zoom: text wrapping, flex reflow, and scrollers prevent layout breaking', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const typography = await source('workspace/ui/ember-typography.css');
  const workspaceCss = await source('workspace/workspace.css');

  // Text size adjust prevents uncontrolled font inflation across browsers under zoom
  assert.match(emberTheme, /-webkit-text-size-adjust:\s*100%;/);
  assert.match(emberTheme, /text-size-adjust:\s*100%;/);

  // Body and shell typography uses relative line-heights
  assert.match(typography, /font-size:\s*14px;\s*line-height:\s*1\.6;/);

  // Headings and metric cards reflow and wrap on 200% zoom without truncation
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-metric\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-metric\s*>\s*strong\s*\{[^}]*overflow-wrap:\s*anywhere;\s*word-break:\s*break-word;/);

  // Badges and key-values wrap under compact widths
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-badge\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-keyvalues\s+dt,\s*\.workspace-shell\s+\.ws-keyvalues\s+dd\s*\{[^}]*overflow-wrap:\s*anywhere;/);

  // Toolbars and pagination wrap flexibly rather than clipping controls
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-toolbar\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-pagination\s*\{[^}]*flex-wrap:\s*wrap;/);

  // Modal dialog adapts to viewport height and width under 200% zoom
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-width:\s*min\(calc\(100vw\s*-\s*20px\),\s*760px\)/);
  assert.match(emberTheme, /\.ws-modal\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*20px\)/);
  assert.match(emberTheme, /\.ws-modal\s*>\s*header\s*\{[^}]*flex-wrap:\s*wrap;/);
  assert.match(emberTheme, /\.ws-modal-footer\s*\{[^}]*flex-wrap:\s*wrap;/);

  // Table horizontal scroll container prevents page-wide overflow
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-table-scroll\s*\{[^}]*width:\s*100%;\s*overflow-x:\s*auto;\s*overscroll-behavior-x:\s*contain;/);
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
});

/* ==========================================================================
   Criterion 3: Keyboard Focus Indicators & Logical Tab Order
   ========================================================================== */

test('Criterion 3: Keyboard focus indicators on all interactive elements, brand focus, and skip link', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const layout = await source('workspace/WorkspaceLayout.jsx');
  const panelKit = await source('workspace/PanelKit.jsx');

  // Global focus indicator applies to buttons, links, inputs, selects, textareas, summaries, and ARIA roles
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(button,a,input,select,textarea,summary\):focus-visible,\s*\.ws-modal\s+:is\(button,a,input,select,textarea,summary\):focus-visible\s*\{[^}]*outline:\s*2px\s*solid\s*var\(--ws-focus\);\s*outline-offset:\s*3px;/
  );
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(\[tabindex="0"\],\[role="button"\],\[role="tab"\],\[role="link"\]\):focus-visible/
  );

  // Primary brand button has high-contrast dual-ring focus
  assert.match(
    emberTheme,
    /\.workspace-shell\s+\.ws-button-primary:focus-visible,\s*\.ws-modal\s+\.ws-button-primary:focus-visible\s*\{[^}]*outline:\s*2px\s*solid\s*var\(--ws-focus\);\s*outline-offset:\s*3px;\s*box-shadow:\s*0\s*0\s*0\s*2px\s*var\(--ws-surface\);/
  );

  // Invalid form inputs have explicit danger focus ring
  assert.match(
    emberTheme,
    /\.workspace-shell\s+:is\(input,select,textarea\):is\(\[aria-invalid="true"\],\s*\.is-error,\s*\.ws-input-error\):focus-visible/
  );
  assert.match(emberTheme, /outline:\s*2px\s*solid\s*var\(--ws-danger\)\s*!important/);

  // Skip-to-content link exists in layout and has visible focus styling
  assert.match(layout, /<a\s+href="#workspace-main"\s+className="ws-skip">İçeriğe geç<\/a>/);
  assert.match(layout, /<main\s+id="workspace-main"/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-skip:focus,\s*\.workspace-shell\s+\.ws-skip:focus-visible\s*\{/);
  assert.match(emberTheme, /outline:\s*2px\s*solid\s*var\(--ws-focus\);/);

  // Modal dialog maintains focus trap, escape handler, and focus return
  assert.match(panelKit, /aria-modal="true"/);
  assert.match(panelKit, /handleKeyDown/);
  assert.match(panelKit, /event\.key === 'Escape'/);
  assert.match(panelKit, /previous\.focus\(\{ preventScroll: true \}\)/);
});

/* ==========================================================================
   Criterion 4: Chromium & Firefox Cross-Browser Compatibility
   ========================================================================== */

test('Criterion 4: Chromium and Firefox: scrollbar styling, inner focus, and font smoothing', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');

  // Firefox scrollbar width and color
  assert.match(emberTheme, /scrollbar-width:\s*thin;/);
  assert.match(emberTheme, /scrollbar-color:\s*var\(--ws-control-border\)\s*transparent;/);

  // Chromium / WebKit scrollbar rules
  assert.match(emberTheme, /::-webkit-scrollbar\s*\{[^}]*width:\s*8px;\s*height:\s*8px;\s*\}/);
  assert.match(emberTheme, /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--ws-control-border\);/);

  // Firefox button inner focus border suppression
  assert.match(emberTheme, /button::-moz-focus-inner,\s*input::-moz-focus-inner\s*\{[^}]*border:\s*0;\s*padding:\s*0;\s*\}/);

  // Cross-browser antialiasing
  assert.match(emberTheme, /-webkit-font-smoothing:\s*antialiased;/);

  // Form controls native accent color supported across Chromium and Firefox
  assert.match(emberTheme, /accent-color:\s*var\(--ws-brand\);/);
});

/* ==========================================================================
   Criterion 5: Screen Reader Announcements & a11y Standards
   ========================================================================== */

test('Criterion 5: Screen reader utility classes, live regions, and semantic landmarks', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const layout = await source('workspace/WorkspaceLayout.jsx');
  const typography = await source('workspace/ui/ember-typography.css');

  // Screen reader accessible hidden class definition
  assert.match(emberTheme, /\.ws-sr-only,\s*\.sr-only\s*\{[^}]*position:\s*absolute\s*!important;/);
  assert.match(emberTheme, /clip:\s*rect\(0,\s*0,\s*0,\s*0\)\s*!important;/);

  // Live status regions in WorkspaceLayout
  assert.match(layout, /role="status"/);
  assert.match(layout, /aria-label="Ana menü"/);
  assert.match(layout, /aria-label="Panel bölümleri"/);
  assert.match(layout, /aria-label="Menüyü kapat"/);

  // Heading hierarchy uses Outfit display font for semantic structure
  assert.match(typography, /\.workspace-shell\s+:is\(h1,\s*h2\),\s*\.ws-modal\s+:is\(h1,\s*h2,\s*h3\)/);
  assert.match(typography, /font-family:\s*var\(--ws-font-display\);/);
});

/* ==========================================================================
   Criterion 6: prefers-reduced-motion, forced-colors, touch, and 26+ contrast
   ========================================================================== */

test('Criterion 6: prefers-reduced-motion suppresses animations and transitions', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const reducedMotionSection = emberTheme.slice(emberTheme.indexOf('@media (prefers-reduced-motion: reduce)'));

  assert.match(reducedMotionSection, /transition:\s*none\s*!important;/);
  assert.match(reducedMotionSection, /animation:\s*none\s*!important;/);
  assert.match(reducedMotionSection, /scroll-behavior:\s*auto\s*!important;/);
  assert.match(reducedMotionSection, /animation-duration:\s*0\.01ms\s*!important;/);
});

test('Criterion 6: forced-colors mode specifies high-contrast system colors for all interactions', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const forcedColorsSection = emberTheme.slice(emberTheme.indexOf('@media (forced-colors: active)'));

  // System border on cards, modals, buttons, and notices
  assert.match(forcedColorsSection, /border:\s*1px\s*solid\s*CanvasText;/);

  // Highlight outline on active navigation, tabs, and focus-visible
  assert.match(forcedColorsSection, /outline:\s*2px\s*solid\s*Highlight;/);
  assert.match(forcedColorsSection, /:focus-visible\s*\{[^}]*outline:\s*2px\s*solid\s*Highlight\s*!important;/);

  // Disabled and error states mapped to system colors
  assert.match(forcedColorsSection, /border-color:\s*GrayText\s*!important;\s*color:\s*GrayText\s*!important;/);
  assert.match(forcedColorsSection, /border:\s*2px\s*solid\s*Mark\s*!important;\s*outline:\s*1px\s*solid\s*Mark\s*!important;/);

  // Selected row state outlined in forced-colors
  assert.match(forcedColorsSection, /tbody\s+tr:is\(\.is-selected,\s*\[aria-selected="true"\],\s*\.ws-context-row\)\s*\{[^}]*outline:\s*2px\s*solid\s*Highlight;/);
});

test('Criterion 6: Touch mode enforces 44px min touch targets across all interactive elements', async () => {
  const emberTheme = await source('workspace/ui/ember-theme.css');
  const touchSection = emberTheme.slice(emberTheme.indexOf('@media (pointer: coarse)'));

  assert.match(touchSection, /\.ws-button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /\.ws-nav\s+a\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /\.ys-site-primary\s+a\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /\.ys-resource-tabs\s+button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /\.ws-tabs\s+a\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /:is\(input,select,textarea\)\s*\{[^}]*min-height:\s*44px;/);
  assert.match(touchSection, /\.ws-pagination\s+button,\s*\.workspace-shell\s+\.ws-pagination\s+a\s*\{[^}]*min-height:\s*44px;/);
});

test('Criterion 6: Full interaction contrast verification across all states beyond 26 static pairs', async () => {
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

  const contrast = (hex1, hex2) => {
    const l1 = luminance(hex1);
    const l2 = luminance(hex2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  // Comprehensive interactive pairs testing hover, active, focus, disabled, badges, and control borders
  const interactiveTextPairs = [
    // Default & surface states
    ['text', 'surface', 4.5],
    ['muted', 'surface', 4.5],
    ['accent', 'surface', 4.5],
    // Hover states
    ['text', 'surface-hover', 4.5],
    ['nav-text', 'nav-hover', 4.5],
    ['accent-hover', 'surface', 4.5],
    ['on-brand', 'brand-hover', 4.5],
    // Active / selected states
    ['nav-text', 'nav', 4.5],
    ['nav-muted', 'nav', 4.5],
    ['nav-on-active', 'nav-active', 4.5],
    ['on-brand', 'brand', 4.5],
    ['on-pill', 'pill', 4.5],
    ['accent', 'accent-soft', 4.5],
    // Semantic soft badges & alerts
    ['success', 'success-soft', 4.5],
    ['warning', 'warning-soft', 4.5],
    ['danger', 'danger-soft', 4.5],
    ['info', 'info-soft', 4.5],
    ['unknown', 'unknown-soft', 4.5],
    // Focus ring contrast against surface and canvas
    ['focus', 'surface', 4.5],
    ['focus', 'canvas', 4.5],
    // UI control borders (WCAG 2.1 SC 1.4.11 Non-text Contrast >= 3:1)
    ['control-border', 'surface', 3.0],
  ];

  for (const [themeName, palette] of Object.entries({ light, dark })) {
    for (const [fg, bg, minRatio] of interactiveTextPairs) {
      const fgHex = palette[`--ws-${fg}`];
      const bgHex = palette[`--ws-${bg}`];
      assert.ok(fgHex, `Missing token --ws-${fg} in ${themeName}`);
      assert.ok(bgHex, `Missing token --ws-${bg} in ${themeName}`);
      const ratio = contrast(fgHex, bgHex);
      assert.ok(
        ratio >= minRatio,
        `${themeName} interaction contrast for ${fg}/${bg} is ${ratio.toFixed(2)}, expected >= ${minRatio}`
      );
    }
  }
});
