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

test.describe('DOS-07 Arşiv oluşturma/açma ve güvenli overwrite', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const timestamp = Date.now().toString(36);
  const prefix = `tdos07-a${agentN}-${timestamp}`;

  const testDocName = `${prefix}-doc.txt`;
  const testDocContentInitial = `YunPanel DOS-07 Initial Archive Content ${timestamp}`;
  const testDocContentOverwritten = `YunPanel DOS-07 Overwritten Content ${timestamp}`;
  const testFolderName = `${prefix}-dir`;
  const testArchiveName = `${prefix}-bundle.zip`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;
  const createdItems = new Set();

  test.beforeEach(async ({ page }) => {
    page.on('request', (req) => {
      const match = req.url().match(/\/api\/panel\/websites\/([^/?#]+)\/files/);
      if (match && !resolvedWebsiteId) {
        resolvedWebsiteId = decodeURIComponent(match[1]);
      }
    });

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
    if (resolvedWebsiteId && createdItems.size > 0) {
      try {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD).catch(() => {});
        const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
        const sessionJson = sessionRes ? await sessionRes.json().catch(() => null) : null;
        const csrfToken = sessionJson?.data?.csrfToken || '';
        const origin = 'https://server.cryptoraichu.website';

        for (const item of createdItems) {
          await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
            headers: { origin, 'x-csrf-token': csrfToken },
            data: {
              path: item,
              confirmation: `delete:${resolvedWebsiteId}:${item}`,
            },
          }).catch(() => {});
        }
        await context.close().catch(() => {});
      } catch (err) {
        console.warn('API cleanup error:', err.message);
      }
    }

    // 2. SSH ile geride kalan test kalıntılarını temizle (mevcut site verilerine asla dokunulmaz)
    try {
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name 'tdos07-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: dosya ve klasör seçip zip arşivi oluşturma, arşivi dizine açma, güvenli overwrite onayı ve fiziksel SSH doğrulaması', async ({ page }) => {
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

    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    const filesListTable = page.locator('table.yf-table[aria-label="Site dosyaları"]');
    await expect(filesListTable).toBeVisible({ timeout: 15000 });

    // 2. Test dosyası oluştur
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createFileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createFileModal).toBeVisible({ timeout: 10000 });

    const fileNameInput = createFileModal.locator('input');
    await fileNameInput.fill(testDocName);
    const createFileSubmit = createFileModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createFileSubmit).toBeEnabled();
    await createFileSubmit.click();

    await expect(createFileModal).toHaveCount(0, { timeout: 15000 });
    const createdFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testDocName}"))`);
    await expect(createdFileRow).toBeVisible({ timeout: 15000 });
    createdItems.add(testDocName);

    // 3. Dosyayı düzenle ve ilk içerikle kaydet
    const editBtn = createdFileRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]');
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testDocName });
    await expect(editorModal).toBeVisible({ timeout: 15000 });

    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 10000 });
    await editorTextarea.fill(testDocContentInitial);

    const saveBtn = editorModal.locator('button[type="submit"]:has-text("Kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });
    // URL parametresini temizleyerek dosya yöneticisine dön
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('dialog.ws-modal-wide')).toHaveCount(0, { timeout: 10000 });

    // 4. Test klasörü oluştur
    await page.locator('button:has-text("Yeni Klasör")').click();
    const createFolderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(createFolderModal).toBeVisible({ timeout: 10000 });

    const folderNameInput = createFolderModal.locator('input');
    await folderNameInput.fill(testFolderName);
    const createFolderSubmit = createFolderModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createFolderSubmit).toBeEnabled();
    await createFolderSubmit.click();

    await expect(createFolderModal).toHaveCount(0, { timeout: 15000 });
    const createdFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFolderName}"))`);
    await expect(createdFolderRow).toBeVisible({ timeout: 15000 });
    createdItems.add(testFolderName);

    // 5. Dosya ve klasörü seçip ZIP arşivi oluştur
    const docRow = page.locator(`tr[role="row"]:has(strong:has-text("${testDocName}"))`);
    const dirRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFolderName}"))`);
    await docRow.locator('input[type="checkbox"]').check();
    await dirRow.locator('input[type="checkbox"]').check();

    const selectionActions = page.locator('.yf-selection-actions');
    await expect(selectionActions).toBeVisible({ timeout: 10000 });

    const archiveBtn = selectionActions.locator('button:has-text("Arşivle")');
    await expect(archiveBtn).toBeVisible({ timeout: 10000 });
    await archiveBtn.click();

    const archiveModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Arşivle (ZIP)' });
    await expect(archiveModal).toBeVisible({ timeout: 10000 });

    const archiveNameInput = archiveModal.locator('input');
    await archiveNameInput.fill(testArchiveName);
    createdItems.add(testArchiveName);

    const submitArchiveBtn = archiveModal.locator('button[type="submit"]:has-text("Arşivle")');
    await expect(submitArchiveBtn).toBeEnabled();
    await submitArchiveBtn.click();

    // 6. Arşiv oluşturuldu bildirimini ve listedeki arşiv satırını doğrula
    await expect(archiveModal).toHaveCount(0, { timeout: 20000 });
    const archiveNotice = page.locator('.yf-feedback, [role="status"]').filter({ hasText: 'Arşiv oluşturuldu' });
    await expect(archiveNotice).toBeVisible({ timeout: 15000 });

    const archiveRow = page.locator(`tr[role="row"]:has(strong:has-text("${testArchiveName}"))`);
    await expect(archiveRow).toBeVisible({ timeout: 15000 });

    // 7. FİZİKSEL SONUÇ (SSH): Arşiv dosyası sunucuda gerçekten oluştu mu ve geçerli bir ZIP mi?
    const sshArchivePath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testArchiveName}'`);
    expect(sshArchivePath).toBeTruthy();
    expect(sshArchivePath).toContain(testArchiveName);

    const zipIntegrityCheck = runSsh(`unzip -t "${sshArchivePath}" && echo ZIP_VALID`);
    expect(zipIntegrityCheck).toContain('ZIP_VALID');

    const zipList = runSsh(`unzip -l "${sshArchivePath}"`);
    expect(zipList).toContain(testDocName);
    expect(zipList).toContain(testFolderName);

    // 8. GÜVENLİ OVERWRITE TESTİ:
    // Mevcut dosyanın içeriğini değiştir (üzerine yazılacağını test etmek için)
    const rowBeforeOverwrite = page.locator(`tr[role="row"]:has(strong:has-text("${testDocName}"))`);
    await rowBeforeOverwrite.locator('button[title="Düzenle"], button[aria-label*="düzenle"]').click();
    const overwriteEditorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testDocName });
    await expect(overwriteEditorModal).toBeVisible({ timeout: 15000 });

    const overwriteEditorTextarea = overwriteEditorModal.locator('textarea');
    await overwriteEditorTextarea.fill(testDocContentOverwritten);
    await overwriteEditorModal.locator('button[type="submit"]:has-text("Kaydet")').click();
    await expect(overwriteEditorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('dialog.ws-modal-wide')).toHaveCount(0, { timeout: 10000 });

    // SSH ile dosyanın değiştirildiğini teyit et
    const sshDocPath = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testDocName}'`);
    expect(sshDocPath).toBeTruthy();
    const contentBeforeExtract = runSsh(`cat "${sshDocPath}"`);
    expect(contentBeforeExtract).toBe(testDocContentOverwritten);

    // 9. Arşivi Çıkart modalını aç, overwrite uyarısını doğrula ve çıkart
    const currentArchiveRow = page.locator(`tr[role="row"]:has(strong:has-text("${testArchiveName}"))`);
    const extractActionBtn = currentArchiveRow.locator('button[aria-label*="arşivi çıkart"], button[title="Arşivi Çıkart"]');
    await expect(extractActionBtn).toBeVisible({ timeout: 10000 });
    await extractActionBtn.click();

    const extractModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Arşivi Çıkart' });
    await expect(extractModal).toBeVisible({ timeout: 10000 });

    // Güvenli overwrite uyarısının mevcut olduğunu doğrula
    const overwriteWarning = extractModal.locator('.yf-conflict-warning');
    await expect(overwriteWarning).toContainText('Hedef klasördeki aynı adlı dosyaların üzerine yazılabilir.');
    await expect(overwriteWarning).toBeVisible({ timeout: 10000 });

    // Hedef kök klasör (boş = geçerli dizin) olarak çıkartmayı başlat
    const submitExtractBtn = extractModal.locator('button[type="submit"]:has-text("Arşivi Çıkart")');
    await expect(submitExtractBtn).toBeEnabled();
    await submitExtractBtn.click();

    // Çıkartma bildirimini doğrula
    await expect(extractModal).toHaveCount(0, { timeout: 20000 });
    const extractNotice = page.locator('.yf-feedback, [role="status"]').filter({ hasText: 'arşivi çıkartıldı' });
    await expect(extractNotice).toBeVisible({ timeout: 15000 });

    // 10. FİZİKSEL SONUÇ (SSH): Arşiv çıkartılınca dosyanın üzerine yazıldı ve orijinal içerik geri yüklendi mi?
    const contentAfterExtract = runSsh(`cat "${sshDocPath}"`);
    expect(contentAfterExtract).toBe(testDocContentInitial);
  });

  test('hatalı girdi: boş arşiv adı, geçersiz dosya adı ve geçersiz çıkartma hedefi (path traversal) reddedilir', async ({ page }) => {
    // 1. Site dosya yöneticisine git
    await page.goto('/files');
    await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });

    const filesTable = page.locator('table.ws-table');
    const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
    await fileManagerLinks.first().click();

    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });

    // Listede bir öğe seçerek seçim çubuğunu aç
    const anyCheckbox = page.locator('table.yf-table tbody tr input[type="checkbox"]').first();
    await anyCheckbox.check();

    const selectionActions = page.locator('.yf-selection-actions');
    await expect(selectionActions).toBeVisible({ timeout: 10000 });

    const archiveBtn = selectionActions.locator('button:has-text("Arşivle")');
    await archiveBtn.click();

    const archiveModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Arşivle (ZIP)' });
    await expect(archiveModal).toBeVisible({ timeout: 10000 });

    const archiveNameInput = archiveModal.locator('input');
    const submitArchiveBtn = archiveModal.locator('button[type="submit"]:has-text("Arşivle")');

    // A. Boş arşiv adı: Buton disabled kalmalı
    await archiveNameInput.fill('');
    await expect(submitArchiveBtn).toBeDisabled();

    // B. Path traversal karakterleri içeren arşiv adı: Buton disabled kalmalı
    await archiveNameInput.fill('../malicious.zip');
    await expect(submitArchiveBtn).toBeDisabled();

    // C. Geçersiz eğik çizgi / alt dizin yolu: Buton disabled kalmalı
    await archiveNameInput.fill('nested/dir/bundle.zip');
    await expect(submitArchiveBtn).toBeDisabled();

    // Arşivle modalını kapat
    await archiveModal.locator('button:has-text("Vazgeç")').click();
    await expect(archiveModal).toHaveCount(0, { timeout: 10000 });

    // D. Çıkartmada geçersiz hedef klasör (path traversal): Hata uyarısı gösterilmeli
    // Tabloda arşiv satırını bul
    const archiveRow = page.locator(`tr[role="row"]:has(strong:has-text("${testArchiveName}"))`);
    await expect(archiveRow).toBeVisible({ timeout: 15000 });

    const extractBtn = archiveRow.locator('button[aria-label*="arşivi çıkart"], button[title="Arşivi Çıkart"]');
    await expect(extractBtn).toBeVisible({ timeout: 10000 });
    await extractBtn.click();

    const extractModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Arşivi Çıkart' });
    await expect(extractModal).toBeVisible({ timeout: 10000 });

    const destInput = extractModal.locator('input');
    await destInput.fill('../../etc/jailbreak');

    const submitExtractBtn = extractModal.locator('button[type="submit"]:has-text("Arşivi Çıkart")');
    await submitExtractBtn.click();

    // validateDestinationPath hatası görüntülenmeli
    const errorNotice = extractModal.locator('[role="alert"]').filter({ hasText: 'Hedef klasör yolu geçersiz' });
    await expect(errorNotice).toBeVisible({ timeout: 10000 });

    // Modalı kapat
    await extractModal.locator('button:has-text("Vazgeç")').click();
    await expect(extractModal).toHaveCount(0, { timeout: 10000 });
  });
});
