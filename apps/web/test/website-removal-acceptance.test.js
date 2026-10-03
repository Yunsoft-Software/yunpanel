import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWebsiteTaskResolver } from '../src/workspace/website-task-model.js';
import { removalBlockerLabel } from '../src/workspace/website-removal-model.js';

const source = (name) => readFile(new URL('../src/workspace/' + name, import.meta.url), 'utf8');

test('BUG-20260923-02: website removal action is available on list task cards for owner', async () => {
  const cardText = await source('WebsiteTaskCard.jsx');
  assert.match(cardText, /tasks\.removeHref/);
  assert.match(cardText, /Siteyi sil/);

  // Model logic for removal link
  const domainItem = { id: 'd-1', primaryDomain: 'example.com', serverId: 's-1', websiteId: 'w-1' };
  const websiteItem = { id: 'w-1', name: 'example.com', serverId: 's-1' };

  const ownerResolver = createWebsiteTaskResolver({
    domains: { status: 'ready', items: [domainItem] },
    websites: { status: 'ready', items: [websiteItem] },
    isOwner: true,
    canManage: true,
  });
  const ownerTasks = ownerResolver('d-1');
  assert.equal(ownerTasks.removeHref, '/websites/d-1/settings');

  // Non-owner should not expose removal
  const nonOwnerResolver = createWebsiteTaskResolver({
    domains: { status: 'ready', items: [domainItem] },
    websites: { status: 'ready', items: [websiteItem] },
    isOwner: false,
    canManage: true,
  });
  const nonOwnerTasks = nonOwnerResolver('d-1');
  assert.equal(nonOwnerTasks.removeHref, null);
});

test('BUG-20260923-02: site detail header and overview link to removal lifecycle', async () => {
  const detailText = await source('SiteDetailPage.jsx');
  assert.match(detailText, /Siteyi sil/);
  assert.match(detailText, /onChanged=\{refreshAll\}/);
  assert.match(detailText, /<WebsiteRemovalPanel domainId=\{domain\.id\} onChanged=\{refreshAll\} \/>/);
});

test('BUG-20260923-02: preview covers domain/subdomain, files, db, email, runtime, DNS, certs and backups', async () => {
  const panelText = await source('WebsiteRemovalPanel.jsx');
  // Impact preview items
  assert.match(panelText, /Bağlı alan adı/);
  assert.match(panelText, /Alt alan adı \(subdomain\)/);
  assert.match(panelText, /Site dosyaları/);
  assert.match(panelText, /Veritabanı bağlantısı/);
  assert.match(panelText, /E-posta etkisi/);
  assert.match(panelText, /Uygulama çalışma zamanı \(runtime\)/);
  assert.match(panelText, /DNS bölgesi ve kayıtları/);
  assert.match(panelText, /SSL\/TLS sertifikası/);
  assert.match(panelText, /Korunacak yedek kaydı/);
  assert.match(panelText, /Kalıcı silme ve veri saklama \(retention\)/);
  assert.match(panelText, /yedek kayıtları silinmez, korunur/);
});

test('BUG-20260923-02: explicit confirmation, retention notice, and safe journal progression', async () => {
  const panelText = await source('WebsiteRemovalPanel.jsx');
  assert.match(panelText, /confirmation=\{scope\.label\}/);
  assert.match(panelText, /Yedek kayıtları silinmeyecek/);
  assert.match(panelText, /backup evidence/);
  assert.match(panelText, /Sonraki silme adımını çalıştır/);
  assert.match(panelText, /Bu adımı açıkça yeniden dene/);
  assert.match(panelText, /Silme engeli/);
  assert.match(panelText, /Tamamlanan adım/);
});

test('BUG-20260923-02: blocker labels translate step obstacles clearly', () => {
  const cleanupUnverified = removalBlockerLabel('website_removal_cleanup_unverified');
  assert.match(cleanupUnverified, /doğrulanamadı/);

  const interrupted = removalBlockerLabel('website_removal_interrupted');
  assert.match(interrupted, /kesintiye uğradı/);

  const childBlocked = removalBlockerLabel('child_domain_removal_blocked');
  assert.match(childBlocked, /alan adı/);
  assert.match(childBlocked, /engellendi/);
});

test('BUG-20260923-02: recovery panel propagates updates to website and domain lists on success', async () => {
  const recoveryText = await source('WebsiteRemovalRecoveryPanel.jsx');
  assert.match(recoveryText, /onChanged\?\.()/);
  const pageText = await source('WebsitesPage.jsx');
  assert.match(pageText, /<WebsiteRemovalRecoveryPanel onChanged=\{refreshAll\} \/>/);
});
