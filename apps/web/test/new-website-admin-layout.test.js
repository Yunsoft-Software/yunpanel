import { register } from 'node:module';
register('./jsx-loader.js', import.meta.url);
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Source regressions only. Real React/CSS/browser layout remains an acceptance task.
const page = await readFile(new URL('../src/workspace/NewWebsitePage.jsx', import.meta.url), 'utf8');
const consoleTheme = await readFile(new URL('../src/workspace/ui/console-theme.css', import.meta.url), 'utf8');
const emberTheme = await readFile(new URL('../src/workspace/ui/ember-theme.css', import.meta.url), 'utf8');

const { LoginCredentialsFields } = await import('../src/workspace/LoginCredentialsFields.jsx');
function renderedFields() {
  return renderToStaticMarkup(createElement(LoginCredentialsFields, {
    email: 'fixture@example.com', password: 'fixture password 123!', onEmailChange() {}, onPasswordChange() {},
  }));
}

test('rendered credential pair uses the responsive grid and aligned controls', () => {
  const html = renderedFields();
  assert.match(html, /class="ws-form-grid ws-site-admin-fields"/);
  assert.match(html, /align-items:start/);
  assert.equal((html.match(/<input /g) ?? []).length, 2);
});

test('rendered credential descriptions belong to distinct fields and stay unique across repeated forms', () => {
  const html = renderToStaticMarkup(createElement('div', null,
    createElement(LoginCredentialsFields, { email: '', password: '', onEmailChange() {}, onPasswordChange() {} }),
    createElement(LoginCredentialsFields, { email: '', password: '', onEmailChange() {}, onPasswordChange() {} })));
  const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(described).size, 4);
  for (const id of described) assert.ok(html.includes(`id="${id}"`));
});

test('rendered email and password retain constraints, autofill and controlled values', () => {
  const html = renderedFields();
  const inputs = [...html.matchAll(/<input [^>]+>/g)].map(match => match[0]);
  assert.ok(inputs.some(input => input.includes('type="email"') && input.includes('required=""')
    && input.includes('autoComplete="email"') && input.includes('value="fixture@example.com"')));
  assert.ok(inputs.some(input => input.includes('type="password"') && input.includes('required=""')
    && input.includes('minLength="12"') && input.includes('autoComplete="new-password"') && input.includes('value="fixture password 123!"')));
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
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*>\s*input:invalid\s*\{[^}]*box-shadow:\s*none;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+input\[type="password"\]::-ms-reveal/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+input\[type="password"\]::-ms-clear/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+input::-webkit-credentials-auto-fill-button\s*\{[^}]*margin:\s*0;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+\.ws-field-hint\s*\{[^}]*font-size:\s*12px;[^}]*line-height:\s*1\.5;[^}]*margin:\s*0;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*height:\s*var\(--ws-control-height\);/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-site-admin-fields\s+label\s*>\s*input\s*\{[^}]*min-height:\s*var\(--ws-control-height\);/);
});

test('responsive layout preserves equal column sizing and consistent mobile vertical stacking', () => {
  assert.match(consoleTheme, /\.ws-form-grid\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\);\s*gap:\s*18px;\s*\}/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.ws-form-grid\s*\{\s*grid-template-columns:\s*minmax\(0,1fr\);/);
  assert.match(consoleTheme, /@media\s*\(max-width:\s*640px\)[\s\S]*?--ws-control-height:\s*44px;/);
});

test('text wrapping and overflow prevention are enforced across hints and labels for 200% zoom and narrow viewports', () => {
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+label\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+\.ws-field-hint\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(consoleTheme, /\.ws-site-admin-fields\s+\.ws-field-hint\s*\{[^}]*word-break:\s*break-word;/);
  assert.match(consoleTheme, /\.ws-notice\s*>\s*span\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-site-admin-fields\s+\.ws-field-hint\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  assert.match(emberTheme, /\.workspace-shell\s+\.ws-site-admin-fields\s+\.ws-field-hint\s*\{[^}]*word-break:\s*break-word;/);
});
