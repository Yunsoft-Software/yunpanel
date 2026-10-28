import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('MON-05 Servis watchdog/yeniden başlatma ve disk izleme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

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

  async function getApiHeaders(page) {
    const origin = 'https://server.cryptoraichu.website';
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      Referer: `${origin}/`,
      'x-csrf-token': csrf,
      'Content-Type': 'application/json',
    };
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    // 0 Artık ilkesi: Panel ve servis durumlarının stabil kaldığını doğrula
    const page = await browser.newPage();
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const res = await page.request.get('/api/panel/servers');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);

    const watchdogRes = await page.request.get('/api/panel/system/watchdog/status');
    expect(watchdogRes.status()).toBe(200);
    const watchdogData = await watchdogRes.json();
    expect(['healthy', 'degraded']).toContain(watchdogData?.data?.status);
    await page.close();
  });

  test('mutlu yol: Servis sağlık denetimi, watchdog durumu sorgulama ve disk izleme', async ({ page }) => {
    const headers = await getApiHeaders(page);

    // 1. /servers sayfasına git ve Sistem Servislerini doğrula
    await page.goto('/servers');
    await expect(page.locator('h1')).toContainText('Sunucu', { timeout: 15000 });

    // Varsa açık modalı kapat
    const modal = page.locator('.ws-modal');
    if (await modal.isVisible()) {
      const closeBtn = modal.locator('button', { hasText: 'Kapat' });
      if (await closeBtn.isVisible()) await closeBtn.click();
    }

    const servicesSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Sistem servisleri' }) });
    await expect(servicesSection).toBeVisible({ timeout: 15000 });

    // Kaydı yenile butonunun çalıştığını doğrula
    const refreshBtn = servicesSection.locator('button', { hasText: 'Kaydı yenile' });
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    // Servis tablosu kontrolleri
    const table = servicesSection.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 15000 });
    await expect(table.locator('th', { hasText: 'Servis' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'Durum' })).toBeVisible();
    await expect(table.locator('th', { hasText: 'İşlemler' })).toBeVisible();

    // Çekirdek servis satırlarının varlığı
    const nginxRow = table.locator('tr').filter({ hasText: 'Nginx' });
    await expect(nginxRow).toBeVisible();

    // 2. Dashboard sayfasına git ve Disk izleme kontrollerini yap
    await page.goto('/dashboard');
    await expect(page.locator('h1', { hasText: 'Genel bakış' })).toBeVisible({ timeout: 15000 });

    const resourceSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Sunucu kaynakları' }) });
    await expect(resourceSection).toBeVisible({ timeout: 15000 });

    // Disk kullanım metriği
    const diskMetric = resourceSection.locator('.ws-usage-metric').filter({ hasText: 'Disk' });
    await expect(diskMetric).toBeVisible();
    await expect(diskMetric.locator('.ws-usage-ring strong')).toContainText(/%[0-9]+/);
    await expect(diskMetric.locator('small')).toContainText(/GB/i);

    // 3. API seviyesinde Watchdog durum sorgusu
    const statusRes = await page.request.get('/api/panel/system/watchdog/status');
    expect(statusRes.status()).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody).toHaveProperty('data');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(statusBody.data.status);
    expect(statusBody.data).toHaveProperty('services');
    expect(Array.isArray(statusBody.data.services)).toBe(true);

    // 4. API seviyesinde Watchdog kontrolü tetikleme
    const checkRes = await page.request.post('/api/panel/system/watchdog/check', {
      headers,
    });
    expect(checkRes.status()).toBe(200);
    const checkBody = await checkRes.json();
    expect(checkBody).toHaveProperty('data');
    expect(['healthy', 'degraded', 'unhealthy']).toContain(checkBody.data.status);
  });

  test('hatalı girdi: Geçersiz parametreler ve eksik onay tokeni ile 400 validation kontrolü', async ({ page }) => {
    const headers = await getApiHeaders(page);

    // 1. Boş gövde ile recover isteği gönderildiğinde 400 dönmeli
    const emptyRes = await page.request.post('/api/panel/system/watchdog/recover', {
      headers,
      data: {},
    });
    expect(emptyRes.status()).toBe(400);
    const emptyBody = await emptyRes.json();
    expect(emptyBody.error?.code).toBe('target_parameters_required');

    // 2. targetType ve targetId var fakat confirmation eksik olduğunda 400 dönmeli
    const noConfirmRes = await page.request.post('/api/panel/system/watchdog/recover', {
      headers,
      data: {
        targetType: 'service',
        targetId: 'nginx',
      },
    });
    expect(noConfirmRes.status()).toBe(400);
    const noConfirmBody = await noConfirmRes.json();
    expect(noConfirmBody.error?.code).toBe('confirmation_required');

    // 3. Geçersiz targetType verildiğinde 400 dönmeli
    const invalidTypeRes = await page.request.post('/api/panel/system/watchdog/recover', {
      headers,
      data: {
        targetType: 'invalid_component',
        targetId: 'nginx',
        confirmation: 'recover:invalid_component:nginx',
      },
    });
    expect(invalidTypeRes.status()).toBe(400);
    const invalidTypeBody = await invalidTypeRes.json();
    expect(invalidTypeBody.error?.code).toBe('invalid_target_type');
  });

  test('fiziksel kanıt: Canlı sunucu SSH ile df -h / ve systemctl is-active karşılaştırması', async ({ page }) => {
    // 1. SSH ile sunucudaki gerçek disk kullanımını ve Nginx durumunu al
    const sshDiskOutput = runSsh('df -B1 /');
    expect(sshDiskOutput).not.toBe('');
    const lines = sshDiskOutput.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const parts = lines[1].trim().split(/\s+/);
    // [Filesystem, 1B-blocks, Used, Available, Use%, Mounted]
    const totalBytes = Number.parseInt(parts[1], 10);
    const usedBytes = Number.parseInt(parts[2], 10);
    const sshUsePercent = Number.parseInt(parts[4].replace('%', ''), 10);
    expect(totalBytes).toBeGreaterThan(0);
    expect(usedBytes).toBeGreaterThan(0);
    expect(sshUsePercent).toBeGreaterThanOrEqual(0);

    const sshNginxStatus = runSsh('systemctl is-active nginx');
    expect(sshNginxStatus).toBe('active');

    // 2. Panel sunucu envanterini API üzerinden çek
    const serverRes = await page.request.get('/api/panel/servers');
    expect(serverRes.status()).toBe(200);
    const serverBody = await serverRes.json();
    const localServer = serverBody.data?.[0];
    expect(localServer).toBeDefined();

    const diskInventory = localServer.inventory?.filesystem;
    expect(diskInventory).toBeDefined();
    expect(diskInventory.totalBytes).toBeGreaterThan(0);
    expect(diskInventory.usedBytes).toBeGreaterThan(0);

    // Fiziksel disk boyutu ve panel envanterinin eşleştiğini doğrula (5% tolerans)
    const panelPercent = Math.round((diskInventory.usedBytes / diskInventory.totalBytes) * 100);
    expect(Math.abs(panelPercent - sshUsePercent)).toBeLessThanOrEqual(5);

    // 3. Watchdog durumundaki Nginx servisinin activeState ile SSH systemctl çıktısının eşleştiğini doğrula
    const watchdogRes = await page.request.get('/api/panel/system/watchdog/status');
    expect(watchdogRes.status()).toBe(200);
    const watchdogData = await watchdogRes.json();
    const nginxService = watchdogData.data?.services?.find((s) => s.id === 'nginx');
    if (nginxService) {
      expect(nginxService.active).toBe(true);
      expect(nginxService.units?.[0]?.activeState).toBe('active');
    }
  });

  test('Plesk eşdeğerliği: Watchdog eklentisi / servis alarm eşikleri ve otomatik kurtarma arayüzü eksikliği', async ({ page }) => {
    test.fail(true, 'BULGU MON-05: Plesk Watchdog eklentisi eşdeğeri UI yapılandırma ve disk kota alarm eşiği arayüzü eksik');

    // Plesk'te Tools & Settings / Extensions altında Watchdog servisi için özel yapılandırma arayüzü bulunur:
    // Disk alarm eşikleri (%80 uyarı, %90 kritik), otomatik restart sıklığı, servis yanıt vermediğinde e-posta bildirimi.
    // YunPanel arayüzünde bu ayar ekranı henüz mevcut değildir.
    await page.goto('/servers');
    await expect(page.locator('a, button').filter({ hasText: /Watchdog Ayarları|İzleme Eşikleri/i })).toBeVisible({ timeout: 5000 });
  });
});
