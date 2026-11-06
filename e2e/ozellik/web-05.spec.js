import http from 'node:http';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function checkHttp(host) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '157.180.11.28',
      port: 80,
      path: '/',
      method: 'GET',
      headers: { Host: host },
    }, (res) => {
      resolve({ status: res.statusCode, location: res.headers.location || '' });
    });
    req.on('error', reject);
    req.end();
  });
}

async function deleteDomain(page, domainId, domainName) {
  if (!domainId) return;
  try {
    await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
    const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
    if (await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
      if (await deleteBtn.isVisible().catch(() => false)) {
        await deleteBtn.click();
        const confirmDialog = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
        if (await confirmDialog.isVisible({ timeout: 5000 }).catch(() => false)) {
          const confirmInput = confirmDialog.locator('input');
          if (await confirmInput.isVisible().catch(() => false)) {
            await confirmInput.fill(domainName);
          }
          const confirmBtn = confirmDialog.locator('button', { hasText: 'Silme işlemini başlat' });
          await confirmBtn.click();
          await page.waitForURL(/\/websites$/, { timeout: 15000 }).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error(`Clean-up failed for domain ${domainId} (${domainName}):`, err.message);
  }
}

test.describe.serial('WEB-05 Tercih edilen domain, HTTP→HTTPS ve yönlendirmeler', () => {
  test.setTimeout(180000);
  const agentN = process.env.AGENT_N || '3';
  const prefix = `tweb05-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
  const wwwAlias = `www.${primaryDomain}`;
  let createdDomainId = null;

  const noSslPrefix = `tweb05nossl-a${agentN}-${Date.now().toString(36)}`;
  const noSslDomain = `${noSslPrefix}.${parentSuffix}`;
  let noSslDomainId = null;

  test.beforeEach(async ({ page }) => {
    page.on('console', msg => console.log(`[PAGE LOG] ${msg.text()}`));
    page.on('pageerror', err => console.log(`[PAGE ERROR] ${err.message}`));
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        if (createdDomainId) {
          await deleteDomain(page, createdDomainId, primaryDomain);
        }
        if (noSslDomainId) {
          await deleteDomain(page, noSslDomainId, noSslDomain);
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      console.error('Clean-up failed in afterAll:', err.message);
    }
  });

  test('mutlu yol: site oluştur, tercih edilen www alan adını seç, yönlendirmeyi uygula ve fiziksel HTTP 301 cevabı al', async ({ page }) => {
    // 1. Yeni bağımsız alan adı (root domain) sihirbazına git
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı ve www alias seçimi
    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await expect(wwwSelect).toBeVisible();
    await wwwSelect.selectOption('alias');

    // Devam et
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 2: Statik dosya yükleme hazır ayarını seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    // Devam et
    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 3: Kurulumu onayla
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: primaryDomain })).toBeVisible();

    // Posta / Webmail kutusunun işaretini kaldır
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

    // Domain ID'sini yakala
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];
    console.log(`Created domain ID: ${createdDomainId}`);

    // Kurulum sunucuda sürerken alan adı ayarları değiştirilemez (T868); bitmesini bekle.
    let websiteId = null;
    await expect.poll(async () => {
      try {
        const res = await page.request.get(`/api/panel/domains/${encodeURIComponent(createdDomainId)}`);
        if (!res.ok()) return null;
        const domainRecord = await res.json();
        websiteId = (domainRecord.data ?? domainRecord).websiteId;
        return websiteId;
      } catch {
        return null;
      }
    }, { timeout: 30000, intervals: [1000] }).toBeTruthy();

    await expect.poll(async () => {
      try {
        const res = await page.request.get(`/api/panel/sites/${encodeURIComponent(websiteId)}/provisioning/latest`);
        if (!res.ok()) return false;
        const latest = await res.json();
        const operation = latest?.data?.operation ?? latest?.data ?? null;
        return operation?.ready === true;
      } catch {
        return false;
      }
    }, { timeout: 120000, intervals: [2000] }).toBe(true);

    // 2. Barındırma (Hosting) Ayarları sayfasına git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // Sayfanın yüklenmesini ve formun hazır olmasını bekle
    await expect(page.locator('button[type="submit"]:has-text("Kaydet ve uygula")')).toBeAttached({ timeout: 10000 });

    // 3. Tercih edilen alan adı seçimini doğrula ve www alias'ı seç
    const preferredSelect = page.locator('label:has-text("Tercih edilen alan adı") select');
    await expect(preferredSelect).toBeVisible({ timeout: 10000 });

    // www alias seçeneğini doğrula ve seç
    const selectOptions = await preferredSelect.locator('option').allTextContents();
    console.log('Preferred domain options:', selectOptions);
    expect(selectOptions).toContain(wwwAlias);
    await preferredSelect.selectOption(wwwAlias);

    // 4. Ek alan adlarını yönlendir onay kutusunu seç
    const canonicalLabelCheckbox = page.locator('label.ws-check:has-text("Ek alan adlarını") input[type="checkbox"]');
    await expect(canonicalLabelCheckbox).toBeVisible();
    await canonicalLabelCheckbox.check();
    await expect(canonicalLabelCheckbox).toBeChecked();

    // 5. Kaydet ve uygula
    const saveButton = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveButton).toBeEnabled();
    await saveButton.click();

    // Uygulama bildirimini veya durumunu bekle
    const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });

    // 6. Fiziksel Sonuç: Nginx seviyesinde 301 yönlendirmesi doğrula
    // Ana domain (primaryDomain) artık alias gibi davranıp tercih edilen wwwAlias'a yönlenmeli
    const redirectResponse = await checkHttp(primaryDomain);
    console.log(`Redirect HTTP status: ${redirectResponse.status}, location: ${redirectResponse.location}`);
    expect(redirectResponse.status).toBe(301);
    expect(redirectResponse.location).toContain(wwwAlias);

    // Tercih edilen alan adı başka bir alan adına yönlenmemeli. Kurulum SSL'i de tamamladığı için
    // HTTP isteği yalnız aynı adresin HTTPS sürümüne 301 alabilir.
    const targetResponse = await checkHttp(wwwAlias);
    console.log(`Target HTTP status: ${targetResponse.status}, location: ${targetResponse.location}`);
    if (targetResponse.status === 301) {
      expect(new URL(targetResponse.location).origin).toBe(`https://${wwwAlias}`);
    } else {
      expect([200, 403, 404, 500]).toContain(targetResponse.status);
    }
  });

  test('hatalı girdi ve sınır durumu: SSL olmadan HTTPS uyarısı ve form sınır değer kontrolü', async ({ page }) => {
    // 1. Sertifikasız / HTTPS kapalı ayrı bir test sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();
    await domainInput.fill(noSslDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await expect(wwwSelect).toBeVisible();
    await wwwSelect.selectOption('none');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 2: Statik dosya yükleme hazır ayarını seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    // Adım 3: HTTPS kapalı (Şimdilik HTTP) seç
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: noSslDomain })).toBeVisible();

    // Posta / Webmail kutusunun işaretini kaldır
    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    // HTTPS / Sertifika yönetimi: Şimdilik HTTP (off)
    const httpsSelect = page.locator('select[aria-label="Sertifika yönetimi"]');
    await expect(httpsSelect).toBeVisible();
    await httpsSelect.selectOption('off');

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Sonuç ekranını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(noSslDomain);

    // Domain ID'sini yakala
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    noSslDomainId = match[1];
    console.log(`Created no-SSL domain ID: ${noSslDomainId}`);

    // Kurulum sunucuda sürerken alan adı ayarları değiştirilemez; bitmesini bekle.
    let websiteId = null;
    await expect.poll(async () => {
      try {
        const res = await page.request.get(`/api/panel/domains/${encodeURIComponent(noSslDomainId)}`);
        if (!res.ok()) return null;
        const domainRecord = await res.json();
        websiteId = (domainRecord.data ?? domainRecord).websiteId;
        return websiteId;
      } catch {
        return null;
      }
    }, { timeout: 30000, intervals: [1000] }).toBeTruthy();

    if (websiteId) {
      await expect.poll(async () => {
        try {
          const res = await page.request.get(`/api/panel/sites/${encodeURIComponent(websiteId)}/provisioning/latest`);
          if (!res.ok()) return false;
          const latest = await res.json();
          const operation = latest?.data?.operation ?? latest?.data ?? null;
          return operation?.ready === true;
        } catch {
          return false;
        }
      }, { timeout: 120000, intervals: [2000] }).toBe(true);
    }

    // Barındırma sayfasına git
    await page.goto(`/websites/${encodeURIComponent(noSslDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // 1. HTTP → HTTPS onay kutusu ve henüz SSL bağlanmamış managed HTTPS uyarısı kontrolü
    const httpsRedirectCheckbox = page.locator('label.ws-check:has-text("HTTP → HTTPS yönlendirmesi") input[type="checkbox"]');
    await expect(httpsRedirectCheckbox).toBeVisible();

    // Sertifika henüz bağlı olmadığından sistem kullanıcıyı uyarmalı
    const sslNotice = page.locator('.ws-notice.ws-notice-warn').filter({
      hasText: /SSL sertifikası bağlı değil|HTTP → HTTPS yönlendirmesinden önce/i,
    });
    await expect(sslNotice.first()).toBeVisible();

    // 2. Tercih edilen alan adı dropdown'ı sitenin yetkili olmayan dış alan adlarını içermez
    const preferredSelect = page.locator('label:has-text("Tercih edilen alan adı") select');
    await expect(preferredSelect).toBeVisible();
    const selectOptions = await preferredSelect.locator('option').allTextContents();
    expect(selectOptions).not.toContain('foreign-unbound-domain.com');

    // 3. Sayısal Nginx sınır değerleri kontrolü (örnek: En büyük yükleme boyutu negatif veya max limit dışı girildiğinde form submit engellenir)
    const bodySizeInput = page.locator('label:has-text("En büyük yükleme boyutu") input');
    await expect(bodySizeInput).toBeVisible();

    // Geçersiz değer: 2000 MB (> max 1024)
    await bodySizeInput.fill('2000');
    const saveButton = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await saveButton.click();

    // HTML5 / form validasyonu nedeniyle form gönderilmemeli, input invalid olmalı
    const isInvalidMax = await bodySizeInput.evaluate((el) => !el.checkValidity());
    expect(isInvalidMax).toBe(true);

    // Geçersiz negatif değer: -10
    await bodySizeInput.fill('-10');
    await saveButton.click();
    const isInvalidMin = await bodySizeInput.evaluate((el) => !el.checkValidity());
    expect(isInvalidMin).toBe(true);

    // Değeri temizle / geçerli hale getir
    await bodySizeInput.fill('');

    // Test sonu temizliği: noSslDomainId'yi panel üzerinden sil
    await deleteDomain(page, noSslDomainId, noSslDomain);
    noSslDomainId = null;
  });
});
