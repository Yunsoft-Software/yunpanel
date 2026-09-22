import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('console skin loads once, after global, auth and legacy workspace styles', async () => {
  const main = await readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../src/workspace/WorkspaceLayout.jsx', import.meta.url), 'utf8');
  const skin = main.indexOf("import './workspace/ui/console-theme.css'");
  assert.ok(skin > main.indexOf("import App from './App.jsx'"));
  assert.ok(main.indexOf("import './styles.css'") < main.indexOf("import App from './App.jsx'"));
  assert.ok(main.indexOf("import AuthGate from './AuthGate.jsx'") < skin);
  assert.doesNotMatch(layout, /import ['"].*console-theme\.css/);
});

test('console defines native hidden, touch, contrast-mode and mobile record styles', async () => {
  const css = await readFile(new URL('../src/workspace/ui/console-theme.css', import.meta.url), 'utf8');
  for (const token of ['[hidden]', '.ws-db-table', '.ws-history', 'prefers-reduced-motion', 'forced-colors', 'pointer: coarse']) assert.ok(css.includes(token), token);
  assert.doesNotMatch(css, /iframe\s*\{|filter:\s*invert/);
});
