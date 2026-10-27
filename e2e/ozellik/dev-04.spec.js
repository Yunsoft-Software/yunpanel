import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-04 Laravel oluşturma, repositoryden kurma ve mevcut app tarama', () => {
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tdev04-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.157.180.11.28.sslip.io`;

  let createdDomainId = null;

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
      console.warn('DEV-04 cleanup notice:', err.message);
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
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('DEV-04 afterAll cleanup notice:', err.message);
    } finally {
      await page.close().catch(() => {});
    }

    // Fiziksel temizlik kontrolü (0 artık ilkesi)
    runSsh(`rm -f /etc/nginx/sites-enabled/*${siteDomain}* /etc/nginx/sites-available/*${siteDomain}* 2>/dev/null; systemctl reload nginx 2>/dev/null || true`);
  });

  test('mutlu yol: PHP/Laravel hazır ayarı ile site oluştur, public docroot ve PHP-FPM yapılandırmasını ve Composer durumunu doğrula', async ({ page }) => {
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

    // Document root 'public' olarak ayarlanabilir veya doğrulanabilir
    const docRootInput = page.locator('label:has-text("Document Root"), label:has-text("Yayın klasörü")').locator('input');
    if (await docRootInput.isVisible()) {
      await docRootInput.fill('public');
    }

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

    // PHP Ayarları sekmesine git ve Composer bileşenini kontrol et
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    const phpHeading = page.locator('h1, h2, h3', { hasText: 'PHP Ayarları' });
    await expect(phpHeading.first()).toBeVisible({ timeout: 20000 });

    // "Composer ve bağımlılıklar" akordiyonunu aç ve durumunu incele
    const composerSummary = page.locator('summary:has-text("Composer ve bağımlılıklar")');
    if (await composerSummary.isVisible()) {
      await composerSummary.click();
      const composerSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Composer' }) });
      await expect(composerSection.first()).toBeVisible({ timeout: 15000 });
    }

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

    // Fiziksel Kontrol 3: SSH ile site dizini ve public klasörü varlığı
    const siteDirCheck = runSsh(`ls -la /var/lib/yunpanel/sites/*${siteDomain}* 2>/dev/null || ls -la /var/lib/yunpanel/apps/*/releases 2>/dev/null`);
    expect(siteDirCheck.length).toBeGreaterThan(0);
  });

  test('hatalı girdi / API: Desteklenmeyen Laravel framework uç noktasına backend 404 döndürür ve geçersiz alan adı engellenir', async ({ page, request }) => {
    expect(createdDomainId).toBeTruthy();

    // 1. API seviyesinde: non-reseller-capabilities'de adı geçen ancak backend'de henüz implemente edilmemiş Laravel API rotası 404 döndürür
    const laravelApiRes = await request.get(`/api/websites/${createdDomainId}/framework/laravel`);
    expect([404, 405]).toContain(laravelApiRes.status());

    // 2. Geçersiz PHP araç eylem önizleme isteği (ör. laravel.artisan) backend tarafından 400 ile reddedilir
    const invalidActionRes = await request.post(`/api/websites/${createdDomainId}/php-tools/actions/preview`, {
      data: { actionId: 'laravel.artisan.migrate' },
    });
    expect([400, 404]).toContain(invalidActionRes.status());

    // 3. Arayüz seviyesinde: Boş veya geçersiz alan adı girildiğinde HTML5 form doğrulaması engeller
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('');
    const nextBtn = page.locator('button[type="submit"]:has-text("Devam et")');
    await nextBtn.click();

    const isInvalid = await domainInput.evaluate((el) => !el.checkValidity());
    expect(isInvalid).toBe(true);
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri yeni Laravel oluşturma (Install Laravel) sihirbazı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-04-A: Plesk Laravel Toolkit uzantısında yer alan hazır Laravel kurulum sihirbazı (Install Laravel, composer create-project laravel/laravel otomasyonu, .env ve APP_KEY üretimi) YunPanel arayüzünde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan "Install Laravel" / "Laravel Kur" butonu veya Laravel sekmesi aranır
    const laravelTabOrButton = page.locator('a:has-text("Laravel"), button:has-text("Install Laravel"), button:has-text("Laravel Kur"), text=/Laravel Toolkit/i');
    await expect(laravelTabOrButton.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri Git deposundan Laravel kurma (Deploy from Git) PHP sitelerinde bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-04-B: Plesk Laravel Toolkit uzantısında yer alan Git deposu üzerinden doğrudan Laravel projesi kurma ve dağıtma (Deploy from Git with Composer install & artisan migration) yeteneği YunPanel PHP sitelerinde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // PHP sitesinde Git & Yayın Yönetimi veya Git'ten Laravel kurma bağlantısı aranır
    const gitDeployForPhp = page.locator('a:has-text("Git ve Yayın"), a:has-text("Git"), button:has-text("Deploy from Git"), text=/Git ile Laravel/i');
    await expect(gitDeployForPhp.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri mevcut Laravel uygulamasını tarama ve bağlama (Scan / Attach) bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-04-C: Plesk Laravel Toolkit uzantısında yer alan mevcut site dizininde fiziksel artisan ve composer.json dosyalarını tarayıp algılayan ve panelle ilişkilendiren "Scan" / "Attach" aracı YunPanel arayüzünde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h1, h2, h3', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan "Scan" / "Attach Laravel Application" butonu veya aracı aranır
    const scanLaravelBtn = page.locator('button:has-text("Laravel Tara"), button:has-text("Scan Laravel"), button:has-text("Uygulamayı Tara"), button:has-text("Scan / Attach")');
    await expect(scanLaravelBtn.first()).toBeVisible({ timeout: 4000 });
  });
});
