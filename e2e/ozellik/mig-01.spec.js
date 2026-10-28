import { execSync } from 'node:child_process';
import { test, expect, request as apiRequest } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-01 Plesk\'ten kaynakları içe aktarma ve Plesk Migrator eşdeğerliği', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tmig01-a${agentN}-${Date.now().toString(36)}`;
  const testDomain1 = `${prefix}-app.example.com`;
  const testDomain2 = `${prefix}-api.example.com`;
  const testAlias = `${prefix}-alias.example.org`;

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
    // 0 artık ilkesi: Testler Plesk çevrimdışı dışa aktarım ayrıştırıcısını,
    // güvenlik kontrollerini ve Plesk Migrator eşdeğerlik eksikliklerini test etmiştir.
    // Önizleme salt okunur (readOnly: true) olduğundan ve diskte kalıcı kayıt oluşturmadığından
    // sunucuda temizlik gerektiren artık kaynak kalmadığı doğrulanır.
    const siteArtifacts = runSsh(`grep -l "${prefix}" /var/lib/yunpanel/control-plane/*.json 2>/dev/null || true`);
    expect(siteArtifacts).toBe('');
  });

  test('mutlu yol: Plesk çevrimdışı dışa aktarma (offline export) verisi önizlemesi, normalizasyonu ve fiziksel kontrol', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const exportPayload = {
      websites: [
        {
          primaryDomain: testDomain1,
          aliases: [testAlias],
          runtime: {
            runtimeType: 'php',
            phpVersion: '8.3',
            documentRoot: 'httpdocs',
          },
          databases: [
            { name: `${prefix}_db`, user: `${prefix}_usr`, type: 'mariadb' },
          ],
          mail: {
            mailboxes: [
              { name: 'info', email: `info@${testDomain1}`, quotaMb: 500 },
            ],
            aliases: [
              { source: `contact@${testDomain1}`, destination: `info@${testDomain1}` },
            ],
            forwardings: [
              { source: `forward@${testDomain1}`, destination: 'external@example.net' },
            ],
          },
          dns: {
            records: [
              { type: 'A', name: testDomain1, value: '1.2.3.4', ttl: 3600 },
              { type: 'CNAME', name: `www.${testDomain1}`, value: testDomain1, ttl: 3600 },
            ],
          },
          crons: [
            {
              name: 'Laravel Scheduler',
              schedule: '0 0 * * *',
              command: `php /var/www/vhosts/${testDomain1}/artisan schedule:run`,
            },
          ],
          certificates: [
            {
              name: `${testDomain1}-cert`,
              certPem: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
              privkeyPem: '-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----',
              domains: [testDomain1, testAlias],
            },
          ],
          backups: [
            {
              name: 'backup_20261028.tar',
              path: `/var/lib/plesk/backups/${testDomain1}.tar`,
              sizeBytes: 52428800,
            },
          ],
        },
        {
          primaryDomain: testDomain2,
          runtime: {
            runtimeType: 'node',
            nodeVersion: '24',
            documentRoot: 'public',
            entryFile: 'server.js',
          },
        },
      ],
    };

    // 1. API üzerinden Plesk dışa aktarma önizlemesi çağrısı
    const previewRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: exportPayload,
    });

    expect(previewRes.status(), 'Plesk preview endpoint 200 dönmeli').toBe(200);
    const previewJson = await previewRes.json();
    expect(previewJson.preview, 'preview nesnesi mevcut olmalı').toBeDefined();

    const { preview } = previewJson;
    expect(preview.readOnly, 'Önizleme readOnly olmalı').toBe(true);
    expect(preview.previewId, 'previewId UUID olmalı').toMatch(/^[0-9a-f-]{36}$/i);
    expect(preview.serverId, 'serverId tanımlı olmalı').toMatch(/^[0-9a-f-]{36}$/i);
    expect(preview.previewDigest, 'previewDigest 64 karakter sha256 hash olmalı').toMatch(/^[0-9a-f]{64}$/);

    // 2. Özet sayıları doğrulama
    expect(preview.summary.websitesCount).toBe(2);
    expect(preview.summary.domainsCount).toBe(3); // testDomain1 + testAlias + testDomain2
    expect(preview.summary.databasesCount).toBe(1);
    expect(preview.summary.mailboxesCount).toBe(1);
    expect(preview.summary.dnsZonesCount).toBe(1);
    expect(preview.summary.cronsCount).toBe(1);
    expect(preview.summary.certificatesCount).toBe(1);
    expect(preview.warnings).toEqual([]);

    // 3. Normalizasyon doğrulamaları
    const phpSite = preview.websites.find((w) => w.primaryDomain === testDomain1);
    expect(phpSite).toBeDefined();
    expect(phpSite.runtime.type).toBe('php');
    expect(phpSite.runtime.phpVersion).toBe('8.3');
    expect(phpSite.runtime.handler).toBe('fpm');
    expect(phpSite.databases[0].name).toBe(`${prefix}_db`);
    expect(phpSite.mailDomain.mailboxes[0].email).toBe(`info@${testDomain1}`);
    expect(phpSite.dnsZone.records.length).toBe(2);
    expect(phpSite.crons[0].command).toBe(`php /var/www/vhosts/${testDomain1}/artisan schedule:run`);

    const nodeSite = preview.websites.find((w) => w.primaryDomain === testDomain2);
    expect(nodeSite).toBeDefined();
    expect(nodeSite.runtime.type).toBe('node');
    expect(nodeSite.runtime.nodeMajor).toBe('24');
    expect(nodeSite.runtime.runtimeAdapter).toBe('passenger');

    // 4. Fiziksel Sonuç (SSH): Önizleme işleminin sunucuda kesinlikle salt okunur çalıştığı,
    // hiçbir dosya veya sanal konak oluşturmadığı ve API servisinin aktif olduğu kanıtlanır.
    const apiStatus = runSsh('systemctl is-active yunpanel-api');
    expect(apiStatus).toBe('active');

    const vhostCheck = runSsh(`ls /etc/nginx/sites-available/*${prefix}* 2>/dev/null || true`);
    expect(vhostCheck).toBe('');

    const registryCheck = runSsh(`grep -l "${testDomain1}" /var/lib/yunpanel/control-plane/website-registry.json 2>/dev/null || true`);
    expect(registryCheck).toBe('');
  });

  test('hatalı girdi ve güvenlik: .44 yasaklı sunucu engeli, boş dışa aktarma ve yetkisiz erişim denetimi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Güvenlik Denetimi: Yasaklı hedef (.44 Plesk sunucusu) içeren dışa aktarma yükü HTTP 403 ile reddedilmeli
    const forbiddenPayload = {
      websites: [
        {
          primaryDomain: `${prefix}-blocked.com`,
          target: '157.180.11.44',
        },
      ],
    };

    const forbiddenRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: forbiddenPayload,
    });
    expect(forbiddenRes.status(), '.44 içeren yük 403 ile engellenmeli').toBe(403);
    const forbiddenJson = await forbiddenRes.json();
    expect(forbiddenJson.error?.code).toBe('plesk_forbidden_target_server');

    // 2. Sınır Durumu: Boş web sitesi listesi HTTP 400 ile reddedilmeli
    const emptyRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { websites: [] },
    });
    expect(emptyRes.status(), 'Boş websites listesi 400 dönmeli').toBe(400);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.error?.code).toBe('plesk_export_no_websites');

    // 3. Sınır Durumu: Geçersiz JSON dizgesi HTTP 400 ile reddedilmeli
    const invalidJsonRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { exportData: '{ broken json' },
    });
    expect(invalidJsonRes.status(), 'Geçersiz JSON string 400 dönmeli').toBe(400);
    const invalidJsonData = await invalidJsonRes.json();
    expect(invalidJsonData.error?.code).toBe('plesk_export_invalid_json');

    // 4. Uyarı (Warning) Denetimi: Geçersiz alan adı içeren kayıt websites listesinden çıkarılıp uyarı üretmeli
    const warningPayload = {
      websites: [
        {
          primaryDomain: testDomain1,
        },
        {
          primaryDomain: 'invalid..domain--!',
        },
      ],
    };
    const warningRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: warningPayload,
    });
    expect(warningRes.status()).toBe(200);
    const warningJson = await warningRes.json();
    expect(warningJson.preview.summary.websitesCount).toBe(1);
    expect(warningJson.preview.warnings.some((w) => w.code === 'domain_name_invalid')).toBe(true);

    // 5. Yetkisiz İstek Denetimi: Oturum açılmamış context ile preview rotası reddedilmeli (401 / 403)
    const cleanContext = await apiRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthRes = await cleanContext.post('https://server.cryptoraichu.website/api/panel/importer/plesk/preview', {
        headers: { 'content-type': 'application/json' },
        data: { websites: [{ primaryDomain: 'example.com' }] },
      });
      expect([401, 403], 'Yetkisiz istek 401 veya 403 ile reddedilmeli').toContain(unauthRes.status());
    } finally {
      await cleanContext.dispose();
    }
  });

  test('eksiklik 1: Plesk Migrator UI (menü, içe aktarma sihirbazı veya yükleme arayüzü) bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-01-A: Plesk Migrator UI arayüzü (menü, içe aktarma sihirbazı ve yükleme formu) YunPanel ön yüzünde henüz bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');

    // Plesk Obsidian'da Araçlar & Ayarlar altında "Migration & Transfer Manager" ve uzantılarda "Plesk Migrator" arayüzü yer alır.
    // YunPanel ön yüzünde Plesk içe aktarma / taşıma arayüzü aranır:
    const migratorLink = page.locator('a[href*="migrat"], a[href*="import"], button:has-text("Plesk"), text="Plesk Migrator", text="İçe Aktar"');
    await expect(migratorLink.first()).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik 2: Plesk Müşteri, Bayi, Hizmet Paketi ve Abonelik hiyerarşisi içe aktarma ayrıştırıcısında desteklenmiyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-01-B: Plesk Müşteri (Customer), Bayi (Reseller), Hizmet Paketi (Service Plan) ve Abonelik (Subscription) nesneleri içe aktarma ayrıştırıcısında desteklenmiyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator tüm hiyerarşiyi (Resellers, Customers, Service Plans, Subscriptions) taşır.
    const fullHierarchyPayload = {
      resellers: [
        { username: 'reseller1', email: 'reseller1@example.com' },
      ],
      customers: [
        { username: 'client1', email: 'client1@example.com', reseller: 'reseller1' },
      ],
      plans: [
        { name: 'Gold Plan', quotaMb: 10240 },
      ],
      subscriptions: [
        { name: testDomain1, plan: 'Gold Plan', customer: 'client1' },
      ],
      websites: [
        { primaryDomain: testDomain1 },
      ],
    };

    const res = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: fullHierarchyPayload,
    });
    expect(res.status()).toBe(200);
    const json = await res.json();

    // plesk-importer.js yalnızca websites dizisini ayrıştırır, müşteri/bayi/paket/abonelik alanlarını görmezden gelir.
    expect(json.preview.summary.resellersCount, 'resellersCount özette dönmeli').toBe(1);
    expect(json.preview.summary.customersCount, 'customersCount özette dönmeli').toBe(1);
    expect(json.preview.summary.plansCount, 'plansCount özette dönmeli').toBe(1);
    expect(json.preview.summary.subscriptionsCount, 'subscriptionsCount özette dönmeli').toBe(1);
  });

  test('eksiklik 3: Önizlenen Plesk kaynaklarını sisteme içe aktarma ve provizyonlama yürütme rotası (/api/panel/importer/plesk/import) bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-01-C: Plesk kaynaklarını sunucuya içe aktarma ve provizyonlama yürütme rotası (/api/panel/importer/plesk/import) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // non-reseller-capabilities.js içinde MIG-01 için listelenen gerçek içe aktarma uç noktası:
    // POST /api/panel/importer/plesk/import
    const importRes = await page.request.post('/api/panel/importer/plesk/import', {
      headers,
      data: {
        exportData: {
          websites: [{ primaryDomain: `${prefix}-import.example.com` }],
        },
      },
    });

    // Rota plesk-importer-http.js içinde tanımlanmadığı için HTTP 404 döner.
    expect(importRes.status(), 'İçe aktarma yürütme rotası 200 dönmeli').toBe(200);
    const importJson = await importRes.json();
    expect(importJson.operationId || importJson.jobId).toBeDefined();
  });

  test('eksiklik 4: Canlı uzak Plesk sunucusundan SSH ve RPC Migration Agent ile uzaktan doğrudan aktarma yeteneği bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-01-D: Canlı uzak Plesk sunucusundan SSH ve RPC Migration Agent ile uzaktan doğrudan aktarma yeteneği bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator uzak kaynak sunucuya SSH/RPC agent ile bağlanıp konfigürasyonu doğrudan çeker.
    const remoteConnectRes = await page.request.post('/api/panel/importer/plesk/remote-connect', {
      headers,
      data: {
        host: '93.184.216.34', // example.com IP
        port: 22,
        username: 'root',
        authType: 'ssh_key',
      },
    });

    expect(remoteConnectRes.status(), 'Uzak bağlantı ve migration agent API uç noktası 200 dönmeli').toBe(200);
  });
});
