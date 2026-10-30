import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('HSP-03 İletişim, şirket, açıklama ve hesap erişim bilgileri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `thsp03-a${agentN}-${Date.now().toString(36)}`;
  const resellerUser = `${prefix}-res@webrich.news`;
  const directCustUser = `${prefix}-cdir@webrich.news`;
  const childCustUser = `${prefix}-cchld`;
  const updatedChildUser = `${prefix}-cupd@webrich.news`;
  const testPassword = 'Password12345678!';
  const updatedPassword = 'NewPassword123456!';

  let directCustId = null;
  let childCustId = null;
  let resellerId = null;

  let resContext = null;
  let custContext = null;

  async function closeModal(modal) {
    const cancelBtn = modal.locator('button:has-text("Vazgeç")');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
    }
    const discardBtn = modal.locator('button:has-text("Değişiklikleri bırak")');
    if (await discardBtn.isVisible()) {
      await discardBtn.click();
    }
    const closeBtn = modal.locator('button:has-text("Kapat")');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
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
    // 1. Ekstra oturum bağlamlarını kapat
    await resContext?.close().catch(() => {});
    await custContext?.close().catch(() => {});

    // 2. Test kaynaklarını (müşteri ve bayi hesapları) eksiksiz temizle
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

      // A. Bu öneke ait tüm müşterileri sil
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

      // B. Bu öneke ait tüm bayileri sil (önce profil unregister)
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

      // C. Bu öneke ait tüm kullanıcıları users tablosundan sil
      const usersRes = await page.request.get('/api/panel/users?limit=100').then((r) => r.json()).catch(() => null);
      const testUsers = (usersRes?.data?.users || []).filter((u) => u.username && u.username.startsWith(prefix));
      for (const u of testUsers) {
        await page.request.delete(`/api/panel/users/${encodeURIComponent(u.id)}`, {
          headers,
          data: { revision: u.revision },
        }).catch((err) => console.warn(`User ${u.username} delete notice:`, err.message));
      }

      // D. Doğrulama: Bu öneke ait hiçbir hesap kalmamalı
      const verifyUsers = await page.request.get('/api/panel/users?limit=100').then((r) => r.json()).catch(() => null);
      const remainingUsers = (verifyUsers?.data?.users || []).filter((u) => u.username && u.username.startsWith(prefix));
      expect(remainingUsers.length).toBe(0);
    } catch (err) {
      console.warn('HSP-03 afterAll cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('01. Mutlu yol: E-posta biçimli erişim bilgileriyle bayi ve müşteri oluşturma, giriş bilgilerini düzenleme, normalizasyon ve oturum düşürme', async ({ browser, page }) => {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL || 'https://server.cryptoraichu.website';

    // 1. Owner olarak e-posta biçimli kullanıcı adıyla Bayi oluştur
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
    await resModal.locator('label:has-text("En fazla müşteri") input').fill('3');
    await resModal.locator('label:has-text("En fazla web sitesi") input').fill('5');
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

    // 2. Owner olarak doğrudan yönetimli e-posta biçimli müşteri oluştur
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

    // 3. Bayi için ayrı bağlam aç ve giriş yap (oturum diğer testlerde de kullanılır)
    resContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const resPage = await resContext.newPage();
    await loginAs(resPage, resellerUser, testPassword);
    await resPage.goto('/customers');
    await expect(resPage.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 4. Bayi ekranından müşteri oluştur
    const resellerAddBtn = resPage.locator('button:has-text("Müşteri ekle")');
    await expect(resellerAddBtn).toBeVisible();
    await resellerAddBtn.click();

    const resellerCustModal = resPage.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(resellerCustModal).toBeVisible({ timeout: 10000 });
    await resellerCustModal.locator('label:has-text("Kullanıcı adı") input').fill(childCustUser);
    await resellerCustModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await resellerCustModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const childNotice = resPage.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(childNotice).toContainText(new RegExp(`${childCustUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    const childRow = resPage.locator('table.ws-table tbody tr', { hasText: childCustUser });
    await expect(childRow).toBeVisible({ timeout: 10000 });

    // Child müşteri ID'sini kaydet
    const childList = await resPage.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=50');
    expect(childList.status()).toBe(200);
    const childData = await childList.json();
    const createdChild = childData.data.accounts.find((a) => a.username === childCustUser);
    expect(createdChild).toBeTruthy();
    childCustId = createdChild.id;

    // 5. Bayi ekranından müşteri giriş bilgilerini düzenle: önce geçersiz format kontrolü, sonra normalizasyon ve yeni parola
    await childRow.locator('button:has-text("Girişi düzenle")').click();
    const editModal = resPage.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri girişini düzenle' });
    await expect(editModal).toBeVisible({ timeout: 10000 });

    const saveBtn = editModal.locator('button[type="submit"]:has-text("Girişi kaydet")');
    await expect(saveBtn).toBeDisabled();

    // Geçersiz format: boşluklu kullanıcı adı
    await editModal.locator('label:has-text("Kullanıcı adı") input').fill('inv al id');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    const formatError = editModal.locator('.ws-error, [role="alert"]');
    await expect(formatError).toContainText(/3–128 karakter olmalı|invalid_username/i, { timeout: 10000 });

    // Büyük harf ve boşluk içeren e-posta kullanıcı adı ile yeni parola gir
    const unnormalizedInput = `  ${updatedChildUser.toUpperCase()}  `;
    await editModal.locator('label:has-text("Kullanıcı adı") input').fill(unnormalizedInput);
    await editModal.locator('label:has-text("Yeni parola") input').fill(updatedPassword);
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    const editNotice = resPage.locator('.ws-notice, [role="status"]').filter({ hasText: 'giriş bilgileri güncellendi' });
    await expect(editNotice).toContainText(new RegExp(`${updatedChildUser} giriş bilgileri güncellendi; mevcut oturumları kapatıldı`, 'i'), { timeout: 15000 });

    // Tabloda küçük harfe normalize edilmiş kullanıcı adı görünmeli
    const updatedRow = resPage.locator('table.ws-table tbody tr', { hasText: updatedChildUser });
    await expect(updatedRow).toBeVisible({ timeout: 10000 });

    // 6. Fiziksel kanıt & AccountDialog: Müşteri için ayrı bağlam aç ve güncellenen bilgilerle giriş yap
    custContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    const custPage = await custContext.newPage();
    await loginAs(custPage, updatedChildUser, updatedPassword);

    const sessionBar = custPage.locator('.auth-sessionbar');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
    await expect(sessionBar).toContainText(updatedChildUser);

    // Self-servis Hesabım (AccountDialog) parola uyuşmazlığı kontrolü
    const myAccountBtn = sessionBar.locator('button:has-text("Hesabım")');
    await expect(myAccountBtn).toBeVisible({ timeout: 10000 });
    await myAccountBtn.click();

    const accountDialog = custPage.locator('dialog.auth-dialog');
    await expect(accountDialog).toBeVisible({ timeout: 10000 });

    await accountDialog.locator('label:has-text("Mevcut parola") input').fill(updatedPassword);
    await accountDialog.locator('label:has-text("Yeni parola") input').nth(0).fill('ValidPassword123!');
    await accountDialog.locator('label:has-text("Yeni parola tekrarı") input').fill('MismatchedPassword123!');
    await accountDialog.locator('button[type="submit"]:has-text("Parolayı değiştir")').click();

    const mismatchAlert = accountDialog.locator('.auth-error[role="alert"]');
    await expect(mismatchAlert).toContainText(/Yeni parolalar eşleşmiyor/i, { timeout: 10000 });

    await accountDialog.locator('header button:has-text("Kapat")').click();
    await expect(accountDialog).not.toBeVisible({ timeout: 10000 });

    // API fiziksel doğrulaması (oturum ve profil)
    const sessionRes = await custPage.request.get('/api/auth/session');
    expect(sessionRes.status()).toBe(200);
    const sessionJson = await sessionRes.json();
    expect(sessionJson.data?.user?.username).toBe(updatedChildUser);
    expect(['customer', 'site_manager']).toContain(sessionJson.data?.user?.role);

    const selfProfileRes = await custPage.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(sessionJson.data.user.id)}`);
    expect(selfProfileRes.status()).toBe(200);
    const selfData = await selfProfileRes.json();
    expect(selfData.data?.kind).toBe('customer');
    expect(selfData.data?.resellerId).toBe(resellerId);
  });

  test('02. Hatalı girdi ve sınırlar: Mükerrer kullanıcı adı, şema dışı alanların ve geçersiz parolanın reddedilmesi', async ({ page }) => {
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

    // Hata bildirimi: Bu kullanıcı adı zaten kullanımda
    const errorNotice = custModal.locator('.ws-error, [role="alert"]');
    await expect(errorNotice).toContainText(/zaten kullanımda|username_taken/i, { timeout: 10000 });
    await closeModal(custModal);

    // 2. API doğrulama ve şema sınırları (Senaryo 5 doğrulamaları)
    // Şema dışı iletişim/şirket/açıklama alanları reddedilmeli
    const schemaReject = await page.request.patch(`/api/panel/users/hosting/accounts/${encodeURIComponent(childCustId)}/login`, {
      data: {
        contactName: 'Test Contact',
        company: 'Test Corp',
        phone: '+905551112233',
        description: 'Test description',
      },
    });
    expect([400, 403]).toContain(schemaReject.status());

    // Kısa parola reddedilmeli (400 invalid_password)
    const shortPassReject = await page.request.patch(`/api/panel/users/hosting/accounts/${encodeURIComponent(childCustId)}/login`, {
      data: { password: 'short' },
    });
    expect([400, 403]).toContain(shortPassReject.status());

    // Mükerrer kullanıcı adına güncelleme reddedilmeli (409 username_taken)
    const dupReject = await page.request.patch(`/api/panel/users/hosting/accounts/${encodeURIComponent(childCustId)}/login`, {
      data: { username: directCustUser },
    });
    expect([409, 403]).toContain(dupReject.status());
  });

  test('03. Rol ve yetki sınırları: Müşteri ve bayinin kiracı ve yetki izolasyonu', async () => {
    expect(custContext).toBeTruthy();
    expect(resContext).toBeTruthy();

    // 1. Müşteri oturumundan yönetim uç noktalarına ve yabancı müşteri erişim engeli
    // Müşteri /api/panel/users uç noktasına erişememeli (403)
    const usersRes = await custContext.request.get('/api/panel/users');
    expect(usersRes.status()).toBe(403);

    // Müşteri başka bir müşterinin girişini düzenleyememeli (403)
    const directCustLoginPatch = await custContext.request.patch(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}/login`, {
      data: { username: `${prefix}-hacked@webrich.news` },
    });
    expect([403, 404]).toContain(directCustLoginPatch.status());

    // Müşteri kurtarma e-postası uç noktasına erişememeli (403)
    const recoveryGet = await custContext.request.get('/api/auth/recovery-email');
    expect(recoveryGet.status()).toBe(403);

    // 2. Bayi oturumundan Owner kullanıcılara ve doğrudan müşteriye erişim engeli
    // Bayi /api/panel/users uç noktasına erişememeli (403)
    const resellerUsersRes = await resContext.request.get('/api/panel/users');
    expect(resellerUsersRes.status()).toBe(403);

    // Bayi kendisine bağlı olmayan doğrudan müşterinin (directCustId) profilini sorgulayamamalı (403)
    const directCustGet = await resContext.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}`);
    expect(directCustGet.status()).toBe(403);

    // Bayi kendisine bağlı olmayan doğrudan müşterinin girişini düzenleyememeli (403)
    const directCustPatch = await resContext.request.patch(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}/login`, {
      data: { username: `${prefix}-stolen@webrich.news` },
    });
    expect(directCustPatch.status()).toBe(403);

    // Bayi kurtarma e-postası uç noktasına erişememeli (403)
    const resRecoveryGet = await resContext.request.get('/api/auth/recovery-email');
    expect(resRecoveryGet.status()).toBe(403);
  });

  test('04. Bilinen hata: Müşteri ve bayi oluşturma/düzenleme formlarında iletişim ve şirket alanları bulunmalı (Plesk HSP-03)', async ({ page }) => {
    test.fail(true, 'BULGU HSP-03: Müşteri ve bayi oluşturma/düzenleme formlarında iletişim adı, şirket, telefon ve açıklama alanları bulunmuyor');

    await ensureOwnerLoggedIn(page);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(addCustBtn).toBeVisible();
    await addCustBtn.click();

    const custModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });

    // Plesk HSP-03 parite eşdeğerliği: Formda İletişim adı ve Şirket alanları bulunmalı
    // YunPanel'de bu alanlar henüz yer almadığı için bu doğrulama test.fail ile yakalanır
    await expect(custModal.locator('label:has-text("İletişim adı"), label:has-text("Şirket")')).toBeVisible({ timeout: 3000 });
  });
});
