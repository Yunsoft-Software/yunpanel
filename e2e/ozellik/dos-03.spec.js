import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function runSsh(command) {
  try {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 20000,
    }).trim();
  } catch (err) {
    console.warn(`SSH command failed: ${command} -> ${err.message}`);
    return '';
  }
}

test.describe('DOS-03 Dosya/klasör oluşturma, yeniden adlandırma ve silme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const testFileInitial = `tdos03-a${agentN}-f-${timestamp}.txt`;
  const testFileRenamed = `tdos03-a${agentN}-renamed-f-${timestamp}.txt`;
  const testFolderInitial = `tdos03-a${agentN}-d-${timestamp}`;
  const testFolderRenamed = `tdos03-a${agentN}-renamed-d-${timestamp}`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;

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

  test.afterAll(async ({ browser }) => {
    // 1. API üzerinden güvenli temizlik
    if (resolvedWebsiteId) {
      const itemsToClean = [testFileInitial, testFileRenamed, testFolderInitial, testFolderRenamed];
      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD).catch(() => {});
        const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
        const sessionData = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
        const csrf = sessionData?.data?.csrfToken || sessionData?.csrfToken || '';
        const origin = 'https://server.cryptoraichu.website';
        const headers = {
          Origin: origin,
          'x-csrf-token': csrf,
        };

        for (const item of itemsToClean) {
          await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
            headers,
            data: {
              path: item,
              confirmation: `delete:${resolvedWebsiteId}:${item}`,
            },
          }).catch(() => {});
        }
        await context.close().catch(() => {});
      } catch {}
    }

    // 2. SSH ile geride kalan geçici test kalıntılarını temizle (mevcut site verilerine asla dokunulmaz)
    try {
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name 'tdos03-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: dosya ve klasör oluşturma, yeniden adlandırma, silme ve fiziksel SSH doğrulaması', async ({ page }) => {
    // 1. Global Files rotasına git ve ilk site dosya yöneticisine bağlan
    await page.goto('/files');
    await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });

    const filesTable = page.locator('table.ws-table');
    await expect(filesTable).toBeVisible({ timeout: 15000 });

    const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
    await expect(fileManagerLinks.first()).toBeVisible({ timeout: 15000 });

    const firstHref = await fileManagerLinks.first().getAttribute('href');
    expect(firstHref).toBeTruthy();
    const domainMatch = firstHref.match(/\/websites\/([^/?#]+)\/files/);
    expect(domainMatch).toBeTruthy();
    resolvedDomainId = domainMatch[1];

    await fileManagerLinks.first().click();
    await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });

    // Dosya yöneticisi arayüzünün hazır olduğunu doğrula
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    const filesListTable = page.locator('table.yf-table[aria-label="Site dosyaları"]');
    await expect(filesListTable).toBeVisible({ timeout: 15000 });

    // ==========================================
    // ADIM A: DOSYA OLUŞTURMA
    // ==========================================
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createFileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createFileModal).toBeVisible({ timeout: 10000 });

    const fileNameInput = createFileModal.locator('input');
    await fileNameInput.fill(testFileInitial);
    const createFileInputSubmit = createFileModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createFileInputSubmit).toBeEnabled();
    await createFileInputSubmit.click();

    // Modal kapanmalı ve dosya listede belirmeli
    await expect(createFileModal).toHaveCount(0, { timeout: 15000 });
    const createdFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileInitial}"))`);
    await expect(createdFileRow).toBeVisible({ timeout: 15000 });

    // Sitenin websiteId'sini indir bağlantısından çöz
    const anyDownloadLink = page.locator('table.yf-table a[download]').first();
    if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const dHref = await anyDownloadLink.getAttribute('href');
      const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // FİZİKSEL SONUÇ (SSH): Dosya sunucuda gerçekten oluştu mu?
    const sshInitialFilePath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFileInitial}'`);
    expect(sshInitialFilePath).toBeTruthy();
    expect(sshInitialFilePath).toContain(testFileInitial);
    const sshInitialFileCheck = runSsh(`test -f "${sshInitialFilePath}" && echo FILE_EXISTS`);
    expect(sshInitialFileCheck).toBe('FILE_EXISTS');

    // ==========================================
    // ADIM B: KLASÖR OLUŞTURMA
    // ==========================================
    await page.locator('button:has-text("Yeni Klasör")').click();
    const createFolderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(createFolderModal).toBeVisible({ timeout: 10000 });

    const folderNameInput = createFolderModal.locator('input');
    await folderNameInput.fill(testFolderInitial);
    const createFolderInputSubmit = createFolderModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createFolderInputSubmit).toBeEnabled();
    await createFolderInputSubmit.click();

    // Modal kapanmalı ve klasör listede belirmeli
    await expect(createFolderModal).toHaveCount(0, { timeout: 15000 });
    const createdFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFolderInitial}"))`);
    await expect(createdFolderRow).toBeVisible({ timeout: 15000 });

    // FİZİKSEL SONUÇ (SSH): Klasör sunucuda gerçekten oluştu mu?
    const sshInitialDirPath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFolderInitial}' -type d`);
    expect(sshInitialDirPath).toBeTruthy();
    expect(sshInitialDirPath).toContain(testFolderInitial);
    const sshInitialDirCheck = runSsh(`test -d "${sshInitialDirPath}" && echo DIR_EXISTS`);
    expect(sshInitialDirCheck).toBe('DIR_EXISTS');

    // ==========================================
    // ADIM C: DOSYA YENİDEN ADLANDIRMA
    // ==========================================
    const fileActionBtn = createdFileRow.locator('button[aria-label*="işlemleri"], button[title="Dosya işlemleri"]');
    await fileActionBtn.click();

    const fileDetailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFileInitial });
    await expect(fileDetailsModal).toBeVisible({ timeout: 10000 });

    const fileRenameBtn = fileDetailsModal.locator('button:has-text("Yeniden adlandır")');
    await expect(fileRenameBtn).toBeVisible({ timeout: 10000 });
    await fileRenameBtn.click();

    const fileRenameModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeniden adlandır' });
    await expect(fileRenameModal).toBeVisible({ timeout: 10000 });

    const fileRenameInput = fileRenameModal.locator('input');
    await fileRenameInput.fill(testFileRenamed);
    const fileRenameSubmit = fileRenameModal.locator('button[type="submit"]:has-text("Adı değiştir")');
    await expect(fileRenameSubmit).toBeEnabled();
    await fileRenameSubmit.click();

    // Modal kapanmalı, eski dosya listeden kalkmalı ve yeni isim görünmeli
    await expect(fileRenameModal).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileInitial}"))`)).toHaveCount(0, { timeout: 10000 });
    const renamedFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileRenamed}"))`);
    await expect(renamedFileRow).toBeVisible({ timeout: 15000 });

    // FİZİKSEL SONUÇ (SSH): Eski ad kalktı, yeni ad sunucuda mevcut mu?
    const sshOldFileAfterRename = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFileInitial}'`);
    expect(sshOldFileAfterRename).toBe('');
    const sshNewFilePath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFileRenamed}'`);
    expect(sshNewFilePath).toBeTruthy();
    expect(sshNewFilePath).toContain(testFileRenamed);
    const sshNewFileCheck = runSsh(`test -f "${sshNewFilePath}" && echo RENAMED_FILE_EXISTS`);
    expect(sshNewFileCheck).toBe('RENAMED_FILE_EXISTS');

    // ==========================================
    // ADIM D: KLASÖR YENİDEN ADLANDIRMA
    // ==========================================
    const folderActionBtn = createdFolderRow.locator('button[aria-label*="işlemleri"], button[title="Dosya işlemleri"]');
    await folderActionBtn.click();

    const folderDetailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFolderInitial });
    await expect(folderDetailsModal).toBeVisible({ timeout: 10000 });

    const folderRenameBtn = folderDetailsModal.locator('button:has-text("Yeniden adlandır")');
    await expect(folderRenameBtn).toBeVisible({ timeout: 10000 });
    await folderRenameBtn.click();

    const folderRenameModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeniden adlandır' });
    await expect(folderRenameModal).toBeVisible({ timeout: 10000 });

    const folderRenameInput = folderRenameModal.locator('input');
    await folderRenameInput.fill(testFolderRenamed);
    const folderRenameSubmit = folderRenameModal.locator('button[type="submit"]:has-text("Adı değiştir")');
    await expect(folderRenameSubmit).toBeEnabled();
    await folderRenameSubmit.click();

    // Modal kapanmalı, eski klasör listeden kalkmalı ve yeni isim görünmeli
    await expect(folderRenameModal).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFolderInitial}"))`)).toHaveCount(0, { timeout: 10000 });
    const renamedFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFolderRenamed}"))`);
    await expect(renamedFolderRow).toBeVisible({ timeout: 15000 });

    // FİZİKSEL SONUÇ (SSH): Eski klasör adı yok, yeni klasör adı sunucuda mevcut mu?
    const sshOldDirAfterRename = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFolderInitial}' -type d`);
    expect(sshOldDirAfterRename).toBe('');
    const sshNewDirPath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFolderRenamed}' -type d`);
    expect(sshNewDirPath).toBeTruthy();
    expect(sshNewDirPath).toContain(testFolderRenamed);
    const sshNewDirCheck = runSsh(`test -d "${sshNewDirPath}" && echo RENAMED_DIR_EXISTS`);
    expect(sshNewDirCheck).toBe('RENAMED_DIR_EXISTS');

    // ==========================================
    // ADIM E: DOSYA SİLME
    // ==========================================
    const deleteFileBtn = renamedFileRow.locator('button[aria-label*="işlemleri"], button[title="Dosya işlemleri"]');
    await deleteFileBtn.click();

    const deleteFileDetailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFileRenamed });
    await expect(deleteFileDetailsModal).toBeVisible({ timeout: 10000 });

    const confirmFileDeleteTrigger = deleteFileDetailsModal.locator('button:has-text("Sil…")');
    await expect(confirmFileDeleteTrigger).toBeVisible({ timeout: 10000 });
    await confirmFileDeleteTrigger.click();

    const deleteFileConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'silinsin mi?' });
    await expect(deleteFileConfirmDialog).toBeVisible({ timeout: 10000 });

    const fileConfirmInput = deleteFileConfirmDialog.locator('input');
    await fileConfirmInput.fill(testFileRenamed);
    const fileConfirmDeleteBtn = deleteFileConfirmDialog.locator('button[type="submit"]:has-text("Kalıcı olarak sil")');
    await expect(fileConfirmDeleteBtn).toBeEnabled();
    await fileConfirmDeleteBtn.click();

    // Modal kapanmalı ve dosya listeden silinmeli
    await expect(deleteFileConfirmDialog).toHaveCount(0, { timeout: 15000 });
    await expect(renamedFileRow).toHaveCount(0, { timeout: 15000 });

    // FİZİKSEL SONUÇ (SSH): Dosya sunucudan tamamen silindi mi?
    const sshDeletedFileCheck = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFileRenamed}'`);
    expect(sshDeletedFileCheck).toBe('');

    // ==========================================
    // ADIM F: KLASÖR SİLME
    // ==========================================
    const deleteFolderBtn = renamedFolderRow.locator('button[aria-label*="işlemleri"], button[title="Dosya işlemleri"]');
    await deleteFolderBtn.click();

    const deleteFolderDetailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFolderRenamed });
    await expect(deleteFolderDetailsModal).toBeVisible({ timeout: 10000 });

    const confirmFolderDeleteTrigger = deleteFolderDetailsModal.locator('button:has-text("Sil…")');
    await expect(confirmFolderDeleteTrigger).toBeVisible({ timeout: 10000 });
    await confirmFolderDeleteTrigger.click();

    const deleteFolderConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'silinsin mi?' });
    await expect(deleteFolderConfirmDialog).toBeVisible({ timeout: 10000 });

    const folderConfirmInput = deleteFolderConfirmDialog.locator('input');
    await folderConfirmInput.fill(testFolderRenamed);
    const folderConfirmDeleteBtn = deleteFolderConfirmDialog.locator('button[type="submit"]:has-text("Kalıcı olarak sil")');
    await expect(folderConfirmDeleteBtn).toBeEnabled();
    await folderConfirmDeleteBtn.click();

    // Modal kapanmalı ve klasör listeden silinmeli
    await expect(deleteFolderConfirmDialog).toHaveCount(0, { timeout: 15000 });
    await expect(renamedFolderRow).toHaveCount(0, { timeout: 15000 });

    // FİZİKSEL SONUÇ (SSH): Klasör sunucudan tamamen silindi mi?
    const sshDeletedDirCheck = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFolderRenamed}' -type d`);
    expect(sshDeletedDirCheck).toBe('');
  });

  test('hatalı girdi: geçersiz dosya adı, ayrılmış isimler ve path traversal denemeleri engellenir', async ({ page }) => {
    // 1. Dosya Yöneticisine git
    if (!resolvedDomainId) {
      await page.goto('/files');
      const filesTable = page.locator('table.ws-table');
      await expect(filesTable).toBeVisible({ timeout: 15000 });
      const firstLink = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")').first();
      await expect(firstLink).toBeVisible({ timeout: 15000 });
      const href = await firstLink.getAttribute('href');
      resolvedDomainId = href.match(/\/websites\/([^/?#]+)\/files/)[1];
    }

    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]')).toBeVisible({ timeout: 15000 });

    // 2. Yeni Dosya modalında doğrulama testleri
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createModal).toBeVisible({ timeout: 10000 });

    const nameInput = createModal.locator('input');
    const submitBtn = createModal.locator('button[type="submit"]:has-text("Oluştur")');

    // A: Boş isim girildiğinde buton disabled kalmalı
    await nameInput.fill('');
    expect(await submitBtn.isDisabled()).toBe(true);

    // B: Slash / Path traversal içeren isim girildiğinde buton disabled kalmalı
    await nameInput.fill('../traversal.txt');
    expect(await submitBtn.isDisabled()).toBe(true);

    // C: Ters slash içeren isim girildiğinde buton disabled kalmalı
    await nameInput.fill('sub\\badfile.txt');
    expect(await submitBtn.isDisabled()).toBe(true);

    // D: Ayrılmış isimler (. veya ..) girildiğinde buton disabled kalmalı
    await nameInput.fill('.');
    expect(await submitBtn.isDisabled()).toBe(true);
    await nameInput.fill('..');
    expect(await submitBtn.isDisabled()).toBe(true);

    // Modalı kapat
    await createModal.locator('button:has-text("Vazgeç")').click();
    await expect(createModal).toHaveCount(0, { timeout: 10000 });

    // 3. Yeni Klasör modalında doğrulama testleri
    await page.locator('button:has-text("Yeni Klasör")').click();
    const createFolderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(createFolderModal).toBeVisible({ timeout: 10000 });

    const folderInput = createFolderModal.locator('input');
    const folderSubmitBtn = createFolderModal.locator('button[type="submit"]:has-text("Oluştur")');

    await folderInput.fill('');
    expect(await folderSubmitBtn.isDisabled()).toBe(true);

    await folderInput.fill('../../forbidden');
    expect(await folderSubmitBtn.isDisabled()).toBe(true);

    await createFolderModal.locator('button:has-text("Vazgeç")').click();
    await expect(createFolderModal).toHaveCount(0, { timeout: 10000 });

    // 4. Backend API seviyesinde doğrudan yetkisiz/geçersiz oluşturma denemeleri (Fail-closed & 400 Bad Request)
    if (!resolvedWebsiteId) {
      const anyDownloadLink = page.locator('table.yf-table a[download]').first();
      if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const dHref = await anyDownloadLink.getAttribute('href');
        const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
        if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
      }
    }

    if (resolvedWebsiteId) {
      // CSRF token ve Origin ayarları
      const origin = 'https://server.cryptoraichu.website';
      const sessionRes = await page.request.get('/api/auth/session');
      const sessionJson = await sessionRes.json().catch(() => ({}));
      const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
      const headers = {
        Origin: origin,
        'x-csrf-token': csrf,
      };

      // Path traversal ile dosya oluşturma girişimi
      const badFileRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/file`, {
        headers,
        data: { path: '../../../etc/evil_probe.txt' },
      });
      expect(badFileRes.status()).toBe(400);

      // Path traversal ile klasör oluşturma girişimi
      const badFolderRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/mkdir`, {
        headers,
        data: { path: '../../../var/evil_folder' },
      });
      expect(badFolderRes.status()).toBe(400);

      // Path traversal ile yeniden adlandırma girişimi
      const badRenameRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/rename`, {
        headers,
        data: { path: 'valid.txt', destination: '../../outside.txt' },
      });
      expect(badRenameRes.status()).toBe(400);

      // Hatalı/eksik onay kodu ile silme girişimi
      const badDeleteRes = await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
        headers,
        data: { path: 'valid.txt', confirmation: 'wrong-confirmation-token' },
      });
      expect(badDeleteRes.status()).toBe(400);
    }
  });
});
