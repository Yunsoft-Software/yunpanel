import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-07 Webmail, mail istemci ayarları ve otomatik yapılandırma', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `teml07-a${agentN}-${Date.now().toString(36)}`;
  let targetDomainName = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
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
    try {
      runSsh(`node -e "
        const fs = require('fs');
        const { execSync } = require('child_process');
        try {
          execSync(\\"sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 \\\\\\"DELETE FROM virtual_mailboxes WHERE address LIKE '${prefix}%';\\\\\\"\\");
        } catch {}
        try {
          const mbPath = '/var/lib/yunpanel/control-plane/mailbox-registry.json';
          if (fs.existsSync(mbPath)) {
            const data = JSON.parse(fs.readFileSync(mbPath, 'utf8'));
            data.mailboxes = (data.mailboxes || []).filter(m => !m.address.startsWith('${prefix}'));
            fs.writeFileSync(mbPath, JSON.stringify(data, null, 2) + '\\n');
          }
        } catch {}
      " 2>/dev/null || true`);
    } catch {
      // Temizlik adımı
    }
  });

  test('mutlu yol: Webmail görünümü, e-posta istemci bağlantı ayarları tanılama modalı ve fiziksel servis yanıtları', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini seç
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';

    // Mail domain yönetimine gir
    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // 2. Posta kutuları sekmesinde mailbox listesini ve İstemci Bağlantı Ayarları modalını doğrula
    const mailboxSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxSection).toBeVisible({ timeout: 15000 });

    // Mevcut veya ilk mailbox satırını bul
    const mailboxRow = mailboxSection.locator('table tbody tr').first();
    await expect(mailboxRow).toBeVisible({ timeout: 15000 });

    const selectedAddress = (await mailboxRow.locator('td strong').textContent())?.trim();

    // "Tanılama" butonuna tıkla ve İstemci Bağlantı Ayarları modalını doğrula
    const diagBtn = mailboxRow.locator('button:has-text("Tanılama")');
    await expect(diagBtn).toBeVisible({ timeout: 10000 });
    await diagBtn.click();

    const diagModal = page.locator('.ws-modal').filter({ hasText: 'Bağlantı & Teslimat Tanılama' });
    await expect(diagModal).toBeVisible({ timeout: 10000 });

    // İstemci bağlantı ayarları başlığı ve içeriği
    const clientSettingsSection = diagModal.locator('section').filter({ has: page.locator('h2', { hasText: 'İstemci Bağlantı Ayarları' }) });
    await expect(clientSettingsSection).toBeVisible({ timeout: 15000 });

    // IMAP ve SMTP port / güvenlik bilgilerini doğrula
    await expect(clientSettingsSection.locator('dt:has-text("Kullanıcı adı")')).toBeVisible();
    if (selectedAddress) {
      await expect(clientSettingsSection.locator(`dd:has-text("${selectedAddress}")`)).toBeVisible();
    }

    await expect(clientSettingsSection.locator('dt:has-text("Gelen Sunucu (IMAP)")')).toBeVisible();
    await expect(clientSettingsSection.locator('dd:has-text("993")').first()).toBeVisible();

    await expect(clientSettingsSection.locator('dt:has-text("Giden Sunucu (SMTP)")')).toBeVisible();
    await expect(clientSettingsSection.locator('dd:has-text("587")').first()).toBeVisible();

    await expect(clientSettingsSection.locator('dt:has-text("Kimlik Doğrulama")')).toBeVisible();
    await expect(clientSettingsSection.locator('dd:has-text("Password (PLAIN, LOGIN)")')).toBeVisible();

    // Modalı kapat
    await diagModal.locator('footer button:has-text("Kapat")').click();
    await expect(diagModal).not.toBeVisible({ timeout: 5000 });

    // 3. "Webmail" sekmesine geç ve Webmail (Roundcube) bölümünü doğrula
    const webmailTab = page.locator('nav.ws-tabs a:has-text("Webmail")');
    await expect(webmailTab).toBeVisible({ timeout: 10000 });
    await webmailTab.click();
    await page.waitForURL(/section=webmail/, { timeout: 10000 });

    const webmailSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Webmail (Roundcube)' }) });
    await expect(webmailSection).toBeVisible({ timeout: 15000 });
    await expect(webmailSection.locator('text=Roundcube webmail eşlemesi')).toBeVisible();
    await expect(webmailSection.locator('text=Webmail henüz bağlı değil').or(webmailSection.locator('dt:has-text("Webmail Adresi")'))).toBeVisible();

    // 4. Fiziksel kanıt 1: Roundcube Webmail HTTP 200 testi (canlı Nginx/PHP-FPM webmail vhost)
    const roundcubeProbe = runSsh("curl -sI -k -H 'Host: mail.webrich.news' https://127.0.0.1/ | head -n 12");
    expect(roundcubeProbe).toContain('HTTP/1.1 200 OK');
    expect(roundcubeProbe).toContain('roundcube_sessid');

    // 5. Fiziksel kanıt 2: Thunderbird Autoconfig XML otomatik yapılandırma yanıtı
    const autoconfigProbe = runSsh(
      `curl -s --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'X-Forwarded-Proto: https' -H 'Host: ${targetDomainName}' ` +
      `'http://localhost/mail/config-v1.1.xml?emailaddress=info@${targetDomainName}'`
    );
    expect(autoconfigProbe).toContain('<clientConfig version="1.1">');
    expect(autoconfigProbe).toContain(`<domain>${targetDomainName}</domain>`);
    expect(autoconfigProbe).toContain('<incomingServer type="imap">');
    expect(autoconfigProbe).toContain('<outgoingServer type="smtp">');
    expect(autoconfigProbe).toContain('<port>143</port>');
    expect(autoconfigProbe).toContain('<port>587</port>');

    // 6. Fiziksel kanıt 3: Microsoft Outlook Autodiscover XML yanıtı
    const autodiscoverXml = `<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006">` +
      `<Request><EMailAddress>info@${targetDomainName}</EMailAddress>` +
      `<AcceptableResponseSchema>http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a</AcceptableResponseSchema>` +
      `</Request></Autodiscover>`;
    const autodiscoverProbe = runSsh(
      `curl -s --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'X-Forwarded-Proto: https' -H 'Host: ${targetDomainName}' ` +
      `-H 'Content-Type: text/xml' -d ${JSON.stringify(autodiscoverXml)} ` +
      `'http://localhost/autodiscover/autodiscover.xml'`
    );
    expect(autodiscoverProbe).toContain('<Autodiscover');
    expect(autodiscoverProbe).toContain('<Action>settings</Action>');
    expect(autodiscoverProbe).toContain('<Type>IMAP</Type>');
    expect(autodiscoverProbe).toContain('<Type>SMTP</Type>');
  });

  test('hatalı girdi ve sınır durumları: Eksik parametre, geçersiz metod ve malformed XML autodiscover/autoconfig tarafından reddedilir', async () => {
    // 1. Eksik email adresi sorgusu (HTTP 400 mail_discovery_address_missing)
    const missingParamProbe = runSsh(
      `curl -s -i --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'X-Forwarded-Proto: https' -H 'Host: ${targetDomainName || 'yp-form.webrich.news'}' ` +
      `'http://localhost/mail/config-v1.1.xml' | head -n 5`
    );
    expect(missingParamProbe).toContain('400');

    // 2. Geçersiz HTTP metodu: autodiscover GET ile çağrılamaz (HTTP 405 Method Not Allowed)
    const wrongMethodProbe = runSsh(
      `curl -s -i -X GET --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'X-Forwarded-Proto: https' -H 'Host: ${targetDomainName || 'yp-form.webrich.news'}' ` +
      `'http://localhost/autodiscover/autodiscover.xml' | head -n 5`
    );
    expect(wrongMethodProbe).toContain('405');

    // 3. Geçersiz / bozuk XML gövdesi (HTTP 400 Bad Request)
    const malformedXmlProbe = runSsh(
      `curl -s -i -X POST --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'X-Forwarded-Proto: https' -H 'Host: ${targetDomainName || 'yp-form.webrich.news'}' ` +
      `-H 'Content-Type: text/xml' -d '<InvalidXml>NoClosingTag' ` +
      `'http://localhost/autodiscover/autodiscover.xml' | head -n 5`
    );
    expect(malformedXmlProbe).toContain('400');

    // 4. HTTPS proxy başlığı eksik olduğunda erişim reddi (HTTP 404 mail_discovery_https_required)
    const insecureProbe = runSsh(
      `curl -s -i --unix-socket /run/yunpanel-mail-discovery/discovery.sock ` +
      `-H 'Host: ${targetDomainName || 'yp-form.webrich.news'}' ` +
      `'http://localhost/mail/config-v1.1.xml?emailaddress=test@domain.com' | head -n 5`
    );
    expect(insecureProbe).toContain('404');
  });

  test('Plesk Parity kontrolü: Apple Mail / iOS .mobileconfig indirme ve tek tıkla Roundcube Webmail oturumu (SSO)', async ({ page }) => {
    test.fail(true, 'BULGU EML-07: Plesk eşdeğeri iOS .mobileconfig istemci profili indirme ve Webmail SSO tek tıkla oturum açma henüz uygulanmadı.');

    await page.goto('/mail');
    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await localDomainRow.locator('a:has-text("Yönet")').click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // Plesk'te yer alan mobil profil indirme butonu
    const mobileConfigBtn = page.locator('button:has-text("Mail Profili İndir (.mobileconfig)"), a:has-text("İstemci Ayarlarını İndir")');
    await expect(mobileConfigBtn).toBeVisible({ timeout: 5000 });
  });
});
