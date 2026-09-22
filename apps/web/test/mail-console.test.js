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
