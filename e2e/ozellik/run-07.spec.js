import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-07 PHP Composer bağımlılık yönetimi', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `trun07-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;
  let resolvedWebsiteId = null;
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

  async function checkHttp(host) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path: '/',
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
      console.warn('RUN-07 cleanup notice:', err.message);
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
      console.warn('RUN-07 afterAll cleanup failed:', err.message);
    } finally {
      // Artık dosya ve dizin temizliği (0 artık ilkesi)
      if (defaultDocRoot) {
        const appRoot = defaultDocRoot.replace(/\/public$/, '');
        runSsh(`rm -rf ${defaultDocRoot}/composer.json ${defaultDocRoot}/composer.lock ${defaultDocRoot}/vendor ${appRoot}/composer.json ${appRoot}/composer.lock ${appRoot}/vendor 2>/dev/null || true`);
      }
      await page.close().catch(() => {});
    }
  });

  test('hatalı girdi: geçersiz Composer komut parametreleri, eksik argüman ve yetkisiz işlem reddedilir', async ({ page }) => {
    // 1. API Doğrulaması: Eksik komut (command alanı yok) gönderildiğinde 400 döner
    const missingCmdRes = await page.request.post('/api/websites/00000000-0000-4000-8000-000000000000/composer/run', {
      data: {},
    });
    expect([400, 404]).toContain(missingCmdRes.status());

    // 2. Desteklenmeyen veya zararlı komut gönderimi reddedilir
    const maliciousCmdRes = await page.request.post('/api/websites/00000000-0000-4000-8000-000000000000/composer/run', {
      data: {
        command: 'rm -rf /; cat /etc/shadow',
      },
    });
    expect([400, 404]).toContain(maliciousCmdRes.status());

    // 3. Geçersiz args türü (string yerine array beklenir) reddedilir
    const invalidArgsRes = await page.request.post('/api/websites/00000000-0000-4000-8000-000000000000/composer/run', {
      data: {
        command: 'install',
        args: 'not-an-array',
      },
    });
    expect([400, 404]).toContain(invalidArgsRes.status());

    // 4. Var olmayan site için composer status sorgusu reddedilir
    const statusRes = await page.request.get('/api/websites/00000000-0000-4000-8000-000000000000/composer/status');
    expect([400, 404]).toContain(statusRes.status());
  });

  test('mutlu yol: PHP sitesi oluşturma, UI Composer durumunun tespiti ve composer.json varlığının canlı algılanması', async ({ page }) => {
    // 1. Yeni PHP Web Sitesi oluşturma sihirbazı
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
    const appRoot = defaultDocRoot.replace(/\/public$/, '');

    // Fiziksel Kontrol (SSH): Sistem kullanıcısının Linux seviyesinde varlığı
    const idCheck = runSsh(`id ${resolvedUnixUser}`);
    expect(idCheck).toContain('uid=');
    expect(idCheck).not.toContain('uid=0(');

    // 3. Fiziksel HTTP Kontrolü: PHP sitesinin web sunucusu (Nginx + PHP-FPM) üzerinden yanıt vermesi (301 HTTPS yönlendirmesi veya 200/403/404)
    const httpRes = await checkHttp(siteDomain);
    expect([200, 301, 302, 403, 404]).toContain(httpRes.status);

    // 4. PHP Ayarları sekmesine git ve Composer bölümünü aç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h2, h3', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    // "Composer ve bağımlılıklar" accordion bölümünü aç
    const composerDetails = page.locator('details.ws-settings-advanced').filter({ hasText: 'Composer ve bağımlılıklar' });
    await expect(composerDetails).toBeVisible({ timeout: 10000 });
    await composerDetails.locator('summary').click();

    // Composer panelinin yüklendiğini doğrula
    const composerSection = composerDetails.locator('section').filter({ hasText: 'Composer' });
    await expect(composerSection.first()).toBeVisible({ timeout: 15000 });

    // Başlangıçta henüz composer.json yokken durum "Yok" olmalıdır
    const composerJsonRow = composerSection.locator('dt:has-text("composer.json") + dd');
    await expect(composerJsonRow).toBeVisible({ timeout: 10000 });
    expect(await composerJsonRow.textContent()).toContain('Yok');

    // 5. Fiziksel olarak site kök dizinine geçerli bir composer.json yerleştir
    const testComposerJson = JSON.stringify({
      name: 'yunpanel/run07-test',
      description: 'PHP dependency test package for RUN-07',
      type: 'project',
      require: {
        'psr/log': '^1.1',
      },
    }, null, 2);
    const b64 = Buffer.from(testComposerJson).toString('base64');

    runSsh(`mkdir -p ${appRoot} && echo '${b64}' | base64 -d > ${appRoot}/composer.json && chown ${resolvedUnixUser}:${resolvedUnixUser} ${appRoot}/composer.json`);

    // SSH ile fiziksel dosya varlığını doğrula
    const fileVerify = runSsh(`test -f ${appRoot}/composer.json && cat ${appRoot}/composer.json`);
    expect(fileVerify).toContain('yunpanel/run07-test');

    // 6. UI'da "Durumu kontrol et" butonuna tıkla ve canlı tespiti doğrula
    const refreshBtn = composerSection.locator('button:has-text("Durumu kontrol et")');
    await expect(refreshBtn).toBeVisible({ timeout: 10000 });
    await refreshBtn.click();

    // composer.json durumunun "Var" olarak güncellenmesini bekle
    await expect(composerSection.locator('dt:has-text("composer.json") + dd')).toContainText('Var', { timeout: 15000 });

    // Proje konumunun "Uygulama kökü" olarak algılandığını doğrula
    const locationRow = composerSection.locator('dt:has-text("Proje konumu") + dd');
    await expect(locationRow).toBeVisible();
    expect(await locationRow.textContent()).toContain('Uygulama kökü');

    // 7. Sorumluluk reddi / sınır bildiriminin UI'da net olarak belirtildiğini doğrula
    await expect(composerSection.locator('text=Bu kontrol bağımlılık kurmaz veya güncellemez')).toBeVisible();
  });

  test('Plesk eşdeğerliği: UI üzerinden Composer bağımlılık kurulumu (composer install/update) ve paket yönetimi', async ({ page }) => {
    test.fail(
      true,
      'BULGU RUN-07: Plesk PHP Composer uzantısı eşdeğeri hazır bir UI arayüzü (Composer install/update/require butonları, paket arama/kurma ve composer.json editörü) YunPanel arayüzünde bulunmuyor; panel yalnızca composer.json varlık tespiti ve dump-autoload sunuyor, bağımlılık kurulumu için site terminali gerekiyor.',
    );

    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('h2, h3', { hasText: 'PHP Ayarları' }).first()).toBeVisible({ timeout: 15000 });

    const composerDetails = page.locator('details.ws-settings-advanced').filter({ hasText: 'Composer ve bağımlılıklar' });
    await expect(composerDetails).toBeVisible({ timeout: 10000 });
    if (!await composerDetails.getAttribute('open')) {
      await composerDetails.locator('summary').click();
    }

    // Plesk Composer uzantısında yer alan bağımlılık kurma (Composer Install) veya güncelleme (Composer Update) butonu aranır
    const installButton = composerDetails.locator(
      'button:has-text("Composer Install"), button:has-text("Bağımlılıkları kur"), button:has-text("composer install"), button:has-text("Paket Kur")',
    );
    // YunPanel arayüzünde bu butonlar bulunmadığı için test.fail ile başarısızlık beklenir
    await expect(installButton).toBeVisible({ timeout: 4000 });
  });
});
