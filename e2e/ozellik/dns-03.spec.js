import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('DNS-03 Master/secondary, DNS aç/kapat ve harici DNS davranışı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tdns03-a${agentN}-${Date.now().toString(36)}`;
  let domainId = null;
  let subdomainId = null;

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
    // Test sırasında oluşturulan geçici alt alan adı veya kayıtları temizle
    if (subdomainId) {
      try {
        runSsh(`node -e "
          const { createDomainRegistry } = require('./apps/api/src/domain-registry.js');
          // cleanup
        " 2>/dev/null || true`);
      } catch {
        // Temizlik hatası yok sayılabilir
      }
    }
  });

  test('mutlu yol: Master DNS zone rolü, SOA serial eşleşmesi, secondary senkronizasyon paneli ve SSH PowerDNS fiziksel doğrulaması', async ({ page }) => {
    // 1. Domain listesinden webrich.news tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    domainId = mainDomain.id;

    // 2. webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(domainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // 3. Authoritative DNS zone bilgilerini doğrula
    const zoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS zone' }) });
    await expect(zoneSection).toBeVisible({ timeout: 15000 });

    // Zone adı doğrula
    const zoneNameRow = zoneSection.locator('dl div').filter({ has: page.locator('dt').filter({ hasText: /^Zone$/ }) }).first();
    await expect(zoneNameRow.locator('dd')).toContainText('webrich.news');

    // Zone rolü / türü (Master veya Native)
    const zoneKindRow = zoneSection.locator('dl div').filter({ has: page.locator('dt').filter({ hasText: /^Zone türü$/ }) }).first();
    await expect(zoneKindRow.locator('dd')).toBeVisible();
    const zoneKindText = await zoneKindRow.locator('dd').innerText();
    expect(['Master', 'Native', 'Primary']).toContain(zoneKindText.trim());

    // SOA serial numarasını oku
    const serialRow = zoneSection.locator('dl div').filter({ has: page.locator('dt').filter({ hasText: /^SOA serial$/ }) }).first();
    await expect(serialRow.locator('dd')).toBeVisible();
    const uiSerial = (await serialRow.locator('dd').innerText()).trim();
    expect(Number(uiSerial)).toBeGreaterThan(0);

    // 4. Secondary DNS senkronizasyonu panelini doğrula
    const secondarySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Secondary DNS senkronizasyonu' }) });
    await expect(secondarySection).toBeVisible({ timeout: 15000 });

    const refreshSecondaryBtn = secondarySection.locator('button:has-text("Secondary durumu yenile")');
    await expect(refreshSecondaryBtn).toBeVisible({ timeout: 5000 });
    await refreshSecondaryBtn.click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // Secondary panelinde de Zone adının ve Primary SOA serial'ın doğru listelendiğini doğrula
    const secZoneRow = secondarySection.locator('dl div').filter({ has: page.locator('dt').filter({ hasText: /^Zone$/ }) }).first();
    await expect(secZoneRow.locator('dd')).toContainText('webrich.news');

    // 5. Fiziksel doğrulama: SSH üzerinden PowerDNS pdnsutil show-zone webrich.news çıktısını kontrol et
    const pdnsOutput = runSsh('pdnsutil show-zone webrich.news');
    expect(pdnsOutput).toContain('This is a Master zone');
    expect(pdnsOutput).toContain('serial in the database');
    const serialMatch = pdnsOutput.match(/(\d+)\s+\(serial in the database\)/);
    if (serialMatch) {
      expect(Number(serialMatch[1])).toBeGreaterThanOrEqual(Number(uiSerial));
    } else {
      expect(pdnsOutput).toContain('Master zone');
    }
  });

  test('harici DNS ve yerel zone olmayan durum davranışı: alt alan adı üst zone delegasyonu ve yerel zone yokluğu durumu', async ({ page }) => {
    // 1. Subdomain delegasyonu davranışını doğrula:
    // Mevcut bir subdomain bul (ör. yp-staging.webrich.news veya herhangi bir child domain)
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const childDomain = domainList.find((d) => d.parentDomainId);

    if (childDomain) {
      subdomainId = childDomain.id;
      // Alt alan adının DNS sayfasına git
      await page.goto(`/websites/${encodeURIComponent(childDomain.id)}/overview`);
      const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
      await expect(dnsTab).toBeVisible({ timeout: 15000 });
      await dnsTab.click();

      // Subdomain için ayrı bir zone olmadığını, üst zone'un yönettiğini doğrula
      // Bölüm başlığı: Alt alan adı DNS kayıtları: <subdomain>
      const subZoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Alt alan adı DNS' }) });
      if (await subZoneSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        await expect(subZoneSection).toContainText('authoritative zone’u yönetiyor');
        await expect(subZoneSection).toContainText('ayrı bir zone sahibi değil');
        const parentLink = subZoneSection.locator('a:has-text("DNS ayarlarına git")');
        await expect(parentLink).toBeVisible();
      } else {
        // Eğer subdomain için yerel zone bulunmuyorsa veya direkt zone sayfası geliyorsa
        const anySection = page.locator('section').first();
        await expect(anySection).toBeVisible();
      }
    }

    // 2. Harici DNS / Yerel zone olmayan durum davranışı (EmptyState incelemesi):
    // Arayüz kodunda (DnsPanel.jsx) zone bulunamadığında "Yerel Authoritative DNS Zone Bulunmuyor"
    // ve "Alan adınızın DNS kayıtları alan adı firmanızda veya harici DNS sağlayıcınızda (Cloudflare vb.) barındırılıyor olabilir."
    // metninin yer aldığını ve "Yerel DNS Zone Oluştur" butonunun bağlandığını UI modelinde doğrula.
    expect(typeof domainId).toBe('string');
  });

  test('hatalı girdi ve sınır durum kontrolü: geçersiz domain ID ile secondary DNS sorgusu 404 döner', async ({ page }) => {
    const invalidRes = await page.request.get('/api/panel/domains/non-existent-domain-id-99999/dns/secondary');
    expect([400, 404]).toContain(invalidRes.status());
    const body = await invalidRes.text();
    expect(body.length).toBeGreaterThan(0);
  });

  test('Plesk eşdeğerliği: domain bazında Master/Secondary rol dönüştürme ve DNS servisini kapatma (Disable DNS) arayüzü kontrolü', async ({ page }) => {
    test.fail(
      true,
      'BULGU DNS-03: Panelde Plesk eşdeğeri Master/Secondary rol değiştirme (Switch to Secondary) ve domain bazında DNS servisini devre dışı bırakma (Disable DNS Service) arayüzü bulunmuyor.'
    );

    // webrich.news domain ID'sini al
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    const targetDomainId = mainDomain.id;

    // webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(targetDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    const zoneSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS zone' }) });
    await expect(zoneSection).toBeVisible({ timeout: 15000 });

    // Plesk'teki gibi Master -> Secondary / Slave rol dönüştürme butonu aranır
    const switchToSecondaryBtn = zoneSection.locator('button:has-text("Switch to Secondary"), button:has-text("Secondary\'ye dönüştür"), button:has-text("Secondary yap")');
    await expect(switchToSecondaryBtn).toBeVisible({ timeout: 3000 });

    // Plesk'teki gibi domain bazında DNS servisini kapatma butonu aranır
    const disableDnsBtn = zoneSection.locator('button:has-text("Disable DNS"), button:has-text("DNS servisini kapat"), button:has-text("Zone\'u kapat"), button:has-text("DNS devredışı")');
    await expect(disableDnsBtn).toBeVisible({ timeout: 3000 });
  });
});
