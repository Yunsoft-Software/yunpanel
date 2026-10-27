import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WEB-03 Domain alias; web/mail/DNS ve yönlendirme tercihleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const prefix = `tweb03-a${process.env.AGENT_N || '2'}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  const aliasDomain = `alias-${prefix}.webrich.news`;
  const serverIp = '157.180.11.28';

  let siteDomainId = null;

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
            const submitBtn = dialog.locator('button[type="submit"]');
            if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 60000 }).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      console.warn('Cleanup notice:', err.message);
    }
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    if (!siteDomainId) return;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, siteDomainId, siteDomain);
    } catch (err) {
      console.error('Clean-up failed for domain:', siteDomainId, err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: domain alias ekleme, yayına uygulama, fiziksel HTTP ve canonical yönlendirme tercihleri', async ({ page }) => {
    // 1. Yeni statik test web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Statik dosya yükleme hazır ayarını seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: HTTPS kapat (sadece HTTP) ve Mail kapat
    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    if (await httpsSelect.isVisible().catch(() => false)) {
      await httpsSelect.selectOption('off');
    }

    const mailCheckbox = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheckbox.isVisible().catch(() => false) && await mailCheckbox.isChecked().catch(() => false)) {
      await mailCheckbox.uncheck();
    }

    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    // Sonuç ekranını bekle ve site kimliğini yakala
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    siteDomainId = match ? match[1] : null;
    expect(siteDomainId).toBeTruthy();
    expect(siteDomainId).not.toBe('new');

    // 2. Alan Adları sekmesine git ve Domain Alias ekle
    await page.goto(`/websites/${siteDomainId}/domains`);
    await expect(page.locator('h1')).toContainText(siteDomain, { timeout: 20000 });
    await expect(page.locator('h2', { hasText: 'Ek alan adları (alias)' })).toBeVisible({ timeout: 15000 });

    const aliasInput = page.locator('label:has-text("Yeni ek alan adı") input');
    const addDraftBtn = page.locator('button[type="submit"]:has-text("Taslağa ekle")');

    await aliasInput.fill(aliasDomain);
    await addDraftBtn.click();

    // Taslak listesinde göründüğünü doğrula
    const aliasItem = page.locator(`ul li:has-text("${aliasDomain}")`);
    await expect(aliasItem).toBeVisible({ timeout: 5000 });

    // 3. Değişiklikleri incele ve Kaydet
    const reviewBtn = page.locator('button:has-text("Değişiklikleri incele")');
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    const reviewModal = page.locator('.ws-modal:has-text("Ek alan adı değişiklikleri")');
    await expect(reviewModal).toBeVisible({ timeout: 5000 });
    await expect(reviewModal.locator('dt:has-text("Eklenecek") + dd')).toContainText(aliasDomain);

    await reviewModal.locator('button[type="submit"]:has-text("Kaydet")').click();
    await expect(reviewModal).toBeHidden({ timeout: 5000 });
    await expect(page.locator('div[role="status"]:has-text("Ek alan adları kaydedildi")')).toBeVisible({ timeout: 10000 });

    // 4. Yayına uygula
    const applyBtn = page.locator('button:has-text("Yayına uygula")');
    await expect(applyBtn).toBeEnabled({ timeout: 10000 });
    await applyBtn.click();

    const confirmDialog = page.locator('.ws-modal:has-text("Kaydedilmiş yapılandırmayı yayına uygula")');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });

    const confirmInput = confirmDialog.locator('label:has-text("Onaylamak için") input');
    await confirmInput.fill(siteDomain);

    const submitApplyBtn = confirmDialog.locator('button[type="submit"]:has-text("Yayına uygula")');
    await expect(submitApplyBtn).toBeEnabled();
    await submitApplyBtn.click();

    // Yayına uygulama arka uçta domain.stage ve domain.activate işlemlerini yürütür
    await expect(confirmDialog).toBeHidden({ timeout: 60000 });
    const applyNotice = page.locator('.ws-notice, [role="status"]').filter({
      hasText: /Yayın yapılandırması uygulandı|zaten yayına uygulanmış/i,
    });
    await expect(applyNotice.first()).toBeVisible({ timeout: 45000 });

    // 5. Fiziksel sonuç 1: canonicalRedirect kapalıyken alias Host başlığı doğrudan Nginx vhost yanıtı döner (301 yönlendirmesi değil)
    const responseAlias = await page.request.get(`http://${serverIp}/`, {
      headers: { Host: aliasDomain },
      maxRedirects: 0,
    });
    expect(responseAlias.status()).not.toBe(301);
    expect([200, 403, 404, 500]).toContain(responseAlias.status());

    // 6. Yönlendirme tercihi (canonicalRedirect): Ek alan adlarını ana alan adına yönlendir
    await page.goto(`/websites/${siteDomainId}/hosting`);
    await expect(page.locator('h1')).toContainText(siteDomain, { timeout: 20000 });
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const redirectCheckbox = page.locator('label.ws-check:has-text("Ek alan adlarını") input[type="checkbox"]');
    await expect(redirectCheckbox).toBeVisible({ timeout: 10000 });
    if (!(await redirectCheckbox.isChecked())) {
      await redirectCheckbox.check();
    }

    const saveHostingBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveHostingBtn).toBeEnabled();
    await saveHostingBtn.click();

    const hostingNotice = page.locator('.ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(hostingNotice.first()).toBeVisible({ timeout: 45000 });

    // 7. Fiziksel sonuç 2: canonicalRedirect açıkken alias Host başlığı ile HTTP 301 yönlendirmesi
    const response301 = await page.request.get(`http://${serverIp}/sayfa-1`, {
      headers: { Host: aliasDomain },
      maxRedirects: 0,
    });
    expect(response301.status()).toBe(301);
    const location = response301.headers()['location'];
    expect(location).toContain(`http://${siteDomain}/sayfa-1`);

    // 8. Plesk eşdeğerlik kontrolleri: DNS ve Mail panelleri
    await page.goto(`/websites/${siteDomainId}/dns`);
    await expect(page.locator('h1')).toContainText(siteDomain, { timeout: 20000 });
    await expect(page.locator('h2, h3').filter({ hasText: /DNS/i }).first()).toBeVisible({ timeout: 15000 });

    await page.goto(`/websites/${siteDomainId}/mail`);
    await expect(page.locator('h1')).toContainText(siteDomain, { timeout: 20000 });
    await expect(page.locator('h2, h3, .ws-empty-title').filter({ hasText: /E-posta|Posta/i }).first()).toBeVisible({ timeout: 15000 });
  });

  test('hatalı girdi: geçersiz sözdizimi ve mükerrer domain alias reddedilir', async ({ page }) => {
    test.skip(!siteDomainId, 'Site oluşturulamadığı için atlandı');
    await page.goto(`/websites/${siteDomainId}/domains`);
    await expect(page.locator('h1')).toContainText(siteDomain, { timeout: 20000 });
    await expect(page.locator('h2', { hasText: 'Ek alan adları (alias)' })).toBeVisible({ timeout: 15000 });

    const aliasInput = page.locator('label:has-text("Yeni ek alan adı") input');
    const addDraftBtn = page.locator('button[type="submit"]:has-text("Taslağa ekle")');

    // 1. Geçersiz protokol içeren girdi
    await aliasInput.fill('https://invalid-protocol.com');
    await addDraftBtn.click();
    const syntaxNotice = page.locator('.ws-error, .ws-notice-warn, div[role="alert"]');
    await expect(syntaxNotice).toBeVisible({ timeout: 5000 });
    await expect(syntaxNotice).toContainText('Yalnız alan adını girin');

    // 2. Ana alan adının kendisini alias olarak ekleme
    await aliasInput.fill(siteDomain);
    await addDraftBtn.click();
    const duplicateNotice = page.locator('.ws-error, .ws-notice-warn, div[role="alert"]');
    await expect(duplicateNotice).toBeVisible({ timeout: 5000 });
    await expect(duplicateNotice).toContainText('Ana alan adı veya aynı ek alan adı ikinci kez eklenemez');

    // Alanı temizle
    await aliasInput.clear();
  });
});
