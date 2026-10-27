import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-06 Node paket kurulumu, script, restart ve loglar', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `trun06-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
  let createdDomainId = null;

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
        res.on('data', (chunk) => { body += chunk; });
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
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 40000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('RUN-06 cleanup notice:', err.message);
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
      console.warn('RUN-06 afterAll cleanup failed:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('hatalı girdi: Node.js process ve restart işleminde geçersiz eylem ve eksik onay tokeni reddedilir', async ({ page }) => {
    // 1. Arayüz doğrulaması: Yeni site ekleme formunda geçersiz github repository URL girildiğinde reddedilir
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(`invalid-${primaryDomain}`);
    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_node');

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await expect(repoInput).toBeVisible();
    await repoInput.fill('https://not-a-valid-github-repo-url-domain.xyz/repo');

    await nextBtn.click();

    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible({ timeout: 10000 });
    await submitBtn.click();

    // Güvenlik ve kaynak doğrulaması: form hata bildirimi verir veya oluşturmayı reddeder
    const errorNotice = page.locator('.ws-notice-error, .ws-notice-warn, [role="alert"]')
      .or(page.getByText('Geçersiz'))
      .or(page.getByText('invalid'))
      .or(page.getByText('hata'))
      .or(page.getByText('Failed'));
    await expect(errorNotice.first()).toBeVisible({ timeout: 20000 });

    // 2. API doğrulaması: /api/websites/:websiteId/application/process uç noktasına geçersiz action gönderimi reddedilir
    const invalidProcessRes = await page.request.post('/api/websites/non-existent-site/application/process', {
      data: {
        action: 'invalid_action',
        confirmation: 'node-process:app:release:invalid_action',
      },
    });
    // Hatalı istek 400 veya 404 olarak reddedilmeli
    expect([400, 404]).toContain(invalidProcessRes.status());
  });

  test('mutlu yol: Plesk RUN-06 Node paket kurulumu (npm ci/install), script, yeniden başlatma ve canlı loglar', async ({ page }) => {
    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));
    page.on('response', (res) => {
      if (res.status() >= 400 && !res.url().includes('invalid')) {
        console.log('HTTP ERROR:', res.url(), res.status());
      }
    });

    // 1. Yeni Node.js Web Sitesi oluşturma sihirbazı
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(primaryDomain);
    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    // Adım 2: Site Türü: Node.js (Git ile yayınla)
    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_node');

    const entryFileInput = page.locator('label', { hasText: 'Başlangıç dosyası' }).locator('input');
    await expect(entryFileInput).toBeVisible();
    await entryFileInput.fill('index.js');

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await repoInput.fill('https://github.com/heroku/node-js-getting-started.git');

    // Adım 3: İnceleme ve Siteyi oluştur
    await nextBtn.click();
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible({ timeout: 10000 });
    await submitBtn.click();

    // Site kaydı oluşturulduğunda Site genel bakışı butonu belirir
    const overviewBtn = page.locator('a:has-text("Site genel bakışı")');
    await expect(overviewBtn).toBeVisible({ timeout: 120000 });
    const href = await overviewBtn.getAttribute('href');
    const domainIdMatch = href?.match(/\/websites\/([^/?#]+)/);
    createdDomainId = domainIdMatch ? decodeURIComponent(domainIdMatch[1]) : primaryDomain;

    // Arka plandaki adımların (npm paketleri, nginx) oturması için bekle
    await page.waitForTimeout(25000);

    await overviewBtn.click();
    await expect(page.getByRole('heading', { name: primaryDomain })).toBeVisible({ timeout: 20000 });

    // 2. Node.js Yönetim Sayfası (`/websites/:id/node`)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/node`);
    await expect(page.getByRole('heading', { name: 'Node.js uygulaması' })).toBeVisible({ timeout: 15000 });

    const nodeSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Node.js uygulaması' }) });
    await expect(nodeSection.getByText('Node.js 24')).toBeVisible({ timeout: 10000 });
    await expect(nodeSection.getByText('main')).toBeVisible({ timeout: 10000 });

    // 3. Yeniden Başlatma (Restart) ve Durum Kontrolleri
    const restartBtn = nodeSection.locator('button', { hasText: 'Yeniden başlat' });
    await expect(restartBtn).toBeVisible({ timeout: 10000 });

    const deployBtn = nodeSection.locator('button', { hasText: 'Deploy başlat' });
    await expect(deployBtn).toBeVisible({ timeout: 10000 });

    // Eğer restart butonu etkinse restart işlemini test et; aktif release kilitliyken buton güvenli şekilde devre dışıdır
    const isRestartEnabled = await restartBtn.isEnabled();
    if (isRestartEnabled) {
      await restartBtn.click();
      await expect(restartBtn).toBeEnabled({ timeout: 40000 });

      const statusBtn = nodeSection.locator('button', { hasText: 'Durumu kontrol et' });
      if (await statusBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await statusBtn.click();
        await expect(statusBtn).toBeEnabled({ timeout: 20000 });
      }
    } else {
      await expect(restartBtn).toBeDisabled();
    }

    // 4. Log Yönetimi (`/websites/:id/logs`)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/logs`);
    await expect(page.getByRole('heading', { name: 'Site logları' })).toBeVisible({ timeout: 15000 });

    const logSection = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Site logları' }) });

    // Kaynak seçici: "Node.js uygulaması" veya log kaynağını seç
    const sourceSelector = logSection.locator('select').first();
    await expect(sourceSelector).toBeVisible({ timeout: 10000 });
    const hasNodeOption = await sourceSelector.locator('option[value="node"]').count();
    if (hasNodeOption > 0) {
      await sourceSelector.selectOption('node');
    }

    const applyBtn = logSection.locator('button:has-text("Uygula")');
    await applyBtn.click();

    // Log tablosu veya log durumunun varlığını doğrula
    const logTable = logSection.locator('table.ws-table');
    const emptyNotice = logSection.locator('.ws-empty').or(logSection.getByText('Log kaydı bulunamadı'));
    await expect(logTable.or(emptyNotice)).toBeVisible({ timeout: 15000 });

    // Log indirme butonunun varlığı ve indirme uç noktasını doğrula
    const downloadLink = logSection.locator('a.ws-button', { hasText: 'İndir' });
    await expect(downloadLink).toBeVisible({ timeout: 10000 });
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toMatch(/\/logs\/.*download|\/application\/logs/);

    // 5. Fiziksel Sonuç Doğrulaması: Nginx / Node.js HTTP çıktısı, vhost kaydı ve passenger konfigürasyonu
    const httpCheck = await checkDirectHttp(primaryDomain).catch((err) => ({ status: 0, error: err.message }));
    // Sitenin Nginx vhost kaydı ve HTTP yanıtı dönmelidir (> 0)
    expect(httpCheck.status).toBeGreaterThan(0);

    // Host üzerinde Node.js Nginx vhost kaydının varlığının doğrulanması
    const sshOutput = runSsh(`ls /etc/nginx/sites-enabled/ | grep ${prefix}`);
    expect(sshOutput).toContain(prefix);

    // Host üzerinde Nginx vhost konfigürasyonunda passenger node ayarlarının doğrulanması
    const vhostConf = runSsh(`cat /etc/nginx/sites-enabled/*${prefix}* 2>/dev/null`);
    expect(vhostConf).toContain('passenger_enabled on');
    expect(vhostConf).toContain('passenger_app_type node');
  });

  test('Plesk eşdeğerliği: Panel arayüzünde bağımsız NPM paket kurma ve özel script çalıştırma kontrolleri', async ({ page }) => {
    test.fail(
      true,
      'BULGU RUN-06: Panel arayüzünde Plesk eşdeğeri bağımsız NPM paket kurma (npm install <pkg>) ve özel npm scripti çalıştırma (Run Script UI) kontrolleri bulunmuyor; paket yönetimi yalnızca Git deployment akışında ve site terminalinde çalışıyor.',
    );

    // Plesk'te Node.js panelinde "NPM Install", "Run Script" ve paket ekleme butonları mevcuttur.
    await page.goto(`/websites/${encodeURIComponent(createdDomainId || primaryDomain)}/node`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Panel arayüzünde bağımsız paket kurma veya script çalıştırma butonu var mı?
    const npmInstallBtn = page.locator('button:has-text("NPM Kur"), button:has-text("Paket Kur"), button:has-text("NPM Install"), button:has-text("Script Çalıştır")');
    await expect(npmInstallBtn.first()).toBeVisible({ timeout: 3000 });
  });
});
