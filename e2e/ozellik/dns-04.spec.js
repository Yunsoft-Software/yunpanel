import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DNS-04 DNSSEC anahtar/DS/rollover ve güvenli kapatma', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  let mainDomainId = null;
  let subdomainId = null;
  let csrfToken = '';
  const targetDomainName = 'webrich.news';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  function apiHeaders(origin = 'https://server.cryptoraichu.website') {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: origin,
      Referer: `${origin}/`,
    };
  }

  test.beforeAll(async () => {
    // Test öncesi temiz başlangıç durumu: DNSSEC operasyon kaydı sıfırlanır ve zone unsecured duruma getirilir
    try {
      runSsh(`echo '{"version":1,"operations":[]}' > /var/lib/yunpanel/control-plane/dnssec-operations.json 2>/dev/null || true; pdnsutil disable-dnssec ${targetDomainName} 2>/dev/null || true; systemctl restart yunpanel-api.service 2>/dev/null || true`);
    } catch {
      // yok sayılabilir
    }
  });

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

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  test.afterAll(async () => {
    // 0 artık ilkesi: webrich.news üzerinde DNSSEC açık kalmışsa güvenli şekilde kapat
    try {
      runSsh(`pdnsutil disable-dnssec ${targetDomainName} 2>/dev/null || true; echo '{"version":1,"operations":[]}' > /var/lib/yunpanel/control-plane/dnssec-operations.json 2>/dev/null || true; systemctl restart yunpanel-api.service 2>/dev/null || true`);
    } catch {
      // Temizlik hatası yok sayılabilir
    }
  });

  test('mutlu yol: DNSSEC imzalama, KSK/ZSK anahtar üretimi, DS kayıtlarının görüntülenmesi, fiziksel PowerDNS/DNSKEY doğrulaması ve güvenli kapatma (Unsign zone)', async ({ page }) => {
    // 1. webrich.news domain ID'sini tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === targetDomainName && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId);
    expect(mainDomain).toBeTruthy();
    mainDomainId = mainDomain.id;

    // 2. webrich.news DNS sekmesine git
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // 3. DNSSEC kartını doğrula
    const dnssecSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNSSEC' }) });
    await expect(dnssecSection).toBeVisible({ timeout: 15000 });

    const signingRow = dnssecSection.locator('dl div').filter({ has: page.locator('dt', { hasText: 'Local signing' }) });
    await expect(signingRow.locator('dd')).toBeVisible({ timeout: 10000 });

    // Başlangıçta "DNSSEC’i aç" butonunun hazır olduğunu doğrula
    const enableBtn = dnssecSection.locator('button:has-text("DNSSEC’i aç")');
    await expect(enableBtn).toBeVisible({ timeout: 15000 });

    // 4. DNSSEC'i Aç (Signing & Key Generation)
    await enableBtn.click();

    // Onay modalını doğrula ve onayla
    const enableModal = page.locator('dialog.ws-modal').filter({ hasText: 'DNSSEC signing aç' });
    await expect(enableModal).toBeVisible({ timeout: 10000 });
    const enableConfirmCode = await enableModal.locator('label strong').innerText();
    expect(enableConfirmCode).toContain('enable-dnssec');
    await enableModal.locator('input').fill(enableConfirmCode.trim());
    await enableModal.locator('button[type="submit"]:has-text("DNSSEC’i aç")').click();
    await expect(enableModal).toBeHidden({ timeout: 25000 });

    // 5. DNSSEC aktif durumunu arayüzde doğrula
    await expect(signingRow.locator('dd')).toContainText('Açık', { timeout: 25000 });

    // Signing key sayısı doğrulaması
    const keysRow = dnssecSection.locator('dl div').filter({ has: page.locator('dt', { hasText: 'Signing key' }) });
    await expect(keysRow.locator('dd')).toBeVisible();
    const keyCountText = (await keysRow.locator('dd').innerText()).trim();
    expect(Number(keyCountText)).toBeGreaterThan(0);

    // DS (Delegation Signer) kutusu doğrulaması
    const dsBox = dnssecSection.locator('.dns-ds-box').filter({ hasText: 'Registrar’a girilecek DS' });
    await expect(dsBox).toBeVisible({ timeout: 15000 });
    const dsRecordCode = dsBox.locator('code').first();
    await expect(dsRecordCode).toBeVisible();
    const dsRecordText = (await dsRecordCode.innerText()).trim();
    // Registrar DS formatı: <Key Tag> <Algorithm> <Digest Type> <Digest>
    expect(dsRecordText).toMatch(/^\d+\s+\d+\s+\d+\s+[A-Fa-f0-9]+$/);

    // 6. Fiziksel PowerDNS doğrulaması (SSH üzerinden pdnsutil ve dig)
    const pdnsShowZone = runSsh(`pdnsutil show-zone ${targetDomainName}`);
    expect(pdnsShowZone).toMatch(/Zone has NSEC|Zone is actively secured/);
    expect(pdnsShowZone).toMatch(/ID = \d+.*(CSK|KSK|ZSK)/);

    // dig ile yerel PowerDNS'ten DNSKEY sorgusu
    const digDnskey = runSsh(`dig @127.0.0.1 DNSKEY ${targetDomainName} +noall +answer`);
    expect(digDnskey).toContain('DNSKEY');

    // 7. DNS işlemleri (Operations) panelinde DNSSEC enable kaydı doğrulaması
    const opsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNS işlemleri' }) });
    await expect(opsSection).toBeVisible({ timeout: 10000 });
    const enableOp = opsSection.locator('.dns-operation-list article').filter({ hasText: 'DNSSEC enable' }).first();
    await expect(enableOp).toBeVisible({ timeout: 10000 });

    // 8. DNSSEC'i Güvenli Kapat (Unsign zone)
    const disableBtn = dnssecSection.locator('button:has-text("DNSSEC’i kapat")');
    await expect(disableBtn).toBeVisible({ timeout: 10000 });
    await disableBtn.click();

    // Onay modalını doğrula ve onayla
    const disableModal = page.locator('dialog.ws-modal').filter({ hasText: 'DNSSEC signing kapat' });
    await expect(disableModal).toBeVisible({ timeout: 10000 });
    const disableConfirmCode = await disableModal.locator('label strong').innerText();
    expect(disableConfirmCode).toContain('disable-dnssec');
    await disableModal.locator('input').fill(disableConfirmCode.trim());
    await disableModal.locator('button[type="submit"]:has-text("DNSSEC’i kapat")').click();
    await expect(disableModal).toBeHidden({ timeout: 25000 });

    // 9. DNSSEC kapalı durumunu arayüzde doğrula
    await expect(signingRow.locator('dd')).toContainText('Kapalı', { timeout: 25000 });
    const badge = dnssecSection.locator('.ws-badge');
    await expect(badge).toContainText('DNSSEC kapalı');

    // 10. Fiziksel PowerDNS doğrulaması (Unsigned zone)
    const pdnsShowZoneAfter = runSsh(`pdnsutil show-zone ${targetDomainName}`);
    expect(pdnsShowZoneAfter).toContain('Zone is not actively secured');
    expect(pdnsShowZoneAfter).not.toContain('keys:');

    // DNS işlemleri panelinde DNSSEC disable kaydı doğrulaması
    const disableOp = opsSection.locator('.dns-operation-list article').filter({ hasText: 'DNSSEC disable' }).first();
    await expect(disableOp).toBeVisible({ timeout: 10000 });
  });

  test('hatalı girdi / kısıtlama: Alt alan adlarında (Subdomain) bağımsız DNSSEC paneli sunulmaz ve API seviyesinde 409 reddedilir', async ({ page }) => {
    // 1. Alt alan adı tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const subDomain = domainList.find((d) => d.parentDomainId && d.primaryDomain.endsWith(`.${targetDomainName}`));
    expect(subDomain).toBeTruthy();
    subdomainId = subDomain.id;

    // 2. Alt alan adı DNS sayfasına git
    await page.goto(`/websites/${encodeURIComponent(subdomainId)}/dns`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // 3. DNSSEC kartı alt alan adında kesinlikle bulunmamalıdır (alt alan adlarında DNSSEC bağımsız yönetilmez)
    const dnssecSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNSSEC' }) });
    await expect(dnssecSection).toHaveCount(0);

    // 4. API seviyesinde doğrudan alt alan adına DNSSEC preview çağrısı yapıldığında 409 reddedilir
    const previewRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(subdomainId)}/dns/dnssec/preview`, {
      headers: apiHeaders(),
      data: { enabled: true },
    });
    expect(previewRes.status()).toBe(409);
    const previewJson = await previewRes.json();
    expect(previewJson.error?.code || previewJson.code).toBe('dnssec_root_domain_required');
  });

  test('Plesk eşdeğeri anahtar yenileme (Key Rollover): UI üzerinden KSK/ZSK rollover başlatma yeteneği kontrolü', async ({ page }) => {
    test.fail(true, 'BULGU DNS-04: Panel arayüzünde Plesk eşdeğeri DNSSEC anahtar rollover (Key Rollover) butonu ve iş akışı eksik');

    // 1. webrich.news DNS sekmesine git
    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === targetDomainName && !d.parentDomainId);
    expect(mainDomain).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(mainDomain.id)}/overview`);
    const dnsTab = page.locator('nav[aria-label="Site araçları"] a:has-text("DNS"), a[href$="/dns"]').first();
    await expect(dnsTab).toBeVisible({ timeout: 15000 });
    await dnsTab.click();

    // 2. DNSSEC kartında Plesk eşdeğeri Rollover butonunun varlığı beklenir
    const dnssecSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNSSEC' }) });
    await expect(dnssecSection).toBeVisible({ timeout: 15000 });

    const rolloverBtn = dnssecSection.locator('button:has-text("Rollover"), button:has-text("Anahtar yenile"), button:has-text("Roll Over Keys")');
    // Plesk'te DNSSEC uzantısında "Roll Over Keys" veya "Rollover" butonu mevcuttur.
    // YunPanel backend'inde API rotaları (/dnssec/rollover/*) bulunsa da arayüzde henüz sunulmamaktadır.
    await expect(rolloverBtn).toBeVisible({ timeout: 5000 });
  });
});
