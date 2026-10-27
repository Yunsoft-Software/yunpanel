import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('UX-02 Global Files + domain File Manager; kaynaklar saklanmaz', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const testFileName = `tux02-a${agentN}-${timestamp}.txt`;
  const testHiddenFileName = `.tux02-hidden-a${agentN}-${timestamp}.env`;
  const testFolderName = `tux02-dir-a${agentN}-${timestamp}`;
  const testFileContent = `UX-02 verified content ${timestamp}\nLine 2 for physical verification`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;

  async function ensureSession(page) {
    const authForm = page.locator('form.auth-form');
    if (await authForm.isVisible({ timeout: 1500 }).catch(() => false)) {
      await authForm.locator('input[name="username"]').fill(OWNER_USERNAME);
      await authForm.locator('input[name="password"]').fill(OWNER_PASSWORD);
      await authForm.locator('button[type="submit"]').click();
      await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
    }
  }

  test.beforeEach(async ({ page }) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await ensureSession(page);
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
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

      if (resolvedWebsiteId) {
        const cleanupPaths = [testFileName, testHiddenFileName, testFolderName];
        for (const itemPath of cleanupPaths) {
          await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
            data: {
              path: itemPath,
              confirmation: `delete:${resolvedWebsiteId}:${itemPath}`,
            },
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.warn('UX-02 cleanup warning:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: Global Files menüsü, domain File Manager geçişi, kaynakların ve gizli dosyaların doğrudan listelenmesi, düzenleme ve fiziksel kanıt', async ({ page }) => {
    await ensureSession(page);

    // 1. Sol ana menüde "Dosyalar" bağlantısının varlığını doğrula ve tıkla
    const globalFilesNavLink = page.locator('nav a[href="/files"], .ws-nav a[href="/files"]').first();
    await expect(globalFilesNavLink).toBeVisible({ timeout: 15000 });
    await globalFilesNavLink.click();
    await page.waitForURL(/\/files/, { timeout: 15000 });

    // 2. Global Files rotası veya tek site ise doğrudan domain File Manager yönlendirmesi
    await page.waitForLoadState('networkidle').catch(() => {});
    await ensureSession(page);

    if (page.url().match(/\/websites\/([^/?#]+)\/files/)) {
      const match = page.url().match(/\/websites\/([^/?#]+)\/files/);
      resolvedDomainId = match[1];
    } else {
      await expect(page.locator('h1', { hasText: 'Dosyalar' })).toBeVisible({ timeout: 15000 });
      const filesTable = page.locator('table.ws-table');
      await expect(filesTable).toBeVisible({ timeout: 15000 });

      const fileManagerLinks = filesTable.locator('tbody tr a:has-text("Dosya Yöneticisi")');
      await expect(fileManagerLinks.first()).toBeVisible({ timeout: 15000 });

      const firstHref = await fileManagerLinks.first().getAttribute('href');
      const domainMatch = firstHref.match(/\/websites\/([^/?#]+)\/files/);
      expect(domainMatch).toBeTruthy();
      resolvedDomainId = domainMatch[1];

      await fileManagerLinks.first().click();
      await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });
    }

    // 3. Domain Overview üzerinden de File Manager'a geçilebildiğini doğrula
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/overview`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await ensureSession(page);
    await expect(page.locator('h1')).toBeVisible({ timeout: 15000 });

    const siteFilesTab = page.locator('.ws-plesk-site-navigation a[href$="/files"], nav[aria-label="Site araçları"] a:has-text("Dosyalar"), a:has-text("Dosya yöneticisi")').first();
    await expect(siteFilesTab).toBeVisible({ timeout: 10000 });
    await siteFilesTab.click();
    await page.waitForURL(new RegExp(`/websites/${encodeURIComponent(resolvedDomainId)}/files`), { timeout: 15000 });

    // 4. File Manager araç çubuğu ve temel bileşenleri
    await expect(page.locator('.yf-header h2', { hasText: 'Dosya yöneticisi' })).toBeVisible({ timeout: 15000 });
    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    const newFolderBtn = page.locator('button:has-text("Yeni Klasör")');
    await expect(newFileBtn).toBeVisible({ timeout: 10000 });
    await expect(newFolderBtn).toBeVisible({ timeout: 10000 });

    // Breadcrumb ve dosya listesi tablosu
    await expect(page.locator('nav[aria-label="Dosya konumu"] button:has-text("Site kökü")')).toBeVisible({ timeout: 10000 });
    const filesListTable = page.locator('table.yf-table[aria-label="Site dosyaları"]');
    await expect(filesListTable).toBeVisible({ timeout: 15000 });

    // 5. Gizli dosya oluşturma ve kaynakların gizlenmediğinin (varsayılan olarak erişilebilir olduğunun) doğrulanması
    await newFileBtn.click();
    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createModal).toBeVisible({ timeout: 10000 });
    await createModal.locator('input').fill(testHiddenFileName);
    const submitCreateBtn = createModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitCreateBtn).toBeEnabled();
    await submitCreateBtn.click();
    await expect(createModal).toHaveCount(0, { timeout: 15000 });

    // Gizli dosya listede doğrudan görünür olmalıdır (varsayılan hidden=true kuralı)
    const hiddenFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testHiddenFileName}"))`);
    await expect(hiddenFileRow).toBeVisible({ timeout: 15000 });

    // "Gizli dosyalar" kutusu kontrolü: Kapatıldığında gizlenmeli, açıldığında tekrar görünmeli
    const hiddenCheckbox = page.locator('label.yf-hidden input[type="checkbox"]');
    if (await hiddenCheckbox.isVisible({ timeout: 5000 }).catch(() => false)) {
      await hiddenCheckbox.uncheck();
      await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testHiddenFileName}"))`)).toHaveCount(0, { timeout: 10000 });
      await hiddenCheckbox.check();
      await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testHiddenFileName}"))`)).toBeVisible({ timeout: 10000 });
    }

    // 6. Normal dosya oluşturma, düzenleme ve kaydetme
    await newFileBtn.click();
    const createFileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createFileModal).toBeVisible({ timeout: 10000 });
    await createFileModal.locator('input').fill(testFileName);
    await createFileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(createFileModal).toHaveCount(0, { timeout: 15000 });

    const createdFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
    await expect(createdFileRow).toBeVisible({ timeout: 15000 });

    // İndir bağlantısından resolvedWebsiteId tespit et
    const downloadLink = createdFileRow.locator('a[download]');
    await expect(downloadLink).toBeVisible({ timeout: 10000 });
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toBeTruthy();
    const websiteMatch = downloadHref.match(/\/websites\/([^/?#]+)\/files\/download/);
    expect(websiteMatch).toBeTruthy();
    resolvedWebsiteId = decodeURIComponent(websiteMatch[1]);

    // Inline editör ile düzenle
    const editBtn = createdFileRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]');
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    // Editor modalının açıldığını doğrula
    const editorTextarea = page.locator('dialog.ws-modal textarea, .yf-editor textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 15000 });
    await editorTextarea.fill(testFileContent);

    const saveBtn = page.locator('dialog.ws-modal button[type="submit"]:has-text("Kaydet"), form button[type="submit"]:has-text("Kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(page.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });

    // Editör modalını kapatmak ve temiz File Manager görünümüne dönmek için sayfayı yenile / kök files rotasına git
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('dialog.ws-modal-wide')).toHaveCount(0, { timeout: 10000 });

    // 7. Klasör oluşturma
    await expect(newFolderBtn).toBeVisible({ timeout: 10000 });
    await newFolderBtn.click();
    const createFolderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(createFolderModal).toBeVisible({ timeout: 10000 });
    await createFolderModal.locator('input').fill(testFolderName);
    await createFolderModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(createFolderModal).toHaveCount(0, { timeout: 15000 });

    const createdFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFolderName}"))`);
    await expect(createdFolderRow).toBeVisible({ timeout: 15000 });

    // 8. Fiziksel Sonuç Kanıtı: API üzerinden dosya sorgusu ve indirme doğrulaması
    expect(resolvedWebsiteId).toBeTruthy();

    // A) Dosya listeleme API sorgusu
    const listRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files?path=`);
    expect(listRes.ok()).toBeTruthy();
    const listData = await listRes.json();
    const items = listData.data?.entries || listData.entries || listData.files || listData.items || (Array.isArray(listData) ? listData : []);
    const foundNormal = items.some((item) => item.name === testFileName);
    const foundHidden = items.some((item) => item.name === testHiddenFileName);
    const foundFolder = items.some((item) => item.name === testFolderName);
    expect(foundNormal).toBeTruthy();
    expect(foundHidden).toBeTruthy();
    expect(foundFolder).toBeTruthy();

    // B) Fiziksel indirme ve içerik bütünlüğü doğrulaması
    const downloadRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=${encodeURIComponent(testFileName)}`);
    expect(downloadRes.ok()).toBeTruthy();
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe(testFileContent);
  });

  test('hatalı girdi ve sınır senaryosu: yetkisiz dizine kaçış (path traversal) ve geçersiz yol talepleri reddedilir', async ({ page }) => {
    // 1. Önce Global Files rotasına git ve sayfayı doğrula
    await page.goto('/files');
    await page.waitForLoadState('networkidle').catch(() => {});
    await ensureSession(page);

    // Gerekirse website ve domain ID'sini tespit et
    if (!resolvedWebsiteId || !resolvedDomainId) {
      if (page.url().match(/\/websites\/([^/?#]+)\/files/)) {
        resolvedDomainId = page.url().match(/\/websites\/([^/?#]+)\/files/)[1];
      } else {
        const link = page.locator('table.ws-table tbody tr a:has-text("Dosya Yöneticisi")').first();
        if (await link.isVisible({ timeout: 5000 }).catch(() => false)) {
          const href = await link.getAttribute('href');
          const m = href ? href.match(/\/websites\/([^/?#]+)\/files/) : null;
          if (m) resolvedDomainId = m[1];
        }
      }
      if (resolvedDomainId) {
        await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
        await page.waitForLoadState('networkidle').catch(() => {});
        const dl = page.locator('table.yf-table a[download]').first();
        if (await dl.isVisible({ timeout: 5000 }).catch(() => false)) {
          const href = await dl.getAttribute('href');
          const wm = href ? href.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
          if (wm) resolvedWebsiteId = decodeURIComponent(wm[1]);
        }
      }
    }

    expect(resolvedWebsiteId).toBeTruthy();
    const testSiteId = resolvedWebsiteId;
    const testDomainId = resolvedDomainId || resolvedWebsiteId;

    // 2. Path Traversal koruması (Relative traversal, Absolute shadow, Null byte)
    const relResp = await page.request.get(`/api/panel/websites/${encodeURIComponent(testSiteId)}/files/download?path=../../../../etc/passwd`);
    expect([400, 404]).toContain(relResp.status());

    const absResp = await page.request.get(`/api/panel/websites/${encodeURIComponent(testSiteId)}/files/download?path=/etc/shadow`);
    expect([400, 404]).toContain(absResp.status());

    const nullResp = await page.request.get(`/api/panel/websites/${encodeURIComponent(testSiteId)}/files/download?path=test%00.txt`);
    expect([400, 404]).toContain(nullResp.status());

    // 3. UI URL parametresinde geçersiz yol verildiğinde kök dizine sanitize edildiğini doğrula
    await page.goto(`/websites/${encodeURIComponent(testDomainId)}/files?path=../../etc`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await ensureSession(page);
    await expect(page.locator('.yf-header h2', { hasText: 'Dosya yöneticisi' })).toBeVisible({ timeout: 15000 });
    // Sayfa çökmeksizin site kökü breadcrumb'ında kalmalıdır
    await expect(page.locator('nav[aria-label="Dosya konumu"] button:has-text("Site kökü")')).toBeVisible({ timeout: 10000 });

    // 4. Arayüzde boş veya slash içeren dosya adı oluşturma engeli
    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn).toBeVisible({ timeout: 10000 });
    await newFileBtn.click();

    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createModal).toBeVisible({ timeout: 10000 });

    const submitBtn = createModal.locator('button[type="submit"]:has-text("Oluştur")');
    // Boşken submit butonu disabled olmalıdır
    await expect(submitBtn).toBeDisabled();

    // Slash içeren geçersiz dosya adı girildiğinde submit engellenmeli veya geçersiz sayılmalıdır
    await createModal.locator('input').fill('sub/invalid.txt');
    await expect(submitBtn).toBeDisabled();

    // Modalı kapat
    await createModal.locator('button:has-text("Vazgeç")').click();
    await expect(createModal).toHaveCount(0, { timeout: 5000 });
  });
});
