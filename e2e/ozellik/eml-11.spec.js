import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test.describe('EML-11 Mail servisi sertifikası ve hostname/SNI davranışı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  let csrfToken = '';
  let panelOrigin = '';

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

    panelOrigin = new URL(page.url()).origin;
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  function mutationHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-csrf-token': csrfToken,
      Origin: panelOrigin,
      Referer: `${panelOrigin}/`,
    };
  }

  test.afterAll(async () => {
    // Salt-okunur doğrulama ve mevcut sunucu durum kontrolü yapıldığı için
    // silinmesi gereken geçici test kaynağı bulunmamaktadır.
  });

  test('mutlu yol: mail servisi ana sertifikası bağlama durumu, Postfix ve Dovecot TLS yapılandırması ve fiziksel SMTP/IMAP TLS el sıkışmaları', async ({ page }) => {
    // 1. Mail servis kimliği API'sini ve bağlı webDomainId'yi sorgula
    const identityRes = await page.request.get('/api/panel/mail-service-identity');
    expect(identityRes.status()).toBe(200);

    const identityJson = await identityRes.json();
    const identityData = identityJson?.data;
    expect(identityData).toBeTruthy();
    expect(identityData.hostname).toBe('mail.webrich.news');
    expect(identityData.ready).toBe(true);
    expect(Array.isArray(identityData.blockers)).toBe(true);
    expect(identityData.blockers.length).toBe(0);

    // 2. Panel arayüzünden ilgili alan adının SSL yönetim ekranına git
    const targetDomainId = identityData.webDomainId;
    await page.goto(`/websites/${encodeURIComponent(targetDomainId)}/ssl`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // SSL sertifikası kartını ve sertifika adını doğrula
    const sslSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'SSL sertifikası' }) });
    await expect(sslSection).toBeVisible({ timeout: 15000 });
    await expect(sslSection.locator('dt', { hasText: 'Sertifika adı' })).toBeVisible({ timeout: 10000 });

    // 3. Fiziksel Postfix yapılandırması kontrolü (SSH)
    const postfixConf = runSsh('postconf smtpd_tls_cert_file smtpd_tls_key_file myhostname');
    expect(postfixConf).toContain('myhostname = mail.webrich.news');
    expect(postfixConf).toContain('smtpd_tls_cert_file = /etc/letsencrypt/live/mail.webrich.news/fullchain.pem');
    expect(postfixConf).toContain('smtpd_tls_key_file = /etc/letsencrypt/live/mail.webrich.news/privkey.pem');

    // 4. Fiziksel Dovecot yapılandırması kontrolü (SSH)
    const dovecotConf = runSsh('grep -E "^ssl_cert|^ssl_key" /etc/dovecot/conf.d/99-yunpanel-mail.conf');
    expect(dovecotConf).toContain('ssl_cert = </etc/letsencrypt/live/mail.webrich.news/fullchain.pem');
    expect(dovecotConf).toContain('ssl_key = </etc/letsencrypt/live/mail.webrich.news/privkey.pem');

    // 5. Fiziksel Postfix SMTP SSL/TLS (port 465) el sıkışması ve sertifika doğrulaması
    const opensslSmtp = runSsh(
      'echo QUIT | openssl s_client -connect 127.0.0.1:465 -servername mail.webrich.news 2>/dev/null | openssl x509 -noout -subject -issuer'
    );
    expect(opensslSmtp).toContain('CN = mail.webrich.news');
    expect(opensslSmtp).toContain("Let's Encrypt");

    // 6. Fiziksel Dovecot IMAPS (port 993) el sıkışması ve sertifika doğrulaması
    const opensslImap = runSsh(
      'echo QUIT | openssl s_client -connect 127.0.0.1:993 -servername mail.webrich.news 2>/dev/null | openssl x509 -noout -subject -issuer'
    );
    expect(opensslImap).toContain('CN = mail.webrich.news');
    expect(opensslImap).toContain("Let's Encrypt");
  });

  test('hatalı girdi ve koruma: geçersiz kimlik, uyuşmayan domain ve revizyon çakışması reddedilir', async ({ page }) => {
    // 0. Güncel durumu al
    const currentRes = await page.request.get('/api/panel/mail-service-identity');
    const currentData = (await currentRes.json())?.data;
    expect(currentData?.webDomainId).toBeTruthy();
    const currentRev = currentData?.revision ?? 0;

    // 1. Olmayan WebDomainId ile bağlama isteği (doğru revizyon numarası ile) -> 404 domain_not_found
    const nonExistentId = randomUUID();
    const missingDomainRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: mutationHeaders(),
      data: {
        webDomainId: nonExistentId,
        expectedRevision: currentRev,
      },
    });
    expect(missingDomainRes.status()).toBe(404);
    const missingDomainJson = await missingDomainRes.json();
    expect(missingDomainJson?.error?.code).toBe('domain_not_found');

    // 2. Mevcut geçerli WebDomainId ama uyuşmayan revizyon numarası -> 409 conflict
    const conflictRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: mutationHeaders(),
      data: {
        webDomainId: currentData.webDomainId,
        expectedRevision: 999999,
      },
    });
    expect(conflictRes.status()).toBe(409);
    const conflictJson = await conflictRes.json();
    expect(conflictJson?.error?.code).toBe('mail_service_identity_revision_conflict');

    // 3. Eksik veya geçersiz alanlar -> 400 validation error
    const badInputRes = await page.request.put('/api/panel/mail-service-identity', {
      headers: mutationHeaders(),
      data: {
        webDomainId: currentData.webDomainId,
      },
    });
    expect(badInputRes.status()).toBe(400);
    const badInputJson = await badInputRes.json();
    expect(badInputJson?.error?.code).toBe('mail_service_identity_bind_input_invalid');
  });

  test('Plesk eşdeğeri alan adı bazlı Mail SNI ve çoklu sertifika haritası (Postfix tls_server_sni_maps & Dovecot local_name) eksikliği', async () => {
    test.fail(
      true,
      'BULGU EML-11-A: Plesk eşdeğeri çoklu alan adı Mail SNI haritası (Postfix tls_server_sni_maps ve Dovecot local_name) tanımlı değil; sistem yalnızca tek sunucu ana mail sertifikasını destekliyor'
    );

    // 1. Postfix SNI harita yapılandırması kontrolü
    const sniMapsConf = runSsh('postconf -h tls_server_sni_maps').trim();

    // 2. Dovecot per-domain local_name SNI blokları kontrolü
    const dovecotSniConf = runSsh("grep -rn 'local_name' /etc/dovecot/ 2>/dev/null || true").trim();

    // Plesk eşdeğerinde farklı alan adlarına ait sertifikaların SNI ile istemciye sunulabilmesi için
    // tls_server_sni_maps ve dovecot local_name haritalarının tanımlı olması gerekir.
    // YunPanel'de bu haritalar tanımlı olmadığı için aşağıdaki kontroller fail eder ve test.fail işaretlenir.
    expect(sniMapsConf).not.toBe('');
    expect(dovecotSniConf).not.toBe('');
  });
});
