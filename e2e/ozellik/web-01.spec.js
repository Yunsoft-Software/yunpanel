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
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          server: res.headers.server || '',
          location: res.headers.location || '',
          body,
        });
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

test.describe.serial('WEB-01 Domain ekleme ve amaca göre site oluşturma sihirbazı', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tweb01-a${agentN}-${Date.now().toString(36)}`;
  const primaryDomain = `${prefix}.webrich.news`;
  const custUser = `${prefix}-c1`;
  const custPass = 'TestPass12345678!';

  let createdDomainId = null;

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      await page.waitForLoadState('domcontentloaded');

      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (!await removalSection.isVisible({ timeout: 15000 }).catch(() => false)) return;

      const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
      const resumeBtn = removalSection.locator('button', { hasText: 'Silme işlemine devam et' });

      const actionBtn = (await deleteBtn.isVisible({ timeout: 5000 }).catch(() => false)) ? deleteBtn : resumeBtn;
      if (await actionBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await actionBtn.click();

        const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Siteyi kalıcı olarak sil|Silme/i });
        await expect(dialog).toBeVisible({ timeout: 10000 });

        const input = dialog.locator('input');
        if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
          await input.fill(domainName);
        }

        const submitBtn = dialog.locator('button[type="submit"]');
        await expect(submitBtn).toBeEnabled({ timeout: 5000 });
        await submitBtn.click();

        // Silme operasyonunun tamamlanmasını bekle
        const doneIndicator = page.locator('button:has-text("Web sitelerine dön")')
          .or(page.getByText('Site silindi'));
        await expect(doneIndicator.first()).toBeVisible({ timeout: 60000 });

        const returnBtn = page.locator('button:has-text("Web sitelerine dön")');
        if (await returnBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await returnBtn.click().catch(() => {});
        }
      }
    } catch (err) {
      console.warn(`Clean-up notice for domain ${domainId} (${domainName}):`, err.message);
    }
  }

  async function cleanupCustomerAccounts(page, pfx) {
    try {
      await page.evaluate(async (prefixStr) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Müşteri profillerini kaldır
        const custRes = await fetch('/api/panel/users/hosting/accounts?kind=customer&limit=100').catch(() => null);
        const custData = await custRes?.json().catch(() => null);
        for (const cust of custData?.data?.accounts || []) {
          if (cust.username && cust.username.startsWith(prefixStr)) {
            await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(cust.id)}/profile`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({
                revision: cust.revision ?? 1,
                confirmation: `unregister-hosting-profile:${cust.id}:${cust.revision ?? 1}`,
              }),
            }).catch(() => null);
          }
        }

        // 2. Kullanıcı hesabını sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          if (u.username && u.username.startsWith(prefixStr)) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }
      }, pfx);
    } catch (err) {
      console.warn('Customer account cleanup notice:', err.message);
    }
  }

  async function loginCustomerWithRetry(custPage, username, password, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await custPage.goto('/');
      const sessionBar = custPage.locator('.auth-sessionbar');
      const authForm = custPage.locator('form.auth-form');
      await expect(sessionBar.or(authForm)).toBeVisible({ timeout: 15000 });

      if (await sessionBar.isVisible()) {
        const text = await sessionBar.textContent();
        if (text.includes(username)) return;
        const logoutBtn = custPage.locator('.auth-sessionbar button', { hasText: 'Çıkış yap' });
        if (await logoutBtn.isVisible()) {
          await logoutBtn.click();
          await expect(authForm).toBeVisible({ timeout: 15000 });
        }
      }

      await custPage.fill('input[name="username"]', username);
      await custPage.fill('input[name="password"]', password);
      await custPage.click('button.auth-primary');

      const notice = custPage.locator('.ws-notice-error, [role="alert"]');
      const outcome = await Promise.race([
        sessionBar.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'success').catch(() => null),
        notice.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'notice').catch(() => null),
      ]);

      if (outcome === 'success') {
        return;
      }

      if (attempt < maxRetries) {
        await custPage.waitForTimeout(attempt * 3000);
      }
    }
    await expect(custPage.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      if (createdDomainId) {
        await removeWebsiteById(page, createdDomainId, primaryDomain);
      }
      await cleanupCustomerAccounts(page, prefix);
    } catch (err) {
      console.warn('afterAll cleanup error:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: kök alan adı + PHP-FPM hazır ayarı + www alias ile site oluşturma ve fiziksel HTTP 200', async ({ page }) => {
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // 1. Adım: Alan adı ve www alias
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('alias');

    const nextBtn1 = page.locator('button[type="submit"]:has-text("Devam et")');
    await expect(nextBtn1).toBeEnabled();
    await nextBtn1.click();

    // 2. Adım: PHP-FPM hazır ayarı ve otomatik veritabanı
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_php');

    const dbCheckbox = page.locator('label.ws-check:has-text("otomatik veritabanı") input[type="checkbox"]');
    await expect(dbCheckbox).toBeVisible({ timeout: 5000 });
    if (!await dbCheckbox.isChecked()) {
      await dbCheckbox.check();
    }

    const nextBtn2 = page.locator('button[type="submit"]:has-text("Devam et")');
    await expect(nextBtn2).toBeEnabled();
    await nextBtn2.click();

    // 3. Adım: DNS, HTTPS ve Kurulum
    await expect(page.locator('h3:has-text("DNS")')).toBeVisible({ timeout: 10000 });

    const dnsSelect = page.locator('label:has-text("DNS yönetimi") select');
    await dnsSelect.selectOption('local');

    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    await httpsSelect.selectOption('off');

    const mailCheckbox = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheckbox.isVisible().catch(() => false) && await mailCheckbox.isChecked().catch(() => false)) {
      await mailCheckbox.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // Kurulum sonuç ekranını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 90000 });
    await expect(resultElement).toContainText(primaryDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    createdDomainId = match ? match[1] : null;
    expect(createdDomainId).toBeTruthy();

    // Fiziksel doğrulama 1: Nginx canlı HTTP port 80 yanıtı (HTTP 200 veya 301 yönlendirmesi)
    // Kurulum sonuç ekranından sonra sunucuda tamamlanır; vhost'u yoklamadan önce bitmesini bekle.
    await expect.poll(async () => (await checkHttp(primaryDomain, '/')).status, { timeout: 120000, intervals: [2000] }).toBeLessThan(400);
    const resPrimary = await checkHttp(primaryDomain, '/');
    expect([200, 301]).toContain(resPrimary.status);
    expect(resPrimary.server.toLowerCase()).toContain('nginx');
    if (resPrimary.status === 301) {
      expect(resPrimary.location).toContain(primaryDomain);
    }

    // Fiziksel doğrulama 2: www alias için Nginx port 80 yanıtı (HTTP 200 veya 301 yönlendirme)
    const resWww = await checkHttp(`www.${primaryDomain}`, '/');
    expect([200, 301]).toContain(resWww.status);
    expect(resWww.server.toLowerCase()).toContain('nginx');

    // Siteyi normal panel silme akışıyla temizle
    await removeWebsiteById(page, createdDomainId, primaryDomain);
    createdDomainId = null;
  });

  test('hatalı girdi: mükerrer alan adı (çakışma) sihirbaz tarafından engellenir', async ({ page }) => {
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Sistemde zaten var olan webrich.news girilir
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('webrich.news');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Devam et
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu dene
    await expect(page.locator('h3:has-text("DNS")')).toBeVisible({ timeout: 10000 });
    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    // Hata bildiriminin ekranda çıktığını ve sitenin oluşturulmadığını doğrula
    const errorNotice = page.locator('.ws-notice-error, [role="alert"]').or(page.locator('text=Önizleme doğrulanamadı'));
    await expect(errorNotice.first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.ws-site-create-result')).not.toBeVisible();
  });

  test('rol senaryosu: müşteri rolü doğrudan site oluşturamaz ve izole edilir', async ({ page, browser }) => {
    // 1. Owner olarak müşteri oluştur
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    await page.locator('button:has-text("Müşteri ekle")').click();
    const createDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(custUser);
    await createDialog.locator('label:has-text("İlk parola") input').fill(custPass);

    const submitBtn = createDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // 2. Yeni izole context ile müşteri olarak giriş yap
    const custContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const custPage = await custContext.newPage();
    try {
      await loginCustomerWithRetry(custPage, custUser, custPass);

      // /websites sayfasına git ve "Web sitesi ekle" butonunun olmadığını doğrula
      await custPage.goto('/websites');
      await expect(custPage.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });
      const addSiteBtn = custPage.locator('a[href="/websites/new"], button:has-text("Web sitesi ekle")');
      await expect(addSiteBtn).not.toBeVisible();

      // Doğrudan /websites/new adresine gitmeyi dene - erişim engellenmeli veya yönlendirilmeli
      await custPage.goto('/websites/new');
      await expect(custPage.locator('form.ws-form')).not.toBeVisible({ timeout: 10000 });
    } finally {
      await custContext.close().catch(() => {});
    }

    // 3. Müşteri hesabını temizle
    await cleanupCustomerAccounts(page, prefix);
  });

  test('bilinen hata: Docker / Compose Proxy hazır ayarında boş proje kimliği 400 hatası üretir (H4)', async ({ page }) => {
    test.fail(true, 'BULGU H4: docker_stack secildiginde projectId bos gecilip 400 site_create_invalid_id uretiliyor');

    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(`${prefix}-dkr.webrich.news`);

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Docker / Compose Proxy hazır ayarını seç
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    const dkrPreset = page.locator('[data-preset-id="docker_stack"]');
    await expect(dkrPreset).toBeVisible({ timeout: 5000 });
    await dkrPreset.click();

    // Docker Compose proje kimliği alanını boş bırakarak devam et
    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu başlat
    await expect(page.locator('h3:has-text("DNS")')).toBeVisible({ timeout: 10000 });
    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    // H4 nedeniyle site_create_invalid_id hatası alınır ve site oluşturulamaz.
    // Başarılı olması beklenirken başarısız olacağı için test.fail bekleneni yakalar.
    await expect(page.locator('.ws-site-create-result')).toBeVisible({ timeout: 10000 });
  });
});
