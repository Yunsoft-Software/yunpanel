import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('MON-01 CPU/RAM/disk/ağ/servis ölçümleri ve geçmiş grafikler', () => {
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

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    // 0 Artık ilkesi: Panel ve telemetri servisinin başlangıç/stabil durumunda kaldığını doğrula
    const page = await browser.newPage();
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const res = await page.request.get('/api/panel/servers');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body?.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  test('mutlu yol: Canlı telemetri akışı, CPU/RAM/Disk kullanım yüzdeleri ve geçmiş grafiği', async ({ page }) => {
    // 1. Dashboard sayfasına git
    await page.goto('/dashboard');
    await expect(page.locator('h1', { hasText: 'Genel bakış' })).toBeVisible({ timeout: 15000 });

    // 2. Performans bölümü kontrolleri
    const perfSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Performans' }) });
    await expect(perfSection).toBeVisible({ timeout: 10000 });

    // Yenileme aralığı seçicisi ve Şimdi ölç butonu
    const intervalSelect = perfSection.locator('select[aria-label="Yenileme aralığı"]');
    await expect(intervalSelect).toBeVisible();

    const measureNowBtn = perfSection.locator('button', { hasText: 'Şimdi ölç' });
    await expect(measureNowBtn).toBeVisible();

    // Yenileme aralığını 3 sn olarak ayarla
    await intervalSelect.selectOption('3000');
    await expect(perfSection.locator('.ws-badge')).toContainText(/Canlı/i);

    // 3. Sunucu kaynakları kartı kontrolleri
    const resourceSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Sunucu kaynakları' }) });
    await expect(resourceSection).toBeVisible();

    // CPU, Bellek ve Disk halkaları (UsageRing)
    const cpuMetric = resourceSection.locator('.ws-usage-metric').filter({ hasText: 'CPU' });
    const memoryMetric = resourceSection.locator('.ws-usage-metric').filter({ hasText: 'Bellek' });
    const diskMetric = resourceSection.locator('.ws-usage-metric').filter({ hasText: 'Disk' });

    await expect(cpuMetric).toBeVisible();
    await expect(memoryMetric).toBeVisible();
    await expect(diskMetric).toBeVisible();

    // Yüzde değerlerinin render edildiğini doğrula (% işareti ve sayı)
    await expect(cpuMetric.locator('.ws-usage-ring strong')).toContainText(/%[0-9]+/);
    await expect(memoryMetric.locator('.ws-usage-ring strong')).toContainText(/%[0-9]+/);
    await expect(diskMetric.locator('.ws-usage-ring strong')).toContainText(/%[0-9]+/);

    // Bellek detayında GB formatı (ör: 1.5 GB / 11.7 GB)
    await expect(memoryMetric.locator('small')).toContainText(/GB/i);
    // Disk detayında GB formatı
    await expect(diskMetric.locator('small')).toContainText(/GB/i);

    // 4. Şimdi ölç butonuna tıkla ve en az 2 örnek toplanmasını sağla
    await measureNowBtn.click();
    await page.waitForTimeout(3500);
    await measureNowBtn.click();

    // 5. UsageHistory bileşeni kontrolleri
    const historyHeader = perfSection.locator('.ws-history-header');
    await expect(historyHeader).toBeVisible();
    await expect(historyHeader).toContainText(/Bu oturum/i);

    // SVG grafiğinin oluştuğunu doğrula (en az 2 ölçüm alındığında çizilir)
    const svgPlot = perfSection.locator('.ws-history-plot svg');
    await expect(svgPlot).toBeVisible({ timeout: 15000 });

    // CPU, RAM ve Disk çizgi grafiklerinin (path) varlığı
    await expect(svgPlot.locator('path.ws-series-cpu')).toBeAttached();
    await expect(svgPlot.locator('path.ws-series-memory')).toBeAttached();
    await expect(svgPlot.locator('path.ws-series-disk')).toBeAttached();

    // Ölçüm tablosu açılır detayı
    const historyDetails = perfSection.locator('details.ws-history-values');
    await expect(historyDetails).toBeVisible();
    await historyDetails.locator('summary').click();

    const tableRows = historyDetails.locator('table.ws-table tbody tr');
    await expect(tableRows.first()).toBeVisible();
    const rowCount = await tableRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(2);

    // 6. /servers sayfasına giderek detaylı servis ve işletim sistemi ölçümlerini doğrula
    await page.goto('/servers');
    await expect(page.locator('h1', { hasText: 'Sunucu' })).toBeVisible({ timeout: 15000 });

    // Sunucu özet kartı
    const serverCard = page.locator('.ws-mini-server');
    await expect(serverCard).toBeVisible();
    await expect(serverCard).toContainText(/Ubuntu/i);

    // ManagedServicesPanel (yönetilen servislerin durumu: nginx, mysql/mariadb, php vb.)
    const servicesSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Yönetilen servisler' }) });
    if (await servicesSection.isVisible().catch(() => false)) {
      await expect(servicesSection.locator('table, .ws-table, article').first()).toBeVisible();
    }
  });

  test('hatalı girdi ve yetkisiz istek koruması: geçersiz sunucu ID ve anonim erişim reddedilir', async ({ page, request }) => {
    // 1. Yetkisiz (anonim/cookie'siz) istemci ile istek yapıldığında 401 Unauthorized dönmeli
    const unauthRes = await request.get('/api/panel/servers', {
      headers: { cookie: '' },
    });
    expect([401, 403]).toContain(unauthRes.status());

    // 2. Geçersiz veya var olmayan sunucu ID ile istek yapıldığında 404 dönmeli
    const notFoundRes = await page.request.get('/api/panel/servers/non-existent-server-id-00000000');
    expect(notFoundRes.status()).toBe(404);
  });

  test('fiziksel kanıt: SSH ile çekirdek, bellek, disk ve ağ metriklerinin panel envanteriyle eşleşmesi', async ({ page }) => {
    // 1. Panel API'sinden sunucu envanterini al
    const apiRes = await page.request.get('/api/panel/servers');
    expect(apiRes.status()).toBe(200);
    const apiData = await apiRes.json();
    const server = apiData.data?.[0];
    expect(server).toBeTruthy();
    expect(server.executionMode).toBe('local');

    const inventory = server.inventory;
    expect(inventory).toBeTruthy();

    // 2. SSH ile canlı test sunucusunda doğrudan donanım komutlarını koştur
    const sshNproc = runSsh('nproc');
    const sshHostname = runSsh('hostname');
    const sshDfOut = runSsh('df -B1 /');
    const sshMemInfo = runSsh('cat /proc/meminfo');

    // 3. Karşılaştırmalı doğrulamalar:
    // CPU çekirdek sayısı
    expect(Number(inventory.cpu.count)).toBe(Number(sshNproc.trim()));

    // Hostname eşleşmesi
    expect(inventory.hostname.toLowerCase()).toBe(sshHostname.trim().toLowerCase());

    // Disk kök dosya sistemi toplam boyutu eşleşmesi
    const rootLine = sshDfOut.split('\n').filter((l) => l.trim().length > 0).pop();
    expect(rootLine).toBeTruthy();
    const diskParts = rootLine.trim().split(/\s+/);
    const sshTotalBytes = Number(diskParts[1]);
    expect(Number.isFinite(sshTotalBytes)).toBe(true);
    expect(inventory.filesystem.totalBytes).toBe(sshTotalBytes);

    // Bellek toplam boyutu (kB -> Byte toleranslı kontrol, işletim sistemi %1-2 sayfa rezerve edebilir)
    const memLine = sshMemInfo.split('\n').find((l) => l.startsWith('MemTotal:'));
    expect(memLine).toBeTruthy();
    const sshMemTotalKb = Number(memLine.trim().split(/\s+/)[1]);
    expect(Number.isFinite(sshMemTotalKb)).toBe(true);
    const sshTotalMemBytes = sshMemTotalKb * 1024;
    const memDiffPercent = Math.abs(inventory.memory.totalBytes - sshTotalMemBytes) / sshTotalMemBytes;
    expect(memDiffPercent).toBeLessThan(0.05);

    // Ağ arayüzlerinin varlığı
    expect(Array.isArray(inventory.network)).toBe(true);
    expect(inventory.network.length).toBeGreaterThan(0);
    const hasValidIp = inventory.network.some((net) => net.address && net.address.length > 6);
    expect(hasValidIp).toBe(true);
  });

  test('Plesk Advanced Monitoring eşdeğerliği: kalıcı geçmiş zaman aralığı (24s/7g) ve servis/ağ I/O grafikleri', async ({ page }) => {
    test.fail(
      true,
      'Plesk Advanced Monitoring eşdeğeri kalıcı geçmiş zaman aralığı (24s/7g) ve servis bazlı CPU/RAM ile Ağ I/O transfer grafikleri henüz çekirdekte desteklenmiyor',
    );

    await page.goto('/dashboard');
    const perfSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Performans' }) });
    await expect(perfSection).toBeVisible();

    // Plesk'teki gibi "Son 1 saat", "Son 24 saat", "Son 7 gün" geçmiş aralık seçicisi aranır
    const historyRangeSelect = perfSection.locator('select[aria-label="Geçmiş aralığı"], select[name="timeRange"]');
    await expect(historyRangeSelect).toBeVisible({ timeout: 5000 });

    // Ağ I/O (Network transfer rate in/out kB/s) geçmiş grafiği aranır
    const networkSeries = perfSection.locator('.ws-series-network, path.ws-series-network');
    await expect(networkSeries).toBeVisible({ timeout: 5000 });
  });
});
