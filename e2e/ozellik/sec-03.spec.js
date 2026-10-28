import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SEC-03 ModSecurity/WAF policy, ruleset ve domain istisnaları', () => {
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tsec03-a${agentN}-${Date.now().toString(36)}`;

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

  async function getAuthHeaders(page) {
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = await sessionRes?.json().catch(() => ({}));
    const token = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    const origin = new URL(page.url()).origin;
    return {
      'x-csrf-token': token,
      Origin: origin,
      Referer: `${origin}/`,
    };
  }

  test.afterAll(async ({ browser }) => {
    // 0 Artık ilkesi: Test sırasında eklenebilecek geçici kural/istisna kayıtlarını temizle
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const headers = await getAuthHeaders(page);
      const domainsRes = await page.request.get('/api/panel/domains');
      if (domainsRes.ok()) {
        const domainsData = await domainsRes.json();
        const list = Array.isArray(domainsData) ? domainsData : (domainsData.data || []);
        const target = list.find((w) => w.primaryDomain === 'webrich.news') || list[0];
        const siteId = target?.websiteId || target?.id;
        if (siteId) {
          await page.request.delete(`/api/panel/websites/${siteId}/waf/rules/${prefix}`, { headers }).catch(() => {});
        }
      }
    } catch {
      // Temizlik yoksay
    } finally {
      await context.close();
    }
  });

  test('mutlu yol: Plesk eşdeğeri ModSecurity / WAF politikaları, kural setleri ve domain istisnaları yönetimi', async ({ page }) => {
    // 1. Panel oturumu aç
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Birincil sitenin ID'sini API'den al ve site detay sayfasına git
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsData = await domainsRes.json();
    const domainList = Array.isArray(domainsData) ? domainsData : (domainsData.data || []);
    const domain = domainList.find((w) => w.primaryDomain === 'webrich.news') || domainList[0];
    expect(domain?.id, 'Domain ID tespit edilebilmeli').toBeTruthy();
    const websiteId = domain.websiteId || domain.id;

    await page.goto(`/websites/${encodeURIComponent(domain.id)}`);
    await expect(page.locator('h1, h2, .yp-site-header').first()).toBeVisible({ timeout: 15000 });

    // 2. Arayüzde WAF / ModSecurity araç veya sekmesinin varlığını denetle
    // Plesk'te her domain için "Web Application Firewall (ModSecurity)" ayarları bulunur.
    const wafTabOrCard = page.locator('button, a, .ws-card, [role="tab"]').filter({ hasText: /ModSecurity|WAF|Web Uygulaması Güvenlik Duvarı/i });

    // 3. API uç noktası denetimi: /api/panel/websites/:id/waf
    const wafApiRes = await page.request.get(`/api/panel/websites/${websiteId}/waf`);

    // Plesk eşdeğerliği eksikliği: YunPanel'de WAF / ModSecurity henüz UI ve API düzeyinde mevcut değil.
    if ((await wafTabOrCard.count()) === 0 && (wafApiRes.status() === 404 || wafApiRes.status() === 405)) {
      test.fail(
        true,
        'BULGU SEC-03: Plesk eşdeğeri ModSecurity / WAF politikaları, kural setleri (OWASP CRS, Comodo) ve domain istisna listesi (rule exclusions) arayüzde ve /api/panel/websites/:id/waf uç noktasında henüz uygulanmamıştır.'
      );
    }

    // Arayüzde WAF kontrolünün görünür olması beklenir
    await expect(wafTabOrCard.first()).toBeVisible({ timeout: 5000 });
    expect(wafApiRes.status()).toBe(200);

    const wafData = await wafApiRes.json();
    expect(wafData).toHaveProperty('mode'); // 'on' | 'detection_only' | 'off'
    expect(wafData).toHaveProperty('ruleset'); // 'owasp' | 'comodo'
    expect(Array.isArray(wafData.exclusions)).toBe(true);
  });

  test('hatalı girdi: geçersiz WAF modu veya hatalı kural ID parametreleri reddedilir (400 validation)', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Birincil sitenin ID'sini API'den al
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsData = await domainsRes.json();
    const domainList = Array.isArray(domainsData) ? domainsData : (domainsData.data || []);
    const domain = domainList.find((w) => w.primaryDomain === 'webrich.news') || domainList[0];
    expect(domain?.id).toBeTruthy();
    const websiteId = domain.websiteId || domain.id;

    const headers = await getAuthHeaders(page);

    // Geçersiz WAF modu gönderimi (mode yalnızca 'on', 'detection_only', 'off' olabilir)
    const badModeRes = await page.request.put(`/api/panel/websites/${websiteId}/waf`, {
      headers,
      data: {
        mode: 'invalid_mode_bypass',
        ruleset: 'owasp',
      },
    });

    if (badModeRes.status() === 404 || badModeRes.status() === 405) {
      test.fail(
        true,
        'BULGU SEC-03: WAF API uç noktası (/api/panel/websites/:id/waf) tanımlı olmadığından 400 validation hatası yerine 404/405 dönmektedir.'
      );
    }

    expect(badModeRes.status()).toBe(400);
    const badModeData = await badModeRes.json();
    expect(badModeData.error || badModeData.code).toMatch(/invalid_mode|validation/i);

    // Geçersiz kural ID ile istisna ekleme denetimi (kural ID numerik olmalıdır, örn: 981173)
    const badRuleRes = await page.request.post(`/api/panel/websites/${websiteId}/waf/exclusions`, {
      headers,
      data: {
        ruleId: 'not_a_valid_numeric_id!@#',
        description: 'Geçersiz kural istisnası testi',
      },
    });

    expect(badRuleRes.status()).toBe(400);
  });

  test('fiziksel kanıt: test sunucusunda Nginx ModSecurity modülü ve kural dizini varlığı', async () => {
    // 1. Test sunucusunda libnginx-mod-http-modsecurity paketi kontrolü
    const dpkgCheck = runSsh('dpkg -l | grep -i modsec || echo "modsec_not_installed"');
    const isPackageInstalled = !dpkgCheck.includes('modsec_not_installed') && dpkgCheck.includes('modsec');

    // 2. Nginx derleme parametrelerinde veya modül dizininde modsecurity kontrolü
    const nginxV = runSsh('nginx -V 2>&1');
    const hasModsecModule = nginxV.includes('modsecurity') || runSsh('ls /usr/lib/nginx/modules/ngx_http_modsecurity_module.so 2>/dev/null').includes('ngx_http_modsecurity_module.so');

    // 3. /etc/nginx/modsec veya /etc/modsecurity kural dizinlerinin varlığı
    const modsecDirs = runSsh('ls -d /etc/nginx/modsec /etc/modsecurity 2>/dev/null || echo "no_dirs"');
    const hasDirs = !modsecDirs.includes('no_dirs');

    if (!isPackageInstalled && !hasModsecModule && !hasDirs) {
      test.fail(
        true,
        'BULGU SEC-03: Test sunucusunda (yunpanel-test) Nginx ModSecurity modülü (libnginx-mod-http-modsecurity / ngx_http_modsecurity_module) ve /etc/nginx/modsec kural dizini fiziksel olarak kurulu değildir.'
      );
    }

    expect(isPackageInstalled || hasModsecModule, 'Nginx ModSecurity modülü kurulu olmalı').toBe(true);
    expect(hasDirs, '/etc/nginx/modsec veya /etc/modsecurity dizini mevcut olmalı').toBe(true);
  });
});
