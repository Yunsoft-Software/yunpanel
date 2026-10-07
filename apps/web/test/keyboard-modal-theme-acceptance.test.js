import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');

const [
  layoutJsx,
  panelKit,
  accountDialog,
  emberTheme,
  workspaceCss,
  dnsPanelCss,
  networkDnsCss,
  terminalCss,
  fileWorkspaceCss,
  aiDrawer,
  aiSettings,
  filesPanel,
  mailDomains,
  dockerProjects,
  terminalPanel,
] = await Promise.all([
  source('workspace/WorkspaceLayout.jsx'),
  source('workspace/PanelKit.jsx'),
  source('AccountDialog.jsx'),
  source('workspace/ui/ember-theme.css'),
  source('workspace/workspace.css'),
  source('workspace/dns-panel.css'),
  source('workspace/network-dns.css'),
  source('workspace/terminal.css'),
  source('workspace/ui/file-workspace.css'),
  source('workspace/AiDrawer.jsx'),
  source('workspace/AiSettingsPanel.jsx'),
  source('workspace/FilesPanel.jsx'),
  source('workspace/MailDomainsPage.jsx'),
  source('workspace/DockerProjectsPage.jsx'),
  source('workspace/TerminalPanel.jsx'),
]);

/* ==========================================================================\n   1. Mobile Menu & Appearance Details Keyboard Navigation (Tab/Shift+Tab/Escape)\n   ========================================================================== */

test('Appearance details supports Escape dismissal and Tab/Shift+Tab boundary wrapping', () => {
  // Preserves exact literal details tag for plesk-navigation test
  assert.match(layoutJsx, /<details className="ws-appearance">/);

  // Escape key collapses details and refocuses summary
  assert.match(layoutJsx, /if \(event\.key === 'Escape'\)/);
  assert.match(layoutJsx, /details\.open = false/);
  assert.match(layoutJsx, /details\.querySelector\('summary'\)\?\.focus\(\)/);

  // Tab key cycles within open appearance details
  assert.match(layoutJsx, /if \(event\.key === 'Tab' && details\.open\)/);
  assert.match(layoutJsx, /event\.shiftKey && document\.activeElement === first/);
  assert.match(layoutJsx, /!event\.shiftKey && document\.activeElement === last/);
});

