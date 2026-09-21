import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('SiteOperations SSL issuance includes Plesk Obsidian multi-SAN checkboxes and ACME email pre-fill', async () => {
  const operations = await readFile(new URL('../src/workspace/SiteOperations.jsx', import.meta.url), 'utf8');

  // Pre-fills ACME email from panel settings
  assert.match(operations, /getPanelSettings/);
  assert.match(operations, /settings\?\.dnsSsl\?\.acmeEmail/);

  // Plesk Obsidian SAN checkboxes
  assert.match(operations, /Sertifika Kapsamı \(Plesk Obsidian standardı\)/);
  assert.match(operations, /www\.\$\{domain\.primaryDomain\}/);
  assert.match(operations, /webmail\.\$\{domain\.primaryDomain\}/);
  assert.match(operations, /mail\.\$\{domain\.primaryDomain\}/);
  assert.match(operations, /Sertifikayı posta alan adına ata \(Postfix\/Dovecot TLS SNI\)/);
  assert.match(operations, /\*\.\$\{domain\.primaryDomain\}/);

  // Passes domains and assignToMail payload to API
  assert.match(operations, /domains: requestedDomains/);
  assert.match(operations, /assignToMail/);
  assert.match(operations, /\/mail-service-identity/);
});

test('SystemSettingsPanels provides editable form for ACME email in DNS ve SSL politikası', async () => {
  const panels = await readFile(new URL('../src/workspace/SystemSettingsPanels.jsx', import.meta.url), 'utf8');

  assert.match(panels, /updatePanelSettings/);
  assert.match(panels, /ACME \/ Yönetici İletişim E-postası/);
  assert.match(panels, /dnsSsl:\s*\{\s*acmeEmail:/);
  assert.match(panels, /E-postayı Kaydet/);
});
