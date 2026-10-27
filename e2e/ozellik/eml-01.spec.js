import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-01 Mailbox oluşturma/düzenleme/silme, parola ve kota', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `teml01-a${agentN}-${Date.now().toString(36)}`;
  const localPart = prefix;
  let fullAddress = '';
  let mailDomainId = '';
  let targetDomainName = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  async function waitForMailJobsIdle(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = runSsh(`python3 -c "
import json
d = json.load(open('/var/lib/yunpanel/control-plane/job-registry.json'))
jobs = d.get('jobs', d if isinstance(d, list) else [])
active = [j for j in jobs if j.get('status') in ['running', 'queued']]
print(len(active))
"`).trim();
        if (count === '0') return;
      } catch {
        // ignore ssh transient errors
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async function fillAndConfirm(modalLocator) {
    const code = (await modalLocator.locator('label strong').textContent())?.trim();
    if (code) {
      await modalLocator.locator('label input').fill(code);
    }
    await waitForMailJobsIdle();
    const btn = modalLocator.locator('button[type="submit"]');
    await expect(btn).toBeEnabled({ timeout: 15000 });
    await btn.click();
  }

  async function submitAndExpectClose(modalLocator, submitSelector = 'button[type="submit"]', closeTimeout = 45000) {
    await waitForMailJobsIdle();
    const submitBtn = modalLocator.locator(submitSelector);
    await expect(submitBtn).toBeEnabled({ timeout: 10000 });
    await submitBtn.click();

    const start = Date.now();
    while (Date.now() - start < closeTimeout) {
      if (!(await modalLocator.isVisible())) return;
      const errorEl = modalLocator.locator('.ws-notice.ws-notice-error, div[role="alert"]');
      if (await errorEl.isVisible()) {
        const text = await errorEl.textContent();
        if (text?.includes('already queued or running')) {
          await waitForMailJobsIdle();
          if (await submitBtn.isEnabled()) {
            await submitBtn.click();
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await expect(modalLocator).not.toBeVisible({ timeout: 5000 });
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
      runSsh(`python3 -c "
import json, os, subprocess
p = '/var/lib/yunpanel/control-plane/mailbox-registry.json'
if os.path.exists(p):
    d = json.load(open(p))
    d['mailboxes'] = [m for m in d['mailboxes'] if not m['address'].startswith('${prefix}')]
    json.dump(d, open(p, 'w'), indent=2)
subprocess.run(['sqlite3', '/var/lib/yunpanel/mail-auth/virtual-mail.sqlite3', \\"DELETE FROM virtual_mailboxes WHERE address LIKE '${prefix}%';\\"], check=False)
" 2>/dev/null || true`);
    } catch {
      // Temizlik hatası yok sayılabilir
    }
  });

  test('mutlu yol: Mailbox CRUD, kota belirleme, parola güncelleme ve Dovecot fiziksel doğrulama', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini bul
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'webrich.news';
    fullAddress = `${localPart}@${targetDomainName}`;

    const manageBtn = localDomainRow.locator('a:has-text("Yönet")');
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    mailDomainId = urlMatch ? urlMatch[1] : '';
    expect(mailDomainId).toBeTruthy();

    // 2. Posta kutuları (Mailboxes) paneline git
    const mailboxesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxesSection).toBeVisible({ timeout: 15000 });

    // 3. Yeni e-posta hesabı (mailbox) oluştur
    await waitForMailJobsIdle();
    const createBtn = mailboxesSection.locator('button:has-text("E-posta hesabı oluştur")').first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await createBtn.click();

    const createModal = page.locator('.ws-modal', { hasText: 'E-posta hesabı oluştur' });
    await expect(createModal).toBeVisible({ timeout: 5000 });

    await createModal.locator('input[aria-label="Adres"]').fill(localPart);
    await createModal.locator('input[type="password"]').fill('YunMailP@ssw0rd2026!');
    await submitAndExpectClose(createModal, 'button[type="submit"]', 45000);

    // Tabloda yeni posta kutusu görünmeli
    const mailboxRow = mailboxesSection.locator('table.ws-table tbody tr', { hasText: fullAddress });
    await expect(mailboxRow).toBeVisible({ timeout: 15000 });
    await expect(mailboxRow.locator('span.ws-badge:has-text("Açık")')).toBeVisible({ timeout: 10000 });

    // 4. Fiziksel doğrulama 1: Dovecot/Postfix sanal posta veritabanında hesap var mı?
    const dovecotSqliteCheck1 = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT address, enabled FROM virtual_mailboxes WHERE address = '${fullAddress}';"`);
    expect(dovecotSqliteCheck1).toContain(`${fullAddress}|1`);

    const virtualMailSql1 = runSsh('cat /etc/yunpanel/mail/sql/virtual-mail.sql');
    expect(virtualMailSql1).toContain(fullAddress);

    // 5. Parola güncelleme (Password rotation)
    const passwordBtn = mailboxRow.locator('button:has-text("Parola")');
    await passwordBtn.click();

    const passwordModal = page.locator('.ws-modal', { hasText: 'E-posta parolasını değiştir' });
    await expect(passwordModal).toBeVisible({ timeout: 5000 });

    await passwordModal.locator('input[type="password"]').fill('YunNewP@ssw0rd9988!!');
    await submitAndExpectClose(passwordModal, 'button[type="submit"]', 45000);

    // Fiziksel doğrulama 2: Dovecot veritabanında hesap ve parola hash'i güncellendi
    const dovecotSqliteCheck2 = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT address, password FROM virtual_mailboxes WHERE address = '${fullAddress}';"`);
    expect(dovecotSqliteCheck2).toContain(fullAddress);
    expect(dovecotSqliteCheck2).toContain('{ARGON2ID}');

    // 6. Kota belirleme (Quota setting)
    const policyBtn = mailboxRow.locator('button:has-text("Kota ve yönlendirme")');
    await policyBtn.click();

    const policySection = page.locator('section').filter({ has: page.locator('h2', { hasText: `Mailbox policy · ${fullAddress}` }) });
    await expect(policySection).toBeVisible({ timeout: 15000 });

    const quotaInput = policySection.locator('label:has-text("Kota (MiB)") input');
    await expect(quotaInput).toBeEnabled({ timeout: 15000 });
    await quotaInput.fill('256');

    await waitForMailJobsIdle();
    const saveQuotaBtn = policySection.locator('button:has-text("Kotayı kaydet")');
    await expect(saveQuotaBtn).toBeEnabled({ timeout: 10000 });
    await saveQuotaBtn.click();

    await expect(policySection.locator('p:has-text("256 MiB")')).toBeVisible({ timeout: 45000 });

    // Fiziksel doğrulama 3: Dovecot virtual-mail.sqlite3'te quota_bytes (256 MiB = 268435456 bayt) güncellenmiş olmalı
    const dovecotSqliteCheck3 = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT quota_bytes FROM virtual_mailboxes WHERE address = '${fullAddress}';"`);
    expect(dovecotSqliteCheck3.trim()).toBe('268435456');

    // 7. Kotayı kaldır (Silme öncesi kota önkoşulunu temizle)
    const clearQuotaBtn = policySection.locator('button:has-text("Kotayı kaldır")');
    await expect(clearQuotaBtn).toBeVisible({ timeout: 10000 });
    await clearQuotaBtn.click();

    const clearQuotaModal = page.locator('.ws-modal', { hasText: 'Mailbox quota policy kaldır' });
    await expect(clearQuotaModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(clearQuotaModal);
    await expect(clearQuotaModal).not.toBeVisible({ timeout: 45000 });

    // Fiziksel doğrulama 4: Dovecot veritabanında kota NULL olmalı
    const dovecotSqliteCheck4 = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT quota_bytes FROM virtual_mailboxes WHERE address = '${fullAddress}';"`);
    expect(dovecotSqliteCheck4.trim()).toBe('');

    // 8. Mailbox silme (Silme akışı: Kapatma -> Yedek -> Veri Silme -> Kayıt Kaldırma)
    const deleteBtn = mailboxRow.locator('button:has-text("Sil…")');
    await expect(deleteBtn).toBeVisible({ timeout: 10000 });
    await deleteBtn.click();

    const removalSection = page.locator('section').filter({ has: page.locator('h2', { hasText: `Posta hesabını sil: ${fullAddress}` }) });
    await expect(removalSection).toBeVisible({ timeout: 15000 });

    // Adım 8a: MailboxAccessPreparation - Hesabı kapat
    const disableBtn = removalSection.locator('button:has-text("Hesabı kapat…")');
    if (await disableBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await disableBtn.click();
      const disableModal = page.locator('.ws-modal', { hasText: 'Yalnız seçilen hesabı kapat' });
      await expect(disableModal).toBeVisible({ timeout: 5000 });
      await fillAndConfirm(disableModal);
      await expect(disableModal).not.toBeVisible({ timeout: 40000 });

      // Değişikliği sunucuya uygula
      await waitForMailJobsIdle();
      const applyBtn = removalSection.locator('button:has-text("Değişikliği sunucuya uygula…")');
      await expect(applyBtn).toBeEnabled({ timeout: 15000 });
      await applyBtn.click();

      const applyModal = page.locator('.ws-modal', { hasText: 'Hesap değişikliğini uygula' });
      await expect(applyModal).toBeVisible({ timeout: 5000 });
      await fillAndConfirm(applyModal);
      await expect(applyModal).not.toBeVisible({ timeout: 45000 });
    }

    // Adım 8b: Yedek hazırla
    await waitForMailJobsIdle();
    const backupBtn = removalSection.locator('button:has-text("Yedeği hazırla"), button:has-text("1. Yedeği hazırla")');
    await expect(backupBtn).toBeEnabled({ timeout: 25000 });
    await backupBtn.click();

    const backupModal = page.locator('.ws-modal', { hasText: 'Silmeden önce yedekle' });
    await expect(backupModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(backupModal);
    await expect(backupModal).not.toBeVisible({ timeout: 45000 });

    // Adım 8c: Posta verisini sil
    await waitForMailJobsIdle();
    const deleteDataBtn = removalSection.locator('button:has-text("2. Posta verisini sil…")');
    await expect(deleteDataBtn).toBeEnabled({ timeout: 35000 });
    await deleteDataBtn.click();

    const deleteDataModal = page.locator('.ws-modal', { hasText: 'Posta verisini sil' });
    await expect(deleteDataModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(deleteDataModal);
    await expect(deleteDataModal).not.toBeVisible({ timeout: 45000 });

    // Adım 8d: Hesap kaydını kaldır
    await waitForMailJobsIdle();
    const finalizeBtn = removalSection.locator('button:has-text("3. Hesap kaydını kaldır…")');
    await expect(finalizeBtn).toBeEnabled({ timeout: 35000 });
    await finalizeBtn.click();

    const finalizeModal = page.locator('.ws-modal', { hasText: 'Posta hesabını kaldır' });
    await expect(finalizeModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(finalizeModal);
    await expect(finalizeModal).not.toBeVisible({ timeout: 45000 });

    // Sonuç bildirimini bekle
    await expect(removalSection.locator('p[role="status"]:has-text("hesap kaydı kaldırıldı")')).toBeVisible({ timeout: 25000 });

    // Posta kutularına dön
    const returnBtn = removalSection.locator('button:has-text("Posta kutularına dön")');
    await returnBtn.click();

    // Tabloda posta kutusu artık listelenmemeli
    await expect(mailboxesSection.locator('table.ws-table tbody tr', { hasText: fullAddress })).not.toBeVisible({ timeout: 15000 });

    // Fiziksel doğrulama 5: Dovecot/Postfix veritabanında hesap silinmiş olmalı
    const dovecotSqliteCheck5 = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT address FROM virtual_mailboxes WHERE address = '${fullAddress}';"`);
    expect(dovecotSqliteCheck5.trim()).toBe('');
  });

  test('hatalı girdi: geçersiz e-posta formatı reddedilir ve hesap oluşturulmaz', async ({ page }) => {
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const manageBtn = localDomainRow.locator('a:has-text("Yönet")');
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const mailboxesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxesSection).toBeVisible({ timeout: 15000 });

    const createBtn = mailboxesSection.locator('button:has-text("E-posta hesabı oluştur")').first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await createBtn.click();

    const createModal = page.locator('.ws-modal', { hasText: 'E-posta hesabı oluştur' });
    await expect(createModal).toBeVisible({ timeout: 5000 });

    // Geçersiz ardışık nokta içeren yerel kısım (RFC & YunPanel kuralı: local part contains unsupported characters)
    const invalidLocalPart = `invalid..box${Date.now().toString().slice(-4)}`;
    await createModal.locator('input[aria-label="Adres"]').fill(invalidLocalPart);
    await createModal.locator('input[type="password"]').fill('ValidPassword2026!');
    const submitBtn = createModal.locator('button[type="submit"]');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // Hata bildirimi modal içerisinde görünmeli ve modal açık kalmalı
    const errorNotice = createModal.locator('.ws-notice.ws-notice-error, div[role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 15000 });
    const errorText = await errorNotice.textContent();
    expect(errorText).toBeTruthy();

    // Modal vazgeçilerek kapatılır
    await createModal.locator('button:has-text("Vazgeç")').click();
    await expect(createModal).not.toBeVisible({ timeout: 5000 });

    // Tabloda geçersiz hesap bulunmamalı
    await expect(mailboxesSection.locator('table.ws-table tbody tr', { hasText: invalidLocalPart })).not.toBeVisible();
  });
});
