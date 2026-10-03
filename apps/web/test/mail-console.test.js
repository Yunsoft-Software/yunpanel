import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('../src/workspace/MailDomainsPage.jsx', import.meta.url), 'utf8');
test('mail management retains all integration panels behind explicit sections', () => {
  for (const panel of ['MailboxesPanel', 'MailWebmailPanel', 'MailAliasesPanel', 'MailDkimDiagnosticsPanel', 'MailConfigurationPanel', 'MailOperationsPanel']) assert.ok(source.includes(`<${panel}`), panel);
  for (const key of ['mailboxes', 'webmail', 'aliases', 'security', 'configuration', 'operations']) assert.ok(source.includes(`hidden={section !== '${key}'}`), key);
});
test('mail section links preserve query state and domain changes reset component identity', () => {
  assert.match(source, /new URLSearchParams\(params\)/);
  assert.match(source, /next\.set\('section', key\)/);
  assert.match(source, /<MailDomainDetail key=\{mailDomainId\}/);
  assert.match(source, /aria-current=\{section === key \? 'page'/);
});
test('mail listing has real filtering and pagination without pretending external accounts are local', () => {
  assert.match(source, /paginateConsoleItems\(filtered/);
  assert.match(source, /item\.managementMode === mode/);
  assert.match(source, /domain\.managementMode === 'local'/);
  assert.match(source, /Harici mail sağlayıcısı/);
  assert.doesNotMatch(source, /window\.open|localStorage|sessionStorage/);
});

test('mailboxes panel exposes connection settings, reception, and test delivery diagnostics', async () => {
  const mailboxesSource = await readFile(new URL('../src/workspace/MailboxesPanel.jsx', import.meta.url), 'utf8');
  assert.match(mailboxesSource, /MailboxDiagnosticsModal/);
  assert.match(mailboxesSource, /getMailboxDeliveryDiagnostics/);
  assert.match(mailboxesSource, /sendMailboxTestDelivery/);
  assert.match(mailboxesSource, /İstemci Bağlantı Ayarları/);
  assert.match(mailboxesSource, /Posta Kutusu Durumu/);
  assert.match(mailboxesSource, /DNS ve Doğrulama Durumu/);
  assert.match(mailboxesSource, /Teslimat Testi/);
});

test('mail DKIM and operations panels expose DNS requirements, connection settings, and authentic delivery test', async () => {
  const dkimSource = await readFile(new URL('../src/workspace/MailDkimDiagnosticsPanel.jsx', import.meta.url), 'utf8');
  assert.match(dkimSource, /getMailDeliveryDiagnostics/);
  assert.match(dkimSource, /sendMailDomainTestDelivery/);
  assert.match(dkimSource, /İstemci Bağlantı Bilgileri/);
  assert.match(dkimSource, /DNS Teslimat Gereksinimleri/);
  assert.match(dkimSource, /Teslimat Testi/);

  const opsSource = await readFile(new URL('../src/workspace/MailOperationsPanel.jsx', import.meta.url), 'utf8');
  assert.match(opsSource, /ServiceConnectionDiagnosticsPanel/);
  assert.match(opsSource, /ServiceTestDeliveryPanel/);
  assert.match(opsSource, /getServerMailDeliveryDiagnostics/);
  assert.match(opsSource, /sendServerMailTestDelivery/);
  assert.match(opsSource, /Yönlendirme/);
  assert.match(opsSource, /secret masking/);
});
