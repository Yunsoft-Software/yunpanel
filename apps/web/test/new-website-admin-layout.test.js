import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source regressions only. Real React/CSS/browser layout remains an acceptance task.
const page = await readFile(new URL('../src/workspace/NewWebsitePage.jsx', import.meta.url), 'utf8');
const fields = page.slice(page.indexOf('<h3>Site Yöneticisi</h3>'), page.indexOf('<h3>3. HTTPS</h3>'));
const consoleTheme = await readFile(new URL('../src/workspace/ui/console-theme.css', import.meta.url), 'utf8');
const emberTheme = await readFile(new URL('../src/workspace/ui/ember-theme.css', import.meta.url), 'utf8');

test('only the admin pair opts into top alignment while shared responsive columns are retained', () => {
  assert.match(fields, /className="ws-form-grid ws-site-admin-fields" style=\{\{ marginTop: 16, alignItems: 'start' \}\}/);
  assert.equal((page.match(/ws-site-admin-fields/g) ?? []).length, 1);
  assert.doesNotMatch(fields, /height:|minHeight:|gridTemplateColumns:|overflow:|position:/);
});

test('both account inputs have distinct accessible descriptions below their controls', () => {
  for (const kind of ['email', 'password']) {
    assert.ok(fields.includes(`aria-describedby="website-admin-${kind}-hint"`));
    assert.ok(fields.includes(`<span id="website-admin-${kind}-hint" className="ws-field-hint">`));
  }
  assert.equal((fields.match(/className="ws-field-hint"/g) ?? []).length, 2);
  assert.match(fields, /Panel girişi için kullanılır; posta kutusu hesabından ayrıdır/);
});

test('email/password controls keep their constraints and controlled form updates', () => {
  assert.match(fields, /type="email"[\s\S]*?required/);
  assert.match(fields, /type="password"[\s\S]*?required[\s\S]*?minLength=\{12\}/);
  assert.match(fields, /autoComplete="new-password"/);
  for (const key of ['adminEmail', 'adminPassword']) {
    assert.ok(fields.includes(`value={form.${key}}`));
    assert.ok(fields.includes(`update('${key}', event.target.value)`));
  }
  assert.doesNotMatch(fields, /defaultValue=|dangerouslySetInnerHTML/);
});

test('scope, submission guard and post-result password cleanup remain connected', () => {
  assert.match(page, /<WebsiteForm key=\{identity\} parentId=\{parentId\}/);
  assert.match(page, /if \(locked \|\| pending.current \|\| !current\?\.isCurrent\(\)\) return/);
  assert.match(page, /setForm\(\(value\) => \(\{ \.\.\.value, adminPassword: '' \}\)\)/);
  assert.match(page, /<fieldset disabled=\{baseLocked\}>/);
});

test('console and ember themes enforce equal input heights, label baseline alignment, and suppress reveal asymmetry', () => {
  assert.match(consoleTheme, /\.ws-site-admin-fields\s*\{\s*align-items:\s*start;\s*\}/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*7px;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*\{[^}]*line-height:\s*1\.4;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*height:\s*var\(--ws-control-height\);/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*min-height:\s*var\(--ws-control-height\);/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*box-sizing:\s*border-box;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+input\[type="password"\]::-ms-reveal/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+input\[type="password"\]::-ms-clear/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*height:\s*var\(--ws-control-height\);/);
});

test('responsive layout preserves equal column sizing and consistent mobile vertical stacking', () => {
  assert.match(consoleTheme, /\.ws-form-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);\s*gap:\s*18px;\s*\}/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.ws-form-grid\s*\{\s*grid-template-columns:\s*minmax\(0,1fr\);/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)[\s\S]*?--ws-control-height:\s*44px;/);
});
