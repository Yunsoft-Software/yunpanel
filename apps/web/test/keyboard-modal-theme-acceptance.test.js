import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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

test('Topbar theme toggle syncs across tabs via storage listener and omits legacy sidebar appearance disclosure', () => {
  assert.doesNotMatch(layoutJsx, /ws-appearance|Görünüm tercihleri/);
  assert.match(layoutJsx, /className="ws-theme-toggle ws-icon-btn"/);
  assert.match(layoutJsx, /window\.addEventListener\('storage',\s*onStorage\)/);
  assert.match(layoutJsx, /window\.removeEventListener\('storage',\s*onStorage\)/);
});

test('Mobile navigation drawer traps Tab/Shift+Tab, renders close button only on narrow screens, and restores focus to trigger on close', () => {
  // Focus moves into drawer on open
  assert.match(layoutJsx, /menu\.current\.querySelector\('button'\)\?\.focus\(\)/);

  // Close button is only rendered inside mobile drawer (no duplicate desktop close button)
  assert.match(layoutJsx, /\{narrow && <Button className="ws-nav-close ws-icon-btn"/);

  // Drawer escape handler closes menu
  assert.match(layoutJsx, /if \(event\.key === 'Escape'\)/);
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

test('Modal component keeps accessible native dialog markup and focus lifecycle controls', async () => {
  // Native dialog element with modal attributes
  const { Modal, ModalScope } = await import('../src/workspace/PanelKit.jsx');
  const render = active => renderToStaticMarkup(createElement(ModalScope, { active }, createElement(Modal, { title: 'Owned task', onClose() {} }, 'Task content')));
  const visible = render(true), hidden = render(false);
  assert.match(visible, /<dialog [^>]*aria-modal="true"/);
  assert.doesNotMatch(visible.match(/<dialog [^>]+>/)[0], /hidden/);
  assert.match(hidden.match(/<dialog [^>]+>/)[0], /hidden/);
  const id = visible.match(/aria-labelledby="([^"]+)"/)[1];
  assert.ok(visible.includes(`id="${id}"`));

  // Initial focus on mount
  assert.match(panelKit, /const initial = dialog\?\.querySelector\('\[autofocus\]'\)/);
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
