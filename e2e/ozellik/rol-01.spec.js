import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-01 Yönetici Service Provider görünümü', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `trol01-a${agentN}-${Date.now().toString(36)}`;
  const RES1_USER = `${prefix}-res1`;
  const CUST1_USER = `${prefix}-cust1`;
  const DIRECT_USER = `${prefix}-direct`;
  const TEST_PASS = 'Tr0l01_A3_TestPass!2026';

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

  async function findAccountRow(page, username) {
    // Tabloda ya da sayfalama üzerinden satırı bul
    for (let pageNum = 0; pageNum < 6; pageNum++) {
      await expect(page.locator('table.ws-table, .ws-empty-state')).toBeVisible({ timeout: 15000 });
      const row = page.locator('table.ws-table tbody tr', { hasText: username });
      if (await row.count() > 0 && await row.first().isVisible()) {
        return row.first();
      }
      const nextBtn = page.locator('footer.ws-pagination button:has-text("Sonraki")');
      if (await nextBtn.isVisible() && !await nextBtn.isDisabled()) {
        await nextBtn.click();
        await expect(page.locator('table.ws-table')).toBeVisible({ timeout: 10000 });
      } else {
        break;
      }
    }
    const finalRow = page.locator('table.ws-table tbody tr', { hasText: username }).first();
    await expect(finalRow).toBeVisible({ timeout: 10000 });
    return finalRow;
  }

  async function cleanupAllTestAccounts(browser) {
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
      }, prefix);
    } finally {
      try {
        await context.close();
      } catch {}
    }
  }

  test.beforeEach(async ({ page }) => {
    await ensureOwnerLoggedIn(page);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: Owner Service Provider görünümü, bayi ve müşteri oluşturma, limit güncelleme ve fiziksel doğrulamalar', async ({ page }) => {
    // 1. Sol menü & Service Provider düzeni
    const sidebar = page.locator('aside.ws-sidebar');
    await expect(sidebar).toBeVisible();

    await expect(sidebar.locator('.ws-brand small')).toContainText(/sunucu/i);
    await expect(sidebar.locator('a[href="/websites"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/databases"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/customers"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/resellers"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/tools-settings"]')).toBeVisible();

    const sessionBar = page.locator('.auth-sessionbar');
    await expect(sessionBar.locator('.auth-role')).toContainText(/owner/i);

    // 2. Global /tools-settings ve /databases sayfalarını kontrol et
    await sidebar.locator('a[href="/tools-settings"]').click();
    await expect(page.locator('h1')).toContainText('Araçlar ve Ayarlar');
    await expect(page.locator('a.ws-console-quicklink[href="/dashboard"]')).toBeVisible();

    await sidebar.locator('a[href="/databases"]').click();
    await expect(page.locator('h1')).toContainText('Veritabanları');

    // 3. Bayiler (/resellers) sayfasına git ve Bayi ekle
    await sidebar.locator('a[href="/resellers"]').click();
    await expect(page.locator('h1')).toContainText('Bayiler');

    await page.locator('button:has-text("Bayi ekle")').click();
    const createResellerDialog = page.locator('dialog[open]');
    await expect(createResellerDialog.locator('h2')).toContainText('Bayi ekle');

    await createResellerDialog.locator('label:has-text("Kullanıcı adı") input').fill(RES1_USER);
    await createResellerDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createResellerDialog.locator('label:has-text("En fazla müşteri") input').fill('2');
    await createResellerDialog.locator('label:has-text("En fazla web sitesi") input').fill('3');
    await createResellerDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    await expect(createResellerDialog).toBeHidden({ timeout: 15000 });
    const resellerRow = await findAccountRow(page, RES1_USER);
    await expect(resellerRow).toContainText('Etkin');

    // 4. Bayi sınırlarını güncelle: maxCustomers: 1, maxWebsites: 2
    await resellerRow.locator('button:has-text("Hesabı yönet")').click();
    const manageResellerDialog = page.locator('dialog[open]');
    await expect(manageResellerDialog.locator('h2')).toContainText('Bayi / müşteri profili');

    const maxCustInput = manageResellerDialog.locator('label:has-text("Toplam müşteri") input[type="text"]');
    const maxWebInput = manageResellerDialog.locator('label:has-text("Toplam site") input[type="text"]');
    await expect(maxCustInput).toBeVisible();
    await maxCustInput.fill('1');
    await maxWebInput.fill('2');
    await manageResellerDialog.locator('button[type="submit"]:has-text("Sınırları kaydet")').click();
    await expect(manageResellerDialog).toBeHidden({ timeout: 15000 });

    // 5. Müşteriler (/customers) sayfasına git ve bayiye bağlı müşteri ekle
    await sidebar.locator('a[href="/customers"]').click();
    await expect(page.locator('h1')).toContainText('Müşteriler');

    await page.locator('button:has-text("Müşteri ekle")').click();
    const createCustDialog = page.locator('dialog[open]');
    await expect(createCustDialog.locator('h2')).toContainText('Müşteri ekle');

    // Bayi select opsiyonunun yüklenmesini bekle
    const resellerSelect = createCustDialog.locator('label:has-text("Bağlı bayi") select');
    await expect(resellerSelect.locator('option', { hasText: RES1_USER })).toBeAttached({ timeout: 10000 });
    const resOptionVal = await resellerSelect.locator('option', { hasText: RES1_USER }).getAttribute('value');

    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST1_USER);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await resellerSelect.selectOption(resOptionVal);
    await createCustDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
    await expect(createCustDialog).toBeHidden({ timeout: 15000 });

    await page.goto('/customers');
    const cust1Row = await findAccountRow(page, CUST1_USER);
    await expect(cust1Row).toBeVisible();

    // 6. Doğrudan Owner müşterisi ekle
    await page.locator('button:has-text("Müşteri ekle")').click();
    await expect(createCustDialog).toBeVisible({ timeout: 10000 });
    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(DIRECT_USER);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createCustDialog.locator('label:has-text("Bağlı bayi") select').selectOption('');
    await createCustDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
    await expect(createCustDialog).toBeHidden({ timeout: 15000 });

    await page.goto('/customers');
    const directRow = await findAccountRow(page, DIRECT_USER);
    await expect(directRow).toBeVisible();

    // 7. Bayiler sayfasına dön ve müşteri kotasının 1 / 1 olduğunu doğrula (doğrudan müşteri bayiyi etkilemez)
    await sidebar.locator('a[href="/resellers"]').click();
    await expect(page.locator('h1')).toContainText('Bayiler');
    const updatedResRow = await findAccountRow(page, RES1_USER);
    await expect(updatedResRow).toContainText('1 / 1');

    // 8. Müşteri bazlı web sitesi filtrelemesi (/websites?customer=<id>)
    await sidebar.locator('a[href="/customers"]').click();
    await expect(page.locator('h1')).toContainText('Müşteriler');
    const customerFilterRow = await findAccountRow(page, CUST1_USER);
    await customerFilterRow.locator('a:has-text("Web siteleri")').click();
    await page.waitForURL(/\/websites\?customer=/, { timeout: 10000 });
    await expect(page.locator('p.ws-notice')).toContainText(new RegExp(`${CUST1_USER}|web siteleri`, 'i'));

    // Tüm siteler bağlantısıyla listeye dön
    await page.locator('p.ws-notice a:has-text("Tüm siteler")').click();
    await page.waitForURL((u) => u.pathname === '/websites' && !u.searchParams.has('customer'), { timeout: 10000 });

    // 9. Fiziksel doğrulamalar: API session & reseller limits
    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const sessionBody = await sessionRes.json();
    expect(sessionBody.data?.user?.role).toBe('owner');
    expect(sessionBody.data?.access?.permissions).toContain('*');

    const resApiRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller');
    expect(resApiRes.ok()).toBeTruthy();
    const resApiBody = await resApiRes.json();
    const targetRes = (resApiBody.data?.accounts || []).find((a) => a.username === RES1_USER);
    expect(targetRes).toBeTruthy();
    expect(targetRes.limits.maxCustomers).toBe(1);
    expect(targetRes.limits.maxWebsites).toBe(2);
  });

  test('hatalı girdi: bayi kotası aşımı (409), mükerrer kullanıcı (409), bağlı müşterisi olan bayiyi silme engeli (409) ve geçersiz müşteri filtresi (404)', async ({ page }) => {
    const sidebar = page.locator('aside.ws-sidebar');

    // 1. Bayi müşteri kotası aşımı (1/1 dolu olan bayiye ikinci müşteri ekleme denemesi)
    await sidebar.locator('a[href="/customers"]').click();
    await expect(page.locator('h1')).toContainText('Müşteriler');

    await page.locator('button:has-text("Müşteri ekle")').click();
    const createCustDialog = page.locator('dialog[open]');
    await expect(createCustDialog).toBeVisible({ timeout: 10000 });

    const resellerSelect = createCustDialog.locator('label:has-text("Bağlı bayi") select');
    await expect(resellerSelect.locator('option', { hasText: RES1_USER })).toBeAttached({ timeout: 10000 });
    const resOptionVal = await resellerSelect.locator('option', { hasText: RES1_USER }).getAttribute('value');

    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(`${prefix}-over`);
    await createCustDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await resellerSelect.selectOption(resOptionVal);
    await createCustDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const alertBox = createCustDialog.locator('[role="alert"]');
    await expect(alertBox).toBeVisible({ timeout: 10000 });
    await expect(alertBox).toContainText(/sınır|kota|limit/i);

    // 2. Mükerrer kullanıcı adı denemesi
    await createCustDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST1_USER);
    await createCustDialog.locator('label:has-text("Bağlı bayi") select').selectOption('');
    await createCustDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    await expect(alertBox).toBeVisible({ timeout: 10000 });
    await expect(alertBox).toContainText(/kullanımda|mevcut|zaten/i);

    await createCustDialog.locator('button:has-text("Vazgeç")').click();
    await expect(createCustDialog).toBeHidden({ timeout: 10000 });

    // 3. Bağlı müşterisi olan bayiyi silme engeli (409)
    await sidebar.locator('a[href="/resellers"]').click();
    await expect(page.locator('h1')).toContainText('Bayiler');
    const resRow = await findAccountRow(page, RES1_USER);

    await resRow.locator('button:has-text("Hesabı yönet")').click();
    const manageDialog = page.locator('dialog[open]');
    await expect(manageDialog).toBeVisible({ timeout: 10000 });

    await manageDialog.locator('button:has-text("Profili kaldır")').click();
    await manageDialog.locator(`label:has-text("Onaylamak için ${RES1_USER} yazın") input`).fill(RES1_USER);
    await manageDialog.locator('button[type="submit"]:has-text("Profili kaldır")').click();

    const resAlertBox = manageDialog.locator('[role="alert"]');
    await expect(resAlertBox).toBeVisible({ timeout: 10000 });
    await expect(resAlertBox).toContainText(/bağlı|korunuyor|kaldırılamadı/i);

    const closeBtn = manageDialog.locator('button:has-text("Kapat")');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
    }
    const discardBtn = page.locator('dialog[open] button:has-text("Değişiklikleri bırak")');
    if (await discardBtn.isVisible()) {
      await discardBtn.click();
    }
    await expect(manageDialog).toBeHidden({ timeout: 10000 });

    // 4. Geçersiz müşteri ID'si ile filtreleme (404)
    await page.goto('/websites?customer=olmayan-musteri-999');
    await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[role="alert"]')).toContainText(/bulunmuyor|bulunamadı|geçersiz/i);
  });

  test('yetki ve rol izolasyonu: Reseller ve Customer yetki sınırları ve bayiyi askıya alma/etkinleştirme zinciri', async ({ browser, page }) => {
    // 1. Bayi (RES1_USER) oturumu aç
    const resContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const resPage = await resContext.newPage();
    await resPage.goto('/');
    await resPage.locator('form.auth-form input[name="username"]').fill(RES1_USER);
    await resPage.locator('form.auth-form input[name="password"]').fill(TEST_PASS);
    await resPage.locator('form.auth-form button[type="submit"]').click();
    await expect(resPage.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // Bayi /customers sayfasına gittiğinde yalnız kendi müşterisini görmeli (DIRECT_USER görünmemeli)
    await resPage.locator('aside.ws-sidebar a[href="/customers"]').click();
    await expect(resPage.locator('h1')).toContainText('Müşterilerim');
    const resCustomerRow = await findAccountRow(resPage, CUST1_USER);
    await expect(resCustomerRow).toBeVisible({ timeout: 15000 });
    await expect(resPage.locator('table.ws-table tbody tr', { hasText: DIRECT_USER })).toBeHidden();

    // Bayi Service Provider rotalarına girmeye çalıştığında /websites adresine yönlendirilmeli
    for (const forbiddenRoute of ['/resellers', '/tools-settings', '/dashboard', '/servers', '/settings/users']) {
      await resPage.goto(forbiddenRoute);
      await expect(resPage).toHaveURL(/\/websites/, { timeout: 10000 });
    }

    // Bayi için Owner API uçları 403 dönmeli
    const forbiddenResellerApi = await resPage.evaluate(async () => {
      const r1 = await fetch('/api/panel/users/hosting/accounts?kind=reseller');
      const r2 = await fetch('/api/panel/users');
      return { r1Status: r1.status, r2Status: r2.status };
    });
    expect(forbiddenResellerApi.r1Status).toBe(403);
    expect(forbiddenResellerApi.r2Status).toBe(403);

    // 2. Alt müşteri (CUST1_USER) oturumu aç
    const cust1Context = await browser.newContext({ ignoreHTTPSErrors: true });
    const cust1Page = await cust1Context.newPage();
    await cust1Page.goto('/');
    await cust1Page.locator('form.auth-form input[name="username"]').fill(CUST1_USER);
    await cust1Page.locator('form.auth-form input[name="password"]').fill(TEST_PASS);
    await cust1Page.locator('form.auth-form button[type="submit"]').click();
    await expect(cust1Page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 3. Doğrudan müşteri (DIRECT_USER) oturumu aç
    const directContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const directPage = await directContext.newPage();
    await directPage.goto('/');
    await directPage.locator('form.auth-form input[name="username"]').fill(DIRECT_USER);
    await directPage.locator('form.auth-form input[name="password"]').fill(TEST_PASS);
    await directPage.locator('form.auth-form button[type="submit"]').click();
    await expect(directPage.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 4. Owner sayfasından bayiyi askıya al
    await page.goto('/resellers');
    await expect(page.locator('h1')).toContainText('Bayiler');
    const resRow = await findAccountRow(page, RES1_USER);

    await resRow.locator('button:has-text("Hesabı yönet")').click();
    const manageDialog = page.locator('dialog[open]');
    await expect(manageDialog).toBeVisible({ timeout: 10000 });

    await manageDialog.locator('button:has-text("Hesabı askıya al")').click();
    await manageDialog.locator('footer button:has-text("Hesabı askıya al")').click();
    await expect(manageDialog).toBeHidden({ timeout: 15000 });

    // 5. Askıya alma zincirinde oturum iptali kontrolü:
    // RES1_USER ve CUST1_USER anında 401 Unauthorized olmalı!
    const resSessionStatus = await resPage.evaluate(async () => (await fetch('/api/auth/session')).status);
    const cust1SessionStatus = await cust1Page.evaluate(async () => (await fetch('/api/auth/session')).status);
    // DIRECT_USER oturumu ise aktif (200 OK) kalmalı!
    const directSessionStatus = await directPage.evaluate(async () => (await fetch('/api/auth/session')).status);

    expect(resSessionStatus).toBe(401);
    expect(cust1SessionStatus).toBe(401);
    expect(directSessionStatus).toBe(200);

    // 6. Bayiyi tekrar etkinleştir
    await resRow.locator('button:has-text("Hesabı yönet")').click();
    await expect(manageDialog).toBeVisible({ timeout: 10000 });
    await manageDialog.locator('button:has-text("Girişi yeniden etkinleştir")').click();
    await manageDialog.locator('footer button:has-text("Girişi etkinleştir")').click();
    await expect(manageDialog).toBeHidden({ timeout: 15000 });

    await resContext.close();
    await cust1Context.close();
    await directContext.close();
  });

  test('bilinen hata: /customers tablosunda ve profil modalında bağlı bayi kullanıcı adı görünmelidir', async ({ page }) => {
    test.fail(true, 'BULGU ROL-01: /customers tablosunda bağlı bayi sütunu yok ve profil modalında bayi adı yerine ham UUID gösteriliyor');

    await page.goto('/customers');
    await expect(page.locator('h1')).toContainText('Müşteriler');

    const custRow = await findAccountRow(page, CUST1_USER);

    // Beklenen davranış: Tabloda bağlı bayi adı (RES1_USER) görünmelidir
    await expect(custRow).toContainText(RES1_USER);

    // Profil modalında da bayi adı görünmelidir (ham UUID yerine)
    await custRow.locator('button:has-text("Hesabı yönet")').click();
    const modal = page.locator('dialog[open]');
    await expect(modal).toBeVisible({ timeout: 10000 });
    const modalText = await modal.innerText();
    expect(modalText).toContain(`Bağlı bayi: ${RES1_USER}`);
  });
});
