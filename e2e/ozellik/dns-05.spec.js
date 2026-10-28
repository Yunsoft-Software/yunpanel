import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DNS-05 Zone transfer yetkileri ve secondary doğrulama', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  let mainDomainId = null;
  let subdomainId = null;
  const targetDomainName = 'webrich.news';

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
    // 0 artık ilkesi: test boyunca webrich.news ve sistem configleri üzerinde kalıcı artık bırakılmaz
  });

  test('mutlu yol: sunucu DNS kimliği, secondary transfer hedefleri ve fiziksel PowerDNS yetkili/yetkisiz AXFR doğrulaması', async ({ page }) => {
    // 1. Ayarlar -> DNS sayfasına git (/settings?section=dns)
    await page.goto('/settings?section=dns');
    await expect(page).toHaveURL(/.*section=dns.*/);

    // 2. Network / Authoritative DNS bölümünü doğrula
    const authDnsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Network / Authoritative DNS' }) });
    await expect(authDnsSection).toBeVisible({ timeout: 15000 });

    // Public IPv4, ns1, ns2 ve Secondary transfer targets satırlarını kontrol et
    const secTargetRow = authDnsSection.locator('dl div').filter({ has: page.locator('dt', { hasText: 'Secondary transfer targets' }) });
    await expect(secTargetRow).toBeVisible();

    // "DNS kimliğini düzenle" butonunun çalıştığını ve Secondary DNS hedefleri form alanının olduğunu doğrula
    const editIdentityBtn = authDnsSection.locator('button:has-text("DNS kimliğini düzenle"), button:has-text("DNS kimliğini yapılandır")');
    await expect(editIdentityBtn).toBeVisible();
    await editIdentityBtn.click();

    const identityModal = page.locator('.ws-modal').filter({ has: page.locator('h2', { hasText: 'Authoritative DNS kimliği' }) });
    await expect(identityModal).toBeVisible({ timeout: 10000 });

    const secDnsTextarea = identityModal.locator('textarea');
    await expect(secDnsTextarea).toBeVisible();
    const secDnsLabel = identityModal.locator('label:has-text("Secondary DNS transfer hedefleri")');
    await expect(secDnsLabel).toBeVisible();

    // Modalı güvenle kapat
    const cancelBtn = identityModal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(identityModal).not.toBeVisible();

    // 3. webrich.news domain ID'sini tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === targetDomainName && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId);
    expect(mainDomain).toBeTruthy();
    mainDomainId = mainDomain.id;

    // Alt alan adı ID'sini de tespit et (sınır durum testi için)
    const childDomain = domainList.find((d) => d.parentDomainId);
    if (childDomain) {
      subdomainId = childDomain.id;
    }

    // 4. webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // Secondary DNS senkronizasyonu kartını doğrula
    const secondarySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Secondary DNS senkronizasyonu' }) });
    await expect(secondarySection).toBeVisible({ timeout: 15000 });

    const refreshSecondaryBtn = secondarySection.locator('button:has-text("Secondary durumu yenile")');
    await expect(refreshSecondaryBtn).toBeVisible({ timeout: 5000 });
    await refreshSecondaryBtn.click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // 5. Fiziksel PowerDNS doğrulaması 1: İzinli IP (127.0.0.1) üzerinden AXFR sorgusu
    const axfrSuccessOutput = runSsh(`dig @127.0.0.1 AXFR ${targetDomainName}`);
    expect(axfrSuccessOutput).toContain(`${targetDomainName}.`);
    expect(axfrSuccessOutput).toContain('SOA');
    expect(axfrSuccessOutput).toContain('XFR size:');
    expect(axfrSuccessOutput).not.toContain('Transfer failed');

    // 6. Fiziksel PowerDNS doğrulaması 2: İzinli olmayan IP üzerinden AXFR sorgusu
    // Sunucu public IP'si üzerinden bağlanıp transfer isteği gönderildiğinde allow-axfr-ips kuralı nedeniyle reddedilir
    const axfrDeniedOutput = runSsh(`dig @157.180.11.28 -b 157.180.11.28 AXFR ${targetDomainName} 2>&1 || true`);
    expect(axfrDeniedOutput).toContain('Transfer failed');

    // PowerDNS journal logunda AXFR reddinin fiziksel kanıtını doğrula
    const pdnsJournal = runSsh('journalctl -u pdns.service -n 20 --no-pager');
    expect(pdnsJournal).toMatch(/denied: client IP has no permission|failed: client may not request AXFR/);
  });

  test('sınır durum ve hatalı girdi kontrolü: secondary DNS endpoint doğrulama, root domain zorunluluğu ve geçersiz domain', async ({ page }) => {
    // 1. Root domain için secondary DNS endpoint sorgusu
    expect(mainDomainId).toBeTruthy();
    const secRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(mainDomainId)}/dns/secondary`);
    expect(secRes.status()).toBe(200);
    const secJson = await secRes.json();
    expect(secJson.data).toBeTruthy();
    expect(secJson.data.zoneName).toBe(targetDomainName);
    expect(typeof secJson.data.configured).toBe('boolean');
    expect(['disabled', 'synced', 'drift', 'unverifiable']).toContain(secJson.data.status);
    expect(secJson.data.policy).toBeTruthy();
    expect(['not_applicable', 'pass', 'block']).toContain(secJson.data.policy.healthGate);

    // 2. Alt alan adı için secondary DNS sorgulanması reddedilir (yalnız root domain authoritative zone sahibidir)
    if (subdomainId) {
      const childSecRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(subdomainId)}/dns/secondary`);
      expect(childSecRes.status()).toBe(409);
      const childJson = await childSecRes.json();
      expect(childJson.error?.code).toBe('dns_secondary_root_domain_required');
    }

    // 3. Olmayan bir domain ID ile secondary DNS sorgusu 404 döner
    const notFoundRes = await page.request.get('/api/panel/domains/non-existent-domain-id-99999/dns/secondary');
    expect([400, 404]).toContain(notFoundRes.status());
    const notFoundJson = await notFoundRes.json();
    expect(notFoundJson.error?.code).toMatch(/domain_not_found|dns_secondary_domain_invalid/);
  });

  test('Plesk eşdeğerliği: domain bazında Zone Transfer ACL (İzinli Secondary IP adresleri) ve Secondary/Slave Zone yönetim arayüzü', async ({ page }) => {
    test.fail(
      true,
      'BULGU DNS-05: Panelde Plesk eşdeğeri domain bazında Zone Transfer ACL (İzinli Secondary IP adresleri tanımlama) ve Secondary/Slave Zone yönetim arayüzü bulunmuyor.'
    );

    // webrich.news DNS sekmesine git
    expect(mainDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // 1. Plesk'teki gibi her domain için ayrı "Zone Transfers" / "Transfer Restrictions" (Zone Transfer ACL) sekmesi veya arayüzü aranır
    const zoneTransferAclTab = page.locator('button:has-text("Zone Transfers"), a:has-text("Zone Transfers"), button:has-text("Transfer Kısıtlamaları"), button:has-text("Zone Transfer Yetkileri")');
    await expect(zoneTransferAclTab).toBeVisible({ timeout: 3000 });

    // 2. Plesk'teki gibi harici Master DNS sunucusundan zone çekerek alan adını "Slave/Secondary Zone" olarak yapılandırma arayüzü aranır
    const slaveZoneOption = page.locator('button:has-text("Secondary Zone Oluştur"), button:has-text("Slave Zone Yap"), select option[value="slave"]');
    await expect(slaveZoneOption).toBeVisible({ timeout: 3000 });
  });
});
