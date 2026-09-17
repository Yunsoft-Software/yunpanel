import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Settings exposes real Network DNS identity, PowerDNS and delegation controls', async () => {
  const [operations, panel, client] = await Promise.all([
    readFile(new URL('../src/workspace/OperationsPages.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/NetworkDnsSettingsPanel.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/workspace/network-dns-client.js', import.meta.url), 'utf8'),
  ]);
  assert.match(operations, /import NetworkDnsSettingsPanel/);
  assert.match(operations, /<NetworkDnsSettingsPanel server=\{server\} domains=\{domains\.items\}/);
  assert.match(panel, /previewServerDnsIdentity/);
  assert.match(panel, /applyServerDnsIdentity/);
  assert.match(panel, /previewPowerDnsAuthoritative/);
  assert.match(panel, /applyPowerDnsAuthoritative/);
  assert.match(panel, /inspectDnsDelegation/);
  assert.match(panel, /Sunucu hostname authority değişmez/);
  assert.match(panel, /Public reachability ayrı kapı/);
  assert.match(panel, /Durable operation/);
  assert.match(panel, /automatic replay kapalı/);
  assert.match(panel, /YunPanel registrar hesabınızda otomatik değişiklik yapmaz/);
  assert.match(client, /\/identity\/preview/);
  assert.match(client, /\/authoritative\/apply/);
  assert.match(client, /\/delegation/);
  assert.doesNotMatch(panel, /window\.(?:alert|confirm|prompt)|<select|privateKey|apiKey/i);
});

test('Network DNS identity uses typed confirmation and does not silently sync existing zones', async () => {
  const panel = await readFile(new URL('../src/workspace/NetworkDnsSettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /<ConfirmDialog title="DNS kimliğini güncelle"/);
  assert.match(panel, /confirmation=\{preview\.confirmation\}/);
  assert.match(panel, /mevcut zonelar otomatik sync edilmez/);
  assert.match(panel, /<ConfirmDialog title="PowerDNS authoritative uygula"/);
  assert.match(panel, /mevcut zone'lar otomatik template sync edilmez/);
});
