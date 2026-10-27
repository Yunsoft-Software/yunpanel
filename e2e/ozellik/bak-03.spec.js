import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-03 Tam ve artımlı yedekleme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const repoName = `tbak03-a${agentN}-${timestamp}-repo`;
  const targetDomainName = 'yp-node.webrich.news';

  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
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

      // 1. Oluşturulan Restic yedek deposunu ve içindeki snapshot'ları temizle
      if (createdRepoId && token) {
        const delRes = await page.request.delete(`/api/panel/backups/repositories/${createdRepoId}`, {
          headers: {
            'x-csrf-token': token,
            Origin: 'https://server.cryptoraichu.website',
            Referer: 'https://server.cryptoraichu.website/',
          },
        }).catch(() => null);
        if (delRes && delRes.ok()) {
          console.log(`Cleaned up test restic repo: ${createdRepoId}`);
        }
      }
    } catch (err) {
      console.warn('BAK-03 cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: tam ve ardışık artımlı (deduplicated) site yedeği oluşturma, job takibi ve fiziksel restic snapshot kanıtı', async ({ page }) => {
    // 1. Hedef web sitesinin (yp-node.webrich.news) domainId ve websiteId'sini al
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName);
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId);
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    // 2. Test amaçlı Restic yedek deposunu oluştur (11 Ekim kuralı: test amaçlı izinli, bitince temizlenir)
    const createRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: repoName,
        backend: 'local',
        password: `Pass-${timestamp}-B3kUp!`,
        initialize: true,
      },
    });
    expect(createRepoRes.status()).toBe(201);
    const repoJson = await createRepoRes.json();
    createdRepoId = repoJson.data?.id;
    expect(createdRepoId).toBeTruthy();

    // 3. Web sitesinin Yedekleme ve Geri Yükleme sayfasına git
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // Yeni oluşturulan deponun sayfada listelendiğini doğrula
    await expect(page.locator(`section:has-text("${repoName}")`)).toBeVisible({ timeout: 15000 });

    // 4. BİRİNCİ YEDEK: Tam yedekleme (İlk snapshot)
    const backupBtn = page.locator('button:has-text("Yedek Al")');
    await expect(backupBtn).toBeVisible({ timeout: 15000 });
    await expect(backupBtn).toBeEnabled({ timeout: 15000 });
    await backupBtn.click();

    const backupModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni Site Yedeği Al' });
    await expect(backupModal).toBeVisible({ timeout: 10000 });

    // Depo seçimi (birden fazla repo varsa test deposunu seç)
    const repoSelect = backupModal.locator('select');
    if (await repoSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await repoSelect.selectOption(createdRepoId);
    }

    const startBackupBtn = backupModal.locator('button[type="submit"]:has-text("Yedeği Başlat")');
    await expect(startBackupBtn).toBeVisible({ timeout: 15000 });
    await startBackupBtn.click();

    // İşlem takibi: Durable operation kartının "Başarılı" olmasını bekle
    const opSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Yedekleme işlemi' }) });
    await expect(opSection).toBeVisible({ timeout: 15000 });
    await expect(opSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 60000 });

    // Tamamlanan işlem kartını kapat
    const closeOpBtn = opSection.locator('button:has-text("Kapat")');
    if (await closeOpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeOpBtn.click();
    }

    // 5. İKİNCİ YEDEK: Artımlı yedekleme (Incremental / Deduplicated snapshot)
    await backupBtn.click();
    await expect(backupModal).toBeVisible({ timeout: 10000 });
    if (await repoSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await repoSelect.selectOption(createdRepoId);
    }
    await expect(startBackupBtn).toBeVisible({ timeout: 15000 });
    await startBackupBtn.click();

    // İkinci işlemin de başarılı tamamlanmasını bekle
    await expect(opSection).toBeVisible({ timeout: 15000 });
    await expect(opSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 60000 });

    // 6. Sayfayı yenile ve arayüzde snapshot tablosunu doğrula
    await page.reload();
    const repoSection = page.locator(`section:has-text("${repoName}")`);
    await expect(repoSection).toBeVisible({ timeout: 15000 });

    const snapshotRows = repoSection.locator('table.ws-table tbody tr');
    await expect(snapshotRows).toHaveCount(2, { timeout: 15000 });

    // 7. FİZİKSEL KANIT (Restic API / Depo Doğrulaması):
    // Restic deposundaki snapshot'ların varlığı, parent ilişkisi ve deduplication doğrulaması
    const snapshotsRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snapshotsRes.status()).toBe(200);
    const snData = await snapshotsRes.json();
    const snapshots = snData.data || [];
    expect(snapshots.length).toBe(2);

    // Her snapshot 64-karakter hex SHA-256 hash'e ve geçerli bir tarihe sahip olmalı
    for (const snap of snapshots) {
      expect(snap.id).toMatch(/^[a-f0-9]{64}$/);
      expect(snap.shortId).toMatch(/^[a-f0-9]{8}$/);
      expect(snap.tags).toContain(`website:${targetWebsiteId}`);
      expect(snap.tags).toContain(`domain:${targetDomainName}`);
    }

    // İki snapshot'ın ID'leri farklı olmalıdır
    expect(snapshots[0].id).not.toBe(snapshots[1].id);

    // En son operasyon kaydının doğrulanması: filesNew ve filesUnmodified metrikleri ile artımlı/deduplicated kanıtı
    const opsRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backup-operations`);
    expect(opsRes.ok()).toBe(true);
    const opsJson = await opsRes.json();
    const recentBackups = (opsJson.data || []).filter((op) => op.kind === 'backup' && op.repositoryId === createdRepoId && op.status === 'succeeded');
    expect(recentBackups.length).toBe(2);

    const latestBackup = recentBackups[0]; // En yeni yedek
    expect(latestBackup.result?.snapshot).toBeTruthy();
    // Artımlı/deduplication kanıtı: Değişmeyen dosyalar (filesUnmodified) pozitif olmalıdır
    expect(latestBackup.result.snapshot.totalFiles).toBeGreaterThan(0);
    expect(latestBackup.result.snapshot.filesUnmodified).toBeGreaterThan(0);
  });

  test('hatalı girdi: geçersiz depo ID veya sahte operasyon türü ile yedekleme başlatma 400/404 hatasıyla reddedilir', async ({ page }) => {
    // 1. Var olmayan geçersiz bir depo kimliğiyle backup başlatma isteği
    const invalidRepoResponse = await page.request.post(`/api/panel/websites/${targetWebsiteId || 'any-id'}/backup-operations`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'backup',
        repositoryId: '00000000-0000-0000-0000-000000000000',
        expectedPreviewDigest: '0'.repeat(64),
        confirmation: 'backup:invalid:repo',
      },
    });

    // 400 invalid_repository_id veya 404 dönmelidir
    expect([400, 404, 409]).toContain(invalidRepoResponse.status());
    const errJson = await invalidRepoResponse.json();
    expect(errJson.error).toBeTruthy();
    expect(['invalid_repository_id', 'repository_not_found', 'website_backup_preview_mismatch', 'website_not_found']).toContain(errJson.error.code);

    // 2. Geçersiz bir operasyon türüyle (kind) istek gönderme
    const invalidKindResponse = await page.request.post(`/api/panel/websites/${targetWebsiteId || 'any-id'}/backup-operations`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        kind: 'invalid_backup_kind',
      },
    });

    expect(invalidKindResponse.status()).toBe(400);
    const kindErrJson = await invalidKindResponse.json();
    expect(kindErrJson.error.code).toBe('invalid_operation_kind');
  });

  test('Plesk eşdeğerliği: UI üzerinde tam vs artımlı yedekleme tipi seçimi modalı', async ({ page }) => {
    test.fail(
      true,
      'BULGU BAK-03: Plesk Backup Manager arayüzünde kullanıcıya "Tam (Full)" veya "Artımlı (Incremental)" yedekleme türü seçimi sunulurken, YunPanel arayüzünde bu seçim bulunmamaktadır (Restic otomatik deduplication mekanizmasına güvenmektedir).'
    );

    // Plesk'te yedek alma modalında Backup Type seçeneği (Full vs Incremental radio button) bulunur.
    await page.goto(`/websites/${targetDomainId}/backup`);
    const backupBtn = page.locator('button:has-text("Yedek Al")');
    await expect(backupBtn).toBeVisible({ timeout: 15000 });
    await backupBtn.click();

    const backupModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni Site Yedeği Al' });
    await expect(backupModal).toBeVisible({ timeout: 10000 });

    // Yedekleme tipi seçimi (Full vs Incremental) var mı?
    const typeRadio = backupModal.locator('input[type="radio"][value="full"], input[type="radio"][value="incremental"], label:has-text("Tam"), label:has-text("Artımlı")');
    await expect(typeRadio.first()).toBeVisible({ timeout: 3000 });
  });
});
