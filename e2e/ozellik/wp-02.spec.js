import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('WP-02 WordPress Core, eklenti (plugin) ve tema (theme) yönetimi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `twp02-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.157.180.11.28.sslip.io`;
  const wpAdminUser = 'wpadmin';
  const wpAdminPass = 'WpSecurePass2026!#';
  const wpAdminEmail = 'wpadmin@example.test';
  const wpSiteTitle = `WP Core Plugin Test ${prefix}`;
  const testPluginSlug = 'classic-editor';

  let createdDomainId = null;
  let wpRootPath = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function findWpRoot(domain, domainId = createdDomainId) {
    if (domainId) {
      const direct = `/var/lib/yunpanel/apps/${domainId}/current/public`;
      const exists = runSsh(`test -d "${direct}" && echo "EXISTS"`);
      if (exists.includes('EXISTS')) return direct;
    }
    const raw = runSsh(`find /var/lib/yunpanel/apps -name wp-config.php -exec grep -l "${domain}" {} + 2>/dev/null | head -1`);
    if (raw && raw.includes('wp-config.php')) {
      return raw.replace(/\/wp-config\.php$/, '').trim();
    }
    const nginxRaw = runSsh(`grep -h 'root /' /etc/nginx/sites-enabled/*${domain}* 2>/dev/null | grep -v acme | head -1`);
    if (nginxRaw) {
      const match = nginxRaw.match(/root\s+([^;]+);?/);
      if (match) return match[1].trim();
    }
    return null;
  }

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
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
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

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: /Siteyi sil/ });
        if (await deleteBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: /Siteyi kalıcı olarak sil|Silme/ });
          if (await dialog.isVisible({ timeout: 8000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: /Silme işlemini başlat|Silme işlemine devam et/ });
            if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
              await submitBtn.click();
              const resumeBtn = page.locator('button', { hasText: /Silme işlemine devam et/ });
              if (await resumeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
                await resumeBtn.click();
                const resumeDialog = page.locator('.ws-modal, [role="dialog"]');
                if (await resumeDialog.isVisible({ timeout: 4000 }).catch(() => false)) {
                  const resumeSubmit = resumeDialog.locator('button[type="submit"]');
                  if (await resumeSubmit.isVisible().catch(() => false)) await resumeSubmit.click();
                }
              }
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 60000 }).catch(() => {});
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
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      if (createdDomainId) {
        await removeWebsiteById(page, createdDomainId, siteDomain);
      }
    } catch (err) {
      console.warn('Clean-up failed for domain:', createdDomainId, err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('ön hazırlık: PHP test web sitesi oluştur', async ({ page }) => {
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: PHP barındırma türü
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_php');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: DNS, HTTPS ve Posta ayarları
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const dnsSelect = page.locator('label:has-text("DNS yönetimi") select');
    if (await dnsSelect.isVisible()) {
      await dnsSelect.selectOption('external');
    }

    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    if (await httpsSelect.isVisible()) {
      await httpsSelect.selectOption('off');
    }

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu ve fiziksel adımların tamamlanmasını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    // Kurulum adımlarının bitmesini bekle: spinner kalkmalı ve "Site genel bakışı" görünür olmalı
    await expect(resultElement.locator('.ws-spinner')).toHaveCount(0, { timeout: 120000 });
    const overviewLink = resultElement.locator('a:has-text("Site genel bakışı")');
    await expect(overviewLink).toBeVisible({ timeout: 30000 });

    const href = await overviewLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Detay genel bakış sayfasına git ve sitenin hazır olduğunu doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1', { hasText: siteDomain })).toBeVisible({ timeout: 20000 });
  });

  test('WordPress kurulumu: temiz WordPress örneği kur', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    // Detay -> WordPress sekmesine git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/wordpress`);

    const installSection = page.locator('section').filter({ hasText: 'WordPress kur' });
    await expect(async () => {
      const retryBtn = page.locator('button:has-text("Yeniden dene")');
      if (await retryBtn.isVisible().catch(() => false)) {
        await retryBtn.click().catch(() => {});
      }
      await expect(installSection).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 60000, intervals: [2000, 3000, 5000] });

    await page.locator('label:has-text("Site başlığı") input').fill(wpSiteTitle);
    await page.locator('label:has-text("Yönetici kullanıcı adı") input').fill(wpAdminUser);
    await page.locator('label:has-text("Yönetici e-posta adresi") input').fill(wpAdminEmail);

    const pwInput = page.locator('label:has-text("Yönetici parolası") input');
    await pwInput.fill(wpAdminPass);

    const localeSelect = page.locator('label:has-text("Dil") select');
    await localeSelect.selectOption('en_US');

    const schemeSelect = page.locator('label:has-text("Site adresi") select');
    await schemeSelect.selectOption('http');

    const installBtn = page.locator('button[type="submit"]:has-text("WordPress kur")');
    await expect(installBtn).toBeEnabled();
    await installBtn.click();

    // Kurulumun bitmesini bekle
    const activeBadge = page.locator('.ws-badge').filter({ hasText: 'Kurulu' });
    await expect(activeBadge).toBeVisible({ timeout: 180000 });

    // Fiziksel WP root yolunu bul
    for (let i = 0; i < 15; i++) {
      wpRootPath = findWpRoot(siteDomain);
      if (wpRootPath) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(wpRootPath).toBeTruthy();
    expect(wpRootPath).toContain('/public');

    // wp-config.php dosyasının oluştuğunu ve HTTP 200 verdiğini doğrula
    const wpConfigExists = runSsh(`test -f "${wpRootPath}/wp-config.php" && echo "FOUND"`);
    expect(wpConfigExists).toContain('FOUND');

    const httpRes = await checkHttp(siteDomain);
    expect([200, 301, 302]).toContain(httpRes.status);
  });

  test('hatalı girdi: geçersiz eklenti ve tema paket adı formatı reddedilir', async ({ page, request }) => {
    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/wordpress`);

    // "Eklentiler" bölümünü bekle
    const pluginsSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Eklentiler' }) });
    await expect(pluginsSection).toBeVisible({ timeout: 30000 });

    // "Eklenti kur" butonuna tıkla
    const installPluginBtn = pluginsSection.locator('button:has-text("Eklenti kur")');
    await installPluginBtn.click();

    // Modal açıldığını doğrula
    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('header h2, h2')).toContainText('Eklenti kur');

    const packageInput = modal.locator('label:has-text("WordPress.org adı") input');
    await expect(packageInput).toBeVisible();

    // 1. Boş bırakıldığında required validation kontrolü (HTML5 valueMissing)
    const isRequired = await packageInput.evaluate((el) => el.validity.valueMissing);
    expect(isRequired).toBe(true);

    // Formu boş gönder butonuna tıklandığında formun submit olmaması gerekir (modal kapanmaz)
    const submitBtn = modal.locator('button[type="submit"]:has-text("Eklenti kur")');
    await submitBtn.click();
    await expect(modal).toBeVisible();

    // Modalı kapat
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible();

    // 2. Backend API doğrulaması: Geçersiz paket adı ile preview istendiğinde 400 Bad Request dönmeli
    const sessionRes = await page.request.get('/api/auth/session');
    const sessionData = await sessionRes.json();
    const csrfToken = sessionData.data?.csrfToken;
    expect(csrfToken).toBeTruthy();

    const apiRes = await page.evaluate(async ({ domainId, csrf }) => {
      const res = await fetch(`/api/panel/websites/${encodeURIComponent(domainId)}/wordpress/preview`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          options: {
            action: 'plugin.install',
            package: 'Invalid_Package_Name!@#',
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    }, { domainId: createdDomainId, csrf: csrfToken });

    expect(apiRes.status).toBe(400);
    expect(apiRes.data.error?.code || apiRes.data.code).toBe('wordpress_package_invalid');
  });

  test('mutlu yol: WordPress eklentisi kurma, etkinleştirme, devre dışı bırakma, silme ve fiziksel WP-CLI doğrulaması', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();
    if (!wpRootPath) {
      wpRootPath = findWpRoot(siteDomain);
    }
    console.log('[TEST] siteDomain:', siteDomain, 'wpRootPath:', wpRootPath);
    expect(wpRootPath).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/wordpress`);

    // 1. "Eklentiler" bölümünden yeni eklenti kur
    const pluginsSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Eklentiler' }) });
    await expect(pluginsSection).toBeVisible({ timeout: 30000 });

    await pluginsSection.locator('button:has-text("Eklenti kur")').click();
    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });

    const packageInput = modal.locator('label:has-text("WordPress.org adı") input');
    await packageInput.fill(testPluginSlug);
    expect(await packageInput.evaluate((el) => el.checkValidity())).toBe(true);

    await modal.locator('button[type="submit"]:has-text("Eklenti kur")').click();

    // Kurulum işleminin tamamlanmasını bekle
    // Eklentiler tablosunda classic-editor belirmeli
    const pluginRow = pluginsSection.locator('table.ws-table tr').filter({ hasText: testPluginSlug });
    await expect(pluginRow).toBeVisible({ timeout: 120000 });

    // Başlangıç durumu: Devre dışı
    await expect(pluginRow.locator('.ws-badge')).toContainText('Devre dışı');

    // --- FİZİKSEL KANIT 1: Eklenti dosyalarının indirildiği doğrulanır ---
    let checkFile = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      checkFile = runSsh(`test -f "${wpRootPath}/wp-content/plugins/${testPluginSlug}/${testPluginSlug}.php" && echo "EXISTS"`);
      if (checkFile.includes('EXISTS')) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    expect(checkFile).toContain('EXISTS');

    // 2. Eklentiyi Etkinleştir
    const activateBtn = pluginRow.locator('button:has-text("Etkinleştir")');
    await expect(activateBtn).toBeVisible();
    await activateBtn.click();

    // Etkin durumuna geçmesini bekle
    await expect(async () => {
      const text = await pluginRow.locator('.ws-badge').textContent().catch(() => '');
      if (!text?.includes('Etkin')) {
        const refreshBtn = page.locator('button:has-text("Yenile")').first();
        if (await refreshBtn.isVisible().catch(() => false)) await refreshBtn.click().catch(() => {});
      }
      expect(text).toContain('Etkin');
    }).toPass({ timeout: 60000, intervals: [2000, 3000, 5000] });

    await expect(pluginRow.locator('button:has-text("Devre dışı bırak")')).toBeVisible({ timeout: 15000 });

    // --- FİZİKSEL KANIT 2: WP-CLI ile eklentinin aktif olduğu doğrulanır ---
    let wpCliCheckActive = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      wpCliCheckActive = runSsh(`/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path="${wpRootPath}" plugin is-active ${testPluginSlug} && echo "IS_ACTIVE"`);
      if (wpCliCheckActive.includes('IS_ACTIVE')) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    expect(wpCliCheckActive).toContain('IS_ACTIVE');

    // HTTP üzerinden sitenin sağlıklı çalıştığını doğrula
    const httpRes = await checkHttp(siteDomain, '/');
    expect(httpRes.status).toBe(200);

    // 3. Eklentiyi Devre Dışı Bırak
    const deactivateBtn = pluginRow.locator('button:has-text("Devre dışı bırak")');
    await deactivateBtn.click();

    await expect(async () => {
      const text = await pluginRow.locator('.ws-badge').textContent().catch(() => '');
      if (!text?.includes('Devre dışı')) {
        const refreshBtn = page.locator('button:has-text("Yenile")').first();
        if (await refreshBtn.isVisible().catch(() => false)) await refreshBtn.click().catch(() => {});
      }
      expect(text).toContain('Devre dışı');
    }).toPass({ timeout: 60000, intervals: [2000, 3000, 5000] });

    await expect(pluginRow.locator('button:has-text("Etkinleştir")')).toBeVisible({ timeout: 15000 });

    // --- FİZİKSEL KANIT 3: WP-CLI ile eklentinin pasif olduğu doğrulanır ---
    let wpCliCheckInactive = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      wpCliCheckInactive = runSsh(`/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path="${wpRootPath}" plugin is-active ${testPluginSlug} || echo "INACTIVE"`);
      if (wpCliCheckInactive.includes('INACTIVE')) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    expect(wpCliCheckInactive).toContain('INACTIVE');

    // 4. Eklentiyi Kaldır (Sil)
    const removeBtn = pluginRow.locator('button.ws-button-danger, button:has-text("Kaldır")');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Eklentinin tablodan silinmesini bekle
    await expect(async () => {
      const count = await pluginsSection.locator('table.ws-table tr').filter({ hasText: testPluginSlug }).count();
      if (count > 0) {
        const refreshBtn = page.locator('button:has-text("Yenile")').first();
        if (await refreshBtn.isVisible().catch(() => false)) await refreshBtn.click().catch(() => {});
      }
      expect(count).toBe(0);
    }).toPass({ timeout: 60000, intervals: [2000, 3000, 5000] });

    // --- FİZİKSEL KANIT 4: Eklenti dizininin tamamen silindiği doğrulanır ---
    let checkFileDeleted = '';
    for (let attempt = 0; attempt < 10; attempt++) {
      checkFileDeleted = runSsh(`test -d "${wpRootPath}/wp-content/plugins/${testPluginSlug}" || echo "DELETED"`);
      if (checkFileDeleted.includes('DELETED')) break;
      await new Promise(r => setTimeout(r, 1500));
    }
    expect(checkFileDeleted).toContain('DELETED');

    // 5. Temalar tablosunun kontrolü
    const themesSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Temalar' }) });
    await expect(themesSection).toBeVisible();
    const themeRows = themesSection.locator('table.ws-table tr');
    await expect(themeRows.first()).toBeVisible();
    // Varsayılan temanın aktif olduğunu doğrula
    await expect(themesSection.locator('.ws-badge:has-text("Etkin")')).toBeVisible();

    // 6. WordPress'i güncelle (Core update) butonu
    const updateCoreBtn = page.locator('button:has-text("WordPress’i güncelle")');
    await expect(updateCoreBtn).toBeVisible();
  });

  test('Plesk eşdeğerlik eksikliği: eklenti ve tema otomatik güncelleme kuralları, ZIP yükleme ve depo kataloğu', async ({ page }) => {
    test.fail(true, 'BULGU WP-02: Plesk WordPress Toolkit eşdeğerliği eksik — Panelde eklenti/tema otomatik güncelleme (Auto-updates/Smart Updates) politikaları, ZIP ile eklenti yükleme ve WordPress.org arama kataloğu arayüzü bulunmuyor.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/wordpress`);
    await expect(page.locator('h2, h3', { hasText: 'Eklentiler' }).first()).toBeVisible({ timeout: 15000 });

    // Plesk WP Toolkit'te bulunan otomatik güncelleme (Auto-updates) ayarları veya ZIP yükleme butonları aranır
    const autoUpdateToggle = page.locator('button:has-text("Otomatik Güncelleme"), button:has-text("Auto-update"), input[name="autoupdate"]');
    await expect(autoUpdateToggle).toBeVisible({ timeout: 4000 });
  });
});
