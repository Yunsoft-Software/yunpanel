import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-05 Laravel environment, Artisan, Composer ve Node komutları', () => {
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tdev05-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.157.180.11.28.sslip.io`;

  let createdDomainId = null;
  let createdWebsiteId = null;
  let csrfToken = '';

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function checkHttp(host, path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: { Host: host },
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });
      req.end();
    });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 7000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible().catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 40000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('DEV-05 cleanup notice:', err.message);
    }
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
    const sessionRes = await page.request.get('/api/panel/session');
    const sessionJson = await sessionRes.json().catch(() => ({}));
    csrfToken = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('DEV-05 afterAll cleanup notice:', err.message);
    } finally {
      await page.close().catch(() => {});
    }

    // Fiziksel temizlik kontrolü (0 artık ilkesi)
    runSsh(`rm -f /etc/nginx/sites-enabled/*${siteDomain}* /etc/nginx/sites-available/*${siteDomain}* 2>/dev/null; systemctl reload nginx 2>/dev/null || true`);
  });

  test('mutlu yol: PHP sitesi oluştur, Composer araçlarını incele, composer/status ve site dosyaları/yapısını doğrula', async ({ page }) => {
    // 1. Yeni Web Sitesi Sihirbazı
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    if (await wwwSelect.isVisible()) {
      await wwwSelect.selectOption('none');
    }

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: PHP barındırma türü seçimi
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_php');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: DNS, HTTPS ve Posta ayarları
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const dnsSelect = page.locator('label:has-text("DNS yönetimi") select');
    if (await dnsSelect.isVisible()) {
      await dnsSelect.selectOption('external');
    }

    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    if (await httpsSelect.isVisible()) {
      await httpsSelect.selectOption('off');
    }

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum adımlarının tamamlanmasını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    await expect(resultElement.locator('.ws-spinner')).toHaveCount(0, { timeout: 120000 });
    const overviewLink = resultElement.locator('a:has-text("Site genel bakışı")');
    await expect(overviewLink).toBeVisible({ timeout: 30000 });

    const href = await overviewLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Detay genel bakış sayfasına git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 20000 });

    // PHP Ayarları sekmesine git ve Composer bölümünü aç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h1, h2', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 20000 });

    const composerDetails = page.locator('details').filter({ hasText: 'Composer ve bağımlılıklar' });
    await expect(composerDetails).toBeVisible({ timeout: 15000 });
    await composerDetails.locator('summary').click();

    const composerHeading = composerDetails.locator('h2, h3', { hasText: 'Composer' });
    await expect(composerHeading.first()).toBeVisible({ timeout: 20000 });

    // Composer açıklama metni ve ilişkili araç linklerini doğrula
    await expect(composerDetails.locator('text=PHP bağımlılıkları ve autoload dosyaları')).toBeVisible({ timeout: 10000 });
    await expect(composerDetails.locator('a:has-text("Dosya Yöneticisi")')).toBeVisible({ timeout: 10000 });
    await expect(composerDetails.locator('a:has-text("Site terminali")')).toBeVisible({ timeout: 10000 });

    // Durumu kontrol et butonu
    const checkStatusBtn = composerDetails.locator('button:has-text("Durumu kontrol et")');
    await expect(checkStatusBtn).toBeVisible({ timeout: 10000 });

    // Composer detay tablosu (composer.json, composer.lock, Proje konumu, Proje doğrulaması)
    await expect(composerDetails.locator('dt:has-text("composer.json")')).toBeVisible({ timeout: 15000 });
    await expect(composerDetails.locator('dt:has-text("composer.lock")')).toBeVisible({ timeout: 15000 });
    await expect(composerDetails.locator('dt:has-text("Proje konumu")')).toBeVisible({ timeout: 15000 });
    await expect(composerDetails.locator('dt:has-text("Proje doğrulaması")')).toBeVisible({ timeout: 15000 });

    // Websites listesinden ilgili websiteId'yi edin
    const sitesApiRes = await page.request.get('/api/panel/websites');
    expect(sitesApiRes.ok()).toBe(true);
    const sitesJson = await sitesApiRes.json();
    const sitesList = Array.isArray(sitesJson.data) ? sitesJson.data : (sitesJson.data?.websites || sitesJson.websites || []);
    const currentSite = sitesList.find((w) => w.name === siteDomain || w.primaryDomain === siteDomain);
    expect(currentSite).toBeTruthy();
    createdWebsiteId = currentSite.id;
    expect(createdWebsiteId).toBeTruthy();

    // API seviyesinde Composer durumu endpoint'i doğrula
    const statusApiRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/composer/status`);
    expect(statusApiRes.status()).toBe(200);
    const statusJson = await statusApiRes.json();
    const compStatus = statusJson.composer || statusJson.status || statusJson;
    expect(typeof compStatus.available).toBe('boolean');

    // Fiziksel Kontrol 1: Canlı HTTP yanıtı
    let httpOk = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const httpRes = await checkHttp(siteDomain, '/');
        if ([200, 403, 404].includes(httpRes.status)) {
          httpOk = true;
          break;
        }
      } catch {
        // Yeniden dene
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(httpOk).toBe(true);

    // Fiziksel Kontrol 2: SSH ile Nginx konfigürasyonu ve PHP-FPM soketi
    const nginxConf = runSsh(`cat /etc/nginx/sites-enabled/*${siteDomain}* 2>/dev/null`);
    expect(nginxConf.length).toBeGreaterThan(0);
    expect(nginxConf).toContain(siteDomain);
    expect(nginxConf).toMatch(/fastcgi_pass\s+unix:/);

    // Fiziksel Kontrol 3: SSH ile site dizini varlığı
    const siteDirCheck = runSsh(`ls -la /var/lib/yunpanel/sites/*${siteDomain}* 2>/dev/null || ls -la /var/lib/yunpanel/apps/*/releases 2>/dev/null`);
    expect(siteDirCheck.length).toBeGreaterThan(0);
  });

  test('hatalı girdi / güvenlik: Geçersiz veya desteklenmeyen PHP tool / Composer aksiyonu backend tarafından 400 ile engellenir', async ({ page }) => {
    expect(createdWebsiteId).toBeTruthy();

    const result = await page.evaluate(async (websiteId) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken || session.csrfToken;
      const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

      // 1. Desteklenmeyen bir actionId gönderildiğinde backend 400 döner
      const res1 = await fetch(`/api/panel/websites/${encodeURIComponent(websiteId)}/php-tools/actions/preview`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ actionId: 'artisan.migrate' }),
      });
      const data1 = await res1.json().catch(() => ({}));

      // 2. Eksik veya geçersiz gövde ile queue isteği 400/409 döner
      const res2 = await fetch(`/api/panel/websites/${encodeURIComponent(websiteId)}/php-tools/actions/queue`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ actionId: 'composer.dump-autoload', expectedWebsiteRevision: 'invalid' }),
      });
      const data2 = await res2.json().catch(() => ({}));

      return {
        status1: res1.status,
        code1: data1?.error?.code,
        status2: res2.status,
      };
    }, createdWebsiteId);

    expect(result.status1).toBe(400);
    expect(result.code1).toBe('php_tool_action_unsupported');
    expect([400, 409]).toContain(result.status2);
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri Environment (.env) editörü ve ortam değişkenleri yönetimi bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-05-A: Plesk Laravel Toolkit eşdeğeri .env environment dosyası ve ortam değişkenleri yönetimi (Environment Editor) arayüzü bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan ".env" / "Environment" veya "Ortam Değişkenleri" sekmesi/editörü aranır
    const envTabOrEditor = page.locator('a:has-text("Environment"), a:has-text(".env"), button:has-text(".env Düzenle"), text=/Environment Variables/i');
    await expect(envTabOrEditor.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri arayüzden Artisan komutları çalıştırma (Run Artisan Command) aracı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-05-B: Plesk Laravel Toolkit uzantısında yer alan arayüzden Artisan komutları koşturma (php artisan migrate, config:cache vb.) aracı bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h1, h2', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    // Plesk Laravel Toolkit'te yer alan "Artisan" komut koşturucu butonu aranır
    const artisanCommandRunner = page.locator('button:has-text("Artisan"), button:has-text("Run Artisan"), a:has-text("Artisan Komutları"), text=/Artisan CLI/i');
    await expect(artisanCommandRunner.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel / PHP eşdeğeri serbest Composer bağımlılık yönetimi (install, update, require) ve Node/npm komutları arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-05-C: Plesk Laravel Toolkit eşdeğeri serbest Composer komutları (composer install/update/require) ve Node/npm build arayüzü bulunmamaktadır; yalnız kısıtlı dump-autoload tasarlanmıştır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h1, h2', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan "Run Composer" / "Composer Install" veya Node.js "npm install / build" düğmeleri aranır
    const composerActionsOrNpm = page.locator('button:has-text("Composer Install"), button:has-text("Composer Update"), button:has-text("npm install"), button:has-text("npm run build")');
    await expect(composerActionsOrNpm.first()).toBeVisible({ timeout: 4000 });
  });
});
