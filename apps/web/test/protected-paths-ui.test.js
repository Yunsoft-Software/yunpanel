import { register } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);

const { default: NginxSettingsFields } = await import('../src/workspace/NginxSettingsFields.jsx');
const { default: ProtectedPathUsers } = await import('../src/workspace/ProtectedPathUsers.jsx');

const render = (settings) => renderToStaticMarkup(createElement(NginxSettingsFields,
  { targetType: 'php', disabled: false, onChange() {}, settings: { headers: [], ...settings } }));

test('protected directories are listed in the web server settings with add and remove controls', () => {
  const markup = render({ protectedPaths: [{ path: '/yonetim/', key: '0123456789abcdef' }] });
  assert.ok(markup.includes('Şifre korumalı dizinler'));
  assert.ok(markup.includes('value="/yonetim/"'));
  assert.ok(markup.includes('Dizin 1 kaldır'));
  assert.ok(markup.includes('Dizin ekle'));
  assert.equal(markup.includes('0123456789abcdef'), false, 'the key stays internal');
});

test('the users section stays hidden while no directory is saved', () => {
  assert.equal(renderToStaticMarkup(createElement(ProtectedPathUsers, { domainId: 'd1', savedPaths: [], disabled: false })), '');
});
