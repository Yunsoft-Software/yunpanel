import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('MON-02 Eşik/teslim alıcısı/bildirim tercihleri ve teslim kanıtı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  let initialPreferences = null;
  let csrfToken = '';
  const panelOrigin = 'https://server.cryptoraichu.website';

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: panelOrigin,
      Referer: `${panelOrigin}/`,
    };
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const sessionRes = await page.request.get('/api/auth/session');
    if (sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || json?.csrfToken || '';
    }
  });

  test.afterAll(async ({ browser }) => {
    // 0 Artık ilkesi: Bildirim tercihlerini başlangıç durumuna geri yükle
    if (initialPreferences) {
      const page = await browser.newPage();
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const sessionRes = await page.request.get('/api/auth/session');
      let token = '';
      if (sessionRes.ok()) {
        const json = await sessionRes.json().catch(() => ({}));
        token = json?.data?.csrfToken || json?.csrfToken || '';
      }
      await page.request.patch('/api/panel/notifications/preferences', {
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': token,
          Origin: panelOrigin,
          Referer: `${panelOrigin}/`,
        },
        data: initialPreferences,
      });
      await page.close();
    }
  });

  test('mutlu yol: Bildirim merkezi çekmecesi (Görev Kuyruğu, Uyarılar, Bildirimler) ve Tercih/Eşik API yönetimi', async ({ page }) => {
    // 1. Dashboard sayfasına git ve bildirim çekmecesini aç
    await page.goto('/dashboard');
    await expect(page.locator('h1', { hasText: 'Genel bakış' })).toBeVisible({ timeout: 15000 });

    const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"]');
    await expect(bellBtn).toBeVisible({ timeout: 10000 });
    await bellBtn.click();

    // Çekmecenin açıldığını doğrula
    const drawer = page.locator('aside[aria-label="Bildirim ve Görev Merkezi"]');
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.locator('h2')).toContainText('Bildirim ve Görev Merkezi');

    // 2. Sekmeler arasında geçiş yap
    const tasksTab = drawer.locator('button[role="tab"]', { hasText: 'Görev Kuyruğu' });
    const alertsTab = drawer.locator('button[role="tab"]', { hasText: 'Sistem Uyarıları' });
    const noticesTab = drawer.locator('button[role="tab"]', { hasText: 'Bildirimler' });

    await expect(tasksTab).toBeVisible();
    await expect(alertsTab).toBeVisible();
    await expect(noticesTab).toBeVisible();

    // Sistem Uyarıları sekmesi
    await alertsTab.click();
    await expect(alertsTab).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.locator('section[aria-label="Sistem Uyarıları"]')).toBeVisible();

    // Bildirimler sekmesi
    await noticesTab.click();
    await expect(noticesTab).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.locator('section[aria-label="Bildirimler"]')).toBeVisible();

    // Çekmeceyi kapat
    const closeBtn = drawer.locator('button[aria-label="Bildirim merkezini kapat"]');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(drawer).toBeHidden();

    // 3. API Seviyesinde Bildirim Tercihlerini Oku ve Sakla
    const getRes = await page.request.get('/api/panel/notifications/preferences');
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();
    expect(getBody?.data).toBeTruthy();
    expect(typeof getBody.data.enabled).toBe('boolean');
    expect(getBody.data.categories).toBeTruthy();
    expect(getBody.data.channels).toBeTruthy();

    if (!initialPreferences) {
      initialPreferences = getBody.data;
    }

    // 4. Tercihleri ve eşik/kanal ayarlarını güncelle (PATCH)
    const patchPayload = {
      enabled: true,
      minSeverity: 'warning',
      categories: {
        ssl: true,
        disk: true,
        backup: true,
      },
      channels: {
        email: {
          enabled: true,
          address: 'mon02-alert@yunpanel.test',
        },
        panel: {
          enabled: true,
        },
      },
    };

    const patchRes = await page.request.patch('/api/panel/notifications/preferences', {
      headers: apiHeaders(),
      data: patchPayload,
    });
    expect(patchRes.status()).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody?.data?.minSeverity).toBe('warning');
    expect(patchBody?.data?.channels?.email?.address).toBe('mon02-alert@yunpanel.test');
    expect(patchBody?.data?.categories?.disk).toBe(true);

    // 5. Test Bildirimi Gönder (POST /api/panel/notifications/test)
    const testRes = await page.request.post('/api/panel/notifications/test', {
      headers: apiHeaders(),
      data: {
        channel: 'panel',
        message: 'MON-02 Doğrulama Test Bildirimi',
      },
    });
    expect(testRes.status()).toBe(200);
    const testBody = await testRes.json();
    expect(testBody?.data?.delivered).toBe(true);
    expect(testBody?.data?.status).toBe('delivered');
  });

  test('hatalı girdi: Geçersiz minSeverity ve hatalı gövde 400 Bad Request ile reddedilir', async ({ page }) => {
    // 1. Geçersiz minSeverity değeri gönder
    const invalidSeverityRes = await page.request.patch('/api/panel/notifications/preferences', {
      headers: apiHeaders(),
      data: {
        minSeverity: 'critical_emergency_overload',
      },
    });
    expect(invalidSeverityRes.status()).toBe(400);
    const errBody = await invalidSeverityRes.json();
    expect(errBody?.error?.code).toBe('invalid_min_severity');

    // 2. Obje olmayan patch verisi (örneğin array) gönder
    const invalidPatchRes = await page.request.patch('/api/panel/notifications/preferences', {
      headers: apiHeaders(),
      data: ['invalid_array_payload'],
    });
    expect(invalidPatchRes.status()).toBe(400);
    const patchErrBody = await invalidPatchRes.json();
    expect(patchErrBody?.error?.code).toBe('invalid_preferences_patch');
  });

  test('fiziksel kanıt: Teslimat geçmişi (/api/panel/notifications/deliveries) ve motor durumunun fiziksel teyidi', async ({ page }) => {
    // 1. Teslimat geçmişini sorgula
    const deliveriesRes = await page.request.get('/api/panel/notifications/deliveries?limit=20');
    expect(deliveriesRes.status()).toBe(200);
    const deliveriesBody = await deliveriesRes.json();
    expect(Array.isArray(deliveriesBody?.data)).toBe(true);
    expect(deliveriesBody.data.length).toBeGreaterThanOrEqual(1);

    // Az önce mutlu yol testinde gönderilen panel test bildirimini geçmişte bul
    const testDelivery = deliveriesBody.data.find((item) => (
      item.eventType === 'test_notification' || (item.details && item.details.testMode === true)
    ));
    expect(testDelivery).toBeTruthy();
    expect(testDelivery.status).toBe('delivered');
    expect(testDelivery.channel).toBe('panel');

    // 2. Sistem bildirim durumu sorgula
    const statusRes = await page.request.get('/api/panel/notifications/status');
    expect(statusRes.status()).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody?.data?.status).toBe('active');
    expect(statusBody?.data?.channels?.panel?.available).toBe(true);
  });

  test('Plesk eşdeğeri eksikliği: Olay bazlı e-posta/webhook alıcı şablonları ve eşik yapılandırma UI ekranı', async ({ page }) => {
    test.fail(
      true,
      'BULGU MON-02: Plesk "Tools & Settings -> Notifications" eşdeğeri olay bazlı alıcı şablonları ve eşik yapılandırma kullanıcı arayüzü (UI) henüz mevcut değil; işlevler yalnızca API düzeyinde sunuluyor.',
    );

    // Plesk'teki gibi özel bir bildirim yönetim ve eşik ekranına gitmeyi dene
    await page.goto('/settings/notifications');
    // Eğer böyle bir sayfa varsa form veya tablo elemanlarının görünmesini bekle
    const settingsHeading = page.locator('h1, h2', { hasText: /Bildirim Tercihleri|Bildirim Ayarları|Notification/i });
    await expect(settingsHeading).toBeVisible({ timeout: 5000 });
  });
});
