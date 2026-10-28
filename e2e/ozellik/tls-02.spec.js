import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('TLS-02 Wildcard/DNS-01, SAN ve www/mail/webmail kapsamı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `ttls02-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const testPrimaryDomain = `${prefix}.${parentSuffix}`;
  let createdDomainId = null;
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
      console.warn('TLS-02 cleanup notice:', err.message);
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
    // 0 artık ilkesi: Test sırasında açılan geçici web sitesini temizle
    if (createdDomainId) {
      try {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        try {
          await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
          await removeWebsiteById(page, createdDomainId, testPrimaryDomain);
        } finally {
          await page.close().catch(() => {});
        }
      } catch (err) {
        console.error('Clean-up failed for domain:', createdDomainId, err.message);
      }
    }

    // Olası artık ttls02 alan adlarını kontrol et ve temizle
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        const domainsRes = await page.request.get('/api/panel/domains');
        if (domainsRes.ok()) {
          const domainsJson = await domainsRes.json();
          const list = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
          for (const d of list) {
            if (d.primaryDomain && d.primaryDomain.startsWith('ttls02-a')) {
              await removeWebsiteById(page, d.id, d.primaryDomain);
            }
          }
        }
      } finally {
        await page.close().catch(() => {});
      }
    } catch {}
  });

  test('mutlu yol: Gerçek domain SAN kapsamı, SSL formundaki alt alan adı seçenekleri ve fiziksel sertifika içeriği', async ({ page }) => {
    // 1. webrich.news ana alan adını bul ve SSL sayfasına git
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
      || domainList.find((d) => d.primaryDomain === 'webrich.news')
      || domainList.find((d) => !d.parentDomainId)
      || domainList[0];
    expect(mainDomain).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(mainDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // SSL sertifikası kartını ve SAN kapsamını doğrula
    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible({ timeout: 10000 });

    const scopeDt = sslSection.locator('dt', { hasText: 'Kapsam' });
    await expect(scopeDt).toBeVisible();
    const scopeDd = sslSection.locator('dd').filter({ hasText: 'www.webrich.news' });
    await expect(scopeDd).toBeVisible();
    const scopeText = await scopeDd.textContent();
    expect(scopeText).toContain('webrich.news');
    expect(scopeText).toContain('www.webrich.news');

    // Fiziksel Kanıt 1: SSH üzerinden OpenSSL x509 SAN (Subject Alternative Name) çıktısı
    const opensslSan = runSsh('openssl x509 -in /etc/letsencrypt/live/webrich.news/fullchain.pem -noout -text | grep -A 2 "Subject Alternative Name"');
    expect(opensslSan).toContain('DNS:webrich.news');
    expect(opensslSan).toContain('DNS:www.webrich.news');

    // Fiziksel Kanıt 2: Nginx port 443 canlı TLS el sıkışmasında sunulan sertifikanın SAN listesi
    const tlsHandshake = runSsh('openssl s_client -connect 127.0.0.1:443 -servername webrich.news </dev/null 2>/dev/null | openssl x509 -noout -text | grep -A 2 "Subject Alternative Name"');
    expect(tlsHandshake).toContain('DNS:webrich.news');
    expect(tlsHandshake).toContain('DNS:www.webrich.news');

    // Fiziksel Kanıt 3: Mail servisi TLS sertifika ve kimlik kontrolü (Postfix/Dovecot SNI)
    const mailIdentityRes = await page.request.get('/api/panel/mail-service-identity');
    expect(mailIdentityRes.status()).toBe(200);
    const mailIdentity = (await mailIdentityRes.json()).data;
    expect(mailIdentity.hostname).toBe('mail.webrich.news');
    expect(mailIdentity.ready).toBe(true);

    const dovecotTls = runSsh('openssl s_client -connect 127.0.0.1:993 </dev/null 2>/dev/null | openssl x509 -noout -subject');
    expect(dovecotTls).toContain('CN = mail.webrich.news');

    // 2. Yeni test web sitesi oluşturarak henüz sertifikası olmayan sitede SSL formunu ve SAN/Wildcard seçeneklerini doğrula
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

    // Yeni sitenin SSL sekmesine git ve sertifika talep formunu doğrula
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // SSL Form öğeleri ve Korunacak alan adları bölümü
    const protectedDomainsHeader = page.locator('strong:has-text("Korunacak alan adları:")');
    await expect(protectedDomainsHeader).toBeVisible({ timeout: 15000 });

    // Ana alan adı: işaretli ve disabled
    const primaryDomainCheckbox = page.locator('label:has-text("Ana alan adı — zorunlu") input[type="checkbox"]');
    await expect(primaryDomainCheckbox).toBeVisible();
    await expect(primaryDomainCheckbox).toBeDisabled();
    await expect(primaryDomainCheckbox).toBeChecked();

    // Alt alan adı seçenekleri (www, webmail, mail, assignToMail, wildcard)
    const wwwCheckbox = page.locator('label:has-text("ve alan adını koru") input[type="checkbox"]');
    const webmailCheckbox = page.locator('label:has-text("webmail arayüzünü koru") input[type="checkbox"]');
    const mailCheckbox = page.locator('label:has-text("posta sunucusunu koru") input[type="checkbox"]');
    const assignMailCheckbox = page.locator('label:has-text("Sertifikayı posta alan adına ata") input[type="checkbox"]');
    const wildcardCheckbox = page.locator('label:has-text("Joker (Wildcard) sertifika çıkar") input[type="checkbox"]');

    await expect(wwwCheckbox).toBeVisible();
    await expect(webmailCheckbox).toBeVisible();
    await expect(mailCheckbox).toBeVisible();
    await expect(assignMailCheckbox).toBeVisible();
    await expect(wildcardCheckbox).toBeVisible();

    // Joker (Wildcard) tıklandığında DNS-01 uyarı mesajının görüntülenmesi
    const wildcardWarning = page.locator('text=Joker sertifikalar Cloudflare DNS-01 doğrulaması gerektirir');
    await expect(wildcardWarning).toHaveCount(0);

    await wildcardCheckbox.check();
    await expect(wildcardWarning).toBeVisible({ timeout: 5000 });
    await expect(wildcardCheckbox).toBeChecked();

    // Checkbox toggle etkileşimleri
    await wwwCheckbox.check();
    await expect(wwwCheckbox).toBeChecked();

    await webmailCheckbox.check();
    await expect(webmailCheckbox).toBeChecked();

    await mailCheckbox.check();
    await expect(mailCheckbox).toBeChecked();

    await assignMailCheckbox.check();
    await expect(assignMailCheckbox).toBeChecked();

    // Değişiklikleri sıfırla butonu etkileşimi
    const resetBtn = page.locator('button:has-text("Değişiklikleri sıfırla")');
    await expect(resetBtn).toBeEnabled();
    await resetBtn.click();

    // Sıfırlandıktan sonra wildcard uyarısının kaybolması ve varsayılan duruma dönüş
    await expect(wildcardWarning).toHaveCount(0);
    await expect(wildcardCheckbox).not.toBeChecked();
    await expect(resetBtn).toBeDisabled();
  });

  test('hatalı girdi ve sınır kontrolleri: Yetkisiz SAN ekleme, DNS-01 olmadan wildcard talebi ve SAN limitleri reddedilir', async ({ page }) => {
    const targetDomainId = createdDomainId || (await (async () => {
      const domainsRes = await page.request.get('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const list = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
      return list[0]?.id;
    })());
    expect(targetDomainId).toBeTruthy();

    const domainInfoRes = await page.request.get(`/api/panel/domains/${encodeURIComponent(targetDomainId)}`);
    expect(domainInfoRes.status()).toBe(200);
    const domainObj = (await domainInfoRes.json()).data || (await domainInfoRes.json()).domain;
    const baseDomain = domainObj.primaryDomain;

    // 1. Yetkisiz SAN: Domain veya alias listesinde bulunmayan yabancı bir alan adı eklendiğinde 409 reddi
    const unauthorizedSanRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(targetDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        domains: [baseDomain, 'unauthorized-external-target.com'],
      },
    });
    expect(unauthorizedSanRes.status()).toBe(409);
    const unauthorizedSanJson = await unauthorizedSanRes.json();
    expect(unauthorizedSanJson.error?.code).toBe('certificate_domain_mismatch');

    // 2. DNS-01 challenge olmadan Wildcard (*.domain) sertifikası talep edildiğinde 409 reddi
    const wildcardNoDnsRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(targetDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        domains: [baseDomain, `*.${baseDomain}`],
        challenge: { type: 'http-01' },
      },
    });
    expect(wildcardNoDnsRes.status()).toBe(409);
    const wildcardNoDnsJson = await wildcardNoDnsRes.json();
    expect(wildcardNoDnsJson.error?.code).toBe('wildcard_not_supported');

    // 3. 21 adetten fazla SAN alanı talep edildiğinde 400 invalid_certificate_domains reddi
    const excessSanList = [baseDomain];
    for (let i = 1; i <= 22; i++) {
      excessSanList.push(`sub${i}.${baseDomain}`);
    }
    const excessSanRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(targetDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        domains: excessSanList,
      },
    });
    expect(excessSanRes.status()).toBe(400);
    const excessSanJson = await excessSanRes.json();
    expect(excessSanJson.error?.code).toBe('invalid_certificate_domains');

    // 4. Boş string veya geçersiz formatlı domain adı gönderildiğinde 400 invalid_certificate_domain reddi
    const emptyDomainRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(targetDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        domains: [baseDomain, '   '],
      },
    });
    expect(emptyDomainRes.status()).toBe(400);
    const emptyDomainJson = await emptyDomainRes.json();
    expect(emptyDomainJson.error?.code).toBe('invalid_certificate_domain');

    // 5. DNS-01 challenge nesnesinde var olmayan dnsZoneId verildiğinde 404 dns_zone_not_found reddi
    const nonExistentZoneRes = await page.request.post(`/api/panel/domains/${encodeURIComponent(targetDomainId)}/certificates/issue`, {
      headers: apiHeaders(),
      data: {
        email: 'admin@webrich.news',
        challenge: {
          type: 'dns-01',
          dnsZoneId: '00000000-0000-4000-8000-000000000000',
          wildcard: true,
        },
      },
    });
    expect(nonExistentZoneRes.status()).toBe(404);
    const nonExistentZoneJson = await nonExistentZoneRes.json();
    expect(nonExistentZoneJson.error?.code).toBe('dns_zone_not_found');
  });

  test('Plesk SSL It! eşdeğerlik eksiklikleri: DNS-01 sağlayıcı yapılandırması, yerel DNS entegrasyonu ve sertifika kapsamını genişletme (Reissue with SAN) UI eksik', async ({ page }) => {
    test.fail(
      true,
      'BULGU TLS-02: Plesk SSL It! / Let\'s Encrypt uzantısı eşdeğeri olarak arayüzde DNS-01 sağlayıcı/token seçimi, yerel DNS otomatik TXT kaydı veya harici DNS manuel TXT prompt ekranı bulunmuyor; ayrıca mevcut sertifikanın SAN kapsamını genişletme (Reissue/Expand) arayüzü eksik.',
    );

    // 1. webrich.news aktif sertifikaya sahip bir domaindir.
    // Plesk'te aktif bir sertifika varken SSL It! ekranında "Reissue Certificate" veya "Kapsamı Değiştir"
    // seçeneğiyle www, mail, webmail veya wildcard eklenerek sertifika genişletilebilir (Multi-SAN / Reissue).
    // YunPanel'de ise sertifika aktif olunca yalnızca SslRenewalPanel görünmekte, kapsamı düzenleme veya
    // yeni SAN ekleme formu tamamen ortadan kalkmaktadır:
    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.domains || domainsJson.domains || []);
    const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news') || domainList[0];
    await page.goto(`/websites/${encodeURIComponent(mainDomain.id)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Bu kontrol beklenen özelliğin arayüzde olmadığını doğrular (test.fail ile işaretlenmiştir)
    const reissueSanBtn = page.locator('button:has-text("Kapsamı genişlet"), button:has-text("Sertifikayı yeniden çıkar"), button:has-text("Reissue")');
    await expect(reissueSanBtn).toBeVisible({ timeout: 5000 });
  });
});
