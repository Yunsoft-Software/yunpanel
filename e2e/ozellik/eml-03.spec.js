import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-03 Otomatik yanıt ve tatil mesajları', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `teml03-a${agentN}-${Date.now().toString(36)}`;
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

  test('mutlu yol: Mail arayüzü ve posta kutusu işlemleri doğrulanır; mevcut posta kutusu kontrolleri aktiftir', async ({ page }) => {
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

    // Mevcut bir mailbox satırını bul
    const mailboxRow = mailboxesSection.locator('table.ws-table tbody tr').first();
    await expect(mailboxRow).toBeVisible({ timeout: 15000 });

    const mailboxAddress = (await mailboxRow.locator('td strong').textContent())?.trim();
    expect(mailboxAddress).toContain('@');

    // 3. "Kota ve yönlendirme" butonuna tıkla ve mevcut ilke ayarlarını gör
    const policyBtn = mailboxRow.locator('button:has-text("Kota ve yönlendirme")');
    await expect(policyBtn).toBeVisible({ timeout: 10000 });
    await policyBtn.click();

    const policySection = page.locator('section').filter({ has: page.locator('h2', { hasText: `Mailbox policy · ${mailboxAddress}` }) });
    await expect(policySection).toBeVisible({ timeout: 15000 });

    // Kota ve yönlendirme form alanlarını doğrula
    await expect(policySection.locator('label:has-text("Kota (MiB)")')).toBeVisible({ timeout: 10000 });
    await expect(policySection.locator('label:has-text("Yönlendirme biçimi")')).toBeVisible({ timeout: 10000 });

    // 4. Fiziksel kanıt 1: Dovecot LMTP Sieve eklentisinin sunucuda aktif olduğunu doğrula
    const dovecotSieveCheck = runSsh('dovecot -n | grep -i "sieve" || true');
    expect(dovecotSieveCheck.length).toBeGreaterThan(0);

    // 5. Fiziksel kanıt 2: Postfix ve Dovecot servislerinin çalıştığını doğrula
    const mailServiceStatus = runSsh('systemctl is-active postfix dovecot');
    expect(mailServiceStatus).toContain('active');
  });

  test('hatalı girdi ve sınır durumları: Var olmayan veya tanımlanmamış autoresponder API uç noktası 404 döner', async ({ request }) => {
    // 1. API üzerinden tanımlanmamış /api/mailboxes/:id/autoresponder uç noktasına istek atıldığında 404 dönmeli
    const dummyMailboxId = '00000000-0000-4000-8000-000000000000';
    const apiRes = await request.get(`/api/mailboxes/${dummyMailboxId}/autoresponder`);
    expect(apiRes.status()).toBe(404);

    // 2. POST ile geçersiz otomatik yanıt payload'u gönderildiğinde de uç nokta bulunamadığı için 404 dönmeli
    const postRes = await request.post(`/api/mailboxes/${dummyMailboxId}/autoresponder`, {
      data: {
        enabled: true,
        subject: 'Otomatik Yanıt: Ofis Dışındayım',
        message: 'Mesajınız alındı, en kısa sürede döneceğim.',
        endDate: '2026-12-31',
      },
    });
    expect(postRes.status()).toBe(404);

    // 3. Fiziksel kontrol: Sunucuda mailbox-autoresponder registry dosyasının olmadığını doğrula
    const autoresponderRegistryCheck = runSsh('[ -f /var/lib/yunpanel/control-plane/mailbox-autoresponder-registry.json ] && echo "EXISTS" || echo "NOT_EXISTS"');
    expect(autoresponderRegistryCheck.trim()).toBe('NOT_EXISTS');
  });

  test('Plesk Parity kontrolü: E-posta hesabı için Otomatik Yanıtlayıcı (Autoresponder / Out of Office) formu ve Sieve vacation kuralı', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-03: Panelde Plesk eşdeğeri Mail Autoresponder (otomatik yanıt / tatil mesajı / vacation) arayüzü ve backend API uç noktası henüz mevcut değil'
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

    // Plesk'te yer alan "Otomatik yanıt" (Autoresponder / Out of Office) butonu veya sekmesi
    const autoresponderBtn = mailboxRow.locator('button:has-text("Otomatik yanıt"), button:has-text("Tatil Mesajı"), button:has-text("Autoresponder")');
    await expect(autoresponderBtn).toBeVisible({ timeout: 5000 });

    // Tıklanabilirse modal veya panelin açılması beklenir
    await autoresponderBtn.click();
    const autoresponderModal = page.locator('.ws-modal, section').filter({ hasText: 'Otomatik yanıt' });
    await expect(autoresponderModal).toBeVisible({ timeout: 5000 });

    // Plesk eşdeğeri alanlar: Konu, mesaj metni, bitiş tarihi
    await expect(autoresponderModal.locator('input[name="subject"], label:has-text("Konu")')).toBeVisible({ timeout: 5000 });
    await expect(autoresponderModal.locator('textarea[name="message"], label:has-text("Mesaj")')).toBeVisible({ timeout: 5000 });
    await expect(autoresponderModal.locator('input[type="date"], label:has-text("Bitiş")')).toBeVisible({ timeout: 5000 });
  });
});
