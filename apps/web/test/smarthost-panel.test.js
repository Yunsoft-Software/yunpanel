import { register } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

register('./jsx-loader.js', import.meta.url);
const { default: SmarthostPanel, smarthostPath, smarthostRequest } = await import('../src/workspace/SmarthostPanel.jsx');

test('the relay request trims input, sends a number port and always asks for confirmation', () => {
  assert.equal(smarthostPath('srv 1'), '/servers/srv%201/mail/smarthost');
  assert.deepEqual(smarthostRequest({ host: ' smtp.example.com ', port: '465', username: ' user ', password: '' }),
    { host: 'smtp.example.com', port: 465, username: 'user', password: '', confirmation: 'smarthost-apply' });
});

test('the panel renders the relay fields and a single apply action', () => {
  const html = renderToStaticMarkup(React.createElement(SmarthostPanel, { serverId: 'srv-1' }));
  for (const label of ['Sunucu', 'Port', 'Kullanıcı adı', 'Parola', 'Uygula']) assert.match(html, new RegExp(label));
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /Onayla/, 'confirmation appears only after Apply');
});

test('the mail screen shows queue, service logs and relay settings to the Owner only', () => {
  const source = readFileSync(new URL('../src/workspace/MailOperationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(source, /\{isOwner && <><QueuePanel serverId=\{server\.id\} \/><LogsPanel serverId=\{server\.id\} \/><\/>\}/);
  assert.match(source, /\{isOwner && <SmarthostPanel serverId=\{server\.id\} \/>\}/);
});
