import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-03 Reseller paneli ve kendi kaynak/kullanıcı sınırı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `trol03-a${agentN}-${Date.now().toString(36)}`;
  const RES_USER = `${prefix}-res`;
  const CUST1_USER = `${prefix}-c1`;
  const CUST2_USER = `${prefix}-c2`;
  const CUST3_USER = `${prefix}-c3`;
  const TEST_PASS = 'Tr0l03_A4_Pass!2026';

  const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
      }
    }
  }

  async function cleanupAllTestAccounts(browser, cleanPrefix = prefix) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Önce müşteri ve bayi profillerini kaldır
        const custRes = await fetch('/api/panel/users/hosting/accounts?kind=customer&limit=100').catch(() => null);
        const custData = await custRes?.json().catch(() => null);
        for (const cust of custData?.data?.accounts || []) {
          if (cust.username && cust.username.startsWith(pfx)) {
            await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(cust.id)}/profile`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({
                revision: cust.revision ?? 1,
                confirmation: `unregister-hosting-profile:${cust.id}:${cust.revision ?? 1}`,
              }),
            }).catch(() => null);
          }
        }

        const resRes = await fetch('/api/panel/users/hosting/accounts?kind=reseller&limit=100').catch(() => null);
        const resData = await resRes?.json().catch(() => null);
        for (const res of resData?.data?.accounts || []) {
          if (res.username && res.username.startsWith(pfx)) {
            await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(res.id)}/profile`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({
                revision: res.revision ?? 1,
                confirmation: `unregister-hosting-profile:${res.id}:${res.revision ?? 1}`,
              }),
            }).catch(() => null);
          }
        }

        // 2. /api/panel/users listesinden kullanıcıları sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          if (u.username && u.username.startsWith(pfx)) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }
      }, cleanPrefix);
    } finally {
      try {
        await context.close();
      } catch {}
      // Auth cache dosyalarını temizle
      for (const user of [RES_USER, CUST1_USER, CUST2_USER, CUST3_USER]) {
        try {
          fs.rmSync(path.join(AUTH_DIR, `${user}.json`), { force: true });
        } catch {}
      }
    }
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: Owner ile bayi oluşturma, Bayi paneli girişi, sol menü sınırlandırması, müşteri oluşturma, kota tahsisi ve fiziksel kontroller', async ({ page }) => {
    // 1. Owner ile bayi oluştur
    await ensureOwnerLoggedIn(page);

    const sidebar = page.locator('aside.ws-sidebar');
    await expect(sidebar).toBeVisible();

    await sidebar.locator('a[href="/resellers"]').click();
    await expect(page.locator('h1')).toContainText('Bayiler');

    await page.locator('button:has-text("Bayi ekle")').click();
    const createResellerDialog = page.locator('dialog[open]');
    await expect(createResellerDialog.locator('h2')).toContainText('Bayi ekle');

    await createResellerDialog.locator('label:has-text("Kullanıcı adı") input').fill(RES_USER);
    await createResellerDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createResellerDialog.locator('label:has-text("En fazla müşteri") input').fill('2');
    await createResellerDialog.locator('label:has-text("En fazla web sitesi") input').fill('2');
    await createResellerDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    await expect(createResellerDialog).toBeHidden({ timeout: 15000 });
    await expect(page.locator('p.ws-notice[role="status"]')).toContainText(new RegExp(`${RES_USER}.*oluşturuldu`, 'i'));

    // Fiziksel doğrulama: Oluşturulan bayinin etkin olduğunu doğrula
    const resVerifyRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=100');
    expect(resVerifyRes.ok()).toBeTruthy();
    const resVerifyData = await resVerifyRes.json();
    const createdRes = (resVerifyData.data?.accounts || []).find((a) => a.username === RES_USER);
    expect(createdRes).toBeTruthy();
    expect(createdRes.active).toBe(true);
    expect(createdRes.limits?.maxCustomers).toBe(2);
    expect(createdRes.limits?.maxWebsites).toBe(2);

    // Owner oturumundan çık
    await logout(page);

    // 2. Bayi ile giriş yap
    await loginAs(page, RES_USER, TEST_PASS);
    if (!page.url().includes('/websites')) {
      await page.waitForURL(/\/websites/, { timeout: 10000 }).catch(async () => {
        await page.goto('/websites');
      });
    }
    await expect(page.locator('h1')).toContainText('Sitelerim');

    // 3. Sol menü kontrolleri: Yalnızca Bayi menü bağlantıları görünmeli
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('a[href="/customers"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/websites"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/mail"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/files"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/databases"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/statistics"]')).toBeVisible();

    // Owner rotaları menüde OLMAMALI
    await expect(sidebar.locator('a[href="/resellers"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/tools-settings"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/docker"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/settings"]')).toBeHidden();

    // 4. Müşterilerim (/customers) sayfasına git
    await sidebar.locator('a[href="/customers"]').click();
    await page.waitForURL(/\/customers/, { timeout: 10000 });
    await expect(page.locator('h1')).toContainText('Müşterilerim');

    // 5. Müşteri ekle
    await page.locator('button:has-text("Müşteri ekle")').click();
    const createCustDialog = page.locator('dialog[open]');
    await expect(createCustDialog).toBeVisible({ timeout: 10000 });
    await expect(createCustDialog.locator('h2')).toContainText('Müşteri ekle');

    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST1_USER);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createCustDialog.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    await expect(createCustDialog).toBeHidden({ timeout: 15000 });
    const cust1Row = page.locator('table.ws-table tbody tr', { hasText: CUST1_USER });
    await expect(cust1Row).toBeVisible({ timeout: 15000 });
    await expect(cust1Row).toContainText('Etkin');

    // 6. Müşteriye kaynak kotası tahsis et
    await cust1Row.locator('button:has-text("Kota tahsis et")').click();
    const quotaDialog = page.locator('dialog[open]');
    await expect(quotaDialog).toBeVisible({ timeout: 10000 });
    await expect(quotaDialog.locator('h2')).toContainText('Kaynak Kotalarını Yönet');

    await quotaDialog.locator('label:has-text("Web Sitesi Kotası") input').fill('1');
    await quotaDialog.locator('label:has-text("Disk Kotası") input').fill('1024');
    await quotaDialog.locator('label:has-text("Aylık Trafik Kotası") input').fill('2048');
    await quotaDialog.locator('label:has-text("Veritabanı Kotası") input').fill('2');
    await quotaDialog.locator('button[type="submit"]:has-text("Kotaları Kaydet")').click();

    await expect(quotaDialog).toBeHidden({ timeout: 15000 });

    // Satırda kotaların yansıdığını doğrula
    await expect(cust1Row).toContainText('0 / 1');
    await expect(cust1Row).toContainText('1024 MB');
    await expect(cust1Row).toContainText('2048 MB');

    // 7. Fiziksel kontroller (API doğrulamaları)
    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const sessionData = await sessionRes.json();
    expect(sessionData.data?.user?.role).toBe('site_manager');
    expect(sessionData.data?.user?.hosting?.kind).toBe('reseller');

    const custsRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer');
    expect(custsRes.ok()).toBeTruthy();
    const custsData = await custsRes.json();
    const cust1Api = (custsData.data?.accounts || []).find((a) => a.username === CUST1_USER);
    expect(cust1Api).toBeTruthy();
    expect(cust1Api.quotas?.maxWebsites).toBe(1);
    expect(cust1Api.quotas?.maxDiskMb).toBe(1024);
    expect(cust1Api.quotas?.maxTrafficMb).toBe(2048);
    expect(cust1Api.quotas?.maxDatabases).toBe(2);
  });

  test('hatalı girdi, kapasite aşımı ve rol sınırları: 409 limit engeli, yetkisiz rotalar ve API uçları', async ({ page }) => {
    // Bayi oturumunu sağla
    await loginAs(page, RES_USER, TEST_PASS);
    await page.goto('/customers');
    await page.waitForURL(/\/customers/, { timeout: 10000 });

    // 1. 2. müşteriyi ekle (maxCustomers: 2 kotasını doldur)
    await page.locator('button:has-text("Müşteri ekle")').click();
    const createCustDialog = page.locator('dialog[open]');
    await expect(createCustDialog).toBeVisible({ timeout: 10000 });

    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST2_USER);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createCustDialog.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();
    await expect(createCustDialog).toBeHidden({ timeout: 15000 });

    const cust2Row = page.locator('table.ws-table tbody tr', { hasText: CUST2_USER });
    await expect(cust2Row).toBeVisible({ timeout: 15000 });

    // 2. 3. müşteri eklemeyi dene (Kapasite dolu, maxCustomers: 2 aşımı -> 409)
    await page.locator('button:has-text("Müşteri ekle")').click();
    await expect(createCustDialog).toBeVisible({ timeout: 10000 });

    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST3_USER);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createCustDialog.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const alertBox = createCustDialog.locator('[role="alert"]');
    await expect(alertBox).toBeVisible({ timeout: 10000 });
    await expect(alertBox).toContainText(/sınır|limit|dolu/i);

    // Dialogu kapat (kirli form koruması ile)
    await createCustDialog.locator('button:has-text("Vazgeç")').click();
    const discardBtn = createCustDialog.locator('button:has-text("Değişiklikleri bırak")');
    if (await discardBtn.isVisible()) {
      await discardBtn.click();
    }
    await expect(createCustDialog).toBeHidden({ timeout: 5000 });

    // 3. Müşteriye bayinin sınırını (maxWebsites: 2) aşan site kotası (5) vermeyi dene
    await cust2Row.locator('button:has-text("Kota tahsis et")').click();
    const quotaDialog = page.locator('dialog[open]');
    await expect(quotaDialog).toBeVisible({ timeout: 10000 });

    await quotaDialog.locator('label:has-text("Web Sitesi Kotası") input').fill('5');
    await quotaDialog.locator('button[type="submit"]:has-text("Kotaları Kaydet")').click();

    const quotaAlert = quotaDialog.locator('[role="alert"]');
    await expect(quotaAlert).toBeVisible({ timeout: 10000 });
    await expect(quotaAlert).toContainText(/sınır|limit|aşıyor/i);

    // Dialogu kapat (kirli form koruması ile)
    await quotaDialog.locator('button:has-text("Vazgeç")').click();
    const quotaDiscardBtn = quotaDialog.locator('button:has-text("Değişiklikleri bırak")');
    if (await quotaDiscardBtn.isVisible()) {
      await quotaDiscardBtn.click();
    }
    await expect(quotaDialog).toBeHidden({ timeout: 5000 });

    // 4. Owner rotalarına doğrudan URL ile gitmeyi dene -> /websites rotasına yönlenmeli
    await page.goto('/resellers');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    await page.goto('/tools-settings');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    await page.goto('/servers');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    await page.goto('/docker');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    // 5. Yetkisiz API uçları çağrıları: 403 Forbidden dönmeli
    const postTerminal = await page.request.post('/api/panel/terminal/capabilities', {
      data: { scope: 'server' },
    });
    expect(postTerminal.status()).toBe(403);

    const postAccount = await page.request.post('/api/panel/users/hosting/accounts', {
      data: { kind: 'reseller', username: `${prefix}-unauth`, password: TEST_PASS },
    });
    expect([401, 403]).toContain(postAccount.status());

    const patchLimits = await page.request.patch('/api/panel/users/hosting/accounts/self/limits', {
      data: { maxCustomers: 999 },
    });
    expect([401, 403, 404, 405]).toContain(patchLimits.status());
  });

  test('bilinen hata: Bayinin müşterisine site tahsis etme akışı sunucu yükleme kilidi veya tenant boundary hatası veriyor', async ({ page }) => {
    test.fail(true, 'BULGU T804: Bayi müşterisine site tahsis etme akışı sunucu yükleme kilidi ve 403 tenant boundary hatası veriyor');

    await loginAs(page, RES_USER, TEST_PASS);
    await page.goto('/customers');
    await page.waitForURL(/\/customers/, { timeout: 10000 });

    const cust1Row = page.locator('table.ws-table tbody tr', { hasText: CUST1_USER });
    await expect(cust1Row).toBeVisible({ timeout: 10000 });

    await cust1Row.locator('button:has-text("Site tahsis et")').click();
    const allocateDialog = page.locator('dialog[open]');
    await expect(allocateDialog).toBeVisible({ timeout: 10000 });
    await expect(allocateDialog.locator('h2')).toContainText('Site Tahsis Et');

    // Normalde sunucu listesi anında yüklenmeli ve "Yerel sunucu bilgisi yükleniyor…" mesajı gizlenmeli
    // Ancak T804 nedeniyle bu mesaj kaybolmaz ve Planı Önizle butonu disabled kalır
    const loadingNotice = allocateDialog.locator('p:has-text("Yerel sunucu bilgisi yükleniyor…")');
    await expect(loadingNotice).toBeHidden({ timeout: 5000 });

    const previewButton = allocateDialog.locator('button[type="submit"]:has-text("Planı Önizle")');
    await expect(previewButton).toBeEnabled();
  });
});
