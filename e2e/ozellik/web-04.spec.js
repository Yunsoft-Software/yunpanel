import http from 'node:http';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function checkHttp(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '157.180.11.28',
      port: 80,
      path,
      method: 'GET',
      headers: { Host: host },
    }, (res) => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        server: res.headers.server || '',
        location: res.headers.location || '',
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test.describe.serial('WEB-04 Hosting, forwarding ve hosting olmadan domain davranışı', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tweb04-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;

  let createdDomainId = null;

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/settings`);

        const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
        if (await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) {
          const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
          if (await deleteBtn.isVisible().catch(() => false)) {
            await deleteBtn.click();
            const confirmDialog = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
            if (await confirmDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
              const confirmInput = confirmDialog.locator('input');
              if (await confirmInput.isVisible().catch(() => false)) {
                await confirmInput.fill(primaryDomain);
              }
              const confirmBtn = confirmDialog.locator('button', { hasText: 'Silme işlemini başlat' });
              await confirmBtn.click();
              await page.waitForURL(/\/websites$/, { timeout: 25000 }).catch(() => {});
            }
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      console.error('Clean-up failed for domain:', createdDomainId, err.message);
    }
  });

  test('mutlu yol: web hosting oluştur, barındırma ayarlarını uygula ve fiziksel HTTP cevabı al', async ({ page }) => {
    // 1. Web sitesi sihirbazı ile yeni web barındırma (hosting) aç
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label:has-text("Alan adı") input');
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await expect(wwwSelect).toBeVisible();
    await wwwSelect.selectOption('none');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 2: Barındırma türü seçimi (Statik site barındırma)
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 3: Son kontrol ve kurulum
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: primaryDomain })).toBeVisible();

    // E-posta kutusu varsa temizle
    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Sonuç ekranını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(primaryDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Barındırma (Hosting) Ayarları ekranına git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // Sayfa ve form elemanlarının hazır olduğunu doğrula
    const saveButton = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveButton).toBeAttached({ timeout: 10000 });

    // JAMstack / Web Sunucusu Nginx ayarlarından statik önbellek hazır ayarını uygula
    const cachePresetBtn = page.locator('button:has-text("1 Yıl Statik Önbellek")');
    if (await cachePresetBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await cachePresetBtn.click();
    }

    // Değişiklikleri kaydet ve uygula
    if (await saveButton.isEnabled()) {
      await saveButton.click();
      const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
        hasText: /Barındırma ayarları uygulandı|Yayında/i,
      });
      await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });
    }

    // 3. Fiziksel Sonuç: Canlı Nginx HTTP cevabı al
    const httpRes = await checkHttp(primaryDomain, '/');
    console.log(`Physical HTTP Response for ${primaryDomain}: status=${httpRes.status}, server=${httpRes.server}`);

    // Nginx web sunucusu yanıt vermeli (statik upload yeni açıldığında boş dizin veya varsayılan sayfa: 200, 403 veya 404 dönebilir, ancak sunucu Nginx'tir)
    expect([200, 301, 302, 403, 404]).toContain(httpRes.status);
    expect(httpRes.server.toLowerCase()).toContain('nginx');
  });

  test('hatalı girdi: geçersiz domain ve Nginx alt yol yönlendirmesinde hatalı girdiler reddedilir', async ({ page }) => {
    // 1. Yeni site sihirbazında geçersiz domain formatı doğrulaması
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();

    // Boş veya geçersiz format tarayıcı constraint validation tarafından engellenir
    await domainInput.fill('');
    expect(await domainInput.evaluate((el) => el.checkValidity())).toBe(false);

    // 2. Alt yol yönlendirmesi (Nginx proxy builder) bileşeni doğrulama sınırları
    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const proxyBuilder = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Nginx Alt Yol / API Reverse Proxy' }) });
    if (await proxyBuilder.isVisible({ timeout: 5000 }).catch(() => false)) {
      const pathInput = proxyBuilder.locator('input').first();
      await pathInput.fill('/api/../invalid;hack');
      // Geçersiz format uyarısı gösterilmeli
      const errorNotice = proxyBuilder.locator('.ws-notice-error, .ws-notice');
      await expect(errorNotice).toBeVisible();
    }
  });
});
