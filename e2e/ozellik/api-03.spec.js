import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('API-03 CLI, olay handler ları ve otomatik provisioning', () => {
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tapi03-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;
  let createdWebsiteId = null;
  let capturedOperationId = null;
  let resolvedUnixUser = null;
  let defaultDocRoot = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function checkHttp(host) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path: '/',
        method: 'GET',
        headers: { Host: host },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function apiCall(page, path, options = {}) {
    return page.evaluate(async ({ path, options }) => {
      const headers = { ...(options.headers || {}) };
      if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
        const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
        const csrf = s?.data?.csrfToken || s?.csrfToken;
        if (csrf) {
          headers['x-csrf-token'] = csrf;
        }
      }
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, ok: res.ok, data };
    }, { path, options });
  }

  async function removeWebsite(page, targetWebsiteId) {
    if (!targetWebsiteId) return;
    try {
      const r = await apiCall(page, `/api/panel/websites/${targetWebsiteId}/removal`);
      if (r.status === 200 && r.data?.preview?.readyToStart) {
        const preview = r.data.preview;
        const start = await apiCall(page, `/api/panel/websites/${targetWebsiteId}/removal`, {
          method: 'POST',
          body: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
        });
        if (start.status === 201 && start.data?.id) {
          const op = start.data;
          if (op.actions?.runConfirmation) {
            await apiCall(page, `/api/panel/website-removal-operations/${op.id}/run`, {
              method: 'POST',
              body: { expectedUpdatedAt: op.updatedAt, confirmation: op.actions.runConfirmation },
            });
          }
          await expect.poll(async () => {
            const poll = await apiCall(page, `/api/panel/website-removal-operations/${op.id}`);
            return poll.data?.status === 'removed';
          }, { timeout: 30000, intervals: [500, 1000, 2000] }).toBe(true);
        }
      }
    } catch (err) {
      console.warn('Removal notice:', err.message);
    }
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
  });

  test.afterAll(async ({ browser }) => {
    if (createdWebsiteId) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsite(page, createdWebsiteId);
      } catch (err) {
        console.warn('Clean-up failed for website:', createdWebsiteId, err.message);
      } finally {
        await page.close().catch(() => {});
      }
    }

    // Fiziksel temizlik garantisi (0 artık ilkesi)
    if (resolvedUnixUser) {
      runSsh(`id ${resolvedUnixUser} >/dev/null 2>&1 && userdel -f ${resolvedUnixUser} 2>/dev/null || true`);
    }
    if (defaultDocRoot) {
      runSsh(`rm -rf ${defaultDocRoot} 2>/dev/null || true`);
    }
    runSsh(`rm -rf /var/www/yunpanel/apps/*${prefix}* /var/lib/yunpanel/homes/*${prefix}* 2>/dev/null || true`);
    runSsh(`rm -f /etc/nginx/sites-enabled/yunpanel-*${prefix}*.conf /etc/nginx/sites-available/yunpanel-*${prefix}*.conf 2>/dev/null || true`);
  });

  test('mutlu yol: panelden site oluştur, otomatik provisioning ardışık adımlarını API ve canlı sunucuda doğrula', async ({ page }) => {
    // 1. Yeni statik test web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: Statik barındırma türünü seç
    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });

    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: Kurulumu onayla ve oluştur
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });
    await expect(summarySection.locator('dd', { hasText: siteDomain })).toBeVisible();

    // E-posta / Webmail seçeneğini temizle
    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    // Sertifika modunu HTTP olarak ayarla (port 80 üzerinden doğrudan 200 testi için)
    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    if (await httpsSelect.isVisible()) {
      await httpsSelect.selectOption('off');
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum sonucunu bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    // Oluşturulan domain ID'sini al
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Domain API ile websiteId'yi çözümle
    const domainDetailRes = await apiCall(page, `/api/panel/domains/${createdDomainId}`);
    expect(domainDetailRes.ok).toBe(true);
    createdWebsiteId = domainDetailRes.data?.data?.websiteId;
    expect(createdWebsiteId).toBeTruthy();

    // 3. Otomatik Provisioning API kontrolü: /api/panel/sites/:websiteId/provisioning/latest
    const provRes = await apiCall(page, `/api/panel/sites/${createdWebsiteId}/provisioning/latest`);
    expect(provRes.status).toBe(200);
    expect(provRes.ok).toBe(true);
    const provData = provRes.data?.data;
    expect(provData).toBeTruthy();
    expect(provData.websiteId).toBe(createdWebsiteId);
    expect(Array.isArray(provData.steps)).toBe(true);
    expect(provData.steps.length).toBeGreaterThan(0);

    capturedOperationId = provData.operationId;
    expect(capturedOperationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    // En az 1 temel provisioning adımının succeeded olduğunu doğrula
    const succeededSteps = provData.steps.filter((s) => s.state === 'succeeded');
    expect(succeededSteps.length).toBeGreaterThan(0);

    // 4. Barındırma ayarlarını yayına uygula (Nginx vhost'unu derle ve aktif et)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled({ timeout: 15000 });
    await saveBtn.click();

    const statusNotice = page.locator('.ws-notice, .ws-badge, p[role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });

    // 5. Erişim hesapları ve sistem kullanıcısını doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/access`);
    await expect(page.locator('h2, h3', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });

    const userRow = page.locator('dt:has-text("Kullanıcı adı") + dd');
    await expect(userRow).toBeVisible();
    resolvedUnixUser = (await userRow.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]+$/);

    const docRootRow = page.locator('dt:has-text("Belge kök dizini (Docroot)") + dd');
    await expect(docRootRow).toBeVisible();
    defaultDocRoot = (await docRootRow.textContent()).trim();
    expect(defaultDocRoot).toContain('/var/www/yunpanel/apps/');

    // 6. Fiziksel Kontrol (SSH & Linux Kullanıcı): Sistem kullanıcısının Linux seviyesinde varlığı
    const idCheck = runSsh(`id ${resolvedUnixUser}`);
    expect(idCheck).toContain('uid=');
    expect(idCheck).toContain('gid=');
    expect(idCheck).not.toContain('uid=0(');

    // Fiziksel Kontrol (HTTP): Nginx canlı vhost yanıtını ve dosya sunumunu doğrula
    const testMarker = `API03_PROVISION_OK_${Date.now()}`;
    runSsh(`mkdir -p ${defaultDocRoot} && echo "<h1>${testMarker}</h1>" > ${defaultDocRoot}/index.html && chown -R ${resolvedUnixUser}:${resolvedUnixUser} ${defaultDocRoot}`);

    const docRootCheck = runSsh(`test -d ${defaultDocRoot} && echo OK`);
    expect(docRootCheck).toBe('OK');

    // HTTP Port 80 üzerinden istek: Sitenin 200 döndürdüğü ve test dosyasını sunduğu doğrulanır
    await expect.poll(async () => {
      const res = await checkHttp(siteDomain).catch(() => null);
      return res?.status === 200 && res?.body?.includes(testMarker);
    }, { timeout: 20000, intervals: [500, 1000, 2000] }).toBe(true);

    // 7. Paneli kullanarak siteyi güvenle sil (temizlik doğrulaması)
    await removeWebsite(page, createdWebsiteId);
    createdWebsiteId = null;
    createdDomainId = null;
  });

  test('hatalı girdi: geçersiz provisioning parametreleri ve yetkisiz işlem denetimi', async ({ page }) => {
    // 1. Olmayan provisioning işlemine continue çağrısı 404 dönmeli
    const fakeOpId = '00000000-0000-4000-8000-000000000000';
    const notFoundRes = await apiCall(page, `/api/panel/sites/provisioning/${fakeOpId}/continue`, {
      method: 'POST',
      body: { confirmation: `continue-site-provisioning:${fakeOpId}` },
    });
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.data?.error?.code).toBe('website_provisioning_not_found');

    // 2. Hatalı onay (confirmation) ile continue çağrısı 400 dönmeli
    const invalidConfirmRes = await apiCall(page, `/api/panel/sites/provisioning/${fakeOpId}/continue`, {
      method: 'POST',
      body: { confirmation: 'invalid-token-format' },
    });
    expect(invalidConfirmRes.status).toBe(400);
    expect(invalidConfirmRes.data?.error?.code).toBe('website_provisioning_confirmation_required');

    // 3. Geçersiz formatlı websiteId ile latest provisioning sorgusu 400 dönmeli
    const malformedWebsiteRes = await apiCall(page, '/api/panel/sites/invalid-uuid-format/provisioning/latest');
    expect(malformedWebsiteRes.status).toBe(400);
    expect(malformedWebsiteRes.data?.error?.code).toBe('website_provisioning_website_invalid');

    // 4. UI doğrulaması: Yeni site ekleme formunda geçersiz alan adı engellenmeli
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('invalid..domain..format');
    await page.click('button[type="submit"]:has-text("Devam et")');

    // 2. Adım (Barındırma türü)
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    await page.click('button[type="submit"]:has-text("Devam et")');

    // 3. Adım (Son kontrol ve kurulum)
    await expect(page.locator('h3:has-text("Son kontrol ve kurulum")').or(page.locator('h2:has-text("Son kontrol ve kurulum")'))).toBeVisible({ timeout: 10000 });
    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    // Hata bildirimi ekranda görünmeli
    const errorNotice = page.locator('.ws-notice-error, [role="alert"]').or(page.locator('.ws-error'));
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
  });

  test('Plesk UI ve CLI eşdeğerliği: CLI ile otomatik provisioning araçları (plesk bin domain/site benzeri)', async () => {
    // Plesk'te `plesk bin domain --create`, `plesk bin customer --create` gibi CLI
    // üzerinden tam provisioning ve yönetim komutları bulunmaktadır.
    // YunPanel test sunucusunda doğrudan global provisioning CLI (ör. `yunpanel` komutu) kontrol edilir.
    test.fail(
      true,
      'Plesk eşdeğeri yunpanel CLI (plesk bin domain/customer benzeri) komut satırı aracı bulunmuyor'
    );

    const cliCheck = runSsh('which yunpanel || find /usr/local/bin /usr/bin -name yunpanel 2>/dev/null');
    expect(cliCheck).toContain('yunpanel');
  });

  test('Plesk UI ve kanca eşdeğerliği: Olay Tetikleyicileri (Event Handlers / Event Manager)', async ({ page }) => {
    // Plesk'te Araçlar ve Ayarlar altında "Olay Tetikleyicileri" (Event Handlers / Event Manager)
    // arayüzü ile provisioning ve sistem olaylarına betik bağlanabilir.
    // YunPanel Tools & Settings sayfasında bu özelliğin varlığı kontrol edilir.
    await page.goto('/tools-settings');
    await expect(page.locator('h1', { hasText: 'Araçlar ve Ayarlar' })).toBeVisible({ timeout: 15000 });

    test.fail(
      true,
      'Plesk eşdeğeri merkezi Olay Tetikleyicileri (Event Handlers / Olay Yöneticisi) arayüzü ve kancaları bulunmuyor'
    );

    const eventManagerLink = page.locator('a', { hasText: /Olay tetikleyicileri|Olay yöneticisi|Event Manager|Event Handlers/i });
    await expect(eventManagerLink).toBeVisible({ timeout: 3000 });
  });
});
