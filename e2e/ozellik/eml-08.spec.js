import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-08 SMTP/IMAP/POP3 ve TLS port politikası; kurulum bileşenine göre', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `teml08-a${agentN}-${Date.now().toString(36)}`;
  let serverId = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
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

  test('mutlu yol: Mail servis bağlantı ve port durumu tablosu, istemci ayarları ve fiziksel SMTP/IMAP TLS el sıkışmaları', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini seç
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // 2. "Kuyruk ve loglar" (operations) sekmesine geç
    const opsTab = page.locator('nav.ws-tabs a:has-text("Kuyruk ve loglar")');
    await expect(opsTab).toBeVisible({ timeout: 10000 });
    await opsTab.click();
    await page.waitForURL(/section=operations/, { timeout: 10000 });

    // 3. ServiceConnectionDiagnosticsPanel doğrulaması
    const diagSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail servis bağlantı ve port durumu' }) });
    await expect(diagSection).toBeVisible({ timeout: 15000 });

    // Port ve TLS özet tanımlarını doğrula
    await expect(diagSection.locator('dt:has-text("Gelen IMAP Portları & TLS")')).toBeVisible();
    await expect(diagSection.locator('dd:has-text("993, 143")')).toBeVisible();

    await expect(diagSection.locator('dt:has-text("Giden SMTP Portları & TLS")')).toBeVisible();
    await expect(diagSection.locator('dd:has-text("465, 587, 25")')).toBeVisible();

    await expect(diagSection.locator('dt:has-text("Kimlik Doğrulama")')).toBeVisible();
    await expect(diagSection.locator('dd:has-text("PLAIN")')).toBeVisible();

    // Protokol tablosu ve dinleme durumlarını doğrula
    const protoTable = diagSection.locator('table[aria-label="Mail protokolleri"]');
    await expect(protoTable).toBeVisible({ timeout: 10000 });

    const expectedProtocols = [
      { name: 'SMTP', port: '25', tls: 'STARTTLS' },
      { name: 'SUBMISSION', port: '587', tls: 'STARTTLS' },
      { name: 'SUBMISSIONS', port: '465', tls: 'Doğrudan SSL/TLS' },
      { name: 'IMAP', port: '143', tls: 'STARTTLS' },
      { name: 'IMAPS', port: '993', tls: 'Doğrudan SSL/TLS' },
    ];

    for (const proto of expectedProtocols) {
      const row = protoTable.locator('tbody tr').filter({ hasText: proto.port }).filter({ hasText: proto.name });
      await expect(row).toBeVisible({ timeout: 5000 });
      await expect(row.locator('td strong', { hasText: proto.name })).toBeVisible();
      await expect(row.locator('td .ws-badge:has-text("Dinliyor (Aktif)")')).toBeVisible();
      await expect(row.locator('td', { hasText: proto.tls })).toBeVisible();
    }

    // 4. "Posta kutuları" sekmesine dön ve İstemci Bağlantı Ayarları modalını doğrula
    const mailboxesTab = page.locator('nav.ws-tabs a:has-text("Posta kutuları")');
    await mailboxesTab.click();
    await page.waitForURL(/(?:\?.*section=mailboxes|\/mail\/[^/?]+$)/, { timeout: 10000 });

    const mailboxRow = page.locator('table.ws-table tbody tr').first();
    if (await mailboxRow.isVisible({ timeout: 5000 }).catch(() => false)) {
      const diagBtn = mailboxRow.locator('button:has-text("Tanılama")');
      if (await diagBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await diagBtn.click();
        const modal = page.locator('.ws-modal').filter({ hasText: 'Bağlantı & Teslimat Tanılama' });
        await expect(modal).toBeVisible({ timeout: 10000 });
        await expect(modal.locator('dt:has-text("Gelen Sunucu (IMAP)")')).toBeVisible();
        await expect(modal.locator('dd:has-text("993")').first()).toBeVisible();
        await expect(modal.locator('dt:has-text("Giden Sunucu (SMTP)")')).toBeVisible();
        await expect(modal.locator('dd:has-text("587")').first()).toBeVisible();
        await modal.locator('footer button:has-text("Kapat")').click();
        await expect(modal).not.toBeVisible({ timeout: 5000 });
      }
    }

    // 5. Fiziksel kanıt 1: SSH üzerinden ss -tulpn ile Postfix ve Dovecot süreçlerinin portları dinlemesi
    const ssListening = runSsh("ss -tulpn | grep -E ':(25|465|587|143|993) '");
    expect(ssListening).toContain('dovecot');
    expect(ssListening).toContain('master');
    expect(ssListening).toContain(':25');
    expect(ssListening).toContain(':465');
    expect(ssListening).toContain(':587');
    expect(ssListening).toContain(':143');
    expect(ssListening).toContain(':993');

    // 6. Fiziksel kanıt 2: 5 protokol portunda openssl s_client ile TLS el sıkışması ve sertifika doğrulaması
    const tls25 = runSsh("echo 'QUIT' | openssl s_client -starttls smtp -connect 127.0.0.1:25 -brief 2>&1");
    expect(tls25).toContain('CONNECTION ESTABLISHED');
    expect(tls25).toMatch(/Protocol version: TLSv1\.[23]/);

    const tls587 = runSsh("echo 'QUIT' | openssl s_client -starttls smtp -connect 127.0.0.1:587 -brief 2>&1");
    expect(tls587).toContain('CONNECTION ESTABLISHED');
    expect(tls587).toMatch(/Protocol version: TLSv1\.[23]/);

    const tls465 = runSsh("echo 'QUIT' | openssl s_client -connect 127.0.0.1:465 -brief 2>&1");
    expect(tls465).toContain('CONNECTION ESTABLISHED');
    expect(tls465).toMatch(/Protocol version: TLSv1\.[23]/);

    const tls143 = runSsh("echo 'a LOGOUT' | openssl s_client -starttls imap -connect 127.0.0.1:143 -brief 2>&1");
    expect(tls143).toContain('CONNECTION ESTABLISHED');
    expect(tls143).toMatch(/Protocol version: TLSv1\.[23]/);

    const tls993 = runSsh("echo 'a LOGOUT' | openssl s_client -connect 127.0.0.1:993 -brief 2>&1");
    expect(tls993).toContain('CONNECTION ESTABLISHED');
    expect(tls993).toMatch(/Protocol version: TLSv1\.[23]/);

    // 7. Fiziksel kanıt 3: Plaintext authentication engeli ve STARTTLS zorunluluğu
    const plainAuthSubmission = runSsh(`python3 -c "
import socket
s = socket.create_connection(('127.0.0.1', 587), timeout=5)
banner = s.recv(1024).decode()
s.sendall(b'EHLO test.local\\r\\n')
ehlo = s.recv(2048).decode()
s.sendall(b'AUTH LOGIN\\r\\n')
res = s.recv(1024).decode()
s.sendall(b'QUIT\\r\\n')
s.close()
print(res.strip())
"`);
    expect(plainAuthSubmission).toContain('530 5.7.0 Must issue a STARTTLS command first');

    const dovecotPlaintextCheck = runSsh("doveconf -a | grep disable_plaintext_auth");
    expect(dovecotPlaintextCheck).toContain('disable_plaintext_auth = yes');
  });

  test('kurulum bileşeni ve sınır durumları: POP3 (110/995) protokol durumu, aktif protokol listesi ve API yetki/hata kontrolleri', async ({ page }) => {
    // 1. Kurulum bileşeni kontrolü: Ubuntu kurulumunda dovecot-pop3d kurulu değil, protocols = imap lmtp
    const dovecotProtocols = runSsh('doveconf protocols');
    expect(dovecotProtocols).toContain('protocols = imap lmtp');
    expect(dovecotProtocols).not.toContain('pop3');

    // 2. Fiziksel port kontrolü: POP3 (110) ve POP3S (995) portlarında dinleyici olmamalıdır
    const pop3Listening = runSsh("ss -H -ltn 'sport = :110 or sport = :995'").trim();
    expect(pop3Listening).toBe('');

    // 3. Fiziksel bağlantı denemesi: POP3 portlarına TCP bağlantısı Connection Refused vermelidir
    const pop3ConnRefused = runSsh(`python3 -c "
import socket
for port in (110, 995):
    try:
        s = socket.create_connection(('127.0.0.1', port), timeout=2)
        s.close()
        print(f'{port}:connected')
    except ConnectionRefusedError:
        print(f'{port}:refused')
    except Exception as e:
        print(f'{port}:{e}')
"`);
    expect(pop3ConnRefused).toContain('110:refused');
    expect(pop3ConnRefused).toContain('995:refused');

    // 4. API doğrulaması: Sunucu mail teslimat tanılama endpoint'i
    serverId = runSsh(`python3 -c "
import json
data = json.load(open('/var/lib/yunpanel/control-plane/server-registry.json'))
print(data['servers'][0]['id'])
"`).trim();
    expect(serverId).toMatch(/^[0-9a-f-]{36}$/);

    const apiHeaders = {
      Origin: 'https://server.cryptoraichu.website',
    };
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrfToken = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    if (csrfToken) {
      apiHeaders['x-csrf-token'] = csrfToken;
    }

    const diagRes = await page.request.get(`/api/panel/servers/${serverId}/mail/delivery-diagnostics`, {
      headers: apiHeaders,
    });
    expect(diagRes.status()).toBe(200);

    const diagJson = await diagRes.json();
    const protocols = diagJson.data?.protocols;
    expect(protocols?.ready).toBe(true);
    expect(protocols?.protocols?.length).toBe(5);

    const protoIds = protocols.protocols.map((p) => p.id);
    expect(protoIds).toEqual(expect.arrayContaining(['smtp', 'submission', 'submissions', 'imap', 'imaps']));
    expect(protoIds).not.toContain('pop3');
    expect(protoIds).not.toContain('pop3s');

    for (const p of protocols.protocols) {
      expect(p.satisfied).toBe(true);
    }

    // 5. Hatalı girdi / sınır durumu: Geçersiz server ID 404 döndürmelidir
    const invalidRes = await page.request.get('/api/panel/servers/invalid-server-uuid-12345/mail/delivery-diagnostics', {
      headers: apiHeaders,
    });
    expect(invalidRes.status()).toBe(404);
    const invalidJson = await invalidRes.json();
    expect(invalidJson?.error?.code || invalidJson?.code).toBe('server_not_found');
  });

  test('Plesk Parity kontrolü: Mail Server Settings altında SMTP/IMAP/POP3 port değiştirme ve SSL/TLS cipher politikası seçici arayüzü', async ({ page }) => {
    test.fail(true, 'BULGU EML-08: Plesk eşdeğeri Mail Server Settings altında SMTP/IMAP/POP3 port özelleştirme, POP3 aktivasyonu ve SSL/TLS cipher politikası seçici arayüzü henüz bulunmuyor.');

    await page.goto('/mail');
    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await localDomainRow.locator('a:has-text("Yönet")').click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const opsTab = page.locator('nav.ws-tabs a:has-text("Kuyruk ve loglar")');
    await opsTab.click();
    await page.waitForURL(/section=operations/, { timeout: 10000 });

    // Plesk'te yer alan port yapılandırma formu ve TLS Cipher Suite seçici buton/form elemanları
    const mailServerSettingsBtn = page.locator('button:has-text("Port Yapılandırma"), button:has-text("Portları Değiştir"), button:has-text("TLS Cipher Politikası")');
    await expect(mailServerSettingsBtn).toBeVisible({ timeout: 5000 });
  });
});