test('Mobile navigation drawer traps Tab/Shift+Tab and restores focus to trigger on close', () => {
  // Focus moves into drawer on open
  assert.match(layoutJsx, /menu\.current\.querySelector\('button'\)\?\.focus\(\)/);

  // Drawer escape handler checks nested appearance details first
  assert.match(layoutJsx, /appearanceRef\.current\?\.open && appearanceRef\.current\.contains\(document\.activeElement\)/);
  assert.match(layoutJsx, /setMenuOpen\(false\)/);

  // Drawer cycles focus on Tab and Shift+Tab
  assert.match(layoutJsx, /if \(event\.key !== 'Tab'\) return;/);
  assert.match(layoutJsx, /event\.shiftKey && \(document\.activeElement === first/);
  assert.match(layoutJsx, /!event\.shiftKey && \(document\.activeElement === last/);

  // Return focus on drawer close
  assert.match(layoutJsx, /if \(previous\?\.isConnected && typeof previous\.focus === 'function'\) previous\.focus\(\);/);
  assert.match(layoutJsx, /document\.querySelector\('\.ws-mobile-menu'\)\?\.focus\(\)/);
});

/* ==========================================================================\n   2. Native Modal Open Focus and Return Focus\n   ========================================================================== */

test('Modal component in PanelKit moves focus on open and restores trigger focus on close', () => {
  // Native dialog element with modal attributes
  assert.match(panelKit, /<dialog ref=\{ref\} className=\{`ws-modal \$\{wide \? 'ws-modal-wide' : ''\}`\} aria-modal="true"/);

  // Initial focus on mount
  assert.match(panelKit, /const initial = dialog\?\.querySelector\('\[autofocus\]'\) \|\| focusable\[0\];/);
  assert.match(panelKit, /initial\.focus\(\)/);

  // Focus restore on unmount
  assert.match(panelKit, /if \(previous && typeof previous\.focus === 'function'\)/);
  assert.match(panelKit, /previous\.focus\(\{ preventScroll: true \}\)/);

  // Keyboard navigation & trap
  assert.match(panelKit, /if \(event\.key === 'Escape'\)/);
  assert.match(panelKit, /if \(event\.key === 'Tab'\)/);
});

test('AccountDialog moves focus on open and restores trigger focus on close', () => {
  // Native dialog element with modal attributes
  assert.match(accountDialog, /<dialog ref=\{dialog\} className="auth-dialog" aria-modal="true" aria-labelledby="account-heading"/);

  // Initial focus on mount
  assert.match(accountDialog, /const initial = el\?\.querySelector\('\[autofocus\]'\) \|\| focusable\[0\];/);
  assert.match(accountDialog, /initial\.focus\(\)/);

  // Focus restore on unmount
  assert.match(accountDialog, /if \(previous && typeof previous\.focus === 'function'\)/);
  assert.match(accountDialog, /previous\.focus\(\{ preventScroll: true \}\)/);

  // Keyboard navigation & trap
  assert.match(accountDialog, /if \(event\.key === 'Escape'\)/);
  assert.match(accountDialog, /if \(event\.key === 'Tab'\)/);
});

/* ==========================================================================\n   3. Accessibility Preferences: prefers-reduced-motion & forced-colors\n   ========================================================================== */

test('prefers-reduced-motion and forced-colors are comprehensively supported', () => {
  // Reduced motion media query suppresses animations across workspace, modals, and auth
  assert.match(emberTheme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(emberTheme, /\.ws-modal,\s*\.ws-modal \*,\s*\.auth-dialog,\s*\.auth-dialog \*\s*\{\s*transition:\s*none !important;\s*animation:\s*none !important;/);

  // Forced colors media query defines high-contrast system colors
  assert.match(emberTheme, /@media \(forced-colors: active\)/);
  assert.match(emberTheme, /\.ws-modal\s*\{\s*border:\s*1px\s*solid\s*CanvasText;\s*\}/);
  assert.match(emberTheme, /\.auth-dialog\s*\{\s*border:\s*1px\s*solid\s*CanvasText;\s*\}/);
  assert.match(emberTheme, /:is\(input,select,textarea\)[^}]*border:\s*1px\s*solid\s*CanvasText;/);
  assert.match(emberTheme, /outline:\s*2px\s*solid\s*Highlight !important;\s*outline-offset:\s*3px;/);
  assert.match(emberTheme, /border-color:\s*GrayText !important;\s*color:\s*GrayText !important;/);
});

/* ==========================================================================\n   4. Theme Conformance & Table Containment across Panels\n   ========================================================================== */

test('Panels conform to common theme tokens and contain wide tables', () => {
  // DNS styles use semantic variables without hardcoded hex
  assert.doesNotMatch(dnsPanelCss, /#[0-9a-fA-F]{3,8}/);
  assert.doesNotMatch(networkDnsCss, /#[0-9a-fA-F]{3,8}/);
  assert.match(dnsPanelCss, /\.dns-table-wrap/);

  // Terminal styles use semantic tokens
  assert.match(terminalCss, /var\(--ws-terminal-bg,\s*var\(--ws-canvas/);
  assert.match(terminalPanel, /getPropertyValue\('--ws-canvas'\)/);

  // File workspace styles use semantic tokens without raw hardcoded hex
  assert.doesNotMatch(fileWorkspaceCss, /#[0-9a-fA-F]{3,8}/);
  assert.match(filesPanel, /<div className="ws-table-scroll"><table className="yf-table"/);

  // AI Drawer and Settings panel use semantic tokens
  assert.doesNotMatch(aiDrawer, /#[0-9a-fA-F]{3,8}/);
  assert.doesNotMatch(aiSettings, /#[0-9a-fA-F]{3,8}/);

  // Mail and Docker panels wrap tables in scroll container
  assert.match(mailDomains, /ws-table-scroll|ws-table-wrap/);
  assert.match(dockerProjects, /ws-table-scroll|ws-table-wrap/);

  // Universal table scroll utility exists
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(workspaceCss, /\.ws-table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain;/);
});

/* ==========================================================================\n   5. Vendor iframe CSS Protection\n   ========================================================================== */

test('Vendor iframes are protected from CSS filter modifications', () => {
  const allStyles = [emberTheme, workspaceCss, dnsPanelCss, networkDnsCss, terminalCss, fileWorkspaceCss].join('\n');
  assert.doesNotMatch(allStyles, /iframe\s*\{[^}]*filter:/);
  assert.doesNotMatch(allStyles, /iframe\s*\{[^}]*invert/);
});
