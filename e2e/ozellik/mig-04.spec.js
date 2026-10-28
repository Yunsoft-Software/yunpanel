import { execSync } from 'node:child_process';
import { test, expect, request as apiRequest } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-04 Ön kontrol, tekrar senkronizasyon ve taşıma sonrası doğrulama (Plesk Migrator eşdeğerliği)', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tmig04-a${agentN}-${Date.now().toString(36)}`;
  const testDomain1 = `${prefix}-shop.example.com`;
  const testDomain2 = `${prefix}-node.example.com`;
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
    // 0 artık ilkesi: Ön kontroller salt okunur (readOnly: true) çalışır.
    // Sunucu diskinde veya kontrol düzleminde artık kaynak/dosya kalmadığı doğrulanır.
    const siteArtifacts = runSsh(`grep -l "${prefix}" /var/lib/yunpanel/control-plane/*.json 2>/dev/null || true`);
    expect(siteArtifacts).toBe('');
  });

  test('mutlu yol: Taşıma öncesi ön kontroller (pre-migration check), kaynak analizi ve fiziksel durum doğrulaması', async ({ page }) => {
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
            documentRoot: 'public_html',
          },
          databases: [
            { name: `${prefix}_db`, user: `${prefix}_u`, type: 'mariadb' },
          ],
          mail: {
            mailboxes: [
              { name: 'support', email: `support@${testDomain1}`, quotaMb: 1024 },
            ],
            aliases: [
              { source: `help@${testDomain1}`, destination: `support@${testDomain1}` },
            ],
          },
          dns: {
            records: [
              { type: 'A', name: testDomain1, value: '5.6.7.8', ttl: 3600 },
              { type: 'MX', name: testDomain1, value: `mail.${testDomain1}`, ttl: 3600 },
            ],
          },
          crons: [
            {
              name: 'Queue Worker',
              schedule: '* * * * *',
              command: `php /var/www/vhosts/${testDomain1}/artisan queue:work --stop-when-empty`,
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
        },
        {
          primaryDomain: testDomain2,
          runtime: {
            runtimeType: 'node',
            nodeVersion: '22',
            documentRoot: 'dist',
            entryFile: 'index.js',
          },
        },
      ],
    };

    // 1. Ön kontrol (pre-check) rotasını çağır ve analiz doğrula
    const previewRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: exportPayload,
    });

    expect(previewRes.status(), 'Plesk ön kontrol uç noktası HTTP 200 dönmeli').toBe(200);
    const previewJson = await previewRes.json();
    expect(previewJson.preview).toBeDefined();

    const { preview } = previewJson;
    expect(preview.readOnly, 'Ön kontrol salt okunur olmalı').toBe(true);
    expect(preview.previewId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(preview.previewDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.summary.websitesCount).toBe(2);
    expect(preview.summary.domainsCount).toBe(3);
    expect(preview.summary.databasesCount).toBe(1);
    expect(preview.summary.mailboxesCount).toBe(1);
    expect(preview.summary.dnsZonesCount).toBe(1);
    expect(preview.summary.cronsCount).toBe(1);
    expect(preview.summary.certificatesCount).toBe(1);
    expect(preview.warnings).toEqual([]);

    // 2. Normalizasyon ve çalışma zamanı ön kontrollerinin doğrulanması
    const phpSite = preview.websites.find((w) => w.primaryDomain === testDomain1);
    expect(phpSite).toBeDefined();
    expect(phpSite.runtime.type).toBe('php');
    expect(phpSite.runtime.phpVersion).toBe('8.3');
    expect(phpSite.databases[0].name).toBe(`${prefix}_db`);
    expect(phpSite.mailDomain.mailboxes[0].email).toBe(`support@${testDomain1}`);
    expect(phpSite.crons[0].name).toBe('Queue Worker');

    const nodeSite = preview.websites.find((w) => w.primaryDomain === testDomain2);
    expect(nodeSite).toBeDefined();
    expect(nodeSite.runtime.type).toBe('node');
    expect(nodeSite.runtime.nodeMajor).toBe('22');

    // 3. Fiziksel Sonuç (SSH): Ön kontrolün sistemde hiçbir yetkisiz dosya veya konfigürasyon açmadığı,
    // API servisinin aktif olduğu ve Nginx sanal konaklarının temiz kaldığı doğrulanır.
    const apiStatus = runSsh('systemctl is-active yunpanel-api');
    expect(apiStatus).toBe('active');

    const vhostCheck = runSsh(`ls /etc/nginx/sites-available/*${prefix}* 2>/dev/null || true`);
    expect(vhostCheck).toBe('');

    const registryCheck = runSsh(`grep -l "${testDomain1}" /var/lib/yunpanel/control-plane/website-registry.json 2>/dev/null || true`);
    expect(registryCheck).toBe('');
  });

  test('hatalı girdi ve güvenlik: .44 yasaklı sunucu engeli, boş yük ve geçersiz alan adı uyarısı', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Güvenlik: Yasaklı Plesk hedefi (.44 sunucusu) ön kontrol aşamasında 403 ile engellenmeli
    const forbiddenRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          {
            primaryDomain: `${prefix}-forbidden.net`,
            target: '157.180.11.44',
          },
        ],
      },
    });
    expect(forbiddenRes.status(), 'Yasaklı .44 hedefi 403 ile reddedilmeli').toBe(403);
    const forbiddenJson = await forbiddenRes.json();
    expect(forbiddenJson.error?.code).toBe('plesk_forbidden_target_server');

    // 2. Hatalı Girdi: Boş web sitesi listesi 400 ile reddedilmeli
    const emptyRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { websites: [] },
    });
    expect(emptyRes.status(), 'Boş websites listesi 400 dönmeli').toBe(400);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.error?.code).toBe('plesk_export_no_websites');

    // 3. Hatalı Girdi: Bozuk JSON dizgesi 400 ile reddedilmeli
    const invalidJsonRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { exportData: '{{{broken-json' },
    });
    expect(invalidJsonRes.status(), 'Bozuk JSON 400 dönmeli').toBe(400);

    // 4. Doğrulama Uyarısı: Geçersiz alan adı taşıma listesinden elenmeli ve uyarılara eklenmeli
    const warningRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          { primaryDomain: testDomain1 },
          { primaryDomain: 'invalid..domain--format!' },
        ],
      },
    });
    expect(warningRes.status()).toBe(200);
    const warningJson = await warningRes.json();
    expect(warningJson.preview.summary.websitesCount).toBe(1);
    expect(warningJson.preview.warnings.some((w) => w.code === 'domain_name_invalid')).toBe(true);

    // 5. Yetkisiz İstek: Kimlik doğrulanmamış context ile erişim engellenmeli (401 veya 403)
    const unauthContext = await apiRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthRes = await unauthContext.post('https://server.cryptoraichu.website/api/panel/importer/plesk/preview', {
        headers: { 'content-type': 'application/json' },
        data: { websites: [{ primaryDomain: 'example.com' }] },
      });
      expect([401, 403]).toContain(unauthRes.status());
    } finally {
      await unauthContext.dispose();
    }
  });

  test('eksiklik 1: Sunucu donanım/kaynak (disk alanı, RAM) ve PHP sürüm uyumluluk ön kontrol rotası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-04-A: Plesk Migrator hedef sunucu disk alanı yeterliliği ve PHP modül/sürüm uyumluluk ön kontrol rotası (/api/panel/importer/plesk/precheck) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator taşıma öncesinde hedef sunucunun disk alanı, RAM ve PHP sürüm uyumluluğunu
    // dinamik olarak kontrol edip detaylı bir "Pre-migration check issues" listesi sunar.
    const precheckRes = await page.request.post('/api/panel/importer/plesk/precheck', {
      headers,
      data: {
        targetServer: 'local',
        requiredDiskMb: 5120,
        requiredPhpVersions: ['8.2', '8.3'],
      },
    });

    expect(precheckRes.status(), 'Ön kontrol ve kaynak uyumluluk rotası 200 dönmeli').toBe(200);
    const precheckJson = await precheckRes.json();
    expect(precheckJson.diskSpaceAvailable).toBeDefined();
    expect(precheckJson.phpCompatibility).toBeDefined();
  });

  test('eksiklik 2: Tekrar senkronizasyon (Re-sync / Sync remaining data) API uç noktası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-04-B: Plesk Migrator eşdeğeri tekrar senkronizasyon (Re-sync) rotası (/api/panel/importer/plesk/resync veya /api/migration/resync) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator'da ilk taşımadan sonra güncellenen dosyaları, veritabanını ve postaları
    // tekrar senkronize eden "Re-sync" mekanizması bulunur.
    const resyncRes = await page.request.post('/api/panel/importer/plesk/resync', {
      headers,
      data: {
        websiteDomain: testDomain1,
        syncItems: ['files', 'databases', 'mail'],
      },
    });

    expect(resyncRes.status(), 'Tekrar senkronizasyon (Re-sync) rotası 200 dönmeli').toBe(200);
    const resyncJson = await resyncRes.json();
    expect(resyncJson.syncJobId).toBeDefined();
  });

  test('eksiklik 3: Taşıma sonrası otomatik doğrulama (Post-migration validation) rotası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-04-C: Taşınan sitelerin HTTP/HTTPS, SSL, sanal konak ve DB bağlantılarını test eden post-migration validation rotası (/api/panel/importer/plesk/validate) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator'da taşıma tamamlandıktan sonra sitelerin HTTP yanıtı, SSL sertifikası
    // ve DB bağlantılarını test eden otomatik doğrulama mekanizması ("Check Migrated Sites") vardır.
    const validateRes = await page.request.post('/api/panel/importer/plesk/validate', {
      headers,
      data: {
        domains: [testDomain1],
        checks: ['http_status', 'ssl_certificate', 'database_connection'],
      },
    });

    expect(validateRes.status(), 'Taşıma sonrası doğrulama (validation) rotası 200 dönmeli').toBe(200);
    const validateJson = await validateRes.json();
    expect(validateJson.validationResults).toBeDefined();
  });

  test('eksiklik 4: Ön yüzde Ön Kontrol (Pre-check), Tekrar Senkronizasyon (Re-sync) ve Doğrulama arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-04-D: Ön yüzde Taşıma Ön Kontrolü (Pre-check), Tekrar Senkronizasyon (Re-sync) ve Doğrulama (Validation) arayüzü bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings');

    // Plesk Migrator arayüzünde ön kontrol listesi, re-sync düğmesi ve taşıma sonrası doğrulama özeti yer alır.
    const migratorControls = page.locator('text="Tekrar Senkronize Et", text="Re-sync", text="Ön Kontrol", text="Taşıma Doğrulama", text="Pre-migration Check"');
    await expect(migratorControls.first()).toBeVisible({ timeout: 5000 });
  });
});
