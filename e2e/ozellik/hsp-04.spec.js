import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.describe('HSP-04 Hesap altında domain, müşteri ve abonelik listeleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `thsp04-a${agentN}-${Date.now().toString(36)}`;
  const resellerUser = `${prefix}-res`;
  const directCustUser = `${prefix}-cdir`;
  const childCustUser = `${prefix}-cchld`;
  const testPassword = 'Password12345678!';

  let directCustId = null;
  let childCustId = null;
  let resellerId = null;

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
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      // 1. Child customer temizliği
      if (childCustId) {
        await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(childCustId)}/login`, {
          data: {},
        }).catch((err) => console.warn('Child customer delete notice:', err.message));
      }

      // 2. Direct customer temizliği
      if (directCustId) {
        await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}/login`, {
          data: {},
        }).catch((err) => console.warn('Direct customer delete notice:', err.message));
      }

      // 3. Reseller temizliği (profil unregister + user delete)
      if (resellerId) {
        const resProfile = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(resellerId)}`).then((r) => r.json()).catch(() => null);
        if (resProfile?.data?.revision) {
          const rev = resProfile.data.revision;
          await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(resellerId)}/profile`, {
            data: {
              revision: rev,
              confirmation: `unregister-hosting-profile:${resellerId}:${rev}`,
            },
          }).catch((err) => console.warn('Reseller unregister notice:', err.message));
        }

        const userObj = await page.request.get(`/api/panel/users/${encodeURIComponent(resellerId)}`).then((r) => r.json()).catch(() => null);
        const userRev = userObj?.data?.revision ?? 1;
        await page.request.delete(`/api/panel/users/${encodeURIComponent(resellerId)}`, {
          data: { revision: userRev },
        }).catch((err) => console.warn('Reseller user delete notice:', err.message));
      }
    } catch (err) {
      console.warn('HSP-04 afterAll cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('01. Mutlu yol: Müşteri oluşturma, müşteri listesi ve müşteri detayında siteler/arama filtreleme', async ({ page }) => {
    await ensureOwnerLoggedIn(page);

    // 1. Müşteriler sayfasına git
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    // 2. Müşteri ekle butonuna bas ve modalı aç
    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(addCustBtn).toBeVisible();
    await addCustBtn.click();

    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // 3. Formu doldur ve hesabı oluştur
    await modal.locator('label:has-text("Kullanıcı adı") input').fill(directCustUser);
    await modal.locator('label:has-text("İlk parola") input').fill(testPassword);
    const submitBtn = modal.locator('button[type="submit"]:has-text("Hesabı oluştur")');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 4. Bildirim ve müşteri tablosunda görünürlük kontrolü
    const notice = page.locator('.ws-notice').filter({ hasText: 'hesabı oluşturuldu' });
    await expect(notice).toContainText(new RegExp(`${directCustUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    const custRow = page.locator('table.ws-table tbody tr', { hasText: directCustUser });
    await expect(custRow).toBeVisible({ timeout: 10000 });
    await expect(custRow.locator('td', { hasText: 'Etkin' })).toBeVisible();

    // 5. Müşteri ID'sini API'den doğrula ve kaydet
    const listRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=50');
    expect(listRes.status()).toBe(200);
    const listData = await listRes.json();
    const createdCust = listData.data.accounts.find((a) => a.username === directCustUser);
    expect(createdCust).toBeTruthy();
    directCustId = createdCust.id;

    // 6. Müşteri detayındaki "Web siteleri" bağlantısına tıkla
    const websitesLink = custRow.locator('a:has-text("Web siteleri")');
    await expect(websitesLink).toBeVisible();
    await websitesLink.click();

    // 7. URL'nin /websites?customer=<id> olduğunu ve müşteri kapsamı bildiriminin göründüğünü doğrula
    await page.waitForURL(new RegExp(`/websites\\?customer=${encodeURIComponent(directCustId)}`), { timeout: 10000 });
    const custNotice = page.locator('.ws-notice[role="status"]', { hasText: `${directCustUser} hesabının web siteleri` });
    await expect(custNotice).toBeVisible({ timeout: 10000 });

    // 8. Henüz müşteriye ait site olmadığı için boş durum ekranını doğrula
    await expect(page.locator('text=Eşleşen alan adı bulunamadı').or(page.locator('text=Henüz web sitesi yok'))).toBeVisible({ timeout: 10000 });

    // 9. Arama kutusunu doğrula
    const searchInput = page.locator('input[type="search"][placeholder*="Alan adı"]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('nonexistent-test-domain.xyz');
    await expect(page.locator('text=Eşleşen alan adı bulunamadı')).toBeVisible();
    await searchInput.fill('');

    // 10. "Tüm siteler" bağlantısına tıkla ve genel site listesine dönüldüğünü doğrula
    const allSitesLink = custNotice.locator('a:has-text("Tüm siteler")');
    await expect(allSitesLink).toBeVisible();
    await allSitesLink.click();
    await page.waitForURL(/\/websites$/, { timeout: 10000 });
  });

  test('02. Yetki ve sınır: Bayi oluşturma, bayinin yalnız kendi müşterisini görmesi ve yabancı müşteriyi listeleyememesi', async ({ page }) => {
    // 1. Owner olarak Bayi oluştur
    await ensureOwnerLoggedIn(page);
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addResBtn = page.locator('button:has-text("Bayi ekle")');
    await expect(addResBtn).toBeVisible();
    await addResBtn.click();

    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    await modal.locator('label:has-text("Kullanıcı adı") input').fill(resellerUser);
    await modal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await modal.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();

    const notice = page.locator('.ws-notice').filter({ hasText: 'hesabı oluşturuldu' });
    await expect(notice).toContainText(new RegExp(`${resellerUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Bayi ID'sini al
    const resList = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=50');
    expect(resList.status()).toBe(200);
    const resData = await resList.json();
    const createdRes = resData.data.accounts.find((a) => a.username === resellerUser);
    expect(createdRes).toBeTruthy();
    resellerId = createdRes.id;

    // 2. Owner oturumunu kapat ve Bayi olarak giriş yap
    await logout(page);
    await loginAs(page, resellerUser, testPassword);

    // Bayi oturum barını doğrula
    const sessionBar = page.locator('.auth-sessionbar');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
    await expect(sessionBar).toContainText(resellerUser);

    // 3. Bayi olarak /customers (Müşterilerim) sayfasına git
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 4. Doğrudan Owner'a ait müşterinin (directCustUser) Bayi tablosunda OLMADIĞINI doğrula
    const foreignCustRow = page.locator('table.ws-table tbody tr', { hasText: directCustUser });
    await expect(foreignCustRow).toHaveCount(0);

    // 5. Bayi kendi müşterisini ekler
    const addCustBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(addCustBtn).toBeVisible();
    await addCustBtn.click();

    const custModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });

    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(childCustUser);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await custModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")').click();

    const childNotice = page.locator('.ws-notice, [role="status"]').filter({ hasText: 'oluşturuldu' });
    await expect(childNotice).toContainText(new RegExp(`${childCustUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // 6. Bayi tablosunda kendi müşterisinin göründüğünü doğrula
    const ownCustRow = page.locator('table.ws-table tbody tr', { hasText: childCustUser });
    await expect(ownCustRow).toBeVisible({ timeout: 10000 });

    // Child müşteri ID'sini al
    const ownListRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer');
    expect(ownListRes.status()).toBe(200);
    const ownListData = await ownListRes.json();
    const createdChild = ownListData.data.accounts.find((a) => a.username === childCustUser);
    expect(createdChild).toBeTruthy();
    childCustId = createdChild.id;

    // 7. Bayi Sitelerim sayfasına gider (/websites)
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Sitelerim' })).toBeVisible({ timeout: 15000 });
  });

  test('03. Fiziksel kanıt: Bayi API izolasyonu ve kiracı sınırı doğrulaması', async ({ page }) => {
    // Reseller oturumunu doğrula
    await loginAs(page, resellerUser, testPassword);

    // 1. Reseller API üzerinden müşteri listesi sorgular: yalnız kendi child müşterisi gelmeli
    const custListRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer');
    expect(custListRes.status()).toBe(200);
    const custListData = await custListRes.json();
    const accounts = custListData.data.accounts;

    // Kendi child müşterisi listede olmalı
    expect(accounts.some((a) => a.username === childCustUser)).toBe(true);
    // Direct Owner müşterisi (yabancı kiracı) listede KESİNLİKLE OLMAMALI
    expect(accounts.some((a) => a.username === directCustUser)).toBe(false);

    // 2. Reseller API üzerinden bayi listesi sorgulamayı dener: 403 Forbidden dönmeli
    const resListRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller');
    expect(resListRes.status()).toBe(403);

    // 3. Reseller API üzerinden yabancı (Owner) müşteriyi tekil sorgulamayı dener: 403/404 dönmeli
    if (directCustId) {
      const foreignDetailRes = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(directCustId)}`);
      expect([403, 404]).toContain(foreignDetailRes.status());
    }

    // 4. Reseller /api/panel/websites sorgular: sadece kendi kiracısına ait siteler (veya boş liste) dönmeli
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.status()).toBe(200);
    const sitesData = await sitesRes.json();
    const websites = sitesData.data?.websites || sitesData.websites || [];
    // Hiçbir foreign domain içermemeli
    for (const site of websites) {
      expect(site.resellerId).toBe(resellerId);
    }
  });
});
