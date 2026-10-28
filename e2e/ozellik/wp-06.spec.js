import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WP-06 WordPress güvenlik denetimi, sıkılaştırma ve zafiyet görünürlüğü', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const targetDomainName = 'yp-wp.webrich.news';
  const targetWebsiteId = 'af2e0dfc-2e63-5bdb-b6f2-68bee01bafa7';
  let csrfToken = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
  }

  function apiHeaders() {
    return {
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
      origin: 'https://server.cryptoraichu.website',
    };
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
    const sessionRes = await page.request.get('/api/auth/session');
    const sessionJson = await sessionRes.json().catch(() => null);
    csrfToken = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
  });

  test.afterAll(async () => {
    // 0 artık ilkesi: test salt-okunur ve güvenlik durumu denetimi amaçlı çalışmıştır;
    // canlı sunucu ve veri tabanında hiçbir artık bırakılmamıştır.
  });

  test('mutlu yol: WordPress kurulum tespiti, yönetim paneli ve wp-config.php güvenlik anahtarlarının fiziksel doğrulanması', async ({ page }) => {
    // 1. Web Siteleri arayüzünde WordPress kurulu hedef sitenin varlığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(targetDomainName)}`);
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });
    const siteCard = page.locator('article').filter({ hasText: targetDomainName }).first();
    await expect(siteCard).toBeVisible({ timeout: 10000 });

    // 2. Hedef sitenin detay sayfasına ve WordPress sekmesine git
    await page.goto(`/websites/${encodeURIComponent(targetDomainName)}/wordpress`);
    await expect(page.locator('section').filter({ hasText: /Eklentiler|WordPress|WP-CLI/ }).first()).toBeVisible({ timeout: 20000 });

    // 3. Gerçek API üzerinden tekil site WordPress durumunu sorgula
    const apiRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/wordpress`);
    expect(apiRes.status()).toBe(200);
    const json = await apiRes.json();
    expect(json).toHaveProperty('data');
    expect(json.data.installed).toBe(true);
    expect(json.data.primaryDomain).toBe(targetDomainName);
    expect(Array.isArray(json.data.plugins)).toBe(true);

    // 4. Fiziksel kanıt 1: Sunucuda wp-config.php dosyasının varlığı, izinleri ve temel güvenlik tuzları (salts)
    const wpConfigFileCheck = runSsh('test -f /var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public/wp-config.php && echo "WP_CONFIG_OK"');
    expect(wpConfigFileCheck).toBe('WP_CONFIG_OK');

    const wpConfigPerms = runSsh('stat -c "%a" /var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public/wp-config.php');
    expect(wpConfigPerms).toBe('640');

    const authKeyPresent = runSsh('grep -q "AUTH_KEY" /var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public/wp-config.php && echo "AUTH_KEY_EXISTS"');
    expect(authKeyPresent).toBe('AUTH_KEY_EXISTS');

    // 5. Fiziksel kanıt 2: non-reseller-capabilities envanterinde WP-06 yeteneğinin tanımını doğrula
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("WP-06");
        console.log(JSON.stringify({ id: c.id, title: c.title, status: c.status }));
      });
    '`);
    expect(capOutput).toContain('"id":"WP-06"');
    expect(capOutput).toContain('Güvenlik denetimi ve sıkılaştırma');
  });

  test('hatalı girdi: geçersiz güvenlik eylemleri ve hatalı payload gönderimi 400 validation ile reddedilir', async ({ page }) => {
    // 1. Desteklenmeyen security.scan eylemi gönderildiğinde 400 wordpress_action_invalid dönmeli
    const scanRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'security.scan',
        },
      },
    });
    expect(scanRes.status()).toBe(400);
    const scanJson = await scanRes.json();
    expect(scanJson.error?.code).toBe('wordpress_action_invalid');

    // 2. Desteklenmeyen security.harden eylemi gönderildiğinde 400 wordpress_action_invalid dönmeli
    const hardenRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'security.harden',
        },
      },
    });
    expect(hardenRes.status()).toBe(400);
    const hardenJson = await hardenRes.json();
    expect(hardenJson.error?.code).toBe('wordpress_action_invalid');

    // 3. Boş options nesnesi gönderildiğinde 400 wordpress_action_invalid dönmeli
    const emptyRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {},
      },
    });
    expect(emptyRes.status()).toBe(400);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.error?.code).toBe('wordpress_action_invalid');
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit Güvenlik Durumu (Security Status) ve Sıkılaştırma (Hardening) arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-06: Plesk WP Toolkit Güvenlik Durumu (Security Status) ve Sıkılaştırma (Check Security / Apply Measures) arayüzü YunPanel üzerinde bulunmuyor.');

    // Plesk WP Toolkit arayüzünde her WordPress örneği için "Security Status" (Güvenlik Durumu)
    // rozeti, "Check Security" düğmesi ve "Apply Security Measures" sıkılaştırma önlemleri sunulur.
    await page.goto(`/websites/${encodeURIComponent(targetDomainName)}/wordpress`);

    // YunPanel SiteWordPressPanel bileşeninde Güvenlik Denetimi veya Sıkılaştırma butonu/bölümü aranır
    const securitySection = page.locator('button:has-text("Güvenlik"), button:has-text("Sıkılaştırma"), button:has-text("Check Security"), [data-testid="wp-security"]');
    await expect(securitySection.first()).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit Zafiyet Taraması (Vulnerability Scanner) ve /api/panel/websites/:id/wordpress/security uç noktası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-06: Plesk WP Toolkit Zafiyet Taraması (Vulnerability Scanner / CVE Reporting) ve /api/panel/websites/:id/wordpress/security uç noktası bulunmuyor (HTTP 404).');

    // Plesk WP Toolkit'te eklenti/tema ve çekirdek için bilinen güvenlik açıkları (CVE) listelenir.
    // non-reseller-capabilities.js içinde WP-06 için belirtilen rotanın varlığı sınanır:
    const securityApiRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/wordpress/security`);

    // Uç nokta mevcut olmalı (200 OK) ve zafiyet listesi / güvenlik durumunu döndürmelidir:
    expect(securityApiRes.status()).toBe(200);
    const json = await securityApiRes.json();
    expect(json.data).toHaveProperty('vulnerabilities');
  });
});
