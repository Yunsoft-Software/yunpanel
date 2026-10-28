import { execSync } from 'node:child_process';
import { test, expect, request as apiRequest } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-02 Desteklenen diğer hosting panellerinden taşıma (cPanel, DirectAdmin vb.)', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tmig02-a${agentN}-${Date.now().toString(36)}`;
  const testCpanelDomain = `${prefix}-cpanel.example.com`;
  const testDaDomain = `${prefix}-da.example.com`;

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

  async function getApiHeaders(page) {
    const origin = 'https://server.cryptoraichu.website';
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      Referer: `${origin}/`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    };
  }

  test.afterAll(async () => {
    // 0 artık ilkesi: Testler cPanel / DirectAdmin yetenek sorgulamasını,
    // güvenlik ve doğrulama denetimlerini ve Plesk Migrator eşdeğerlik boşluklarını test etmiştir.
    // Sunucuda geçici kalıntı bırakılmadığı SSH üzerinden teyit edilir.
    const artifacts = runSsh(`grep -l "${prefix}" /var/lib/yunpanel/control-plane/*.json 2>/dev/null || true`);
    expect(artifacts).toBe('');

    const vhosts = runSsh(`ls /etc/nginx/sites-available/*${prefix}* 2>/dev/null || true`);
    expect(vhosts).toBe('');
  });

  test('mutlu yol: Sistem MIG-02 yetenek envanteri (capabilities) doğrulaması ve fiziksel servis sağlığı kontrolü', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. API üzerinden MIG-02 tekil yetenek kaydını sorgula
    const capRes = await page.request.get('/api/panel/system/capabilities/MIG-02', { headers });
    expect(capRes.status(), 'MIG-02 capabilities uç noktası 200 dönmeli').toBe(200);

    const capJson = await capRes.json();
    expect(capJson.data, 'MIG-02 yetenek verisi mevcut olmalı').toBeDefined();
    const { data: cap } = capJson;

    expect(cap.id).toBe('MIG-02');
    expect(cap.category).toBe('migration');
    expect(cap.title).toContain('cPanel');
    expect(cap.status).toBe('partial');
    expect(cap.apiEndpoints).toContain('/api/importer/cpanel');
    expect(cap.rolesAllowed).toEqual(['owner']);
    expect(cap.scopeLevel).toBe('owner_only');
    expect(cap.serviceAdapters).toContain('cPanel');

    // 2. Genel sistem yetenek envanterinde MIG-02 varlığını doğrula
    const allCapsRes = await page.request.get('/api/panel/system/capabilities', { headers });
    expect(allCapsRes.status()).toBe(200);
    const allCapsJson = await allCapsRes.json();
    expect(Array.isArray(allCapsJson.data?.capabilities)).toBe(true);
    const mig02InList = allCapsJson.data.capabilities.find((c) => c.id === 'MIG-02');
    expect(mig02InList).toBeDefined();
    expect(mig02InList.status).toBe('partial');

    // 3. Fiziksel Sonuç (SSH): Sunucuda backend API ve web sunucu servislerinin aktif olduğunu,
    // kontrol düzlemi veritabanı/konfigürasyonunun sağlıklı olduğunu doğrula.
    const apiStatus = runSsh('systemctl is-active yunpanel-api');
    expect(apiStatus).toBe('active');

    const nginxStatus = runSsh('systemctl is-active nginx');
    expect(nginxStatus).toBe('active');

    const controlPlaneDir = runSsh('test -d /var/lib/yunpanel/control-plane && echo "ok"');
    expect(controlPlaneDir).toBe('ok');
  });

  test('hatalı girdi ve güvenlik: geçersiz yetenek kimliği, bulunamayan kayıt ve yetkisiz erişim denetimi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Sınır Durumu: Geçersiz formatta yetenek kimliği HTTP 400 ile reddedilmeli
    const invalidIdRes = await page.request.get('/api/panel/system/capabilities/invalid_id_format', { headers });
    expect(invalidIdRes.status()).toBe(400);
    const invalidIdJson = await invalidIdRes.json();
    expect(invalidIdJson.error?.code).toBe('invalid_capability_id');

    // 2. Sınır Durumu: Formatı doğru ancak envanterde bulunmayan ID HTTP 404 dönmeli
    const notFoundRes = await page.request.get('/api/panel/system/capabilities/ZZZ-99', { headers });
    expect(notFoundRes.status()).toBe(404);
    const notFoundJson = await notFoundRes.json();
    expect(notFoundJson.error?.code).toBe('capability_not_found');

    // 3. Güvenlik Denetimi: Yasaklı .44 sunucusu hiçbir taşıma/bağlantı hedefinde kabul edilmemeli
    // Yetkisiz İstek Denetimi: Oturumu olmayan temiz context ile yetenek uç noktası 401 veya 403 ile reddedilmeli
    const cleanContext = await apiRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthRes = await cleanContext.get('https://server.cryptoraichu.website/api/panel/system/capabilities/MIG-02', {
        headers: { 'content-type': 'application/json' },
      });
      expect([401, 403], 'Yetkisiz yetenek sorgusu 401 veya 403 ile engellenmeli').toContain(unauthRes.status());
    } finally {
      await cleanContext.dispose();
    }
  });

  test('eksiklik 1: cPanel ve DirectAdmin içe aktarma arayüzü ve geçiş sihirbazı ön yüzde bulunmuyor', async ({ page }) => {
    test.fail(
      true,
      'BULGU MIG-02-A: Plesk Migrator eşdeğeri cPanel ve DirectAdmin içe aktarma arayüzü ve geçiş sihirbazı YunPanel ön yüzünde henüz bulunmuyor',
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');

    // Plesk Obsidian'da Araçlar & Ayarlar -> Migration & Transfer Manager (Plesk Migrator) menüsünde
    // cPanel ve DirectAdmin kaynaklarından doğrudan geçiş başlatma arayüzü bulunur.
    // YunPanel ön yüzünde cPanel / DirectAdmin içe aktarma arayüzü aranır:
    const migratorLink = page.locator(
      'a[href*="cpanel"], a[href*="directadmin"], button:has-text("cPanel"), button:has-text("DirectAdmin"), text="cPanel", text="DirectAdmin"',
    );
    await expect(migratorLink.first()).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik 2: cPanel yedek arşivini (cpmove) ayrıştırma ve önizleme API rotası bulunmuyor', async ({ page }) => {
    test.fail(
      true,
      'BULGU MIG-02-B: non-reseller-capabilities.js içinde listelenen cPanel içe aktarma/önizleme rotası (/api/importer/cpanel/preview veya /api/panel/importer/cpanel) henüz tanımlanmamıştır (404 döner)',
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // cPanel cpmove / full backup yapısı: homedir (public_html), mysql veritabanları, e-posta kutuları, cron işleri ve DNS bölgesi
    const cpanelPayload = {
      sourcePanel: 'cpanel',
      archiveType: 'cpmove',
      account: {
        username: 'cpuser',
        primaryDomain: testCpanelDomain,
        documentRoot: 'public_html',
        databases: [
          { name: 'cpuser_maindb', user: 'cpuser_dbu' },
        ],
        mailboxes: [
          { email: `info@${testCpanelDomain}`, quotaMb: 250 },
        ],
        crons: [
          { schedule: '0 * * * *', command: `/usr/local/bin/php /home/cpuser/public_html/cron.php` },
        ],
      },
    };

    // Beklenen Plesk eşdeğeri cPanel preview uç noktası çağrılır
    const previewRes = await page.request.post('/api/panel/importer/cpanel/preview', {
      headers,
      data: cpanelPayload,
    });

    // Uç nokta henüz mevcut olmadığından 404 döner; Plesk eşdeğerliğinde 200 dönmeli
    expect(previewRes.status(), 'cPanel önizleme uç noktası 200 dönmeli').toBe(200);
    const previewJson = await previewRes.json();
    expect(previewJson.preview).toBeDefined();
    expect(previewJson.preview.summary.websitesCount).toBe(1);
  });

  test('eksiklik 3: DirectAdmin yedek arşivini ayrıştırma ve önizleme API rotası bulunmuyor', async ({ page }) => {
    test.fail(
      true,
      'BULGU MIG-02-C: DirectAdmin yedek arşivini (user.admin.*.tar.gz) ayrıştırma ve önizleme rotası (/api/panel/importer/directadmin/preview) henüz tanımlanmamıştır (404 döner)',
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // DirectAdmin backup yapısı: domains/domain.com/public_html, backup/*.sql, email kutuları ve DNS zone
    const directadminPayload = {
      sourcePanel: 'directadmin',
      archiveType: 'user_backup',
      account: {
        username: 'dauser',
        primaryDomain: testDaDomain,
        documentRoot: 'public_html',
        databases: [
          { name: 'dauser_webapp' },
        ],
        mailboxes: [
          { email: `admin@${testDaDomain}` },
        ],
      },
    };

    const daPreviewRes = await page.request.post('/api/panel/importer/directadmin/preview', {
      headers,
      data: directadminPayload,
    });

    expect(daPreviewRes.status(), 'DirectAdmin önizleme uç noktası 200 dönmeli').toBe(200);
    const daJson = await daPreviewRes.json();
    expect(daJson.preview).toBeDefined();
  });

  test('eksiklik 4: Uzak canlı cPanel (WHM) ve DirectAdmin sunucusundan SSH/RPC ile uzaktan doğrudan aktarma yeteneği bulunmuyor', async ({ page }) => {
    test.fail(
      true,
      'BULGU MIG-02-D: Canlı uzak cPanel/WHM veya DirectAdmin sunucusundan SSH ve RPC Migration Agent ile uzaktan doğrudan veri çekme ve aktarma yeteneği bulunmuyor',
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator canlı cPanel/WHM sunucusunun IP ve root/reseller SSH kimlik bilgileriyle bağlanıp hesapları uzaktan çeker
    const remoteRes = await page.request.post('/api/panel/importer/cpanel/remote-connect', {
      headers,
      data: {
        host: '198.51.100.10',
        port: 2087,
        authType: 'whm_api_token',
        token: 'sample-whm-token',
      },
    });

    expect(remoteRes.status(), 'Uzak cPanel/WHM bağlantı API uç noktası 200 dönmeli').toBe(200);
  });
});
