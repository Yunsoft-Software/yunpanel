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

test.describe('DOS-06 Kopyalama ve taşıma; çakışma/onay davranışı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const prefix = `tdos06-a${agentN}-${timestamp}`;

  const destFolder = `${prefix}-dst`;
  const copyFile = `${prefix}-cp.txt`;
  const moveFile = `${prefix}-mv.txt`;
  const conflictFile = `${prefix}-cf.txt`;

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
    if (resolvedWebsiteId) {
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
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 5 -name 'tdos06-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: dosya kopyalama ve taşıma, hedef dizine yerleşme ve fiziksel sunucu doğrulaması', async ({ page }) => {
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
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Sitenin websiteId'sini indir bağlantısından da çöz
    const anyDownloadLink = page.locator('table.yf-table a[download]').first();
    if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const dHref = await anyDownloadLink.getAttribute('href');
      const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // =========================================================================
    // ADIM 1: Hedef klasör oluştur (destFolder)
    // =========================================================================
    const newFolderBtn = page.locator('button:has-text("Yeni Klasör")');
    await expect(newFolderBtn).toBeVisible({ timeout: 15000 });
    await newFolderBtn.click();

    const folderModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni klasör' });
    await expect(folderModal).toBeVisible({ timeout: 10000 });
    await folderModal.locator('input').fill(destFolder);
    const folderSubmitBtn = folderModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(folderSubmitBtn).toBeEnabled();
    await folderSubmitBtn.click();
    await expect(folderModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    const destFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${destFolder}"))`);
    await expect(destFolderRow).toBeVisible({ timeout: 15000 });
    createdItems.add(destFolder);

    // =========================================================================
    // ADIM 2: Kopyalanacak kaynak dosya oluştur (copyFile)
    // =========================================================================
    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn).toBeVisible({ timeout: 15000 });
    await newFileBtn.click();

    const fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });
    await fileModal.locator('input').fill(copyFile);
    const fileSubmitBtn = fileModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(fileSubmitBtn).toBeEnabled();
    await fileSubmitBtn.click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    const copyFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${copyFile}"))`);
    await expect(copyFileRow).toBeVisible({ timeout: 15000 });
    createdItems.add(copyFile);

    // =========================================================================
    // ADIM 3: DOSYA KOPYALAMA (Copy)
    // =========================================================================
    // Tablodan copyFile öğesini seç
    const copyCheckbox = copyFileRow.locator('input[type="checkbox"]');
    await expect(copyCheckbox).toBeEnabled({ timeout: 10000 });
    await copyCheckbox.click();

    const selectionBar = page.locator('div.yf-selection-actions');
    await expect(selectionBar).toBeVisible({ timeout: 10000 });

    const copyBtn = selectionBar.locator('button:has-text("Kopyala")');
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();

    const copyModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Kopyala' });
    await expect(copyModal).toBeVisible({ timeout: 10000 });

    const destInput = copyModal.locator('label:has-text("Hedef Klasör") input');
    await destInput.fill(destFolder);

    const copySubmitBtn = copyModal.locator('button[type="submit"]:has-text("Kopyala")');
    await expect(copySubmitBtn).toBeEnabled();
    await copySubmitBtn.click();

    // Modal kapanmalı ve başarı geri bildirimi gelmeli
    await expect(copyModal).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.yf-feedback')).toContainText('kopyalandı', { timeout: 15000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Kök dizinde kaynak dosya hâlâ mevcut olmalı (kopyalama işlemi)
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${copyFile}"))`)).toBeVisible({ timeout: 10000 });

    // Hedef klasörün içine gir ve kopyalanan dosyanın orada olduğunu doğrula
    const destFolderEntry = page.locator(`button.yf-entry.is-folder:has(strong:has-text("${destFolder}"))`);
    await expect(destFolderEntry).toBeEnabled({ timeout: 10000 });
    await destFolderEntry.click();

    // Breadcrumb hedef klasörü göstermeli
    const locationNav = page.locator('nav[aria-label="Dosya konumu"]');
    await expect(locationNav.locator(`button:has-text("${destFolder}")`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Hedef klasör listesinde kopyalanan dosya görünmeli
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${copyFile}"))`)).toBeVisible({ timeout: 15000 });

    // Fiziksel doğrulama (SSH): Dosya hem kök dizinde hem de destFolder altında mevcut olmalı
    const sshCopyFind = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 5 -name '${copyFile}' 2>/dev/null`);
    expect(sshCopyFind).toContain(copyFile);
    expect(sshCopyFind).toContain(destFolder);

    // =========================================================================
    // ADIM 4: DOSYA TAŞIMA (Move)
    // =========================================================================
    // Kök dizine geri dön
    await locationNav.locator('button:has-text("Site kökü")').click();
    await expect(locationNav.locator('button:has-text("Site kökü")')).toHaveAttribute('aria-current', 'location', { timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Taşınacak ikinci bir dosya oluştur (moveFile)
    await newFileBtn.click();
    const moveFileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(moveFileModal).toBeVisible({ timeout: 10000 });
    await moveFileModal.locator('input').fill(moveFile);
    await moveFileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(moveFileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    const moveFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${moveFile}"))`);
    await expect(moveFileRow).toBeVisible({ timeout: 15000 });
    createdItems.add(moveFile);

    // moveFile seç ve Taşı dialogunu aç
    const moveCheckbox = moveFileRow.locator('input[type="checkbox"]');
    await expect(moveCheckbox).toBeEnabled({ timeout: 10000 });
    await moveCheckbox.click();

    await expect(selectionBar).toBeVisible({ timeout: 10000 });
    const moveBtn = selectionBar.locator('button:has-text("Taşı")');
    await expect(moveBtn).toBeVisible();
    await moveBtn.click();

    const moveModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Taşı' });
    await expect(moveModal).toBeVisible({ timeout: 10000 });

    const moveDestInput = moveModal.locator('label:has-text("Hedef Klasör") input');
    await moveDestInput.fill(destFolder);

    const moveSubmitBtn = moveModal.locator('button[type="submit"]:has-text("Taşı")');
    await expect(moveSubmitBtn).toBeEnabled();
    await moveSubmitBtn.click();

    // Modal kapanmalı ve taşıma bildirimi gelmeli
    await expect(moveModal).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.yf-feedback')).toContainText('taşındı', { timeout: 15000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // KÖK DİZİNDE ARTIK OLMAMALI (taşındı)
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${moveFile}"))`)).toHaveCount(0, { timeout: 10000 });

    // Hedef klasöre gir
    await page.locator(`button.yf-entry.is-folder:has(strong:has-text("${destFolder}"))`).click();
    await expect(locationNav.locator(`button:has-text("${destFolder}")`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Hedef klasörde taşınan dosya görünmeli
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${moveFile}"))`)).toBeVisible({ timeout: 15000 });

    // Fiziksel doğrulama (SSH): moveFile yalnız destFolder içinde bulunmalı, kök dizinde bulunmamalı
    const sshMoveFind = runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 5 -name '${moveFile}' 2>/dev/null`);
    expect(sshMoveFind).toContain(destFolder);
    expect(sshMoveFind.split('\n').filter(Boolean).length).toBe(1);

    // Kök dizine dönerek temiz bir durumda bırak
    await locationNav.locator('button:has-text("Site kökü")').click();
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });
  });

  test('çakışma ve hatalı girdi: geçersiz hedef yolu, kendi içine kopyalama engeli ve taşımada dosya çakışması', async ({ page }) => {
    // Dosya yöneticisi arayüzünü aç
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    const browserSection = page.locator('section.yf-browser, section[aria-label="Site dosya yöneticisi"]');
    await expect(browserSection).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    const selectionBar = page.locator('div.yf-selection-actions');
    const locationNav = page.locator('nav[aria-label="Dosya konumu"]');

    // =========================================================================
    // 1. GEÇERSİZ HEDEF YOLU (Path Traversal engeli)
    // =========================================================================
    const copyFileRow = page.locator(`tr[role="row"]:has(strong:has-text("${copyFile}"))`);
    await expect(copyFileRow).toBeVisible({ timeout: 15000 });
    const copyCheck = copyFileRow.locator('input[type="checkbox"]');
    await expect(copyCheck).toBeEnabled({ timeout: 10000 });
    await copyCheck.click();

    await expect(selectionBar).toBeVisible({ timeout: 10000 });
    await selectionBar.locator('button:has-text("Kopyala")').click();

    const copyModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Kopyala' });
    await expect(copyModal).toBeVisible({ timeout: 10000 });

    const destInput = copyModal.locator('label:has-text("Hedef Klasör") input');
    await destInput.fill('../../disari');
    await copyModal.locator('button[type="submit"]:has-text("Kopyala")').click();

    // Hata mesajı modal içinde görünmeli ve işlem engellenmeli
    const errorNotice1 = copyModal.locator('[role="alert"].ws-notice-error, [role="alert"]');
    await expect(errorNotice1).toBeVisible({ timeout: 10000 });
    await expect(errorNotice1).toContainText('Hedef klasör yolu geçersiz');

    // Vazgeç ile modalı kapat
    await copyModal.locator('button:has-text("Vazgeç")').click();
    await expect(copyModal).toHaveCount(0, { timeout: 10000 });

    // Seçimi kaldır
    if (await copyCheck.isChecked()) await copyCheck.click();

    // =========================================================================
    // 2. BİR KLASÖRÜN KENDİ İÇİNE KOPYALANMASI / TAŞINMASI ENGELİ
    // =========================================================================
    const destFolderRow = page.locator(`tr[role="row"]:has(strong:has-text("${destFolder}"))`);
    await expect(destFolderRow).toBeVisible({ timeout: 15000 });
    const destCheck = destFolderRow.locator('input[type="checkbox"]');
    await expect(destCheck).toBeEnabled({ timeout: 10000 });
    await destCheck.click();

    await expect(selectionBar).toBeVisible({ timeout: 10000 });
    await selectionBar.locator('button:has-text("Kopyala")').click();
    await expect(copyModal).toBeVisible({ timeout: 10000 });

    // Hedef klasör olarak kendisini yaz
    await destInput.fill(destFolder);
    await copyModal.locator('button[type="submit"]:has-text("Kopyala")').click();

    const errorNotice2 = copyModal.locator('[role="alert"].ws-notice-error, [role="alert"]');
    await expect(errorNotice2).toBeVisible({ timeout: 10000 });
    await expect(errorNotice2).toContainText('Bir klasör kendi içine veya alt klasörlerine kopyalanamaz/taşınamaz');

    await copyModal.locator('button:has-text("Vazgeç")').click();
    await expect(copyModal).toHaveCount(0, { timeout: 10000 });
    if (await destCheck.isChecked()) await destCheck.click();

    // =========================================================================
    // 3. TAŞIMA SIRASINDA ÇAKIŞMA (Hedefte aynı adlı dosya mevcutken taşıma engeli)
    // =========================================================================
    // Kök dizinde conflictFile oluştur
    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    await newFileBtn.click();
    const fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });
    await fileModal.locator('input').fill(conflictFile);
    await fileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    const conflictRow = page.locator(`tr[role="row"]:has(strong:has-text("${conflictFile}"))`);
    await expect(conflictRow).toBeVisible({ timeout: 15000 });
    createdItems.add(conflictFile);

    // conflictFile'ı önce destFolder içine KOPYALA ki destFolder altında da aynı isimli dosya oluşsun
    const conflictCheck = conflictRow.locator('input[type="checkbox"]');
    await expect(conflictCheck).toBeEnabled({ timeout: 10000 });
    await conflictCheck.click();
    await selectionBar.locator('button:has-text("Kopyala")').click();
    await expect(copyModal).toBeVisible({ timeout: 10000 });
    await destInput.fill(destFolder);
    await copyModal.locator('button[type="submit"]:has-text("Kopyala")').click();
    await expect(copyModal).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator('.yf-feedback')).toContainText('kopyalandı', { timeout: 15000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });

    // Seçim durumunu kontrol et
    if (await conflictCheck.isChecked()) await conflictCheck.click();

    // Şimdi kök dizindeki conflictFile'ı destFolder içine TAŞIMAYA çalış
    // destFolder içinde conflictFile zaten var olduğu için backend rename 409 site_file_exists verecektir!
    await conflictCheck.click();
    await selectionBar.locator('button:has-text("Taşı")').click();

    const moveModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Taşı' });
    await expect(moveModal).toBeVisible({ timeout: 10000 });

    const moveDestInput = moveModal.locator('label:has-text("Hedef Klasör") input');
    await moveDestInput.fill(destFolder);
    await moveModal.locator('button[type="submit"]:has-text("Taşı")').click();

    // Çakışma hatasının modal içinde görünmesi beklenir (Destination already exists)
    const errorNotice3 = moveModal.locator('[role="alert"].ws-notice-error, [role="alert"]');
    await expect(errorNotice3).toBeVisible({ timeout: 10000 });
    await expect(errorNotice3).toContainText('Destination already exists');

    // Modalı kapat
    await moveModal.locator('button:has-text("Vazgeç")').click();
    await expect(moveModal).toHaveCount(0, { timeout: 10000 });

    // Her iki dosyanın da korunduğunu doğrula:
    // 1. Kök dizindeki conflictFile yerinde duruyor
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${conflictFile}"))`)).toBeVisible({ timeout: 10000 });

    // 2. destFolder içindeki conflictFile da yerinde duruyor
    await page.locator(`button.yf-entry.is-folder:has(strong:has-text("${destFolder}"))`).click();
    await expect(locationNav.locator(`button:has-text("${destFolder}")`)).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.yf-busy')).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${conflictFile}"))`)).toBeVisible({ timeout: 10000 });

    // Kök dizine dön
    await locationNav.locator('button:has-text("Site kökü")').click();
  });
});
