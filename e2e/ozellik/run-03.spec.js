import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-03 Apache/Nginx ayarları, ek direktifler ve testli uygulama', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `trun03-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(`${command} 2>&1`)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function checkHttp(host) {
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
      const deleteBtn = page.locator('button:has-text("Siteyi sil…")');
      await deleteBtn.waitFor({ state: 'visible', timeout: 20000 });
      await deleteBtn.click();
      const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const input = dialog.locator('input');
      await input.fill(domainName);
      const submitBtn = dialog.locator('button:has-text("Silme işlemini başlat"), button[type="submit"]');
      await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
      await submitBtn.click();
      const doneBtn = page.locator('button:has-text("Web sitelerine dön")');
      await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 45000 }).catch(() => {});
      if (await doneBtn.isVisible().catch(() => false)) {
        await doneBtn.click();
      }
    } catch (err) {
      console.warn('Cleanup notice:', err.message);
    }
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('Clean-up failed for domain:', createdDomainId, err.message);
    } finally {
      await page.close().catch(() => {});
      runSsh(`rm -f /etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf && nginx -t && systemctl reload nginx || true`);
    }
  });

  test('mutlu yol: site oluştur, Nginx ayarları ve ek direktifleri (client_max_body_size, custom headers, static cache) uygula ve canlı vhost + HTTP yanıtını doğrula', async ({ page }) => {
    // 1. Yeni statik test web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Statik barındırma türünü seç
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu onayla
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible().catch(() => false) && await mailCheck.isChecked().catch(() => false)) {
      await mailCheck.uncheck();
    }

    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    // Kurulum sonucunu bekle ve domain ID al
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Barındırma / Web Sunucusu ayarları sekmesine git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // En büyük yükleme boyutu (MB) ayarla -> 64
    const bodySizeInput = page.locator('label:has-text("En büyük yükleme boyutu") input');
    await expect(bodySizeInput).toBeVisible({ timeout: 10000 });
    await bodySizeInput.fill('64');

    // Özel yanıt başlığı (Custom Header directive) ekle
    const addHeaderBtn = page.locator('button', { hasText: 'Yanıt başlığı ekle' });
    await expect(addHeaderBtn).toBeVisible();
    await addHeaderBtn.click();

    // Yeni eklenen başlık inputlarını doldur
    const headerNameInput = page.locator('input[pattern="[A-Za-z][A-Za-z0-9-]*"]').first();
    await expect(headerNameInput).toBeVisible({ timeout: 5000 });
    await headerNameInput.fill('X-Run03-Directive');

    const headerValueInput = page.locator('label:has-text("Başlık 1 değeri") input');
    await headerValueInput.fill('Antigravity-Verified');

    // "Kaydet ve uygula" butonuna bas
    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 10000 });
    await saveBtn.click();

    // Yapılandırma kontrolü ve uygulama durumunu bekle
    const badgeActive = page.locator('.ws-actions .ws-badge, .ws-actions .badge').filter({ hasText: /Yayında \(Güncel\)|Yayında/i });
    await expect(badgeActive.first()).toBeVisible({ timeout: 60000 });

    // 3. Fiziksel Sonuç 1 (SSH - Vhost dosyası): Nginx konfigürasyonunu doğrula
    const vhostPath = `/etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf`;
    const nginxConf = runSsh(`cat ${vhostPath}`);
    expect(nginxConf).toContain('client_max_body_size 64m;');
    expect(nginxConf).toContain('add_header X-Run03-Directive "Antigravity-Verified" always;');

    // 4. Fiziksel Sonuç 2 (SSH - Nginx syntax testi): `nginx -t` başarı kontrolü
    const nginxTestOutput = runSsh('nginx -t');
    expect(nginxTestOutput).toContain('syntax is ok');
    expect(nginxTestOutput).toContain('test is successful');

    // Statik dosya köküne test içeriği yerleştirerek HTTP isteğini doğrula
    const rootMatch = nginxConf.match(/root\s+(\/var\/www\/[^\s;]+);/);
    if (rootMatch) {
      const docRoot = rootMatch[1];
      runSsh(`mkdir -p ${docRoot} && echo "<h1>RUN-03 OK</h1>" > ${docRoot}/index.html`);
    }

    // 5. Fiziksel Sonuç 3 (HTTP): Sunucuya canlı HTTP isteği at ve yanıt başlıklarını doğrula
    const httpRes = await checkHttp(siteDomain);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toContain('<h1>RUN-03 OK</h1>');
    expect(httpRes.headers['x-run03-directive']).toBe('Antigravity-Verified');
    expect(httpRes.headers['server'] || '').toContain('nginx');
  });

  test('hatalı girdi: geçersiz Nginx ayarları ve sınır dışı değerler reddedilir, rollback ile mevcut config korunur', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // 1. Sınır dışı En büyük yükleme boyutu gir (desteklenen aralık 1–1024 MB; 99999 gir)
    const bodySizeInput = page.locator('label:has-text("En büyük yükleme boyutu") input');
    await expect(bodySizeInput).toBeVisible({ timeout: 10000 });
    await bodySizeInput.fill('99999');

    // Form submit denemesi
    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // HTML5 / UI seviyesinde doğrulama veya backend hatası
    const isHtml5Invalid = await bodySizeInput.evaluate((el) => !el.checkValidity());
    const errorNotice = page.locator('.ws-notice-error, [role="alert"], .ws-error, .ws-notice-warn');
    const hasErrorNotice = await errorNotice.isVisible().catch(() => false);

    expect(isHtml5Invalid || hasErrorNotice).toBe(true);

    // 2. Fiziksel Sonuç (SSH): Nginx vhost dosyasının bozulmadığı, önceki 64m ayarının korunduğu doğrulanır
    const vhostPath = `/etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf`;
    const nginxConf = runSsh(`cat ${vhostPath}`);
    expect(nginxConf).toContain('client_max_body_size 64m;');
    expect(nginxConf).not.toContain('client_max_body_size 99999m;');

    // 3. Fiziksel Sonuç (SSH): Nginx servis sözdiziminin sağlam kaldığı doğrulanır
    const nginxTestOutput = runSsh('nginx -t');
    expect(nginxTestOutput).toContain('syntax is ok');
  });

  test('Plesk paritesi: serbest metin Ek Nginx Direktifleri (Additional nginx directives) ve Apache direktifleri alanı', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan serbest metin "Additional nginx directives" (Ek Nginx direktifleri textarea)
    // ve "Additional Apache directives" alanlarının YunPanel'de olup olmadığını kontrol et
    const rawDirectivesTextarea = page.locator('textarea[name*="directive"], textarea[placeholder*="directive"], label:has-text("Ek direktifler") textarea, label:has-text("Additional directives") textarea');
    const apacheSettingsSection = page.locator('h2, h3, legend').filter({ hasText: /Apache/i });

    const hasRawDirectives = await rawDirectivesTextarea.isVisible().catch(() => false);
    const hasApacheSettings = await apacheSettingsSection.isVisible().catch(() => false);

    // YunPanel güvenlik ve deklaratif yapı nedeniyle serbest metin raw direktif kutusu ve Apache sunucusu sunmaz
    if (!hasRawDirectives || !hasApacheSettings) {
      test.fail(
        true,
        'PLESK PARITY: YunPanel arayüzünde Plesk eşdeğeri serbest metin "Ek Nginx Direktifleri" (Additional nginx directives) ve "Apache ayarları/direktifleri" yer almıyor; deklaratif form alanları (headers, gzip, limits, redirects) kullanılıyor.',
      );
    }
    expect(hasRawDirectives).toBe(true);
    expect(hasApacheSettings).toBe(true);
  });
});
