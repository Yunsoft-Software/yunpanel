import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { themeSection } from './theme-section.js';

test('console skin loads once, after global, auth and legacy workspace styles', async () => {
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../src/workspace/WorkspaceLayout.jsx', import.meta.url), 'utf8');
  // The console skin is a section of the design system, which main.jsx imports once after the app.
  const skin = main.indexOf("import './workspace/design-system/theme.css'");
  assert.ok(skin > main.indexOf("import App from './App.jsx'"));
  assert.ok(main.indexOf("import AuthGate from './AuthGate.jsx'") < skin);
  assert.doesNotMatch(layout, /import ['"].*\.css/);
  const theme = await readFile(new URL('../src/workspace/design-system/theme.css', import.meta.url), 'utf8');
  const at = (title) => theme.indexOf(`   ${title}\n`);
  assert.ok(at('Base: document, headings, legacy buttons and status dots') < at('Console skin'));
  assert.ok(at('Workspace shell: sidebar, toolbar, sections, tables, badges') < at('Console skin'));
  assert.ok(at('Legacy auth controls inside the workspace') < at('Console skin'));
});

test('console defines native hidden, touch, contrast-mode and mobile record styles', async () => {
  const css = await themeSection('console-theme');
  for (const token of ['[hidden]', '.ws-db-table', '.ws-history', 'prefers-reduced-motion', 'forced-colors', 'pointer: coarse']) assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /iframe\s*\{|filter:\s*invert/);
});
