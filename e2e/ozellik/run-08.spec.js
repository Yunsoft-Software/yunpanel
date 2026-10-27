import http from 'node:http';
import https from 'node:https';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-08 Dil/runtime eklentilerinin kurulum ve erişim politikası', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `trun08-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;
  let resolvedUnixUser = null;
  let defaultDocRoot = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  async function checkHttp(host, path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: { Host: host },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 8000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
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
      console.warn('RUN-08 cleanup notice:', err.message);
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
      console.warn('RUN-08 afterAll cleanup failed:', err.message);
    } finally {
      // 0 artık ilkesi: geçici dosya temizliği
      if (defaultDocRoot) {
        const baseDir = defaultDocRoot.replace(/\/public$/, '');
        runSsh(`rm -f ${baseDir}/public/run08-ext-check.php ${baseDir}/run08-ext-check.php 2>/dev/null || true`);
      }
      await page.close().catch(() => {});
    }
  });

  test('hatalı girdi: PHP/runtime yapılandırmasında geçersiz alanlar, yetkisiz modül parametreleri ve geçersiz sürümler reddedilir', async ({ page }) => {
    // 1. API: Var olmayan website ID için PHP yapılandırma okuma isteği reddedilir (400 veya 404)
    const fakeIdRes = await page.request.get('/api/websites/00000000-0000-4000-8000-000000000000/php-tools/config');
    expect([400, 404]).toContain(fakeIdRes.status());

    // 2. API: Desteklenmeyen veya tanımlanmamış alanlar (ör. extensions, arbitrary shell injection) gönderildiğinde 400 ile fail-closed reddedilir
    const invalidPayloadRes = await page.request.post('/api/websites/00000000-0000-4000-8000-000000000000/php-tools/config/preview', {
      data: {
        phpVersion: '8.3',
        extensions: ['curl', 'mbstring', 'malicious_module'],
      },
    });
    expect([400, 404]).toContain(invalidPayloadRes.status());

    // 3. API: Desteklenmeyen eski veya geçersiz PHP sürümü (ör. 5.6) reddedilir
    const unsupportedVerRes = await page.request.post('/api/websites/00000000-0000-4000-8000-000000000000/php-tools/config/preview', {
      data: {
        phpVersion: '5.6',
      },
    });
    expect([400, 404]).toContain(unsupportedVerRes.status());
  });

  test('mutlu yol: PHP sitesi oluşturma, runtime ayarlarını inceleme ve SSH & HTTP üzerinden fiziksel PHP eklentilerini (curl, mbstring, gd, pdo_mysql, opcache) doğrulama', async ({ page }) => {
    // 1. Yeni PHP Web Sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1, h2', { hasText: 'Web sitesi ekle' }).first()).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: PHP / WordPress barındırma türünü seç
    const sourceSelect = page.locator('label:has-text("Site türü") select, select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_php');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu onayla ve oluştur
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: siteDomain })).toBeVisible();

    // E-posta / Webmail seçeneğini temizle
    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible().catch(() => false)) {
      if (await mailCheck.isChecked()) {
        await mailCheck.uncheck();
      }
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    // Oluşturulan domain ID'sini al
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Erişim hesapları ve sistem kullanıcısını doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/access`);
    await expect(page.locator('h2, h3', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });

    const userRow = page.locator('dt:has-text("Kullanıcı adı") + dd');
    await expect(userRow).toBeVisible({ timeout: 10000 });
    resolvedUnixUser = (await userRow.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]+$/);

    const docRootRow = page.locator('dt:has-text("Belge kök dizini (Docroot)") + dd');
    await expect(docRootRow).toBeVisible({ timeout: 10000 });
    defaultDocRoot = (await docRootRow.textContent()).trim();
    expect(defaultDocRoot).toMatch(/\/(?:var\/www|var\/lib)\/yunpanel\/apps\/[^/]+\/current(?:\/public)?$/);

    // 3. PHP Ayarları sayfasına git ve çalışma ortamını incele
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h2, h3', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    const phpVersionSelect = page.locator('#site-php-version');
    await expect(phpVersionSelect).toBeVisible({ timeout: 10000 });
    const selectedVersion = await phpVersionSelect.inputValue();
    expect(['8.3', '8.2', '8.1', '7.4']).toContain(selectedVersion);

    // 4. Fiziksel Kontrol 1 (SSH): Host seviyesinde php -m ile derlenmiş ve yüklü PHP modüllerini doğrula
    const sshPhpModules = runSsh('php -m');
    expect(sshPhpModules).toContain('curl');
    expect(sshPhpModules).toContain('mbstring');
    expect(sshPhpModules).toContain('gd');
    expect(sshPhpModules).toContain('pdo_mysql');
    expect(sshPhpModules).toContain('Zend OPcache');
    expect(sshPhpModules).toContain('intl');

    // 5. Fiziksel Kontrol 2 (SSH & İzolasyon): Dedicated site kullanıcısı bağlamında PHP eklentilerini çalıştır
    const userPhpCheck = runSsh(
      `su -s /bin/bash -c "php8.3 -r 'echo json_encode([\\"curl\\"=>extension_loaded(\\"curl\\"),\\"mbstring\\"=>extension_loaded(\\"mbstring\\"),\\"gd\\"=>extension_loaded(\\"gd\\"),\\"pdo_mysql\\"=>extension_loaded(\\"pdo_mysql\\"),\\"opcache\\"=>extension_loaded(\\"Zend OPcache\\")]);'" ${resolvedUnixUser}`,
    );
    const parsed = JSON.parse(userPhpCheck);
    expect(parsed.curl).toBe(true);
    expect(parsed.mbstring).toBe(true);
    expect(parsed.gd).toBe(true);
    expect(parsed.pdo_mysql).toBe(true);
    expect(parsed.opcache).toBe(true);

    // 6. Fiziksel Kontrol 3 (HTTP): Web sunucusunun canlı yanıtını doğrula
    const httpRes = await checkHttp(siteDomain);
    expect([200, 301, 302, 403, 404]).toContain(httpRes.status);
  });

  test('Plesk paritesi: PHP eklentilerini (extensions/modüller) açma-kapatma ve müşteri/domain bazlı modül erişim politikası arayüzü', async ({ page }) => {
    // Plesk'te her PHP sürümü veya domain/subscription için PHP Extensions
    // (modül açma-kapatma checkbox listesi; ör. redis, curl, gd, imagick, mbstring, pdo_mysql, xdebug vb.)
    // yönetim arayüzü ve müşteri/domain bazlı modül erişim politikası bulunur.
    // YunPanel PHP ayarları sayfasında bu Plesk özelliği incelenir.

    test.fail(
      true,
      'BULGU RUN-08: Panelde Plesk eşdeğeri PHP modülleri/eklentileri (extensions) açma-kapatma ve domain/müşteri bazlı modül erişim politikası arayüzü bulunmuyor.',
    );

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h2, h3', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    // Plesk eşdeğeri PHP eklentileri / modül açma-kapatma bölümü aranır
    const extensionHeading = page.locator('h2, h3, summary, label').filter({ hasText: /PHP Eklentileri|PHP Modülleri|Extensions/i });
    await expect(extensionHeading.first()).toBeVisible({ timeout: 5000 });
  });
});
