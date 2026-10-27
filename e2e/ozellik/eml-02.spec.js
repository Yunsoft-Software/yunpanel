import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('EML-02 Alias, forwarding ve yerel kopya tercihleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `teml02-a${agentN}-${Date.now().toString(36)}`;
  const aliasLocalPart = `${prefix}-al`;
  const srcMailboxLocalPart = `${prefix}-src`;
  const dstMailboxLocalPart = `${prefix}-dst`;
  let targetDomainName = '';
  let fullAliasAddress = '';
  let fullSrcMailboxAddress = '';
  let fullDstMailboxAddress = '';
  let mailDomainId = '';

  function runSsh(command) {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  async function fillAndConfirm(modalLocator, confirmButtonText) {
    const code = (await modalLocator.locator('label strong').textContent())?.trim();
    if (code) {
      await modalLocator.locator('label input').fill(code);
    }
    const btn = modalLocator.locator(`button:has-text("${confirmButtonText}")`);
    await expect(btn).toBeEnabled({ timeout: 15000 });
    await btn.click();
  }

  test.beforeAll(async () => {
    try {
      runSsh(`node -e "
        const fs = require('fs');
        const fwdPath = '/var/lib/yunpanel/control-plane/mailbox-forwarding-registry.json';
        if (fs.existsSync(fwdPath)) {
          const fwdData = JSON.parse(fs.readFileSync(fwdPath, 'utf8'));
          fwdData.forwardings = (fwdData.forwardings || []).filter(f => !f.destinations.some(d => d.includes('example.org') || d.includes('example.com') || d.startsWith('teml02')));
          fs.writeFileSync(fwdPath, JSON.stringify(fwdData, null, 2) + '\\n');
        }
        const alPath = '/var/lib/yunpanel/control-plane/mail-alias-registry.json';
        if (fs.existsSync(alPath)) {
          const alData = JSON.parse(fs.readFileSync(alPath, 'utf8'));
          alData.aliases = (alData.aliases || []).filter(a => !a.source.startsWith('teml02'));
          fs.writeFileSync(alPath, JSON.stringify(alData, null, 2) + '\\n');
        }
      " 2>/dev/null || true`);
    } catch {}
  });

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
    // Test kaynaklarını SSH ile temizle
    try {
      runSsh(`node -e "
        const fs = require('fs');
        const { execSync } = require('child_process');
        try {
          execSync(\\"sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 \\\\\\"DELETE FROM virtual_aliases WHERE source LIKE '${prefix}%'; DELETE FROM virtual_mailboxes WHERE address LIKE '${prefix}%';\\\\\\"\\");
        } catch {}
        let dirty = false;
        try {
          const mbPath = '/var/lib/yunpanel/control-plane/mailbox-registry.json';
          if (fs.existsSync(mbPath)) {
            const data = JSON.parse(fs.readFileSync(mbPath, 'utf8'));
            const initialLen = (data.mailboxes || []).length;
            data.mailboxes = (data.mailboxes || []).filter(m => !m.address.startsWith('${prefix}'));
            if (data.mailboxes.length !== initialLen) {
              fs.writeFileSync(mbPath, JSON.stringify(data, null, 2) + '\\n');
              dirty = true;
            }
          }
          const fwdPath = '/var/lib/yunpanel/control-plane/mailbox-forwarding-registry.json';
          if (fs.existsSync(fwdPath)) {
            const fwdData = JSON.parse(fs.readFileSync(fwdPath, 'utf8'));
            const initialLen = (fwdData.forwardings || []).length;
            fwdData.forwardings = (fwdData.forwardings || []).filter(f => !f.destinations.some(d => d.startsWith('${prefix}') || d.includes('example.org')));
            if (fwdData.forwardings.length !== initialLen) {
              fs.writeFileSync(fwdPath, JSON.stringify(fwdData, null, 2) + '\\n');
              dirty = true;
            }
          }
          const alPath = '/var/lib/yunpanel/control-plane/mail-alias-registry.json';
          if (fs.existsSync(alPath)) {
            const alData = JSON.parse(fs.readFileSync(alPath, 'utf8'));
            const initialLen = (alData.aliases || []).length;
            alData.aliases = (alData.aliases || []).filter(a => !a.source.startsWith('${prefix}'));
            if (alData.aliases.length !== initialLen) {
              fs.writeFileSync(alPath, JSON.stringify(alData, null, 2) + '\\n');
              dirty = true;
            }
          }
          if (dirty) {
            execSync('systemctl restart yunpanel-api');
          }
        } catch {}
      " 2>/dev/null || true`);
    } catch {
      // Temizlik hatası yok sayılabilir
    }
  });

  test('mutlu yol: Email alias ekleme/düzenleme/silme, forwarding yapılandırma ve yerel kopya saklama tercihi', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini bul
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';
    fullAliasAddress = `${aliasLocalPart}@${targetDomainName}`;
    fullSrcMailboxAddress = `${srcMailboxLocalPart}@${targetDomainName}`;
    fullDstMailboxAddress = `${dstMailboxLocalPart}@${targetDomainName}`;

    const manageBtn = localDomainRow.locator('a:has-text("Yönet")');
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    mailDomainId = urlMatch ? urlMatch[1] : '';
    expect(mailDomainId).toBeTruthy();

    // -------------------------------------------------------------
    // BÖLÜM A: ALIAS OLUŞTURMA, DÜZENLEME, DOĞRULAMA VE SİLME
    // -------------------------------------------------------------
    const aliasTab = page.locator('.ws-tabs a:has-text("Takma adlar")');
    await expect(aliasTab).toBeVisible({ timeout: 10000 });
    await aliasTab.click();

    const aliasesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail aliasları' }) });
    await expect(aliasesSection).toBeVisible({ timeout: 15000 });

    // Alias oluştur
    const createAliasBtn = aliasesSection.locator('button:has-text("Alias oluştur")').first();
    await expect(createAliasBtn).toBeVisible({ timeout: 10000 });
    await createAliasBtn.click();

    const aliasModal = page.locator('.ws-modal', { hasText: 'Alias oluştur' });
    await expect(aliasModal).toBeVisible({ timeout: 5000 });

    await aliasModal.locator('label:has-text("Kaynak adres") input').fill(aliasLocalPart);
    await aliasModal.locator('label:has-text("Hedefler") textarea').fill('dest1@example.com\ndest2@example.net');
    await aliasModal.locator('button[type="submit"]:has-text("Alias oluştur")').click();

    // Modal kapanmalı (işlem sunucuya uygulanıp onaylanana kadar beklenir)
    await expect(aliasModal).not.toBeVisible({ timeout: 45000 });

    // Tabloda yeni alias görünmeli
    const aliasRow = aliasesSection.locator('table.ws-table tbody tr', { hasText: fullAliasAddress });
    await expect(aliasRow).toBeVisible({ timeout: 15000 });
    await expect(aliasRow.locator('span.ws-badge:has-text("Açık")')).toBeVisible({ timeout: 10000 });
    await expect(aliasRow).toContainText('dest1@example.com, dest2@example.net');

    // Fiziksel Doğrulama 1: Postfix SQLite veritabanında virtual_aliases tablosu kontrolü
    const sqliteAfterAliasCreate = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT source, destinations, enabled FROM virtual_aliases WHERE source='${fullAliasAddress}';"`);
    expect(sqliteAfterAliasCreate.trim()).toBe(`${fullAliasAddress}|dest1@example.com, dest2@example.net|1`);

    // Alias Düzenleme
    const editAliasBtn = aliasRow.locator('button:has-text("Düzenle")');
    await editAliasBtn.click();

    const editModal = page.locator('.ws-modal', { hasText: 'Alias düzenle' });
    await expect(editModal).toBeVisible({ timeout: 5000 });
    await editModal.locator('label:has-text("Hedefler") textarea').fill('updated@example.org');
    await editModal.locator('button[type="submit"]:has-text("Aliası kaydet")').click();
    await expect(editModal).not.toBeVisible({ timeout: 45000 });

    // Tabloda güncellenen hedef görünmeli
    await expect(aliasRow).toContainText('updated@example.org');

    // Fiziksel Doğrulama 2: Postfix SQLite veritabanında güncellenen hedef kontrolü
    const sqliteAfterAliasEdit = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT destinations FROM virtual_aliases WHERE source='${fullAliasAddress}';"`);
    expect(sqliteAfterAliasEdit.trim()).toBe('updated@example.org');

    // Alias Silme
    const deleteAliasBtn = aliasRow.locator('button:has-text("Sil")');
    await deleteAliasBtn.click();

    const deleteAliasModal = page.locator('.ws-modal', { hasText: 'Mail aliasını sil' });
    await expect(deleteAliasModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(deleteAliasModal, 'Aliası sil');
    await expect(deleteAliasModal).not.toBeVisible({ timeout: 45000 });

    // Tabloda alias artık görünmemeli
    await expect(aliasesSection.locator('table.ws-table tbody tr', { hasText: fullAliasAddress })).not.toBeVisible({ timeout: 15000 });

    // Fiziksel Doğrulama 3: SQLite veritabanından alias silinmiş olmalı
    const sqliteAfterAliasDelete = runSsh(`sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT count(*) FROM virtual_aliases WHERE source='${fullAliasAddress}';"`);
    expect(sqliteAfterAliasDelete.trim()).toBe('0');

    // -------------------------------------------------------------
    // BÖLÜM B: MAILBOX FORWARDING & YEREL KOPYA TERCİHLERİ
    // -------------------------------------------------------------
    const mailboxesTab = page.locator('.ws-tabs a:has-text("Posta kutuları")');
    await expect(mailboxesTab).toBeVisible({ timeout: 10000 });
    await mailboxesTab.click();

    const mailboxesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'E-posta hesapları' }) });
    await expect(mailboxesSection).toBeVisible({ timeout: 15000 });

    // 1) Hedef posta kutusunu oluştur (internal forwarding hedefi)
    const createDstBtn = mailboxesSection.locator('button:has-text("E-posta hesabı oluştur")').first();
    await expect(createDstBtn).toBeVisible({ timeout: 10000 });
    await createDstBtn.click();

    const dstModal = page.locator('.ws-modal', { hasText: 'E-posta hesabı oluştur' });
    await expect(dstModal).toBeVisible({ timeout: 5000 });
    await dstModal.locator('input[aria-label="Adres"]').fill(dstMailboxLocalPart);
    await dstModal.locator('input[type="password"]').fill('YunFwdP@ssw0rd2026!');
    await dstModal.locator('button:has-text("E-posta hesabı oluştur")').click();
    await expect(dstModal).not.toBeVisible({ timeout: 45000 });

    const dstRow = mailboxesSection.locator('table.ws-table tbody tr', { hasText: fullDstMailboxAddress });
    await expect(dstRow).toBeVisible({ timeout: 15000 });

    // 2) Kaynak posta kutusunu oluştur
    await createDstBtn.click();
    const srcModal = page.locator('.ws-modal', { hasText: 'E-posta hesabı oluştur' });
    await expect(srcModal).toBeVisible({ timeout: 5000 });
    await srcModal.locator('input[aria-label="Adres"]').fill(srcMailboxLocalPart);
    await srcModal.locator('input[type="password"]').fill('YunFwdP@ssw0rd2026!');
    await srcModal.locator('button:has-text("E-posta hesabı oluştur")').click();
    await expect(srcModal).not.toBeVisible({ timeout: 45000 });

    const srcRow = mailboxesSection.locator('table.ws-table tbody tr', { hasText: fullSrcMailboxAddress });
    await expect(srcRow).toBeVisible({ timeout: 15000 });

    // "Kota ve yönlendirme" paneline gir
    const policyBtn = srcRow.locator('button:has-text("Kota ve yönlendirme")');
    await policyBtn.click();

    const policySection = page.locator('section').filter({ has: page.locator('h2', { hasText: `Mailbox policy · ${fullSrcMailboxAddress}` }) });
    await expect(policySection).toBeVisible({ timeout: 15000 });

    const fwdForm = policySection.locator('form').filter({ hasText: 'Yönlendirme biçimi' });
    await expect(fwdForm.locator('fieldset')).toBeEnabled({ timeout: 15000 });
    await expect(fwdForm.locator('p.ws-muted')).toContainText('Mevcut:', { timeout: 15000 });

    // Mode 1: Yerel kopya saklama ("Bir kopyasını ilet" - copy)
    const modeSelect = fwdForm.locator('label:has-text("Yönlendirme biçimi") select');
    await expect(modeSelect).toBeVisible({ timeout: 10000 });
    await modeSelect.selectOption('copy');

    const fwdDestInput = fwdForm.locator('label:has-text("Hedefler") textarea');
    await fwdDestInput.fill(fullDstMailboxAddress);
    await expect(fwdDestInput).toHaveValue(fullDstMailboxAddress);

    const saveForwardingBtn = fwdForm.locator('button:has-text("Yönlendirmeyi kaydet")');
    await expect(saveForwardingBtn).toBeEnabled({ timeout: 10000 });
    await saveForwardingBtn.click();

    // Revizyon 1 beklenir
    await expect(policySection.locator('p.ws-muted:has-text("rev 1")')).toBeVisible({ timeout: 45000 });
    await expect(saveForwardingBtn).toBeEnabled({ timeout: 45000 });

    // Fiziksel Doğrulama 4: Dovecot Sieve dosyasında redirect :copy ve keep kontrolü
    const sieveAfterCopy = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterCopy).toContain(`if envelope :is "to" "${fullSrcMailboxAddress}"`);
    expect(sieveAfterCopy).toContain(`redirect :copy "${fullDstMailboxAddress}";`);
    expect(sieveAfterCopy).toContain('keep;');

    // Mode 2: Yalnızca yönlendir / yerel kopya saklamadan iletme ("Yalnız yönlendir" - redirect)
    await modeSelect.selectOption('redirect');
    await expect(saveForwardingBtn).toBeEnabled({ timeout: 10000 });
    await saveForwardingBtn.click();

    // Revizyon 2 beklenir
    await expect(policySection.locator('p.ws-muted:has-text("rev 2")')).toBeVisible({ timeout: 45000 });
    await expect(saveForwardingBtn).toBeEnabled({ timeout: 45000 });

    // Fiziksel Doğrulama 5: Dovecot Sieve dosyasında :copy OLMADAN doğrudan redirect kontrolü
    const sieveAfterRedirect = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterRedirect).toContain(`if envelope :is "to" "${fullSrcMailboxAddress}"`);
    expect(sieveAfterRedirect).toContain(`redirect "${fullDstMailboxAddress}";`);
    expect(sieveAfterRedirect).not.toContain(`redirect :copy "${fullDstMailboxAddress}";`);

    // Forwarding kaldırma
    const clearFwdBtn = fwdForm.locator('button:has-text("Yönlendirmeyi kaldır")');
    await expect(clearFwdBtn).toBeVisible({ timeout: 10000 });
    await clearFwdBtn.click();

    const clearFwdModal = page.locator('.ws-modal', { hasText: 'Mailbox forwarding policy kaldır' });
    await expect(clearFwdModal).toBeVisible({ timeout: 5000 });
    await fillAndConfirm(clearFwdModal, 'Forwarding policy kaldır');
    await expect(clearFwdModal).not.toBeVisible({ timeout: 45000 });

    await expect(fwdForm.locator('p:has-text("Mevcut: Yapılandırılmadı")')).toBeVisible({ timeout: 35000 });

    // Fiziksel Doğrulama 6: Dovecot Sieve dosyasında bu adres artık bulunmamalı
    const sieveAfterClear = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterClear).not.toContain(fullSrcMailboxAddress);
  });

  test('hatalı girdi: döngüsel/kendine yönlendirme reddedilir', async ({ page }) => {
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    targetDomainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';

    const manageBtn = localDomainRow.locator('a:has-text("Yönet")');
    await manageBtn.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // 1. Alias döngüsel/kendine yönlendirme denemesi
    const aliasTab = page.locator('.ws-tabs a:has-text("Takma adlar")');
    await expect(aliasTab).toBeVisible({ timeout: 10000 });
    await aliasTab.click();

    const aliasesSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail aliasları' }) });
    await expect(aliasesSection).toBeVisible({ timeout: 15000 });

    const createAliasBtn = aliasesSection.locator('button:has-text("Alias oluştur")').first();
    await expect(createAliasBtn).toBeVisible({ timeout: 10000 });
    await createAliasBtn.click();

    const aliasModal = page.locator('.ws-modal', { hasText: 'Alias oluştur' });
    await expect(aliasModal).toBeVisible({ timeout: 5000 });

    const loopAlias = `loop-${Date.now().toString(36)}`;
    await aliasModal.locator('label:has-text("Kaynak adres") input').fill(loopAlias);
    // Kendine yönlendirilen hedef
    await aliasModal.locator('label:has-text("Hedefler") textarea').fill(`${loopAlias}@${targetDomainName}`);
    await aliasModal.locator('button[type="submit"]:has-text("Alias oluştur")').click();

    // Hata bildirimi modal içerisinde görünmeli ve modal açık kalmalı
    const errorNotice = aliasModal.locator('.ws-notice.ws-notice-error, div[role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 15000 });
    const errorText = await errorNotice.textContent();
    expect(errorText?.toLowerCase()).toMatch(/itself|cycle|döngü|geçersiz|hata/);

    await aliasModal.locator('button:has-text("Vazgeç")').click();
    await expect(aliasModal).not.toBeVisible({ timeout: 5000 });

    // Tabloda döngüsel alias bulunmamalı
    await expect(aliasesSection.locator('table.ws-table tbody tr', { hasText: `${loopAlias}@${targetDomainName}` })).not.toBeVisible();
  });
});
