import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DOS-01 Global Files ve domain File Manager girişleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const testFileName = `tdos01-a${agentN}-${Date.now().toString(36)}.txt`;
  const testFileContent = `YunPanel DOS-01 E2E verified content ${Date.now()}`;
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
    if (!testFileName) return;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

      // 1. API üzerinden güvenli ve hızlı silme
      if (resolvedWebsiteId) {
        await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
          data: {
            path: testFileName,
            confirmation: `delete:${resolvedWebsiteId}:${testFileName}`,
          },
        }).catch(() => {});
      }

      // 2. Arayüzde hâlâ varsa temizle
      if (resolvedDomainId) {
        await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
        await page.waitForLoadState('networkidle').catch(() => {});
        const fileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
        if (await fileRow.isVisible({ timeout: 3000 }).catch(() => false)) {
          const actionsBtn = fileRow.locator('button[aria-label*="işlemleri"]');
          if (await actionsBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            await actionsBtn.click();
            const deleteBtn = page.locator('dialog.ws-modal button:has-text("Sil…"), .ws-modal button:has-text("Sil…")');
            if (await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
              await deleteBtn.click();
              const confirmInput = page.locator('dialog.ws-modal input, .ws-modal input');
              if (await confirmInput.isVisible({ timeout: 3000 }).catch(() => false)) {
                await confirmInput.fill(testFileName);
              }
              const confirmBtn = page.locator('dialog.ws-modal button:has-text("Kalıcı olarak sil"), .ws-modal button:has-text("Kalıcı olarak sil")');
              if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
                await confirmBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('DOS-01 cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: Global Files ve domain File Manager gezintisi, dosya listeleme, oluşturma, düzenleme ve fiziksel HTTP doğrulaması', async ({ page }) => {
    // 1. Global Files rotasına git ve başlığı doğrula
    await page.goto('/files');
    await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Dosya yöneticisini açmak için web sitesini seçin.')).toBeVisible({ timeout: 10000 });

    // 2. Web siteleri tablosunun yüklendiğini doğrula
    const filesTable = page.locator('table.ws-table');
    await expect(filesTable).toBeVisible({ timeout: 15000 });

    // 3. Tablodaki ilk erişilebilir sitenin "Dosya Yöneticisi" butonunu bul
    const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
    await expect(fileManagerLinks.first()).toBeVisible({ timeout: 15000 });

    const firstLinkHref = await fileManagerLinks.first().getAttribute('href');
    expect(firstLinkHref).toBeTruthy();
    const domainMatch = firstLinkHref.match(/\/websites\/([^/?#]+)\/files/);
    expect(domainMatch).toBeTruthy();
    resolvedDomainId = domainMatch[1];

    // Global Files sayfasından site File Manager'ına tıkla
    await fileManagerLinks.first().click();
    await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });

    // 4. Domain Overview üzerinden File Manager girişini doğrula
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/overview`);
    await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });

    // Sekmelerde "Dosyalar" bağlantısının var olduğunu ve tıklandığında File Manager'ı açtığını doğrula
    const siteFilesTab = page.locator('.ws-plesk-site-navigation a[href$="/files"], nav[aria-label="Site araçları"] a:has-text("Dosyalar"), a:has-text("Dosya yöneticisi")').first();
    await expect(siteFilesTab).toBeVisible({ timeout: 10000 });
    await siteFilesTab.click();
    await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });

    // 5. File Manager arayüz bileşenlerini doğrula
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.yf-header h2', { hasText: 'Dosya yöneticisi' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Yeni Dosya")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Yeni Klasör")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Yükle")')).toBeVisible({ timeout: 10000 });

    // Breadcrumb ve klasör ağacını doğrula
    await expect(page.locator('nav[aria-label="Dosya konumu"] button:has-text("Site kökü")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('nav.yf-tree button.yf-root:has-text("Site kökü")')).toBeVisible({ timeout: 10000 });

    // Dosya listesi tablosunun yüklendiğini doğrula
    const filesListTable = page.locator('table.yf-table[aria-label="Site dosyaları"]');
    await expect(filesListTable).toBeVisible({ timeout: 15000 });

    // 6. Yeni dosya oluşturma
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createModal).toBeVisible({ timeout: 10000 });

    const nameInput = createModal.locator('input');
    await nameInput.fill(testFileName);
    const submitCreateBtn = createModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitCreateBtn).toBeEnabled();
    await submitCreateBtn.click();

    // Modal kapanmalı ve dosya listede görünmeli
    await expect(createModal).toHaveCount(0, { timeout: 15000 });
    const createdRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
    await expect(createdRow).toBeVisible({ timeout: 15000 });

    // 7. Dosyayı inline editörde aç ve düzenle
    const editBtn = createdRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]');
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFileName });
    await expect(editorModal).toBeVisible({ timeout: 15000 });

    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 10000 });
    await editorTextarea.fill(testFileContent);

    // Kaydet butonuna tıkla
    const saveBtn = editorModal.locator('button[type="submit"]:has-text("Kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Kaydedildi durumunu doğrula
    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });

    // İndir bağlantısından websiteId parametresini tespit et
    const downloadLink = createdRow.locator('a[download]');
    await expect(downloadLink).toBeVisible({ timeout: 10000 });
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toBeTruthy();
    const websiteMatch = downloadHref.match(/\/websites\/([^/?#]+)\/files\/download/);
    expect(websiteMatch).toBeTruthy();
    resolvedWebsiteId = decodeURIComponent(websiteMatch[1]);

    // Editörü kapatıp File Manager ana görünümüne dön (re-open loop'unu engellemek için temiz rota)
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('dialog.ws-modal-wide')).toHaveCount(0, { timeout: 10000 });

    // 8. Fiziksel Sonuç Doğrulaması (HTTP download yanıtı ve içerik kontrolü)
    const downloadResponse = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(testFileName)}`);
    expect(downloadResponse.status()).toBe(200);
    const downloadedText = await downloadResponse.text();
    expect(downloadedText).toBe(testFileContent);

    // 9. Temizlik: Dosyayı arayüz üzerinden sil
    const fileRowToDelete = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
    await expect(fileRowToDelete).toBeVisible({ timeout: 10000 });
    const actionsBtn = fileRowToDelete.locator('button[aria-label*="işlemleri"]');
    await actionsBtn.click();

    const detailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFileName });
    await expect(detailsModal).toBeVisible({ timeout: 10000 });

    const deleteBtn = detailsModal.locator('button:has-text("Sil…")');
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
    await deleteBtn.click();

    const confirmModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'silinsin mi?' });
    await expect(confirmModal).toBeVisible({ timeout: 10000 });

    const confirmInput = confirmModal.locator('input');
    await confirmInput.fill(testFileName);
    const confirmDeleteBtn = confirmModal.locator('button:has-text("Kalıcı olarak sil")');
    await expect(confirmDeleteBtn).toBeEnabled();
    await confirmDeleteBtn.click();

    // Dosyanın listeden silindiğini doğrula
    await expect(fileRowToDelete).toHaveCount(0, { timeout: 15000 });
  });

  test('hatalı girdi: geçersiz site sorgusu, path traversal ve geçersiz dosya adı reddedilir', async ({ page }) => {
    // 1. Global Files'ta geçersiz/var olmayan site ID sorgusu
    await page.goto('/files?site=00000000-0000-0000-0000-000000000000');
    await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });
    const notFoundState = page.locator('text=İstenen siteye erişilemiyor');
    await expect(notFoundState).toBeVisible({ timeout: 15000 });
    const returnLink = page.locator('a:has-text("Site seçimine dön")');
    await expect(returnLink).toBeVisible();

    // 2. Gerekirse domain ve website ID'sini hazırla
    if (!resolvedDomainId || !resolvedWebsiteId) {
      await page.goto('/files');
      const filesTable = page.locator('table.ws-table');
      await expect(filesTable).toBeVisible({ timeout: 15000 });
      const firstLink = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")').first();
      await expect(firstLink).toBeVisible({ timeout: 15000 });
      const href = await firstLink.getAttribute('href');
      const match = href.match(/\/websites\/([^/?#]+)\/files/);
      resolvedDomainId = match[1];

      await firstLink.click();
      await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });
      const anyDownloadLink = page.locator('table.yf-table a[download]').first();
      if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        const dHref = await anyDownloadLink.getAttribute('href');
        const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
        if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
      }
    }

    // 3. Path Traversal koruması (Backend API üzerinden ../ veya /etc/passwd girişimleri)
    if (resolvedWebsiteId) {
      // Relative path traversal
      const traversalResponse = await page.request.get(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=../../../../etc/passwd`
      );
      expect(traversalResponse.status()).toBe(400);

      // Absolute path jail koruması: /etc/shadow kökten okunamaz, jail içinde aranır ve 400/404 döner
      const absoluteResponse = await page.request.get(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=/etc/shadow`
      );
      expect([400, 404]).toContain(absoluteResponse.status());

      // Null byte injection koruması
      const nullByteResponse = await page.request.get(
        `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=test%00.txt`
      );
      expect(nullByteResponse.status()).toBe(400);
    }

    // 4. Arayüzde geçersiz dosya adı doğrulama koruması
    if (resolvedDomainId) {
      await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
      await expect(page.locator('button:has-text("Yeni Dosya")')).toBeVisible({ timeout: 15000 });
      await page.locator('button:has-text("Yeni Dosya")').click();

      const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
      await expect(createModal).toBeVisible({ timeout: 10000 });

      const nameInput = createModal.locator('input');
      const submitBtn = createModal.locator('button[type="submit"]:has-text("Oluştur")');

      // Slash içeren ad (path traversal veya alt klasör sızması denemesi)
      await nameInput.fill('../badname.txt');
      expect(await submitBtn.isDisabled()).toBe(true);

      // Yalnızca nokta olan ad
      await nameInput.fill('..');
      expect(await submitBtn.isDisabled()).toBe(true);

      // Boş ad
      await nameInput.fill('');
      expect(await submitBtn.isDisabled()).toBe(true);

      // Modaldan vazgeç
      await createModal.locator('button:has-text("Vazgeç")').click();
      await expect(createModal).toHaveCount(0, { timeout: 10000 });
    }
  });
});
