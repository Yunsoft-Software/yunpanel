import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('RUN-04 MIME, index, hata sayfaları ve parola korumalı dizinler', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `trun04-a${agentN}-${Date.now().toString(36)}`;
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

  function checkHttp(host, path = '/', headers = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: {
          Host: host,
          ...headers,
        },
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
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 30000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
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
    if (createdDomainId) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, siteDomain);
      } catch (err) {
        console.warn('Clean-up failed for domain:', createdDomainId, err.message);
      } finally {
        await page.close().catch(() => {});
      }
    }
    // Lingering auth files, vhost conf or directories cleanup on server (0 residue)
    runSsh(`rm -f /etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf /etc/nginx/sites-available/yunpanel-${siteDomain}.conf && rm -rf /etc/nginx/yunpanel-auth/${siteDomain}`);
  });

  test('mutlu yol: site oluştur, başlangıç dosyaları ve özel 404 sayfası yapılandır, Nginx ve fiziksel HTTP ile doğrula', async ({ page }) => {
    // 1. Yeni statik test web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Statik barındırma türünü seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu onayla ve oluştur
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: siteDomain })).toBeVisible();

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
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

    // 2. Sistem kullanıcısı ve DocRoot dizinini erişim sayfasından tespit et
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/access`);
    await expect(page.locator('h2, h3', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });

    const userRow = page.locator('dt:has-text("Kullanıcı adı") + dd');
    await expect(userRow).toBeVisible();
    resolvedUnixUser = (await userRow.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]+$/);

    const docRootRow = page.locator('dt:has-text("Belge kök dizini (Docroot)") + dd');
    await expect(docRootRow).toBeVisible();
    defaultDocRoot = (await docRootRow.textContent()).trim();
    expect(defaultDocRoot).toContain('/var/www/yunpanel/apps/');

    // 3. Fiziksel dosya yapısını sunucuda hazırla (SSH)
    // - index.html (varsayılan) ve anasayfa.html (öncelikli index dosyası)
    // - /hatalar/404.html (özel 404 hata sayfası)
    const setupCmd = [
      `mkdir -p ${defaultDocRoot}/hatalar`,
      `echo "<h1>VARSAYILAN_INDEX</h1>" > ${defaultDocRoot}/index.html`,
      `echo "<h1>ONCELIKLI_ANASAYFA_INDEX</h1>" > ${defaultDocRoot}/anasayfa.html`,
      `echo "<div id=\\"custom-error\\">OZEL_404_HATA_SAYFASI</div>" > ${defaultDocRoot}/hatalar/404.html`,
      `chown -R ${resolvedUnixUser}:${resolvedUnixUser} ${defaultDocRoot}`,
      `chmod 755 ${defaultDocRoot}/hatalar`,
      `chmod 644 ${defaultDocRoot}/index.html ${defaultDocRoot}/anasayfa.html ${defaultDocRoot}/hatalar/404.html`,
    ].join(' && ');
    const setupResult = runSsh(setupCmd);
    expect(setupResult).not.toContain('No such file');

    // 4. Barındırma ayarlarına git: Başlangıç dosyaları ve Özel 404 sayfası tanımla
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // a) Başlangıç dosyaları (Index Files): anasayfa.html index.html
    const indexInput = page.locator('label:has-text("Başlangıç dosyaları") input');
    await expect(indexInput).toBeVisible({ timeout: 10000 });
    await indexInput.fill('anasayfa.html index.html');

    // SPA Fallback'i kapat (404 hata sayfalarının tetiklenebilmesi için Nginx =404 dönmelidir)
    const spaCheck = page.locator('label.ws-check:has-text("Bulunamayan sayfalarda index.html kullan") input[type="checkbox"]');
    if (await spaCheck.isVisible() && await spaCheck.isChecked()) {
      await spaCheck.uncheck();
    }

    // b) Özel hata sayfaları: 404 -> /hatalar/404.html
    const errorDetails = page.locator('details:has(summary:has-text("Özel hata sayfaları"))');
    await errorDetails.locator('summary').click();
    const err404Input = errorDetails.locator('label:has-text("404 hata sayfası") input');
    await expect(err404Input).toBeVisible({ timeout: 5000 });
    await err404Input.fill('/hatalar/404.html');

    // c) Ayarları kaydet ve uygula
    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 10000 });
    await saveBtn.click();

    // Yayına uygulanmasını bekle
    const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });

    // 5. Fiziksel Nginx dosya doğrulaması (SSH)
    const nginxConf = runSsh(`cat /etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf`);
    // a) indexFiles direktifi
    expect(nginxConf).toContain('index anasayfa.html index.html;');
    expect(nginxConf).toContain('try_files $uri $uri/ =404;');
    // b) error_page direktifi ve internal location
    expect(nginxConf).toContain('error_page 404 /hatalar/404.html;');
    expect(nginxConf).toContain('location = /hatalar/404.html {');
    expect(nginxConf).toContain('internal;');

    // 6. Fiziksel HTTP istek doğrulamaları
    // a) Başlangıç dosyası önceliği: GET / -> ONCELIKLI_ANASAYFA_INDEX dönmeli (varsayılan index.html ezilir)
    const indexRes = await checkHttp(siteDomain, '/');
    expect(indexRes.status).toBe(200);
    expect(indexRes.body).toContain('ONCELIKLI_ANASAYFA_INDEX');
    expect(indexRes.body).not.toContain('VARSAYILAN_INDEX');

    // b) Özel 404 hata sayfası: GET /mevcut-olmayan-yol.html -> status 404 ve özel HTML içeriği
    const errRes = await checkHttp(siteDomain, '/mevcut-olmayan-yol.html');
    expect(errRes.status).toBe(404);
    expect(errRes.body).toContain('OZEL_404_HATA_SAYFASI');
  });

  test('hatalı girdi: index/hata sayfası çakışması ve geçersiz index formatı reddedilir, Nginx konfigürasyonu korunur', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const indexInput = page.locator('label:has-text("Başlangıç dosyaları") input');
    const errorDetails = page.locator('details:has(summary:has-text("Özel hata sayfaları"))');
    if (!(await errorDetails.locator('label:has-text("404 hata sayfası") input').isVisible().catch(() => false))) {
      await errorDetails.locator('summary').click();
    }
    const err404Input = errorDetails.locator('label:has-text("404 hata sayfası") input');

    // 1. Durum: Hata sayfası ile başlangıç dosyası aynı dosya olamaz (çakışma doğrulaması)
    await indexInput.fill('anasayfa.html index.html');
    await err404Input.fill('/anasayfa.html');

    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();

    // Hata uyarısının belirmesi gerekir
    const errorNotice = page.locator('.ws-notice-error, [role="alert"], .ws-error');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(errorNotice).toContainText(/başlangıç dosyasıyla aynı olmamalı|Web sunucusu ayarlarını kontrol edin/i);

    // 2. Durum: Geçersiz index dosyası (dizin dışına çıkma traversal veya geçersiz format)
    await err404Input.fill('/hatalar/404.html'); // Hata sayfasını düzelt
    await indexInput.fill('../yasak.html');

    await saveBtn.click();
    await expect(errorNotice).toBeVisible({ timeout: 10000 });

    // Formu geçerli değerlere geri al ve Nginx konfigürasyonunun bozulmadığını SSH ile doğrula
    await indexInput.fill('anasayfa.html index.html');
    await saveBtn.click();
    await expect(page.locator('.ws-badge:has-text("Yayında (Güncel)")').first()).toBeVisible({ timeout: 30000 });

    // Fiziksel doğrulama: Nginx konfigürasyonu geçerli ve çalışır durumda kalmalı
    const nginxTest = runSsh('nginx -t 2>&1');
    expect(nginxTest).toContain('syntax is ok');
    expect(nginxTest).toContain('test is successful');
  });

  test('Plesk eşdeğerlik eksiklikleri: Parola korumalı dizinler, özel MIME türleri editörü ve Directory Browsing seçeneği', async ({ page }) => {
    test.fail(
      true,
      'BULGU RUN-04: Plesk üzerinde yer alan parola korumalı dizinler (Password-Protected Directories / Directory Protection), Apache & Nginx ayarlarındaki özel MIME türleri editörü (MIME Types) ve dizin listeleme açma/kapama seçeneği (Directory Browsing / Autoindex) YunPanel canlı arayüzünde bulunmamaktadır.',
    );

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // Plesk'teki yerleşik parola korumalı dizinler, MIME türleri yönetimi veya autoindex seçeneği aranır
    // Canlı YunPanel'de bu kontroller bulunmadığı için test.fail beklentisi gerçekleşecektir
    const protectedDirControl = page.locator('details:has(summary:has-text("Şifre korumalı dizinler")), a:has-text("Parola Korumalı Dizinler")');
    const mimeControl = page.locator('label:has-text("MIME"), [aria-label*="MIME"], input[name*="mime"]');
    const autoindexControl = page.locator('label:has-text("Dizin listeleme"), label:has-text("Directory Browsing"), input[name*="autoindex"]');

    await expect(protectedDirControl.or(mimeControl).or(autoindexControl)).toBeVisible({ timeout: 5000 });
  });
});
