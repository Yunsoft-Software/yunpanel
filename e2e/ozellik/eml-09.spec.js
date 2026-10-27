import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-09 SPF/DKIM/DMARC ve relay/kimlik doğrulama güvenliği', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  let targetDomainName = '';
  let mailDomainId = '';
  let localServerId = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  async function getApiHeaders(page) {
    const origin = 'https://server.cryptoraichu.website';
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      'x-csrf-token': csrf,
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
  });

  test.afterAll(async () => {
    // Test sırasında oluşturulan DKIM anahtarlarını temizle ve API durumunu tazele
    try {
      runSsh('rm -rf /var/lib/yunpanel/control-plane/mail-dkim/*; systemctl restart yunpanel-api');
    } catch {
      // Temizlik adımı
    }
  });

  test('mutlu yol: DKIM anahtar oluşturma/önizleme, DNS kayıtları ve Postfix relay politikası fiziksel doğrulaması', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini bul
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';

    const manageBtn = localDomainRow.locator('a:has-text("Yönet")');
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    mailDomainId = urlMatch ? urlMatch[1] : '';
    expect(mailDomainId).toBeTruthy();

    // 2. DNS ve DKIM sekmesine git
    const securityTab = page.locator('nav.ws-tabs a:has-text("DNS ve DKIM")');
    await expect(securityTab).toBeVisible({ timeout: 10000 });
    await securityTab.click();
    await page.waitForURL(/section=security/, { timeout: 10000 });

    // 3. DKIM paneli: Anahtar oluşturma ve metadata doğrulaması
    const dkimSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DKIM' }) });
    await expect(dkimSection).toBeVisible({ timeout: 15000 });

    const createDkimBtn = dkimSection.locator('button:has-text("DKIM oluştur")');
    const dkimSelectorDt = dkimSection.locator('dt:has-text("Selector")');
    await expect(createDkimBtn.or(dkimSelectorDt)).toBeVisible({ timeout: 15000 });

    if (await createDkimBtn.isVisible()) {
      await createDkimBtn.click();

      const dkimModal = page.locator('.ws-modal', { hasText: 'DKIM key oluştur' });
      await expect(dkimModal).toBeVisible({ timeout: 5000 });

      const selectorInput = dkimModal.locator('input[placeholder="mail"]');
      await selectorInput.fill('mail');

      const submitBtn = dkimModal.locator('button[type="submit"]:has-text("DKIM oluştur")');
      await expect(submitBtn).toBeEnabled({ timeout: 5000 });
      await submitBtn.click();

      await expect(dkimModal).not.toBeVisible({ timeout: 25000 });
    }

    // DKIM metadata doğrulaması (<dl className="ws-keyvalues">)
    await expect(dkimSection.locator('dt:has-text("Selector")')).toBeVisible({ timeout: 10000 });
    await expect(dkimSection.locator('dt:has-text("Selector") + dd')).toContainText('mail');
    await expect(dkimSection.locator('dt:has-text("Algoritma") + dd')).toContainText('rsa-sha256');
    await expect(dkimSection.locator('dt:has-text("DNS tipi") + dd')).toContainText('TXT');
    await expect(dkimSection.locator('dt:has-text("DNS adı") + dd')).toContainText(`mail._domainkey.${targetDomainName}`);
    await expect(dkimSection.locator('dt:has-text("DNS değer") + dd')).toContainText('v=DKIM1');

    // DKIM Signing Preview kontrolü
    const previewBtn = dkimSection.locator('button:has-text("Signing preview")');
    await expect(previewBtn).toBeVisible({ timeout: 10000 });
    await previewBtn.click();

    await expect(dkimSection.locator('dt:has-text("Preview digest")')).toBeVisible({ timeout: 15000 });
    await expect(dkimSection.locator('dt:has-text("Signing domain") + dd')).toBeVisible({ timeout: 10000 });

    // 4. Mail diagnostics paneli
    const diagSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail diagnostics' }) });
    await expect(diagSection).toBeVisible({ timeout: 10000 });

    // 5. Fiziksel Sonuç Kanıtları
    // a) PowerDNS üzerinde SPF TXT kaydı
    const spfDig = runSsh(`dig @127.0.0.1 TXT ${targetDomainName} +short`);
    expect(spfDig).toContain('v=spf1 mx -all');

    // b) PowerDNS üzerinde DMARC TXT kaydı
    const dmarcDig = runSsh(`dig @127.0.0.1 TXT _dmarc.${targetDomainName} +short`);
    expect(dmarcDig).toContain('v=DMARC1; p=none');

    // c) PowerDNS üzerinde MX kaydı
    const mxDig = runSsh(`dig @127.0.0.1 MX ${targetDomainName} +short`);
    expect(mxDig).toContain('mail.webrich.news');

    // d) Postfix smtpd_relay_restrictions doğrulaması (Open relay engelleme)
    const postfixRelay = runSsh('postconf smtpd_relay_restrictions');
    expect(postfixRelay).toContain('permit_mynetworks, reject_unauth_destination');

    // e) Postfix port 25 direkt anonim kimlik doğrulama kapalılığı
    const postfixSasl = runSsh('postconf smtpd_sasl_auth_enable');
    expect(postfixSasl).toContain('smtpd_sasl_auth_enable = no');

    // f) Postfix submission (587) ve submissions (465) kimlik doğrulama zorunluluğu
    const masterCf = runSsh('grep -A 5 -E "^(submission|submissions)" /etc/postfix/master.cf');
    expect(masterCf).toContain('smtpd_relay_restrictions=permit_sasl_authenticated,reject');
    expect(masterCf).toContain('smtpd_sasl_auth_enable=yes');

    // g) Fiziksel DKIM anahtarı ve izinlerinin doğrulanması
    const dkimFileCheck = runSsh(`ls -la /var/lib/yunpanel/control-plane/mail-dkim/${mailDomainId}/`);
    expect(dkimFileCheck).toContain('metadata.json');
    expect(dkimFileCheck).toContain('private.pem');
    expect(dkimFileCheck).toContain('-rw-------'); // 0600 izni
  });

  test('Plesk Parity: DNS Teslimat Gereksinimleri (SPF, DKIM, DMARC) ve İstemci Bağlantı Bilgileri panelleri', async ({ page }) => {
    test.fail(true, 'BULGU EML-09: delivery-diagnostics uç noktası 400 invalid_log_query döndüğü için DNS Teslimat Gereksinimleri ve İstemci Bağlantı Bilgileri paneli render olmuyor');

    if (!mailDomainId) {
      const mailDomainsRes = await page.request.get('/api/panel/mail-domains');
      expect(mailDomainsRes.status()).toBe(200);
      const mailDomainsJson = await mailDomainsRes.json();
      const mailDomainList = mailDomainsJson.data?.mailDomains || mailDomainsJson.data || [];
      const localMd = mailDomainList.find((m) => m.managementMode === 'local') || mailDomainList[0];
      expect(localMd).toBeTruthy();
      mailDomainId = localMd.id;
    }

    await page.goto(`/mail/${mailDomainId}?section=security`);

    // DNS Teslimat Gereksinimleri panelinin görünür olması beklenir
    const dnsReqSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'DNS Teslimat Gereksinimleri' }) });
    await expect(dnsReqSection).toBeVisible({ timeout: 10000 });

    const spfRow = dnsReqSection.locator('div', { has: page.locator('dt:has-text("SPF Kaydı")') });
    await expect(spfRow.locator('span.ws-badge:has-text("Geçerli")')).toBeVisible({ timeout: 10000 });

    const dmarcRow = dnsReqSection.locator('div', { has: page.locator('dt:has-text("DMARC Kaydı")') });
    await expect(dmarcRow.locator('span.ws-badge:has-text("Geçerli")')).toBeVisible({ timeout: 10000 });
  });

  test('hatalı girdi: Geçersiz DKIM selector adı, boş gövde veya olmayan domain ID reddedilir', async ({ page }) => {
    const headers = await getApiHeaders(page);

    // 1. Mail domain ID tespit et
    if (!mailDomainId) {
      const mailDomainsRes = await page.request.get('/api/panel/mail-domains');
      expect(mailDomainsRes.status()).toBe(200);
      const mailDomainsJson = await mailDomainsRes.json();
      const mailDomainList = mailDomainsJson.data?.mailDomains || mailDomainsJson.data || [];
      const localMd = mailDomainList.find((m) => m.managementMode === 'local') || mailDomainList[0];
      expect(localMd).toBeTruthy();
      mailDomainId = localMd.id;
    }

    // 2. Geçersiz DKIM selector adı (büyük harf ve özel karakterler) gönderildiğinde 400 reddi
    const invalidSelectorRes = await page.request.post(`/api/panel/mail-domains/${mailDomainId}/dkim`, {
      headers,
      data: {
        expectedRevision: 0,
        selector: 'INVALID_SELECTOR_$$!',
      },
    });
    expect([400, 409]).toContain(invalidSelectorRes.status());
    const invalidSelectorJson = await invalidSelectorRes.json();
    expect(invalidSelectorJson.error).toBeTruthy();
    expect(['invalid_mail_dkim_selector', 'mail_dkim_create_input_invalid', 'mail_dkim_key_exists']).toContain(invalidSelectorJson.error.code);

    // 3. Eksik gövde ile DKIM isteği 400 ile reddedilir
    const emptyBodyRes = await page.request.post(`/api/panel/mail-domains/${mailDomainId}/dkim`, {
      headers,
      data: {},
    });
    expect([400, 409]).toContain(emptyBodyRes.status());

    // 4. Olmayan mail domain ID için 404 reddi
    const nonExistentRes = await page.request.post('/api/panel/mail-domains/00000000-0000-0000-0000-000000000000/dkim', {
      headers,
      data: { expectedRevision: 0, selector: 'mail' },
    });
    expect(nonExistentRes.status()).toBe(404);
  });

  test('Plesk Parity: Giden e-posta relay (Smarthost) yapılandırma ve API uç noktası', async ({ page }) => {
    test.fail(true, 'BULGU EML-09: Smarthost outbound relay API uç noktası canlı sunucuda henüz deploy edilmemiş (404 Not Found)');

    const headers = await getApiHeaders(page);

    // Sunucu kimliğini API üzerinden tespit et
    const serversRes = await page.request.get('/api/panel/servers');
    expect(serversRes.status()).toBe(200);
    const serversJson = await serversRes.json();
    const serverList = serversJson.data?.servers || serversJson.data || [];
    const localServer = serverList.find((s) => s.executionMode === 'local') || serverList[0];
    expect(localServer).toBeTruthy();
    localServerId = localServer.id;

    const smarthostRes = await page.request.get(`/api/panel/servers/${localServerId}/mail/smarthost`, { headers });
    expect(smarthostRes.status()).toBe(200);

    const invalidHostRes = await page.request.put(`/api/panel/servers/${localServerId}/mail/smarthost`, {
      headers,
      data: {
        host: 'invalid host with spaces and special chars!',
        port: 587,
        username: 'testuser',
        password: 'testpassword123',
        confirmation: 'smarthost-apply',
      },
    });
    expect(invalidHostRes.status()).toBe(400);
    const invalidHostJson = await invalidHostRes.json();
    expect(invalidHostJson.error?.code).toBe('invalid_smarthost');
  });
});
