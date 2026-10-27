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

test.describe('DOS-08 Kod/metin/HTML düzenleme, kaydetme ve değişiklik uyarısı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const prefix = `tdos08-a${agentN}-${timestamp}`;

  const testHtmlName = `${prefix}-page.html`;
  const testHtmlContent = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <title>DOS-08 Test ${timestamp}</title>
</head>
<body>
  <h1>YunPanel DOS-08 HTML Editör Doğrulaması</h1>
  <p>Test ID: ${prefix}</p>
</body>
</html>`;

  const testConflictName = `${prefix}-conflict.txt`;
  const testBinaryName = `${prefix}-binary.bin`;

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
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name 'tdos08-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: HTML dosyası oluşturma, editörde açma, düzenleme, kaydedilmemiş değişiklik uyarısı, kaydetme ve fiziksel sunucu doğrulaması', async ({ page }) => {
    // 1. Global Files sayfasına git ve sitenin dosya yöneticisine bağlan
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

    // 2. Yeni HTML dosyası oluştur
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createFileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createFileModal).toBeVisible({ timeout: 10000 });

    const fileNameInput = createFileModal.locator('input');
    await fileNameInput.fill(testHtmlName);
    const createFileSubmit = createFileModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createFileSubmit).toBeEnabled();
    await createFileSubmit.click();

    await expect(createFileModal).toHaveCount(0, { timeout: 15000 });
    const createdFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testHtmlName}"))`);
    await expect(createdFileRow).toBeVisible({ timeout: 15000 });
    createdItems.add(testHtmlName);

    // 3. Editörde aç
    const editBtn = createdFileRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]');
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testHtmlName });
    await expect(editorModal).toBeVisible({ timeout: 15000 });

    // Editör meta ve satır numaralarını doğrula
    await expect(editorModal.locator('.yf-editor-meta code')).toContainText(testHtmlName);
    await expect(editorModal.locator('.yf-editor pre')).toBeVisible({ timeout: 5000 });

    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 10000 });

    // 4. HTML kod düzenleme
    await editorTextarea.fill(testHtmlContent);

    // Kaydedilmemiş değişiklikler rozetini doğrula
    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedilmemiş değişiklikler")')).toBeVisible({ timeout: 5000 });

    // 5. Kaydedilmemiş değişiklik varken kapatma uyarısı (ConfirmDialog)
    const closeBtn = editorModal.locator('button:has-text("Kapat")');
    await closeBtn.click();

    const confirmDiscardDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Değişiklikler bırakılsın mı?' });
    await expect(confirmDiscardDialog).toBeVisible({ timeout: 5000 });
    await expect(confirmDiscardDialog).toContainText('Dosyada kaydedilmemiş değişiklikler var.');

    // Vazgeç'e basıldığında editörün kapanmadığını ve içeriğin durduğunu doğrula
    const cancelDiscardBtn = confirmDiscardDialog.locator('button:has-text("Vazgeç")');
    await cancelDiscardBtn.click();
    await expect(confirmDiscardDialog).toHaveCount(0, { timeout: 5000 });
    await expect(editorModal).toBeVisible({ timeout: 5000 });
    await expect(editorTextarea).toHaveValue(testHtmlContent);

    // 6. Dosyayı kaydet
    const saveBtn = editorModal.locator('button[type="submit"]:has-text("Kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Kaydedildi durumunu doğrula
    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });

    // Kaydedildikten sonra Kapat'a tıklandığında uyarı çıkmadan doğrudan kapanmalıdır
    await editorModal.locator('button:has-text("Kapat")').click();
    await expect(editorModal).toHaveCount(0, { timeout: 10000 });

    // Editör kapandıktan sonra geri bildirim mesajını kontrol et (mevcutsa doğrula)
    const feedback = page.locator('.yf-feedback');
    if (await feedback.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(feedback).toContainText('Dosya kaydedildi');
    }

    // 7. Fiziksel Sonuç Doğrulaması:
    // A) HTTP API üzerinden dosya içeriğini GET ile oku
    const readResponse = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/text?path=${encodeURIComponent(testHtmlName)}`
    );
    expect(readResponse.ok()).toBeTruthy();
    const readJson = await readResponse.json();
    expect(readJson?.data?.content).toBe(testHtmlContent);

    // B) Fiziksel SSH üzerinden dosya içeriğini ve boyutunu doğrula
    const catOutput = runSsh(
      `find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name '${testHtmlName}' -exec cat {} \\;`
    );
    expect(catOutput).toContain('YunPanel DOS-08 HTML Editör Doğrulaması');
    expect(catOutput).toContain(prefix);
  });

  test('hatalı girdi ve çakışma: değişiklikleri bırakma (discard), eşzamanlı değişiklik çakışması (409 conflict) ve geçersiz UTF-8 ikili dosya koruması', async ({ page }) => {
    // 1. Global Files sayfasına ve sitenin dosya yöneticisine git
    if (!resolvedDomainId) {
      await page.goto('/files');
      const filesTable = page.locator('table.ws-table');
      await expect(filesTable).toBeVisible({ timeout: 15000 });
      const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
      await expect(fileManagerLinks.first()).toBeVisible({ timeout: 15000 });
      const firstHref = await fileManagerLinks.first().getAttribute('href');
      const match = firstHref.match(/\/websites\/([^/?#]+)\/files/);
      resolvedDomainId = match[1];
    }
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });

    // --- ALT SENARYO 1: Değişiklikleri Bırakma (Discard changes) ---
    // Oluşturduğumuz HTML dosyasını tekrar editörde aç
    const fileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testHtmlName}"))`);
    await expect(fileRow).toBeVisible({ timeout: 15000 });
    await fileRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]').click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testHtmlName });
    await expect(editorModal).toBeVisible({ timeout: 15000 });
    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 10000 });
    await expect(editorTextarea).toHaveValue(testHtmlContent);

    // Yeni metin ekle (bu bırakılacak)
    await editorTextarea.fill(`${testHtmlContent}\n<!-- BU DEGISIKLIK BIRAKILACAK -->`);
    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedilmemiş değişiklikler")')).toBeVisible({ timeout: 5000 });

    // Kapat'a tıkla ve 'Değişiklikleri bırak' seçeneğini onayla
    await editorModal.locator('button:has-text("Kapat")').last().click();
    const confirmDiscardDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Değişiklikler bırakılsın mı?' });
    await expect(confirmDiscardDialog).toBeVisible({ timeout: 5000 });

    const discardBtn = confirmDiscardDialog.locator('button:has-text("Değişiklikleri bırak")');
    await expect(discardBtn).toBeEnabled({ timeout: 5000 });
    await discardBtn.click();
    await expect(confirmDiscardDialog).toHaveCount(0, { timeout: 10000 });

    // Sayfayı temiz URL ile yenileyerek editörün kapandığını ve bırakılan değişikliğin kaydedilmediğini doğrula
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(browserSection).toBeVisible({ timeout: 15000 });

    const fileRowFresh = page.locator(`tr[role="row"]:has(strong:has-text("${testHtmlName}"))`);
    await expect(fileRowFresh).toBeVisible({ timeout: 15000 });
    const editBtnReopen = fileRowFresh.locator('button[title="Düzenle"], button[aria-label*="düzenle"]').first();
    await expect(editBtnReopen).toBeEnabled({ timeout: 10000 });
    await editBtnReopen.click();

    const reopenedEditorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testHtmlName });
    await expect(reopenedEditorModal).toBeVisible({ timeout: 15000 });
    const reopenedTextarea = reopenedEditorModal.locator('textarea');
    await expect(reopenedTextarea).toHaveValue(testHtmlContent);
    expect(await reopenedTextarea.inputValue()).not.toContain('BU DEGISIKLIK BIRAKILACAK');
    await reopenedEditorModal.locator('button:has-text("Kapat")').last().click();

    // Temiz URL ile dosya listesine dönerek editörün kapandığını doğrula
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    await expect(page.locator('dialog.ws-modal, [role="dialog"]')).toHaveCount(0, { timeout: 10000 });

    // --- ALT SENARYO 2: Eşzamanlı Değişiklik Çakışması (Optimistic Concurrency / 409 Conflict) ---
    // Yeni dosya oluştur
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createConflictModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createConflictModal).toBeVisible({ timeout: 10000 });
    await createConflictModal.locator('input').fill(testConflictName);
    await createConflictModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(createConflictModal).toHaveCount(0, { timeout: 15000 });
    createdItems.add(testConflictName);

    const conflictRow = page.locator(`tr[role="row"]:has(strong:has-text("${testConflictName}"))`);
    await expect(conflictRow).toBeVisible({ timeout: 15000 });
    await conflictRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]').click();

    const conflictEditorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testConflictName });
    await expect(conflictEditorModal).toBeVisible({ timeout: 15000 });
    const conflictTextarea = conflictEditorModal.locator('textarea');
    await conflictTextarea.fill('Sürüm 1 - Başlangıç');
    await conflictEditorModal.locator('button[type="submit"]:has-text("Kaydet")').click();
    await expect(conflictEditorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });

    // Editör açıkken arka planda SSH ile dosyayı doğrudan değiştir (SHA256'yı boz)
    const conflictTargetFile = runSsh(
      `find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name '${testConflictName}' | head -n 1`
    );
    expect(conflictTargetFile).toBeTruthy();
    runSsh(`echo "Sürüm 2 - Dışarıdan SSH ile değiştirildi" > ${conflictTargetFile}`);

    // Şimdi editörde değişiklik yapıp kaydetmeye çalış
    await conflictTextarea.fill('Sürüm 3 - Editör üzerinden çakışan kayıt');
    await conflictEditorModal.locator('button[type="submit"]:has-text("Kaydet")').click();

    // Hatanın çıktığını doğrula (File changed since it was opened / 409 Conflict)
    const errorNotice = conflictEditorModal.locator('.ws-error, .yf-error, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    await expect(errorNotice).toContainText(/değiş|changed/i);

    // Editörü kapat (değişiklikleri bırakarak)
    await conflictEditorModal.locator('button:has-text("Kapat")').last().click();
    const discardConflictDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Değişiklikler bırakılsın mı?' });
    if (await discardConflictDialog.isVisible({ timeout: 3000 }).catch(() => false)) {
      await discardConflictDialog.locator('button:has-text("Değişiklikleri bırak")').click();
      await expect(discardConflictDialog).toHaveCount(0, { timeout: 5000 });
    }

    // Temiz URL ile dosya listesine dön
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    await expect(page.locator('dialog.ws-modal, [role="dialog"]')).toHaveCount(0, { timeout: 10000 });

    // --- ALT SENARYO 3: UTF-8 Olmayan İkili (Binary) Dosya Korunması ---
    // Test dizininde rastgele geçersiz UTF-8 binary byte'lar içeren dosya oluştur
    const siteDir = runSsh(`dirname ${conflictTargetFile}`);
    expect(siteDir).toBeTruthy();
    runSsh(`printf '\\xFF\\xFE\\xFD\\x80\\x00\\xFF' > ${siteDir}/${testBinaryName} && chmod 666 ${siteDir}/${testBinaryName}`);
    createdItems.add(testBinaryName);

    // Dosya listesini yenile
    await page.reload();
    await expect(page.locator('table.yf-table[aria-label="Site dosyaları"]')).toBeVisible({ timeout: 15000 });

    const binaryRow = page.locator(`tr[role="row"]:has(strong:has-text("${testBinaryName}"))`);
    await expect(binaryRow).toBeVisible({ timeout: 15000 });

    // Binary dosya için düzenle butonuna tıkla
    await binaryRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]').click();

    // Hata bildiriminin ekranda çıktığını doğrula ("File is not valid UTF-8 text" / "UTF-8")
    const pageErrorNotice = page.locator('.ws-error, .yf-error, [role="alert"]');
    await expect(pageErrorNotice).toBeVisible({ timeout: 10000 });
    await expect(pageErrorNotice).toContainText(/UTF-8|text|metin/i);
  });
});
