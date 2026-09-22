import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (name) => readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
test('Ember is the final entrypoint stylesheet after the console layout', async () => {
  const main = await source('main.jsx');
  const old = main.indexOf("import './workspace/ui/console-theme.css'");
  const skin = main.indexOf("import './workspace/ui/ember-theme.css'");
  assert.ok(old >= 0 && skin > old);
  const imports = [...main.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)].map((m) => m[1]);
  assert.equal(imports.at(-1), './workspace/ui/ember-theme.css');
  assert.equal(imports.filter((path) => path.includes('ember-theme')).length, 1);
});
test('warm dark and light palettes are explicit; brand and danger remain separate', async () => {
  const css = await source('workspace/ui/ember-theme.css');
  assert.match(css, /data-ws-theme='dark'/);
  for (const token of ['--ws-brand:', '--ws-on-brand:', '--ws-danger:', '--ws-success:', '--ws-chart-cpu:', '--ws-nav-on-active:', '--ws-control-border:']) assert.ok(css.includes(token), token);
  assert.match(css, /--ws-radius: 22px/);
  assert.doesNotMatch(css, /#(?:246bfa|90bdff|0b121d)\b/i);
});
test('file mail database and existing navigation get the visual language without UX replacement', async () => {
  const css = await source('workspace/ui/ember-theme.css');
  for (const selector of ['.yf-browser', '.yf-table', '.yf-grid', '.ys-resource-table', '.ys-resource-tabs', '.ys-site-primary', '.ws-db-access', '.ws-modal']) assert.ok(css.includes(selector), selector);
  assert.doesNotMatch(css, /display:\s*none|pointer-events:\s*none|filter:\s*invert|iframe\s*\{/);
  for (const state of ['focus-visible', 'prefers-reduced-motion', 'forced-colors', 'pointer: coarse', "[aria-current]", "[aria-pressed=true]"]) assert.ok(css.includes(state), state);
});
test('fonts are self-hosted with swap and monospace editors are not restyled as UI text', async () => {
  const css = await source('workspace/ui/ember-typography.css');
  assert.match(css, /font-family: 'Yun Manrope'/); assert.match(css, /font-family: 'Yun Outfit'/);
  assert.equal([...css.matchAll(/font-display: swap/g)].length, 2);
  assert.doesNotMatch(css, /url\(['"]?https?:/);
  assert.match(css, /font-family: var\(--ws-font-code\)/);
  assert.match(css, /\.yf-editor textarea/);
});
test('build prepares fonts but adds no runtime package dependency', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.prebuild, 'npm run fonts'); assert.equal(pkg.scripts.predev, 'npm run fonts');
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@xterm/addon-fit','@xterm/xterm','react','react-dom','react-router'].sort());
});
test('normal text, navigation and semantic badges retain 4.5 contrast in both palettes', async () => {
  const css = await source('workspace/ui/ember-theme.css');
  const [base, tail] = css.split(":root[data-ws-theme='dark']");
  const tokens = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[a-f0-9]{6})(?:;|\s)/g)].map((m) => [m[1], m[2]]));
  const light = tokens(base), dark = { ...light, ...tokens(tail.split('}')[0]) };
  const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const pairs = [['text','surface'],['muted','surface'],['accent','surface'],['nav-muted','nav'],['nav-text','nav'],
    ['nav-on-active','nav-active'],['on-brand','brand'],['success','success-soft'],['warning','warning-soft'],
    ['danger','danger-soft'],['info','info-soft'],['unknown','unknown-soft'],['on-pill','pill']];
  for (const [name, values] of Object.entries({ light, dark })) for (const [fg, bg] of pairs) {
    const levels = [luminance(values[`--ws-${fg}`]), luminance(values[`--ws-${bg}`])].sort((a,b) => a-b);
    const ratio = (levels[1] + .05) / (levels[0] + .05);
    assert.ok(ratio >= 4.5, `${name} ${fg}/${bg}: ${ratio}`);
  }
});
