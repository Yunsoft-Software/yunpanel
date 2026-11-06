import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('UX-01 Plesk görev yerleşimi ve tüm rollerin doğru menüsü', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tux01-a${agentN}-${Date.now().toString(36)}`;
  const RES_USER = `${prefix}-res`;
  const CUST_USER = `${prefix}-cust`;
  const TEST_PASS = 'TuX01_P@ss!2026';

  let resolvedDomainId = null;

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

  async function cleanupAllTestAccounts(browser, pfx = prefix) {
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

        // 1. Müşteri ve bayi profillerini sil
        for (const kind of ['customer', 'reseller']) {
          const res = await fetch(`/api/panel/users/hosting/accounts?kind=${kind}&limit=100`).catch(() => null);
          const data = await res?.json().catch(() => null);
          for (const acc of data?.data?.accounts || []) {
            const u = acc.username || '';
            if (u.startsWith(pfx)) {
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

        // 2. /api/panel/users listesinden kullanıcıları sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          const uname = u.username || '';
          if (uname !== currentOwner && uname.startsWith(pfx)) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }
        // 3. Doğrula: öneke ait kullanıcı kalmadığını onayla
        const verifyUsersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const verifyData = await verifyUsersRes?.json().catch(() => null);
        const remaining = (verifyData?.data?.users || []).filter((u) => u.username && u.username.startsWith(pfx));
        if (remaining.length > 0) {
          throw new Error(`Temizlik başarısız: ${remaining.length} kullanıcı kaldı: ${remaining.map((u) => u.username).join(', ')}`);
        }
      }, pfx);
    } finally {
      await context.close().catch(() => {});
    }
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: Owner sol menüsü, Araçlar ve Ayarlar grupları, site görev kartları ve Plesk 3 görev grubu sekme yapısı', async ({ page }) => {
    await ensureOwnerLoggedIn(page);
    await page.goto('/websites');
    await expect(page.locator('.workspace-shell')).toBeVisible({ timeout: 15000 });

    // 1. Sol menü başlığı, marka ve görev odaklı birincil menü bağlantıları
    const sidebar = page.locator('aside.ws-sidebar');
    await expect(sidebar).toBeVisible({ timeout: 15000 });
    await expect(sidebar.locator('.ws-brand small')).toContainText('SUNUCU YÖNETİMİ');

    await expect(sidebar.locator('a[href="/websites"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/docker"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/mail"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/files"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/databases"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/statistics"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/customers"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/resellers"]')).toBeVisible();
    await expect(sidebar.locator('a[href="/tools-settings"]')).toBeVisible();

    // Sunucu iç rotaları sol menüyü şişirmemeli
    await expect(sidebar.locator('a[href="/servers"]')).toHaveCount(0);
    await expect(sidebar.locator('a[href="/firewall"]')).toHaveCount(0);
    await expect(sidebar.locator('a[href="/logs"]')).toHaveCount(0);

    // 2. /tools-settings (Araçlar ve Ayarlar) 3 Plesk görev grubu
    await sidebar.locator('a[href="/tools-settings"]').click();
    await page.waitForURL(/\/tools-settings/, { timeout: 15000 });
    await expect(page.locator('h1')).toContainText('Araçlar ve Ayarlar');

    // 3 kategori başlığı
    await expect(page.locator('h2', { hasText: 'Sunucu ve hizmetler' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Panel ve erişim' })).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Tanılama ve kayıtlar' })).toBeVisible();

    // Alt yönetim bağlantıları
    await expect(page.locator('a[href="/servers"]').first()).toBeVisible();
    await expect(page.locator('a[href="/firewall"]').first()).toBeVisible();
    await expect(page.locator('a[href="/settings/users"]').first()).toBeVisible();
    await expect(page.locator('a[href="/jobs"]').first()).toBeVisible();
    await expect(page.locator('a[href="/audit"]').first()).toBeVisible();
    await expect(page.locator('a[href="/logs"]').first()).toBeVisible();

    // 3. /websites site görev kartları ve Plesk görev grubu sekmeleri
    await sidebar.locator('a[href="/websites"]').click();
    await page.waitForURL(/\/websites/, { timeout: 15000 });

    const taskCards = page.locator('.ws-website-task-card');
    await expect(taskCards.first()).toBeVisible({ timeout: 15000 });

    // Kart üzerindeki hızlı araç bağlantılarından Domain ID'yi yakala (Tam barındırma sunan bir site seç)
    const hostingCard = taskCards.filter({ has: page.locator('.ws-website-task-title p', { hasText: /(Statik|PHP|Node|WordPress|Docker)/i }) }).first();
    const firstCard = await hostingCard.isVisible().catch(() => false) ? hostingCard : taskCards.first();
    const overviewLink = firstCard.locator('a[href*="/websites/"]').first();
    const linkHref = await overviewLink.getAttribute('href');
    const domainMatch = linkHref?.match(/\/websites\/([^/?#]+)/);
    expect(domainMatch).toBeTruthy();
    resolvedDomainId = domainMatch[1];

    // Site çalışma alanına git
    await overviewLink.click();
    await page.waitForURL(new RegExp(`/websites/${resolvedDomainId}`), { timeout: 15000 });

    // 3 Plesk görev grubu: Site, Barındırma ve DNS, Posta (3 araç grubu ve ilgili sekmeler)
    const siteNav = page.locator('.ws-plesk-site-navigation');
    await expect(siteNav).toBeVisible({ timeout: 15000 });
    await expect(siteNav.locator('.ws-site-tool-group')).toHaveCount(3);
    await expect(siteNav.locator('a[href$="/overview"]')).toBeVisible();
    await expect(siteNav.locator('a[href$="/hosting"]')).toBeVisible();
    await expect(siteNav.locator('a[href$="/mail"]')).toBeVisible();

    // Genel bakış bölümleri: Site araçları ve Yayın bilgileri
    await expect(page.locator('section.ws-section h2', { hasText: 'Site araçları' })).toBeVisible();
    await expect(page.locator('section.ws-section h2', { hasText: 'Yayın bilgileri' })).toBeVisible();

    // 4. Global araç yönlendirmesi: ?site=<domainId> ile doğrudan analytics sekmesine geçiş
    await page.goto(`/statistics?site=${resolvedDomainId}`);
    await page.waitForURL(new RegExp(`/websites/${resolvedDomainId}/analytics`), { timeout: 15000 });
    await expect(page.locator('nav a[href$="/analytics"].active, nav a[aria-current="page"]').first()).toBeVisible();

    // 5. Fiziksel kanıt: API üzerinden oturum ve siteler listesi
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBeTruthy();
    const sitesData = await sitesRes.json();
    const sites = Array.isArray(sitesData.data) ? sitesData.data : sitesData.data?.websites || [];
    expect(sites.length).toBeGreaterThan(0);

    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.ok()).toBeTruthy();
    const sessionData = await sessionRes.json();
    expect(sessionData.data?.user?.role).toBe('owner');
  });

  test('hatalı girdi ve sınır durumları: olmayan rota (404), geçersiz ?site= parametresi ve açık yönlendirme koruması', async ({ page }) => {
    await ensureOwnerLoggedIn(page);

    // 1. Olmayan rota (NotFoundPage)
    await page.goto('/olmayan-rota-ux01');
    await expect(page.locator('h1', { hasText: 'Sayfa bulunamadı' })).toBeVisible({ timeout: 15000 });

    // 2. Geçersiz ?site= kimliği: sessizce başka siteye düşmemeli
    await page.goto('/databases?site=olmayan-site-id-999');
    await expect(page.locator('body')).toContainText(/İstenen siteye erişilemiyor|erişilemiyor/i, { timeout: 15000 });

    // 3. Açık yönlendirme (open redirect) koruması
    if (!resolvedDomainId) {
      const sitesRes = await page.request.get('/api/panel/websites');
      const sitesData = await sitesRes.json();
      const sites = Array.isArray(sitesData.data) ? sitesData.data : sitesData.data?.websites || [];
      resolvedDomainId = sites[0]?.domainId || sites[0]?.id;
    }

    const testReturnUrls = [
      'https://evil.example/phish',
      '//evil.example/phish',
      'javascript:alert(1)',
    ];

    for (const ret of testReturnUrls) {
      await page.goto(`/websites/${resolvedDomainId}/files?returnTo=${encodeURIComponent(ret)}`);
      await page.waitForLoadState('domcontentloaded');
      const backLink = page.locator('a:has-text("Web Siteleri"), a.ws-back-link').first();
      if (await backLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const href = await backLink.getAttribute('href');
        expect(href).not.toContain('evil.example');
        expect(href).not.toContain('javascript:');
        expect(href).toMatch(/^\/websites/);
      }
    }
  });

  test('rol senaryosu: Customer ve Reseller sol menü kısıtları, tenant izolasyonu ve 403 API engeli', async ({ browser }) => {
    // 1. Owner oturumu ile Bayi ve Müşteri hesabı oluştur
    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const ownerPage = await ownerContext.newPage();
    try {
      await ensureOwnerLoggedIn(ownerPage);

      // Bayi oluştur
      await ownerPage.goto('/resellers');
      await ownerPage.locator('button:has-text("Bayi ekle")').click();
      const resellerDialog = ownerPage.locator('dialog[open], [role="dialog"]').filter({ hasText: 'Bayi ekle' });
      await expect(resellerDialog).toBeVisible({ timeout: 10000 });
      await resellerDialog.locator('label:has-text("Kullanıcı adı") input').fill(RES_USER);
      await resellerDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
      await resellerDialog.locator('label:has-text("En fazla müşteri") input').fill('2');
      await resellerDialog.locator('label:has-text("En fazla web sitesi") input').fill('3');
      await resellerDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
      await expect(resellerDialog).toBeHidden({ timeout: 15000 });

      // Müşteri oluştur
      await ownerPage.goto('/customers');
      await ownerPage.locator('button:has-text("Müşteri ekle")').click();
      const custDialog = ownerPage.locator('dialog[open], [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
      await expect(custDialog).toBeVisible({ timeout: 10000 });
      await custDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST_USER);
      await custDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
      const resSelect = custDialog.locator('label:has-text("Bağlı bayi") select');
      if (await resSelect.isVisible()) {
        await resSelect.selectOption('');
      }
      await custDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
      await expect(custDialog).toBeHidden({ timeout: 15000 });
    } finally {
      await ownerContext.close().catch(() => {});
    }

    // 2. Reseller oturumu ile menü ve kısıt kontrolü
    const resContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const resPage = await resContext.newPage();
    try {
      await loginAs(resPage, RES_USER, TEST_PASS);
      await resPage.goto('/websites');
      await expect(resPage.locator('.workspace-shell')).toBeVisible({ timeout: 15000 });

      const resSidebar = resPage.locator('aside.ws-sidebar');
      await expect(resSidebar).toBeVisible({ timeout: 15000 });
      await expect(resSidebar.locator('.ws-brand small')).toContainText('BAYİ PANELİ');

      // Bayi 6 izinli öğe
      await expect(resSidebar.locator('a[href="/customers"]')).toBeVisible();
      await expect(resSidebar.locator('a[href="/websites"]')).toBeVisible();
      await expect(resSidebar.locator('a[href="/mail"]')).toBeVisible();
      await expect(resSidebar.locator('a[href="/files"]')).toBeVisible();
      await expect(resSidebar.locator('a[href="/databases"]')).toBeVisible();
      await expect(resSidebar.locator('a[href="/statistics"]')).toBeVisible();

      // Bayide yasaklı menü öğeleri
      await expect(resSidebar.locator('a[href="/resellers"]')).toHaveCount(0);
      await expect(resSidebar.locator('a[href="/tools-settings"]')).toHaveCount(0);
      await expect(resSidebar.locator('a[href="/docker"]')).toHaveCount(0);

      // Yasaklı rotalara gitmeyi dene: /tools-settings ve /servers -> /websites yönlenmeli
      await resPage.goto('/tools-settings');
      await resPage.waitForURL(/\/websites/, { timeout: 15000 });

      await resPage.goto('/servers');
      await resPage.waitForURL(/\/websites/, { timeout: 15000 });
    } finally {
      await resContext.close().catch(() => {});
    }

    // 3. Customer oturumu ile menü, kısıt ve fiziksel 403 API kontrolü
    const custContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const custPage = await custContext.newPage();
    try {
      await loginAs(custPage, CUST_USER, TEST_PASS);
      await custPage.goto('/websites');
      await expect(custPage.locator('.workspace-shell')).toBeVisible({ timeout: 15000 });

      const custSidebar = custPage.locator('aside.ws-sidebar');
      await expect(custSidebar).toBeVisible({ timeout: 15000 });
      await expect(custSidebar.locator('.ws-brand small')).toContainText('MÜŞTERİ PANELİ');

      // Müşteri 5 izinli öğe
      await expect(custSidebar.locator('a[href="/websites"]')).toBeVisible();
      await expect(custSidebar.locator('a[href="/mail"]')).toBeVisible();
      await expect(custSidebar.locator('a[href="/files"]')).toBeVisible();
      await expect(custSidebar.locator('a[href="/databases"]')).toBeVisible();
      await expect(custSidebar.locator('a[href="/statistics"]')).toBeVisible();

      // Müşteride yasaklı menü öğeleri
      await expect(custSidebar.locator('a[href="/customers"]')).toHaveCount(0);
      await expect(custSidebar.locator('a[href="/resellers"]')).toHaveCount(0);
      await expect(custSidebar.locator('a[href="/tools-settings"]')).toHaveCount(0);

      // Yasaklı rotalar: /customers ve /tools-settings -> /websites yönlenmeli
      await custPage.goto('/customers');
      await custPage.waitForURL(/\/websites/, { timeout: 15000 });

      await custPage.goto('/tools-settings');
      await custPage.waitForURL(/\/websites/, { timeout: 15000 });

      // Fiziksel yetki kanıtı: Müşteri oturumunda /api/panel/users çağrısı 403 Forbidden dönmeli
      const forbiddenRes = await custPage.request.get('/api/panel/users');
      expect(forbiddenRes.status()).toBe(403);
    } finally {
      await custContext.close().catch(() => {});
    }
  });

  test('bilinen hata: /settings/users modalında Site Yöneticisi seçildiğinde web sitelerinin yüklenmemesi', async ({ page }) => {
    test.fail(true, 'BULGU UX-01: /settings/users modalında Site Yöneticisi seçildiğinde siteler yüklenmiyor');

    await ensureOwnerLoggedIn(page);
    await page.goto('/settings/users');
    await expect(page.locator('h1')).toContainText('Kullanıcılar', { timeout: 15000 });

    await page.locator('button:has-text("Kullanıcı ekle")').click();
    const userModal = page.locator('dialog[open], [role="dialog"]').filter({ hasText: 'Kullanıcı ekle' });
    await expect(userModal).toBeVisible({ timeout: 10000 });

    // Rolü Site Yöneticisi yap
    const roleSelect = userModal.locator('label:has-text("Rol") select');
    await roleSelect.selectOption('site_manager');

    // Beklenen: Sunucuda siteler olduğundan en az 1 site checkbox'ı görünmeli
    // Gerçek: workspaceResources('/settings/users') websites: false olduğu için "Henüz kayıtlı web sitesi yok." yazar ve checkbox gelmez.
    await expect(userModal.locator('input[type="checkbox"]')).toBeVisible({ timeout: 4000 });
  });

  test('bilinen hata: Reseller ve Customer rolünde /jobs ve /audit rotalarının açık olması ve üst barda İşlemler butonu', async ({ browser }) => {
    test.fail(true, 'BULGU UX-01: Reseller ve Customer rolünde /jobs ve /audit rotaları erişilebilir ve üst barda İşlemler butonu görünüyor');

    const custContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const custPage = await custContext.newPage();
    try {
      await loginAs(custPage, CUST_USER, TEST_PASS);
      await custPage.goto('/websites');
      await expect(custPage.locator('.workspace-shell')).toBeVisible({ timeout: 15000 });

      // Beklenen 1: Customer için üst barda İşlemler butonu görünmemeli
      // Gerçek: canManage kontrolü yapıldığı için <LinkButton to="/jobs"> görünür kalır.
      await expect(custPage.locator('.ws-toolbar-actions a[href="/jobs"]')).toHaveCount(0);

      // Beklenen 2: Customer /audit rotasına gittiğinde /websites adresine yönlendirilmeli
      // Gerçek: manage(<AuditPage />) ile korunduğu için yönlenmez, sayfa açılır.
      await custPage.goto('/audit');
      await custPage.waitForURL(/\/websites/, { timeout: 4000 });
    } finally {
      await custContext.close().catch(() => {});
    }
  });

  test('bilinen hata: Mobil görünümde (<=768px) Site aracı select seçicisinin CSS ile gizlenmiş olması', async ({ page }) => {
    test.fail(true, 'BULGU UX-01: Mobil görünümde (<=768px) Site aracı select seçicisi CSS ile gizli');

    await page.setViewportSize({ width: 390, height: 844 });
    await ensureOwnerLoggedIn(page);

    if (!resolvedDomainId) {
      const sitesRes = await page.request.get('/api/panel/websites');
      const sitesData = await sitesRes.json();
      const sites = Array.isArray(sitesData.data) ? sitesData.data : sitesData.data?.websites || [];
      resolvedDomainId = sites[0]?.domainId || sites[0]?.id;
    }

    await page.goto(`/websites/${resolvedDomainId}/overview`);
    await expect(page.locator('.ws-plesk-site-navigation')).toBeVisible({ timeout: 15000 });

    // Beklenen: ui-plan.md §1 gereği mobilde .ws-site-tool-select seçicisi görünür olmalıdır
    // Gerçek: theme.css içindeki @media (max-width: 768px) kuralı display: none !important uyguladığı için gizlidir.
    await expect(page.locator('.ws-site-tool-select')).toBeVisible({ timeout: 4000 });
  });
});
