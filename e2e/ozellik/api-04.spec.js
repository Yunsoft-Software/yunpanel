import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('API-04 Tek kullanımlık oturum, SSO ve denetlenebilir bağlam değişimi', () => {
  test.setTimeout(180000);

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
    };
  }

  test.afterAll(async () => {
    // 0 artık ilkesi: API-04 testleri tek kullanımlık oturum/SSO handoff yeteneklerini,
    // replay korumasını ve audit log doğrulamasını kapsar; geçici oturumlar anında tüketilir
    // veya düşürülür, sunucuda kalıcı artık kaynak bırakılmaz.
  });

  test('mutlu yol: tek kullanımlık SSO handoff token üretimi, oturum tüketimi ve fiziksel replay engellemesi', async ({ page }) => {
    // 1. Arayüzden Owner girişi yap
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 2. Arayüz: Denetim kayıtları (/audit) sayfasının açılması ve doğrulanması
    await page.goto('/audit');
    await expect(page.locator('h1', { hasText: 'Denetim kayıtları' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.ws-table tbody tr').first()).toBeVisible({ timeout: 15000 });

    const headers = await getApiHeaders(page);

    // 3. Sunucu ve Veritabanı envanterinden geçerli credentialId tespit et
    const serversRes = await page.request.get('/api/panel/servers', { headers });
    expect(serversRes.status()).toBe(200);
    const serversJson = await serversRes.json();
    const server = serversJson.data?.[0];
    expect(server?.id).toBeDefined();

    const dbsRes = await page.request.get(`/api/panel/servers/${server.id}/databases`, { headers });
    expect(dbsRes.status()).toBe(200);
    const dbsJson = await dbsRes.json();
    const ownedDb = dbsJson.data?.databases?.find((d) => d.ownership?.credential?.id);
    expect(ownedDb, 'En az 1 adet sahiplikli veritabanı bulunmalı').toBeDefined();

    const websiteId = ownedDb.ownership.websiteId;
    const credentialId = ownedDb.ownership.credential.id;

    // 4. Tek kullanımlık SSO handoff token (capability) talep et
    const handoffRes = await page.request.post(
      `/api/panel/servers/${server.id}/websites/${websiteId}/phpmyadmin-handoffs`,
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        data: { credentialId },
      },
    );
    expect(handoffRes.status(), 'Handoff oluşturma 201 Created dönmeli').toBe(201);
    const handoffJson = await handoffRes.json();
    const handoffData = handoffJson.data;
    expect(handoffData.protocol).toBe('yunpanel-phpmyadmin-signon-v1');
    expect(handoffData.capability).toBeDefined();
    expect(handoffData.capability.length).toBe(43);
    expect(handoffData.expiresAt).toBeGreaterThan(Date.now());

    const capabilityToken = handoffData.capability;

    // 5. Fiziksel Sonuç 1: Tek kullanımlık token ile ilk oturum başlatma (HTTP 303 Redirect)
    const signon1 = await page.request.post('/tools/phpmyadmin/__yunpanel/signon', {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: { capability: capabilityToken },
      maxRedirects: 0,
    });
    expect([302, 303]).toContain(signon1.status());
    expect(signon1.headers().location).toContain('/tools/phpmyadmin');

    // 6. Fiziksel Sonuç 2: Replay koruması - aynı tek kullanımlık token tekrar kullanılamaz (HTTP 401)
    const signon2 = await page.request.post('/tools/phpmyadmin/__yunpanel/signon', {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: { capability: capabilityToken },
      maxRedirects: 0,
    });
    expect(signon2.status()).toBe(401);

    // 7. Fiziksel Sonuç 3: SSH üzerinden hostta gerçek denetim (audit) kaydının doğrulanması
    const auditDbCheck = runSsh(
      'sudo sqlite3 /var/lib/yunpanel/control-plane/auth/auth.sqlite "SELECT action, outcome FROM audit_events WHERE action = \'login.succeeded\' ORDER BY id DESC LIMIT 1;"',
    );
    expect(auditDbCheck).toContain('login.succeeded');
    expect(auditDbCheck).toContain('succeeded');
  });

  test('hatalı girdi ve sınır durumu: geçersiz token, sahte kimlik ve oturumsuz istekler reddedilir', async ({ page, request }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Sahte/Rastgele token ile SSO signon denemesi -> 401 Unauthorized
    const fakeToken = 'FakeCapabilityTokenWith43CharsForTesting123';
    const fakeSignon = await page.request.post('/tools/phpmyadmin/__yunpanel/signon', {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      form: { capability: fakeToken },
      maxRedirects: 0,
    });
    expect(fakeSignon.status()).toBe(401);

    // 2. Geçersiz gövde ile handoff API talebi -> 400 Bad Request
    const invalidBodyRes = await page.request.post(
      '/api/panel/servers/46efce06-9472-4f81-ba39-e249c2010610/websites/7fe9a711-a5b0-550e-a5e5-49fee4c66a73/phpmyadmin-handoffs',
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        data: { invalidField: 'unknown' },
      },
    );
    expect(invalidBodyRes.status()).toBe(400);

    // 3. Olmayan bir credentialId ile handoff talebi -> 400 veya 404
    const nonExistentCredRes = await page.request.post(
      '/api/panel/servers/46efce06-9472-4f81-ba39-e249c2010610/websites/7fe9a711-a5b0-550e-a5e5-49fee4c66a73/phpmyadmin-handoffs',
      {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        data: { credentialId: '00000000-0000-4000-8000-000000000000' },
      },
    );
    expect([400, 404, 409]).toContain(nonExistentCredRes.status());

    // 4. Panel oturumu olmadan korumalı denetim / audit API'ye erişim -> 401 Unauthorized
    const unauthAuditRes = await request.get('/api/panel/audit', {
      headers: {
        Origin: 'https://server.cryptoraichu.website',
      },
    });
    expect(unauthAuditRes.status()).toBe(401);
  });

  test('Plesk eksikliği: Plesk harici tek kullanımlık oturum / SSO token oluşturma API (/api/v2/cli/session veya /api/v2/sessions) bulunmuyor', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    test.fail(
      true,
      'BULGU API-04-A: Plesk harici tek kullanımlık oturum / SSO token API (/api/v2/cli/session veya /api/v2/sessions) bulunmuyor; oturum açma yalnızca parola ve dahili araç handoff ile sağlanmaktadır',
    );

    const res = await page.request.post('/api/v2/cli/session', {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      data: {
        login: OWNER_USERNAME,
      },
    });

    // Plesk'te 200/201 ile one-time token döner; YunPanel'de uç nokta olmadığından 404 döner ve test.fail ile işaretlenir
    expect(res.status()).toBe(200);
  });

  test('Plesk eksikliği: Plesk eşdeğeri yönetici/bayi müşteri paneline geçiş (login-as / context switch) mekanizması bulunmuyor', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    test.fail(
      true,
      'BULGU API-04-B: Plesk eşdeğeri admin/reseller login-as veya denetlenebilir bağlam değişimi (context switch / impersonation) mekanizması bulunmuyor; sonraki faz olarak ertelenmiştir',
    );

    const res = await page.request.post('/api/auth/impersonate', {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      data: {
        userId: 'target-customer-user-id',
      },
    });

    // Plesk'te müşteri oturumuna geçiş yapılırken YunPanel'de bu uç nokta henüz yoktur (404 döner)
    expect(res.status()).toBe(200);
  });
});
