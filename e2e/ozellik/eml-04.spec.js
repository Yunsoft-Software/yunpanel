import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-04 Spam filtre, allow/deny list ve antivirüs politikası', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `teml04-a${agentN}-${Date.now().toString(36)}`;
  let targetDomainName = '';
  let mailDomainId = '';

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

  test('mutlu yol: Mail arayüzü ve Rspamd spam filtre motorunun fiziksel aktifliği doğrulanır', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini seç
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'webrich.news';

    // Mail domain yönetimine gir
    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    mailDomainId = urlMatch ? urlMatch[1] : '';
    expect(mailDomainId).toBeTruthy();

    // 2. Posta kutuları (Mailboxes) panelini doğrula
    const mailboxesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxesSection).toBeVisible({ timeout: 15000 });

    // 3. Sistem genelinde Rspamd servis loglarının görüntülenebilir olduğunu doğrula
    await page.goto('/mail');
    const logsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail servis logları' }) });
    if (await logsSection.isVisible({ timeout: 5000 }).catch(() => false)) {
      const serviceSelect = logsSection.locator('select');
      await expect(serviceSelect).toBeVisible();
      // rspamd seçeneğinin mevcut olduğunu doğrula
      const rspamdOption = serviceSelect.locator('option[value="rspamd"]');
      await expect(rspamdOption).toBeAttached();
    }

    // 4. Fiziksel kanıt 1: Sunucuda Rspamd servisinin çalıştığını doğrula
    const rspamdStatus = runSsh('systemctl is-active rspamd');
    expect(rspamdStatus.trim()).toBe('active');

    // 5. Fiziksel kanıt 2: Postfix smtpd_milters yapılandırmasında Rspamd soketinin aktif olduğunu doğrula
    const milters = runSsh('postconf -h smtpd_milters');
    expect(milters.trim()).toContain('127.0.0.1:11332');

    // 6. Fiziksel kanıt 3: Rspamd worker proxy'nin milter ve self_scan modunda çalıştığını doğrula
    const workerProxyConfig = runSsh('cat /etc/rspamd/local.d/worker-proxy.inc');
    expect(workerProxyConfig).toContain('milter = yes');
    expect(workerProxyConfig).toContain('self_scan = yes');
  });

  test('hatalı girdi ve sınır durumları: Tanımlanmamış spam filtresi ve antivirüs API uç noktaları 404 döner', async ({ request }) => {
    // 1. Tanımlanmamış /api/mail/spam-filter API uç noktasına istek atıldığında 404 dönmeli
    const spamFilterRes = await request.get('/api/mail/spam-filter');
    expect(spamFilterRes.status()).toBe(404);

    // 2. POST ile spam ayarı veya allow/deny listesi kaydetmeye çalışıldığında da 404 dönmeli
    const spamPostRes = await request.post('/api/mail/spam-filter', {
      data: {
        domain: targetDomainName || 'webrich.news',
        threshold: 5.0,
        action: 'add_header',
        allowlist: ['trusted@example.com', '*@trusted-partner.org'],
        denylist: ['spammer@badsource.net', '*@known-spam.biz'],
      },
    });
    expect(spamPostRes.status()).toBe(404);

    // 3. Tanımlanmamış /api/mail/antivirus API uç noktasına istek atıldığında 404 dönmeli
    const avRes = await request.get('/api/mail/antivirus');
    expect(avRes.status()).toBe(404);

    // 4. Fiziksel kontrol 1: Sunucuda Rspamd multimap (allowlist/denylist) kural dosyasının olmadığını doğrula
    const multimapCheck = runSsh('[ -f /etc/rspamd/local.d/multimap.conf ] && echo "EXISTS" || echo "NOT_EXISTS"');
    expect(multimapCheck.trim()).toBe('NOT_EXISTS');

    // 5. Fiziksel kontrol 2: Sunucuda Rspamd antivirüs (ClamAV) kural dosyasının olmadığını doğrula
    const antivirusConfCheck = runSsh('[ -f /etc/rspamd/local.d/antivirus.conf ] && echo "EXISTS" || echo "NOT_EXISTS"');
    expect(antivirusConfCheck.trim()).toBe('NOT_EXISTS');

    // 6. Fiziksel kontrol 3: ClamAV servisinin varsayılan olarak sistemde çalışmadığını (inactive) doğrula
    const clamavStatus = runSsh('systemctl is-active clamav-daemon || true');
    expect(clamavStatus.trim()).toBe('inactive');
  });

  test('Plesk Parity kontrolü: E-posta hesabı veya alan adı için Spam Filtresi (Rspamd/SpamAssassin), Beyaz/Kara Liste ve Antivirüs politikası', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-04: Panelde Plesk eşdeğeri SpamFilter (duyarlılık eşiği, konu etiketleme, silme/karantina), allow/deny list (beyaz/kara liste) ve Antivirüs (ClamAV) gelen/giden tarama arayüzü ve API uç noktası henüz mevcut değil'
    );

    // 1. Mail sayfasına git ve mail domain detayını aç
    await page.goto('/mail');
    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await localDomainRow.locator('a:has-text("Yönet")').click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const mailboxesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxesSection).toBeVisible({ timeout: 15000 });

    const mailboxRow = mailboxesSection.locator('table.ws-table tbody tr').first();
    await expect(mailboxRow).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan "Spam Filtresi" (Spam Filter) butonu veya sekmesi
    const spamFilterBtn = mailboxRow.locator('button:has-text("Spam Filtresi"), button:has-text("Spam"), button:has-text("Spam Koruması")');
    await expect(spamFilterBtn).toBeVisible({ timeout: 5000 });

    // Butona tıklandığında ayar modalı veya paneli açılmalı
    await spamFilterBtn.click();
    const spamModal = page.locator('.ws-modal, section').filter({ hasText: 'Spam Filtresi' });
    await expect(spamModal).toBeVisible({ timeout: 5000 });

    // Plesk eşdeğeri alanlar:
    // a. Spam filtresini aç/kapat onay kutusu
    await expect(spamModal.locator('input[type="checkbox"][name="spam_filter_enabled"], label:has-text("Spam korumasını etkinleştir")')).toBeVisible({ timeout: 5000 });

    // b. Spam duyarlılık puanı / eşiği (score threshold)
    await expect(spamModal.locator('input[name="threshold"], select[name="threshold"], label:has-text("Spam puanı")')).toBeVisible({ timeout: 5000 });

    // c. Beyaz liste (Allowlist / Whitelist) alanı
    await expect(spamModal.locator('textarea[name="whitelist"], textarea[name="allowlist"], label:has-text("Beyaz liste")')).toBeVisible({ timeout: 5000 });

    // d. Kara liste (Denylist / Blacklist) alanı
    await expect(spamModal.locator('textarea[name="blacklist"], textarea[name="denylist"], label:has-text("Kara liste")')).toBeVisible({ timeout: 5000 });

    // e. Antivirüs koruması (gelen/giden virüs taraması)
    await expect(spamModal.locator('input[name="antivirus_enabled"], label:has-text("Antivirüs")')).toBeVisible({ timeout: 5000 });
  });
});
