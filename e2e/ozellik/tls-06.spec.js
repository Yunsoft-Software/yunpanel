import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import tls from 'node:tls';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('TLS-06 Geçerlilik, gerçek sunulan sertifika, durum ve uyarılar', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `ttls06-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const testPrimaryDomain = `${prefix}.${parentSuffix}`;
  const testCustomerUsername = `${prefix}-cust`;
  const testCustomerPassword = `CustP@ss-${Date.now().toString(36)}`;

  let createdDomainId = null;
  let createdCustomerUserId = null;
  let csrfToken = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  function getLiveTlsPresentation(host, servername) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host,
        port: 443,
        servername,
        rejectUnauthorized: false,
      }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(cert);
      });
      socket.setTimeout(10000, () => {
        socket.destroy();
        reject(new Error('TLS connection timeout to host: ' + host));
      });
      socket.on('error', (err) => reject(err));
    });
  }

  function apiHeaders(origin = 'https://server.cryptoraichu.website') {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: origin,
      Referer: `${origin}/`,
    };
  }

  async function apiPost(request, url, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await request.post(url, options);
      } catch (err) {
        if (attempt === 2 || !['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'].some((code) => err.message?.includes(code))) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible().catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 40000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('TLS-06 cleanup notice:', err.message);
    }
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

  test.afterAll(async ({ browser }) => {
    // 0 artık ilkesi: Test sırasında açılan geçici web sitesi ve müşteri hesabını temizle
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

        // 1. Oluşturulan web sitesini temizle
        if (createdDomainId) {
          await removeWebsiteById(page, createdDomainId, testPrimaryDomain);
        }

        // 2. Oluşturulan müşteriyi temizle
        if (createdCustomerUserId) {
          const userRes = await page.request.get('/api/panel/users?limit=100').catch(() => null);
          if (userRes && userRes.ok()) {
            const usersJson = await userRes.json();
            const list = Array.isArray(usersJson.data?.users) ? usersJson.data.users : [];
            const targetUser = list.find((u) => u.id === createdCustomerUserId || u.username === testCustomerUsername);
            if (targetUser) {
              await page.request.delete(`/api/panel/users/${encodeURIComponent(targetUser.id)}`, {
                headers: apiHeaders(),
                data: { revision: targetUser.revision },
              }).catch(() => {});
            }
          }
        }

        // 3. Olası artık ttls06-a alan adlarını temizle
        const domainsRes = await page.request.get('/api/panel/domains').catch(() => null);
        if (domainsRes && domainsRes.ok()) {
          const domainsJson = await domainsRes.json();
          const list = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
          for (const d of list) {
            if (d.primaryDomain && d.primaryDomain.startsWith(`ttls06-a${agentN}`)) {
              await removeWebsiteById(page, d.id, d.primaryDomain);
            }
          }
        }

        // 4. Olası artık ttls06-a kullanıcılarını temizle
        const sweepUsersRes = await page.request.get('/api/panel/users?limit=100').catch(() => null);
        if (sweepUsersRes && sweepUsersRes.ok()) {
          const sweepJson = await sweepUsersRes.json();
          const list = Array.isArray(sweepJson.data?.users) ? sweepJson.data.users : [];
          for (const u of list) {
            if (u.username && u.username.startsWith(`ttls06-a${agentN}`)) {
              await page.request.delete(`/api/panel/users/${encodeURIComponent(u.id)}`, {
                headers: apiHeaders(),
                data: { revision: u.revision },
              }).catch(() => {});
            }
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      console.warn('afterAll general sweep error:', err.message);
    }
  });

  test('mutlu yol: Web siteleri kart rozetleri, SSL sekmesi detayları, Sistem Uyarıları ve Nginx :443 canlı TLS fiziksel doğrulaması', async ({ page }) => {
    // 1. /websites listesine arama parametresiyle git (webrich.news Z-A sıralamasında en başta gelir)
    await page.goto('/websites?q=webrich.news&sort=desc');
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });

    // Aktif web sitelerinden webrich.news kartını doğrula
    const webrichCard = page.locator('article.ws-website-task-card').filter({ has: page.locator('h3 a', { hasText: /^webrich\.news$/ }) }).first();
    await expect(webrichCard).toBeVisible({ timeout: 10000 });

    // Kalan gün rozeti görünür olmalı (örn: "88 gün" veya "\d+ gün")
    const badge = webrichCard.locator('.ws-badge').filter({ hasText: /gün/ });
    await expect(badge).toBeVisible();

    // 2. webrich.news domain ID'sini API'den al ve SSL sekmesine git
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    expect(webrichDomain?.certificateId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(webrichDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    // SSL sekmesindeki temel bilgileri doğrula
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Kapsam' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Başlangıç' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Bitiş' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'HTTPS tercihi' })).toBeVisible();

    // 3. Üst bardaki Bildirim ve Görev Merkezi (Sistem Uyarıları) kontrolü
    const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"]');
    await expect(bellBtn).toBeVisible({ timeout: 10000 });
    await bellBtn.click();

    const drawer = page.locator('aside[aria-label="Bildirim ve Görev Merkezi"]');
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const alertsTab = drawer.locator('button[role="tab"]', { hasText: 'Sistem Uyarıları' });
    await expect(alertsTab).toBeVisible();
    await alertsTab.click();
    await expect(alertsTab).toHaveAttribute('aria-selected', 'true');
    await expect(drawer.locator('section[aria-label="Sistem Uyarıları"]')).toBeVisible();

    const closeBtn = drawer.locator('button[aria-label="Bildirim merkezini kapat"]');
    await closeBtn.click();
    await expect(drawer).toBeHidden();

    // 4. Fiziksel Sonuç 1: Node tls.connect ile :443 portuna SNI TLS bağlantısı kur ve X.509 peer certificate al
    const peerCert = await getLiveTlsPresentation('server.cryptoraichu.website', 'webrich.news');
    expect(peerCert.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i);
    expect(peerCert.valid_from).toBeTruthy();
    expect(peerCert.valid_to).toBeTruthy();

    // 5. Fiziksel Sonuç 2: SSH ile .28 hostunda Nginx :443 canlı TLS el sıkışması
    const sshFingerprintRaw = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256').trim();
    const sshFingerprintMatch = sshFingerprintRaw.match(/Fingerprint=([0-9A-Fa-f:]+)/);
    expect(sshFingerprintMatch).toBeTruthy();
    const sshFingerprint = sshFingerprintMatch[1].toUpperCase();

    // Canlı TLS soket parmak izi ile SSH openssl s_client parmak izi birebir aynı olmalı
    expect(peerCert.fingerprint256.toUpperCase()).toBe(sshFingerprint);

    // 6. Fiziksel Sonuç 3: Panel API'deki aktif sertifika kaydıyla fiziksel sertifikanın eşleşmesi
    const certsRes = await page.request.get('/api/panel/certificates');
    expect(certsRes.status()).toBe(200);
    const certsJson = await certsRes.json();
    const certList = Array.isArray(certsJson.data) ? certsJson.data : (certsJson.data?.certificates || []);
    const webrichCert = certList.find((c) => c.id === webrichDomain.certificateId);
    expect(webrichCert).toBeTruthy();
    expect(webrichCert.fingerprint256.toUpperCase()).toBe(sshFingerprint);

    // 7. Fiziksel Sonuç 4: API verify-tls endpoint'i gerçek TLS verisiyle matches: true döner
    const verifyRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(webrichDomain.id)}/certificates/${encodeURIComponent(webrichCert.id)}/verify-tls`, {
      headers: apiHeaders(),
      data: {
        liveTls: {
          validFrom: webrichCert.validFrom,
          validTo: webrichCert.validTo,
          fingerprint256: webrichCert.fingerprint256,
        },
      },
    });
    expect(verifyRes.status()).toBe(200);
    const verifyJson = await verifyRes.json();
    expect(verifyJson.data?.matches).toBe(true);
    expect(verifyJson.data?.fingerprint256.toUpperCase()).toBe(sshFingerprint);
  });

  test('hatalı girdi ve sınır durumları: ACME e-posta doğrulaması, canlı TLS uyuşmazlığı tespiti ve kısmi servis reload teşhisi', async ({ page }) => {
    // 1. Yeni geçici web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label:has-text("Alan adı") input');
    await expect(domainInput).toBeVisible();
    await domainInput.fill(testPrimaryDomain);

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
    if (await mailCheck.isVisible().catch(() => false) && await mailCheck.isChecked().catch(() => false)) {
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

    // 2. Sitenin SSL sekmesine git ve henüz sertifikasız durumu gör
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    const unissuedBadge = sslSection.locator('text=Sertifika bekliyor').or(sslSection.locator('text=Sertifika yok'));
    await expect(unissuedBadge).toBeVisible();

    const emailInput = sslSection.locator('input[type="email"]');
    const issueBtn = sslSection.locator('button[type="submit"]:has-text("SSL sertifikası al")');
    const stagingBtn = sslSection.locator('button:has-text("ACME doğrulamasını test et")');

    // 3. UI Hatalı Girdi Kontrolleri: Geçersiz e-posta formatlarında butonlar devre dışı kalmalı
    for (const invalidEmail of ['gecersiz-eposta', 'user@', '@domain.com', 'user name@webrich.news']) {
      await emailInput.fill(invalidEmail);
      await expect(issueBtn).toBeDisabled();
      await expect(stagingBtn).toBeDisabled();
    }

    // 4. API Önkoşul Kontrolü: Aktif olmayan domainde ACME isteği 409 http_domain_not_active dönmeli
    const inactiveDomainRes = await apiPost(page.request, `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: { email: 'admin@webrich.news' },
    });
    expect(inactiveDomainRes.status()).toBe(409);
    const inactiveDomainJson = await inactiveDomainRes.json();
    expect(inactiveDomainJson.error?.code).toBe('http_domain_not_active');

    // 5. webrich.news bilgilerini al
    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    const webrichCertId = webrichDomain.certificateId;

    // 6. API Hatalı Girdi Kontrolü: Geçersiz alanlar içeren sertifika talebi 400 invalid_certificate_request dönmeli
    const invalidCertReqRes = await apiPost(page.request, `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: { invalid_field_name: 'test' },
    });
    expect(invalidCertReqRes.status()).toBe(400);
    const invalidCertReqJson = await invalidCertReqRes.json();
    expect(invalidCertReqJson.error?.code).toBe('invalid_certificate_request');

    // 7. API Sınır Kontrolü: HTTP-01 altında wildcard sertifika talep edildiğinde 409 wildcard_not_supported dönmeli
    const wildcardRes = await apiPost(page.request, `/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        domains: [testPrimaryDomain, `*.${testPrimaryDomain}`],
        challenge: { type: 'http-01' },
      },
    });
    expect(wildcardRes.status()).toBe(409);
    const wildcardJson = await wildcardRes.json();
    expect(wildcardJson.error?.code).toBe('wildcard_not_supported');

    // 8. API Canlı TLS Uyuşmazlığı Testi: webrich.news sertifikasında yanlış parmak izi ve tarih kontrolü

    const certsRes = await page.request.get('/api/panel/certificates');
    const certsJson = await certsRes.json();
    const certList = Array.isArray(certsJson.data) ? certsJson.data : (certsJson.data?.certificates || []);
    const webrichCert = certList.find((c) => c.id === webrichCertId);

    // Yanlış parmak izi ile verify-tls -> matches: false, reason: "fingerprint_mismatch"
    const mismatchFpRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(webrichDomain.id)}/certificates/${encodeURIComponent(webrichCertId)}/verify-tls`, {
      headers: apiHeaders(),
      data: {
        liveTls: {
          validFrom: webrichCert.validFrom,
          validTo: webrichCert.validTo,
          fingerprint256: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
        },
      },
    });
    expect(mismatchFpRes.status()).toBe(200);
    const mismatchFpJson = await mismatchFpRes.json();
    expect(mismatchFpJson.data?.matches).toBe(false);
    expect(mismatchFpJson.data?.reason).toBe('fingerprint_mismatch');

    // Yanlış bitiş tarihi ile verify-tls -> matches: false, reason: "valid_to_mismatch"
    const mismatchDateRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(webrichDomain.id)}/certificates/${encodeURIComponent(webrichCertId)}/verify-tls`, {
      headers: apiHeaders(),
      data: {
        liveTls: {
          validFrom: webrichCert.validFrom,
          validTo: '2029-01-01T00:00:00.000Z',
          fingerprint256: webrichCert.fingerprint256,
        },
      },
    });
    expect(mismatchDateRes.status()).toBe(200);
    const mismatchDateJson = await mismatchDateRes.json();
    expect(mismatchDateJson.data?.matches).toBe(false);
    expect(mismatchDateJson.data?.reason).toBe('valid_to_mismatch');

    // 6. Servis Reload Sonucu Testi: Kısmi reload sonucunda sertifikanın bozulmadan uyarılı kalması
    const partialReloadRes = await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
      headers: apiHeaders(),
      data: {
        service: 'nginx',
        status: 'partial',
        stage: 'reload',
        error: 'nginx reload warning on secondary listener',
      },
    });
    expect(partialReloadRes.status()).toBe(200);
    const partialJson = await partialReloadRes.json();
    expect(partialJson.data?.certificate?.state).toBe('active');
    expect(partialJson.data?.certificate?.lastReloadOutcome?.status).toBe('partial');

    // Temizlik: Başarılı reload göndererek sertifika üzerindeki kısmi teşhisi sıfırla
    const cleanReloadRes = await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
      headers: apiHeaders(),
      data: {
        service: 'nginx',
        status: 'succeeded',
      },
    });
    expect(cleanReloadRes.status()).toBe(200);
    const cleanJson = await cleanReloadRes.json();
    expect(cleanJson.data?.certificate?.lastReloadOutcome?.status).toBe('succeeded');
  });

  test('güvenlik ve yetki sınırları: CSRF koruması, anonim erişim ve Customer kiracı izolasyonu', async ({ page, browser }) => {
    // 1. webrich.news sertifika ID'sini al
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    const webrichCertId = webrichDomain.certificateId;

    // 2. CSRF Koruması: CSRF başlığı olmadan verify-tls isteği 403 csrf_invalid döner
    const noCsrfRes = await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/verify-tls`, {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://server.cryptoraichu.website',
      },
      data: {
        liveTls: { fingerprint256: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99' },
      },
    });
    expect(noCsrfRes.status()).toBe(403);
    const noCsrfJson = await noCsrfRes.json();
    expect(noCsrfJson.error?.code).toBe('csrf_invalid');

    // 3. Anonim Erişim Koruması: Oturumsuz bağlamda sertifika listesi 401, işlemler 401/403 ile reddedilir
    const anonContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const anonListRes = await anonContext.request.get('/api/panel/certificates');
      expect(anonListRes.status()).toBe(401);

      const anonVerifyRes = await anonContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/verify-tls`, {
        data: { liveTls: {} },
      });
      expect([401, 403]).toContain(anonVerifyRes.status());

      const anonReloadRes = await anonContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
        data: { service: 'nginx', status: 'succeeded' },
      });
      expect([401, 403]).toContain(anonReloadRes.status());
    } finally {
      await anonContext.close().catch(() => {});
    }

    // 4. Rol Senaryosu (Kiracı İzolasyonu): Sadece geçici siteye yetkili site_manager kullanıcısı oluştur
    const createUserRes = await page.request.post('/api/panel/users', {
      headers: apiHeaders(),
      data: {
        username: testCustomerUsername,
        password: testCustomerPassword,
        role: 'site_manager',
        websiteIds: createdDomainId ? [createdDomainId] : [],
        active: true,
      },
    });
    expect(createUserRes.status()).toBe(201);
    const userJson = await createUserRes.json();
    createdCustomerUserId = userJson.data?.user?.id;
    expect(createdCustomerUserId).toBeTruthy();

    // 5. Customer oturumu aç ve kiracı sınırlarını doğrula
    const customerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const custLoginRes = await customerContext.request.post('/api/auth/login', {
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://server.cryptoraichu.website',
          Referer: 'https://server.cryptoraichu.website/',
        },
        data: { username: testCustomerUsername, password: testCustomerPassword },
      });
      expect(custLoginRes.status()).toBe(200);

      const custSessionRes = await customerContext.request.get('/api/auth/session');
      expect(custSessionRes.status()).toBe(200);
      const custSessionJson = await custSessionRes.json();
      const custCsrf = custSessionJson.data?.csrfToken;

      const custHeaders = {
        'Content-Type': 'application/json',
        'x-csrf-token': custCsrf,
        Origin: 'https://server.cryptoraichu.website',
      };

      // Customer Owner'ın sertifikasını sertifika listesinde göremez
      const custCertListRes = await customerContext.request.get('/api/panel/certificates');
      expect(custCertListRes.status()).toBe(200);
      const custCerts = (await custCertListRes.json()).data || [];
      expect(custCerts.find((c) => c.id === webrichCertId)).toBeUndefined();

      // Customer Owner sertifikası üzerinde verify-tls çağıramaz (403 veya 404)
      const custVerifyRes = await customerContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/verify-tls`, {
        headers: custHeaders,
        data: { liveTls: {} },
      });
      expect([403, 404]).toContain(custVerifyRes.status());

      // Customer Owner sertifikası üzerinde reload-outcome çağıramaz (403 veya 404)
      const custReloadRes = await customerContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
        headers: custHeaders,
        data: { service: 'nginx', status: 'succeeded' },
      });
      expect([403, 404]).toContain(custReloadRes.status());
    } finally {
      await customerContext.close().catch(() => {});
    }
  });

  test('BULGU TLS-06: /websites/:id/ssl sekmesinde canlı sunulan sertifika doğrulaması ve kimlik detayları varsayılan görünümde eksik', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-06: /websites/:id/ssl sekmesinde gerçek sunulan sertifika doğrulaması (verify-tls) ve issuer/fingerprint detayları varsayılan görünümde sunulmuyor.',
    );

    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];

    await page.goto(`/websites/${encodeURIComponent(webrichDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    // Plesk TLS-06 eşdeğeri olarak sertifika sağlayıcısı (issuer), SHA-256 parmak izi ve sunulan canlı sertifika doğrulama rozeti beklenir
    const issuerDt = sslSection.locator('dt', { hasText: /Sağlayıcı|Issuer/i });
    const fingerprintDt = sslSection.locator('dt', { hasText: /Parmak izi|Fingerprint/i });
    const liveTlsBadge = sslSection.locator('text=Canlı sertifika eşleşti').or(sslSection.locator('text=Sunulan sertifika doğrulandı'));

    // Bu alanlar mevcut arayüzde bulunmadığı için test.fail ile işaretlenmiştir
    await expect(issuerDt).toBeVisible({ timeout: 3000 });
    await expect(fingerprintDt).toBeVisible({ timeout: 3000 });
    await expect(liveTlsBadge).toBeVisible({ timeout: 3000 });
  });

  test('BULGU TLS-06: NotificationCenterDrawer kısmi servis reload durumunda sistem uyarısı üretmiyor', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-06: NotificationCenterDrawer kısmi servis reload (certificate_reload_partial) durumunda uyarı üretmiyor.',
    );

    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    const webrichCertId = webrichDomain.certificateId;

    try {
      // 1. Kısmi reload outcome bildir
      await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
        headers: apiHeaders(),
        data: {
          service: 'nginx',
          status: 'partial',
          stage: 'reload',
          error: 'nginx worker reload partial failure',
        },
      });

      // 2. Sayfayı yenile ve Bildirim Çekmecesini aç
      await page.goto('/dashboard');
      const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"]');
      await expect(bellBtn).toBeVisible({ timeout: 10000 });
      await bellBtn.click();

      const drawer = page.locator('aside[aria-label="Bildirim ve Görev Merkezi"]');
      await expect(drawer).toBeVisible({ timeout: 10000 });
      const alertsTab = drawer.locator('button[role="tab"]', { hasText: 'Sistem Uyarıları' });
      await alertsTab.click();

      // Kısmi reload uyarısı drawer altında beklenir
      const partialAlert = drawer.locator('section[aria-label="Sistem Uyarıları"]').locator('text=Kısmi').or(drawer.locator('text=reload'));
      await expect(partialAlert).toBeVisible({ timeout: 3000 });
    } finally {
      // Teşhisi temizle
      await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/reload-outcome`, {
        headers: apiHeaders(),
        data: { service: 'nginx', status: 'succeeded' },
      }).catch(() => {});
    }
  });
});
