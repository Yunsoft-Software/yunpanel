import http from 'node:http';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-05 Node.js sürümü, app root, startup dosyası ve environment', () => {
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `trun05-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
  let createdDomainId = null;

  async function checkDirectHttp(host) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path: '/',
        method: 'GET',
        headers: { Host: host },
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
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
      if (await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible().catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button[type="submit"]');
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 40000 }).catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      console.warn('RUN-05 cleanup notice:', err.message);
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
      await removeWebsiteById(page, createdDomainId, primaryDomain);
    } catch (err) {
      console.warn('RUN-05 afterAll cleanup failed:', err.message);
    } finally {
      await page.close();
    }
  });

  test('hatalı girdi: geçersiz başlangıç dosyası (path traversal / geçersiz karakterler) reddedilir', async ({ page }) => {
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı girişi
    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(`invalid-${primaryDomain}`);
    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    // Adım 2: Site türü seçimi
    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_node');

    // Başlangıç dosyası alanına geçersiz path traversal dosya yolu gir
    const entryFileInput = page.locator('label', { hasText: 'Başlangıç dosyası' }).locator('input');
    await expect(entryFileInput).toBeVisible();
    await entryFileInput.fill('../../../etc/passwd');

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await repoInput.fill('https://github.com/Yunsoft-Software/node-process-recovery');

    // Adım 3'e geçiş
    await nextBtn.click();

    // Adım 3: Siteyi oluştur butonu
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible({ timeout: 10000 });
    await submitBtn.click();

    // Hata bildirimi veya validation uyarısının görünmesi beklenir
    const errorNotice = page.locator('.ws-notice-error, .ws-notice-warn, [role="alert"]')
      .or(page.getByText('Geçersiz'))
      .or(page.getByText('invalid'))
      .or(page.getByText('hata'));
    await expect(errorNotice.first()).toBeVisible({ timeout: 15000 });
  });

  test('mutlu yol: Plesk RUN-05 Node.js sürümü, app root, startup dosyası ve ortam değişkenleri', async ({ page }) => {
    // 1. Yeni Web Sitesi oluşturma sihirbazında Node.js konfigürasyonu
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(primaryDomain);
    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    // Adım 2: Barındırma & Site Türü
    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });

    // Node.js olarak seç
    await sourceSelect.selectOption('new_node');

    // Başlangıç dosyası (Plesk startup file eşdeğeri)
    const entryFileInput = page.locator('label', { hasText: 'Başlangıç dosyası' }).locator('input');
    await expect(entryFileInput).toBeVisible();
    await expect(entryFileInput).toHaveValue('server.js');
    await entryFileInput.fill('app.js');

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await repoInput.fill('https://github.com/Yunsoft-Software/node-process-recovery');

    // Adım 3: İnceleme ve Kurulum
    await nextBtn.click();
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible({ timeout: 10000 });
    await submitBtn.click();

    // Kurulumun tamamlanmasını bekle
    await expect(page.locator('text=Site oluşturuluyor').or(page.locator('text=Site hazırlandı')).or(page.locator('text=Site kuruluyor'))).toBeVisible({ timeout: 30000 }).catch(() => {});

    // Web siteleri listesine git ve siteyi aç
    await page.goto('/websites');
    const siteRow = page.locator(`a:has-text("${primaryDomain}")`).first();
    await expect(siteRow).toBeVisible({ timeout: 40000 });

    const href = await siteRow.getAttribute('href');
    const domainIdMatch = href?.match(/\/websites\/([^/?#]+)/);
    createdDomainId = domainIdMatch ? decodeURIComponent(domainIdMatch[1]) : primaryDomain;

    // 2. Site Detay Sayfası - Node.js Sekmesi (`tab=node`)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/node`);
    await expect(page.getByRole('heading', { name: 'Node.js uygulaması' })).toBeVisible({ timeout: 15000 });

    // Node.js çalışma zamanı bilgilerinin kontrolü
    const nodeSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Node.js uygulaması' }) });
    await expect(nodeSection.getByText('Node.js 24')).toBeVisible({ timeout: 10000 });
    await expect(nodeSection.getByText('main')).toBeVisible({ timeout: 10000 });

    // 3. Ortam Değişkenleri (Environment Variables) Yönetimi
    const envSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Ortam değişkenleri' }) });
    await expect(envSection).toBeVisible({ timeout: 10000 });

    // Yeni ortam değişkeni ekle: APP_RUN_STAGE = staging_test (Düz metin olarak)
    await page.getByRole('textbox', { name: 'Değişken adı' }).fill('APP_RUN_STAGE');
    await page.getByRole('textbox', { name: 'Değer' }).fill('staging_test');
    await envSection.locator('select').first().selectOption('plain');
    await page.getByRole('button', { name: 'Değişkeni kaydet' }).click();

    // Değişkenin eklendiğini ve tabloda/ekranda göründüğünü doğrula
    await expect(envSection.getByText('APP_RUN_STAGE')).toBeVisible({ timeout: 15000 });
    await expect(envSection.getByText('staging_test')).toBeVisible({ timeout: 10000 });

    // İkinci değişken: Gizli (Secret) ortam değişkeni ekleme
    await page.getByRole('textbox', { name: 'Değişken adı' }).fill('SECRET_API_KEY');
    await page.getByRole('textbox', { name: 'Değer' }).fill('super_secret_val_123');
    await envSection.locator('select').first().selectOption('secret');
    await page.getByRole('button', { name: 'Değişkeni kaydet' }).click();

    await expect(envSection.getByText('SECRET_API_KEY')).toBeVisible({ timeout: 15000 });
    // Gizli değer maskeli olarak görünmeli (değerin kendisi düz metin olarak listede açıkça yer almamalı)
    await expect(envSection.getByText('••••••••')).toBeVisible({ timeout: 10000 });

    // 4. Fiziksel Sonuç Doğrulaması: Nginx Port/Vhost veya HTTP Yanıtı
    const httpCheck = await checkDirectHttp(primaryDomain).catch(err => ({ status: 0, error: err.message }));
    // Sitenin Nginx vhost kaydı oluşturulmuş ve yanıt dönüyor (200, 502, 503 veya yönlendirme)
    expect(httpCheck.status).toBeGreaterThan(0);
  });
});
