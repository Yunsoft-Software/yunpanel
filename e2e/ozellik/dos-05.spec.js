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

test.describe('DOS-05 Dosya indirme ve URL\'den içe aktarma; SSRF koruması', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const testFileName = `tdos05-a${agentN}-${timestamp}.txt`;
  const testFileContent = `YunPanel DOS-05 verified content for download test ${timestamp}`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;
  let serverAppDocroot = null;

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
    if (resolvedWebsiteId && testFileName) {
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
            path: testFileName,
            confirmation: `delete:${resolvedWebsiteId}:${testFileName}`,
          },
        }).catch(() => {});

        await context.close().catch(() => {});
      } catch (err) {
        console.warn('DOS-05 cleanup API warning:', err.message);
      }
    }

    // 2. SSH ile dosya kalıntısı varsa temizle
    try {
      runSsh(`find /var/www/yunpanel/apps /var/lib/yunpanel/apps -maxdepth 4 -name 'tdos05-a${agentN}-*' -exec rm -f {} + 2>/dev/null || true`);
    } catch {}
  });

  test('mutlu yol: panel arayüzünden dosya indirme bağlantısı ve fiziksel sunucu doğrulaması', async ({ page }) => {
    // 1. Global Files sayfasına git ve ilk web sitesinin dosya yöneticisini aç
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

    // Dosya yöneticisi arayüzünün hazır olduğunu doğrula
    await expect(page.locator('.yf-header h2', { hasText: 'Dosya yöneticisi' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('table.yf-table[aria-label="Site dosyaları"]')).toBeVisible({ timeout: 15000 });

    // 2. Yeni test dosyası oluştur
    await page.locator('button:has-text("Yeni Dosya")').click();
    const createModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yeni dosya' });
    await expect(createModal).toBeVisible({ timeout: 10000 });

    await createModal.locator('input').fill(testFileName);
    const createSubmit = createModal.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(createSubmit).toBeEnabled();
    await createSubmit.click();
    await expect(createModal).toHaveCount(0, { timeout: 15000 });

    // Dosyanın listede belirdiğini doğrula
    const createdRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
    await expect(createdRow).toBeVisible({ timeout: 15000 });

    // 3. Dosyayı düzenle ve içine benzersiz içerik yaz
    const editBtn = createdRow.locator('button[title="Düzenle"], button[aria-label*="düzenle"]');
    await expect(editBtn).toBeVisible({ timeout: 10000 });
    await editBtn.click();

    const editorModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: testFileName });
    await expect(editorModal).toBeVisible({ timeout: 15000 });

    const editorTextarea = editorModal.locator('textarea');
    await expect(editorTextarea).toBeVisible({ timeout: 10000 });
    await editorTextarea.fill(testFileContent);

    const saveBtn = editorModal.locator('button[type="submit"]:has-text("Kaydet")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(editorModal.locator('.yf-editor-meta:has-text("Kaydedildi")')).toBeVisible({ timeout: 15000 });

    // Editörden çıkış yap
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('table.yf-table[aria-label="Site dosyaları"]')).toBeVisible({ timeout: 15000 });

    // 4. Dosya satırındaki İndir butonunun (a[download]) özelliklerini doğrula
    const fileRow = page.locator(`tr[role="row"]:has(strong:has-text("${testFileName}"))`);
    await expect(fileRow).toBeVisible({ timeout: 15000 });

    const downloadLink = fileRow.locator('a[download]');
    await expect(downloadLink).toBeVisible({ timeout: 10000 });
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toBeTruthy();
    expect(downloadHref).toContain('/files/download?path=');
    expect(downloadHref).toContain(encodeURIComponent(testFileName));

    const websiteMatch = downloadHref.match(/\/websites\/([^/?#]+)\/files\/download/);
    expect(websiteMatch).toBeTruthy();
    resolvedWebsiteId = decodeURIComponent(websiteMatch[1]);

    // 5. İndirme bağlantısına doğrudan HTTP isteği yap ve başlık/içerik doğrulaması yap
    const downloadResponse = await page.request.get(downloadHref);
    expect(downloadResponse.status()).toBe(200);

    const disposition = downloadResponse.headers()['content-disposition'];
    expect(disposition).toBeTruthy();
    expect(disposition).toContain('attachment');
    expect(disposition).toContain(encodeURIComponent(testFileName));

    expect(downloadResponse.headers()['content-type']).toBe('application/octet-stream');
    expect(downloadResponse.headers()['x-content-type-options']).toBe('nosniff');

    const downloadedBody = await downloadResponse.text();
    expect(downloadBodyClean(downloadedBody)).toBe(downloadBodyClean(testFileContent));

    // 6. Fiziksel kanıt: Sunucu dosya sisteminde dosyanın varlığı ve içeriği
    const sshFindOutput = runSsh(`find /var/www/yunpanel/apps -name "${testFileName}" 2>/dev/null || true`);
    expect(sshFindOutput).toBeTruthy();
    serverAppDocroot = sshFindOutput.trim();

    const sshContentOutput = runSsh(`cat "${serverAppDocroot}" 2>/dev/null || true`);
    expect(downloadBodyClean(sshContentOutput)).toBe(downloadBodyClean(testFileContent));
  });

  test('güvenlik: dosya indirme path traversal engeli ve sistem dosyası izolasyonu', async ({ page }) => {
    expect(resolvedWebsiteId).toBeTruthy();

    // 1. Path traversal denemeleri (../etc/passwd) -> 400 Bad Request
    const relativeTraversal = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=../../../../etc/passwd`,
    );
    expect(relativeTraversal.status()).toBe(400);
    const relJson = await relativeTraversal.json().catch(() => null);
    expect(relJson?.error?.code).toBe('site_file_path_invalid');

    // 2. Absolute path denemesi (/etc/passwd) -> jail dışına çıkamaz, site kökünde aranır ve 400/404 döner
    const absoluteRes = await page.request.get(
      `/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/download?path=/etc/passwd`,
    );
    expect([400, 404]).toContain(absoluteRes.status());

    // 3. Sistem dosyası içeriği asla sızdırılmamalı
    const relText = await relativeTraversal.text();
    expect(relText).not.toContain('root:x:0:0');
    const absText = await absoluteRes.text();
    expect(absText).not.toContain('root:x:0:0');
  });

  test('mutlu yol 2 (Plesk eşdeğerliği): URL\'den dosya içe aktarma (Import via URL) arayüzü ve akışı', async ({ page }) => {
    test.fail(
      true,
      'BULGU DOS-05: Panel dosya yöneticisinde Plesk eşdeğeri URLden dosya içe aktarma (Import via URL) arayüzü ve API desteği bulunmuyor',
    );

    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/files`);
    await expect(page.locator('.yf-header h2', { hasText: 'Dosya yöneticisi' })).toBeVisible({ timeout: 10000 });

    // Plesk'te araç çubuğunda "URL'den İçe Aktar" / "Import via URL" butonu bulunur
    const importUrlBtn = page.locator('.yf-main-actions button:has-text("URL\'den İçe Aktar"), .yf-main-actions button:has-text("URL"), button:has-text("Uzak Dosya İndir")');
    await expect(importUrlBtn).toBeVisible({ timeout: 5000 });
  });

  test('güvenlik ve hatalı girdi (Plesk eşdeğerliği): URL\'den içe aktarmada SSRF koruması (localhost / dahili IP / metadata engeli)', async ({ page }) => {
    test.fail(
      true,
      'BULGU DOS-05: URLden dosya içe aktarma altyapısı bulunmadığından SSRF filtreleme motoru panelde mevcut değil',
    );

    // Plesk veya SSRF korumalı bir panelde dahili ağ/metadata hedefleri (127.0.0.1, localhost, 169.254.169.254) 400/403 ile engellenmelidir
    const ssrfPayloads = [
      'http://127.0.0.1:8080/internal.zip',
      'http://localhost/admin.tar',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/backup.tar.gz',
      'http://192.168.1.1/secret.conf',
    ];

    // Panelde URL import endpoint'inin varlığı ve SSRF engellemesi sınanır
    for (const ssrfUrl of ssrfPayloads) {
      const response = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/files/remote-download`, {
        data: {
          url: ssrfUrl,
          destination: 'downloaded.zip',
        },
      });

      // SSRF engellemesi durumunda 400 Bad Request veya 403 Forbidden beklenir (404 değil)
      expect([400, 403]).toContain(response.status());
      const body = await response.json().catch(() => ({}));
      expect(body?.error?.code).toMatch(/ssrf|forbidden_host|private_ip/);
    }
  });
});

function downloadBodyClean(val) {
  return String(val || '').trim().replace(/\r\n/g, '\n');
}
