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

test.describe('DOS-09 Dosya adı/içerik araması, gizli dosyalar, izinler', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const prefix = `tdos09-a${agentN}-${timestamp}`;

  const testFolder = `${prefix}-dir`;
  const normalFile = `${prefix}-normal.txt`;
  const hiddenFile = `.${prefix}-hidden.env`;
  const searchableFile = `${prefix}-searchable.txt`;
  const searchContentNeedle = `DOS09_NEEDLE_${timestamp.toUpperCase()}_42`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;

  test.beforeEach(async ({ page }) => {
    page.on('request', (req) => {
      const match = req.url().match(/\/api\/(?:panel\/)?websites\/([^/?#]+)\/files/);
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

        await page.request.delete(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files`, {
          headers: { origin, 'x-csrf-token': csrfToken },
          data: {
            path: testFolder,
            confirmation: `delete:${resolvedWebsiteId}:${testFolder}`,
          },
        }).catch(() => {});

        await context.close().catch(() => {});
      } catch (err) {
        console.warn('API cleanup error:', err.message);
      }
    }

    // 2. SSH ile geride kalan test kalıntılarını temizle (mevcut site verilerine asla dokunulmaz)
    try {
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name 'tdos09-a${agentN}-*' -exec rm -rf {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: dosya adı araması, gizli dosyalar görünürlüğü, chmod izinlerini değiştirme ve sunucuda stat/ls doğrulaması', async ({ page }) => {
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

    // Sitenin websiteId'sini indir bağlantısından çöz (henüz çözülmediyse)
    const anyDownloadLink = page.locator('table.yf-table a[download]').first();
    if (await anyDownloadLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      const dHref = await anyDownloadLink.getAttribute('href');
      const wMatch = dHref ? dHref.match(/\/websites\/([^/?#]+)\/files\/download/) : null;
      if (wMatch) resolvedWebsiteId = decodeURIComponent(wMatch[1]);
    }

    // =========================================================================
    // ADIM 1: Kök dizinde izole test klasörünü oluştur ve içine gir
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

    // Klasöre tıkla ve içine gir
    const folderEntryBtn = page.locator(`button.yf-entry.is-folder:has(strong:has-text("${testFolder}"))`);
    await expect(folderEntryBtn).toBeVisible({ timeout: 15000 });
    await folderEntryBtn.click();

    const locationNav = page.locator('nav[aria-label="Dosya konumu"]');
    await expect(locationNav.locator(`button:has-text("${testFolder}")`)).toBeVisible({ timeout: 10000 });

    // =========================================================================
    // ADIM 2: Normal dosya, gizli dosya (.env) ve aranabilir dosya oluştur
    // =========================================================================
    // 2.1 Normal dosya
    const newFileBtn = page.locator('button:has-text("Yeni Dosya")');
    await expect(newFileBtn).toBeVisible({ timeout: 10000 });
    await newFileBtn.click();

    let fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });
    await fileModal.locator('input').fill(normalFile);
    await fileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`)).toBeVisible({ timeout: 15000 });

    // 2.2 Gizli dosya (.env)
    await newFileBtn.click();
    fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });
    await fileModal.locator('input').fill(hiddenFile);
    await fileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).toBeVisible({ timeout: 15000 });

    // 2.3 İçerik aranabilir dosya
    await newFileBtn.click();
    fileModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(fileModal).toBeVisible({ timeout: 10000 });
    await fileModal.locator('input').fill(searchableFile);
    await fileModal.locator('button[type="submit"]:has-text("Oluştur")').click();
    await expect(fileModal).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).toBeVisible({ timeout: 15000 });

    // =========================================================================
    // ADIM 3: DOSYA ADI ARAMASI (File Name Search)
    // =========================================================================
    const searchInput = page.locator('.yf-tools input[type="search"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // "normal" araması yap
    await searchInput.fill(`${prefix}-normal`);
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).not.toBeVisible();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).not.toBeVisible();

    // "searchable" araması yap
    await searchInput.fill(`${prefix}-searchable`);
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`)).not.toBeVisible();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).not.toBeVisible();

    // Arama kutusunu temizle
    await searchInput.fill('');
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).toBeVisible({ timeout: 5000 });

    // =========================================================================
    // ADIM 4: GİZLİ DOSYALAR (Hidden Files Filter Toggle)
    // =========================================================================
    const hiddenLabel = page.locator('label.yf-hidden');
    await expect(hiddenLabel).toBeVisible({ timeout: 10000 });
    const hiddenCheckbox = hiddenLabel.locator('input[type="checkbox"]');
    await expect(hiddenCheckbox).toBeChecked();

    // Gizli dosyaları gizle (uncheck)
    await hiddenCheckbox.uncheck();
    await expect(hiddenCheckbox).not.toBeChecked();

    // Gizli dosya artık listede görünmemeli, normal dosyalar görünmeli
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).not.toBeVisible();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`)).toBeVisible();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).toBeVisible();

    // Gizli dosyaları tekrar göster (check)
    await hiddenCheckbox.check();
    await expect(hiddenCheckbox).toBeChecked();
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${hiddenFile}"))`)).toBeVisible({ timeout: 5000 });

    // =========================================================================
    // ADIM 5: İZİNLER (Permissions / Chmod Modal & Mutation)
    // =========================================================================
    const normalRow = page.locator(`tr[role="row"]:has(strong:has-text("${normalFile}"))`);
    await expect(normalRow).toBeVisible();

    // İlk izin değeri 0640 olmalıdır
    const permSpan = normalRow.locator('.yf-perm');
    await expect(permSpan).toHaveText(/0?640/);

    // İşlemler butonuna tıkla
    const actionsBtn = normalRow.locator('button[title="Dosya işlemleri"], button[aria-label*="işlemleri"]');
    await actionsBtn.click();

    // Detay modalında "İzinler" butonuna tıkla
    const detailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: normalFile });
    await expect(detailsModal).toBeVisible({ timeout: 10000 });
    const permissionsBtn = detailsModal.locator('button:has-text("İzinler")');
    await expect(permissionsBtn).toBeVisible();
    await permissionsBtn.click();

    // İzinler modalının açıldığını doğrula
    const permModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: `İzinler: ${normalFile}` });
    await expect(permModal).toBeVisible({ timeout: 10000 });

    // Sekizli izin göstergesi ilk değeri 0640 olmalı
    const octalCode = permModal.locator('code.yf-permissions-octal');
    await expect(octalCode).toHaveText(/0?640/);

    // İzin tablosunda: Diğer -> Okuma (r) iznini aktif et (0640 -> 0644)
    // Diğer satırındaki ilk checkbox (Okuma)
    const othersRow = permModal.locator('.yf-permissions-grid tbody tr').filter({ hasText: 'Diğer' });
    await expect(othersRow).toBeVisible();
    const othersReadCb = othersRow.locator('input[type="checkbox"]').first();
    await expect(othersReadCb).not.toBeChecked();
    await othersReadCb.check();

    // Sekizli değer 0644 olarak güncellenmelidir
    await expect(octalCode).toHaveText('0644');

    // İzinleri Kaydet
    const savePermBtn = permModal.locator('button[type="submit"]:has-text("İzinleri Kaydet")');
    await expect(savePermBtn).toBeEnabled();
    await savePermBtn.click();

    // Modal kapanmalı ve başarı bildirimi görünmeli
    await expect(permModal).toHaveCount(0, { timeout: 10000 });
    const feedback = page.locator('.yf-feedback, [role="status"]').filter({ hasText: '0644' });
    await expect(feedback).toBeVisible({ timeout: 10000 });

    // Dosya listesi tablosundaki izin sütunu 0644 olarak güncellenmiş olmalı
    await expect(normalRow.locator('.yf-perm')).toHaveText('0644');

    // =========================================================================
    // ADIM 6: FİZİKSEL KANIT (Fiziksel sunucu dosya sisteminde stat/ls doğrulaması)
    // =========================================================================
    const statCmd = `find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${normalFile}' -exec stat -c '%a' {} + 2>/dev/null || true`;
    const serverMode = runSsh(statCmd);
    expect(serverMode).toContain('644');
  });

  test('hatalı girdi ve sınır senaryoları: world-writable engeli, geçersiz chmod ve yetkisiz izin istekleri reddedilir', async ({ page }) => {
    // 1. İlgili site dosyalarına git
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files?path=${encodeURIComponent(testFolder)}`);
    const filesListTable = page.locator('table.yf-table[aria-label="Site dosyaları"]');
    await expect(filesListTable).toBeVisible({ timeout: 15000 });

    // 2. Arayüzde world-writable (başkalarına yazma) izninin kilitli olduğunu doğrula
    const searchableRow = page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`);
    await expect(searchableRow).toBeVisible({ timeout: 10000 });

    const actionsBtn = searchableRow.locator('button[title="Dosya işlemleri"], button[aria-label*="işlemleri"]');
    await actionsBtn.click();

    const detailsModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: searchableFile });
    await expect(detailsModal).toBeVisible({ timeout: 10000 });
    await detailsModal.locator('button:has-text("İzinler")').click();

    const permModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: `İzinler: ${searchableFile}` });
    await expect(permModal).toBeVisible({ timeout: 10000 });

    // Diğer satırındaki 2. kutu (Yazma) disabled olmalı ve güvenlik uyarısı içermeli
    const othersRow = permModal.locator('.yf-permissions-grid tbody tr').filter({ hasText: 'Diğer' });
    const worldWriteCb = othersRow.locator('input[type="checkbox"]').nth(1);
    await expect(worldWriteCb).toBeDisabled();
    await expect(worldWriteCb).toHaveAttribute('title', /world-writable/i);

    // Modaldan vazgeç
    await permModal.locator('button:has-text("Vazgeç")').click();
    await expect(permModal).toHaveCount(0, { timeout: 10000 });

    // 3. API düzeyinde doğrudan güvensiz veya geçersiz chmod gönderim denemeleri
    const sessionRes = await page.request.get('/api/auth/session');
    const sessionData = await sessionRes.json().catch(() => ({}));
    const csrfToken = sessionData?.data?.csrfToken || '';
    const origin = 'https://server.cryptoraichu.website';
    const headers = { origin, 'x-csrf-token': csrfToken, 'content-type': 'application/json' };

    // 3.1 Güvensiz izin (0777 world-writable) -> 400 Bad Request
    const unsafeRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/permissions`, {
      headers,
      data: {
        path: `${testFolder}/${searchableFile}`,
        mode: '0777',
      },
    });
    expect(unsafeRes.status()).toBe(400);
    const unsafeBody = await unsafeRes.json().catch(() => ({}));
    expect(unsafeBody?.error?.code).toBe('site_file_mode_unsafe');

    // 3.2 Geçersiz izin formatı (harf veya geçersiz basamak) -> 400 Bad Request
    const invalidRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/permissions`, {
      headers,
      data: {
        path: `${testFolder}/${searchableFile}`,
        mode: '999',
      },
    });
    expect(invalidRes.status()).toBe(400);
    const invalidBody = await invalidRes.json().catch(() => ({}));
    expect(invalidBody?.error?.code).toBe('site_file_mode_invalid');

    // 3.3 Path traversal ile sistem dosyasına izin değiştirme denemesi -> 400 Bad Request
    const traversalRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/permissions`, {
      headers,
      data: {
        path: '../../etc/passwd',
        mode: '0644',
      },
    });
    expect(traversalRes.status()).toBe(400);
    const traversalBody = await traversalRes.json().catch(() => ({}));
    expect(traversalBody?.error?.code).toBe('site_file_path_invalid');

    // 4. Fiziksel Teyit: searchableFile'ın izninin asla 777 veya güvensiz moda dönüşmediği
    const statCmd = `find /var/www/yunpanel/apps /var/lib/yunpanel/apps -name '${searchableFile}' -exec stat -c '%a' {} + 2>/dev/null || true`;
    const serverMode = runSsh(statCmd);
    expect(serverMode).not.toContain('777');
    expect(serverMode).toContain('640');
  });

  test('içerik araması: Plesk eşdeğeri dosya içerik araması (content search / full-text)', async ({ page }) => {
    // Plesk'te Dosya Yöneticisi hem dosya adı hem de dosya İÇERİĞİNDE tam metin arama (grep) destekler.
    // YunPanel yerel dosya yöneticisinde ise arama kutusu yalnızca geçerli dizindeki dosya adlarıyla sınırlıdır.
    test.fail(
      true,
      'BULGU DOS-09: Dosya içerik araması (content search / full-text grep) panel dosya yöneticisinde henüz bulunmuyor; arama yalnızca dosya adıyla filtreleme yapıyor',
    );

    // 1. Önce searchableFile içine özgün bir içerik metni yazalım
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files?path=${encodeURIComponent(testFolder)}`);
    const searchableRow = page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`);
    await expect(searchableRow).toBeVisible({ timeout: 15000 });

    // Dosyayı editörde aç
    const openBtn = searchableRow.locator(`button.yf-entry:has(strong:has-text("${searchableFile}"))`);
    await openBtn.click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: searchableFile });
    await expect(editorModal).toBeVisible({ timeout: 10000 });

    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible();
    await editorTextarea.fill(`Test Header\n${searchContentNeedle}\nTest Footer`);

    const saveEditorBtn = editorModal.locator('button[type="submit"]:has-text("Kaydet")');
    await saveEditorBtn.click();
    await expect(editorModal.locator('text=Kaydedildi')).toBeVisible({ timeout: 10000 });

    // Editörü kapat
    await editorModal.locator('button:has-text("Kapat")').click();
    await expect(editorModal).toHaveCount(0, { timeout: 10000 });

    // 2. Şimdi arama kutusuna dosya adını DEĞİL, dosyanın İÇİNDEKİ özgün metni (needle) yazalım
    const searchInput = page.locator('.yf-tools input[type="search"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill(searchContentNeedle);

    // Plesk eşdeğerliğinde bu dosya içerik eşleşmesiyle listede görünmelidir.
    // YunPanel'de yalnızca dosya adına göre filtreleme yapıldığından bu arama dosyayı bulamaz (test.fail beklenir).
    await expect(page.locator(`tr[role="row"]:has(strong:has-text("${searchableFile}"))`)).toBeVisible({ timeout: 5000 });
  });
});
