import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('RUN-02 PHP sürümü/handler, php.ini ve PHP-FPM ayarları', () => {
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `trun02-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.157.180.11.28.sslip.io`;
  const cust1User = `${prefix}-c1`;
  const cust2User = `${prefix}-c2`;
  const cust1Pass = 'Trun02A1!' + crypto.randomBytes(6).toString('hex');
  const cust2Pass = 'Trun02A2!' + crypto.randomBytes(6).toString('hex');

  let cust1Id = null;
  let cust2Id = null;
  let createdDomainId = null;
  let createdWebsiteId = null;
  let createdAppId = null;
  let resolvedUnixUser = null;

  const AUTH_DIR = path.resolve(process.cwd(), 'e2e/.auth');

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(`${command} 2>&1`)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function checkHttp(path = '/') {
    try {
      const res = execSync(`curl -skL -w "\\n---HTTP_STATUS:%{http_code}---" --connect-timeout 8 --resolve ${siteDomain}:80:157.180.11.28 --resolve ${siteDomain}:443:157.180.11.28 http://${siteDomain}${path}`, {
        encoding: 'utf8',
        timeout: 15000,
      });
      const match = res.match(/---HTTP_STATUS:(\d+)---$/);
      const status = match ? parseInt(match[1], 10) : 200;
      const body = res.replace(/---HTTP_STATUS:\d+---$/, '').trim();
      return { status, body };
    } catch (err) {
      return { status: err.status || 500, body: (err.stdout || '') + (err.stderr || '') };
    }
  }

  async function ensureOwnerLoggedIn(page) {
    const ownerAuthFile = path.join(AUTH_DIR, `${OWNER_USERNAME}.json`);
    if (fs.existsSync(ownerAuthFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(ownerAuthFile, 'utf8'));
        if (state.cookies && state.cookies.length) {
          await page.context().addCookies(state.cookies);
        }
      } catch {}
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto('/');
        const sessionBar = page.locator('.auth-sessionbar');
        const authForm = page.locator('form.auth-form');
        await expect(sessionBar.or(authForm)).toBeVisible({ timeout: 15000 });

        if (await sessionBar.isVisible()) {
          const text = await sessionBar.textContent();
          if (text.includes(OWNER_USERNAME)) {
            return;
          }
          await page.context().clearCookies();
          await page.goto('/');
          await expect(authForm).toBeVisible({ timeout: 15000 });
        }

        if (await authForm.isVisible()) {
          await page.fill('input[name="username"]', OWNER_USERNAME);
          await page.fill('input[name="password"]', OWNER_PASSWORD);
          await page.click('button.auth-primary');
          await expect(sessionBar).toBeVisible({ timeout: 15000 });
          try {
            await page.context().storageState({ path: ownerAuthFile });
          } catch {}
          return;
        }
      } catch (err) {
        if (attempt === 2) throw err;
        await page.waitForTimeout(1000);
      }
    }
  }

  async function panelApi(page, method, endpoint, body = undefined) {
    return page.evaluate(
      async ({ method, endpoint, body }) => {
        const sessionRes = await fetch('/api/auth/session', { credentials: 'same-origin' });
        const sessionData = await sessionRes.json().catch(() => ({}));
        const csrf = sessionData?.data?.csrfToken || sessionData?.csrfToken || '';
        const headers = { 'x-csrf-token': csrf };
        let payload = undefined;
        if (body !== undefined) {
          headers['content-type'] = 'application/json';
          payload = JSON.stringify(body);
        }
        const res = await fetch('/api/panel' + endpoint, {
          method,
          headers,
          body: payload,
          credentials: 'same-origin',
        });
        const json = await res.json().catch(() => null);
        return { status: res.status, body: json, data: json?.data ?? json };
      },
      { method, endpoint, body },
    );
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const deleteBtn = page.locator('button:has-text("Siteyi sil…")');
      if (await deleteBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
        await deleteBtn.click();
        const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
        if (await dialog.isVisible({ timeout: 8000 }).catch(() => false)) {
          const input = dialog.locator('input');
          await input.fill(domainName);
          const submitBtn = dialog.locator('button:has-text("Silme işlemini başlat"), button[type="submit"]');
          if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
            await submitBtn.click();
            const doneBtn = page.locator('button:has-text("Web sitelerine dön")');
            await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 45000 }).catch(() => {});
            if (await doneBtn.isVisible().catch(() => false)) {
              await doneBtn.click();
            }
          }
        }
      }
    } catch (err) {
      console.warn('Cleanup notice (website UI):', err.message);
    }
  }

  async function cleanupAll(browser) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await ensureOwnerLoggedIn(page);
      if (createdDomainId) {
        await removeWebsiteById(page, createdDomainId, siteDomain);
        if (createdWebsiteId) {
          const check = await panelApi(page, 'GET', `/websites/${createdWebsiteId}`);
          if (check.status === 200) {
            await panelApi(page, 'DELETE', `/websites/${createdWebsiteId}`, { confirmation: `delete:${siteDomain}` });
          }
        }
      }

      // Test müşteri hesaplarını temizle
      const accountsRes = await panelApi(page, 'GET', '/users/hosting/accounts?kind=customer&limit=100');
      for (const acc of accountsRes.data?.accounts ?? []) {
        if (acc.username && (acc.username.startsWith(`trun02-a${agentN}`) || acc.username === cust1User || acc.username === cust2User)) {
          await panelApi(page, 'DELETE', `/users/hosting/accounts/${acc.id}/login`, { revision: acc.revision ?? 1 });
        }
      }
      const usersRes = await panelApi(page, 'GET', '/users?limit=100');
      for (const u of usersRes.data?.users ?? []) {
        if (u.username && (u.username.startsWith(`trun02-a${agentN}`) || u.username === cust1User || u.username === cust2User)) {
          await panelApi(page, 'DELETE', `/users/${encodeURIComponent(u.id)}`, { revision: u.revision ?? 1 });
        }
      }
    } catch (err) {
      console.warn('Cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }

    try {
      if (fs.existsSync(AUTH_DIR)) {
        for (const f of fs.readdirSync(AUTH_DIR)) {
          if (f.startsWith(`trun02-a${agentN}`) && f.endsWith('.json')) {
            fs.rmSync(path.join(AUTH_DIR, f), { force: true });
          }
        }
      }
    } catch {}
  }

  test.beforeAll(async ({ browser }) => {
    await cleanupAll(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAll(browser);
  });

  test('mutlu yol: PHP sitesi oluştur, PHP ayarları ekranından limitleri güncelle, sayfa yenileme ve fiziksel çalışma zamanında doğrula', async ({ page }) => {
    await ensureOwnerLoggedIn(page);

    // 1. Test müşterisi 1 (cust1) oluştur
    const c1Res = await panelApi(page, 'POST', '/users/hosting/accounts/create-login', {
      kind: 'customer',
      username: cust1User,
      password: cust1Pass,
      resellerId: null,
    });
    expect([200, 201]).toContain(c1Res.status);
    cust1Id = c1Res.data?.account?.id;
    expect(cust1Id).toBeTruthy();

    // 2. Yeni PHP sitesi oluştur (/websites/new)
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı ve Müşteri seçimi
    const domainInput = page.locator('input[placeholder="example.com"]').or(page.getByLabel('Alan adı', { exact: true }));
    await domainInput.fill(siteDomain);

    const ownerModeSelect = page.getByLabel('Site sahibi', { exact: true });
    await ownerModeSelect.selectOption('customer');

    const wwwSelect = page.locator('label').filter({ hasText: 'www davranışı' }).locator('select');
    if (await wwwSelect.isVisible().catch(() => false)) {
      await wwwSelect.selectOption('none');
    }

    // Customer select kutusu (required select with option "Müşteri seçin")
    const customerSelect = page.locator('select[required]').filter({ has: page.locator('option', { hasText: 'Müşteri seçin' }) });
    await customerSelect.waitFor({ state: 'visible', timeout: 10000 });
    await customerSelect.selectOption(cust1Id);

    const step1Next = page.locator('button[type="submit"]:has-text("Devam et")');
    await step1Next.click();

    // Adım 2: Barındırma türü -> new_php
    await expect(page.locator('h3', { hasText: 'Barındırma türü' })).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.getByLabel('Site türü', { exact: true });
    await sourceSelect.selectOption('new_php');

    const step2Next = page.locator('button[type="submit"]:has-text("Devam et")');
    await step2Next.click();

    // Adım 3: Kurulum ve onay
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const httpsSelect = page.getByLabel('Sertifika yönetimi', { exact: true });
    if (await httpsSelect.isVisible().catch(() => false)) {
      await httpsSelect.selectOption('off');
    }

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible().catch(() => false) && await mailCheck.isChecked().catch(() => false)) {
      await mailCheck.uncheck();
    }

    const createBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await createBtn.click();

    // Kurulum sonucunu bekle ve planındaki zorunlu adımların tamamlandığını doğrula
    await page.getByLabel('Site kurulum durumu').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[aria-label="Site kurulum durumu"]');
        return el && el.innerText.includes('Kurulum planındaki zorunlu adımlar tamamlandı');
      },
      { timeout: 180000 },
    );

    // API üzerinden Domain, Website ve Unix user nesnelerini al
    let domainObj = null;
    for (let i = 0; i < 30; i++) {
      const domainsRes = await panelApi(page, 'GET', '/domains');
      domainObj = (domainsRes.data ?? []).find((d) => d.primaryDomain === siteDomain);
      if (domainObj?.websiteId) break;
      await page.waitForTimeout(1000);
    }
    expect(domainObj).toBeTruthy();
    createdDomainId = domainObj.id;
    createdWebsiteId = domainObj.websiteId;

    const websitesRes = await panelApi(page, 'GET', '/websites');
    const websiteObj = (websitesRes.data ?? []).find((w) => w.id === createdWebsiteId);
    expect(websiteObj).toBeTruthy();
    createdAppId = websiteObj.applicationId;
    resolvedUnixUser = websiteObj.unixUser;
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]+$/);

    // Varsayılan index.php HTTP erişimini doğrula (Website ready)
    const defaultHttp = await checkHttp('/');
    expect(defaultHttp.status).toBe(200);

    // 3. PHP runtime probe dosyasını vhost document root dizinine yerleştir
    const probeScript = `<?php
header('Content-Type: application/json');
echo json_encode([
  'version' => PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION,
  'memory_limit' => ini_get('memory_limit'),
  'max_execution_time' => ini_get('max_execution_time'),
  'sapi' => php_sapi_name(),
  'user' => get_current_user(),
]);
`;
    // Hem API files/upload ile hem de vhost document root dizinine SSH ile yerleştir
    await page.evaluate(async ({ websiteId, probeScript }) => {
      const sessionRes = await fetch('/api/auth/session', { credentials: 'same-origin' });
      const sessionData = await sessionRes.json().catch(() => ({}));
      const csrfToken = sessionData?.data?.csrfToken || sessionData?.csrfToken || '';
      await fetch(`/api/panel/websites/${websiteId}/files/upload?path=probe.php`, {
        method: 'PUT',
        headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/octet-stream' },
        body: probeScript,
        credentials: 'same-origin',
      });
    }, { websiteId: createdWebsiteId, probeScript });

    const realDocRoot = runSsh(`sudo -n realpath ${websiteObj.documentRoot} || true`).trim();
    const probeB64 = Buffer.from(probeScript, 'utf8').toString('base64');
    runSsh(`sudo -n bash -c 'mkdir -p ${websiteObj.documentRoot} ${realDocRoot} && echo "${probeB64}" | base64 -d | tee ${websiteObj.documentRoot}/probe.php ${realDocRoot}/probe.php >/dev/null && chown -R ${resolvedUnixUser}:${resolvedUnixUser} ${websiteObj.documentRoot}/probe.php ${realDocRoot}/probe.php && chmod 644 ${websiteObj.documentRoot}/probe.php ${realDocRoot}/probe.php'`);

    // Başlangıç HTTP probe kontrolü: 256M / 60s / version 8.3
    const initialHttp = await checkHttp('/probe.php');
    expect(initialHttp.status).toBe(200);
    const initialProbe = JSON.parse(initialHttp.body);
    expect(initialProbe.version).toBe('8.3');
    expect(initialProbe.memory_limit).toBe('256M');
    expect(initialProbe.max_execution_time).toBe('60');
    expect(initialProbe.user).toBe(resolvedUnixUser);

    // Başlangıç FPM havuz dosyasını doğrula
    const poolPath = `/etc/php/8.3/fpm/pool.d/yunpanel-${resolvedUnixUser}.conf`;
    const initialPoolConf = runSsh(`cat ${poolPath}`);
    expect(initialPoolConf).toContain('php_admin_value[memory_limit] = 256M');
    expect(initialPoolConf).toContain('php_admin_value[max_execution_time] = 60');
    expect(initialPoolConf).toContain('pm.max_children = 8');

    // 4. /websites/:domainId/php sayfasına git ve ayarları güncelle: 512 MB, 120s, 12 workers
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('#site-php-version')).toBeVisible({ timeout: 15000 });

    const advancedSummary = page.locator('details.ws-settings-advanced summary', { hasText: 'Gelişmiş işlem havuzu ayarları' });
    await advancedSummary.click();

    const memInput = page.locator('#site-php-memory');
    await memInput.fill('512');

    const timeoutInput = page.locator('#site-php-timeout');
    await timeoutInput.fill('120');

    const workersInput = page.locator('#site-php-workers');
    await workersInput.fill('12');

    const saveBtn = page.locator('form.ws-form button[type="submit"]');
    await saveBtn.click();

    // Kayıt bildirimini bekle
    const successNotice = page.locator('text=PHP ayarları uygulandı ve kaydedildi.');
    await expect(successNotice).toBeVisible({ timeout: 60000 });

    // 5. Sayfayı yenile (reload) ve UI kalıcılığını doğrula
    await page.reload();
    await expect(page.locator('#site-php-version')).toBeVisible({ timeout: 15000 });
    await page.locator('details.ws-settings-advanced summary', { hasText: 'Gelişmiş işlem havuzu ayarları' }).click();

    await expect(page.locator('#site-php-memory')).toHaveValue('512');
    await expect(page.locator('#site-php-timeout')).toHaveValue('120');
    await expect(page.locator('#site-php-workers')).toHaveValue('12');

    // 6. Fiziksel Sonuç 1 (HTTP probe): ini_get('memory_limit') === '512M' ve ini_get('max_execution_time') === '120'
    const updatedHttp = await checkHttp('/probe.php');
    expect(updatedHttp.status).toBe(200);
    const updatedProbe = JSON.parse(updatedHttp.body);
    expect(updatedProbe.memory_limit).toBe('512M');
    expect(updatedProbe.max_execution_time).toBe('120');

    // 7. Fiziksel Sonuç 2 (SSH FPM Pool config & socket):
    const updatedPoolConf = runSsh(`cat ${poolPath}`);
    expect(updatedPoolConf).toContain('php_admin_value[memory_limit] = 512M');
    expect(updatedPoolConf).toContain('php_admin_value[max_execution_time] = 120');
    expect(updatedPoolConf).toContain('pm.max_children = 12');

    const socketStat = runSsh(`ls -l /run/php/yunpanel-${resolvedUnixUser}.sock`);
    expect(socketStat).toContain(`yunpanel-${resolvedUnixUser}.sock`);
  });

  test('hatalı girdi ve sınır durumları: değişiklik yapmadan kaydetme uyarısı ve sınır dışı değer doğrulaması', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();
    await ensureOwnerLoggedIn(page);

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('#site-php-version')).toBeVisible({ timeout: 15000 });

    // 1. Hiçbir alanı değiştirmeden Kaydet butonuna tıkla (409 Conflict / php_config_no_changes)
    const saveBtn = page.locator('form.ws-form button[type="submit"]');
    await saveBtn.click();

    // Hata bildirimi gösterilmeli
    const alertBox = page.locator('[role="alert"], .ws-error, .yp-alert-error');
    await expect(alertBox).toBeVisible({ timeout: 10000 });
    await expect(alertBox).toContainText(/PHP configuration does not change current state|php_config_no_changes/i);

    // 2. Form HTML5 alt ve üst sınır kontrolleri (Bellek 64-2048, Süre 5-600, İşlem 1-64)
    await page.locator('details.ws-settings-advanced summary', { hasText: 'Gelişmiş işlem havuzu ayarları' }).click();

    // Bellek sınırı < 64
    await page.fill('#site-php-memory', '32');
    const memUnderflow = await page.evaluate(() => document.querySelector('#site-php-memory').validity.rangeUnderflow);
    expect(memUnderflow).toBe(true);

    // Bellek sınırı > 2048
    await page.fill('#site-php-memory', '4096');
    const memOverflow = await page.evaluate(() => document.querySelector('#site-php-memory').validity.rangeOverflow);
    expect(memOverflow).toBe(true);

    // Çalışma süresi < 5
    await page.fill('#site-php-timeout', '2');
    const timeoutUnderflow = await page.evaluate(() => document.querySelector('#site-php-timeout').validity.rangeUnderflow);
    expect(timeoutUnderflow).toBe(true);

    // Eşzamanlı işlem < 1
    await page.fill('#site-php-workers', '0');
    const workersUnderflow = await page.evaluate(() => document.querySelector('#site-php-workers').validity.rangeUnderflow);
    expect(workersUnderflow).toBe(true);

    // Geçerli değerlere geri dön
    await page.fill('#site-php-memory', '512');
    await page.fill('#site-php-timeout', '120');
    await page.fill('#site-php-workers', '12');

    // 3. API uç noktası üzerinden sınır dışı ve desteklenmeyen değerlerin reddi (400 Bad Request)
    const badMemRes = await panelApi(page, 'POST', `/websites/${createdWebsiteId}/php-tools/config/preview`, { memoryLimitMb: 32 });
    expect(badMemRes.status).toBe(400);

    const badWorkersRes = await panelApi(page, 'POST', `/websites/${createdWebsiteId}/php-tools/config/preview`, { maxChildren: 65 });
    expect(badWorkersRes.status).toBe(400);

    const badVersionRes = await panelApi(page, 'POST', `/websites/${createdWebsiteId}/php-tools/config/preview`, { phpVersion: '7.4' });
    expect(badVersionRes.status).toBe(400);
  });

  test('yetki (RBAC): sitenin sahibi olan müşteri PHP ayarlarını günceller, yabancı müşteri erişemez', async ({ page, browser }) => {
    expect(createdDomainId).toBeTruthy();
    expect(cust1Id).toBeTruthy();

    await ensureOwnerLoggedIn(page);

    // 1. Yabancı test müşterisi 2 (cust2) oluştur
    const c2Res = await panelApi(page, 'POST', '/users/hosting/accounts/create-login', {
      kind: 'customer',
      username: cust2User,
      password: cust2Pass,
      resellerId: null,
    });
    expect([200, 201]).toContain(c2Res.status);
    cust2Id = c2Res.data?.account?.id;
    expect(cust2Id).toBeTruthy();

    // 2. Sitenin sahibi olan Customer 1 ile giriş yap ve PHP ayarlarını güncelle
    const cust1Context = await browser.newContext({ ignoreHTTPSErrors: true });
    const cust1Page = await cust1Context.newPage();
    try {
      await loginAs(cust1Page, cust1User, cust1Pass);
      await cust1Page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
      await expect(cust1Page.locator('#site-php-version')).toBeVisible({ timeout: 15000 });

      await cust1Page.locator('details.ws-settings-advanced summary', { hasText: 'Gelişmiş işlem havuzu ayarları' }).click();
      await cust1Page.fill('#site-php-memory', '384');
      await cust1Page.fill('#site-php-timeout', '90');
      await cust1Page.fill('#site-php-workers', '10');

      const cust1SaveBtn = cust1Page.locator('form.ws-form button[type="submit"]');
      await cust1SaveBtn.click();

      await expect(cust1Page.locator('text=PHP ayarları uygulandı ve kaydedildi.')).toBeVisible({ timeout: 60000 });

      // Fiziksel HTTP probe ile Customer 1 güncellemesini doğrula (384M / 90s)
      const cust1ProbeRes = await checkHttp('/probe.php');
      expect(cust1ProbeRes.status).toBe(200);
      const cust1Probe = JSON.parse(cust1ProbeRes.body);
      expect(cust1Probe.memory_limit).toBe('384M');
      expect(cust1Probe.max_execution_time).toBe('90');
    } finally {
      await cust1Context.close();
    }

    // 3. Yabancı Customer 2 ile giriş yap ve site PHP ayarlarına erişim engellendiğini doğrula
    const cust2Context = await browser.newContext({ ignoreHTTPSErrors: true });
    const cust2Page = await cust2Context.newPage();
    try {
      await loginAs(cust2Page, cust2User, cust2Pass);
      await cust2Page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);

      // Arayüzde boş durum veya hata görünmeli; form görünmemeli
      const phpForm = cust2Page.locator('form.ws-form');
      await expect(phpForm).not.toBeVisible({ timeout: 10000 });

      // API doğrudan çağrıldığında 403 site_scope_forbidden dönmeli
      const foreignApiRes = await panelApi(cust2Page, 'GET', `/websites/${createdWebsiteId}/php-tools/config`);
      expect(foreignApiRes.status).toBe(403);
      const errorCode = foreignApiRes.body?.error?.code || foreignApiRes.body?.error;
      expect(errorCode).toBe('site_scope_forbidden');
    } finally {
      await cust2Context.close();
    }
  });

  test('Plesk paritesi: upload_max_filesize, post_max_size ve serbest php.ini direktifleri alanı', async ({ page }) => {
    test.fail(true, 'Plesk paritesi: upload_max_filesize, post_max_size ve serbest php.ini direktifleri alanı panelde henüz bulunmuyor');
    expect(createdDomainId).toBeTruthy();

    await ensureOwnerLoggedIn(page);
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/php`);
    await expect(page.locator('#site-php-version')).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan serbest php.ini direktif editörü ve ek limitler kontrol edilir
    const additionalDirectives = page.locator('textarea[name="additionalDirectives"], label:has-text("upload_max_filesize")');
    await expect(additionalDirectives).toBeVisible({ timeout: 3000 });
  });
});
