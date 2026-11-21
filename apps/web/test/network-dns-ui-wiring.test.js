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
  assert.match(panel, /resolvePowerDnsRecovery/);
  assert.match(panel, /retryPowerDnsRecovery/);
  assert.match(panel, /rollbackPowerDnsAuthoritative/);
  assert.match(panel, /inspectDnsDelegation/);
  assert.match(panel, /Ağ ve Yetkili DNS/);
  assert.match(panel, /PowerDNS Yerel ve Dış Erişim Durumu/);
  assert.match(panel, /Alan Adı Kayıt ve Delege Bilgisi/);
  assert.match(panel, /İşletim sistemi sunucu adı değiştirilmez/);
  assert.match(panel, /Dış DNS erişimi ayrı doğrulanır/);
  assert.match(panel, /Son kurulum işlemi/);
  assert.match(panel, /Otomatik yeniden çalıştırma güvenlik nedeniyle durduruldu/);
  assert.match(panel, /Kurtarma durumunu incele/);
  assert.match(panel, /İncele ve yeniden dene/);
  assert.match(panel, /Önceki PowerDNS durumuna dön/);
  assert.match(panel, /Paket, yapılandırma veya servis değişikliği yapılmayacak/);
  assert.match(panel, /YunPanel alan adı kayıt firmanızdaki ayarları otomatik değiştirmez/);
  assert.match(panel, /Yedekli DNS eksik: ns1 ve ns2 aynı sunucu adresine yönleniyor/);
  assert.match(panel, /<summary>Destek kodu<\/summary>/);
  assert.doesNotMatch(panel, /Sunucu hostname authority değişmez|ayrı evidence kaynaklarıdır|Durable operation|Network \/ Authoritative DNS|PowerDNS local \/ public health|Registrar \/ delegation/);
  assert.match(client, /\/identity\/preview/);
  assert.match(client, /\/authoritative\/apply/);
  assert.match(client, /\/authoritative\/recovery\/resolve/);
  assert.match(client, /\/authoritative\/recovery\/retry/);
  assert.match(client, /\/authoritative\/rollback/);
  assert.match(client, /\/delegation/);
  assert.doesNotMatch(panel, /window\.(?:alert|confirm|prompt)|<select|privateKey|apiKey/i);
});

test('Network DNS identity uses typed confirmation and does not silently sync existing zones', async () => {
  const panel = await readFile(new URL('../src/workspace/NetworkDnsSettingsPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /<ConfirmDialog title="DNS kimliğini güncelle"/);
  assert.match(panel, /confirmation=\{preview\.confirmation\}/);
  assert.match(panel, /mevcut bölgeler otomatik olarak güncellenmez/);
  assert.match(panel, /<ConfirmDialog title="PowerDNS kurulumunu uygula"/);
  assert.match(panel, /mevcut bölgeler otomatik olarak güncellenmez/);
});
