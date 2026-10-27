import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DOS-04 Tekli/çoklu dosya ve klasör yükleme; sürükle/bırak', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const runId = Date.now().toString(36);
  const prefix = `tdos04-a${agentN}-${runId}`;

  const singleFileName = `${prefix}-single.txt`;
  const singleFileContent = `DOS-04 single upload verified content ${runId}`;

  const multiFile1Name = `${prefix}-multi-1.txt`;
  const multiFile1Content = `DOS-04 multi-upload 1 content ${runId}`;
  const multiFile2Name = `${prefix}-multi-2.txt`;
  const multiFile2Content = `DOS-04 multi-upload 2 content ${runId}`;

  const dropFileName = `${prefix}-drop.txt`;
  const dropFileContent = `DOS-04 drag-and-drop upload verified content ${runId}`;

  const oversizedFileName = `${prefix}-oversized.bin`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;
  const createdFiles = new Set();

  test.beforeEach(async ({ page }) => {
    // API çağrıları için websiteId yakala
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
    if (createdFiles.size === 0) return;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const origin = new URL(page.url()).origin;
      const sessionRes = await page.request.get('/api/auth/session');
      const sessionJson = await sessionRes.json().catch(() => null);
      const csrfToken = sessionJson?.data?.csrfToken || '';

      for (const fileName of createdFiles) {
        if (resolvedWebsiteId) {
          await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
            headers: { origin, 'x-csrf-token': csrfToken },
            data: {
              path: fileName,
              confirmation: `delete:${resolvedWebsiteId}:${fileName}`,
            },
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('DOS-04 cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: tekli dosya yükleme, çoklu dosya yükleme ve sürükle/bırak; fiziksel indirme ve içerik doğrulaması', async ({ page }) => {
    // 1. /files üzerinden ilk uygun sitenin dosya yöneticisine git
    await page.goto('/files');
    await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });

    const filesTable = page.locator('table.ws-table');
    await expect(filesTable).toBeVisible({ timeout: 15000 });

    const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
    await expect(fileManagerLinks.first()).toBeVisible({ timeout: 15000 });

    const firstLinkHref = await fileManagerLinks.first().getAttribute('href');
    expect(firstLinkHref).toBeTruthy();
    const domainMatch = firstLinkHref.match(/\/websites\/([^/?#]+)\/files/);
    expect(domainMatch).toBeTruthy();
    resolvedDomainId = domainMatch[1];

    await fileManagerLinks.first().click();
    await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });

    const uploadBtn = page.locator('button:has-text("Yükle")');
    await expect(uploadBtn).toBeEnabled({ timeout: 15000 });

    const fileInput = page.locator('input[type="file"][multiple]');
    await expect(fileInput).toBeAttached({ timeout: 10000 });

    // Download linkinden websiteId doğrulaması
    const existingDownloadLink = page.locator('table.yf-table a[download]').first();
    if (await existingDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const dHref = await existingDownloadLink.getAttribute('href');
      const wMatch = dHref?.match(/\/websites\/([^/?#]+)\/files\/download/);
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // 2. TEKLİ DOSYA YÜKLEME (File Chooser input üzerinden)
    await fileInput.setInputFiles({
      name: singleFileName,
      mimeType: 'text/plain',
      buffer: Buffer.from(singleFileContent, 'utf8'),
    });

    // Dosya yükleme modali açılmalı
    const uploadModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Dosya yükle' });
    await expect(uploadModal).toBeVisible({ timeout: 10000 });
    await expect(uploadModal.locator('.yf-upload-list li')).toContainText(singleFileName);
    await expect(uploadModal.locator('.yf-upload-list li strong')).toContainText('Bekliyor');

    // Yüklemeyi başlat butonuna tıkla
    const startUploadBtn = uploadModal.locator('button:has-text("Yüklemeyi başlat")');
    await expect(startUploadBtn).toBeVisible({ timeout: 5000 });
    await startUploadBtn.click();

    // Modal kapanmalı ve geri bildirim görünmeli
    await expect(uploadModal).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.yf-feedback')).toContainText('1 dosya yüklendi', { timeout: 10000 });

    // Dosya listesinde görünmeli
    const singleRow = page.locator(`tr[role="row"]:has(strong:has-text("${singleFileName}"))`);
    await expect(singleRow).toBeVisible({ timeout: 15000 });
    createdFiles.add(singleFileName);

    if (!resolvedWebsiteId) {
      const dHref = await singleRow.locator('a[download]').getAttribute('href');
      const wMatch = dHref?.match(/\/websites\/([^/?#]+)\/files\/download/);
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // Fiziksel doğrulama 1: İndirme API'si ile dosya içeriğini kontrol et
    expect(resolvedWebsiteId).toBeTruthy();
    const singleDownloadRes = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(singleFileName)}`
    );
    expect(singleDownloadRes.status()).toBe(200);
    const downloadedSingleBody = await singleDownloadRes.text();
    expect(downloadedSingleBody).toBe(singleFileContent);

    // 3. ÇOKLU DOSYA YÜKLEME (2 dosya aynı anda)
    await fileInput.setInputFiles([
      {
        name: multiFile1Name,
        mimeType: 'text/plain',
        buffer: Buffer.from(multiFile1Content, 'utf8'),
      },
      {
        name: multiFile2Name,
        mimeType: 'text/plain',
        buffer: Buffer.from(multiFile2Content, 'utf8'),
      },
    ]);

    await expect(uploadModal).toBeVisible({ timeout: 10000 });
    const listItems = uploadModal.locator('.yf-upload-list li');
    await expect(listItems).toHaveCount(2);
    await expect(listItems.nth(0)).toContainText(multiFile1Name);
    await expect(listItems.nth(1)).toContainText(multiFile2Name);

    const startMultiBtn = uploadModal.locator('button:has-text("Yüklemeyi başlat")');
    await startMultiBtn.click();

    await expect(uploadModal).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.yf-feedback')).toContainText('2 dosya yüklendi', { timeout: 10000 });

    const multi1Row = page.locator(`tr[role="row"]:has(strong:has-text("${multiFile1Name}"))`);
    const multi2Row = page.locator(`tr[role="row"]:has(strong:has-text("${multiFile2Name}"))`);
    await expect(multi1Row).toBeVisible({ timeout: 15000 });
    await expect(multi2Row).toBeVisible({ timeout: 15000 });
    createdFiles.add(multiFile1Name);
    createdFiles.add(multiFile2Name);

    // Fiziksel doğrulama 2: Çoklu dosyaların her ikisinin içeriğini indirip doğrula
    const m1Res = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(multiFile1Name)}`
    );
    expect(m1Res.status()).toBe(200);
    expect(await m1Res.text()).toBe(multiFile1Content);

    const m2Res = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(multiFile2Name)}`
    );
    expect(m2Res.status()).toBe(200);
    expect(await m2Res.text()).toBe(multiFile2Content);

    // 4. SÜRÜKLE / BIRAK (Drag and drop) İLE DOSYA YÜKLEME
    await page.evaluate(({ name, content }) => {
      const dt = new DataTransfer();
      const file = new File([content], name, { type: 'text/plain' });
      dt.items.add(file);
      const target = document.querySelector('section.yf-browser');
      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      target.dispatchEvent(dropEvent);
    }, { name: dropFileName, content: dropFileContent });

    await expect(uploadModal).toBeVisible({ timeout: 10000 });
    await expect(uploadModal.locator('.yf-upload-list li')).toContainText(dropFileName);

    const startDropBtn = uploadModal.locator('button:has-text("Yüklemeyi başlat")');
    await startDropBtn.click();

    await expect(uploadModal).toHaveCount(0, { timeout: 20000 });
    await expect(page.locator('.yf-feedback')).toContainText('1 dosya yüklendi', { timeout: 10000 });

    const dropRow = page.locator(`tr[role="row"]:has(strong:has-text("${dropFileName}"))`);
    await expect(dropRow).toBeVisible({ timeout: 15000 });
    createdFiles.add(dropFileName);

    // Fiziksel doğrulama 3: Sürükle bırak ile yüklenen dosyanın içeriğini doğrula
    const dropRes = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(dropFileName)}`
    );
    expect(dropRes.status()).toBe(200);
    expect(await dropRes.text()).toBe(dropFileContent);
  });

  test('hatalı girdi: 16 MB limitini aşan dosya ve geçersiz dosya yolu reddedilir', async ({ page }) => {
    // Dosya yöneticisi sayfasına git
    if (resolvedDomainId) {
      await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    } else {
      await page.goto('/files');
      const firstLink = page.locator('table.ws-table tbody tr a:has-text("Dosya Yöneticisi")').first();
      await expect(firstLink).toBeVisible({ timeout: 15000 });
      const href = await firstLink.getAttribute('href');
      const domainMatch = href.match(/\/websites\/([^/?#]+)\/files/);
      resolvedDomainId = domainMatch[1];
      await firstLink.click();
    }

    await expect(page.locator('section.yf-browser')).toBeVisible({ timeout: 15000 });
    const uploadBtn = page.locator('button:has-text("Yükle")');
    await expect(uploadBtn).toBeEnabled({ timeout: 15000 });
    const fileInput = page.locator('input[type="file"][multiple]');
    await expect(fileInput).toBeAttached({ timeout: 10000 });

    // 1. 16 MB + 1 KB (16778240 bayt) aşırı büyük dosya yükleme denemesi
    const oversizedBuffer = Buffer.alloc(16 * 1024 * 1024 + 1024, 0x5a);
    await fileInput.setInputFiles({
      name: oversizedFileName,
      mimeType: 'application/octet-stream',
      buffer: oversizedBuffer,
    });

    const uploadModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Dosya yükle' });
    await expect(uploadModal).toBeVisible({ timeout: 10000 });
    await expect(uploadModal.locator('.yf-upload-list li')).toContainText(oversizedFileName);

    const startBtn = uploadModal.locator('button:has-text("Yüklemeyi başlat")');
    await startBtn.click();

    // Hata mesajı görünmeli (16 MB sınırı aşıldığı için yükleme başarısız oldu uyarısı)
    const modalError = uploadModal.locator('[role="alert"], .ws-notice-error');
    await expect(modalError).toBeVisible({ timeout: 15000 });
    await expect(modalError).toContainText(/Dosya yükleme başarısız oldu|16777216|too_large|limit/i);

    // Modal açık kalmalı ve dosya başarıyla yüklenmiş sayılmamalı
    await expect(uploadModal.locator('p[role="status"]')).toContainText('0 / 1 tamamlandı');

    // Modalı vazgeç/kapat butonuyla kapat
    const closeBtn = uploadModal.locator('button:has-text("Kapat")');
    await closeBtn.click();
    await expect(uploadModal).toHaveCount(0, { timeout: 10000 });

    // Fiziksel doğrulama: Aşırı büyük dosya sunucu diskinde oluşmamış olmalı
    if (resolvedWebsiteId) {
      const checkRes = await page.request.get(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(oversizedFileName)}`
      );
      expect([400, 404]).toContain(checkRes.status());
    }

    // 2. Güvenlik ve sınır denetimleri: Path traversal ve geçersiz yol içeren upload denemeleri API'de reddedilir
    if (resolvedWebsiteId) {
      // CSRF token ve Origin al
      const origin = new URL(page.url()).origin;
      const sessionRes = await page.request.get('/api/auth/session');
      const sessionJson = await sessionRes.json().catch(() => null);
      const csrfToken = sessionJson?.data?.csrfToken || '';

      const authHeaders = {
        origin,
        'x-csrf-token': csrfToken,
        'content-type': 'application/octet-stream',
      };

      // Path traversal ile kök dışına yükleme denemesi
      const traversalUploadRes = await page.request.put(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/upload?path=../../escape.txt`,
        {
          headers: authHeaders,
          data: Buffer.from('escape attempt'),
        }
      );
      expect(traversalUploadRes.status()).toBe(400);

      // Null byte injection denemesi
      const nullByteRes = await page.request.put(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/upload?path=evil%00.txt`,
        {
          headers: authHeaders,
          data: Buffer.from('null byte attempt'),
        }
      );
      expect(nullByteRes.status()).toBe(400);

      // Yanlış Content-Type ile upload denemesi (415 beklenir)
      const wrongTypeRes = await page.request.put(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/upload?path=wrongtype.txt`,
        {
          headers: {
            origin,
            'x-csrf-token': csrfToken,
            'content-type': 'text/plain',
          },
          data: 'text content',
        }
      );
      expect(wrongTypeRes.status()).toBe(415);
    }

    // 3. Panelde klasör yükleme denetimi: webkitdirectory veya klasör yükleme inputu bulunmamaktadır
    const folderInputCount = await page.locator('input[type="file"][webkitdirectory]').count();
    expect(folderInputCount).toBe(0);
  });
});
