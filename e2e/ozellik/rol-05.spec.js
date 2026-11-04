import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-05 Ek kullanıcılar, roller ve izin matrisi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `trol05-a${agentN}-${Date.now().toString(36)}`;
  const SM_USER = `${prefix}-sm1`;
  const RO_USER = `${prefix}-ro1`;
  const TEST_PASS = 'Tr0l05_TestPass!2026';

  let boundSiteId = null;

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
      }
    }
  }

  async function gotoUsersPage(page) {
    await page.goto('/settings/users');
    for (let i = 0; i < 3; i++) {
      const h1Text = await page.locator('h1').textContent({ timeout: 10000 }).catch(() => '');
      if (h1Text.includes('Kullanıcılar')) break;
      await page.goto('/settings/users');
      await page.waitForTimeout(500);
    }
    await expect(page.locator('h1')).toContainText('Kullanıcılar', { timeout: 15000 });
  }

  async function findAccountRow(page, username) {
    const userSection = page.locator('section', { hasText: 'Hesaplar' });
    for (let pageNum = 0; pageNum < 6; pageNum++) {
      await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 15000 });
      const row = userSection.locator('table.ws-table tbody tr', { hasText: username });
      if (await row.count() > 0 && await row.first().isVisible()) {
        return row.first();
      }
      const nextBtn = userSection.locator('footer.ws-pagination button:has-text("Sonraki")');
      if (await nextBtn.isVisible() && !await nextBtn.isDisabled()) {
        const pageTextBefore = await userSection.locator('footer.ws-pagination span[aria-live="polite"]').textContent();
        await nextBtn.click();
        await expect(userSection.locator('footer.ws-pagination span[aria-live="polite"]')).not.toHaveText(pageTextBefore, { timeout: 10000 });
        await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 10000 });
      } else {
        break;
      }
    }
    const finalRow = userSection.locator('table.ws-table tbody tr', { hasText: username }).first();
    await expect(finalRow).toBeVisible({ timeout: 10000 });
    return finalRow;
  }

  async function cleanupPanelAccounts(browser, targetPrefix = prefix) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      const result = await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Hosting profillerini (customer ve reseller) temizle
        for (const kind of ['customer', 'reseller']) {
          const res = await fetch(`/api/panel/users/hosting/accounts?kind=${kind}&limit=100`).catch(() => null);
          const data = await res?.json().catch(() => null);
          for (const acc of data?.data?.accounts || []) {
            const u = acc.username || '';
            if (u.startsWith(pfx) || u.startsWith('trol04-') || u.startsWith('trol05-')) {
              await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(acc.id)}/profile`, {
                method: 'DELETE',
                headers,
                body: JSON.stringify({
                  revision: acc.revision ?? 1,
                  confirmation: `unregister-hosting-profile:${acc.id}:${acc.revision ?? 1}`,
                }),
              }).catch(() => null);
            }
          }
        }

        // 2. /api/panel/users listesinden kullanıcıları temizle
        for (let pass = 0; pass < 2; pass++) {
          const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
          const usersData = await usersRes?.json().catch(() => null);
          for (const u of usersData?.data?.users || []) {
            const uname = u.username || '';
            if (uname !== 'yunsoft-owner' && (uname.startsWith(pfx) || uname.startsWith('trol04-') || uname.startsWith('trol05-'))) {
              if (u.role === 'site_manager' && Array.isArray(u.websiteIds) && u.websiteIds.length > 0) {
                const patchRes = await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
                  method: 'PATCH',
                  headers,
                  body: JSON.stringify({ revision: u.revision, websiteIds: [] }),
                }).catch(() => null);
                const patchData = await patchRes?.json().catch(() => null);
                if (patchData?.data?.user?.revision) {
                  u.revision = patchData.data.user.revision;
                }
              }
              await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
                method: 'DELETE',
                headers,
                body: JSON.stringify({ revision: u.revision }),
              }).catch(() => null);
            }
          }
        }

        // Doğrulama: kalan kullanıcıları kontrol et
        const verifyRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const verifyData = await verifyRes?.json().catch(() => null);
        const remaining = (verifyData?.data?.users || []).filter((u) => u.username?.startsWith(pfx));
        return { remainingCount: remaining.length, remainingUsers: remaining.map((u) => u.username) };
      }, targetPrefix);

      return result;
    } finally {
      try {
        await context.close();
      } catch {}
    }
  }

  test.beforeAll(async ({ browser }) => {
    // Başlangıçta test öneki ve önceki denemelerden kalan hesapları temizle
    await cleanupPanelAccounts(browser, prefix);
  });

  test.afterAll(async ({ browser }) => {
    // Koşu sonunda temizlik yap ve kalan olmadığını doğrula
    const res = await cleanupPanelAccounts(browser, prefix);
    expect(res?.remainingCount).toBe(0);
  });

  test.beforeEach(async ({ page }) => {
    await ensureOwnerLoggedIn(page);
  });

  test('mutlu yol: Owner Kullanıcılar sayfasından Site Yöneticisi oluşturur, site yetkisi bağlar ve kullanıcı giriş yapar', async ({ page, browser }) => {
    // 1. /settings/users sayfasına git
    await gotoUsersPage(page);
    const userSection = page.locator('section', { hasText: 'Hesaplar' });
    await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 15000 });

    // 2. Kullanıcı ekle butonuna tıkla
    const addBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    // 3. Modal formunu doldur
    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible();
    await modal.locator('input[name="username"]').fill(SM_USER);
    await modal.locator('input[name="new-password"]').fill(TEST_PASS);
    await modal.locator('label', { hasText: 'Rol' }).locator('select').selectOption('site_manager');

    // 4. Formu gönder
    await modal.locator('button[type="submit"]:has-text("Hesap oluştur")').click();

    // Modal kapanmalı ve kullanıcı tabloda bulunmalı
    await expect(modal).not.toBeVisible({ timeout: 15000 });
    const userRow = await findAccountRow(page, SM_USER);
    await expect(userRow).toContainText('Site Yöneticisi');

    // 5. Fiziksel sonuç 1: API üzerinden kullanıcının kaydı doğrulanır
    const apiCheck = await page.evaluate(async (uname) => {
      const res = await fetch('/api/panel/users?limit=100');
      const data = await res.json();
      return data?.data?.users?.find((u) => u.username === uname) || null;
    }, SM_USER);
    expect(apiCheck).not.toBeNull();
    expect(apiCheck.role).toBe('site_manager');
    expect(apiCheck.active).toBe(true);

    // 6. Bir web sitesi bul ve kullanıcıya site yetkisi ata (PATCH /api/panel/users/:id)
    const siteInfo = await page.evaluate(async ({ userId, userRev }) => {
      const sitesRes = await fetch('/api/panel/websites');
      const sitesData = await sitesRes.json();
      const websites = Array.isArray(sitesData?.data) ? sitesData.data : (sitesData?.data?.websites || []);
      const firstSite = websites[0] || null;
      if (!firstSite) return null;

      const sessionResp = await fetch('/api/auth/session');
      const sessionData = await sessionResp.json();
      const csrf = sessionData?.data?.csrfToken;

      const patchRes = await fetch(`/api/panel/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: userRev, websiteIds: [firstSite.id] }),
      });
      const patchData = await patchRes.json();
      return { siteId: firstSite.id, patchStatus: patchRes.status, updatedUser: patchData?.data?.user };
    }, { userId: apiCheck.id, userRev: apiCheck.revision });

    if (siteInfo && siteInfo.siteId) {
      boundSiteId = siteInfo.siteId;
      expect(siteInfo.patchStatus).toBe(200);
      expect(siteInfo.updatedUser.websiteIds).toContain(boundSiteId);
    }

    // 7. Fiziksel sonuç 2: Site Yöneticisi hesabı ile yeni tarayıcı oturumunda giriş yap
    const smContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const smPage = await smContext.newPage();
    try {
      await loginAs(smPage, SM_USER, TEST_PASS);

      // Oturum ve izin matrisi doğrulaması
      const smSession = await smPage.evaluate(async () => {
        const res = await fetch('/api/auth/session');
        return res.json();
      });
      expect(smSession?.data?.access?.mode).toBe('site_management');
      expect(smSession?.data?.access?.permissions).toContain('sites.manage');
      if (boundSiteId) {
        expect(smSession?.data?.user?.websiteIds).toContain(boundSiteId);
      }

      // Sol menüde sadece site yönetimi bağlantıları görünmeli, sunucu/kullanıcı yönetim rotaları olmamalı
      const smSidebar = smPage.locator('aside.ws-sidebar');
      await expect(smSidebar).toBeVisible();
      await expect(smSidebar.locator('a[href="/websites"]')).toBeVisible();
      await expect(smSidebar.locator('a[href="/settings"]')).not.toBeVisible();
      await expect(smSidebar.locator('a[href="/servers"]')).not.toBeVisible();
      await expect(smSidebar.locator('a[href="/customers"]')).not.toBeVisible();
      await expect(smSidebar.locator('a[href="/resellers"]')).not.toBeVisible();
    } finally {
      await smContext.close();
    }
  });

  test('hatalı girdi: mükerrer kullanıcı adı ve geçersiz parametreler reddedilir', async ({ page }) => {
    await gotoUsersPage(page);
    const userSection = page.locator('section', { hasText: 'Hesaplar' });
    await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 15000 });

    // Mükerrer kullanıcı adı denemesi
    const addBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible();
    await modal.locator('input[name="username"]').fill(SM_USER);
    await modal.locator('input[name="new-password"]').fill(TEST_PASS);
    await modal.locator('label', { hasText: 'Rol' }).locator('select').selectOption('site_manager');

    await modal.locator('button[type="submit"]:has-text("Hesap oluştur")').click();

    // Hata mesajı görünmeli (409 username_taken)
    const alertMsg = modal.locator('.ws-error, [role="alert"], .ws-notice');
    await expect(alertMsg).toBeVisible({ timeout: 10000 });
    await expect(alertMsg).toContainText(/başka bir hesapta|kullanılıyor|alınmış|taken/i);

    // Modalı kapat (form kirli olduğu için 'Değişiklikleri bırak' onayı çıkabilir)
    const cancelBtn = modal.locator('button:has-text("Vazgeç")');
    if (await cancelBtn.isVisible()) {
      await cancelBtn.click();
      const discardBtn = modal.locator('button:has-text("Değişiklikleri bırak")');
      if (await discardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await discardBtn.click();
      }
    }
    await expect(modal).not.toBeVisible({ timeout: 10000 });

    // Fiziksel API doğrulama: geçersiz rol ve kısa parola API düzeyinde 400 döner
    const apiErrors = await page.evaluate(async (pwd) => {
      const sessionResp = await fetch('/api/auth/session');
      const sessionData = await sessionResp.json();
      const csrf = sessionData?.data?.csrfToken;
      const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

      const resInvalidRole = await fetch('/api/panel/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'trol05-inv-role', password: pwd, role: 'invalid_role_xyz' }),
      });
      const dataInvalidRole = await resInvalidRole.json();

      const resShortPass = await fetch('/api/panel/users', {
        method: 'POST',
        headers,
        body: JSON.stringify({ username: 'trol05-short-pass', password: 'short', role: 'site_manager' }),
      });
      const dataShortPass = await resShortPass.json();

      return {
        roleStatus: resInvalidRole.status,
        roleCode: dataInvalidRole?.error?.code,
        passStatus: resShortPass.status,
        passCode: dataShortPass?.error?.code,
      };
    }, TEST_PASS);

    expect(apiErrors.roleStatus).toBe(400);
    expect(apiErrors.roleCode).toBe('invalid_role');
    expect(apiErrors.passStatus).toBe(400);
    expect(apiErrors.passCode).toBe('invalid_password');
  });

  test('rol senaryosu: Read Only kullanıcısı 9 salt okunur izne sahiptir, mutasyon ve kullanıcı yönetimi engellenir', async ({ page, browser }) => {
    // 1. Owner ile Read Only kullanıcı oluştur
    await gotoUsersPage(page);
    const userSection = page.locator('section', { hasText: 'Hesaplar' });
    await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 15000 });

    const addBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible();
    await modal.locator('input[name="username"]').fill(RO_USER);
    await modal.locator('input[name="new-password"]').fill(TEST_PASS);
    await modal.locator('label', { hasText: 'Rol' }).locator('select').selectOption('read_only');

    await modal.locator('button[type="submit"]:has-text("Hesap oluştur")').click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    const roRow = await findAccountRow(page, RO_USER);
    await expect(roRow).toContainText('Read Only');

    // 2. Read Only kullanıcısı ile yeni tarayıcı oturumunda giriş yap
    const roContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const roPage = await roContext.newPage();
    try {
      await loginAs(roPage, RO_USER, TEST_PASS);

      // Fiziksel sonuç: İzin matrisinde tam 9 *.read izni ve mode: "read_only" doğrulanır
      const roSession = await roPage.evaluate(async () => {
        const res = await fetch('/api/auth/session');
        return res.json();
      });
      expect(roSession?.data?.access?.mode).toBe('read_only');
      const expectedPerms = [
        'applications.read',
        'certificates.read',
        'dns_zones.read',
        'docker_workloads.read',
        'domains.read',
        'mail_domains.read',
        'mailboxes.read',
        'servers.read',
        'websites.read',
      ];
      expect(roSession?.data?.access?.permissions?.slice().sort()).toEqual(expectedPerms.sort());

      // Fiziksel sonuç: Yazma ve hassas yönetim uçları 403 Forbidden ile reddedilir
      const roAccess = await roPage.evaluate(async () => {
        const sessionResp = await fetch('/api/auth/session');
        const sessionData = await sessionResp.json();
        const csrf = sessionData?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        const postSite = await fetch('/api/panel/websites', {
          method: 'POST',
          headers,
          body: JSON.stringify({ domain: 'forbidden-site.test' }),
        });

        const getUsers = await fetch('/api/panel/users');

        return {
          postSiteStatus: postSite.status,
          getUsersStatus: getUsers.status,
        };
      });

      expect(roAccess.postSiteStatus).toBe(403);
      expect(roAccess.getUsersStatus).toBe(403);

      // UI: Doğrudan /settings/users adresine gitmeyi denerse kullanıcı yönetimi açılmamalı
      await roPage.goto('/settings/users');
      await expect(roPage.locator('button:has-text("Kullanıcı ekle")')).not.toBeVisible();
    } finally {
      await roContext.close();
    }
  });

  test('yetki ve koruma: bağlı sitesi olan Site Yöneticisi doğrudan silinemez (site_manager_delete_blocked)', async ({ page }) => {
    test.skip(!boundSiteId, 'Site yetkisi bağlanamadığı için silme koruması testi atlandı');

    await gotoUsersPage(page);

    // API üzerinden bağlı sitesi olan SM_USER silmeyi dene -> 409 site_manager_delete_blocked dönmeli
    const deleteResult = await page.evaluate(async (uname) => {
      const usersRes = await fetch('/api/panel/users?limit=100');
      const usersData = await usersRes.json();
      const user = usersData?.data?.users?.find((u) => u.username === uname);
      if (!user) return { status: 404 };

      const sessionResp = await fetch('/api/auth/session');
      const sessionData = await sessionResp.json();
      const csrf = sessionData?.data?.csrfToken;

      const delRes = await fetch(`/api/panel/users/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ revision: user.revision }),
      });
      const delData = await delRes.json();
      return { status: delRes.status, code: delData?.error?.code };
    }, SM_USER);

    expect(deleteResult.status).toBe(409);
    expect(deleteResult.code).toBe('site_manager_delete_blocked');
  });

  test('bilinen hata: /settings/users üzerinde Kullanıcı ekle modalında web siteleri onay kutuları listelenir', async ({ page }) => {
    test.fail(true, 'BULGU ROL-05: /settings/users rotasında workspaceResources websites koleksiyonunu yüklemediği için modalda site onay kutuları görünmüyor');

    // Doğrudan /settings/users sayfasına git (önceki bir sayfadan önbellek taşımadan)
    await gotoUsersPage(page);

    const addBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addBtn).toBeVisible();
    await addBtn.click();

    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible();

    // Rolü site_manager seç
    await modal.locator('label', { hasText: 'Rol' }).locator('select').selectOption('site_manager');

    // Yönetilecek Web Siteleri kutusunda en az bir site onay kutusu (checkbox) bulunmalı
    const siteCheckboxes = modal.locator('input[type="checkbox"]');
    // Sunucuda web siteleri bulunduğu halde workspace-resources.js /settings/users için websites yüklemediğinden
    // "Henüz kayıtlı web sitesi yok." gösterilir ve checkbox sayısı 0 kalır; bu test düşer ve test.fail yakalar.
    await expect(siteCheckboxes.first()).toBeVisible({ timeout: 5000 });
  });
});
