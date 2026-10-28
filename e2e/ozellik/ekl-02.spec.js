import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('EKL-02 Eklenti kur/güncelle/kaldır ve paket bağımlılıkları', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  function runSsh(command) {
    try {
      const b64 = Buffer.from(command).toString('base64');
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  async function getCsrfToken(page) {
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    return sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
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

  test.afterAll(async () => {
    // 0 Artık ve Sağlık Doğrulaması: Test edilen ana servislerin ve panelin çalışır durumda olduğunu doğrula
    try {
      runSsh('systemctl is-active yunpanel-api || sudo systemctl start yunpanel-api');
      runSsh('systemctl is-active cron || sudo systemctl start cron');
      runSsh('systemctl is-active nginx || sudo systemctl start nginx');
    } catch {
      // ignore
    }
  });

  test('mutlu yol 1: Sunucu servis/eklenti kataloğu, paket bilgileri ve durum rozetleri kontrolü', async ({ page }) => {
    // 1. Sunucu ve servis yönetimi sayfasına git
    await page.goto('/servers');
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 2. Sistem servisleri / eklentileri bölümünü doğrula
    const section = page.locator('section').filter({ hasText: 'Sistem servisleri' });
    await expect(section).toBeVisible({ timeout: 15000 });

    // 3. Tabloyu bekle (boş durumdaysa sunucuyu tara butonuna bas)
    const table = section.locator('table.ws-table');
    const emptyScanBtn = section.locator('.ws-empty button').filter({ hasText: /Servisleri tara|Sunucuyu tara/ });
    if (await emptyScanBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emptyScanBtn.click();
      const jobDialog = page.getByRole('dialog', { name: /İşlem durumu/i });
      if (await jobDialog.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(jobDialog.getByText(/Tamamlandı|Başarısız/i)).toBeVisible({ timeout: 60000 });
        const closeBtn = jobDialog.getByRole('button', { name: /Kapat|Pencereyi kapat/i }).first();
        await closeBtn.click();
      }
    }
    await expect(table).toBeVisible({ timeout: 30000 });

    // 4. Tablodaki servisleri ve paket bağımlılıklarını doğrula
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(8);

    // Nginx servis satırı ve kurulu sürüm kontrolü
    const nginxRow = rows.filter({ has: page.locator('strong', { hasText: /^nginx$/i }) });
    await expect(nginxRow).toBeVisible();
    await expect(nginxRow.getByRole('cell', { name: /1\.24/ })).toBeVisible();
    await expect(nginxRow.locator('.ws-badge, [class*="badge"]')).toContainText(/Çalışıyor/);

    // Cron servis satırı ve çalışma durumu
    const cronRow = rows.filter({ has: page.locator('strong', { hasText: /^cron$/i }) });
    await expect(cronRow).toBeVisible();
    await expect(cronRow.locator('.ws-badge, [class*="badge"]')).toContainText(/Çalışıyor/);

    // MariaDB servis satırı
    const mariadbRow = rows.filter({ has: page.locator('strong', { hasText: /^mariadb$/i }) });
    await expect(mariadbRow).toBeVisible();
    await expect(mariadbRow.locator('.ws-badge, [class*="badge"]')).toContainText(/Çalışıyor/);

    // Docker servis satırı
    const dockerRow = rows.filter({ has: page.locator('strong', { hasText: /^docker$/i }) });
    await expect(dockerRow).toBeVisible();
    await expect(dockerRow.locator('.ws-badge, [class*="badge"]')).toContainText(/Çalışıyor/);
  });

  test('mutlu yol 2: API servis envanteri ile sunucudaki gerçek APT/dpkg paketleri ve systemd servislerinin birebir doğrulanması', async ({ page }) => {
    // 1. Sunucu ID'sini API'den al
    const serverId = await page.evaluate(async () => {
      const res = await fetch('/api/panel/servers');
      const json = await res.json().catch(() => ({}));
      return json.data?.items?.[0]?.id || json.data?.[0]?.id || null;
    });
    expect(serverId).toBeTruthy();

    // 2. Servis ve paket envanterini API'den çek
    const servicesRes = await page.evaluate(async (sId) => {
      const res = await fetch(`/api/panel/servers/${encodeURIComponent(sId)}/services`);
      return { status: res.status, json: await res.json().catch(() => ({})) };
    }, serverId);

    expect(servicesRes.status).toBe(200);
    const services = servicesRes.json?.data?.services;
    expect(Array.isArray(services)).toBe(true);
    expect(services.length).toBeGreaterThanOrEqual(8);

    // 3. Fiziksel Sonuç 1: SSH üzerinden dpkg paket durumunu çek ve API ile karşılaştır
    const dpkgOutput = runSsh("dpkg-query -W -f='${Package} ${Version} ${Status}\\n' nginx cron postfix dovecot-imapd");
    expect(dpkgOutput).toContain('nginx');
    expect(dpkgOutput).toContain('cron');
    expect(dpkgOutput).toContain('postfix');
    expect(dpkgOutput).toContain('install ok installed');

    // API'deki nginx servis kaydını dpkg ile eşle
    const nginxService = services.find((s) => s.id === 'nginx');
    expect(nginxService).toBeTruthy();
    expect(nginxService.installed).toBe(true);

    // 4. Fiziksel Sonuç 2: SSH üzerinden systemd servis çalışma durumunu doğrula
    const nginxSshActive = runSsh('systemctl is-active nginx');
    expect(nginxSshActive).toBe('active');

    const cronSshActive = runSsh('systemctl is-active cron');
    expect(cronSshActive).toBe('active');

    // 5. Fiziksel Sonuç 3: /settings?section=updates sayfasındaki APT paket sürüm sorgulamasını doğrula
    await page.goto('/settings?section=updates');
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
    const checkBtn = page.locator('button', { hasText: /Check updates|Kontrol et|Güncellemeleri denetle/i }).first();
    await expect(checkBtn).toBeVisible({ timeout: 10000 });
    await checkBtn.click();

    const versionCell = page.locator('.domain-cell strong').first();
    await expect(versionCell).toBeVisible({ timeout: 30000 });
    const versionText = (await versionCell.textContent()) || '';
    expect(versionText).toMatch(/0\.\d+\.\d+|Not checked/);
  });

  test('hatalı girdi ve güvenlik: Geçersiz eklenti ID, eksik confirmation parametresi ve geçersiz kontrol eylemleri 400 döner', async ({ page }) => {
    const serverId = await page.evaluate(async () => {
      const res = await fetch('/api/panel/servers');
      const json = await res.json().catch(() => ({}));
      return json.data?.items?.[0]?.id || json.data?.[0]?.id || null;
    });
    expect(serverId).toBeTruthy();

    const csrf = await getCsrfToken(page);
    const headers = {
      'Content-Type': 'application/json',
      'x-csrf-token': csrf,
      Origin: 'https://server.cryptoraichu.website',
      Referer: 'https://server.cryptoraichu.website/servers',
    };

    // 1. Desteklenmeyen eklenti/servis kurulumu
    const invalidInstallRes = await page.request.post(`/api/panel/servers/${encodeURIComponent(serverId)}/services/unsupported-extension-999/install`, {
      headers,
      data: { confirmation: 'install:unsupported-extension-999' },
    });
    expect(invalidInstallRes.status()).toBe(400);
    const invalidInstallJson = await invalidInstallRes.json().catch(() => ({}));
    expect(invalidInstallJson.error?.code).toBe('unsupported_managed_service');

    // 2. Eksik confirmation parametresi ile kurulum isteği
    const missingConfirmRes = await page.request.post(`/api/panel/servers/${encodeURIComponent(serverId)}/services/nginx/install`, {
      headers,
      data: {},
    });
    expect(missingConfirmRes.status()).toBe(400);
    const missingConfirmJson = await missingConfirmRes.json().catch(() => ({}));
    expect(missingConfirmJson.error?.code).toBe('managed_service_confirmation_required');

    // 3. Geçersiz kontrol eylemi (unsupported action)
    const invalidActionRes = await page.request.post(`/api/panel/servers/${encodeURIComponent(serverId)}/services/cron/control`, {
      headers,
      data: { action: 'purge_all', confirmation: 'control:cron:purge_all' },
    });
    expect(invalidActionRes.status()).toBe(400);
    const invalidActionJson = await invalidActionRes.json().catch(() => ({}));
    expect(invalidActionJson.error?.code).toBe('unsupported_managed_service_action');
  });

  test('eksiklik 1: Plesk Extensions Marketplace / harici 3. parti eklenti (.zip/SDK) yükleme ve uzantı kataloğu rotası yokluğu', async ({ page }) => {
    test.fail(true, 'Plesk eşdeğeri harici eklenti kataloğu ve 3. parti uzantı yükleme API rotası mevcut değil');

    // Plesk'te /api/extensions veya /api/panel/extensions üzerinden 3. parti eklentiler yönetilebilir
    const extCatalogRes = await page.request.get('/api/panel/extensions/catalog');
    expect(extCatalogRes.status()).toBe(200);

    const extListRes = await page.request.get('/api/panel/extensions');
    expect(extListRes.status()).toBe(200);
  });

  test('eksiklik 2: Kurulu bir eklentiyi/servisi paket bağımlılıklarıyla birlikte sistemden tamamen kaldırma (uninstall/purge) rotası yokluğu', async ({ page }) => {
    test.fail(true, 'Yönetilen servislerde ve eklentilerde paket bağımlılıklarını temizleyerek tamamen kaldırma (uninstall/purge) rotası yok');

    const serverId = await page.evaluate(async () => {
      const res = await fetch('/api/panel/servers');
      const json = await res.json().catch(() => ({}));
      return json.data?.items?.[0]?.id || json.data?.[0]?.id || null;
    });
    expect(serverId).toBeTruthy();

    const csrf = await getCsrfToken(page);
    // Plesk'te veya gelişmiş panel modellerinde uzantıyı bağımlılıklarıyla kaldırma
    const uninstallRes = await page.request.post(`/api/panel/servers/${encodeURIComponent(serverId)}/services/nginx/uninstall`, {
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrf,
      },
      data: { confirmation: 'uninstall:nginx' },
    });
    expect(uninstallRes.status()).toBe(202);
  });
});
