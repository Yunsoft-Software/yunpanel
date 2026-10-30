import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.describe('HSP-01 Müşteri oluştur/düzenle/askıya al/etkinleştir/sil', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `thsp01-a${agentN}-${Date.now().toString(36)}`;
  const resellerUser = `${prefix}-res`;
  const directCustUser = `${prefix}-cdir`;
  const childCustUser = `${prefix}-cchld`;
  const updatedChildUser = `${prefix}-cupd`;
  const secondChildUser = `${prefix}-cch2`;
  const testPassword = 'Password12345678!';
  const updatedPassword = 'NewPassword123456!';

  let directCustId = null;
  let resellerId = null;

  async function closeModal(modal) {
    const cancelBtn = modal.locator('button:has-text("Vazgeç")');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    }
    const discardBtn = modal.locator('button:has-text("Değişiklikleri bırak")');
    if (await discardBtn.isVisible()) {
      await discardBtn.click();
    }
    await expect(modal).not.toBeVisible({ timeout: 10000 });
  }

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        await page.waitForTimeout(2000);
      }
    }
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

      // 1. Bu öneke ait tüm müşterileri sil
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

      // 2. Bu öneke ait tüm bayileri sil (önce profil unregister)
      const resRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=100').catch(() => null);
      if (resRes && resRes.ok()) {
        const data = await resRes.json();
        const testResellers = (data.data?.accounts || []).filter((a) => a.username && a.username.startsWith(prefix));
        for (const res of testResellers) {
          const profile = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(res.id)}`).then((r) => r.json()).catch(() => null);
          const rev = profile?.data?.revision ?? 1;
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
    } catch (err) {
      console.warn('HSP-01 afterAll cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('01. Mutlu yol: Müşteri oluşturma, düzenleme, kota atama, askıya alma ve yeniden açma', async ({ page }) => {
    // 1. Owner olarak Bayi oluştur (En fazla müşteri: 2, En fazla web sitesi: 3)
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addResBtn = page.locator('button:has-text("Bayi ekle")');
    await expect(addResBtn).toBeVisible();
    await addResBtn.click();

    const resModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(resModal).toBeVisible({ timeout: 10000 });
    await resModal.locator('label:has-text("Kullanıcı adı") input').fill(resellerUser);
    await resModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await resModal.locator('label:has-text("En fazla müşteri") input').fill('2');
    await resModal.locator('label:has-text("En fazla web sitesi") input').fill('3');
    await resModal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const resNotice = page.locator('.ws-notice').filter({ hasText: 'hesabı oluşturuldu' });
    await expect(resNotice).toContainText(new RegExp(`${resellerUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Bayi ID'sini kaydet
    const resList = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=50');
    expect(resList.status()).toBe(200);
    const resData = await resList.json();
    const createdRes = resData.data.accounts.find((a) => a.username === resellerUser);
    expect(createdRes).toBeTruthy();
    resellerId = createdRes.id;

    // 2. Owner olarak doğrudan yönetimli müşteri oluştur
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(addCustBtn).toBeVisible();
    await addCustBtn.click();

    const custModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });
    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(directCustUser);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await custModal.locator('label:has-text("Bağlı bayi") select').selectOption({ label: 'Doğrudan yönetim' });
    await custModal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const custNotice = page.locator('.ws-notice').filter({ hasText: 'hesabı oluşturuldu' });
    await expect(custNotice).toContainText(new RegExp(`${directCustUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Direct müşteri ID'sini kaydet
    const directList = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=50');
    expect(directList.status()).toBe(200);
    const directData = await directList.json();
    const createdDirect = directData.data.accounts.find((a) => a.username === directCustUser);
    expect(createdDirect).toBeTruthy();
    directCustId = createdDirect.id;

    // 3. Bayi olarak giriş yap ve Müşterilerim sayfasına git
    await logout(page);
    await loginAs(page, resellerUser, testPassword);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // Doğrudan Owner müşterisi bayi listesinde OLMAMALI
    const foreignRow = page.locator('table.ws-table tbody tr', { hasText: directCustUser });
    await expect(foreignRow).toHaveCount(0);

    // 4. Bayi ekranından müşteri oluştur
    const resellerAddBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(resellerAddBtn).toBeVisible();
    await resellerAddBtn.click();

    const resellerCustModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(resellerCustModal).toBeVisible({ timeout: 10000 });
    await resellerCustModal.locator('label:has-text("Kullanıcı adı") input').fill(childCustUser);
    await resellerCustModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await resellerCustModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const childNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(childNotice).toContainText(new RegExp(`${childCustUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    const childRow = page.locator('table.ws-table tbody tr', { hasText: childCustUser });
    await expect(childRow).toBeVisible({ timeout: 10000 });
    await expect(childRow.locator('td', { hasText: 'Etkin' })).toBeVisible();

    // 5. Bayi ekranından müşteri giriş bilgilerini düzenle (username + password)
    await childRow.locator('button:has-text("Girişi düzenle")').click();
    const editModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri girişini düzenle' });
    await expect(editModal).toBeVisible({ timeout: 10000 });

    await editModal.locator('label:has-text("Kullanıcı adı") input').fill(updatedChildUser);
    await editModal.locator('label:has-text("Yeni parola") input').fill(updatedPassword);
    await editModal.locator('button[type="submit"]:has-text("Girişi kaydet")').click();

    const editNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'giriş bilgileri güncellendi' });
    await expect(editNotice).toContainText(new RegExp(`${updatedChildUser} giriş bilgileri güncellendi`, 'i'), { timeout: 15000 });

    const updatedRow = page.locator('table.ws-table tbody tr', { hasText: updatedChildUser });
    await expect(updatedRow).toBeVisible({ timeout: 10000 });

    // 6. Bayi ekranından kaynak kotaları ata (Web Sitesi: 2, Disk: 1024, Trafik: 5120, DB: 2)
    await updatedRow.locator('button:has-text("Kota tahsis et")').click();
    const quotaModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Kaynak Kotalarını Yönet' });
    await expect(quotaModal).toBeVisible({ timeout: 10000 });

    await quotaModal.locator('label:has-text("Web Sitesi Kotası") input').fill('2');
    await quotaModal.locator('label:has-text("Disk Kotası") input').fill('1024');
    await quotaModal.locator('label:has-text("Aylık Trafik Kotası") input').fill('5120');
    await quotaModal.locator('label:has-text("Veritabanı Kotası") input').fill('2');
    await quotaModal.locator('button[type="submit"]:has-text("Kotaları Kaydet")').click();

    const quotaNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'kaynak kotaları güncellendi' });
    await expect(quotaNotice).toContainText(new RegExp(`${updatedChildUser} müşterisinin kaynak kotaları güncellendi`, 'i'), { timeout: 15000 });

    // Tabloda kotaların yansıdığını doğrula
    await expect(updatedRow.locator('td', { hasText: '0 / 2' })).toBeVisible();
    await expect(updatedRow.locator('td', { hasText: '1024 MB' })).toBeVisible();
    await expect(updatedRow.locator('td', { hasText: '5120 MB' })).toBeVisible();
    await expect(updatedRow.locator('td', { hasText: '2' }).last()).toBeVisible();

    // 7. Müşteriyi askıya al ve buton durumunu doğrula
    await updatedRow.locator('button:has-text("Askıya al")').click();
    const suspendModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteriyi askıya al' });
    await expect(suspendModal).toBeVisible({ timeout: 10000 });
    await suspendModal.locator('button[type="submit"]:has-text("Hesabı askıya al")').click();

    const suspendNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'askıya alındı' });
    await expect(suspendNotice).toContainText(new RegExp(`${updatedChildUser} giriş hesabı askıya alındı`, 'i'), { timeout: 15000 });

    await expect(updatedRow.locator('td', { hasText: 'Askıda (Kilitli)' })).toBeVisible();
    await expect(updatedRow.locator('button:has-text("Site tahsis et")')).toBeDisabled();

    // 8. Müşteriyi yeniden aç
    await updatedRow.locator('button:has-text("Yeniden aç")').click();
    const reactivateModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteriyi yeniden aç' });
    await expect(reactivateModal).toBeVisible({ timeout: 10000 });
    await reactivateModal.locator('button[type="submit"]:has-text("Girişi yeniden aç")').click();

    const reactivateNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'yeniden açıldı' });
    await expect(reactivateNotice).toContainText(new RegExp(`${updatedChildUser} giriş hesabı yeniden açıldı`, 'i'), { timeout: 15000 });

    await expect(updatedRow.locator('td', { hasText: 'Etkin' })).toBeVisible();
    await expect(updatedRow.locator('button:has-text("Site tahsis et")')).toBeEnabled();

    // 9. Fiziksel kanıt: Güncellenen müşteri hesabı ile başarılı giriş ve API kota kontrolü
    await logout(page);
    await loginAs(page, updatedChildUser, updatedPassword);

    const sessionBar = page.locator('.auth-sessionbar');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
    await expect(sessionBar).toContainText(updatedChildUser);

    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.status()).toBe(200);
    const sessionJson = await sessionRes.json();
    expect(sessionJson.data?.user?.username).toBe(updatedChildUser);
    expect(['customer', 'site_manager']).toContain(sessionJson.data?.user?.role);

    const selfProfileRes = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(sessionJson.data.user.id)}`);
    expect(selfProfileRes.status()).toBe(200);
    const selfData = await selfProfileRes.json();
    expect(selfData.data.active).toBe(true);
    expect(selfData.data.kind).toBe('customer');
    expect(selfData.data.quotas.maxWebsites).toBe(2);
    expect(selfData.data.quotas.maxDiskMb).toBe(1024);
    expect(selfData.data.quotas.maxTrafficMb).toBe(5120);
    expect(selfData.data.quotas.maxDatabases).toBe(2);
  });

  test('02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, bayi müşteri ve site kotası sınırı aşımı', async ({ page }) => {
    // 1. Mükerrer kullanıcı adı kontrolü (Owner müşteriler sayfasında var olan directCustUser adını tekrar dener)
    await ensureOwnerLoggedIn(page);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await addCustBtn.click();
    const custModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });

    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(directCustUser);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await custModal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    // Hata bildirimi kontrolü: Bu kullanıcı adı zaten kullanımda
    const errorNotice = custModal.locator('.ws-error, [role="alert"]');
    await expect(errorNotice).toContainText(/zaten kullanımda|username_taken/i, { timeout: 10000 });
    await closeModal(custModal);

    // 2. Bayi müşteri sınırı aşımı (Reseller sınırı: 2. 1. müşteri güncellendi, 2. müşteri eklenecek, 3. müşteri reddedilmeli)
    await logout(page);
    await loginAs(page, resellerUser, testPassword);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 2. müşteriyi ekle (başarılı olmalı, 2/2 dolacak)
    const addSecondBtn = page.locator('button:has-text("Müşteri ekle")');
    await addSecondBtn.click();
    const secondModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(secondModal).toBeVisible({ timeout: 10000 });

    await secondModal.locator('label:has-text("Kullanıcı adı") input').fill(secondChildUser);
    await secondModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await secondModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const secondNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(secondNotice).toContainText(new RegExp(`${secondChildUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // 3. müşteriyi eklemeyi dene (sınır 2 olduğu için reddedilmeli)
    await addSecondBtn.click();
    const thirdModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(thirdModal).toBeVisible({ timeout: 10000 });

    await thirdModal.locator('label:has-text("Kullanıcı adı") input').fill(`${prefix}-overlimit`);
    await thirdModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await thirdModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const thirdError = thirdModal.locator('.ws-error, [role="alert"]');
    await expect(thirdError).toContainText(/adet sınırı doldu|reseller_limit_reached/i, { timeout: 10000 });
    await closeModal(thirdModal);

    // 3. Bayi site sınırını aşan müşteri kotası (Bayi sınırı: 3 web sitesi, müşteriye 10 verilmeye çalışılır)
    const secondRow = page.locator('table.ws-table tbody tr', { hasText: secondChildUser });
    await expect(secondRow).toBeVisible({ timeout: 10000 });
    await secondRow.locator('button:has-text("Kota tahsis et")').click();

    const quotaModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Kaynak Kotalarını Yönet' });
    await expect(quotaModal).toBeVisible({ timeout: 10000 });

    await quotaModal.locator('label:has-text("Web Sitesi Kotası") input').fill('10');
    await quotaModal.locator('button[type="submit"]:has-text("Kotaları Kaydet")').click();

    const quotaError = quotaModal.locator('.ws-error, [role="alert"]');
    await expect(quotaError).toContainText(/adet sınırı doldu|reseller_limit_reached|limit/i, { timeout: 10000 });
    await closeModal(quotaModal);
  });

  test('03. Rol ve kiracı sınırları: Müşteri ve bayi yetki izolasyonu', async ({ page }) => {
    // 1. Müşteri oturumunda Müşteriler ve Bayiler menüsü bulunmamalı, /customers doğrudan /websites'e yönlenmeli
    await loginAs(page, updatedChildUser, updatedPassword);
    await expect(page.locator('a[href="/customers"]')).toHaveCount(0);
    await expect(page.locator('a[href="/resellers"]')).toHaveCount(0);

    await page.goto('/customers');
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    // Müşteri API üzerinden hesap yönetimi sorgulayamaz (403)
    const custDenyRes = await page.request.get('/api/panel/users/hosting/accounts');
    expect(custDenyRes.status()).toBe(403);

    // 2. Bayi oturumunda yabancı müşteri izolasyonu
    await logout(page);
    await loginAs(page, resellerUser, testPassword);

    // Bayi doğrudan Owner müşterisinin profiline erişemez (403 veya 404)
    if (directCustId) {
      const foreignRes = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}`);
      expect([403, 404]).toContain(foreignRes.status());
    }

    // Bayi başka bayileri listeleyemez (403)
    const resDenyRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller');
    expect(resDenyRes.status()).toBe(403);
  });

  test('04. Bilinen hata: Bayi arayüzünde müşteri silme (Sil) butonu bulunmalı', async ({ page }) => {
    test.fail(true, 'BULGU HSP-01: Bayi ekranında müşteri silme butonu bulunmuyor (DELETE login API ön yüze bağlanmamış)');

    await loginAs(page, resellerUser, testPassword);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    const custRow = page.locator('table.ws-table tbody tr', { hasText: updatedChildUser });
    await expect(custRow).toBeVisible({ timeout: 10000 });

    // Mevcut arayüzde Sil butonu bulunmuyor; bu beklenti test.fail ile yakalanır
    await expect(custRow.locator('button:has-text("Sil")')).toBeVisible({ timeout: 3000 });
  });
});
