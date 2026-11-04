import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('TLS-01 Ücretsiz ACME issue, renew ve otomatik yenileme', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `ttls01-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const testPrimaryDomain = `${prefix}.${parentSuffix}`;
  const testCustomerUsername = `${prefix}-cust`;
  const testCustomerPassword = `CustP@ss-${Date.now().toString(36)}`;

  let createdDomainId = null;
  let createdWebsiteId = null;
  let createdCustomerUserId = null;
  let csrfToken = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
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

  async function removeDomainFallback(page, domainId) {
    if (!domainId) return;
    try {
      const pRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(domainId)}/removal-preview`, {
        headers: apiHeaders(),
      });
      if (pRes.ok()) {
        const preview = (await pRes.json()).preview;
        if (preview?.previewDigest && preview?.confirmation) {
          await page.request.post(`/api/panel/domains/${encodeURIComponent(domainId)}/removal`, {
            headers: apiHeaders(),
            data: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
          });
        }
      }
    } catch (err) {
      console.warn('Domain removal fallback error:', err.message);
    }
  }

  async function removeWebsite(page, websiteId, domainName) {
    if (!websiteId) return;
    // 1. Doğrudan Website Removal API ile güvenli kaldırma
    try {
      const prevRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(websiteId)}/removal-preview`, {
        headers: apiHeaders(),
      });
      if (prevRes.ok()) {
        const prevJson = await prevRes.json();
        const preview = prevJson.preview || prevJson.data;
        if (preview?.readyToStart && preview?.previewDigest && preview?.confirmation) {
          const remRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(websiteId)}/removal`, {
            headers: apiHeaders(),
            data: { previewDigest: preview.previewDigest, confirmation: preview.confirmation },
          });
          if (remRes.status() === 201) {
            const remJson = await remRes.json();
            const op = remJson.operation || remJson.data;
            if (op?.actions?.runConfirmation) {
              await page.request.post(`/api/panel/website-removal-operations/${encodeURIComponent(op.id)}/run`, {
                headers: apiHeaders(),
                data: { expectedUpdatedAt: op.updatedAt, confirmation: op.actions.runConfirmation },
              }).catch(() => {});
            }
            for (let i = 0; i < 25; i++) {
              await new Promise((r) => setTimeout(r, 1000));
              const pollRes = await page.request.get(`/api/panel/website-removal-operations/${encodeURIComponent(op.id)}`, {
                headers: apiHeaders(),
              });
              if (pollRes.ok()) {
                const pollJson = await pollRes.json();
                const status = pollJson.data?.status || pollJson.status;
                if (status === 'removed' || status === 'failed') break;
              }
            }
            return;
          }
        }
      }
    } catch (err) {
      console.warn('Website removal API notice:', err.message);
    }

    // 2. UI Fallback: /websites/${websiteId}/settings rotası üzerinden silme
    try {
      await page.goto(`/websites/${encodeURIComponent(websiteId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
          await deleteBtn.click();

          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal, dialog[open]').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            if (domainName) await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
              await submitBtn.click();

              const doneBtn = page.locator('button:has-text("Web sitelerine dön")');
              if (await doneBtn.isVisible({ timeout: 45000 }).catch(() => false)) {
                await doneBtn.click();
                await page.waitForURL(/\/websites/, { timeout: 10000 }).catch(() => {});
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Website removal UI notice:', err.message);
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

        // 1. Önce web sitesini (websiteId ile) sil
        if (createdWebsiteId) {
          await removeWebsite(page, createdWebsiteId, testPrimaryDomain);
        }

        // 2. Ardından bağlı alan adını (domainId ile) sil
        if (createdDomainId) {
          await removeDomainFallback(page, createdDomainId);
        }

        // 3. Oluşturulan müşteriyi temizle
        if (createdCustomerUserId) {
          await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(createdCustomerUserId)}/login`, {
            headers: apiHeaders(),
            data: { revision: 1 },
          }).catch(() => {});
        }

        // 4. Olası artık ttls01- web sitelerini temizle
        const wsRes = await page.request.get('/api/panel/websites').catch(() => null);
        if (wsRes && wsRes.ok()) {
          const wsJson = await wsRes.json();
          const wsList = Array.isArray(wsJson.data) ? wsJson.data : (wsJson.data?.websites || wsJson.websites || []);
          for (const w of wsList) {
            if (w.name && w.name.startsWith('ttls01-')) {
              await removeWebsite(page, w.id, w.name);
            }
          }
        }

        // 5. Olası artık ttls01- alan adlarını temizle
        const domainsRes = await page.request.get('/api/panel/domains').catch(() => null);
        if (domainsRes && domainsRes.ok()) {
          const domainsJson = await domainsRes.json();
          const list = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
          for (const d of list) {
            if (d.primaryDomain && d.primaryDomain.startsWith('ttls01-')) {
              await removeDomainFallback(page, d.id);
            }
          }
        }

        // 6. Olası artık ttls01- müşteri hesaplarını temizle
        const custRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=100').catch(() => null);
        if (custRes && custRes.ok()) {
          const custJson = await custRes.json();
          const list = Array.isArray(custJson.data?.accounts) ? custJson.data.accounts : (custJson.accounts || []);
          for (const acc of list) {
            if (acc.username && acc.username.startsWith('ttls01-')) {
              await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(acc.id)}/login`, {
                headers: apiHeaders(),
                data: { revision: acc.revision ?? 1 },
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

    // 7. Fiziksel süpürme ve 0 artık garantisi (.28 temizlik garantisi)
    try {
      runSsh('rm -f /var/lib/yunpanel/staging/nginx/*ttls01* /var/lib/yunpanel/staging/nginx/rollback/*ttls01* /var/lib/yunpanel/staging/nginx/deactivation/*ttls01* 2>/dev/null || true');
    } catch {}
  });

  test('mutlu yol: Web sitesi oluşturma, ACME SSL formu, staging doğrulaması, dry-run yenileme ve fiziksel TLS kanıtları', async ({ page }) => {
    // 1. Yeni web sitesi ekle
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

    // API üzerinden oluşturulan web sitesi ve alan adı kimliklerini al
    const createdDomainsRes = await page.request.get('/api/panel/domains');
    if (createdDomainsRes.ok()) {
      const domJson = await createdDomainsRes.json();
      const domList = Array.isArray(domJson.data) ? domJson.data : (domJson.data?.domains || domJson.domains || []);
      const matchedDom = domList.find((d) => d.primaryDomain === testPrimaryDomain || d.id === createdDomainId);
      if (matchedDom) {
        createdDomainId = matchedDom.id;
        createdWebsiteId = matchedDom.websiteId;
      }
    }

    // 2. Yeni sitenin SSL sekmesine git ve başlangıç durumunu doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    const unissuedBadge = sslSection.locator('text=Sertifika bekliyor').or(sslSection.locator('text=Sertifika yok'));
    await expect(unissuedBadge).toBeVisible();

    const emailInput = sslSection.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    await emailInput.fill('admin@webrich.news');

    // Alt alan adı kutularını kaldır (DNS kaydı yalnızca kök domain için var)
    const wwwCheck = sslSection.locator('label:has-text("ve alan adını koru") input[type="checkbox"]');
    const webmailCheck = sslSection.locator('label:has-text("webmail arayüzünü koru") input[type="checkbox"]');
    const sslMailCheck = sslSection.locator('label:has-text("posta sunucusunu koru") input[type="checkbox"]');
    if (await wwwCheck.isChecked().catch(() => false)) await wwwCheck.uncheck();
    if (await webmailCheck.isChecked().catch(() => false)) await webmailCheck.uncheck();
    if (await sslMailCheck.isChecked().catch(() => false)) await sslMailCheck.uncheck();

    // 3. Staging doğrulaması: ACME doğrulamasını test et
    const stagingBtn = sslSection.locator('button:has-text("ACME doğrulamasını test et")');
    await expect(stagingBtn).toBeEnabled();

    // Staging test isteğini başlat
    const stagingPromise = page.waitForResponse(
      (res) => res.url().includes('/certificates/issue') && res.request().method() === 'POST',
      { timeout: 60000 },
    );
    await stagingBtn.click();
    const stagingResponse = await stagingPromise;
    expect([200, 201, 202]).toContain(stagingResponse.status());

    // 4. Var olan aktif alan adı (webrich.news) üzerinden aktif sertifika inceleme ve ACME dry-run testi
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    expect(webrichDomain).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(webrichDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const webrichSslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(webrichSslSection).toBeVisible({ timeout: 15000 });

    // Aktif sertifika bilgilerini doğrula
    await expect(webrichSslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible();
    await expect(webrichSslSection.locator('dt', { hasText: 'Kapsam' })).toBeVisible();
    await expect(webrichSslSection.locator('dt', { hasText: 'Başlangıç' })).toBeVisible();
    await expect(webrichSslSection.locator('dt', { hasText: 'Bitiş' })).toBeVisible();
    await expect(webrichSslSection.locator('dt', { hasText: 'HTTPS tercihi' })).toBeVisible();

    // SslRenewalPanel: Yenilemeyi test et (dry-run)
    const dryRunBtn = webrichSslSection.locator('button:has-text("Yenilemeyi test et")');
    await expect(dryRunBtn).toBeVisible({ timeout: 10000 });
    await expect(dryRunBtn).toBeEnabled({ timeout: 30000 });
    await dryRunBtn.click();

    // Onay modalı
    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'SSL yenilemesini test et' });
    await expect(modal).toBeVisible({ timeout: 5000 });
    const modalMsg = await modal.textContent();
    expect(modalMsg).toContain('yenileme testi');

    const startTestBtn = modal.locator('button:has-text("Testi başlat")');
    await expect(startTestBtn).toBeVisible();
    await startTestBtn.click();

    // Dry-run yenileme işinin tetiklendiğini ve arayüz durum bildirimini doğrula
    const renewalStatus = webrichSslSection.locator('[role="status"], .ws-error, [role="alert"]').filter({
      hasText: /Yenileme işi sunucuda devam ediyor|Yenileme testi tamamlandı|Yenileme testi başarılı|İşlem tamamlandı|Yenileme işi başarısız oldu/i,
    });
    await expect(renewalStatus).toBeVisible({ timeout: 20000 });

    const jobDetailBtn = webrichSslSection.locator('button:has-text("İşlem ayrıntısı")');
    await expect(jobDetailBtn).toBeVisible({ timeout: 10000 });

    // 5. Fiziksel Kanıtlar
    // Fiziksel Kanıt 1: SSH üzerinden OpenSSL x509 sertifika doğrulaması
    const opensslOut = runSsh('openssl x509 -in /etc/letsencrypt/live/webrich.news/fullchain.pem -noout -issuer -subject');
    expect(opensslOut).toContain('Let\'s Encrypt');
    expect(opensslOut).toContain('webrich.news');

    // Fiziksel Kanıt 2: Nginx :443 canlı TLS el sıkışması
    const tlsOut = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news </dev/null 2>/dev/null | openssl x509 -noout -issuer -subject');
    expect(tlsOut).toContain('Let\'s Encrypt');
    expect(tlsOut).toContain('webrich.news');

    // Fiziksel Kanıt 3: certbot.timer systemd zamanlayıcısının aktifliği
    const timerStatus = runSsh('systemctl is-active certbot.timer').trim();
    expect(timerStatus).toBe('active');

    // Fiziksel Kanıt 4: Canlı HTTPS isteğinde geçerli TLS ve HTTP 200/301
    const curlOut = runSsh('curl -sI https://webrich.news/ | head -n 1');
    expect(curlOut).toMatch(/HTTP\/[12](\.[01])?\s+[23]\d\d/);
  });

  test('hatalı girdi ve sınır kontrolleri: ACME e-posta doğrulaması, wildcard DNS-01 engeli ve onay modalı iptali', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    const emailInput = sslSection.locator('input[type="email"]');
    const issueBtn = sslSection.locator('button[type="submit"]:has-text("SSL sertifikası al")');
    const stagingBtn = sslSection.locator('button:has-text("ACME doğrulamasını test et")');

    // 1. Boş e-posta: Butonlar disabled
    await emailInput.fill('');
    await expect(issueBtn).toBeDisabled();
    await expect(stagingBtn).toBeDisabled();

    // 2. Geçersiz e-posta formatları: Butonlar disabled
    for (const invalidEmail of ['gecersiz-eposta', 'user@', '@domain.com', 'user name@webrich.news']) {
      await emailInput.fill(invalidEmail);
      await expect(issueBtn).toBeDisabled();
      await expect(stagingBtn).toBeDisabled();
    }

    // 3. API seviyesinde geçersiz e-posta gönderimi: 400 invalid_acme_email
    const invalidEmailRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'not-an-email',
      },
    });
    expect(invalidEmailRes.status()).toBe(400);
    const invalidEmailJson = await invalidEmailRes.json();
    expect(invalidEmailJson.error?.code).toBe('invalid_acme_email');

    // 4. HTTP-01 altında Wildcard sertifika talep edildiğinde 409 wildcard_not_supported
    const wildcardRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(createdDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        domains: [testPrimaryDomain, `*.${testPrimaryDomain}`],
        challenge: { type: 'http-01' },
      },
    });
    expect(wildcardRes.status()).toBe(409);
    const wildcardJson = await wildcardRes.json();
    expect(wildcardJson.error?.code).toBe('wildcard_not_supported');

    // 5. Onay modalı: Yanlış alan adı girildiğinde buton kilitli, Vazgeç ile modal kapanır
    await emailInput.fill('admin@webrich.news');
    await expect(issueBtn).toBeEnabled();
    await issueBtn.click();

    const confirmModal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'SSL sertifikası al' });
    await expect(confirmModal).toBeVisible({ timeout: 5000 });

    const confirmInput = confirmModal.locator('input');
    await confirmInput.fill('yanlis-alan-adi.webrich.news');
    const startIssueBtn = confirmModal.locator('button:has-text("İşlemi başlat")');
    await expect(startIssueBtn).toBeDisabled();

    const cancelBtn = confirmModal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(confirmModal).not.toBeVisible({ timeout: 5000 });
  });

  test('güvenlik ve yetki sınırları: CSRF koruması, anonim erişim ve Customer kiracı izolasyonu (T800 doğrulandı)', async ({ page, browser }) => {
    test.setTimeout(300000);

    // 1. webrich.news domain ve certificate ID'lerini al
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const webrichDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    expect(webrichDomain?.certificateId).toBeTruthy();

    const webrichDomainId = webrichDomain.id;
    const webrichCertId = webrichDomain.certificateId;

    // 2. CSRF Koruması: CSRF başlığı olmadan sertifika yenileme isteği 403 csrf_invalid döner
    const noCsrfRes = await page.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/renew`, {
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://server.cryptoraichu.website',
      },
      data: { dryRun: true },
    });
    expect(noCsrfRes.status()).toBe(403);
    const noCsrfJson = await noCsrfRes.json();
    expect(noCsrfJson.error?.code).toBe('csrf_invalid');

    // 3. Anonim Erişim Koruması: Oturumsuz bağlamda sertifika listeleme 401 unauthorized döner, POST işlemleri 401 veya 403 ile reddedilir
    const anonContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
    });
    try {
      const anonListRes = await anonContext.request.get('/api/panel/certificates');
      expect(anonListRes.status()).toBe(401);

      const anonIssueRes = await anonContext.request.post(`/api/panel/domains/${encodeURIComponent(webrichDomainId)}/certificates/issue`, {
        headers: { 'Content-Type': 'application/json' },
        data: { email: 'admin@webrich.news' },
      });
      expect([401, 403]).toContain(anonIssueRes.status());

      const anonRenewRes = await anonContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/renew`, {
        headers: { 'Content-Type': 'application/json' },
        data: { dryRun: true },
      });
      expect([401, 403]).toContain(anonRenewRes.status());
    } finally {
      await anonContext.close().catch(() => {});
    }

    // 4. Rol Senaryosu (Kiracı İzolasyonu): Geçici bir Customer kullanıcısı oluştur
    const createUserRes = await page.request.post('/api/panel/users/hosting/accounts/create-login', {
      headers: apiHeaders(),
      data: {
        kind: 'customer',
        username: testCustomerUsername,
        password: testCustomerPassword,
        resellerId: null,
      },
    });
    expect([200, 201]).toContain(createUserRes.status());
    const userJson = await createUserRes.json();
    createdCustomerUserId = userJson.data?.account?.id || userJson.account?.id;
    expect(createdCustomerUserId).toBeTruthy();

    // 5. Customer oturumu aç
    const customerContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
    });
    try {
      let custLoginRes;
      for (let attempt = 0; attempt < 8; attempt++) {
        custLoginRes = await customerContext.request.post('/api/auth/login', {
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://server.cryptoraichu.website',
            Referer: 'https://server.cryptoraichu.website/',
          },
          data: { username: testCustomerUsername, password: testCustomerPassword },
        });
        if (custLoginRes.status() === 200) {
          break;
        }
        if (custLoginRes.status() === 429) {
          const body = await custLoginRes.json().catch(() => ({}));
          const waitSec = Number(body.retryAfter || custLoginRes.headers()['retry-after'] || 5);
          await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
        } else {
          break;
        }
      }
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

      // Customer Owner'ın sertifikasını listeleyemez
      const custCertListRes = await customerContext.request.get('/api/panel/certificates');
      expect(custCertListRes.status()).toBe(200);
      const custCerts = (await custCertListRes.json()).data || [];
      expect(custCerts.find((c) => c.id === webrichCertId)).toBeUndefined();

      // Customer Owner alan adına sertifika talebi gönderemez (403 site_scope_forbidden / 404)
      const custIssueRes = await customerContext.request.post(`/api/panel/domains/${encodeURIComponent(webrichDomainId)}/certificates/issue`, {
        headers: custHeaders,
        data: { email: 'cust@webrich.news' },
      });
      expect([403, 404]).toContain(custIssueRes.status());

      // Customer Owner'ın sertifikasını yenileyemez (T800 kiracı izolasyonu kontrolü: 403 / 404)
      const custRenewRes = await customerContext.request.post(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/renew`, {
        headers: custHeaders,
        data: { dryRun: true },
      });
      expect([403, 404]).toContain(custRenewRes.status());

      // Customer Owner'ın sertifika renewal sonucuna erişemez (403 / 404)
      const custOutcomeRes = await customerContext.request.get(`/api/panel/certificates/${encodeURIComponent(webrichCertId)}/renewal-outcome`);
      expect([403, 404]).toContain(custOutcomeRes.status());
    } finally {
      await customerContext.close().catch(() => {});
    }
  });

  test('Plesk SSL It! eşdeğerlik eksikliği: Aktif sertifikalı alan adında sertifika kapsamını genişletme (Reissue / Multi-SAN) UI eksik', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-01: Plesk SSL It! / Let\'s Encrypt uzantısı eşdeğeri olarak aktif sertifikası olan bir alan adında arayüz üzerinden SAN kapsamını genişleterek yeniden sertifika isteme (Reissue) seçeneği bulunmuyor.',
    );

    // webrich.news alan adının SSL sayfasına git
    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];

    await page.goto(`/websites/${encodeURIComponent(mainDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Plesk'teki gibi "Kapsamı genişlet" veya "Sertifikayı yeniden çıkar" butonu beklenir, ancak YunPanel'de aktif sertifika varken form gizlenir.
    const reissueSanBtn = page.locator('button:has-text("Kapsamı genişlet"), button:has-text("Sertifikayı yeniden çıkar"), button:has-text("Reissue")');
    await expect(reissueSanBtn).toBeVisible({ timeout: 5000 });
  });
});
