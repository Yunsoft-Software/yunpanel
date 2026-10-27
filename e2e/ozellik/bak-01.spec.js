import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-01 Server, reseller/customer, subscription ve site düzeyleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const testUsername = `tbak01_sm_${agentN}_${timestamp}`;
  const testPassword = `Pass_${timestamp}_Bak01!`;
  const targetDomainName = 'yp-node.webrich.news';

  let targetDomainId = null;
  let targetWebsiteId = null;
  let csrfToken = '';
  let createdUserId = null;

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
        const retryBtn = page.locator('button:has-text("Tekrar dene")');
        if (await retryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
          await retryBtn.click();
        }
      }
    }

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
      const token = (await sessionRes?.json())?.data?.csrfToken || csrfToken;

      // Temizlik: Oluşturulan geçici site_manager kullanıcısını sil
      if (testUsername) {
        await page.goto('/settings/users').catch(() => {});
        const userRow = page.locator('table tr', { hasText: testUsername });
        if (await userRow.isVisible({ timeout: 5000 }).catch(() => false)) {
          const deleteBtn = userRow.locator('button:has-text("Sil")');
          if (await deleteBtn.isVisible().catch(() => false)) {
            await deleteBtn.click().catch(() => {});
            const confirmBtn = page.locator('button:has-text("Kullanıcıyı sil"), button:has-text("Onayla")');
            if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await confirmBtn.click().catch(() => {});
            }
          }
        }
      }
    } catch (err) {
      console.warn('BAK-01 cleanup notice:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: Server düzeyi depoların listelenmesi, Site düzeyi yedek arayüzü ve fiziksel backup-set kanıtı', async ({ page }) => {
    // 1. Server Düzeyi: Depo listesi API sorgusu
    const reposRes = await page.request.get('/api/panel/backups/repositories');
    expect(reposRes.ok()).toBe(true);
    const reposJson = await reposRes.json();
    expect(Array.isArray(reposJson.data)).toBe(true);

    // 2. Hedef site ve domain bilgilerini al
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName) || sites[0];
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId) || domains[0];
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    // 3. Site Düzeyi: Arayüz üzerinden site detayına ve Yedekleme sekmesine git
    await page.goto(`/websites/${targetDomainId}`);
    await expect(page.locator('h1, h2')).toBeVisible({ timeout: 15000 });

    const backupTab = page.locator('button, a').filter({ hasText: /Yedekleme/i });
    if (await backupTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await backupTab.click();
    } else {
      await page.goto(`/websites/${targetDomainId}/backup`);
    }

    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // Yedek seti özet bilgilerinin arayüzde görünürlüğü
    await expect(page.locator('text=Yedek seti').or(page.locator('text=Veritabanı'))).toBeVisible({ timeout: 15000 });

    // 4. Fiziksel Sonuç Kanıtı: /api/panel/websites/:id/backups API yanıtını doğrula
    const backupRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backups`);
    expect(backupRes.ok()).toBe(true);
    const backupJson = await backupRes.json();
    expect(backupJson.data).toBeTruthy();
    expect(backupJson.data.websiteId).toBe(targetWebsiteId);
    expect(backupJson.data.backupSet).toBeTruthy();
    expect(typeof backupJson.data.backupSet.databaseCount).toBe('number');
    expect(typeof backupJson.data.backupSet.mailCount).toBe('number');
    expect(typeof backupJson.data.backupSet.pathCount).toBe('number');
    expect(Array.isArray(backupJson.data.repositories)).toBe(true);
  });

  test('yetki/sınır senaryosu: site_manager rolünün sunucu düzeyi depolara ve yetkisiz site yedeklerine erişiminin 403 ile engellenmesi', async ({ page }) => {
    // 1. Owner oturumuyla yeni bir site_manager kullanıcısı oluştur
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 15000 });

    const addUserBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addUserBtn).toBeVisible({ timeout: 10000 });
    await addUserBtn.click();

    await expect(page.locator('h2:has-text("Kullanıcı ekle")')).toBeVisible({ timeout: 10000 });
    await page.fill('input[name="username"]', testUsername);
    await page.fill('input[name="new-password"]', testPassword);
    await page.selectOption('label:has-text("Rol") select', 'site_manager');
    await page.click('button[type="submit"]:has-text("Hesap oluştur")');

    await expect(page.locator('.ws-notice')).toContainText(/Hesap oluşturuldu/i, { timeout: 15000 });
    await expect(page.locator('table', { hasText: testUsername })).toBeVisible({ timeout: 10000 });

    // 2. Owner oturumunu kapatıp site_manager kullanıcısı ile oturum aç
    await logout(page);
    await loginAs(page, testUsername, testPassword);

    const smSessionRes = await page.request.get('/api/auth/session');
    expect(smSessionRes.ok()).toBe(true);
    const smSessionJson = await smSessionRes.json();
    const smToken = smSessionJson?.data?.csrfToken || '';
    expect(smSessionJson?.data?.user?.role).toBe('site_manager');

    // 3. Sınır Doğrulaması 1: site_manager rolü Sunucu Düzeyi Restic Deposu oluşturamaz (403 Forbidden)
    const unauthorizedRepoCreate = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': smToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: `unauth-repo-${timestamp}`,
        backend: 'local',
        password: 'forbidden-pass-1234!',
      },
    });
    expect(unauthorizedRepoCreate.status()).toBe(403);
    const unauthRepoJson = await unauthorizedRepoCreate.json();
    expect(['forbidden', 'site_scope_forbidden']).toContain(unauthRepoJson.error?.code);

    // 4. Sınır Doğrulaması 2: site_manager rolü doğrudan site yedeği başlatamaz (requireOwner -> 403 Forbidden)
    const unauthorizedBackupTrigger = await page.request.post(`/api/panel/websites/${targetWebsiteId || '00000000-0000-0000-0000-000000000000'}/backup-operations`, {
      headers: {
        'x-csrf-token': smToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'backup',
        repositoryId: '00000000-0000-0000-0000-000000000000',
        expectedPreviewDigest: '0'.repeat(64),
        confirmation: 'backup:unauth:test',
      },
    });
    expect(unauthorizedBackupTrigger.status()).toBe(403);
    const unauthBackupJson = await unauthorizedBackupTrigger.json();
    expect(['forbidden', 'site_scope_forbidden']).toContain(unauthBackupJson.error?.code);

    // 5. Oturumu kapatıp Owner'a geri dön
    await logout(page);
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test('eksiklik tespiti: Plesk eşdeğeri sunucu geneli (server-wide full backup) ve müşteri/abonelik düzeyinde toplu yedekleme arayüzü', async ({ page }) => {
    // Plesk Parity Kuralı:
    // Plesk Backup Manager'da Tools & Settings altında tek tıkla "Back Up" seçilerek
    // tüm sunucuyu, konfigürasyonu ve tüm barındırılan müşteri/abonelik sitelerini tek arşivde yedekleme
    // ve Müşteri/Abonelik seviyesinde "Tüm aboneliği yedekle" işlevi mevcuttur.
    // YunPanel'de ise yedekleme yalnızca tekil site (SiteBackupPanel) düzeyinde çalışır;
    // genel sunucu yedeği veya toplu müşteri yedeği UI akışı henüz bulunmamaktadır.
    test.fail(
      true,
      'BULGU BAK-01: Plesk eşdeğeri sunucu geneli (server-wide) ve müşteri/abonelik düzeyinde toplu yedekleme arayüzü mevcut değil; yalnızca site düzeyinde tekil yedekleme destekleniyor'
    );

    await page.goto('/settings');
    const fullServerBackupBtn = page.locator('button:has-text("Sunucu Yedeği Al"), button:has-text("Tüm Sunucuyu Yedekle")');
    await expect(fullServerBackupBtn).toBeVisible({ timeout: 5000 });
  });
});
