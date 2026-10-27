import http from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('MON-03 Domain web istatistikleri, trafik ve kullanım raporları', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tmon03-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;
  let createdWebsiteId = null;

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

  function sendProbeRequest(host, path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: {
          Host: host,
          'User-Agent': 'Playwright-MON03-Probe/1.0',
        },
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
    if (createdWebsiteId) {
      runSsh(`kill $(cat /run/yunpanel/goaccess/${createdWebsiteId}.pid 2>/dev/null) 2>/dev/null || true`);
      runSsh(`rm -f /var/lib/yunpanel/reports/goaccess/${createdWebsiteId}.html /run/yunpanel/goaccess/${createdWebsiteId}.* 2>/dev/null || true`);
    }
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

  test('mutlu yol: GoAccess web istatistiklerini görüntüle, statik rapor üret, HTML raporunu aç ve gerçek zamanlı servisi yönet', async ({ page }) => {
    // 1. Statik web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');
    await page.click('button[type="submit"]:has-text("Devam et")');

    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');
    await page.click('button[type="submit"]:has-text("Devam et")');

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Trafik oluşturmak için web sitesine probe HTTP istekleri gönder
    const probePath1 = `/traffic-probe-p1-${randomUUID().slice(0, 8)}`;
    const probePath2 = `/traffic-probe-p2-${randomUUID().slice(0, 8)}`;
    await sendProbeRequest(siteDomain, probePath1);
    await sendProbeRequest(siteDomain, probePath2);

    // 3. Sitenin "İstatistikler" sekmesine geç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/analytics`);
    const analyticsSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'İstatistikler' }) });
    await expect(analyticsSection).toBeVisible({ timeout: 15000 });
    await expect(analyticsSection).toContainText('Nginx erişim günlüğünden GoAccess raporu oluşturun');

    // GoAccess durum değerlerini doğrula
    await expect(analyticsSection.locator('text=Kullanılabilir')).toBeVisible({ timeout: 10000 });
    const staticReportLink = analyticsSection.locator('a:has-text("Statik raporu aç")');
    await expect(staticReportLink).toBeVisible({ timeout: 10000 });

    const reportHref = await staticReportLink.getAttribute('href');
    expect(reportHref).toContain('/analytics/report?format=html');
    const websiteIdMatch = reportHref.match(/\/websites\/([^/?#]+)\/analytics/);
    expect(websiteIdMatch).toBeTruthy();
    createdWebsiteId = websiteIdMatch[1];

    // 4. "Statik raporu yenile" butonuna tıkla ve rapor üretimini doğrula
    const refreshReportBtn = analyticsSection.locator('button:has-text("Statik raporu yenile")');
    await expect(refreshReportBtn).toBeEnabled({ timeout: 5000 });
    await refreshReportBtn.click();

    // Rapor üretildikten sonra son statik rapor bilgisi güncellenmeli (Bu oturumda oluşturulmadı yazısı kalkmalı)
    await expect(analyticsSection.locator('text=Bu oturumda oluşturulmadı')).toBeHidden({ timeout: 15000 });

    // 5. Statik HTML raporunu doğrula (API üzerinden dönen gerçek HTML içeriği)
    const reportResponse = await page.request.get(reportHref);
    expect(reportResponse.status()).toBe(200);
    expect(reportResponse.headers()['content-type']).toContain('text/html');
    const htmlBody = await reportResponse.text();
    expect(htmlBody).toContain('GoAccess');

    // 6. Gerçek zamanlı servis yönetimi (Owner yetkisi)
    const realtimeSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Gerçek zamanlı istatistik servisi' }) });
    await expect(realtimeSection).toBeVisible({ timeout: 10000 });

    const startBtn = realtimeSection.locator('button:has-text("Başlat")');
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await startBtn.click();

    // Çalışıyor rozetini ve buton değişimini bekle
    await expect(realtimeSection.locator('text=Çalışıyor')).toBeVisible({ timeout: 15000 });
    const stopBtn = realtimeSection.locator('button:has-text("Durdur")');
    await expect(stopBtn).toBeVisible({ timeout: 10000 });

    // Gerçek zamanlı görünüm linkinin belirdiğini doğrula
    const realtimeViewLink = analyticsSection.locator('a:has-text("Gerçek zamanlı görünümü aç")');
    await expect(realtimeViewLink).toBeVisible({ timeout: 10000 });
    expect(await realtimeViewLink.getAttribute('href')).toContain(`/tools/goaccess/${createdWebsiteId}/`);

    // Servisi durdur
    await stopBtn.click();
    await expect(realtimeSection.locator('text=Durduruldu')).toBeVisible({ timeout: 15000 });
  });

  test('hatalı girdi: geçersiz website kimliği ve parametrelerle istatistik sorguları reddedilir', async ({ page }) => {
    // 1. Olmayan UUID ile API çağrıları güvenli şekilde 400, 403 veya 404 ile reddedilmelidir
    const nonExistentId = randomUUID();
    const notFoundStatusRes = await page.request.get(`/api/panel/websites/${nonExistentId}/analytics/status`);
    expect([400, 403, 404]).toContain(notFoundStatusRes.status());

    const notFoundReportRes = await page.request.get(`/api/panel/websites/${nonExistentId}/analytics/report`);
    expect([400, 403, 404]).toContain(notFoundReportRes.status());

    const notFoundRealtimeRes = await page.request.post(`/api/panel/websites/${nonExistentId}/analytics/realtime/start`);
    expect([400, 403, 404]).toContain(notFoundRealtimeRes.status());

    // 2. Geçersiz ID formatı güvenli şekilde reddedilmeli
    const invalidIdRes = await page.request.get('/api/panel/websites/invalid_unsafe_id!@#/analytics/status');
    expect([400, 403, 404, 500]).toContain(invalidIdRes.status());

    // 3. UI'da var olmayan bir domain ID ile analytics sayfasına gidildiğinde hata durumu gösterilmeli
    await page.goto(`/websites/${nonExistentId}/analytics`);
    const emptyNotice = page.locator('text=İstatistikler açılamadı').or(page.locator('text=bulunamadı'));
    await expect(emptyNotice.first()).toBeVisible({ timeout: 10000 });
  });

  test('fiziksel kanıt: Nginx erişim günlüğü, GoAccess ikili dosyası ve üretilen HTML rapor dosyası doğrulanır', async ({ page }) => {
    // 1. Sunucuda GoAccess ikili dosyası mevcuttur ve çalışmaktadır
    const goaccessVersionOutput = runSsh('goaccess --version');
    expect(goaccessVersionOutput).toContain('GoAccess');

    // 2. Nginx vhost erişim log dosyası mevcuttur
    const accessLogCheck = runSsh(`ls -la /var/log/nginx/${siteDomain}.access.log`);
    expect(accessLogCheck).toContain(`${siteDomain}.access.log`);

    // 3. GoAccess tarafından üretilen fiziksel HTML rapor dosyası mevcuttur
    if (createdWebsiteId) {
      const reportFileCheck = runSsh(`ls -la /var/lib/yunpanel/reports/goaccess/${createdWebsiteId}.html`);
      expect(reportFileCheck).toContain(`${createdWebsiteId}.html`);

      // 4. Panel analytics status API'si çalışır durumdadır
      const statusRes = await page.request.get(`/api/panel/websites/${createdWebsiteId}/analytics/status`);
      expect(statusRes.status()).toBe(200);
      const statusData = (await statusRes.json()).data;
      expect(statusData.available).toBe(true);
      expect(statusData.websiteId).toBe(createdWebsiteId);
    }
  });

  test('Plesk eşdeğerliği: Tarih aralıklı trafik/bant genişliği kullanım grafikleri ve istatistik sağlayıcı yapılandırması', async ({ page }) => {
    test.fail(true, 'BULGU MON-03: Plesk eşdeğeri tarih aralıklı trafik/bant genişliği kullanım raporları, protokol kırılımı (HTTP/FTP/Mail) ve istatistik sağlayıcı seçim ayarları eksik');

    if (!createdDomainId) {
      await page.goto('/websites');
      const firstManage = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
      await firstManage.click();
    } else {
      await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/analytics`);
    }

    // Plesk'te tarih aralığı filtresi (günlük/aylık trafik tablosu) veya Awstats/Webalizer seçimi aranır
    const pleskTrafficFilters = page.locator('input[type="date"], select:has-text("Aylık"), select:has-text("Günlük"), text=Bant Genişliği Kullanımı, text=Webalizer, text=Awstats');
    await expect(pleskTrafficFilters.first()).toBeVisible({ timeout: 5000 });
  });
});
