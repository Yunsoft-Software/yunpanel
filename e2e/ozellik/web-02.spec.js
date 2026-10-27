import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WEB-02 Subdomain ve ayrı document root', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tweb02-a${agentN}-${Date.now().toString(36)}`;
  let createdDomainId = null;
  let fullSubdomain = '';

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;

    try {
      // 1. Silme planının kararlı (stable) state araması için alan adını yayına uygula (gerekliyse)
      await page.goto(`/websites/${encodeURIComponent(domainId)}/domains`);
      const applyBtn = page.locator('button:has-text("Yayına uygula")');
      if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        if (await applyBtn.isEnabled()) {
          await applyBtn.click();
          await expect(page.locator('text=Yayında').first()).toBeVisible({ timeout: 20000 }).catch(() => {});
        }
      }

      // 2. Ayarlar sekmesindeki güvenli kaldırma paneline git
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
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
      console.warn('Subdomain cleanup notice:', err.message);
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
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, fullSubdomain);
    } catch (err) {
      console.error('Clean-up failed for subdomain:', createdDomainId, err);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('hatalı girdi: geçersiz subdomain adı reddedilir', async ({ page }) => {
    await page.goto('/websites/new?mode=subdomain');
    await expect(page.locator('h1', { hasText: 'Alt alan adı ekle' })).toBeVisible({ timeout: 10000 });

    const prefixInput = page.locator('input[aria-label="Alt alan adı"]');
    await expect(prefixInput).toBeVisible();

    const parentSelect = page.locator('label:has-text("Üst alan adı") select');
    await expect(parentSelect).toBeVisible();
    await expect(parentSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });

    const options = await parentSelect.locator('option').allTextContents();
    const parentOption = options.find((opt) => opt.includes('webrich.news')) || options[1];
    expect(parentOption).toBeTruthy();
    await parentSelect.selectOption({ label: parentOption });

    // 1. Boş önek tarayıcı HTML5 constraint validation tarafından engellenir
    await prefixInput.fill('');
    expect(await prefixInput.evaluate((el) => el.checkValidity())).toBe(false);

    // 2. Geçersiz karakterler içeren önek (özel karakter / geçersiz DNS etiketi)
    await prefixInput.fill('invalid_prefix!@#');
    expect(await prefixInput.inputValue()).toBe('invalid_prefix!@#');

    // 2. Adıma geç
    const nextBtn = page.locator('button[type="submit"]:has-text("Devam et")');
    await nextBtn.click();
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });

    // 3. Adıma geç
    await nextBtn.click();
    await expect(page.locator('h3:has-text("Son kontrol ve kurulum")').or(page.locator('h2:has-text("Son kontrol ve kurulum")'))).toBeVisible({ timeout: 10000 });

    // Siteyi oluştur butonuna tıkla
    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // domainCreatePayload doğrulama hatası fırlatmalı ve ekranda hata uyarısı görünmelidir
    const errorNotice = page.locator('.ws-notice-error, [role="alert"]').or(page.locator('.ws-error'));
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(errorNotice).toContainText(/subdomain prefix/i);
  });

  test('mutlu yol: subdomain oluştur, ayrı document root doğrula ve fiziksel HTTP cevabı al', async ({ page, request }) => {
    await page.goto('/websites/new?mode=subdomain');
    await expect(page.locator('h1', { hasText: 'Alt alan adı ekle' })).toBeVisible({ timeout: 10000 });

    // 1. Adım: Üst alan adı ve subdomain öneki
    const parentSelect = page.locator('label:has-text("Üst alan adı") select');
    await expect(parentSelect).toBeVisible();
    await expect(parentSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });

    const options = await parentSelect.locator('option').allTextContents();
    const parentOption = options.find((opt) => opt.includes('webrich.news')) || options[1];
    expect(parentOption).toBeTruthy();
    await parentSelect.selectOption({ label: parentOption });

    const parentDomain = parentOption.trim();
    const parentDomainId = await parentSelect.inputValue();
    expect(parentDomainId).toBeTruthy();
    fullSubdomain = `${prefix}.${parentDomain}`;

    const prefixInput = page.locator('input[aria-label="Alt alan adı"]');
    await prefixInput.fill(prefix);

    // Ortak domain içi hiyerarşik dosya kökü rozetini doğrula
    const expectedDocRoot = `/var/www/vhosts/${parentDomain}/subdomains/${prefix}`;
    const docRootBadge = page.locator('.yp-subdomain-branch');
    await expect(docRootBadge).toBeVisible();
    await expect(docRootBadge).toContainText(expectedDocRoot);

    // 2. Adıma ilerle
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // 2. Adım: Barındırma türü seçimi
    const hostingHeading = page.locator('h3:has-text("Barındırma türü")');
    await expect(hostingHeading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    // 3. Adıma ilerle
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // 3. Adım: Son kontrol ve kurulum özeti
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    // Özette alan adı ve document root doğrulaması
    await expect(summarySection.locator('dd', { hasText: fullSubdomain })).toBeVisible();
    await expect(summarySection.locator('dd', { hasText: expectedDocRoot })).toBeVisible();

    // Kurulumu başlat
    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(fullSubdomain);

    // Oluşturulan domain ID'sini yakala
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href ? href.match(/\/websites\/([^/?#]+)/) : null;
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Subdomain'in kendi çalışma alanına git ve yayına uygula (kararlı Nginx/vhost durumu için)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/domains`);
    const applyBtn = page.locator('button:has-text("Yayına uygula")');
    if (await applyBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      if (await applyBtn.isEnabled()) {
        await applyBtn.click();
        await expect(page.locator('text=Yayında').first()).toBeVisible({ timeout: 25000 });
      }
    }

    // Web siteleri listesinde arayarak hiyerarşik alt alan adı kartını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(fullSubdomain)}`);
    const subdomainCard = page.locator('.ws-website-task-card').filter({ hasText: fullSubdomain });
    await expect(subdomainCard).toBeVisible({ timeout: 15000 });
    await expect(subdomainCard).toContainText('Alt alan adı');

    // Üst alan adının (webrich.news) Alan Adları sekmesinde alt alan adları listesini doğrula
    await page.goto(`/websites/${encodeURIComponent(parentDomainId)}/domains`);
    await expect(page.locator('h1')).toContainText(parentDomain, { timeout: 15000 });

    const subdomainsSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Alt alan adları' }) });
    await expect(subdomainsSection).toBeVisible({ timeout: 15000 });
    await expect(subdomainsSection.locator(`a:has-text("${fullSubdomain}")`)).toBeVisible({ timeout: 15000 });

    // Subdomain overview sayfasında alt alan adının başlığını ve detayını doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1')).toContainText(fullSubdomain, { timeout: 15000 });

    // Fiziksel Sonuç: 157.180.11.28 IP'sindeki Nginx sunucusuna Host başlığıyla HTTPS isteği at
    // Nginx yapılandırması yüklenmiş olmalı ve 200 OK yanıtı dönmelidir
    const httpsResponse = await request.get('https://157.180.11.28/', {
      headers: { Host: fullSubdomain },
      ignoreHTTPSErrors: true,
      maxRedirects: 0,
      timeout: 15000,
    });
    expect([200, 301]).toContain(httpsResponse.status());
    expect(httpsResponse.headers()['server'] || '').toContain('nginx');
  });
});
