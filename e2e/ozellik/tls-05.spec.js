import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function checkHttp(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '157.180.11.28',
      port: 80,
      path,
      method: 'GET',
      headers: { Host: host },
    }, (res) => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        location: res.headers.location || '',
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function runSsh(command) {
  return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
    encoding: 'utf8',
    timeout: 30000,
  });
}

test.describe.serial('TLS-05 HTTPS yönlendirme, HSTS ve desteklenen TLS seçenekleri', () => {
  test.setTimeout(180000);
  const agentN = process.env.AGENT_N || '2';
  const prefix = `ttls05-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
  let createdDomainId = null;
  let csrfToken = '';

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: 'https://server.cryptoraichu.website',
      Referer: 'https://server.cryptoraichu.website/',
    };
  }

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

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const deleteBtn = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) }).locator('button:has-text("Siteyi sil…")');
      await deleteBtn.waitFor({ state: 'visible', timeout: 25000 });
      await deleteBtn.click();

      const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
      await dialog.waitFor({ state: 'visible', timeout: 10000 });
      const input = dialog.locator('input');
      await input.fill(domainName);

      const submitBtn = dialog.locator('button:has-text("Silme işlemini başlat")');
      await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
      await submitBtn.click();

      const doneBtn = page.locator('button:has-text("Web sitelerine dön")');
      if (await doneBtn.isVisible().catch(() => false)) {
        await doneBtn.click();
      }
      await page.waitForURL(/\/websites$/, { timeout: 15000 }).catch(() => {});
    } catch (err) {
      console.warn('TLS-05 cleanup notice:', err.message);
    }
  }

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, primaryDomain);
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      console.error('Clean-up failed for domain:', createdDomainId, err.message);
    }
  });

  test('mutlu yol: HTTPS yönlendirme, HSTS başlığı yapılandırması ve canlı TLS fiziksel kanıtı', async ({ page }) => {
    // Varsa önceki koşudan kalan ttls05 alan adlarını temizle
    const domainsResPre = await page.request.get('/api/panel/domains');
    if (domainsResPre.ok()) {
      const json = await domainsResPre.json();
      const list = json.data?.domains || json.data || [];
      const leftovers = list.filter((d) => d.primaryDomain?.includes('ttls05') && !d.parentDomainId);
      for (const leftover of leftovers) {
        await removeWebsiteById(page, leftover.id, leftover.primaryDomain);
      }
    }

    // 1. Canlı sitede (webrich.news) HTTPS Yönlendirmesini (301) doğrula
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    const mainDomainId = mainDomain.id;

    // webrich.news barındırma ayarlarına git ve HTTP->HTTPS yönlendirmesi durumunu kontrol et
    await page.goto(`/websites/${encodeURIComponent(mainDomainId)}/hosting`);
    await page.waitForLoadState('networkidle').catch(() => {});
    const httpsRedirectCheck = page.locator('label.ws-check:has-text("HTTP → HTTPS yönlendirmesi") input[type="checkbox"]');
    await expect(httpsRedirectCheck).toBeVisible({ timeout: 15000 });
    await expect(httpsRedirectCheck).toBeChecked();

    // Fiziksel Kanıt 1: Nginx webrich.news konfigürasyonunda HTTP->HTTPS 301 yönlendirmesi
    const nginxConf = runSsh('cat /etc/nginx/sites-enabled/yunpanel-webrich.news.conf');
    expect(nginxConf).toContain('listen 80;');
    expect(nginxConf).toContain('return 301 https://$host$request_uri;');

    // Fiziksel Kanıt 2: webrich.news HTTP port 80 isteğinde 301 Moved Permanently ve Location başlığı
    const httpRes = await checkHttp('webrich.news', '/test-tls');
    expect(httpRes.status).toBe(301);
    expect(httpRes.location).toBe('https://webrich.news/test-tls');

    // 2. Yeni test sitesi oluştur ve arayüzden HSTS (Strict-Transport-Security) başlığı ekle
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();
    await domainInput.fill(primaryDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    if (await wwwSelect.isVisible().catch(() => false)) {
      await wwwSelect.selectOption('none');
    }

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');

    await page.locator('button[type="submit"]:has-text("Devam et")').click();

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    await page.locator('button[type="submit"]:has-text("Siteyi oluştur")').click();

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Barındırma ayarlarına git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(page.locator('h2, h3', { hasText: 'Barındırma ayarları' })).toBeVisible({ timeout: 15000 });

    // HSTS yanıt başlığı ekle: Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
    const addHeaderBtn = page.locator('button:has-text("Yanıt başlığı ekle")');
    await expect(addHeaderBtn).toBeVisible({ timeout: 10000 });
    await addHeaderBtn.click();

    const headerNameInput = page.locator('label:has-text("adı") input').last();
    const headerValueInput = page.locator('label:has-text("değeri") input').last();
    await expect(headerNameInput).toBeVisible();
    await headerNameInput.fill('Strict-Transport-Security');
    await headerValueInput.fill('max-age=31536000; includeSubDomains; preload');

    // Kaydet ve uygula
    const saveBtn = page.locator('button[type="submit"]:has-text("Kaydet ve uygula")');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    const statusNotice = page.locator('p[role="status"], .ws-notice, [role="status"]').filter({
      hasText: /Barındırma ayarları uygulandı|Yayında/i,
    });
    await expect(statusNotice.first()).toBeVisible({ timeout: 60000 });

    // Fiziksel Kanıt 3: Nginx yapılandırma dosyasında HSTS başlığı direktifi
    const testSiteNginxConf = runSsh(`cat /etc/nginx/sites-enabled/yunpanel-${primaryDomain}.conf`);
    expect(testSiteNginxConf).toContain('add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;');

    // Fiziksel Kanıt 4: HTTP isteği atıldığında Nginx tarafından dönen yanıtta HSTS başlığı
    const siteHttpRes = await checkHttp(primaryDomain, '/');
    expect(siteHttpRes.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains; preload');

    // 3. Sunucu Düzeyinde Canlı TLS Seçenekleri Fiziksel Doğrulaması
    // Fiziksel Kanıt 5: TLS 1.2 protokolü ile canlı el sıkışması başarılı
    const tls12Out = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news -tls1_2 </dev/null 2>&1');
    expect(tls12Out).toMatch(/TLSv1\.2/);
    expect(tls12Out).toContain('Verify return code: 0 (ok)');

    // Fiziksel Kanıt 6: TLS 1.3 protokolü ile canlı el sıkışması başarılı
    const tls13Out = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news -tls1_3 </dev/null 2>&1');
    expect(tls13Out).toMatch(/TLSv1\.3/);
    expect(tls13Out).toContain('Verify return code: 0 (ok)');

    // Fiziksel Kanıt 7: Eski/güvensiz TLS 1.0 protokolü sunucu tarafından reddedilir
    const tls10Out = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news -tls1 </dev/null 2>&1 || true');
    expect(tls10Out).toMatch(/no protocols available|handshake failure|wrong version number/i);
  });

  test('hatalı girdi: Geçersiz HSTS başlık değerleri ve SSL olmadan HTTPS yönlendirmesi kural ihlali', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    // 1. Arayüzde SSL sertifikası henüz bağlı olmayan sitede uyarı mesajı kontrolü
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/hosting`);
    await page.waitForLoadState('networkidle').catch(() => {});
    const httpsRedirectCheck = page.locator('label.ws-check:has-text("HTTP → HTTPS yönlendirmesi") input[type="checkbox"]');
    await expect(httpsRedirectCheck).toBeVisible({ timeout: 15000 });
    await expect(httpsRedirectCheck).toBeChecked();

    // SSL bağlı olmadığı için sistemin uyarı vermesini doğrula
    const warnNotice = page.locator('.ws-notice.ws-notice-warn').filter({
      hasText: /SSL sertifikası bağlı değil/i,
    });
    await expect(warnNotice.first()).toBeVisible();

    // 2. Geçersiz karakterler içeren HSTS başlık değeri denemesi (400 invalid_nginx_header)
    const badHeaderRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/update-preview`, {
      headers: apiHeaders(),
      data: {
        changes: {
          nginxSettings: {
            headers: [
              {
                name: 'Strict-Transport-Security',
                value: 'max-age=31536000"; injected_directive;',
                always: true,
              },
            ],
          },
        },
      },
    });
    expect(badHeaderRes.status()).toBe(400);
    const badHeaderJson = await badHeaderRes.json();
    expect(badHeaderJson.error?.code).toBe('invalid_nginx_header');

    // 3. Yasaklı/korunan başlık ismi (örn. Location veya Set-Cookie) ekleme denemesi (400 blocked_nginx_header)
    const blockedHeaderRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/update-preview`, {
      headers: apiHeaders(),
      data: {
        changes: {
          nginxSettings: {
            headers: [
              {
                name: 'Location',
                value: 'https://evil.com',
                always: true,
              },
            ],
          },
        },
      },
    });
    expect(blockedHeaderRes.status()).toBe(400);
    const blockedHeaderJson = await blockedHeaderRes.json();
    expect(blockedHeaderJson.error?.code).toBe('blocked_nginx_header');

    // 4. 256 karakteri aşan aşırı uzun HSTS başlık değeri denemesi (400 invalid_nginx_header)
    const longHeaderRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/update-preview`, {
      headers: apiHeaders(),
      data: {
        changes: {
          nginxSettings: {
            headers: [
              {
                name: 'Strict-Transport-Security',
                value: `max-age=${'9'.repeat(300)}`,
                always: true,
              },
            ],
          },
        },
      },
    });
    expect(longHeaderRes.status()).toBe(400);
    const longHeaderJson = await longHeaderRes.json();
    expect(longHeaderJson.error?.code).toBe('invalid_nginx_header');

    // 5. httpsMode: 'off' olan bir alan adında httpsRedirect: true zorlama kural ihlali (400 hosting_target_invalid)
    const offRedirectRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/update-preview`, {
      headers: apiHeaders(),
      data: {
        changes: {
          httpsMode: 'off',
          httpsRedirect: true,
        },
      },
    });
    expect(offRedirectRes.status()).toBe(400);
    const offRedirectJson = await offRedirectRes.json();
    expect(['invalid_redirect_policy', 'hosting_target_invalid']).toContain(offRedirectJson.error?.code);
  });

  test('Plesk eşdeğerlik eksiklikleri: Yerleşik HSTS anahtarı ve TLS protokol/şifre seçenekleri arayüzü', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-05: Plesk SSL It! / SSL/TLS ekranındaki yerleşik HSTS yapılandırma anahtarı (max-age, includeSubDomains, preload seçenekleri) ve Tools & Settings altındaki TLS protokol/şifre sürümü (TLS 1.2 / TLS 1.3 min-version) seçici arayüzü YunPanel bünyesinde yer almamaktadır.',
    );

    // Plesk'te SSL/TLS ayarlarında yerleşik "HSTS" açma/kapatma ve max-age seçicisi bulunur.
    // YunPanel SSL sekmesinde bu yerleşik arayüzün bulunmadığını test.fail ile belgele:
    await page.goto('/websites');
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslHstsControl = page.locator('input[name*="hsts"], select[aria-label*="HSTS"], [role="switch"]:has-text("HSTS")');
    await expect(sslHstsControl).toBeVisible({ timeout: 5000 });
  });
});
