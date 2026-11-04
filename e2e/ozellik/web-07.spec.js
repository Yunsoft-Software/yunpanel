import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('WEB-07 Domain kartı/liste, arama, filtre ve doğru araç grupları', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tweb07-a${agentN}-${Date.now().toString(36)}`;
  const CUST_USER = `${prefix}-cust`;
  const TEST_PASS = 'Tr0lWEB07_A3_Test!2026';

  const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');
  const ownerAuthFile = path.join(AUTH_DIR, `${OWNER_USERNAME}.json`);
  const custAuthFile = path.join(AUTH_DIR, `${CUST_USER}.json`);

  let customerCreated = false;
  let customerStorage = null;

  async function ensureOwnerLoggedIn(page) {
    if (fs.existsSync(ownerAuthFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(ownerAuthFile, 'utf8'));
        if (state.cookies && state.cookies.length) {
          await page.context().clearCookies();
          await page.context().addCookies(state.cookies);
          await page.goto('/');
          const sessionBar = page.locator('.auth-sessionbar');
          if (await sessionBar.isVisible({ timeout: 5000 }).catch(() => false)) {
            const text = await sessionBar.textContent();
            if (text.includes(OWNER_USERNAME)) {
              return;
            }
          }
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

  async function ensureCustomerExists(page) {
    if (customerCreated) return;
    await ensureOwnerLoggedIn(page);
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });
    // Tablo veya liste yüklenene kadar bekle (re-render detach olmasını önlemek için)
    await expect(page.locator('table.ws-table, .ws-empty')).toBeVisible({ timeout: 15000 });

    const existing = page.locator('table.ws-table tbody tr', { hasText: CUST_USER });
    if (await existing.isVisible({ timeout: 2000 }).catch(() => false)) {
      customerCreated = true;
      return;
    }

    const addBtn = page.locator('button:has-text("Müşteri ekle")');
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await addBtn.click();

    const createDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(createDialog).toBeVisible({ timeout: 10000 });

    const usernameInput = createDialog.locator('label:has-text("Kullanıcı adı") input');
    await usernameInput.fill(CUST_USER);

    const passwordInput = createDialog.locator('label:has-text("İlk parola") input');
    await passwordInput.fill(TEST_PASS);

    const resellerSelect = createDialog.locator('label:has-text("Bağlı bayi") select');
    if (await resellerSelect.isVisible()) {
      await resellerSelect.selectOption('');
    }

    const submitBtn = createDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    await expect(createDialog).toBeHidden({ timeout: 15000 });
    await expect(page.locator('p.ws-notice[role="status"]')).toContainText(new RegExp(`${CUST_USER}.*oluşturuldu`, 'i'), { timeout: 15000 });
    customerCreated = true;
  }

  async function ensureCustomerLoggedIn(page) {
    if (customerStorage?.cookies?.length) {
      await page.context().clearCookies();
      await page.context().addCookies(customerStorage.cookies);
      await page.goto('/websites');
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
          await page.context().clearCookies();
          await page.context().addCookies(state.cookies);
          await page.goto('/websites');
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

  async function cleanupAllTestAccounts(browser) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (fs.existsSync(ownerAuthFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(ownerAuthFile, 'utf8'));
        if (state.cookies && state.cookies.length) {
          await context.addCookies(state.cookies);
        }
      } catch {}
    }
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      const cleanupReport = await page.evaluate(async (pfx) => {
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

        // 2. users tablosundaki kullanıcıyı sil
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

        // 3. Kalan kaynak kontrolü
        const checkRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const checkData = await checkRes?.json().catch(() => null);
        const remaining = (checkData?.data?.users || []).filter(u => u.username?.startsWith(pfx));
        return { remainingCount: remaining.length };
      }, prefix);

      console.log(`Temizlik kanıtı: ${cleanupReport.remainingCount} kaynak kaldı.`);
    } catch (err) {
      console.error('Cleanup test accounts error:', err);
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
    if (fs.existsSync(custAuthFile)) {
      try {
        fs.unlinkSync(custAuthFile);
      } catch {}
    }
  });

  test('mutlu yol: domain kartı, kök ve alt alan adı ağacı, arama, filtre ve fiziksel HTTP 200 kontrolü', async ({ page, request }) => {
    // 1. /websites listesini aç
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    const siteSection = page.locator('section.ws-site-list');
    await expect(siteSection).toBeVisible({ timeout: 15000 });

    // 2. Başlık açıklamasında alan adı sayaçlarını doğrula (yüklenme tamamlanana kadar bekle)
    await expect(siteSection.locator('.ws-section-heading p')).toHaveText(/(\d+)\s+ana alan adı\s*·\s*(\d+)\s+alt alan adı/i, { timeout: 20000 });

    // 3. İlk sayfada alan adı kartlarının listelendiğini doğrula
    const anyCard = page.locator('article.ws-website-task-card').first();
    await expect(anyCard).toBeVisible({ timeout: 15000 });

    // 4. Sistem posta servisi domaini (mail.webrich.news) listede gizlenmeli
    const mailServiceCard = page.locator('article.ws-website-task-card', { hasText: 'mail.webrich.news' });
    await expect(mailServiceCard).toHaveCount(0);

    // 5. Arama kutusunu test et ve webrich.news'i ara
    const searchInput = page.locator('label.ws-filter-search input[type="search"]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('webrich.news');
    await page.waitForTimeout(500); // UI URL senkronizasyonu

    // Filtrelenen ilk kartı doğrula
    const matchedCard = page.locator('article.ws-website-task-card').first();
    await expect(matchedCard).toBeVisible({ timeout: 15000 });
    await expect(matchedCard.locator('h3 a')).toContainText('webrich.news');

    // Kart hızlı araçlarını doğrula (Dosya Yöneticisi, Veritabanları, vb.)
    await expect(matchedCard.locator('a', { hasText: 'Dosya Yöneticisi' })).toBeVisible({ timeout: 5000 });

    // Araç çekmecesini aç/kapat kontrolü
    const toggleBtn = matchedCard.locator('button.ws-website-task-toggle');
    if (await toggleBtn.isVisible()) {
      await toggleBtn.click();
      await expect(matchedCard.locator('.yp-plesk-drawer')).toBeVisible({ timeout: 5000 });
      await toggleBtn.click();
      await expect(matchedCard.locator('.yp-plesk-drawer')).toBeHidden({ timeout: 5000 });
    }

    // Arama kutusunu temizle
    await searchInput.fill('');
    await page.waitForTimeout(500);

    // 6. Görünüm ve filtreler detayını aç ve kontrol et
    const optionsSummary = page.locator('details.ws-list-options summary');
    if (await optionsSummary.isVisible()) {
      await optionsSummary.click();
      await expect(page.locator('.ws-filter-options')).toBeVisible({ timeout: 5000 });
      const sortSelect = page.locator('.ws-filter-options label:has-text("Sıralama") select');
      await expect(sortSelect).toBeVisible();
      await sortSelect.selectOption('desc');
      await expect(page).toHaveURL(/sort=desc/);
      await sortSelect.selectOption('asc');
    }

    // 7. Fiziksel kanıt: Barındırılan aktif web sitesine doğrudan HTTP isteği
    const physicalRes = await request.get('https://webrich.news', { ignoreHTTPSErrors: true });
    expect(physicalRes.status()).toBe(200);
  });

  test('hatalı girdi ve sınır durumları: eşleşmeyen arama, geçersiz müşteri ID ve sınır sayfa no', async ({ page }) => {
    // 1. Eşleşmeyen arama testi
    await page.goto('/websites?q=olmayan-asdasd-xyz-12345');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    const emptyState = page.locator('.ws-empty');
    await expect(emptyState).toBeVisible({ timeout: 10000 });
    await expect(emptyState).toContainText(/Eşleşen (site veya )?alan adı bulunamadı/i);

    const clearBtn = emptyState.locator('button', { hasText: 'Filtreleri temizle' });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    await expect(page.locator('article.ws-website-task-card').first()).toBeVisible({ timeout: 15000 });

    // 2. Bilinmeyen geçersiz müşteri parametresi testi (fail-closed doğrulama)
    await page.goto('/websites?customer=00000000-0000-0000-0000-000000000000');
    const notice = page.locator('p.ws-notice[role="status"]');
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText(/Müşteri siteleri doğrulanamadı/i, { timeout: 15000 });
    // Fail-closed: Müşteri doğrulanmadığı için 0 kart listelenmeli
    await expect(page.locator('article.ws-website-task-card')).toHaveCount(0);

    // 3. Sınır durum: Geçersiz/aşırı sayfa numarası (page=999) güvenle ele alınmalı
    await page.goto('/websites?page=999');
    await expect(page.locator('section.ws-site-list')).toBeVisible({ timeout: 15000 });
    // Veriler yüklenene kadar bekle
    await expect(page.locator('section.ws-site-list .ws-section-heading p')).toHaveText(/(\d+)\s+ana alan adı/i, { timeout: 20000 });
    // Sayfa çökmemeli ve son sayfanın kartları render edilmeli
    await expect(page.locator('article.ws-website-task-card').first()).toBeVisible({ timeout: 15000 });
  });

  test('rol senaryosu: Müşteri (Customer) hesabı oluşturma, rol izolasyonu ve yetki sınırları', async ({ page }) => {
    // 1. Owner olarak Müşteri hesabı oluştur
    await ensureCustomerExists(page);

    // 2. Müşteri oturumuyla giriş yap
    await ensureCustomerLoggedIn(page);

    // 3. Müşteri /websites sayfasına git
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    // Müşteriye özel açıklama metni doğrulanır
    const customerDesc = page.locator('.ws-page-heading p');
    await expect(customerDesc).toContainText('Web sitenizin dosya, e-posta ve veritabanı araçlarını buradan yönetin.');

    // Rol izolasyonu: Müşteri, Owner'a ait siteleri (webrich.news) göremez
    const foreignSite = page.locator('article.ws-website-task-card', { hasText: 'webrich.news' });
    await expect(foreignSite).toHaveCount(0);
  });

  test('bilinen hata H1: Tür filtresinde Uygulama / Proxy seçildiğinde PHP ve Node siteler listelenmeli', async ({ page }) => {
    test.fail(true, 'BULGU WEB-07 H1: Tür: Uygulama / Proxy filtresi php ve passenger siteleri eşleştirmiyor, 0 sonuç döndürüyor');

    await page.goto('/websites?type=proxy');
    await expect(page.locator('section.ws-site-list')).toBeVisible({ timeout: 15000 });

    // Panelde PHP (yp-wp.webrich.news) ve Passenger (yp-node.webrich.news) siteleri bulunmaktadır.
    // proxy filtresi seçildiğinde bu sitelerin listelenmesi beklenir, ancak şu an 0 sonuç döndürmektedir.
    const cards = page.locator('article.ws-website-task-card');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('bilinen hata H2: Durum filtresinde Askıda (suspended) seçeneği bulunmalı', async ({ page }) => {
    test.fail(true, 'BULGU WEB-07 H2: Durum filtresinde Askıda (suspended) seçeneği bulunmuyor');

    await page.goto('/websites');
    await expect(page.locator('section.ws-site-list')).toBeVisible({ timeout: 15000 });

    const statusSelect = page.locator('.ws-filters label:has-text("Durum") select');
    await expect(statusSelect).toBeVisible({ timeout: 10000 });

    const suspendedOption = statusSelect.locator('option[value="suspended"]');
    await expect(suspendedOption).toBeAttached({ timeout: 5000 });
  });

  test('bilinen hata H3: Customer /websites ekranında Veritabanları kota paydası render kontrolü', async ({ page }) => {
    test.fail(true, 'BULGU WEB-07 H3: Customer /websites ekranında Veritabanları kota paydası — / olarak boş render ediliyor');

    await ensureCustomerExists(page);
    await ensureCustomerLoggedIn(page);
    await page.goto('/websites');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    const quotaSection = page.locator('section', { hasText: 'Barındırma Kaynakları ve Kotalar' });
    await expect(quotaSection).toBeVisible({ timeout: 15000 });

    const dbQuotaCard = quotaSection.locator('div', { hasText: 'Veritabanları' }).locator('div').filter({ hasText: '/' });
    await expect(dbQuotaCard).toBeVisible({ timeout: 5000 });
    const dbQuotaText = await dbQuotaCard.textContent();

    // Hata nedeniyle "— / " kalmaktadır, oysa "— / Sınırsız" veya bir sayı render edilmelidir
    expect(dbQuotaText).toMatch(/—\s*\/\s*(Sınırsız|\d+)/);
  });

  test('bilinen hata H4: Statik sitelerde kartta Uygulama (/node) aracı gösterilmemeli', async ({ page }) => {
    test.fail(true, 'BULGU WEB-07 H4: Statik sitelerde kart çekmecesinde Uygulama (/node) aracı gösterilmemeli');

    await page.goto('/websites?sort=desc&q=webrich.news');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    // webrich.news kök domain kartını bul
    const rootCard = page.locator('article.ws-website-task-card').filter({ has: page.locator('h3 a', { hasText: /^webrich\.news$/ }) }).first();
    await expect(rootCard).toBeVisible({ timeout: 15000 });

    // Çekmeceyi aç (eğer henüz açık değilse)
    const drawer = rootCard.locator('.yp-plesk-drawer');
    const toggleBtn = rootCard.locator('button.ws-website-task-toggle');
    if (!await drawer.isVisible().catch(() => false)) {
      await expect(toggleBtn).toBeVisible({ timeout: 5000 });
      await toggleBtn.click();
      await expect(drawer).toBeVisible({ timeout: 5000 });
    }

    // webrich.news statik bir sitedir; kartında /node (Uygulama) bağlantısı bulunmamalıdır
    const nodeTool = rootCard.locator('a[href$="/node"]');
    await expect(nodeTool).toHaveCount(0);
  });
});
