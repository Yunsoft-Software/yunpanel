import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('TLS-04 Panel, website ve mail servisine doğru sertifika atama', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  let csrfToken = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

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

  test.afterAll(async () => {
    // Test sırasında kalıcı kaynak üretilmedi; var olan yapılandırma korundu
  });

  test('mutlu yol: Website ve Mail servisine doğru sertifika atama ve fiziksel doğrulama', async ({ page }) => {
    // 1. webrich.news domainini tespit et
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();
    const domainId = mainDomain.id;

    // 2. Web sitesi SSL arayüzünden sertifika atama durumunu doğrula
    await page.goto(`/websites/${encodeURIComponent(domainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    const sslSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });

    // Sertifika adı ve kapsam doğrulaması
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible({ timeout: 10000 });
    await expect(sslSection.locator('dt', { hasText: 'Kapsam' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Başlangıç' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'Bitiş' })).toBeVisible();
    await expect(sslSection.locator('dt', { hasText: 'HTTPS tercihi' })).toBeVisible();

    // 3. Mail servisi sertifika atama durumunu arayüz ve API üzerinden doğrula
    // API kontrolü: /api/panel/mail-service-identity
    const mailIdentityRes = await page.request.get('/api/panel/mail-service-identity');
    expect(mailIdentityRes.status()).toBe(200);
    const mailIdentityJson = await mailIdentityRes.json();
    expect(mailIdentityJson.data).toBeTruthy();
    expect(mailIdentityJson.data.hostname).toBe('mail.webrich.news');
    expect(mailIdentityJson.data.ready).toBe(true);
    expect(mailIdentityJson.data.blockers).toEqual([]);
    expect(mailIdentityJson.data.certificateId).toBeTruthy();

    // Webmail arayüzü kontrolü: /websites/:id/mail
    await page.goto(`/websites/${encodeURIComponent(domainId)}/mail`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Webmail sekmesine geç
    const webmailTab = page.locator('button:has-text("Webmail"), a:has-text("Webmail"), [role="tab"]:has-text("Webmail")').first();
    if (await webmailTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await webmailTab.click();
    }
    const webmailSection = page.locator('section').filter({ has: page.locator('h2', { hasText: /Webmail/i }) }).first();
    if (await webmailSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(webmailSection.locator('dt', { hasText: 'Hostname' })).toBeVisible();
      await expect(webmailSection.locator('dt', { hasText: 'Sertifika ID' })).toBeVisible();
    }

    // 4. Fiziksel host sonuç kanıtları (Nginx, Postfix, Dovecot ve Canlı TLS port el sıkışması)
    // Fiziksel Kanıt 1: Nginx web sitesi sertifika ataması
    const nginxOut = runSsh(`cat /etc/nginx/sites-enabled/yunpanel-webrich.news.conf | grep -E 'ssl_certificate'`);
    expect(nginxOut).toContain('/etc/letsencrypt/live/webrich.news/fullchain.pem');
    expect(nginxOut).toContain('/etc/letsencrypt/live/webrich.news/privkey.pem');

    // Fiziksel Kanıt 2: Postfix mail servisi TLS sertifika ataması
    const postfixOut = runSsh(`postconf -n smtpd_tls_cert_file smtpd_tls_key_file`);
    expect(postfixOut).toContain('/etc/letsencrypt/live/mail.webrich.news/fullchain.pem');
    expect(postfixOut).toContain('/etc/letsencrypt/live/mail.webrich.news/privkey.pem');

    // Fiziksel Kanıt 3: Dovecot mail servisi TLS sertifika ataması
    const dovecotOut = runSsh(`grep -E 'ssl_cert|ssl_key' /etc/dovecot/conf.d/99-yunpanel-mail.conf`);
    expect(dovecotOut).toContain('/etc/letsencrypt/live/mail.webrich.news/fullchain.pem');
    expect(dovecotOut).toContain('/etc/letsencrypt/live/mail.webrich.news/privkey.pem');

    // Fiziksel Kanıt 4: Canlı Dovecot IMAPS (port 993) TLS sertifika sunumu
    const tlsHandshake = runSsh(`openssl s_client -connect 127.0.0.1:993 </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer`);
    expect(tlsHandshake).toContain('mail.webrich.news');
    expect(tlsHandshake).toContain("Let's Encrypt");
  });

  test('hatalı girdi: Geçersiz parametreler, var olmayan domain veya revizyon çakışması reddedilir', async ({ page }) => {
    // Mevcut mail service identity durumunu ve güncel revizyonunu al
    const currentIdentityRes = await page.request.get('/api/panel/mail-service-identity');
    expect(currentIdentityRes.status()).toBe(200);
    const currentIdentity = (await currentIdentityRes.json()).data;
    const currentRev = currentIdentity?.revision ?? 0;

    // 1. Mail servisine var olmayan WebDomain atama denemesi (doğru revizyonla ama geçersiz domain: 404 domain_not_found)
    const notFoundRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: apiHeaders(),
      data: {
        webDomainId: '00000000-0000-4000-8000-000000000000',
        expectedRevision: currentRev,
      },
    });
    expect(notFoundRes.status()).toBe(404);
    const notFoundJson = await notFoundRes.json();
    expect(notFoundJson.error?.code).toBe('domain_not_found');

    // 2. Eksik veya geçersiz gövde ile mail servisi atama denemesi (400 mail_service_identity_bind_input_invalid)
    const badInputRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: apiHeaders(),
      data: {
        unexpectedField: 'invalid',
      },
    });
    expect(badInputRes.status()).toBe(400);
    const badInputJson = await badInputRes.json();
    expect(badInputJson.error?.code).toBe('mail_service_identity_bind_input_invalid');

    // 3. Çakışan beklenen revizyon ile mail servisi atama denemesi (409 mail_service_identity_revision_conflict)
    const conflictRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: apiHeaders(),
      data: {
        webDomainId: currentIdentity?.webDomainId || '00000000-0000-4000-8000-000000000000',
        expectedRevision: currentRev + 999999,
      },
    });
    expect(conflictRes.status()).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson.error?.code).toBe('mail_service_identity_revision_conflict');

    // 4. Web sitesine var olmayan veya uyumsuz sertifika atama önizlemesi (404/409)
    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = domainsJson.data?.domains || domainsJson.data || [];
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    expect(mainDomain).toBeTruthy();

    const fakeCertRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(mainDomain.id)}/certificates/00000000-0000-4000-8000-000000000000/select-preview`, {
      headers: apiHeaders(),
      data: {},
    });
    expect([404, 409]).toContain(fakeCertRes.status());
  });

  test('panel sertifikası ve web sitesi sertifika seçici: Plesk eşdeğerlik eksiklikleri', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-04: Panelin kendisini koruyan SSL sertifikasını atama veya değiştirme özelliği (Plesk Tools & Settings -> Certificate for securing Plesk eşdeğeri) ve web sitesi detayında mevcut sertifikalar arasında seçim yapma arayüzü eksik.',
    );

    // Plesk Tools & Settings -> SSL/TLS Certificates altında "Certificate for securing Plesk" ve
    // web sitesi ayarlarında mevcut sertifikalar arasından seçim yapılabilmektedir.
    // YunPanel sistem ayarlarında (/settings?section=dns) panel SSL ataması bulunmalıdır:
    await page.goto('/settings?section=dns');
    await page.waitForLoadState('networkidle').catch(() => {});

    // Bu kontrol beklenen özelliğin arayüzde olmadığını doğrular ve test.fail ile işaretlenmiştir
    const panelSslAssign = page.locator('text=Panel SSL sertifikası, text=Certificate for securing panel, select[aria-label*="Panel sertifikası"]');
    await expect(panelSslAssign).toBeVisible({ timeout: 5000 });
  });
});
