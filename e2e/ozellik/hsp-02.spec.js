import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';
import fs from 'fs';
import path from 'path';

test.describe('HSP-02 Reseller oluştur/düzenle/askıya al/etkinleştir/sil', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `thsp02-a${agentN}-${Date.now().toString(36)}`;
  const resellerUser = `${prefix}-res1`;
  const secondResellerUser = `${prefix}-res2`;
  const childCustUser = `${prefix}-cust1`;
  const testPassword = 'Password12345678!';

  async function closeModal(modal) {
    for (let i = 0; i < 4; i++) {
      if (!await modal.isVisible()) break;
      const discardBtn = modal.locator('button:has-text("Değişiklikleri bırak")');
      if (await discardBtn.isVisible()) {
        await discardBtn.click();
        await pageWait(300);
        continue;
      }
      const cancelBtn = modal.locator('button:has-text("Vazgeç")');
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
        await pageWait(300);
        continue;
      }
      const closeBtn = modal.locator('button:has-text("Kapat")');
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await pageWait(300);
        continue;
      }
      const closeXBtn = modal.locator('button[aria-label="Pencereyi kapat"]');
      if (await closeXBtn.isVisible()) {
        await closeXBtn.click();
        await pageWait(300);
        continue;
      }
    }
    await expect(modal).not.toBeVisible({ timeout: 10000 });
  }

  function pageWait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        await pageWait(1000);
      }
    }
  }

  async function findResellerRow(page, username) {
    for (let p = 0; p < 5; p++) {
      await expect(page.locator('table.ws-table, .ws-empty-state')).toBeVisible({ timeout: 15000 });
      const row = page.locator('table.ws-table tbody tr', { hasText: username });
      if (await row.count() > 0 && await row.isVisible()) {
        return row;
      }
      const nextBtn = page.locator('footer.ws-pagination button:has-text("Sonraki")');
      if (await nextBtn.isVisible() && !await nextBtn.isDisabled()) {
        await nextBtn.click();
        await pageWait(500);
      } else {
        break;
      }
    }
    const finalRow = page.locator('table.ws-table tbody tr', { hasText: username });
    await expect(finalRow).toBeVisible({ timeout: 10000 });
    return finalRow;
  }

  test.afterAll(async ({ browser }) => {
    // Test kaynaklarını (müşteri ve bayi hesapları) eksiksiz temizle
    const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website';
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
      const sessionData = await sessionRes?.json().catch(() => null);
      const csrfToken = sessionData?.data?.csrfToken;
      const headers = csrfToken ? {
        'x-csrf-token': csrfToken,
        Origin: baseURL,
        Referer: `${baseURL}/`,
      } : {};

      // 1. Bu öneke ait tüm müşterileri sil (login hesabı ve profili)
      const custRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=100').catch(() => null);
      if (custRes && custRes.ok()) {
        const data = await custRes.json();
        const testCustomers = (data.data?.accounts || []).filter((a) => a.username && a.username.startsWith(prefix));
        for (const cust of testCustomers) {
          await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(cust.id)}/login`, {
            headers,
            data: {},
          }).catch((err) => console.warn(`Customer ${cust.username} delete notice:`, err.message));
        }
      }

      // 2. Bu öneke ait tüm bayileri unregister et
      const resRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=100').catch(() => null);
      if (resRes && resRes.ok()) {
        const data = await resRes.json();
        const testResellers = (data.data?.accounts || []).filter((a) => a.username && a.username.startsWith(prefix));
        for (const res of testResellers) {
          const profile = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(res.id)}`).then((r) => r.json()).catch(() => null);
          const rev = profile?.data?.revision ?? res.revision ?? 1;
          await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(res.id)}/profile`, {
            headers,
            data: {
              revision: rev,
              confirmation: `unregister-hosting-profile:${res.id}:${rev}`,
            },
          }).catch((err) => console.warn(`Reseller profile unregister notice:`, err.message));
        }
      }

      // 3. Bu öneke ait tüm kullanıcıları users tablosundan sil
      const usersRes = await page.request.get('/api/panel/users?limit=100').then((r) => r.json()).catch(() => null);
      const testUsers = (usersRes?.data?.users || []).filter((u) => u.username && u.username.startsWith(prefix));
      for (const u of testUsers) {
        await page.request.delete(`/api/panel/users/${encodeURIComponent(u.id)}`, {
          headers,
          data: { revision: u.revision },
        }).catch((err) => console.warn(`User ${u.username} delete notice:`, err.message));
      }

      // 4. Auth önbellek dosyalarını temizle
      for (const u of [resellerUser, secondResellerUser, childCustUser]) {
        const authFile = path.resolve('e2e/.auth', `${u}.json`);
        if (fs.existsSync(authFile)) {
          try { fs.unlinkSync(authFile); } catch {}
        }
      }
    } catch (err) {
      console.warn('HSP-02 afterAll cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('01. Mutlu yol: Bayi oluşturma, limit güncelleme, askıya alma ve yeniden açma', async ({ page }) => {
    // 1. Owner oturumuyla /resellers sayfasına git ve Bayi ekle modalını aç
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addBtn = page.locator('button:has-text("Bayi ekle")');
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(createModal).toBeVisible({ timeout: 10000 });

    // Bayi bilgilerini doldur
    await createModal.locator('label:has-text("Kullanıcı adı") input').fill(`  ${resellerUser}  `);
    await createModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await createModal.locator('label:has-text("En fazla müşteri") input').fill('2');
    await createModal.locator('label:has-text("En fazla web sitesi") input').fill('3');
    await createModal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    // Oluşturulma bildirimi ve tablodaki satırı doğrula
    const notice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(notice).toContainText(new RegExp(`${resellerUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    const resellerRow = await findResellerRow(page, resellerUser);
    await expect(resellerRow.locator('.ws-badge')).toContainText('Etkin');
    await expect(resellerRow).toContainText('0 / 3'); // Web siteleri: 0 / 3
    await expect(resellerRow).toContainText('0 / 2'); // Müşteriler: 0 / 2

    // 2. Fiziksel doğrulama: Yeni bayi hesabı ile panele giriş yap
    await logout(page);
    await loginAs(page, resellerUser, testPassword);

    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const sessionData = await sessionRes.json();
    expect(sessionData.data?.user?.username).toBe(resellerUser);
    const hosting = sessionData.data?.user?.hosting || sessionData.data?.hosting;
    expect(hosting?.kind).toBe('reseller');
    expect(hosting?.resellerId ?? null).toBeNull();

    // Bayi panelinde Müşterilerim sayfasını doğrula
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 3. Limit düzenleme: Owner oturumuna dön ve limitleri güncelle
    await logout(page);
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const manageRow = await findResellerRow(page, resellerUser);
    await manageRow.locator('button:has-text("Hesabı yönet")').click();

    const profileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi / müşteri profili' });
    await expect(profileModal).toBeVisible({ timeout: 10000 });

    // Toplam site limitini sınırsız yap, müşteri limitini 4'e yükselt
    const unlimitedWebsitesCheckbox = profileModal.locator('label:has-text("Toplam site: Sınırsız") input[type="checkbox"]');
    await unlimitedWebsitesCheckbox.check();

    const maxCustomersInput = profileModal.locator('label:has-text("Toplam müşteri") input[type="text"]');
    await maxCustomersInput.fill('4');

    await profileModal.locator('button[type="submit"]:has-text("Sınırları kaydet")').click();

    const limitNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'kaydedildi' });
    await expect(limitNotice).toContainText(/Adet sınırları kaydedildi/i, { timeout: 15000 });

    // Güncellenmiş limitler: Müşteri: 0 / 4
    const updatedRow = await findResellerRow(page, resellerUser);
    await expect(updatedRow).toContainText('0 / 4');

    // 4. Askıya alma: Hesabı askıya al
    await updatedRow.locator('button:has-text("Hesabı yönet")').click();
    await expect(profileModal).toBeVisible({ timeout: 10000 });

    await profileModal.locator('button:has-text("Hesabı askıya al")').first().click();
    await profileModal.locator('footer button:has-text("Hesabı askıya al")').click();

    const suspendNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'askıya alındı' });
    await expect(suspendNotice).toContainText(/Bayi hesabı askıya alındı/i, { timeout: 15000 });

    const suspendedRowCheck = await findResellerRow(page, resellerUser);
    await expect(suspendedRowCheck.locator('.ws-badge')).toContainText('Giriş kapalı');

    // Fiziksel doğrulama: Askıya alınan bayi giriş yapamaz
    await logout(page);
    const authFile = path.resolve('e2e/.auth', `${resellerUser}.json`);
    if (fs.existsSync(authFile)) {
      try { fs.unlinkSync(authFile); } catch {}
    }
    await page.goto('/');
    await page.fill('input[name="username"]', resellerUser);
    await page.fill('input[name="password"]', testPassword);
    await page.click('button.auth-primary');

    const errorAlert = page.locator('.auth-error, #auth-error, [role="alert"]');
    await expect(errorAlert).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.auth-sessionbar')).not.toBeVisible();

    // 5. Yeniden etkinleştirme: Girişi aç
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const suspendedRow = await findResellerRow(page, resellerUser);
    await suspendedRow.locator('button:has-text("Hesabı yönet")').click();
    await expect(profileModal).toBeVisible({ timeout: 10000 });

    await profileModal.locator('button:has-text("Girişi yeniden etkinleştir")').first().click();
    await profileModal.locator('footer button:has-text("Girişi etkinleştir")').click();

    const reactivateNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'etkinleştirildi' });
    await expect(reactivateNotice).toContainText(/Giriş hesabı yeniden etkinleştirildi/i, { timeout: 15000 });

    const activeRowCheck = await findResellerRow(page, resellerUser);
    await expect(activeRowCheck.locator('.ws-badge')).toContainText('Etkin');

    // Fiziksel doğrulama: Bayi tekrar oturum açabilir
    await logout(page);
    await loginAs(page, resellerUser, testPassword);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
  });

  test('02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, kapasite aşımı ve bağlı müşterili bayi profilini kaldırma engeli', async ({ page }) => {
    // 1. Mükerrer kullanıcı adı ile bayi ekleme reddedilmeli
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addBtn = page.locator('button:has-text("Bayi ekle")');
    await addBtn.click();
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    await modal.locator('label:has-text("Kullanıcı adı") input').fill(resellerUser);
    await modal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await modal.locator('label:has-text("En fazla müşteri") input').fill('2');
    await modal.locator('label:has-text("En fazla web sitesi") input').fill('3');
    await modal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const dupError = modal.locator('.ws-error, [role="alert"]');
    await expect(dupError).toBeVisible({ timeout: 10000 });
    await expect(dupError).toContainText(/kullanıcı adı zaten kullanımda|username_taken/i);
    await closeModal(modal);

    // 2. Kapasite sınırı: 1 müşteri sınırıyla ikinci bir bayi oluştur
    await addBtn.click();
    await expect(modal).toBeVisible({ timeout: 10000 });
    await modal.locator('label:has-text("Kullanıcı adı") input').fill(secondResellerUser);
    await modal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await modal.locator('label:has-text("En fazla müşteri") input').fill('1');
    await modal.locator('label:has-text("En fazla web sitesi") input').fill('2');
    await modal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const createNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(createNotice).toContainText(new RegExp(`${secondResellerUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Bayi 2 oturumuyla giriş yap ve müşteri ekle
    await logout(page);
    await loginAs(page, secondResellerUser, testPassword);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 1. müşteri (başarılı, kota 1/1 dolacak)
    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await addCustBtn.click();
    const custModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });

    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(childCustUser);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await custModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const custNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(custNotice).toContainText(new RegExp(`${childCustUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // 2. müşteriyi eklemeyi dene (kota 1 olduğu için reddedilmeli)
    await addCustBtn.click();
    await expect(custModal).toBeVisible({ timeout: 10000 });

    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(`${prefix}-overlimit`);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await custModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const overlimitError = custModal.locator('.ws-error, [role="alert"]');
    await expect(overlimitError).toBeVisible({ timeout: 10000 });
    await expect(overlimitError).toContainText(/adet sınırı doldu|reseller_limit_reached/i);
    await closeModal(custModal);

    // 3. Bağlı müşterisi olan bayide Profili kaldır engeli (409 hosting_account_in_use)
    await logout(page);
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const secondRow = await findResellerRow(page, secondResellerUser);
    await secondRow.locator('button:has-text("Hesabı yönet")').click();

    const profileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi / müşteri profili' });
    await expect(profileModal).toBeVisible({ timeout: 10000 });

    // Profili kaldır seçeneğine geç
    await profileModal.locator('button:has-text("Profili kaldır")').click();
    await profileModal.locator('label:has-text("Onaylamak için") input').fill(secondResellerUser);
    await profileModal.locator('footer button[type="submit"]:has-text("Profili kaldır")').click();

    const inUseError = profileModal.locator('.ws-error, [role="alert"]');
    await expect(inUseError).toBeVisible({ timeout: 10000 });
    await expect(inUseError).toContainText(/hosting_account_in_use|bağlı müşteri|kontenjan/i);
    await closeModal(profileModal);
  });

  test('03. Rol ve kiracı sınırları: Bayi yetki izolasyonu', async ({ page }) => {
    // 1. Bayi oturumunda Bayiler rotası /websites rotasına yönlenmeli
    await loginAs(page, resellerUser, testPassword);
    await expect(page.locator('a[href="/resellers"]')).toHaveCount(0);

    await page.goto('/resellers');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    // 2. Bayi API üzerinden doğrudan bayileri listeleyemez (403)
    const resListDeny = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller');
    expect(resListDeny.status()).toBe(403);

    // 3. Bayi API üzerinden kullanıcılar tablosunu listeleyemez (403)
    const usersDeny = await page.request.get('/api/panel/users');
    expect(usersDeny.status()).toBe(403);
  });

  test('04. Bilinen hata: /resellers ekranında bayi eklerken sınırsız (Sınırsız) limit onay kutusu bulunmalı', async ({ page }) => {
    test.fail(true, 'BULGU HSP-02: /resellers ekranında bayi eklerken sınırsız (Sınırsız) limit onay kutusu bulunmuyor (AccountCreateDialog yalnız zorunlu sayısal input içeriyor)');

    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addBtn = page.locator('button:has-text("Bayi ekle")');
    await addBtn.click();
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Mevcut formda Sınırsız onay kutusu bulunmamaktadır; bu beklenti test.fail ile yakalanır
    await expect(modal.locator('label:has-text("Sınırsız")')).toBeVisible({ timeout: 3000 });
  });
});
