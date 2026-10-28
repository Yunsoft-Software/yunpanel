import { execSync } from 'node:child_process';
import { test, expect, request as apiRequest } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-03 Site, mail, DB, DNS, SSL, kullanıcı verisi ve IP eşleme', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tmig03-a${agentN}-${Date.now().toString(36)}`;
  const testDomain = `${prefix}-portal.example.com`;
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
    // 0 artık ilkesi:
    // İçe aktarma önizleme motoru salt okunurdur (readOnly: true).
    // Sunucuda kalıcı artık veya istenmeyen dosya bırakılmadığı kontrol edilir.
    const siteArtifacts = runSsh(`grep -l "${prefix}" /var/lib/yunpanel/control-plane/*.json /etc/nginx/sites-enabled/* 2>/dev/null || true`);
    expect(siteArtifacts).toBe('');
  });

  test('mutlu yol: Plesk dışa aktarma yükünden Site, Mail, DB, DNS ve SSL bileşen verilerinin ayrıştırılması ve eşlenmesi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const exportPayload = {
      websites: [
        {
          primaryDomain: testDomain,
          aliases: [testAlias],
          runtime: {
            runtimeType: 'php',
            phpVersion: '8.3',
            documentRoot: 'httpdocs',
          },
          databases: [
            { name: `${prefix}_crm`, user: `${prefix}_u`, type: 'mariadb' },
          ],
          mail: {
            mailboxes: [
              { name: 'contact', email: `contact@${testDomain}`, quotaMb: 256 },
            ],
            aliases: [
              { source: `info@${testDomain}`, destination: `contact@${testDomain}` },
            ],
            forwardings: [
              { source: `sales@${testDomain}`, destination: 'remote@partner.example' },
            ],
          },
          dns: {
            records: [
              { type: 'A', name: testDomain, value: '198.51.100.20', ttl: 3600 },
              { type: 'MX', name: testDomain, value: `mail.${testDomain}`, ttl: 3600 },
              { type: 'TXT', name: testDomain, value: 'v=spf1 mx ~all', ttl: 3600 },
            ],
          },
          crons: [
            {
              name: 'CRM Daily Backup',
              schedule: '0 3 * * *',
              command: `php /var/www/vhosts/${testDomain}/artisan schedule:run`,
            },
          ],
          certificates: [
            {
              name: `${prefix}-ssl`,
              certPem: '-----BEGIN CERTIFICATE-----\nMIIC5jCCAc6gAwIBAgIBATANBgkqhkiG9w0BAQsFADAv...\n-----END CERTIFICATE-----',
              privkeyPem: '-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDv...\n-----END PRIVATE KEY-----',
              domains: [testDomain, testAlias],
            },
          ],
        },
      ],
    };

    // 1. API üzerinden Plesk dışa aktarma önizlemesi çağrısı
    const previewRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: exportPayload,
    });

    expect(previewRes.status(), 'Plesk preview API 200 dönmeli').toBe(200);
    const { preview } = await previewRes.json();
    expect(preview, 'preview nesnesi bulunmalı').toBeDefined();

    // 2. Salt okunurluk ve özet metrikleri doğrulaması
    expect(preview.readOnly, 'Önizleme salt okunur olmalı').toBe(true);
    expect(preview.previewDigest, 'previewDigest SHA-256 formatında olmalı').toMatch(/^[a-f0-9]{64}$/);
    expect(preview.summary.websitesCount, '1 web sitesi ayrıştırılmalı').toBe(1);
    expect(preview.summary.domainsCount, '2 alan adı (primary + alias) ayrıştırılmalı').toBe(2);
    expect(preview.summary.databasesCount, '1 veritabanı ayrıştırılmalı').toBe(1);
    expect(preview.summary.mailboxesCount, '1 posta kutusu ayrıştırılmalı').toBe(1);
    expect(preview.summary.dnsZonesCount, '1 DNS bölgesi ayrıştırılmalı').toBe(1);
    expect(preview.summary.cronsCount, '1 zamanlanmış görev ayrıştırılmalı').toBe(1);
    expect(preview.summary.certificatesCount, '1 SSL sertifikası ayrıştırılmalı').toBe(1);

    // 3. Bileşen eşlemelerinin doğrulanması
    const site = preview.websites[0];
    expect(site.primaryDomain).toBe(testDomain);
    expect(site.aliases).toEqual([testAlias]);
    expect(site.runtime.type).toBe('php');
    expect(site.runtime.phpVersion).toBe('8.3');
    expect(site.runtime.documentRoot).toBe('httpdocs');

    // DB eşlemesi
    expect(site.databases[0].name).toBe(`${prefix}_crm`);
    expect(site.databases[0].user).toBe(`${prefix}_u`);
    expect(site.databases[0].type).toBe('mariadb');

    // Mail eşlemesi
    expect(site.mailDomain.mailboxes[0].email).toBe(`contact@${testDomain}`);
    expect(site.mailDomain.mailboxes[0].quotaBytes).toBe(256 * 1024 * 1024);
    expect(site.mailDomain.aliases[0].source).toBe(`info@${testDomain}`);
    expect(site.mailDomain.forwardings[0].destination).toBe('remote@partner.example');

    // DNS eşlemesi
    const aRecord = site.dnsZone.records.find((r) => r.type === 'A');
    expect(aRecord).toBeDefined();
    expect(aRecord.value).toBe('198.51.100.20');

    // SSL eşlemesi
    expect(site.certificates[0].name).toBe(`${prefix}-ssl`);
    expect(site.certificates[0].domains).toEqual([testDomain, testAlias]);

    // 4. Fiziksel kontroller:
    // a) Sunucuda diskte geçici/kalıcı dosya oluşturulmadığının teyidi
    const diskArtifacts = runSsh(`ls -la /var/lib/yunpanel/control-plane/*${prefix}* /etc/nginx/sites-enabled/*${prefix}* 2>&1 || true`);
    expect(diskArtifacts).toContain('No such file');

    // b) Deterministik SHA-256 hash imzası doğrulaması
    expect(preview.previewDigest).toHaveLength(64);
    expect(typeof preview.previewId).toBe('string');
    expect(typeof preview.createdAt).toBe('string');
  });

  test('hatalı girdi ve güvenlik: .44 yasaklı sunucu denetimi, geçersiz yük ve yetkisiz erişim reddi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. .44 sunucu referansı (yasaklı hedef koruması)
    const forbiddenRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          {
            primaryDomain: `${prefix}-bad.example.com`,
            dns: {
              records: [{ type: 'A', name: `${prefix}-bad.example.com`, value: '157.180.11.44' }],
            },
          },
        ],
      },
    });
    expect(forbiddenRes.status(), '.44 referansı HTTP 403 ile engellenmeli').toBe(403);
    const forbiddenJson = await forbiddenRes.json();
    expect(forbiddenJson.code || forbiddenJson.error?.code).toBe('plesk_forbidden_target_server');

    // 2. Boş websites listesi (hatalı girdi)
    const emptyRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: { websites: [] },
    });
    expect(emptyRes.status(), 'Boş websites listesi HTTP 400 dönmeli').toBe(400);

    // 3. Eksik primaryDomain alanı uyarısı
    const warnRes = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: {
        websites: [
          { runtime: { runtimeType: 'static' } },
        ],
      },
    });
    expect(warnRes.status()).toBe(200);
    const warnJson = await warnRes.json();
    expect(warnJson.preview.warnings.some((w) => w.code === 'website_missing_domain')).toBe(true);

    // 4. Yetkisiz erişim denetimi
    const cleanContext = await apiRequest.newContext({
      baseURL: 'https://server.cryptoraichu.website',
      ignoreHTTPSErrors: true,
    });
    try {
      const unauthRes = await cleanContext.post('/api/panel/importer/plesk/preview', {
        headers: { 'content-type': 'application/json' },
        data: { websites: [{ primaryDomain: 'unauth-test.example.com' }] },
      });
      expect([401, 403], 'Yetkisiz istek 401 veya 403 ile reddedilmeli').toContain(unauthRes.status());
    } finally {
      await cleanContext.dispose();
    }
  });

  test('eksiklik 1: Plesk Migrator IP eşleme tablosu (ipMapping) ve DNS A / web listen IP otomatik dönüştürme yeteneği bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-03-A: Plesk Migrator IP eşleme tablosu (ipMapping) ve DNS A / web listen IP otomatik dönüştürme yeteneği bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator'da kaynak sunucunun eski IP adresleri hedef sunucunun yeni IP adresine eşlenir:
    // Örneğin kaynak IP: 198.51.100.20 -> Hedef IP: 178.156.140.28
    const payloadWithIpMapping = {
      ipMapping: {
        '198.51.100.20': '178.156.140.28',
      },
      websites: [
        {
          primaryDomain: testDomain,
          dns: {
            records: [
              { type: 'A', name: testDomain, value: '198.51.100.20', ttl: 3600 },
            ],
          },
        },
      ],
    };

    const res = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: payloadWithIpMapping,
    });
    expect(res.status()).toBe(200);
    const { preview } = await res.json();

    // Plesk Migrator eşdeğerliğinde:
    // 1) preview.ipMappings veya summary.remappedIps listelenmelidir
    expect(preview.ipMappings, 'IP eşleme tablosu önizlemede yer almalı').toBeDefined();
    // 2) İçe aktarılan DNS A kaydındaki eski IP hedef IP ile güncellenmiş olmalıdır
    const aRecord = preview.websites[0]?.dnsZone?.records?.find((r) => r.type === 'A');
    expect(aRecord?.value, 'DNS A kaydı hedef sunucu IP\'sine dönüştürülmeli').toBe('178.156.140.28');
  });

  test('eksiklik 2: Plesk kaynaklarındaki sistem Unix kullanıcısı (systemUser) ve FTP kullanıcı verisi ayrıştırılmıyor ve eşlenmiyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-03-B: Plesk kaynaklarındaki sistem Unix kullanıcısı (systemUser) ve FTP kullanıcı verisi ayrıştırılmıyor ve hedef sisteme eşlenmiyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator web alanı sistem Unix kullanıcısını (sys_user) ve ek FTP kullanıcılarını aktarır:
    const payloadWithUsers = {
      websites: [
        {
          primaryDomain: testDomain,
          systemUser: {
            username: `${prefix}_sys`,
            shell: '/bin/bash',
            home: `/var/www/vhosts/${testDomain}`,
          },
          ftpUsers: [
            {
              username: `${prefix}_ftp`,
              home: 'httpdocs',
              permissions: 'rw',
            },
          ],
        },
      ],
    };

    const res = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: payloadWithUsers,
    });
    expect(res.status()).toBe(200);
    const { preview } = await res.json();

    const site = preview.websites[0];
    // Mevcut ayrıştırıcı systemUser ve ftpUsers alanlarını tamamen yoksayar
    expect(site.systemUser, 'Sistem Unix kullanıcısı normalize edilmeli').toBeDefined();
    expect(site.systemUser?.username).toBe(`${prefix}_sys`);
    expect(Array.isArray(site.ftpUsers), 'FTP kullanıcıları dizisi yer almalı').toBe(true);
    expect(site.ftpUsers?.length).toBe(1);
  });

  test('eksiklik 3: Seçici bileşen filtreleme (selective component mapping) ve çakışma durumunda DB/kullanıcı yeniden adlandırma desteği bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU MIG-03-C: Seçici bileşen filtreleme (selective component mapping) ve çakışma durumunda DB/kullanıcı yeniden adlandırma desteği bulunmuyor');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // Plesk Migrator'da kullanıcı hangi bileşenleri aktaracağını seçebilir (ör. sadece web ve db, mail hariç)
    // ve çakışma durumunda veritabanı adını yeniden adlandırabilir (remapping):
    const selectivePayload = {
      selectedComponents: ['web', 'databases'], // mail ve dns dahil edilmemeli
      dbMapping: {
        [`${prefix}_crm`]: `${prefix}_crm_target`,
      },
      websites: [
        {
          primaryDomain: testDomain,
          databases: [{ name: `${prefix}_crm`, user: 'crm_u' }],
          mail: { mailboxes: [{ name: 'box', email: `box@${testDomain}` }] },
          dns: { records: [{ type: 'A', name: testDomain, value: '1.2.3.4' }] },
        },
      ],
    };

    const res = await page.request.post('/api/panel/importer/plesk/preview', {
      headers,
      data: selectivePayload,
    });
    expect(res.status()).toBe(200);
    const { preview } = await res.json();

    const site = preview.websites[0];
    // Seçici bileşen filtresi uygulandıysa mail ve dns null olmalı:
    expect(site.mailDomain, 'Mail bileşeni seçilmediğinde dahil edilmemeli').toBeNull();
    expect(site.dnsZone, 'DNS bileşeni seçilmediğinde dahil edilmemeli').toBeNull();
    // Yeniden adlandırılan veritabanı adı hedef isim olmalı:
    expect(site.databases[0]?.name, 'Veritabanı adı dbMapping ile dönüştürülmeli').toBe(`${prefix}_crm_target`);
  });
});
