import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('ROL-04 Müşteri paneli ve abonelik/site seçimi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `trol04-a${agentN}-${Date.now().toString(36)}`;
  const CUST_USER = `${prefix}-c1`;
  const TEST_PASS = 'Tr0l04_A1_Pass!2026';

  const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');
  const custAuthFile = path.join(AUTH_DIR, `${CUST_USER}.json`);

  let customerStorage = null;

  async function ensureOwnerLoggedIn(page) {
    const ownerAuthFile = path.join(AUTH_DIR, `${OWNER_USERNAME}.json`);
    if (fs.existsSync(ownerAuthFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(ownerAuthFile, 'utf8'));
        if (state.cookies && state.cookies.length) {
          await page.context().addCookies(state.cookies);
        }
      } catch {}
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto('/');
        const sessionBar = page.locator('.auth-sessionbar');
        const authForm = page.locator('form.auth-form');
        await expect(sessionBar.or(authForm)).toBeVisible({ timeout: 15000 });

        if (await sessionBar.isVisible()) {
          const text = await sessionBar.textContent();
          if (text.includes(OWNER_USERNAME)) {
            await expect(sessionBar.locator('.auth-role')).toContainText('Owner', { timeout: 10000 });
            return;
          }
          await page.context().clearCookies();
          await page.goto('/');
          await expect(authForm).toBeVisible({ timeout: 15000 });
        }

        if (await authForm.isVisible()) {
          await page.fill('input[name="username"]', OWNER_USERNAME);
          await page.fill('input[name="password"]', OWNER_PASSWORD);
          await page.click('button.auth-primary');
          await expect(sessionBar).toBeVisible({ timeout: 15000 });
          await expect(sessionBar.locator('.auth-role')).toContainText('Owner', { timeout: 10000 });
          try {
            await page.context().storageState({ path: ownerAuthFile });
          } catch {}
          return;
        }
      } catch (err) {
        if (attempt === 2) throw err;
        await page.waitForTimeout(1000);
      }
    }
  }

  async function gotoCustomersPage(page) {
    for (let i = 0; i < 3; i++) {
      await page.goto('/customers');
      await page.waitForLoadState('domcontentloaded');
      const h1Text = await page.locator('h1').textContent({ timeout: 5000 }).catch(() => '');
      if (h1Text.includes('Müşteriler')) {
        return;
      }
      await page.waitForTimeout(500);
    }
    await expect(page.locator('h1')).toContainText('Müşteriler', { timeout: 15000 });
  }

  async function ensureCustomerLoggedIn(page) {
    if (customerStorage?.cookies?.length) {
      await page.context().addCookies(customerStorage.cookies);
      await page.goto('/websites');
      await page.waitForLoadState('domcontentloaded');
      const sessionBar = page.locator('.auth-sessionbar');
      if (await sessionBar.isVisible({ timeout: 5000 }).catch(() => false)) {
        const text = await sessionBar.textContent();
        if (text.includes(CUST_USER)) {
          return;
        }
      }
    } else if (fs.existsSync(custAuthFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(custAuthFile, 'utf8'));
        if (state.cookies && state.cookies.length) {
          customerStorage = state;
          await page.context().addCookies(state.cookies);
          await page.goto('/websites');
          await page.waitForLoadState('domcontentloaded');
          const sessionBar = page.locator('.auth-sessionbar');
          if (await sessionBar.isVisible({ timeout: 5000 }).catch(() => false)) {
            const text = await sessionBar.textContent();
            if (text.includes(CUST_USER)) {
              return;
            }
          }
        }
      } catch {}
    }

    // Fallback: Doğrudan form doldurarak giriş
    await page.context().clearCookies();
    await page.goto('/');
    const authForm = page.locator('form.auth-form');
    await expect(authForm).toBeVisible({ timeout: 15000 });
    await page.fill('input[name="username"]', CUST_USER);
    await page.fill('input[name="password"]', TEST_PASS);
    await page.click('button.auth-primary');
    const sessionBar = page.locator('.auth-sessionbar');
    await expect(sessionBar).toBeVisible({ timeout: 15000 });
    customerStorage = await page.context().storageState();
    try {
      await page.context().storageState({ path: custAuthFile });
    } catch {}
  }

  async function cleanupCustomerAccounts(browser, cleanPrefix = 'trol04-') {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Müşteri profillerini sil
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

        // 2. users tablosundaki test kullanıcılarını sil
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
      await context.close();
      try {
        if (fs.existsSync(AUTH_DIR)) {
          const files = fs.readdirSync(AUTH_DIR);
          for (const f of files) {
            if (f.startsWith('trol04-') && f.endsWith('.json')) {
              fs.rmSync(path.join(AUTH_DIR, f), { force: true });
            }
          }
        }
      } catch {}
    }
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupCustomerAccounts(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupCustomerAccounts(browser);
  });

  test('mutlu yol: Owner müşteri oluşturur, müşteri paneline giriş yapar ve 0 siteli müşteri araçlarını doğrular', async ({ page }) => {
    // 1. Owner ile oturum aç ve /customers sayfasına git
    await ensureOwnerLoggedIn(page);
    await gotoCustomersPage(page);

    // 2. Yeni müşteri hesabı oluştur
    await page.locator('button:has-text("Müşteri ekle")').click();
    const createDialog = page.locator('dialog[open], [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);

    const resellerSelect = createDialog.locator('label:has-text("Bağlı bayi") select');
    if (await resellerSelect.isVisible()) {
      await resellerSelect.selectOption('');
    }

    await createDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });
    await expect(page.locator('p.ws-notice[role="status"]')).toContainText(new RegExp(`${CUST_USER}.*oluşturuldu`, 'i'));

    // Fiziksel doğrulama 1: Owner API üzerinden veritabanında müşteri hesabını doğrula
    const custApiRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=100');
    expect(custApiRes.ok()).toBeTruthy();
    const custApiData = await custApiRes.json();
    const targetCust = (custApiData.data?.accounts || []).find((a) => a.username === CUST_USER);
    expect(targetCust).toBeTruthy();
    expect(targetCust.kind).toBe('customer');
    expect(targetCust.active).toBe(true);

    // 3. Müşteri hesabıyla panele giriş yap (Owner çerezlerini temizleyip form doldurur)
    await page.context().clearCookies();
    await page.goto('/');
    const authForm = page.locator('form.auth-form');
    await expect(authForm).toBeVisible({ timeout: 15000 });
    await page.fill('input[name="username"]', CUST_USER);
    await page.fill('input[name="password"]', TEST_PASS);
    await page.click('button.auth-primary');
    await page.waitForURL(/\/websites/, { timeout: 15000 });

    // Müşteri oturum durumunu değişkende ve diskte sakla (diğer testlerde 0 login maliyeti)
    customerStorage = await page.context().storageState();
    try {
      await page.context().storageState({ path: custAuthFile });
    } catch {}

    // 4. Müşteri sol menüsünü (MÜŞTERİ PANELİ / Müşteri Menüsü) doğrula
    const sidebar = page.locator('aside.ws-sidebar');
    await expect(sidebar.locator('.ws-brand small')).toContainText('MÜŞTERİ PANELİ');
    await expect(sidebar.locator('.ws-nav-label')).toContainText('Müşteri Menüsü');

    // Müşteri araçları menüde bulunmalı
    await expect(sidebar.locator('a[href="/websites"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/mail"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/files"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/databases"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/statistics"]')).toBeVisible();

    // Owner / Bayi rotaları menüde OLMAMALI
    await expect(sidebar.locator('a[href="/customers"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/resellers"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/tools-settings"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/docker"]')).toBeHidden();
    await expect(sidebar.locator('a[href="/servers"]')).toBeHidden();

    // 5. 0 siteli boş müşteri durumu ve kota kartlarını doğrula
    const emptyState = page.locator('.ws-empty, .ws-empty-state');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText(/web sitesi/i);

    const quotaSection = page.locator('.ws-section').filter({ hasText: /Kotalar/i });
    await expect(quotaSection).toBeVisible();
    await expect(quotaSection).toContainText('Web Siteleri');
    await expect(quotaSection).toContainText('0 / Sınırsız');

    // 6. Global müşteri araçlarında (/files, /databases, /mail, /statistics) boş durum ve yönlendirme butonu kontrolü
    await page.goto('/files');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('Henüz erişilebilir site yok', { timeout: 15000 });
    const toWebsitesBtn = page.locator('.ws-empty a, .ws-empty button, .ws-empty-state a, .ws-empty-state button', { hasText: 'Web sitelerine git' });
    await expect(toWebsitesBtn).toBeVisible();
    await toWebsitesBtn.click();
    await page.waitForURL(/\/websites/, { timeout: 10000 });

    await page.goto('/databases');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('Henüz erişilebilir site yok', { timeout: 15000 });

    await page.goto('/mail');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('Henüz erişilebilir site yok', { timeout: 15000 });

    await page.goto('/statistics');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('Henüz erişilebilir site yok', { timeout: 15000 });

    // 7. Komut paleti (⌘K / Ctrl+K) kontrolü: Yalnız müşteri rotaları listelenmeli
    await page.goto('/websites');
    await page.locator('.ws-command-trigger').click();
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Hızlı erişim' });
    await expect(modal).toBeVisible();
    const results = modal.locator('.ws-command-results');
    await expect(results).toContainText('Web Siteleri');
    await expect(results).toContainText('Dosyalar');
    await expect(results).toContainText('Veritabanları');
    await expect(results).not.toContainText('Bayiler');
    await expect(results).not.toContainText('Sunucular');
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    // Fiziksel doğrulama 2: Müşteri oturum API bilgisi
    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const sessionData = await sessionRes.json();
    expect(sessionData.data?.user?.username).toBe(CUST_USER);
    expect(sessionData.data?.user?.role).toBe('site_manager');
    expect(sessionData.data?.user?.hosting?.kind).toBe('customer');
    expect(sessionData.data?.access?.mode).toBe('site_management');
  });

  test('hatalı girdi ve sınır durumlar: geçersiz veya boş ?site= parametrelerinde güvenli fail-closed davranışı', async ({ page }) => {
    await ensureCustomerLoggedIn(page);

    // 1. /files?site=nonexistent-uuid rotasında fail-closed ekranı
    await page.goto('/files?site=nonexistent-site-id-999');
    await page.waitForLoadState('domcontentloaded');
    const emptyState = page.locator('.ws-empty, .ws-empty-state');
    await expect(emptyState).toBeVisible({ timeout: 15000 });
    await expect(emptyState).toContainText('İstenen siteye erişilemiyor');
    await expect(emptyState).toContainText('Başka bir sitenin dosyaları otomatik açılmaz');

    // Site seçimine dön butonuyla güvenli geri dönüş
    const backBtn = emptyState.locator('a, button', { hasText: 'Site seçimine dön' });
    await expect(backBtn).toBeVisible();
    await backBtn.click();
    await page.waitForURL(/\/files/, { timeout: 10000 });

    // 2. /databases?site=nonexistent-uuid rotasında fail-closed kontrolü
    await page.goto('/databases?site=nonexistent-site-id-999');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('İstenen siteye erişilemiyor', { timeout: 15000 });
    await expect(page.locator('.ws-empty, .ws-empty-state')).toContainText('Başka bir site otomatik açılmaz');

    // 3. /files?site= (boş parametre) durumunda çökme olmadan güvenli işleme
    await page.goto('/files?site=');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty, .ws-empty-state')).toBeVisible({ timeout: 15000 });
  });

  test('rol ve kiracı sınırı: Müşteri hesabı Owner/Reseller sayfalarına ve yabancı kaynaklara erişemez (403 / yönlendirme)', async ({ page }) => {
    await ensureCustomerLoggedIn(page);

    // 1. Owner ve Bayi yönetim rotalarına doğrudan gitmeyi dene -> /websites sayfasına yönlenmeli
    const protectedRoutes = ['/customers', '/resellers', '/tools-settings', '/servers', '/docker', '/settings/users'];
    for (const route of protectedRoutes) {
      await page.goto(route);
      await page.waitForURL(/\/websites/, { timeout: 10000 });
    }

    // 2. Yabancı site URL'sine doğrudan gitmeyi dene -> bilgi sızmadan hata/bulunamadı ekranı
    await page.goto('/websites/09efa3a3-81ed-5764-b925-3a6770516a6f/overview');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ws-empty')).toContainText(/bulunamadı|erişilemiyor|hata/i, { timeout: 15000 });

    // 3. Müşteri oturumuyla doğrudan yetkisiz API çağrıları: 403 Forbidden dönmeli
    const foreignSiteRes = await page.request.get('/api/panel/websites/09efa3a3-81ed-5764-b925-3a6770516a6f');
    expect(foreignSiteRes.status()).toBe(403);

    const foreignFilesRes = await page.request.get('/api/panel/websites/09efa3a3-81ed-5764-b925-3a6770516a6f/files?path=/');
    expect(foreignFilesRes.status()).toBe(403);

    const accountsRes = await page.request.get('/api/panel/users/hosting/accounts');
    expect(accountsRes.status()).toBe(403);

    const usersRes = await page.request.get('/api/panel/users');
    expect(usersRes.status()).toBe(403);
  });

  test('bilinen hata (test.fail): üst oturum çubuğunda rol rozeti Müşteri yerine Site Manager görünüyor', async ({ page }) => {
    test.fail(true, 'BULGU ROL-04: Üst oturum çubuğunda rol rozeti Müşteri yerine Site Manager görünüyor');
    await ensureCustomerLoggedIn(page);

    // Üst oturum çubuğundaki rol rozetinin Türkçe "Müşteri" olması beklenir
    const roleBadge = page.locator('.auth-sessionbar .auth-role');
    await expect(roleBadge).toBeVisible();
    await expect(roleBadge).toHaveText('Müşteri');
  });

  test('bilinen hata (test.fail): WebsitesPage veritabanı kotasında JSX boolean hatası yüzünden payda render edilmiyor', async ({ page }) => {
    test.fail(true, 'BULGU ROL-04: WebsitesPage veritabanı kotasında JSX boolean hatası yüzünden payda render edilmiyor');
    await ensureCustomerLoggedIn(page);

    await page.goto('/websites');
    await page.waitForLoadState('domcontentloaded');
    const quotaSection = page.locator('.ws-section').filter({ hasText: /Kotalar/i });
    await expect(quotaSection).toBeVisible({ timeout: 15000 });

    // WebsitesPage.jsx:103 satırındaki `!= null ??` hatası nedeniyle payda boş kalarak "Veritabanları — /" render edilir
    const dbCard = quotaSection.locator('div').filter({ hasText: 'Veritabanları' }).last();
    await expect(dbCard).toContainText(/Sınırsız|\d+/);
  });
});
