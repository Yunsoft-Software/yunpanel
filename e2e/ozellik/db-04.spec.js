import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DB-04 phpMyAdmin geçişi ve oturum/yetki izolasyonu', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  let targetDatabaseName = 'tdb04_a3_mvqgctuk';
  let testServerId = null;

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

  test('mutlu yol: Veritabanları ekranından phpMyAdmin SSO oturum açma, veritabanına erişim ve tablo listeleme', async ({ page, context }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const inventorySection = page.locator('section.ws-database-inventory, section:has-text("Veritabanı listesi")').first();
    await expect(inventorySection).toBeVisible({ timeout: 15000 });

    // Hedef test veritabanını ara
    let row = page.locator('tr[role="row"]').filter({ hasText: targetDatabaseName }).first();

    // Eğer hedef veritabanı mevcut değilse arayüzden yeni bir tane oluştur
    if (!(await row.isVisible({ timeout: 3000 }).catch(() => false))) {
      const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
      await expect(createBtn).toBeEnabled({ timeout: 10000 });
      await createBtn.click();

      const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
      await expect(dialog).toBeVisible({ timeout: 10000 });

      // Web sitesi seçimi
      const siteSelect = dialog.locator('select').first();
      if (await siteSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
        const options = await siteSelect.locator('option').all();
        for (const opt of options) {
          const val = await opt.getAttribute('value');
          if (val) {
            await siteSelect.selectOption(val);
            break;
          }
        }
      }

      targetDatabaseName = `tdb04_a${agentN}_${Date.now().toString(36)}`;
      const dbNameInput = dialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
      await expect(dbNameInput).toBeVisible({ timeout: 5000 });
      await dbNameInput.fill(targetDatabaseName);

      const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
      await expect(submitBtn).toBeEnabled({ timeout: 5000 });
      await submitBtn.click();

      const successMsg = dialog.locator('p:has-text("hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")');
      await expect(successMsg).toBeVisible({ timeout: 60000 });

      const finishBtn = dialog.locator('button:has-text("Tamam")');
      await expect(finishBtn).toBeVisible({ timeout: 5000 });
      await finishBtn.click();
      await expect(dialog).toHaveCount(0, { timeout: 10000 });

      row = page.locator('tr[role="row"]').filter({ hasText: targetDatabaseName }).first();
    }

    await expect(row).toBeVisible({ timeout: 15000 });

    // Satırdaki phpMyAdmin butonunu bul
    const phpMyAdminBtn = row.locator('button:has-text("phpMyAdmin")');
    await expect(phpMyAdminBtn).toBeVisible({ timeout: 10000 });
    await expect(phpMyAdminBtn).toBeEnabled();

    // phpMyAdmin SSO açılışını tetikle ve yeni pencereyi dinle
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 25000 }),
      phpMyAdminBtn.click(),
    ]);

    // Popup yönlendirmesini bekle
    await popup.waitForURL((url) => url.pathname.includes('/tools/phpmyadmin'), { timeout: 25000 });
    await popup.waitForLoadState('networkidle');

    // Fiziksel Sonuç 1: Popup URL'si phpMyAdmin route ve veritabanı adını içermeli
    const popupUrl = popup.url();
    expect(popupUrl).toContain('/tools/phpmyadmin/index.php');
    expect(decodeURIComponent(popupUrl)).toContain(targetDatabaseName);

    // Fiziksel Sonuç 2: phpMyAdmin sayfa başlığı (title) phpMyAdmin ve veritabanı adını doğrulamalı
    await expect(popup).toHaveTitle(/phpMyAdmin/i, { timeout: 15000 });
    const pageTitle = await popup.title();
    expect(pageTitle).toContain(targetDatabaseName);

    // Fiziksel Sonuç 3: phpMyAdmin menüsünde veritabanı sekmesi ("Yapı" veya "Structure") aktif olmalı
    const topMenu = popup.locator('#topmenu, .navigation');
    await expect(topMenu).toBeVisible({ timeout: 15000 });
    const structureTab = popup.locator('#topmenu').filter({ hasText: /Yapı|Structure/i });
    await expect(structureTab).toBeVisible({ timeout: 10000 });

    // Fiziksel Sonuç 4: Veritabanı içeriği ve tablo listeleme ekranı doğrulanmalı
    const dbContainer = popup.locator('#tableslistcontainer, #page_content, #pma_navigation_tree_content');
    await expect(dbContainer.first()).toBeVisible({ timeout: 15000 });

    await popup.close();
  });

  test('yetki ve izolasyon: unauthenticated veya yabancı website phpMyAdmin handoff erişimi engellenir', async ({ page, browser }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // 1. Session bilgisini al
    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.status()).toBe(200);
    const sessionData = (await sessionRes.json()).data;
    const csrfToken = sessionData.csrfToken;
    expect(csrfToken).toBeTruthy();

    // 2. Yerel sunucu bilgisini al
    const serversRes = await page.request.get('/api/panel/servers');
    expect(serversRes.status()).toBe(200);
    const serversData = await serversRes.json();
    testServerId = serversData.data?.servers?.[0]?.id || 'local';

    // Yetki İzolasyonu 1: Giriş yapmamış (unauthenticated) istekler 401/403 ile reddedilir
    const unauthContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthHandoff = await unauthContext.request.post(
        `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/dummy-website-id/phpmyadmin-handoffs`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: { credentialId: 'dummy-credential' },
        }
      );
      expect([401, 403]).toContain(unauthHandoff.status());

      const unauthSignon = await unauthContext.request.post(
        '/tools/phpmyadmin/__yunpanel/signon',
        {
          form: { capability: 'invalid-capability-token-must-fail-closed-401' },
          maxRedirects: 0,
        }
      );
      expect([401, 403]).toContain(unauthSignon.status());
    } finally {
      await unauthContext.close();
    }

    // Yetki İzolasyonu 2: Var olmayan veya yetkisiz website üzerinden handoff talebi 403/404 ile engellenir
    const fakeWebsiteId = 'non-existent-website-0000-000000000000';
    const forbiddenHandoff = await page.request.post(
      `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/${fakeWebsiteId}/phpmyadmin-handoffs`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        data: { credentialId: 'fake-credential' },
      }
    );
    expect([403, 404]).toContain(forbiddenHandoff.status());

    // Yetki İzolasyonu 3: phpMyAdmin signon endpoint'ine sahte capability ile istek fail-closed reddedilir
    const invalidSignon = await page.request.post(
      '/tools/phpmyadmin/__yunpanel/signon',
      {
        headers: {
          'x-csrf-token': csrfToken,
        },
        form: { capability: 'A'.repeat(43) },
        maxRedirects: 0,
      }
    );
    expect([401, 403, 404]).toContain(invalidSignon.status());
  });
});
