import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-06 Ek yönetici hesapları ve yönetim yetkileri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `trol06-a${agentN}-${Date.now().toString(36)}`;
  const ADMIN_USER = `${prefix}-adm`;
  const RO_USER = `${prefix}-ro`;
  const TEST_PASS = 'Tr0l06_A2_TestPass!2026';

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

  async function gotoUsersPage(page) {
    await page.goto('/settings/users');
    await expect(page.locator('h1')).toContainText('Kullanıcılar', { timeout: 15000 });
    const userSection = page.locator('section', { hasText: 'Hesaplar' });
    await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 15000 });
  }

  async function findAccountRow(page, username) {
    const userSection = page.locator('section', { hasText: 'Hesaplar' });

    // Eğer önceki işlemden sonra 2. sayfada kalınmışsa sayfa 1'e dön
    const prevBtn = userSection.locator('footer.ws-pagination button:has-text("Önceki")');
    while (await prevBtn.isVisible() && !await prevBtn.isDisabled()) {
      const pageText = await userSection.locator('footer.ws-pagination span[aria-live="polite"]').textContent();
      await prevBtn.click();
      await expect(userSection.locator('footer.ws-pagination span[aria-live="polite"]')).not.toHaveText(pageText, { timeout: 10000 });
      await expect(userSection.locator('table.ws-table')).toBeVisible({ timeout: 10000 });
    }

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

  async function cleanupAllTestAccounts(browser, cleanPrefix = prefix) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const currentOwner = sessionData?.data?.user?.username;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Varsa hosting profillerini temizle
        for (const kind of ['customer', 'reseller']) {
          const res = await fetch(`/api/panel/users/hosting/accounts?kind=${kind}&limit=100`).catch(() => null);
          const data = await res?.json().catch(() => null);
          for (const acc of data?.data?.accounts || []) {
            const u = acc.username || '';
            if (u.startsWith(pfx) || u.startsWith('trol06-')) {
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

        // 2. Test kullanıcılarını sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          if (u.username !== currentOwner && (u.username.startsWith(pfx) || u.username.startsWith('trol06-'))) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }
      }, cleanPrefix);
    } finally {
      await context.close();
      try {
        if (fs.existsSync(AUTH_DIR)) {
          const files = fs.readdirSync(AUTH_DIR);
          for (const f of files) {
            if (f.startsWith('trol06-') && f.endsWith('.json')) {
              fs.rmSync(path.join(AUTH_DIR, f), { force: true });
            }
          }
        }
      } catch {}
    }
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test.beforeEach(async ({ page }) => {
    await ensureOwnerLoggedIn(page);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: Owner ek yönetici oluşturur, ek yönetici ile oturum açılır, tam yönetim yetkileri ve denetim kaydı doğrulanır', async ({ browser, page }) => {
    // 1. Owner ile kullanıcılar sayfasına git
    await gotoUsersPage(page);

    // 2. Ek yönetici hesabı oluştur
    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const createDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcı ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(ADMIN_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createDialog.locator('label:has-text("Rol") select').selectOption('owner');
    await createDialog.locator('label:has-text("Hesap durumu") select').selectOption('true');

    await createDialog.locator('button[type="submit"]:has-text("Hesap oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // 3. Tabloda ek yöneticinin Owner rolüyle listelendiğini doğrula
    const adminRow = await findAccountRow(page, ADMIN_USER);
    await expect(adminRow).toContainText('Owner');
    await expect(adminRow).toContainText('Aktif');

    // 4. Fiziksel doğrulama 1: Ek yönetici (ADMIN_USER) ile oturum açma ve tam yetkiler
    const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const adminPage = await adminContext.newPage();
    try {
      await loginAs(adminPage, ADMIN_USER, TEST_PASS);

      // Oturum API yetki kontrolü
      const sessionRes = await adminPage.request.get('/api/auth/session');
      expect(sessionRes.ok()).toBeTruthy();
      const sessionData = await sessionRes.json();
      expect(sessionData.data?.user?.username).toBe(ADMIN_USER);
      expect(sessionData.data?.user?.role).toBe('owner');
      expect(sessionData.data?.access?.mode).toBe('management');
      expect(sessionData.data?.access?.permissions).toContain('*');

      // Üst bar ve Service Provider yan menü kontrolü
      await expect(adminPage.locator('.auth-sessionbar .auth-role')).toContainText(/owner/i);
      const sidebar = adminPage.locator('aside.ws-sidebar');
      await expect(sidebar.locator('a[href="/websites"]')).toBeVisible();
      await expect(sidebar.locator('a[href="/databases"]')).toBeVisible();
      await expect(sidebar.locator('a[href="/customers"]')).toBeVisible();
      await expect(sidebar.locator('a[href="/resellers"]')).toBeVisible();
      await expect(sidebar.locator('a[href="/tools-settings"]')).toBeVisible();

      // Kullanıcılar sayfasına gidebilmeli ve "Kullanıcı ekle" butonunu görebilmeli
      await gotoUsersPage(adminPage);
      await expect(adminPage.locator('button:has-text("Kullanıcı ekle")')).toBeVisible();

      // Fiziksel doğrulama 2: Denetim kayıtları (/api/panel/audit)
      const auditRes = await adminPage.request.get('/api/panel/audit?limit=25');
      expect(auditRes.ok()).toBeTruthy();
      const auditData = await auditRes.json();
      const events = auditData.data?.events || [];
      const hasAuthOrUserEvent = events.some((e) =>
        e.action === 'user.created' || e.action === 'login.succeeded' || e.actor?.username === ADMIN_USER || e.target?.name === ADMIN_USER
      );
      expect(hasAuthOrUserEvent).toBeTruthy();
    } finally {
      await adminContext.close();
    }
  });

  test('hatalı girdi ve korumalar: geçersiz kullanıcı adı, mükerrer kullanıcı, kaydedilmemiş değişiklik onayı ve silme onay kilidi', async ({ page }) => {
    await gotoUsersPage(page);

    // 1. Hatalı girdi: Geçersiz karakterli kullanıcı adı (Türkçe harfler) ve format kuralı uyarısı
    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const createDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcı ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    const usernameInput = createDialog.locator('label:has-text("Kullanıcı adı") input');
    await usernameInput.fill('trol06-ğüşıöç');
    await expect(createDialog.locator('label:has-text("Kullanıcı adı") .ws-field-hint')).toContainText(/3–128 karakter.*harf.*rakam/i);

    // 2. Mükerrer kullanıcı adı denemesi (409 username_taken)
    await usernameInput.fill(ADMIN_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createDialog.locator('button[type="submit"]:has-text("Hesap oluştur")').click();

    const alertNotice = createDialog.locator('[role="alert"], .ws-notice-error');
    await expect(alertNotice).toBeVisible({ timeout: 10000 });
    await expect(alertNotice).toContainText(/başka bir hesapta kullanılıyor|zaten|kullanımda/i);

    // 3. Kaydedilmemiş değişiklik onayı
    await createDialog.locator('button:has-text("Vazgeç")').click();
    await expect(createDialog).toContainText('Kaydedilmemiş değişiklikleriniz silinecek');
    await createDialog.locator('button:has-text("Değişiklikleri bırak")').click();
    await expect(createDialog).toBeHidden({ timeout: 10000 });

    // 4. Silme onay metni güvenliği: ADMIN_USER için yanlış metin yazıldığında butonun kilitli kalması
    const adminRow = await findAccountRow(page, ADMIN_USER);
    await adminRow.locator('button:has-text("Sil")').click();

    const deleteDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcıyı sil' });
    await expect(deleteDialog).toBeVisible({ timeout: 10000 });
    const deleteSubmitBtn = deleteDialog.locator('button[type="submit"]:has-text("Hesabı sil")');

    const confirmInput = deleteDialog.locator(`label:has-text("Onaylamak için ${ADMIN_USER} yazın") input`);
    await confirmInput.fill('yanlis-onay-metni');
    await expect(deleteSubmitBtn).toBeDisabled();

    // Doğru metin girilince buton açılır ve hesap silinir
    await confirmInput.fill(ADMIN_USER);
    await expect(deleteSubmitBtn).toBeEnabled();
    await deleteSubmitBtn.click();
    await expect(deleteDialog).toBeHidden({ timeout: 15000 });

    // 5. Fiziksel silme doğrulaması: API'de ADMIN_USER bulunmamalı
    const usersRes = await page.request.get('/api/panel/users?limit=100');
    expect(usersRes.ok()).toBeTruthy();
    const usersData = await usersRes.json();
    const adminStillExists = (usersData.data?.users || []).some((u) => u.username === ADMIN_USER);
    expect(adminStillExists).toBeFalsy();
  });

  test('rol ve yetki sınırları: read_only rolünün yetkisiz API ve rotalara erişememesi, devre dışı bırakılınca anında oturum iptali', async ({ browser, page }) => {
    // 1. Owner ile RO_USER hesabı oluştur
    await gotoUsersPage(page);

    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const createDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcı ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(RO_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createDialog.locator('label:has-text("Rol") select').selectOption('read_only');
    await createDialog.locator('label:has-text("Hesap durumu") select').selectOption('true');
    await createDialog.locator('button[type="submit"]:has-text("Hesap oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // Kullanıcının tabloda yer aldığını doğrula
    const roRow = await findAccountRow(page, RO_USER);
    await expect(roRow).toContainText('Read Only');
    await expect(roRow).toContainText('Aktif');

    // 2. Read Only oturumu aç ve yetki sınırlarını kontrol et
    const roContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const roPage = await roContext.newPage();
    try {
      await loginAs(roPage, RO_USER, TEST_PASS);

      // Fiziksel doğrulama 1: Read only oturum yetkileri
      const sessionRes = await roPage.request.get('/api/auth/session');
      expect(sessionRes.ok()).toBeTruthy();
      const sessionData = await sessionRes.json();
      expect(sessionData.data?.user?.username).toBe(RO_USER);
      expect(sessionData.data?.user?.role).toBe('read_only');
      expect(sessionData.data?.access?.mode).toBe('read_only');
      expect(sessionData.data?.access?.permissions).not.toContain('*');

      // UI: /settings/users adresine doğrudan gitmeyi dene -> Kullanıcı ekle görünmemeli veya /websites'e yönlenmeli
      await roPage.goto('/settings/users');
      await expect(roPage.locator('button:has-text("Kullanıcı ekle")')).not.toBeVisible();

      // Fiziksel doğrulama 2: Salt okunur kullanıcının yazma/denetim uçlarına erişim engeli (403 Forbidden)
      const roApiChecks = await roPage.evaluate(async () => {
        const sessionResp = await fetch('/api/auth/session');
        const sessionInfo = await sessionResp.json();
        const csrf = sessionInfo?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        const postUser = await fetch('/api/panel/users', {
          method: 'POST',
          headers,
          body: JSON.stringify({ username: 'forbidden-adm', password: 'ForbiddenPass123!', role: 'owner', active: true }),
        });

        const getAudit = await fetch('/api/panel/audit');

        return {
          postUserStatus: postUser.status,
          getAuditStatus: getAudit.status,
        };
      });

      expect(roApiChecks.postUserStatus).toBe(403);
      expect(roApiChecks.getAuditStatus).toBe(403);

      // 3. Anında oturum iptali (session revocation): Owner RO_USER hesabını devre dışı bırakır
      const activeRoRow = await findAccountRow(page, RO_USER);
      await activeRoRow.locator('button:has-text("Düzenle")').click();

      const editDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcıyı düzenle' });
      await expect(editDialog).toBeVisible({ timeout: 10000 });
      await editDialog.locator('label:has-text("Hesap durumu") select').selectOption('false');
      await editDialog.locator('button[type="submit"]:has-text("Değişiklikleri kaydet")').click();
      await expect(editDialog).toBeHidden({ timeout: 15000 });

      // 4. roPage oturumunda sonraki çağrının 401 Unauthorized olması gerekir (canlı oturum anında düşürüldü)
      const revokedSessionRes = await roPage.request.get('/api/auth/session');
      expect(revokedSessionRes.status()).toBe(401);
    } finally {
      await roContext.close();
    }

    // 5. Devre dışı bırakılan RO_USER'ı Owner arayüzünden sil
    const roRowToDelete = await findAccountRow(page, RO_USER);
    await roRowToDelete.locator('button:has-text("Sil")').click();
    const roDeleteDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcıyı sil' });
    await expect(roDeleteDialog).toBeVisible({ timeout: 10000 });
    await roDeleteDialog.locator(`label:has-text("Onaylamak için ${RO_USER} yazın") input`).fill(RO_USER);
    await roDeleteDialog.locator('button[type="submit"]:has-text("Hesabı sil")').click();
    await expect(roDeleteDialog).toBeHidden({ timeout: 15000 });
  });

  test('bilinen hata (test.fail): /settings/users üzerinde Kullanıcıyı düzenle modalında parola sıfırlama/değiştirme alanı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU ROL-06: /settings/users üzerindeki Kullanıcıyı düzenle modalında parola sıfırlama/değiştirme alanı bulunmuyor');

    await gotoUsersPage(page);

    const ownerRow = await findAccountRow(page, OWNER_USERNAME);
    await ownerRow.locator('button:has-text("Düzenle")').click();

    const editDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcıyı düzenle' });
    await expect(editDialog).toBeVisible({ timeout: 10000 });

    try {
      // Arka uç PATCH /api/users/:id üzerinde password desteklediği halde arayüzde parola alanı mevcut kullanıcı için gösterilmez (!user koşulu)
      const passwordInput = editDialog.locator('input[type="password"], input[name="new-password"]');
      await expect(passwordInput).toBeVisible({ timeout: 5000 });
    } finally {
      const cancelBtn = editDialog.locator('button:has-text("Vazgeç")');
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click();
      }
    }
  });

  test('bilinen hata (test.fail): ReadOnlyServersPage ve ReadOnlyDashboardPage rotaları OwnerRoute ile korunduğu için read_only hesaplar /websites adresine yönlendiriliyor', async ({ browser, page }) => {
    test.fail(true, 'BULGU ROL-06: ReadOnlyServersPage ve ReadOnlyDashboardPage rotaları OwnerRoute ile korunduğu için read_only hesaplar /websites adresine yönlendiriliyor');

    const tempRoUser = `${prefix}-ro-fail`;

    // Geçici read_only hesap oluştur
    await gotoUsersPage(page);

    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const createDialog = page.locator('.ws-modal').filter({ hasText: 'Kullanıcı ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(tempRoUser);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createDialog.locator('label:has-text("Rol") select').selectOption('read_only');
    await createDialog.locator('button[type="submit"]:has-text("Hesap oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    const roContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const roPage = await roContext.newPage();
    try {
      await loginAs(roPage, tempRoUser, TEST_PASS);

      // Read only kullanıcının /servers sayfasına erişebilmesi beklenir (kodda ReadOnlyServersPage vardır)
      // Ancak WorkspaceApp.jsx bu rotayı OwnerRoute ile sardığı için kullanıcı /websites sayfasına yönlendirilir
      await roPage.goto('/servers');
      await expect(roPage).toHaveURL(/\/servers/, { timeout: 5000 });
      await expect(roPage.locator('h1')).toContainText(/sunucu/i);
    } finally {
      await roContext.close();
      // Temizlik: tempRoUser'ı sil
      try {
        await gotoUsersPage(page);
        const tempRow = await findAccountRow(page, tempRoUser);
        await tempRow.locator('button:has-text("Sil")').click();
        const delModal = page.locator('.ws-modal').filter({ hasText: 'Kullanıcıyı sil' });
        await delModal.locator(`label:has-text("Onaylamak için ${tempRoUser} yazın") input`).fill(tempRoUser);
        await delModal.locator('button[type="submit"]:has-text("Hesabı sil")').click();
        await expect(delModal).toBeHidden({ timeout: 10000 });
      } catch {}
    }
  });
});
