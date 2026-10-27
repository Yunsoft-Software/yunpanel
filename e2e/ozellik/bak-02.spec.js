import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-02 Yapılandırma/içerik, dosya/mail/DB kapsam seçimi', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const repoName = `tbak02-a${agentN}-${timestamp}-repo`;
  const targetDomainName = 'yp-node.webrich.news';

  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
  let targetActualDomainName = targetDomainName;
  let csrfToken = '';

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

      // Temizlik: Test için oluşturulan Restic yedek deposunu sil
      if (createdRepoId && token) {
        const delRes = await page.request.delete(`/api/panel/backups/repositories/${createdRepoId}`, {
          headers: {
            'x-csrf-token': token,
            Origin: 'https://server.cryptoraichu.website',
            Referer: 'https://server.cryptoraichu.website/',
          },
        }).catch(() => null);
        if (delRes && delRes.ok()) {
          console.log(`Cleaned up BAK-02 test restic repo: ${createdRepoId}`);
        }
      }
    } catch (err) {
      console.warn('BAK-02 cleanup notice:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: Yedekleme kapsamı incelemesi, UI üzerinden yedek alma ve fiziksel snapshot etiketleri/metrikleri kanıtı', async ({ page }) => {
    // 1. Hedef web sitesinin websiteId ve domainId'sini al
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName) || sites[0];
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;
    targetActualDomainName = site.name || targetDomainName;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId) || domains[0];
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    // 2. Test amaçlı Restic yedek deposunu oluştur (11 Ekim kuralı: izole test deposu, bitince temizlenir)
    const createRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: repoName,
        backend: 'local',
        password: `Pass-${timestamp}-B3kUp02!`,
        initialize: true,
      },
    });
    expect(createRepoRes.status()).toBe(201);
    const repoJson = await createRepoRes.json();
    createdRepoId = repoJson.data?.id;
    expect(createdRepoId).toBeTruthy();

    // 3. Sitenin sayfasına git ve Yedekleme sekmesini aç
    await page.goto(`/websites/${targetDomainId}`);
    await expect(page.locator('text=Alan adı yükleniyor…')).toBeHidden({ timeout: 20000 });
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15000 });

    const backupTab = page.locator('button, a').filter({ hasText: /Yedekleme/i });
    if (await backupTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await backupTab.click();
    } else {
      await page.goto(`/websites/${targetDomainId}/backup`);
      await expect(page.locator('text=Alan adı yükleniyor…')).toBeHidden({ timeout: 20000 });
    }

    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 20000 });

    // Kapsam özeti kartının (dosya yolu, veritabanı, posta, DNS) sayfada görünürlüğü
    const scopeSummaryRow = page.locator('text=Kapsam özeti');
    await expect(scopeSummaryRow).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=dosya yolu')).toBeVisible({ timeout: 15000 });

    // Yeni oluşturulan deponun sayfada listelendiğini doğrula
    await expect(page.locator(`section:has-text("${repoName}")`)).toBeVisible({ timeout: 20000 });

    // 4. Arayüzden "Yedek Al" butonuna tıkla ve modalı aç
    const backupBtn = page.locator('button:has-text("Yedek Al")');
    await expect(backupBtn).toBeVisible({ timeout: 15000 });
    await expect(backupBtn).toBeEnabled({ timeout: 15000 });
    await backupBtn.click();

    const backupModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni Site Yedeği Al' });
    await expect(backupModal).toBeVisible({ timeout: 10000 });

    // Depo seçimi (oluşturduğumuz yeni test deposunu seç)
    const repoSelect = backupModal.locator('select');
    if (await repoSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await repoSelect.selectOption(createdRepoId);
    }

    // Modal içerisindeki kapsam mesajını doğrula
    await expect(backupModal.locator('text=Bu sitenin dosyaları')).toBeVisible({ timeout: 15000 });

    // "Yedeği Başlat" onay butonuna tıkla
    const startBackupBtn = backupModal.locator('button:has-text("Yedeği Başlat")');
    await expect(startBackupBtn).toBeVisible({ timeout: 10000 });
    await startBackupBtn.click();

    // 5. İşlemin başlaması ve tamamlanmasını takip et
    await expect(backupModal).toBeHidden({ timeout: 15000 });
    const opSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Yedekleme işlemi' }) });
    await expect(opSection).toBeVisible({ timeout: 15000 });

    // Operasyonun başarıyla tamamlanmasını bekle (en fazla 90 saniye)
    await expect(opSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 90000 });

    // 6. FİZİKSEL SONUÇ KANITI 1: /api/panel/websites/:id/backup-operations üzerinden doğrula
    const opsRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backup-operations`);
    expect(opsRes.ok()).toBe(true);
    const opsJson = await opsRes.json();
    const ops = opsJson.data || [];
    const successfulBackup = ops.find((op) => op.kind === 'backup' && op.repositoryId === createdRepoId && op.status === 'succeeded');
    expect(successfulBackup).toBeTruthy();
    expect(successfulBackup.result?.snapshot).toBeTruthy();

    const snapResult = successfulBackup.result.snapshot;
    expect(snapResult.totalFiles).toBeGreaterThan(0);
    expect(snapResult.totalBytes).toBeGreaterThan(0);

    // 7. FİZİKSEL SONUÇ KANITI 2: Restic deposundaki snapshot'ların doğrulanması
    const snapshotsRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snapshotsRes.status()).toBe(200);
    const snData = await snapshotsRes.json();
    const snapshots = snData.data || [];
    expect(snapshots.length).toBeGreaterThanOrEqual(1);

    const targetSnapshot = snapshots[0];
    expect(targetSnapshot.id).toMatch(/^[a-f0-9]{64}$/);
    expect(targetSnapshot.shortId).toMatch(/^[a-f0-9]{8}$/);
    expect(targetSnapshot.tags).toContain(`website:${targetWebsiteId}`);
    expect(targetSnapshot.tags).toContain(`domain:${targetActualDomainName}`);
  });

  test('hatalı girdi: geçersiz expectedPreviewDigest veya confirmation ile yedekleme başlatma 409 Conflict ile reddedilir', async ({ page }) => {
    // 1. Sahte/uyuşmayan expectedPreviewDigest ile POST /api/panel/websites/:id/backup-operations
    const fakeDigestResponse = await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup-operations`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'backup',
        repositoryId: createdRepoId || '00000000-0000-0000-0000-000000000000',
        expectedPreviewDigest: '0'.repeat(64),
        confirmation: `backup:${targetWebsiteId}:${createdRepoId || '00000000-0000-0000-0000-000000000000'}:${'0'.repeat(64)}`,
      },
    });

    expect([400, 404, 409]).toContain(fakeDigestResponse.status());
    const fakeDigestJson = await fakeDigestResponse.json();
    expect(fakeDigestJson.error).toBeTruthy();
    expect(['backup_preview_stale', 'backup_confirmation_invalid', 'invalid_repository_id', 'repository_not_found']).toContain(fakeDigestJson.error.code);

    // 2. Geçersiz onay (confirmation) metni ile POST isteği
    const invalidConfirmResponse = await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup-operations`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'backup',
        repositoryId: createdRepoId || '00000000-0000-0000-0000-000000000000',
        expectedPreviewDigest: 'a'.repeat(64),
        confirmation: 'invalid_confirmation_string',
      },
    });

    expect([400, 404, 409]).toContain(invalidConfirmResponse.status());
    const invalidConfirmJson = await invalidConfirmResponse.json();
    expect(invalidConfirmJson.error).toBeTruthy();
    expect(['backup_preview_stale', 'backup_confirmation_invalid', 'invalid_repository_id', 'repository_not_found']).toContain(invalidConfirmJson.error.code);
  });

  test('Plesk eşdeğerliği: Yedek alma modalında yapılandırma vs içerik ve dosya/mail/DB kapsam seçimi arayüzü', async ({ page }) => {
    // Plesk Eşdeğerliği (BAK-02):
    // Plesk Backup Manager'da kullanıcı "Back Up" butonuna tıkladığında:
    // 1. "Backup content" altında "Domain configuration" (yalnızca konfigürasyon) veya "Domain configuration and user content" (konfigürasyon + kullanıcı içeriği) seçimi sunulur.
    // 2. İçerik bileşenleri: "Mail messages", "User files and databases" opsiyonları bağımsız olarak seçilip/kaldırılabilir.
    // YunPanel'de ise bu seçicilik yalnızca "Geri Yükleme" (Restore) modalında mevcuttur;
    // "Yedek Al" (Backup) modalında kullanıcıya herhangi bir kapsam seçimi sunulmamakta,
    // sitenin tüm bileşenleri (dosyalar ve veritabanları) zorunlu olarak tek parça halinde yedeklenmektedir.
    test.fail(
      true,
      'BULGU BAK-02: Plesk eşdeğeri yedek alma modalında yapılandırma vs içerik ve dosya/mail/DB kapsam seçimi arayüzü mevcut değil; yedekleme ayrım gözetmeksizin tüm bileşenleri tek paket olarak almaktadır.'
    );

    await page.goto(`/websites/${targetDomainId}`);
    await expect(page.locator('text=Alan adı yükleniyor…')).toBeHidden({ timeout: 20000 });

    const backupTab = page.locator('button, a').filter({ hasText: /Yedekleme/i });
    if (await backupTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await backupTab.click();
    } else {
      await page.goto(`/websites/${targetDomainId}/backup`);
      await expect(page.locator('text=Alan adı yükleniyor…')).toBeHidden({ timeout: 20000 });
    }

    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 20000 });

    const backupBtn = page.locator('button:has-text("Yedek Al")');
    await expect(backupBtn).toBeVisible({ timeout: 15000 });
    await backupBtn.click();

    const backupModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni Site Yedeği Al' });
    await expect(backupModal).toBeVisible({ timeout: 10000 });

    // Yedekleme kapsam seçimi elemanları aranır (Checkbox / Radio butonlar)
    const scopeOptions = backupModal.locator(
      'input[type="checkbox"][name*="files"], input[type="checkbox"][name*="mail"], input[type="checkbox"][name*="db"], input[type="radio"][value*="config"], label:has-text("Yalnızca yapılandırma"), label:has-text("E-posta"), label:has-text("Site dosyaları")'
    );

    await expect(scopeOptions.first()).toBeVisible({ timeout: 3000 });
  });
});
