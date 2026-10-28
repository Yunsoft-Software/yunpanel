import { execSync } from 'node:child_process';
import { test, expect, request as apiRequest } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-05 Site ve mail import, kısıtlar ve veri kaybı uyarısı', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tmig05-a${agentN}-${Date.now().toString(36)}`;
  const testDomain = `${prefix}-single.example.com`;
  const testMailbox = 'destek';

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
    // 0 artık ilkesi: İçe aktarım önizlemesi ve kısıt denetimleri salt okunurdur (readOnly: true).
    // Sunucu diskinde veya kontrol düzleminde artık test dosyası kalmadığı kontrol edilir.
    const siteArtifacts = runSsh(`grep -l "${prefix}" /var/lib/yunpanel/control-plane/*.json /etc/nginx/sites-enabled/* 2>/dev/null || true`);
    expect(siteArtifacts).toBe('');
  });

  test('mutlu yol: Tekil site ve e-posta import önizlemesi, kısıt/uyarı ayrıştırması ve fiziksel durum kontrolü', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Tekil site ve ilişkili posta kutusu verisi içeren dışa aktarım yükü
    const singleSitePayload = {
      websites: [
        {
          primaryDomain: testDomain,
          aliases: [`www.${testDomain}`],
          runtime: {
            runtimeType: 'php',
            phpVersion: '8.3',
            documentRoot: 'httpdocs',
          },
          databases: [
            { name: `${prefix}_db`, user: `${prefix}_u`, type: 'mariadb' },
          ],
          mail: {
            domainName: testDomain,
            mailboxes: [
              { name: testMailbox, email: `${testMailbox}@${testDomain}`, quotaMb: 250 },
            ],
            aliases: [
              { source: `yardim@${testDomain}`, destination: `${testMailbox}@${testDomain}` },
            ],
            forwardings: [
              { source: `iletisim@${testDomain}`, destination: 'info@external.org' },
            ],
          },
          dns: {
            records: [
              { type: 'A', name: testDomain, value: '1.2.3.4', ttl: 3600 },
              { type: 'MX', name: testDomain, value: `mail.${testDomain}`, ttl: 3600 },
            ],
          },
          crons: [
            {
              name: 'Mail Sync Worker',
              schedule: '*/15 * * * *',
              command: `php /var/www/vhosts/${testDomain}/artisan mail:sync`,
            },
          ],
        },
      ],
    };

    // 1. Arayüz oturumu üzerinden önizleme API çağrısı
    const previewRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: singleSitePayload,
    });
    expect(previewRes.status(), 'Tekil site ve posta kutusu import önizleme API 200 dönmeli').toBe(200);

    const body = await previewRes.json();
    const preview = body.preview;
    expect(preview).toBeDefined();

    // 2. Kapsam ve özet doğrulamaları
    expect(preview.summary.websitesCount, 'Tekil site ayrıştırılmalı').toBe(1);
    expect(preview.summary.mailboxesCount, 'İlişkili posta kutusu ayrıştırılmalı').toBe(1);
    expect(preview.summary.databasesCount).toBe(1);
    expect(preview.summary.cronsCount).toBe(1);
    expect(preview.readOnly, 'Önizleme salt okunur olmalı').toBe(true);
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);

    // 3. Tekil site ve posta kutusu detay kontrolü
    const importedSite = preview.websites[0];
    expect(importedSite.primaryDomain).toBe(testDomain);
    expect(importedSite.mailDomain).toBeDefined();
    expect(importedSite.mailDomain.mailboxes).toHaveLength(1);
    expect(importedSite.mailDomain.mailboxes[0].email).toBe(`${testMailbox}@${testDomain}`);
    expect(importedSite.mailDomain.aliases[0].source).toBe(`yardim@${testDomain}`);
    expect(importedSite.mailDomain.forwardings[0].destination).toBe('info@external.org');

    // 4. Fiziksel Sonuç: Sunucu üzerindeki temel servislerin canlı ve sağlıklı olduğu doğrulanır
    const serviceHealth = runSsh('systemctl is-active nginx yunpanel-api');
    expect(serviceHealth).toBe('active\nactive');

    // Disk üzerinde yetkisiz kalıcı konfigürasyon oluşmadığı doğrulanır
    const strayFile = runSsh(`test -f /etc/nginx/sites-available/${testDomain}.conf && echo "EXISTS" || echo "CLEAN"`);
    expect(strayFile).toBe('CLEAN');
  });

  test('hatalı girdi ve kısıtlar: .44 yasaklı sunucu engeli, boş yük, bozuk JSON ve kısıt uyarıları', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Güvenlik Kısıtı: .44 yasaklı sunucu referansı 403 ile engellenmeli
    const forbiddenRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          { primaryDomain: 'test-forbidden.example.com', target: '157.180.11.44' },
        ],
      },
    });
    expect(forbiddenRes.status(), '.44 yasaklı sunucu 403 dönmeli').toBe(403);
    const forbiddenJson = await forbiddenRes.json();
    expect(forbiddenJson.error?.code).toBe('plesk_forbidden_target_server');

    // 2. Kısıt: Boş websites listesi 400 ile reddedilmeli
    const emptyRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { websites: [] },
    });
    expect(emptyRes.status(), 'Boş web sitesi listesi 400 dönmeli').toBe(400);
    const emptyJson = await emptyRes.json();
    expect(emptyJson.error?.code).toBe('plesk_export_no_websites');

    // 3. Kısıt: Bozuk JSON formatı 400 ile reddedilmeli
    const invalidJsonRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { exportData: '{corrupted-json-payload}' },
    });
    expect(invalidJsonRes.status(), 'Bozuk JSON 400 dönmeli').toBe(400);

    // 4. Kısıt Uyarısı: Geçersiz cron ifadesi içe aktarmayı düşürmemeli, warnings listesine eklenmeli
    const invalidCronRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          {
            primaryDomain: testDomain,
            crons: [
              { name: 'Gecersiz Cron', schedule: '99 99 * * *', command: 'rm -rf /' },
            ],
          },
        ],
      },
    });
    expect(invalidCronRes.status()).toBe(200);
    const invalidCronJson = await invalidCronRes.json();
    const hasCronWarning = invalidCronJson.preview.warnings.some((w) => w.code === 'cron_expression_invalid');
    expect(hasCronWarning, 'Geçersiz cron için uyarı üretilmeli').toBe(true);

    // 5. Yetkisiz İstek Kısıtı: Kimlik doğrulanmamış context ile erişim engellenmeli (401 veya 403)
    const unauthContext = await apiRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthRes = await unauthContext.post('https://server.cryptoraichu.website/api/panel/importer/plesk/preview', {
        headers: { 'content-type': 'application/json' },
        data: { websites: [{ primaryDomain: 'unauthorized.example.com' }] },
      });
      expect([401, 403]).toContain(unauthRes.status());
    } finally {
      await unauthContext.dispose();
    }
  });

  test('eksiklik 1: Plesk Site Import eşdeğeri tekil site çekme ve aktarma rotası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-05-A: Plesk Site Import eşdeğeri tekil site çekme ve aktarma rotası (/api/panel/importer/site/remote-import) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk'te Site Import uzantısı ile kaynak sunucudan FTP/SSH veya web arayüzü üzerinden
    // tek bir siteyi ve verilerini hedef sunucuya aktaran özel bir servis rotası bulunur.
    const siteImportRes = await page.request.post('/api/panel/importer/site/remote-import', {
      headers,
      data: {
        sourceHost: 'remote.example.com',
        sourceType: 'ssh',
        domainName: testDomain,
        targetDirectory: 'httpdocs',
      },
    });

    expect(siteImportRes.status(), 'Tekil site import rotası 200 dönmeli').toBe(200);
    const siteImportJson = await siteImportRes.json();
    expect(siteImportJson.jobId).toBeDefined();
  });

  test('eksiklik 2: Plesk Mail Import eşdeğeri uzak IMAP posta kutusu senkronizasyon rotası bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-05-B: Plesk Mail Import eşdeğeri uzak IMAP posta kutusu senkronizasyon rotası (/api/panel/importer/mail/imap-sync) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Mail Import ile harici bir e-posta sunucusundaki posta kutuları (IMAP kimlik bilgileriyle)
    // hedefteki ilgili posta kutusuna doğrudan kopyalanıp içe aktarılabilir.
    const mailImportRes = await page.request.post('/api/panel/importer/mail/imap-sync', {
      headers,
      data: {
        sourceServer: 'mail.remote.example.com',
        sourceEmail: 'user@remote.example.com',
        targetEmail: `${testMailbox}@${testDomain}`,
        protocol: 'imap',
      },
    });

    expect(mailImportRes.status(), 'Uzak IMAP mail import rotası 200 dönmeli').toBe(200);
    const mailImportJson = await mailImportRes.json();
    expect(mailImportJson.syncJobId).toBeDefined();
  });

  test('eksiklik 3: Hedefte mevcut site/posta kutusu üzerine yazma kısıtları ve veri kaybı uyarısı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-05-C: Hedefte mevcut site/posta kutusu çakışmalarını tespit eden, veri kaybı uyarısı (data loss warning) üreten ve açık onay kısıtı getiren rota (/api/panel/importer/plesk/check-conflicts) bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator ve Site Import araçlarında, hedef sunucuda var olan bir site veya e-posta kutusu üzerine
    // yazılacaksa açık bir "Veri Kaybı Uyarısı" (Data loss warning) üretilir ve "confirmOverwrite / confirmDataLoss"
    // onayı verilmeden işlem kesinlikle engellenir (Constraint).
    const conflictRes = await page.request.post('/api/panel/importer/plesk/check-conflicts', {
      headers,
      data: {
        targetDomains: [testDomain],
        targetMailboxes: [`${testMailbox}@${testDomain}`],
      },
    });

    expect(conflictRes.status(), 'Çakışma ve veri kaybı analiz rotası 200 dönmeli').toBe(200);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.conflicts).toBeDefined();
    expect(conflictJson.dataLossWarningRequired).toBe(true);
  });

  test('eksiklik 4: Ön yüzde Tekil Site/Mail Import ve Veri Kaybı Onayı arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-05-D: Ön yüzde Web Siteleri ve E-posta sayfalarında Tekil Site Import, Mail Import ve Veri Kaybı Riski Onay modalı bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/sites');

    // Plesk'te siteler listesinde veya detayında "Site Import", "İçe Aktar", "Mail Import" ve
    // mevcut sitenin üzerine yazılacağını belirten "Veri Kaybı Uyarısı" modalı bulunur.
    const importUiElements = page.locator('button:has-text("Site İçe Aktar"), button:has-text("Site Import"), button:has-text("Mail Import"), text="Veri Kaybı Riski", text="Data Loss Warning"');
    await expect(importUiElements.first()).toBeVisible({ timeout: 5000 });
  });
});
