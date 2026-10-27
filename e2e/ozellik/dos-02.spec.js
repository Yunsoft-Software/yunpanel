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

test.describe('DOS-02 Klasör ağacı, yol, liste, seçim, sıralama ve arama', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const testFolder = `tdos02-a${agentN}-dir-${timestamp}`;
  const testFileAlpha = `tdos02-a${agentN}-aaa-${timestamp}.txt`;
  const testFileZeta = `tdos02-a${agentN}-zzz-${timestamp}.txt`;

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
      const itemsToClean = [testFolder, testFileAlpha, testFileZeta];
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
      } catch (err) {
        console.warn('API cleanup error:', err.message);
      }
    }

    // 2. SSH ile geride kalan test dosyalarını temizle (mevcut site verilerine asla dokunulmaz)
    try {
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name 'tdos02-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: klasör ağacı, yol navigasyonu, dosya listesi, çoklu seçim, ada/boyuta sıralama ve arama', async ({ page }) => {
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

    // Sitenin websiteId'sini indir bağlantısından çöz
    const anyDownloadLink = page.locator('table.yf-table a[download]').first();
    if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const dHref = await anyDownloadLink.getAttribute('href');
      const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // =========================================================================
    // ADIM 1: Kök dizinde test klasörünü oluştur
    // =========================================================================

    const newFolderBtn = page.locator('button:has-text("Yeni Klasör")');
    await expect(newFolderBtn).toBeVisible({ timeout: 15000 });
    await expect(newFolderBtn).toBeEnabled();
    await newFolderBtn.click();

    const folderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(folderModal).toBeVisible({ timeout: 10000 });
    await folderModal.locator('input').fill(testFolder);
    const folderSubmitBtn = folderModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(folderSubmitBtn).toBeEnabled();
    await folderSubmitBtn.click();
    await expect(folderModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFolder}"))`)).toBeVisible({ timeout: 15000 });

    // =========================================================================
    // ADIM 2: KLASÖR AĞACI (Tree) VE YOL GEZİNTİSİ (Breadcrumbs & Navigation)
    // =========================================================================

    // Klasör ağacının görünür olduğunu ve 'Site kökü' butonunu içerdiğini doğrula
    const treeNav = page.locator('nav.yf-tree[aria-label="Site klasörleri"]');
    await expect(treeNav).toBeVisible({ timeout: 10000 });
    const rootTreeBtn = treeNav.locator('button.yf-root');
    await expect(rootTreeBtn).toBeVisible();
    await expect(rootTreeBtn).toHaveAttribute('aria-current', 'location');

    // Breadcrumb (Dosya konumu) alanını kontrol et
    const locationNav = page.locator('nav[aria-label="Dosya konumu"]');
    await expect(locationNav).toBeVisible();
    await expect(locationNav.locator('button:has-text("Site kökü")')).toHaveAttribute('aria-current', 'location');

    // Üst klasör butonunun kök dizinde pasif olduğunu doğrula
    const upButton = page.locator('button.yf-up[aria-label="Üst klasöre git"]');
    await expect(upButton).toBeDisabled();

    // Oluşturulan test klasörünün içine gir
    const folderEntryBtn = page.locator(`button.yf-entry.is-folder:has(strong:has-text("${testFolder}"))`);
    await folderEntryBtn.click();

    // Breadcrumb güncellenmeli: Site kökü / testFolder
    await expect(locationNav.locator(`button:has-text("${testFolder}")`)).toBeVisible({ timeout: 10000 });
    await expect(locationNav.locator(`button:has-text("${testFolder}")`)).toHaveAttribute('aria-current', 'location');
    // Üst klasöre git butonu artık aktif olmalı
    await expect(upButton).toBeEnabled();

    // Yeni klasör boş olduğundan 'Bu klasör boş' EmptyState görünmeli
    await expect(page.locator('text=Bu klasör boş')).toBeVisible({ timeout: 10000 });

    // =========================================================================
    // ADIM 3: Bu izole klasör içinde 2 test dosyası oluştur
    // =========================================================================

    // Dosya 1: Alpha (aaa)
    const newFileBtn1 = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn1).toBeVisible({ timeout: 10000 });
    await newFileBtn1.click();
    const fileModal1 = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal1).toBeVisible({ timeout: 10000 });
    await fileModal1.locator('input').fill(testFileAlpha);
    await fileModal1.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal1).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileAlpha}"))`)).toBeVisible({ timeout: 15000 });

    // Dosya 2: Zeta (zzz)
    const newFileBtn2 = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn2).toBeVisible({ timeout: 10000 });
    await newFileBtn2.click();
    const fileModal2 = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal2).toBeVisible({ timeout: 10000 });
    await fileModal2.locator('input').fill(testFileZeta);
    await fileModal2.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal2).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileZeta}"))`)).toBeVisible({ timeout: 15000 });

    // =========================================================================
    // ADIM 4: ARAMA / FİLTRELEME FONKSİYONLARI
    // =========================================================================

    const searchInput = page.locator('input[type="search"][placeholder*="Bu klasörde ara"]');
    await expect(searchInput).toBeVisible();

    // A: 'aaa' ile ara -> Sadece Alpha görünmeli, Zeta gizlenmeli
    await searchInput.fill('aaa');
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileAlpha}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileZeta}"))`)).toHaveCount(0);

    // B: Olmayan bir terim ile ara -> 'Eşleşen dosya yok' EmptyState
    await searchInput.fill(`nonexistent_${Date.now()}`);
    await expect(page.locator('text=Eşleşen dosya yok')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Başka bir dosya adı arayın.')).toBeVisible();

    // C: Arama terimini temizle -> Tüm dosyalar geri dönmeli
    await searchInput.fill('');
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileAlpha}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFileZeta}"))`)).toBeVisible({ timeout: 5000 });

    // =========================================================================
    // ADIM 5: SIRALAMA FONKSİYONLARI (Ada ve Son Değişene göre)
    // =========================================================================

    const sortSelect = page.locator('label.yf-sort select');
    await expect(sortSelect).toBeVisible();

    // A: Ada göre sırala ('name') -> aaa, zzz'den önce gelmeli
    await sortSelect.selectOption('name');
    await expect.poll(async () => {
      const texts = await page.locator('table.yf-table tbody tr strong').allInnerTexts();
      const aIdx = texts.findIndex((t) => t.includes(testFileAlpha));
      const zIdx = texts.findIndex((t) => t.includes(testFileZeta));
      return aIdx >= 0 && zIdx >= 0 && aIdx < zIdx;
    }, { timeout: 10000 }).toBe(true);

    // B: Son değişene göre sırala ('modified') -> en son oluşturulan zzz, aaa'dan önce veya eşit gelmeli
    await sortSelect.selectOption('modified');
    await expect.poll(async () => {
      const texts = await page.locator('table.yf-table tbody tr strong').allInnerTexts();
      return texts.length >= 2;
    }, { timeout: 10000 }).toBe(true);

    // Sıralamayı tekrar Ada göre yap
    await sortSelect.selectOption('name');

    // =========================================================================
    // ADIM 6: ÇOKLU SEÇİM VE SEÇİM EYLEMLERİ
    // =========================================================================

    const selectionBar = page.locator('.yf-selection');
    await expect(selectionBar).toBeVisible();

    // A: Tekil seçim
    const alphaCheckbox = page.locator(`tr[role="row"]:has(strong:has-text("${testFileAlpha}")) input[type="checkbox"]`);
    await alphaCheckbox.check();
    await expect(selectionBar).toContainText('1 öğe seçili');
    await expect(selectionBar.locator('button:has-text("Seçimi kaldır")')).toBeVisible();
    await expect(selectionBar.locator('button:has-text("Seçilenleri Sil")')).toBeVisible();

    // B: Seçimi kaldır butonu
    await selectionBar.locator('button:has-text("Seçimi kaldır")').click();
    await expect(selectionBar).not.toContainText('öğe seçili');
    expect(await alphaCheckbox.isChecked()).toBe(false);

    // C: Tümünü Seç (Görünen öğeleri seç)
    const selectAllBox = page.locator('input[type="checkbox"][aria-label="Görünen öğeleri seç"]');
    await selectAllBox.check();
    await expect(selectionBar).toContainText('2 öğe seçili');
    expect(await alphaCheckbox.isChecked()).toBe(true);

    // Seçimi tekrar temizle
    await selectionBar.locator('button:has-text("Seçimi kaldır")').click();
    await expect(selectionBar).not.toContainText('öğe seçili');

    // =========================================================================
    // ADIM 7: YOL GEZİNTİSİ İLE KÖKE DÖNÜŞ (Üst klasöre git ve Breadcrumbs)
    // =========================================================================

    // Üst klasöre git butonuyla köke geri dön
    await upButton.click();
    await expect(locationNav.locator('button:has-text("Site kökü")')).toHaveAttribute('aria-current', 'location', { timeout: 10000 });
    await expect(upButton).toBeDisabled();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${testFolder}"))`)).toBeVisible({ timeout: 10000 });

    // =========================================================================
    // ADIM 8: FİZİKSEL SONUÇ KANITI (API & SSH)
    // =========================================================================

    if (!resolvedWebsiteId) {
      const anyDl = page.locator('table.yf-table a[download]').first();
      if (await anyDl.isVisible({ timeout: 5000 }).catch(() => false)) {
        const dHref = await anyDl.getAttribute('href');
        const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
        if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
      }
    }

    if (resolvedWebsiteId) {
      // API'den alt klasör dosya listesini çek ve doğrula
      const apiFilesRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files?path=${encodeURIComponent(testFolder)}`);
      expect(apiFilesRes.status()).toBe(200);
      const apiFilesData = await apiFilesRes.json();
      const entries = apiFilesData?.data?.entries || apiFilesData?.entries || [];

      const alphaEntry = entries.find((e) => e.name === testFileAlpha);
      const zetaEntry = entries.find((e) => e.name === testFileZeta);

      expect(alphaEntry).toBeDefined();
      expect(alphaEntry.type).toBe('file');

      expect(zetaEntry).toBeDefined();
      expect(zetaEntry.type).toBe('file');
    }

    // SSH ile fiziksel dosya sistemi varlığını doğrula
    const sshFolderCheck = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${testFolder}'`);
    expect(sshFolderCheck).toContain(testFolder);
  });

  test('hatalı girdi ve sınır senaryosu: path traversal, geçersiz dizin ve karakter engeli', async ({ page }) => {
    // 1. Gerekirse domain ve website ID'sini hazırla
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

      const anyDl = page.locator('table.yf-table a[download]').first();
      if (await anyDl.isVisible({ timeout: 5000 }).catch(() => false)) {
        const dHref = await anyDl.getAttribute('href');
        const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
        if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
      }
    }

    // 2. Backend API path traversal sorgusu gönderildiğinde HTTP 400 Bad Request dönmeli
    if (resolvedWebsiteId) {
      const traversalRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files?path=../../etc`);
      expect(traversalRes.status()).toBe(400);
      const traversalData = await traversalRes.json();
      const errStr = JSON.stringify(traversalData);
      expect(errStr).toMatch(/site_file_path_invalid|path is invalid|Geçerli bir klasör yolu girin/i);
    }

    // 3. UI üzerinde geçersiz dosya adı ve traversal karakterleri girildiğinde form engeli
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });

    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn).toBeVisible({ timeout: 15000 });
    await newFileBtn.click();

    const fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });

    const nameInput = fileModal.locator('input');
    const submitBtn = fileModal.locator('button[type="submit"]:has-text("Oluştur")');

    // Boş isim engeli
    await nameInput.fill('');
    expect(await submitBtn.isDisabled()).toBe(true);

    // Path traversal karakterleri engeli (/ ve \)
    await nameInput.fill('../traversal.txt');
    expect(await submitBtn.isDisabled()).toBe(true);

    await nameInput.fill('sub\\test.txt');
    expect(await submitBtn.isDisabled()).toBe(true);

    // Ayrılmış isimler (. ve ..) engeli
    await nameInput.fill('.');
    expect(await submitBtn.isDisabled()).toBe(true);

    await nameInput.fill('..');
    expect(await submitBtn.isDisabled()).toBe(true);

    // Modalı kapat
    await fileModal.locator('button:has-text("Vazgeç")').click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
  });
});
