import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SYS-02 Sistem servislerini kurma/başlatma/durdurma/yeniden başlatma', () => {
  test.setTimeout(240000);

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

  test.afterAll(async () => {
    // 0 Artık ilkesi: Test edilen servislerin (cron ve nginx) sistemde çalışır durumda olduğunu doğrula
    try {
      runSsh('systemctl is-active cron || sudo systemctl start cron');
      runSsh('systemctl is-active nginx || sudo systemctl start nginx');
    } catch {
      // ignore
    }
  });

  test('mutlu yol 1: Sistem servislerini listeleme, durum rozetleri ve tarama (inspect)', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 1. Sistem servisleri bölümünün varlığını doğrula
    const section = page.locator('section').filter({ hasText: 'Sistem servisleri' });
    await expect(section).toBeVisible({ timeout: 10000 });

    // 2. Tablo görünür değilse sunucuyu tara butonuna bas, görünürse tabloyu bekle
    const table = section.locator('table.ws-table');
    const scanBtn = section.locator('button:has-text("Sunucuyu tara"), button:has-text("Servisleri tara")').first();
    if (!await table.isVisible()) {
      await expect(scanBtn).toBeVisible({ timeout: 5000 });
      await scanBtn.click();
    }
    await expect(table).toBeVisible({ timeout: 60000 });

    // 3. Tablodaki servisleri doğrula (En az 10 yönetilen servis bulunmalı)
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(10);

    // Kritik servislerin satırlarını doğrula (tam eşleşme ile)
    const cronRow = table.locator('tbody tr').filter({ has: page.locator('strong', { hasText: /^cron$/ }) });
    await expect(cronRow).toBeVisible();
    await expect(cronRow.locator('span.ws-badge, .badge')).toContainText('Çalışıyor');

    const nginxRow = table.locator('tbody tr').filter({ has: page.locator('strong', { hasText: /^nginx$/ }) });
    await expect(nginxRow).toBeVisible();
    await expect(nginxRow.locator('span.ws-badge, .badge')).toContainText('Çalışıyor');

    const mariadbRow = table.locator('tbody tr').filter({ has: page.locator('strong', { hasText: /^mariadb$/ }) });
    await expect(mariadbRow).toBeVisible();
    await expect(mariadbRow.locator('span.ws-badge, .badge')).toContainText('Çalışıyor');

    // 4. Fiziksel Kanıt 1: API üzerinden servis durumlarını doğrula
    const serverIdRes = await page.evaluate(async () => {
      const r = await fetch('/api/panel/servers');
      const json = await r.json().catch(() => ({}));
      return json.data?.items?.[0]?.id || json.data?.[0]?.id || null;
    });
    expect(serverIdRes).toBeTruthy();

    const servicesApiRes = await page.evaluate(async (sId) => {
      const r = await fetch(`/api/panel/servers/${encodeURIComponent(sId)}/services`);
      return { status: r.status, json: await r.json().catch(() => ({})) };
    }, serverIdRes);

    expect(servicesApiRes.status).toBe(200);
    const servicesList = servicesApiRes.json?.data?.services;
    expect(Array.isArray(servicesList)).toBe(true);

    const cronService = servicesList.find((s) => s.id === 'cron');
    expect(cronService).toBeTruthy();
    expect(cronService.active).toBe(true);
    expect(cronService.installed).toBe(true);

    // 5. Fiziksel Kanıt 2: SSH ile sunucuda systemd durumunu doğrula
    const sshCronStatus = runSsh('systemctl is-active cron');
    expect(sshCronStatus).toBe('active');

    const sshNginxStatus = runSsh('systemctl is-active nginx');
    expect(sshNginxStatus).toBe('active');
  });

  test('mutlu yol 2: Güvenli servis yeniden başlatma (cron restart) işlemi ve onay akışı', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    const section = page.locator('section').filter({ hasText: 'Sistem servisleri' });
    await expect(section).toBeVisible({ timeout: 10000 });

    const table = section.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 30000 });

    // cron satırındaki "Yeniden başlat" butonuna tıkla
    const cronRow = table.locator('tbody tr').filter({ has: page.locator('strong', { hasText: /^cron$/ }) });
    await expect(cronRow).toBeVisible();

    const restartBtn = cronRow.locator('button:has-text("Yeniden başlat")');
    await expect(restartBtn).toBeVisible();
    await restartBtn.click();

    // Onay modalını doğrula
    const confirmModal = page.getByRole('dialog', { name: 'cron yeniden başlatılsın mı?' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    const confirmBtn = confirmModal.locator('button:has-text("Yeniden başlat")');
    await expect(confirmBtn).toBeVisible();
    await confirmBtn.click();

    // Onay modalının işlem tamamlandığında kapanmasını bekle
    await expect(confirmModal).toBeHidden({ timeout: 60000 });

    // Eğer global "İşlem durumu" modalı açıldıysa kapat
    const jobDialog = page.getByRole('dialog', { name: 'İşlem durumu' });
    if (await jobDialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      const closeBtn = jobDialog.locator('button:has-text("Kapat"), button[aria-label="Kapat"]').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click().catch(() => {});
      }
    }

    // İşlem sonrasında cron servisinin hala "Çalışıyor" durumunda olduğunu doğrula
    await expect(cronRow.locator('span.ws-badge, .badge')).toContainText('Çalışıyor', { timeout: 15000 });

    // Fiziksel kanıt: SSH ile cron servisinin aktif olduğunu doğrula
    const sshStatus = runSsh('systemctl is-active cron');
    expect(sshStatus).toBe('active');
  });

  test('hatalı girdi ve güvenlik: Geçersiz servis, geçersiz aksiyon ve eksik onay koruması', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    const serverId = await page.evaluate(async () => {
      const r = await fetch('/api/panel/servers');
      const json = await r.json().catch(() => ({}));
      return json.data?.items?.[0]?.id || json.data?.[0]?.id || null;
    });
    expect(serverId).toBeTruthy();

    const headers = await getApiHeaders(page);

    // 1. Desteklenmeyen / geçersiz servis adı
    const invalidServiceRes = await page.request.post(
      `/api/panel/servers/${encodeURIComponent(serverId)}/services/nonexistent-service/control`,
      {
        headers,
        data: {
          action: 'restart',
          confirmation: 'control:nonexistent-service:restart',
        },
      },
    );
    expect(invalidServiceRes.status()).toBe(400);
    const invalidServiceJson = await invalidServiceRes.json().catch(() => ({}));
    expect(invalidServiceJson.error?.code).toBe('unsupported_managed_service');

    // 2. Desteklenmeyen / geçersiz eylem
    const invalidActionRes = await page.request.post(
      `/api/panel/servers/${encodeURIComponent(serverId)}/services/cron/control`,
      {
        headers,
        data: {
          action: 'terminate_now',
          confirmation: 'control:cron:terminate_now',
        },
      },
    );
    expect(invalidActionRes.status()).toBe(400);
    const invalidActionJson = await invalidActionRes.json().catch(() => ({}));
    expect(invalidActionJson.error?.code).toBe('unsupported_managed_service_action');

    // 3. Eksik veya geçersiz onay (confirmation) metni
    const invalidConfirmRes = await page.request.post(
      `/api/panel/servers/${encodeURIComponent(serverId)}/services/cron/control`,
      {
        headers,
        data: {
          action: 'restart',
          confirmation: 'wrong-confirmation-text',
        },
      },
    );
    expect(invalidConfirmRes.status()).toBe(400);
    const invalidConfirmJson = await invalidConfirmRes.json().catch(() => ({}));
    expect(invalidConfirmJson.error?.code).toBe('managed_service_confirmation_required');

    // 4. Çakışan servis koruması (UI doğrulaması: MariaDB kurulu olduğunda MySQL kurulumunun engellenmesi)
    const section = page.locator('section').filter({ hasText: 'Sistem servisleri' });
    const mysqlRow = section.locator('table.ws-table tbody tr').filter({ has: page.locator('strong', { hasText: /^mysql$/ }) });
    await expect(mysqlRow).toBeVisible();
    await expect(mysqlRow).toContainText('mariadb kurulu olduğu için birlikte kurulamaz.');
    // MySQL satırında "Kur" butonu olmamalıdır
    await expect(mysqlRow.locator('button:has-text("Kur")')).toHaveCount(0);
  });

  test('Plesk eşdeğerliği: Başlangıç tipi (Startup Type / Boot) yapılandırması ve PHP-FPM / PowerDNS servis kontrolleri', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    const section = page.locator('section').filter({ hasText: 'Sistem servisleri' });
    await expect(section).toBeVisible({ timeout: 10000 });

    const table = section.locator('table.ws-table');
    await expect(table).toBeVisible({ timeout: 30000 });

    // BULGU: Plesk Services Management panelinde her servis için başlangıç modu (Startup Type: Automatic / Manual / Disabled)
    // ayarlanabilir ve PHP-FPM ile PowerDNS (DNS Server) servisleri doğrudan bu ekrandan yönetilebilir.
    // YunPanel ManagedServicesPanel'de servis başlangıç tipi (systemctl enable/disable) ayarı ve
    // PHP-FPM / PowerDNS servis kontrolleri bulunmamaktadır.
    test.fail(
      true,
      'BULGU SYS-02: Plesk Services Management eşdeğeri servis başlangıç türü (Startup Type / Boot enable-disable) yapılandırması ve PHP-FPM / PowerDNS servis kontrolleri arayüzde eksik',
    );

    // Bu kontroller henüz panelde bulunmadığından test.fail ile işaretlenmiştir
    await expect(table.locator('th:has-text("Başlangıç Türü"), th:has-text("Startup Type")')).toBeVisible({ timeout: 2000 });
  });
});
