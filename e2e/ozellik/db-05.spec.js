import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('DB-05 Veritabanı dump import/export, kopyalama ve backup/restore', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tdb05_a${agentN}_${Date.now().toString(36)}`;
  const testDatabaseName = prefix;
  let savedDomainId = null;
  let savedServerId = null;

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
  });



  test('mutlu yol: veritabanı vendor dump yedeği alma, geri yükleme (restore), fiziksel checksum kanıtı ve phpMyAdmin export köprüsü', async ({ page, context }) => {
    // 1. Ana web sitesi kimliğini (webrich.news) belirle
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    const domainId = mainDomain.id;
    savedDomainId = domainId;
    savedServerId = mainDomain.serverId;

    // 2. Sitenin veritabanları çalışma alanına doğrudan git
    await page.goto(`/websites/${encodeURIComponent(domainId)}/databases`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('h2:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // "Veritabanı oluştur" butonuna tıkla
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    // Dialog açılmalı
    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Veritabanı adını doldur
    const dbNameInput = dialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
    await expect(dbNameInput).toBeVisible({ timeout: 5000 });
    await dbNameInput.fill(testDatabaseName);

    // Formu gönder
    const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // Kurulum sonucunu bekle
    const successMsg = dialog.locator('p:has-text("hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")');
    await expect(successMsg).toBeVisible({ timeout: 60000 });

    // Tamam butonu ile kapat
    const finishBtn = dialog.locator('button:has-text("Tamam")');
    await expect(finishBtn).toBeVisible({ timeout: 5000 });
    await finishBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    // 3. Tabloda oluşturulan veritabanının satırını bul
    const dbRow = page.locator('tr[role="row"]').filter({ hasText: testDatabaseName }).first();
    await expect(dbRow).toBeVisible({ timeout: 20000 });

    // Satırdaki "Yönet" butonuna tıkla
    const manageBtn = dbRow.locator('button:has-text("Yönet")');
    await expect(manageBtn).toBeVisible({ timeout: 10000 });
    await manageBtn.click();

    // Yönet modalı açılmalı
    const manageModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testDatabaseName });
    await expect(manageModal).toBeVisible({ timeout: 10000 });

    // "Yedek al" butonuna tıkla
    const backupBtn = manageModal.locator('button:has-text("Yedek al")');
    await expect(backupBtn).toBeVisible({ timeout: 5000 });
    await backupBtn.click();

    // "Veritabanı yedeği al" onay diyaloğu açılmalı
    const backupConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Veritabanı yedeği al' });
    await expect(backupConfirmDialog).toBeVisible({ timeout: 10000 });

    // Onay inputuna veritabanı adını yaz
    const confirmInput = backupConfirmDialog.locator('input');
    await confirmInput.fill(testDatabaseName);

    const startBackupBtn = backupConfirmDialog.locator('button:has-text("Yedeği başlat")');
    await expect(startBackupBtn).toBeEnabled({ timeout: 5000 });
    await startBackupBtn.click();

    // JobDrawer modalını bekle ve başarıyla tamamlanınca kapat
    const jobModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'İşlem durumu' });
    await expect(jobModal).toBeVisible({ timeout: 20000 });
    await expect(jobModal.locator('p:has-text("Sunucu işlemi başarıyla tamamladı."), .ws-badge:has-text("succeeded")').first()).toBeVisible({ timeout: 60000 });
    const closeJobBtn = jobModal.locator('button:has-text("Kapat"), button:has-text("Pencereyi kapat")').first();
    await closeJobBtn.click();
    await expect(jobModal).toHaveCount(0, { timeout: 10000 });

    // Durum bildirimini doğrula (örn. "... yedeği doğrulandı")
    const backupNotice = page.locator('[role="status"]').filter({ hasText: /yedeği doğrulandı|yedeği başarıyla/i });
    await expect(backupNotice.first()).toBeVisible({ timeout: 30000 });

    // 4. Fiziksel Sonuç Doğrulaması: Backend job kaydından doğrulanmış dump verisini çek
    const jobsRes = await page.request.get('/api/panel/jobs');
    expect(jobsRes.status()).toBe(200);
    const jobsJson = await jobsRes.json();
    const rawJobs = jobsJson.data?.jobs || jobsJson.data || [];
    const backupJob = rawJobs.find((j) => (j.operation === 'database.backup' || j.type === 'database.backup') && j.resourceId === testDatabaseName && j.status === 'succeeded');
    expect(backupJob).toBeTruthy();

    // Fiziksel kanıt 1: backedUp flag true
    expect(backupJob.result?.backedUp).toBe(true);
    // Fiziksel kanıt 2: SHA256 checksum'ı 64 hex karakter
    expect(backupJob.result?.dumpSha256).toMatch(/^[a-f0-9]{64}$/);
    // Fiziksel kanıt 3: dump boyutu pozitif tam sayı
    expect(backupJob.result?.dumpBytes).toBeGreaterThan(0);

    // 5. Geri Yükleme (Restore) ve Checksum Doğrulaması (Sayfa oturumu üzerinden)
    const serverId = mainDomain.serverId;
    const websiteId = mainDomain.websiteId;

    const resourcesRes = await page.request.get(
      `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-resources`
    );
    expect(resourcesRes.status()).toBe(200);
    const resourcesJson = await resourcesRes.json();
    const databases = resourcesJson.data?.databases || [];
    const matched = databases.find((d) => d.binding?.databaseName === testDatabaseName);
    expect(matched).toBeTruthy();
    const bindingId = matched.binding.id;
    const bindingRevision = matched.binding.revision;

    const restoreFlowResult = await page.evaluate(async ({ serverId, websiteId, bindingId, bindingRevision, backupId, expectedBackupSha }) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken;

      const previewRes = await fetch(
        `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/restore-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ backupId, expectedBindingRevision: bindingRevision }),
        }
      );

      if (previewRes.status !== 200) {
        return { ok: false, phase: 'preview', status: previewRes.status, body: await previewRes.json() };
      }
      const previewJson = await previewRes.json();
      const previewData = previewJson.data;

      const applyRes = await fetch(
        `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({
            backupId,
            expectedBindingRevision: bindingRevision,
            expectedPreviewDigest: previewData.previewDigest,
            expectedBackupSha256: expectedBackupSha,
            confirmation: previewData.confirmation,
          }),
        }
      );

      if (applyRes.status !== 202) {
        return { ok: false, phase: 'apply', status: applyRes.status, body: await applyRes.json() };
      }
      const applyJson = await applyRes.json();
      return { ok: true, previewData, job: applyJson.data?.job };
    }, { serverId, websiteId, bindingId, bindingRevision, backupId: backupJob.id, expectedBackupSha: backupJob.result.dumpSha256 });

    expect(restoreFlowResult.ok).toBe(true);
    expect(restoreFlowResult.job?.id).toBeTruthy();

    // Restore job'ının tamamlanmasını bekle
    let completedRestoreJob = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      const pollRes = await page.request.get(`/api/panel/jobs/${encodeURIComponent(restoreFlowResult.job.id)}`);
      if (pollRes.status() === 200) {
        const polled = (await pollRes.json()).data;
        if (polled?.status === 'succeeded') {
          completedRestoreJob = polled;
          break;
        }
      }
    }

    // Fiziksel Kanıt 4: Restore job sonucunun doğrulanması (verified: true, preRestoreDumpSha256)
    expect(completedRestoreJob).toBeTruthy();
    expect(completedRestoreJob.result?.verified).toBe(true);
    expect(completedRestoreJob.result?.preRestoreDumpSha256).toMatch(/^[a-f0-9]{64}$/);

    // 6. phpMyAdmin Export (Döküm Dışa Aktar) Köprüsü Kontrolü
    const exportBtn = dbRow.locator('button:has-text("SQL dışa aktar")');
    await expect(exportBtn).toBeVisible({ timeout: 10000 });
    await exportBtn.click();

    // Sayfa doğrudan phpMyAdmin signon üzerinden export sayfasına yönlenir
    await page.waitForURL(/\/tools\/phpmyadmin\/index\.php/, { timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');

    // Fiziksel kanıt 5: phpMyAdmin URL'si export route'unu ve db parametresini içerir
    expect(decodeURIComponent(page.url())).toContain('route=/database/export');
    expect(decodeURIComponent(page.url())).toContain(`db=${testDatabaseName}`);
    await expect(page).toHaveTitle(/phpMyAdmin/i, { timeout: 15000 });
  });

  test('hatalı girdi: yanlış onay metni ile yedekleme/restore engellenir ve sahte checksum ile restore reddedilir', async ({ page }) => {
    // 1. Arayüz Koruması: Web sitesi veritabanları sayfasında yedek diyalogunda yanlış onay metni
    if (savedDomainId) {
      await page.goto(`/websites/${encodeURIComponent(savedDomainId)}/databases`);
      await expect(page.locator('h2:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

      const dbRow = page.locator('tr[role="row"]').filter({ hasText: testDatabaseName }).first();
      if (await dbRow.isVisible({ timeout: 5000 }).catch(() => false)) {
        await dbRow.locator('button:has-text("Yönet")').click();
        const manageModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testDatabaseName });
        await expect(manageModal).toBeVisible({ timeout: 5000 });

        await manageModal.locator('button:has-text("Yedek al")').click();
        const backupConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Veritabanı yedeği al' });
        await expect(backupConfirmDialog).toBeVisible({ timeout: 5000 });

        // Yanlış onay metni gir
        await backupConfirmDialog.locator('input').fill('yanlis_onay_metni_123');
        const startBackupBtn = backupConfirmDialog.locator('button:has-text("Yedeği başlat")');

        // Buton disabled kalmalı
        await expect(startBackupBtn).toBeDisabled();

        // İptal et ve kapat
        await backupConfirmDialog.locator('button:has-text("Vazgeç")').click();
        await expect(backupConfirmDialog).toHaveCount(0, { timeout: 5000 });
      }
    }

    // 2. API Koruması: Sahte/bozuk previewDigest ve beklenen SHA256 ile restore denemesi fail-closed döner
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const serverId = savedServerId || 'local';

    const failClosedCheck = await page.evaluate(async ({ serverId, testDatabaseName }) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken;

      const res = await fetch(
        `/api/panel/servers/${encodeURIComponent(serverId)}/databases/${encodeURIComponent(testDatabaseName)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({
            backupId: 'non-existent-backup-id',
            expectedPreviewDigest: '0'.repeat(64),
            expectedBackupSha256: 'f'.repeat(64),
            confirmation: `restore-database:${testDatabaseName}:malicious`,
          }),
        }
      );
      return { status: res.status, body: await res.json() };
    }, { serverId, testDatabaseName });

    // Backend isteği kabul etmeyip 400/404/409 hatası döndürmelidir
    expect([400, 404, 409]).toContain(failClosedCheck.status);
    expect(failClosedCheck.body.error).toBeTruthy();
  });
});
