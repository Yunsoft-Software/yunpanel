import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('RUN-01 Document root, sistem kullanıcısı ve hosting ayarları', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `trun01-a${agentN}-${Date.now().toString(36)}`;
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
        res.on('data', chunk => { body += chunk; });
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
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('Clean-up failed for domain:', createdDomainId, err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: site oluştur, sistem kullanıcısı ve izolasyonunu doğrula, document root değiştir ve Nginx yayına al', async ({ page }) => {
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

    // E-posta / Webmail seçeneğini temizle
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

    // 2. Erişim hesapları ve sistem kullanıcısını doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/access`);
    await expect(page.locator('h2, h3', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });

    // İzolasyon durumu rozetini kontrol et (ws-badge filtrelenerek strict mode çakışması önlenir)
    await expect(page.locator('.ws-badge').filter({ hasText: 'Dedicated Unix kullanıcısı (İzole)' })).toBeVisible({ timeout: 10000 });

    // Kullanıcı adı ve Belge kök dizini bilgilerini oku
    const userRow = page.locator('dt:has-text("Kullanıcı adı") + dd');
    await expect(userRow).toBeVisible();
    resolvedUnixUser = (await userRow.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]+$/);

    const docRootRow = page.locator('dt:has-text("Belge kök dizini (Docroot)") + dd');
    await expect(docRootRow).toBeVisible();
    defaultDocRoot = (await docRootRow.textContent()).trim();
    expect(defaultDocRoot).toContain('/var/www/yunpanel/apps/');
    expect(defaultDocRoot).toMatch(/\/current$/);

    // Fiziksel Kontrol (SSH): Sistem kullanıcısının Linux seviyesinde varlığı ve kök dizin sahipliği
    const idCheck = runSsh(`id ${resolvedUnixUser}`);
    expect(idCheck).toContain(`uid=`);
    expect(idCheck).toContain(`gid=`);
    expect(idCheck).not.toContain('uid=0('); // root olmamalı

    // Panel politikasınca alt belge kök dizini önceden mevcut olmalıdır; public alt dizinini ve test dosyasını oluştur
    const targetSubDoc = `${defaultDocRoot}/public`;
    runSsh(`mkdir -p ${targetSubDoc} && echo "<h1>RUN-01 OK</h1>" > ${targetSubDoc}/index.html && chown -R ${resolvedUnixUser}:${resolvedUnixUser} ${targetSubDoc}`);
    const subDirCheck = runSsh(`test -d ${targetSubDoc} && echo OK`);
    expect(subDirCheck).toBe('OK');

    // 3. Barındırma ayarları: Document root değiştir ve yayına uygula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const docRootInput = page.locator('label:has-text("Document root") input');
    await expect(docRootInput).toBeVisible({ timeout: 10000 });
    await docRootInput.fill('public');

    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 15000 });
    await saveBtn.click();

    // Barındırma ayarlarının başarıyla uygulanmasını bekle
    const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });

    // 4. Fiziksel Sonuç (SSH): Nginx yapılandırma dosyasında güncel document root kontrolü
    const nginxConf = runSsh(`cat /etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf`);
    expect(nginxConf).toContain(`root ${defaultDocRoot}/public;`);
    expect(nginxConf).toContain(`disable_symlinks on from=${defaultDocRoot};`);

    // 5. Fiziksel Sonuç (HTTP): 157.180.11.28 IP'sine Host başlığıyla istek at
    const httpRes = await checkHttp(siteDomain);
    expect(httpRes.status).toBe(200);
    expect(httpRes.body).toContain('<h1>RUN-01 OK</h1>');
    expect(httpRes.headers['server'] || '').toContain('nginx');
  });

  test('hatalı girdi: geçersiz document root (path traversal / absolute path) reddedilir ve Nginx config korunur', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const docRootInput = page.locator('label:has-text("Document root") input');
    await expect(docRootInput).toBeVisible({ timeout: 10000 });

    // Kök dizin dışına çıkma (path traversal) denemesi
    await docRootInput.fill('../../../etc/passwd');

    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Form doğrulaması hata bildirmeli
    const errorNotice = page.locator('.ws-notice-error, [role="alert"]').or(page.locator('.ws-error'));
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(errorNotice).toContainText(/Web sunucusu ayarlarını kontrol edin|Document root/i);

    // Fiziksel Kontrol (SSH): Nginx config dosyasında geçersiz traversal yolunun YER ALMADIĞI doğrulanır
    const nginxConf = runSsh(`cat /etc/nginx/sites-enabled/yunpanel-${siteDomain}.conf`);
    expect(nginxConf).not.toContain('/etc/passwd');
    expect(nginxConf).not.toContain('../');
    expect(nginxConf).toContain(`root ${defaultDocRoot}/public;`); // Önceki geçerli document root korunmalı
  });
});
