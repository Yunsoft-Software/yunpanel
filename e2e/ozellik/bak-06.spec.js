import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-06 Seçici geri yükleme, indir/yükle ve parola koruması', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const timestamp = Date.now().toString(36);
  const repoName = `tbak06-a${agentN}-${timestamp}-repo`;
  const targetDomainName = 'yp-node.webrich.news';

  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
  let firstSnapshotId = null;
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

      // Oluşturulan test Restic yedek deposunu ve ilişkili snapshot'ları temizle
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
      console.warn('BAK-06 cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: parola korumalı repo oluşturma, UI üzerinden seçici geri yükleme başlatma, progress takibi ve fiziksel restore kanıtı', async ({ page, request }) => {
    // 1. Hedef web sitesinin (yp-node.webrich.news) websiteId ve domainId bilgilerini al
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

    // 2. Parola korumalı Restic yedek deposunu oluştur (AES-256 şifreli repo)
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
    const repoSection = page.locator(`section:has-text("${repoName}")`);
    await expect(repoSection).toBeVisible({ timeout: 15000 });

    // 4. Test için ilk yedeği (snapshot) al
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

    // Operasyon kartını kapat
    const closeBackupOpBtn = backupOpSection.locator('button:has-text("Kapat")');
    if (await closeBackupOpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBackupOpBtn.click();
    }

    // 5. Sayfayı yenile ve snapshot'ın listelendiğini doğrula
    await page.reload();
    await expect(repoSection).toBeVisible({ timeout: 15000 });

    const snapshotRows = repoSection.locator('table.ws-table tbody tr');
    await expect(snapshotRows).toHaveCount(1, { timeout: 15000 });

    // Snapshot ID'sini al
    const snRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snRes.ok()).toBe(true);
    const snData = await snRes.json();
    expect(snData.data?.length).toBeGreaterThan(0);
    firstSnapshotId = snData.data[0].id;

    // 6. UI ÜZERİNDEN SEÇİCİ GERİ YÜKLEME (Selective Restore)
    const restoreBtn = snapshotRows.first().locator('button:has-text("Geri Yükle")');
    await expect(restoreBtn).toBeVisible({ timeout: 10000 });
    await restoreBtn.click();

    // Geri yükleme modalı açıldı
    const restoreModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedeği geri yükle' });
    await expect(restoreModal).toBeVisible({ timeout: 10000 });

    // "Seçici Geri Yükleme (Kapsamı Özelleştir)" onay kutusunu işaretle
    const selectiveCheckbox = restoreModal.locator('label:has-text("Seçici Geri Yükleme") input[type="checkbox"]');
    await expect(selectiveCheckbox).toBeVisible({ timeout: 10000 });
    await selectiveCheckbox.check();

    // Alt seçim kutularının (Site dosyaları vb.) görünür olduğunu doğrula
    const filesCheckbox = restoreModal.locator('label:has-text("Site dosyaları") input[type="checkbox"]');
    await expect(filesCheckbox).toBeVisible({ timeout: 5000 });
    expect(await filesCheckbox.isChecked()).toBe(true);

    // DNS kayıtları, barındırma ayarları ve ortam kutularını kapatıp yalnızca "Site dosyaları" seç
    const dnsCheckbox = restoreModal.locator('label:has-text("DNS kayıtları") input[type="checkbox"]');
    if (await dnsCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (await dnsCheckbox.isChecked()) await dnsCheckbox.uncheck();
    }

    const hostingCheckbox = restoreModal.locator('label:has-text("Barındırma ayarları") input[type="checkbox"]');
    if (await hostingCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (await hostingCheckbox.isChecked()) await hostingCheckbox.uncheck();
    }

    const envCheckbox = restoreModal.locator('label:has-text("Uygulama ortamı") input[type="checkbox"]');
    if (await envCheckbox.isVisible({ timeout: 2000 }).catch(() => false)) {
      if (await envCheckbox.isChecked()) await envCheckbox.uncheck();
    }

    // Önizlemenin ve onay kutusunun yüklenmesini bekle (DNS kapatılınca preview başarılı üretilir)
    const confirmInput = restoreModal.locator('form label input');
    await expect(confirmInput).toBeVisible({ timeout: 15000 });

    // Onay metnini form içindeki strong etiketinden al ve doldur
    const confirmationText = await restoreModal.locator('form label strong').textContent();
    expect(confirmationText).toBeTruthy();
    await confirmInput.fill(confirmationText.trim());

    // "Seçici Geri Yüklemeyi Başlat" butonuna tıkla
    const startRestoreBtn = restoreModal.locator('button[type="submit"]:has-text("Seçici Geri Yüklemeyi Başlat")');
    await expect(startRestoreBtn).toBeVisible({ timeout: 5000 });
    await expect(startRestoreBtn).toBeEnabled({ timeout: 5000 });
    await startRestoreBtn.click();

    // 7. GERİ YÜKLEME İŞLEMİNİ TAKİP ET
    const restoreOpSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Geri yükleme işlemi' }) });
    await expect(restoreOpSection).toBeVisible({ timeout: 15000 });
    await expect(restoreOpSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 90000 });

    // 8. FİZİKSEL KANIT 1: Operation kaydında `selective: true` ve seçilen dosyalar (`include`)
    const opsRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backup-operations`);
    expect(opsRes.ok()).toBe(true);
    const opsJson = await opsRes.json();
    const restoreOps = (opsJson.data || []).filter((op) => op.kind === 'restore' && op.repositoryId === createdRepoId && op.status === 'succeeded');
    expect(restoreOps.length).toBeGreaterThan(0);

    const latestRestore = restoreOps[0];
    expect(latestRestore.result?.selective).toBe(true);
    expect(Array.isArray(latestRestore.result?.include)).toBe(true);
    expect(latestRestore.result.include.length).toBeGreaterThan(0);
    // Seçilen yol site uygulama dizinini içermeli
    expect(latestRestore.result.include.some((p) => p.includes(targetWebsiteId) || p.includes('apps') || p.includes('data'))).toBe(true);

    // 9. FİZİKSEL KANIT 2: Geri yükleme öncesinde otomatik güvenlik snapshot'ı (pre-restore) alınmış olmalı
    const snAfterRestoreRes = await page.request.get(`/api/panel/backups/repositories/${createdRepoId}/snapshots`);
    expect(snAfterRestoreRes.ok()).toBe(true);
    const snAfterRestoreJson = await snAfterRestoreRes.json();
    const preRestoreSnap = (snAfterRestoreJson.data || []).find((s) => (s.tags || []).includes('pre-restore') || s.kind === 'pre_restore');
    expect(preRestoreSnap).toBeTruthy();

    // 10. FİZİKSEL KANIT 3: Web sitesi geri yükleme sonrası canlı ve HTTP 200 dönüyor
    const siteHealthRes = await request.get(`https://${targetDomainName}/`);
    expect(siteHealthRes.status()).toBe(200);
  });

  test('hatalı girdi: parolasız repo oluşturma ve seçici geri yüklemede tüm kapsamın kaldırılması reddedilir', async ({ page }) => {
    // 1. Parola koruması kuralı: Parolasız / boş parola ile depo oluşturma 400 hatasıyla reddedilir
    const invalidRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: `tbak06-nopass-${timestamp}`,
        backend: 'local',
        password: '',
        initialize: true,
      },
    });
    expect(invalidRepoRes.status()).toBe(400);
    const errJson = await invalidRepoRes.json();
    expect(['restic_password_required', 'restic_password_invalid']).toContain(errJson.error?.code);

    // 2. UI seçici geri yükleme doğrulama: Tüm veri türlerinin işareti kaldırıldığında hata uyarısı verilir
    await page.goto(`/websites/${targetDomainId}/backup`);
    const repoSection = page.locator(`section:has-text("${repoName}")`);
    await expect(repoSection).toBeVisible({ timeout: 15000 });

    const snapshotRows = repoSection.locator('table.ws-table tbody tr');
    const restoreBtn = snapshotRows.first().locator('button:has-text("Geri Yükle")');
    await restoreBtn.click();

    const restoreModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedeği geri yükle' });
    await expect(restoreModal).toBeVisible({ timeout: 10000 });

    // Seçici geri yüklemeyi aktif et
    const selectiveCheckbox = restoreModal.locator('label:has-text("Seçici Geri Yükleme") input[type="checkbox"]');
    await selectiveCheckbox.check();

    // Sırasıyla kutuları kaldırıp her adımda yüklenmenin tamamlanmasını bekle
    const uncheckItem = async (label) => {
      const cb = restoreModal.locator(`label:has-text("${label}") input[type="checkbox"]`);
      if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(cb).toBeEnabled({ timeout: 10000 });
        if (await cb.isChecked()) {
          await cb.uncheck();
          await expect(restoreModal.locator('p[role="status"]')).toBeHidden({ timeout: 10000 }).catch(() => {});
        }
      }
    };

    await uncheckItem('DNS kayıtları');
    await uncheckItem('Barındırma ayarları');
    await uncheckItem('Uygulama ortamı');
    await uncheckItem('Site dosyaları');

    // UI'da hata mesajı görünmeli ve onay formu engellenmeli (boş seçimle restore engellendi)
    const errorNotice = restoreModal.locator('.ws-error, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 5000 });
    await expect(restoreModal.locator('button[type="submit"]:has-text("Geri Yüklemeyi Başlat")')).toBeHidden();

    // Modalı kapat
    const cancelBtn = restoreModal.locator('button:has-text("Vazgeç"), button[aria-label="Pencereyi kapat"]');
    await cancelBtn.first().click();

    // 3. API seviyesinde güvenlik: Path traversal içeren zararlı restore seçimi reddedilir
    const traversalRestoreRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/restore/preview`, {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        repositoryId: createdRepoId,
        snapshotId: firstSnapshotId,
        include: ['/var/lib/yunpanel/apps/../etc/passwd', '*'],
      },
    });
    expect(traversalRestoreRes.status()).toBeGreaterThanOrEqual(400);
  });

  test('Plesk eşdeğerliği: UI üzerinde yedek arşivi indir/yükle (download/upload) butonu', async ({ page }) => {
    test.fail(true, 'Plesk eşdeğerliği: UI üzerinde yedek arşivi indir/yükle (download/upload) özelliği eksik');

    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // Plesk Backup Manager'da yer alan yedek arşivini (.tar/.zip) indirme veya bilgisayardan yükleme butonu
    const downloadOrUploadBtn = page.locator('main').locator('button, a').filter({ hasText: /^Yedek İndir$|^Yedek Yükle$|^Arşiv İndir$|^Dosyadan Yükle$/ });
    await expect(downloadOrUploadBtn.first()).toBeVisible({ timeout: 3000 });
  });
});
