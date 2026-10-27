import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('DNS-01 Domain zone ve DNS kayıt CRUD; desteklenen RR türleri matrisi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tdns01-a${agentN}-${Date.now().toString(36)}`;
  let domainId = null;

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        const retryBtn = page.locator('button:has-text("Tekrar dene")');
        if (await retryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }
  });

  test.afterAll(async () => {
    // Test sırasında eklenen kayıtları fiziksel PowerDNS üzerinden güvence amaçlı temizle
    try {
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-a A 2>/dev/null || true`);
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-cname CNAME 2>/dev/null || true`);
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-txt TXT 2>/dev/null || true`);
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-mx MX 2>/dev/null || true`);
      runSsh(`pdnsutil delete-rrset webrich.news ${prefix}-err A 2>/dev/null || true`);
    } catch {
      // Temizlik hatası yok sayılabilir
    }
  });

  test('mutlu yol: DNS zone görüntüleme, desteklenen RR türleri matrisi ve A/CNAME/TXT/MX CRUD işlemleri ile yerel PowerDNS dig fiziksel doğrulaması', async ({ page }) => {
    // 1. Domain ID tespit et ve webrich.news DNS sekmesine git
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    domainId = mainDomain.id;

    // Arayüz üzerinden Web Siteleri listesine git ve webrich.news detayına gir
    await page.goto('/websites');
    await page.waitForLoadState('networkidle').catch(() => {});

    // webrich.news kartını bul ve yönet veya doğrudan detay sayfasına git
    const siteLink = page.locator(`a[href*="/websites/${encodeURIComponent(domainId)}"]`).first();
    if (await siteLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await siteLink.click();
    } else {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/overview`);
    }

    // DNS sekmesine geç
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // 2. Zone görüntüleme doğrulaması
    const zoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS zone' }) });
    await expect(zoneSection).toBeVisible({ timeout: 15000 });

    const dnsTable = zoneSection.locator('.dns-table');
    await expect(dnsTable).toBeVisible({ timeout: 15000 });

    await expect(zoneSection.locator('dt', { hasText: 'Zone' }).first()).toBeVisible();
    await expect(zoneSection.locator('dt', { hasText: 'SOA serial' })).toBeVisible();

    await expect(dnsTable.locator('th:has-text("Ad")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Tür")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("TTL")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Kaynak")')).toBeVisible();
    await expect(dnsTable.locator('th:has-text("Değer")')).toBeVisible();

    // 3. Desteklenen RR türleri matrisi doğrulaması
    const addBtn = page.locator('button:has-text("Manual kayıt ekle")');
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const recordDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydı ekle' });
    await expect(recordDialog).toBeVisible({ timeout: 5000 });

    const expectedTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'CAA', 'SRV', 'NS', 'SOA'];
    for (const rrType of expectedTypes) {
      const typeBtn = recordDialog.getByRole('button', { name: rrType, exact: true });
      await expect(typeBtn).toBeVisible();
    }

    // Dialogu kapatmadan önce ilk olarak A kaydı ekle
    const ownerInput = recordDialog.locator('label:has-text("Kayıt adı") input');
    const ttlInput = recordDialog.locator('label:has-text("TTL") input');
    const valInput = recordDialog.locator('label:has-text("Değerler") textarea');
    const submitBtn = recordDialog.locator('button:has-text("Kaydı ekle")');

    // 4. CRUD - CREATE A Kaydı
    await ownerInput.fill(`${prefix}-a`);
    await ttlInput.fill('300');
    await recordDialog.getByRole('button', { name: 'A', exact: true }).click();
    await valInput.fill('157.180.11.99');
    await submitBtn.click();
    await expect(recordDialog).not.toBeVisible({ timeout: 15000 });

    // Tabloda doğrula
    const rowA = dnsTable.locator('tr', { hasText: `${prefix}-a` });
    await expect(rowA).toBeVisible({ timeout: 15000 });
    await expect(rowA.locator('code:has-text("A")')).toBeVisible();
    await expect(rowA).toContainText('157.180.11.99');

    // 5. CRUD - CREATE CNAME Kaydı
    await addBtn.click();
    await expect(recordDialog).toBeVisible({ timeout: 5000 });
    await ownerInput.fill(`${prefix}-cname`);
    await ttlInput.fill('300');
    await recordDialog.getByRole('button', { name: 'CNAME', exact: true }).click();
    await valInput.fill('webrich.news');
    await submitBtn.click();
    await expect(recordDialog).not.toBeVisible({ timeout: 15000 });

    const rowCname = dnsTable.locator('tr', { hasText: `${prefix}-cname` });
    await expect(rowCname).toBeVisible({ timeout: 15000 });
    await expect(rowCname.locator('code:has-text("CNAME")')).toBeVisible();

    // 6. CRUD - CREATE TXT Kaydı
    await addBtn.click();
    await expect(recordDialog).toBeVisible({ timeout: 5000 });
    await ownerInput.fill(`${prefix}-txt`);
    await ttlInput.fill('300');
    await recordDialog.getByRole('button', { name: 'TXT', exact: true }).click();
    await valInput.fill('"v=spf1 ~all"');
    await submitBtn.click();
    await expect(recordDialog).not.toBeVisible({ timeout: 15000 });

    const rowTxt = dnsTable.locator('tr', { hasText: `${prefix}-txt` });
    await expect(rowTxt).toBeVisible({ timeout: 15000 });
    await expect(rowTxt.locator('code:has-text("TXT")')).toBeVisible();
    await expect(rowTxt).toContainText('v=spf1 ~all');

    // 7. CRUD - CREATE MX Kaydı
    await addBtn.click();
    await expect(recordDialog).toBeVisible({ timeout: 5000 });
    await ownerInput.fill(`${prefix}-mx`);
    await ttlInput.fill('300');
    await recordDialog.getByRole('button', { name: 'MX', exact: true }).click();
    await valInput.fill('10 mail.webrich.news');
    await submitBtn.click();
    await expect(recordDialog).not.toBeVisible({ timeout: 15000 });

    const rowMx = dnsTable.locator('tr', { hasText: `${prefix}-mx` });
    await expect(rowMx).toBeVisible({ timeout: 15000 });
    await expect(rowMx.locator('code:has-text("MX")')).toBeVisible();
    await expect(rowMx).toContainText('10 mail.webrich.news');

    // 8. CRUD - UPDATE A Kaydını Düzenleme
    const editBtn = rowA.locator('button:has-text("Düzenle")');
    await editBtn.click();

    const editDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını düzenle' });
    await expect(editDialog).toBeVisible({ timeout: 5000 });
    const editValInput = editDialog.locator('label:has-text("Değerler") textarea');
    await editValInput.fill('157.180.11.105');

    const updateBtn = editDialog.locator('button:has-text("Kaydı güncelle")');
    await updateBtn.click();
    await expect(editDialog).not.toBeVisible({ timeout: 15000 });

    // Tabloda güncellenen değer doğrulanır
    await expect(rowA).toContainText('157.180.11.105', { timeout: 10000 });

    // 9. Fiziksel Sonuç (Physical Evidence): Yerel PowerDNS üzerinden dig ve pdnsutil sorguları
    const digA = runSsh(`dig @127.0.0.1 ${prefix}-a.webrich.news A +short`).trim();
    expect(digA).toBe('157.180.11.105');

    const digTxt = runSsh(`dig @127.0.0.1 ${prefix}-txt.webrich.news TXT +short`).trim();
    expect(digTxt).toContain('v=spf1 ~all');

    const digCname = runSsh(`dig @127.0.0.1 ${prefix}-cname.webrich.news CNAME +short`).trim();
    expect(digCname).toBe('webrich.news.');

    const digMx = runSsh(`dig @127.0.0.1 ${prefix}-mx.webrich.news MX +short`).trim();
    expect(digMx).toContain('mail.webrich.news.');

    // 10. CRUD - DELETE Kayıtları Silme
    const recordsToDelete = [
      { row: rowA, name: `${prefix}-a` },
      { row: rowCname, name: `${prefix}-cname` },
      { row: rowTxt, name: `${prefix}-txt` },
      { row: rowMx, name: `${prefix}-mx` },
    ];

    for (const rec of recordsToDelete) {
      const deleteBtn = rec.row.locator('button:has-text("Sil")');
      await deleteBtn.click();

      const confirmDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydını sil' });
      await expect(confirmDialog).toBeVisible({ timeout: 5000 });

      const confirmCode = await confirmDialog.locator('label strong').textContent();
      expect(confirmCode).toContain('delete-dns:');

      await confirmDialog.locator('label input').fill(confirmCode.trim());
      const confirmDeleteBtn = confirmDialog.locator('button:has-text("Kaydı sil")');
      await expect(confirmDeleteBtn).toBeEnabled();
      await confirmDeleteBtn.click();

      await expect(confirmDialog).not.toBeVisible({ timeout: 15000 });
      await expect(dnsTable.locator('tr', { hasText: rec.name })).not.toBeVisible({ timeout: 10000 });
    }

    // Fiziksel Sonuç: Silinen kaydın DNS cevabının boş dönmesi
    const digAfterDelete = runSsh(`dig @127.0.0.1 ${prefix}-a.webrich.news A +short`).trim();
    expect(digAfterDelete).toBe('');
  });

  test('hatalı girdi: geçersiz IP formatı girildiğinde form hata verir, kayıt oluşturulmaz ve DNS sunucusunda yansımaz', async ({ page }) => {
    // Sitenin DNS sekmesine doğrudan git
    await page.goto(`/websites/${encodeURIComponent(domainId)}/dns`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const addBtn = page.locator('button:has-text("Manual kayıt ekle")');
    await expect(addBtn).toBeVisible({ timeout: 15000 });
    await addBtn.click();

    const recordDialog = page.locator('.ws-modal', { hasText: 'Manual DNS kaydı ekle' });
    await expect(recordDialog).toBeVisible({ timeout: 5000 });

    const ownerInput = recordDialog.locator('label:has-text("Kayıt adı") input');
    const ttlInput = recordDialog.locator('label:has-text("TTL") input');
    const valInput = recordDialog.locator('label:has-text("Değerler") textarea');
    const submitBtn = recordDialog.locator('button:has-text("Kaydı ekle")');

    // Geçersiz IPv4 adresi gir
    await ownerInput.fill(`${prefix}-err`);
    await ttlInput.fill('300');
    await recordDialog.getByRole('button', { name: 'A', exact: true }).click();
    await valInput.fill('999.999.999.999');

    await submitBtn.click();

    // Modal kapanmamalı ve hata bildirimi görünmeli
    const errorNotice = recordDialog.locator('.ws-notice-error, p[role="alert"], [class*="error"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(recordDialog).toContainText(/invalid/i);

    // Modal vazgeç butonu ile kapatılır
    const cancelBtn = recordDialog.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(recordDialog).not.toBeVisible({ timeout: 5000 });

    // Tabloda bu hatalı kaydın oluşmadığı doğrulanır
    const dnsTable = page.locator('.dns-table');
    await expect(dnsTable.locator('tr', { hasText: `${prefix}-err` })).not.toBeVisible({ timeout: 5000 });

    // Fiziksel Sonuç: PowerDNS üzerinde sorgulandığında boş dönmelidir
    const digErr = runSsh(`dig @127.0.0.1 ${prefix}-err.webrich.news A +short`).trim();
    expect(digErr).toBe('');
  });
});
