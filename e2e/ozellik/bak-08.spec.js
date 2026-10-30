import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-08 Gerçek kurtarma, hata bildirimi ve yedek sahipliği', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);
  const repoName = `tbak08-a${agentN}-${timestamp}-repo`;
  const testManagerUsername = `tbak08_mgr_${agentN}_${timestamp}`;
  const testManagerPassword = `Pass_${timestamp}_Bak08!`;
  const targetDomainName = 'yp-node.webrich.news';

  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
  let otherDomainId = null;
  let otherWebsiteId = null;
  let firstSnapshotId = null;
  let createdManagerId = null;
  let csrfToken = '';

  const getFreshCsrfToken = async (p) => {
    let res = await p.request.get('/api/auth/session').catch(() => null);
    if (!res || !res.ok()) {
      await loginAs(p, OWNER_USERNAME, OWNER_PASSWORD);
      res = await p.request.get('/api/auth/session').catch(() => null);
    }
    const json = await res?.json().catch(() => ({}));
    const tok = json?.data?.csrfToken || csrfToken;
    csrfToken = tok;
    return tok;
  };

  const openBackupPage = async (p, domainId) => {
    await p.goto(`/websites/${domainId}/backup`);
    const header = p.locator('h2:has-text("Yedekleme ve Geri Yükleme")');
    const loginForm = p.locator('form.auth-form, form:has-text("YunPanel’e giriş yapın")');
    await expect(header.or(loginForm)).toBeVisible({ timeout: 20000 });
    if (await loginForm.isVisible()) {
      await loginAs(p, OWNER_USERNAME, OWNER_PASSWORD);
      await p.goto(`/websites/${domainId}/backup`);
      await expect(header).toBeVisible({ timeout: 20000 });
    }
    await expect(p.locator('[role="status"]:has-text("okunuyor")')).toBeHidden({ timeout: 25000 }).catch(() => {});
    await getFreshCsrfToken(p);
  };

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

      const headers = {
        'x-csrf-token': token,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
        'Content-Type': 'application/json',
      };

      const deleteUserSafely = async (userId) => {
        try {
          const listRes = await page.request.get('/api/panel/users?limit=100').catch(() => null);
          const listJson = await listRes?.json().catch(() => ({}));
          const user = (listJson?.data?.users || []).find((u) => u.id === userId);
          if (!user) return;

          let rev = user.revision;
          if (user.role === 'site_manager') {
            const patchRes = await page.request.patch(`/api/panel/users/${userId}`, {
              headers,
              data: { revision: rev, websiteIds: [] },
            }).catch(() => null);
            if (patchRes && patchRes.ok()) {
              const patchJson = await patchRes.json().catch(() => ({}));
              rev = patchJson?.data?.user?.revision ?? (rev + 1);
            }
          }

          const delRes = await page.request.delete(`/api/panel/users/${userId}`, {
            headers,
            data: { revision: rev },
          }).catch(() => null);
          if (delRes && delRes.ok()) {
            console.log(`Cleaned up test manager user: ${userId} (${user.username})`);
          }
        } catch (err) {
          console.warn(`User cleanup failed for ${userId}:`, err.message);
        }
      };

      // 1. Oluşturulan geçici site_manager kullanıcısını ve tbak08 önekli tüm test kullanıcılarını sil
      if (createdManagerId) {
        await deleteUserSafely(createdManagerId);
      }
      const usersRes = await page.request.get('/api/panel/users?limit=100').catch(() => null);
      if (usersRes && usersRes.ok()) {
        const usersJson = await usersRes.json().catch(() => ({}));
        const leftoverUsers = (usersJson?.data?.users || []).filter((u) => u.username && u.username.startsWith('tbak08'));
        for (const u of leftoverUsers) {
          await deleteUserSafely(u.id);
        }
      }

      // 2. Oluşturulan test Restic yedek deposunu ve tbak08 önekli tüm test depolarını sil
      const deleteRepoSafely = async (repoId) => {
        try {
          const delRepoRes = await page.request.delete(`/api/panel/backups/repositories/${repoId}`, {
            headers: {
              'x-csrf-token': token,
              Origin: 'https://server.cryptoraichu.website',
              Referer: 'https://server.cryptoraichu.website/',
            },
          }).catch(() => null);
          if (delRepoRes && delRepoRes.ok()) {
            console.log(`Cleaned up test repo: ${repoId}`);
          }
        } catch (err) {
          console.warn(`Repo cleanup failed for ${repoId}:`, err.message);
        }
      };

      if (createdRepoId) {
        await deleteRepoSafely(createdRepoId);
      }
      const reposRes = await page.request.get('/api/panel/backups/repositories').catch(() => null);
      if (reposRes && reposRes.ok()) {
        const reposJson = await reposRes.json().catch(() => ({}));
        const leftoverRepos = (reposJson?.data || []).filter((r) => r.name && r.name.startsWith('tbak08'));
        for (const r of leftoverRepos) {
          await deleteRepoSafely(r.id);
        }
      }
    } catch (err) {
      console.warn('BAK-08 cleanup warning:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: Gerçek yedek alma, UI üzerinden seçici kurtarma başlatma, fiziksel pre_restore snapshot ve HTTP 200 doğrulaması', async ({ page, request }) => {
    // 1. Hedef siteyi ve sunucudaki diğer siteyi tespit et
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName);
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;

    // Siteler arası izolasyon için başka bir site al
    const otherSite = sites.find((w) => w.id !== targetWebsiteId);
    expect(otherSite).toBeTruthy();
    otherWebsiteId = otherSite.id;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId);
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    const otherDomain = domains.find((d) => d.websiteId === otherWebsiteId);
    expect(otherDomain).toBeTruthy();
    otherDomainId = otherDomain.id;

    // 2. Parola korumalı Restic test deposu oluştur
    const createRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: repoName,
        backend: 'local',
        password: `Pass-${timestamp}-Bak08!`,
        initialize: true,
      },
    });
    expect(createRepoRes.status()).toBe(201);
    const repoJson = await createRepoRes.json();
    createdRepoId = repoJson.data?.id;
    expect(createdRepoId).toBeTruthy();

    // 3. Web sitesinin Yedekleme ve Geri Yükleme sayfasına git
    await openBackupPage(page, targetDomainId);

    const repoSection = page.locator('section').filter({ hasText: repoName });
    await expect(repoSection).toBeVisible({ timeout: 30000 });

    // 4. UI üzerinden gerçek bir site yedeği al
    const backupBtn = page.locator('button:has-text("Yedek Al")');
    await expect(backupBtn).toBeVisible({ timeout: 15000 });
    await expect(backupBtn).toBeEnabled({ timeout: 15000 });
    await backupBtn.click();

    const backupModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni Site Yedeği Al' });
    await expect(backupModal).toBeVisible({ timeout: 10000 });

    const repoSelect = backupModal.locator('select');
    if (await repoSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await repoSelect.selectOption(createdRepoId);
    }

    const startBackupBtn = backupModal.locator('button[type="submit"]:has-text("Yedeği Başlat")');
    await expect(startBackupBtn).toBeVisible({ timeout: 15000 });
    await startBackupBtn.click();

    // Yedekleme işleminin tamamlanmasını bekle
    const backupOpSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Yedekleme işlemi' }) });
    await expect(backupOpSection).toBeVisible({ timeout: 15000 });
    await expect(backupOpSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 60000 });

    const closeBackupOpBtn = backupOpSection.locator('button:has-text("Kapat")');
    if (await closeBackupOpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBackupOpBtn.click();
    }

    // 5. Snapshot'ın tabloda listelendiğini doğrula
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('[role="status"]:has-text("okunuyor")')).toBeHidden({ timeout: 25000 }).catch(() => {});
    await expect(repoSection).toBeVisible({ timeout: 30000 });

    const snapshotRows = repoSection.locator('table.ws-table tbody tr');
    await expect(snapshotRows.first()).toBeVisible({ timeout: 45000 });

    const snRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snRes.ok()).toBe(true);
    const snData = await snRes.json();
    expect(snData.data?.length).toBeGreaterThan(0);
    firstSnapshotId = snData.data[0].id;
    expect(firstSnapshotId).toBeTruthy();

    // 6. UI ÜZERİNDEN SEÇİCİ KURTARMA (Geri Yükleme) BAŞLAT
    const restoreBtn = snapshotRows.first().locator('button:has-text("Geri Yükle")');
    await expect(restoreBtn).toBeVisible({ timeout: 10000 });
    await restoreBtn.click();

    const restoreModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedeği geri yükle' });
    await expect(restoreModal).toBeVisible({ timeout: 10000 });

    // "Seçici Geri Yükleme (Kapsamı Özelleştir)" seç
    const selectiveCheckbox = restoreModal.locator('label:has-text("Seçici Geri Yükleme") input[type="checkbox"]');
    await expect(selectiveCheckbox).toBeVisible({ timeout: 10000 });
    await selectiveCheckbox.check();

    // Site dosyaları seçili kalırken, subdomain için varsa DNS ve barındırma kutularını güvenli uncheck et
    const filesCheckbox = restoreModal.locator('label:has-text("Site dosyaları") input[type="checkbox"]');
    await expect(filesCheckbox).toBeVisible({ timeout: 5000 });
    expect(await filesCheckbox.isChecked()).toBe(true);

    const safeUncheck = async (label) => {
      const cb = restoreModal.locator(`label:has-text("${label}") input[type="checkbox"]`);
      if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(restoreModal.locator('[role="status"]')).toBeHidden({ timeout: 10000 }).catch(() => {});
        if (await cb.isEnabled().catch(() => false) && await cb.isChecked().catch(() => false)) {
          await cb.uncheck();
          await expect(restoreModal.locator('[role="status"]')).toBeHidden({ timeout: 10000 }).catch(() => {});
        }
      }
    };

    await safeUncheck('DNS kayıtları');
    await safeUncheck('Barındırma ayarları');
    await safeUncheck('Uygulama ortamı');

    // Önizlemenin ve onay kutusunun yüklenmesini bekle
    const confirmInput = restoreModal.locator('form label input');
    await expect(confirmInput).toBeVisible({ timeout: 20000 });

    // Onay metnini form içindeki strong etiketinden oku ve doğru şekilde gir
    const confirmationText = await restoreModal.locator('form label strong').textContent();
    expect(confirmationText).toBeTruthy();
    await confirmInput.fill(confirmationText.trim());

    // "Seçici Geri Yüklemeyi Başlat" butonuna tıkla
    const startRestoreBtn = restoreModal.locator('button[type="submit"]:has-text("Seçici Geri Yüklemeyi Başlat")');
    await expect(startRestoreBtn).toBeVisible({ timeout: 5000 });
    await expect(startRestoreBtn).toBeEnabled({ timeout: 5000 });
    await startRestoreBtn.click();

    // 7. Geri yükleme operasyonunun tamamlanmasını bekle
    const restoreOpSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Geri yükleme işlemi' }) });
    await expect(restoreOpSection).toBeVisible({ timeout: 15000 });
    await expect(restoreOpSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 90000 });

    // 8. FİZİKSEL KANIT 1: Geri yükleme öncesinde otomatik güvenlik snapshot'ı (pre-restore) alınmış olmalı
    const snAfterRestoreRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snAfterRestoreRes.ok()).toBe(true);
    const snAfterRestoreJson = await snAfterRestoreRes.json();
    const preRestoreSnap = (snAfterRestoreJson.data || []).find((s) => (s.tags || []).includes('pre-restore') || s.kind === 'pre_restore');
    expect(preRestoreSnap).toBeTruthy();

    // 9. FİZİKSEL KANIT 2: Operation kaydında kind: 'restore', status: 'succeeded' ve restoreOutcome bilgisi
    const opsRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backup-operations`);
    expect(opsRes.ok()).toBe(true);
    const opsJson = await opsRes.json();
    const restoreOps = (opsJson.data || []).filter((op) => op.kind === 'restore' && op.repositoryId === createdRepoId && op.status === 'succeeded');
    expect(restoreOps.length).toBeGreaterThan(0);
    const latestRestore = restoreOps[0];
    expect(latestRestore.status).toBe('succeeded');

    // 10. FİZİKSEL KANIT 3: Canlı web sitesi HTTP 200 ile ayakta
    const siteHealthRes = await request.get(`https://${targetDomainName}/`);
    expect(siteHealthRes.status()).toBe(200);
  });

  test('hatalı girdi: Geri yüklemede yanlış onay metni butonu kilitler, API geçersiz istekleri reddeder', async ({ page }) => {
    // 1. UI: Geri yükleme modalında hatalı onay metni girildiğinde submit butonu devre dışı kalır
    await openBackupPage(page, targetDomainId);

    const repoSection = page.locator('section').filter({ hasText: repoName });
    await expect(repoSection).toBeVisible({ timeout: 30000 });

    const snapshotRows = repoSection.locator('table.ws-table tbody tr');
    await expect(snapshotRows.first()).toBeVisible({ timeout: 15000 });
    const restoreBtn = snapshotRows.first().locator('button:has-text("Geri Yükle")');
    await expect(restoreBtn).toBeVisible({ timeout: 10000 });
    await restoreBtn.click();

    const restoreModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedeği geri yükle' });
    await expect(restoreModal).toBeVisible({ timeout: 10000 });

    // Seçici geri yüklemeyi aktif et
    const selectiveCheckbox = restoreModal.locator('label:has-text("Seçici Geri Yükleme") input[type="checkbox"]');
    await expect(selectiveCheckbox).toBeVisible({ timeout: 10000 });
    await selectiveCheckbox.check();

    const dnsCheckbox = restoreModal.locator('label:has-text("DNS kayıtları") input[type="checkbox"]');
    if (await dnsCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expect(restoreModal.locator('[role="status"]')).toBeHidden({ timeout: 10000 }).catch(() => {});
      if (await dnsCheckbox.isEnabled().catch(() => false) && await dnsCheckbox.isChecked().catch(() => false)) {
        await dnsCheckbox.uncheck();
      }
    }

    const confirmInput = restoreModal.locator('form label input');
    await expect(confirmInput).toBeVisible({ timeout: 20000 });

    // Hatalı / yanlış onay metni gir
    await confirmInput.fill('tamamen-hatali-onay-metni-123');

    // Submit butonu disabled olmalıdır
    const startRestoreBtn = restoreModal.locator('button[type="submit"]:has-text("Seçici Geri Yüklemeyi Başlat"), button[type="submit"]:has-text("Geri Yüklemeyi Başlat")');
    await expect(startRestoreBtn).toBeDisabled();

    // Vazgeç butonu ile modalı kapat
    const cancelBtn = restoreModal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(restoreModal).toBeHidden({ timeout: 5000 });

    // 2. API seviyesinde hatalı girdi: Geçersiz include listesi veya path traversal reddedilir (400)
    const invalidPreviewRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/restore/preview`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        repositoryId: createdRepoId,
        snapshotId: firstSnapshotId,
        include: ['../../../../etc/shadow'],
      },
    });
    expect(invalidPreviewRes.status()).toBeGreaterThanOrEqual(400);

    // 3. API seviyesinde hatalı girdi: Var olmayan snapshot ID ile restore isteği reddedilir (404)
    const notFoundRestoreRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/restore/preview`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        repositoryId: createdRepoId,
        snapshotId: '0000000000000000000000000000000000000000000000000000000000000000',
        include: [],
      },
    });
    expect([400, 404]).toContain(notFoundRestoreRes.status());
  });

  test('yetki ve sahiplik: Siteler arası izolasyon, sahiplik etiketi koruması ve site_manager sınırları', async ({ page, browser }) => {
    // 0. Oturum ve CSRF token'ı taze doğrula
    let currentToken = await getFreshCsrfToken(page);

    // 1. Siteler Arası İzolasyon (UI): Başka bir sitenin yedekleme sayfasında bu repo için hedef sitenin snapshot'ları görünmez
    await openBackupPage(page, otherDomainId);

    const otherRepoSection = page.locator('section').filter({ hasText: repoName });
    if (await otherRepoSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Repo listelense dahi bu site için snapshot sayısı 0 olmalıdır
      const emptyNotice = otherRepoSection.locator('.ws-empty').or(otherRepoSection.getByText('Bu site için yedek yok'));
      await expect(emptyNotice.first()).toBeVisible({ timeout: 10000 });
    }

    // 2. Siteler Arası İzolasyon (API): Yabancı site üzerinden ilk sitenin snapshot'ı ile restore preview istendiğinde 404 döner
    currentToken = await getFreshCsrfToken(page);
    const crossSitePreviewRes = await page.request.post(`/api/panel/websites/${otherWebsiteId}/restore/preview`, {
      headers: {
        'x-csrf-token': currentToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        repositoryId: createdRepoId,
        snapshotId: firstSnapshotId,
        include: [],
      },
    });
    expect(crossSitePreviewRes.status()).toBe(404);
    const crossSiteJson = await crossSitePreviewRes.json();
    expect(crossSiteJson.error?.code).toBe('snapshot_not_found');

    // 3. Sahiplik Etiketi Koruması: POST /backup-operations içine başka bir sitenin etiketi enjekte edilemez (400 backup_tag_reserved)
    const backupPrevRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup/preview`, {
      headers: {
        'x-csrf-token': currentToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        repositoryId: createdRepoId,
      },
    });
    expect(backupPrevRes.ok()).toBe(true);
    const backupPrevJson = await backupPrevRes.json();
    const digest = backupPrevJson.data?.backupSetDigest || backupPrevJson.data?.previewDigest;
    const confirmation = backupPrevJson.data?.confirmation;

    const tagInjectRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup-operations`, {
      headers: {
        'x-csrf-token': currentToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'backup',
        repositoryId: createdRepoId,
        expectedPreviewDigest: digest,
        confirmation,
        tags: [`website:${otherWebsiteId}`],
      },
    });
    expect(tagInjectRes.status()).toBe(400);
    const tagJson = await tagInjectRes.json();
    expect(tagJson.error?.code).toBe('backup_tag_reserved');

    // 4. Rol İzolasyonu: Sadece hedef siteye yetkili geçici site_manager kullanıcısı oluştur
    const createUserRes = await page.request.post('/api/panel/users', {
      headers: {
        'x-csrf-token': currentToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        username: testManagerUsername,
        password: testManagerPassword,
        role: 'site_manager',
        websiteIds: [targetWebsiteId],
      },
    });
    expect(createUserRes.status()).toBe(201);
    const userJson = await createUserRes.json();
    createdManagerId = userJson.data?.user?.id || userJson.data?.id;
    expect(createdManagerId).toBeTruthy();

    // 5. site_manager oturumuyla giriş yap ve yedekleme arayüzünü incele
    const managerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const managerPage = await managerContext.newPage();
    try {
      await loginAs(managerPage, testManagerUsername, testManagerPassword);

      // Sitenin yedekleme sayfasına git
      await managerPage.goto(`/websites/${targetDomainId}/backup`);
      await expect(managerPage.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 20000 });

      // Salt-okunur uyarı bildiriminin görünür olduğunu doğrula
      const readOnlyNotice = managerPage.locator('text=Bu ekranda yalnız bu sitenin yedeklerini görebilirsiniz');
      await expect(readOnlyNotice).toBeVisible({ timeout: 10000 });

      // Mutasyon butonlarının (Yedek Al, Geri Yükle, Plan ve Zamanlama) render edilmediğini doğrula
      await expect(managerPage.locator('button:has-text("Yedek Al")')).toBeHidden();
      await expect(managerPage.locator('button:has-text("Plan ve Zamanlama")')).toBeHidden();
      await expect(managerPage.locator('button:has-text("Geri Yükle")')).toBeHidden();

      // 6. site_manager API sınırları: Yabancı sitenin yedeklerine ve global depo listesine erişim 403 ile engellenir
      const managerOtherBackupsRes = await managerPage.request.get(`/api/panel/websites/${otherWebsiteId}/backups`);
      expect(managerOtherBackupsRes.status()).toBe(403);

      const managerGlobalReposRes = await managerPage.request.get('/api/panel/backups/repositories');
      expect(managerGlobalReposRes.status()).toBe(403);
    } finally {
      await managerContext.close().catch(() => {});
    }
  });

  test('Plesk eşdeğerliği ve bilinen hata: Panelde Restic depo oluşturma UI ekranı eksikliği (T802)', async ({ page }) => {
    test.fail(true, 'BULGU T802: Panel arayüzünde Restic yedek deposu oluşturma / başlatma ekranı yok');

    // Web sitesinin yedekleme ekranına git
    await openBackupPage(page, targetDomainId);

    // Panel arayüzünde yeni Restic yedek deposu oluşturma / bağlama butonu
    const createRepoBtn = page.locator('button, a').filter({ hasText: /^Yeni Depo$|^Depo Ekle$|^Depo Oluştur$|^Restic Deposu Tanımla$/ });
    await expect(createRepoBtn.first()).toBeVisible({ timeout: 3000 });
  });
});
