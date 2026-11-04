import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('EML-02 Alias, forwarding ve yerel kopya tercihleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `teml02-a${agentN}-${Date.now().toString(36)}`;
  const aliasLocalPart = `${prefix}-al`;
  const srcMailboxLocalPart = `${prefix}-src`;
  const dstMailboxLocalPart = `${prefix}-dst`;
  let createdSite = null;
  let targetDomainName = '';
  let fullAliasAddress = '';
  let fullSrcMailboxAddress = '';
  let fullDstMailboxAddress = '';
  let mailDomainId = '';

  function runSsh(command) {
    return execSync('ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test bash', {
      input: command,
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  async function call(page, method, path, data) {
    const session = await page.request.get('/api/auth/session');
    const token = (await session.json()).data?.csrfToken;
    const origin = page.url() ? new URL(page.url()).origin : 'https://server.cryptoraichu.website';
    const response = await page.request.fetch(`/api/panel${path}`, {
      method,
      headers: { origin, ...(method === 'GET' ? {} : { 'x-csrf-token': token }) },
      ...(data === undefined ? {} : { data }),
    });
    return { status: response.status(), body: await response.json().catch(() => null) };
  }

  async function createSite(page) {
    const name = `${prefix}.webrich.news`;
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle', exact: true })).toBeVisible({ timeout: 15000 });

    await page.getByLabel('Alan adı', { exact: true }).fill(name);
    const wwwSelect = page.getByLabel('www davranışı');
    if (await wwwSelect.isVisible().catch(() => false)) {
      await wwwSelect.selectOption('none');
    }
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();

    await expect(page.getByLabel('Site türü', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();

    await expect(page.getByLabel('DNS yönetimi', { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('local');
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('managed');

    const mailCheckbox = page.locator('label:has-text("E-posta ve Webmail etkinleştir") input[type="checkbox"]');
    if (await mailCheckbox.count()) {
      if (!(await mailCheckbox.isChecked())) {
        await mailCheckbox.check();
      }
    }

    const submitBtn = page.getByRole('button', { name: 'Siteyi oluştur', exact: true });
    await expect(submitBtn).toBeVisible({ timeout: 15000 });
    await expect(submitBtn).toBeEnabled({ timeout: 15000 });

    const responsePromise = page.waitForResponse((response) => response.url().includes('/api/panel/sites')
      && response.request().method() === 'POST'
      && !response.url().includes('create-preview'));

    await submitBtn.click();
    const response = await responsePromise;
    expect(response.status()).toBe(201);
    const result = (await response.json()).data;
    const site = {
      domainId: result.primaryDomain.id,
      websiteId: result.website.id,
      hostname: result.primaryDomain.primaryDomain || name,
      operationId: result.operationId,
    };
    await expect(page.locator('.ws-site-create-result')).toBeVisible({ timeout: 60000 });

    let lastUpdate = null;
    let idlePolls = 0;
    await expect.poll(async () => {
      try {
        const provRes = await page.request.get(`/api/panel/sites/provisioning/${site.operationId}`);
        if (!provRes.ok()) return false;
        const op = (await provRes.json()).data;
        if (op.ready) return true;
        idlePolls = op.updatedAt === lastUpdate ? idlePolls + 1 : 0;
        lastUpdate = op.updatedAt;
        if (idlePolls >= 3) {
          idlePolls = 0;
          await call(page, 'POST', `/sites/provisioning/${site.operationId}/continue`, {
            confirmation: `continue-site-provisioning:${site.operationId}`,
          });
        }
      } catch (err) {
        if (!/socket hang up|ECONNRESET|fetch failed/i.test(String(err?.message))) throw err;
      }
      return false;
    }, { timeout: 240000, intervals: [3000] }).toBe(true);

    const mailRes = await page.request.get('/api/panel/mail-domains');
    const mailBody = await mailRes.json();
    const mailDomains = Array.isArray(mailBody.data) ? mailBody.data : (mailBody.data?.mailDomains || []);
    const found = mailDomains.find((m) => m.webDomainId === site.domainId || m.domainName === site.hostname);
    expect(found).toBeTruthy();
    site.mailDomainId = found.id;
    console.log('CREATE_SITE_DONE:', site);
    return site;
  }

  async function removeSite(page, site) {
    if (!site || !site.domainId) return;
    try {
      for (let round = 0; round < 30; round++) {
        const current = await page.request.get(`/api/panel/domains/${site.domainId}`);
        if (current.status() === 404) break;
        await page.goto(`/websites/${site.domainId}/settings`);
        const start = page.getByRole('button', { name: /^(Siteyi sil…|Silme işlemine devam et…)$/ });
        try {
          await expect(start).toBeVisible({ timeout: 15000 });
          await start.click();
        } catch {
          await page.waitForTimeout(3000);
          continue;
        }
        const dialog = page.getByRole('dialog');
        if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
          const input = dialog.locator('input');
          if (await input.isVisible().catch(() => false)) {
            await input.fill(site.hostname);
          }
          const confirmBtn = dialog.getByRole('button', { name: /^(Silme işlemini başlat|Silme işlemine devam et)$/ });
          if (await confirmBtn.isVisible().catch(() => false)) {
            await confirmBtn.click();
          }
        }
        await page.waitForTimeout(6000);
      }
    } catch (err) {
      console.warn('removeSite notice:', err.message);
    }
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

  test.afterAll(async ({ browser }) => {
    test.setTimeout(300000);
    if (createdSite) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeSite(page, createdSite);
      } finally {
        await page.close().catch(() => {});
      }
    }
  });

  test('mutlu yol: Email alias ekleme/düzenleme/silme, forwarding yapılandırma ve yerel kopya saklama tercihi', async ({ page }) => {
    // 1. Kendi test sitemizi oluştur ve yerel mail domainini al
    createdSite = await createSite(page);
    targetDomainName = createdSite.hostname;
    mailDomainId = createdSite.mailDomainId;
    expect(mailDomainId).toBeTruthy();

    fullAliasAddress = `${aliasLocalPart}@${targetDomainName}`;
    fullSrcMailboxAddress = `${srcMailboxLocalPart}@${targetDomainName}`;
    fullDstMailboxAddress = `${dstMailboxLocalPart}@${targetDomainName}`;

    // Mail alan adı detay sayfasına git
    await page.goto(`/mail/${mailDomainId}`);
    await page.waitForURL(new RegExp(`/mail/${mailDomainId}`), { timeout: 15000 });

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

    async function saveForwardingAndVerify(expectedRevText) {
      for (let attempt = 0; attempt < 10; attempt++) {
        await expect(saveForwardingBtn).toBeEnabled({ timeout: 15000 });
        await saveForwardingBtn.click();
        const conflictAlert = policySection.locator('.ws-notice.ws-notice-error, div[role="alert"]').filter({ hasText: 'Site yedekleme' });
        if (await conflictAlert.isVisible({ timeout: 3000 }).catch(() => false)) {
          await expect(conflictAlert).not.toBeVisible({ timeout: 60000 });
          continue;
        }
        try {
          await expect(policySection.locator(`p.ws-muted:has-text("${expectedRevText}")`)).toBeVisible({ timeout: 15000 });
          await expect(saveForwardingBtn).toBeEnabled({ timeout: 15000 });
          return;
        } catch (e) {
          if (attempt === 9) throw e;
        }
      }
    }

    await saveForwardingAndVerify('rev 1');

    // Fiziksel Doğrulama 4: Dovecot Sieve dosyasında redirect :copy ve keep kontrolü
    const sieveAfterCopy = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterCopy).toContain(`if envelope :is "to" "${fullSrcMailboxAddress}"`);
    expect(sieveAfterCopy).toContain(`redirect :copy "${fullDstMailboxAddress}";`);
    expect(sieveAfterCopy).toContain('keep;');

    // Mode 2: Yalnızca yönlendir / yerel kopya saklamadan iletme ("Yalnız yönlendir" - redirect)
    await modeSelect.selectOption('redirect');
    await saveForwardingAndVerify('rev 2');

    // Fiziksel Doğrulama 5: Dovecot Sieve dosyasında :copy OLMADAN doğrudan redirect kontrolü
    const sieveAfterRedirect = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterRedirect).toContain(`if envelope :is "to" "${fullSrcMailboxAddress}"`);
    expect(sieveAfterRedirect).toContain(`redirect "${fullDstMailboxAddress}";`);
    expect(sieveAfterRedirect).not.toContain(`redirect :copy "${fullDstMailboxAddress}";`);

    // Forwarding kaldırma
    const clearFwdBtn = fwdForm.locator('button:has-text("Yönlendirmeyi kaldır")');
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(clearFwdBtn).toBeVisible({ timeout: 10000 });
      await clearFwdBtn.click();

      const clearFwdModal = page.locator('.ws-modal', { hasText: 'Mailbox forwarding policy kaldır' });
      await expect(clearFwdModal).toBeVisible({ timeout: 5000 });
      await fillAndConfirm(clearFwdModal, 'Forwarding policy kaldır');
      await expect(clearFwdModal).not.toBeVisible({ timeout: 45000 });

      const conflictAlert = policySection.locator('.ws-notice.ws-notice-error, div[role="alert"]').filter({ hasText: 'Site yedekleme' });
      if (await conflictAlert.isVisible({ timeout: 3000 }).catch(() => false)) {
        await expect(conflictAlert).not.toBeVisible({ timeout: 60000 });
        continue;
      }
      break;
    }

    await expect(fwdForm.locator('p:has-text("Mevcut: Yapılandırılmadı")')).toBeVisible({ timeout: 35000 });

    // Fiziksel Doğrulama 6: Dovecot Sieve dosyasında bu adres artık bulunmamalı
    const sieveAfterClear = runSsh('cat /etc/dovecot/yunpanel-forwarding.sieve');
    expect(sieveAfterClear).not.toContain(fullSrcMailboxAddress);
  });

  test('hatalı girdi: döngüsel/kendine yönlendirme reddedilir', async ({ page }) => {
    expect(createdSite).toBeTruthy();
    await page.goto(`/mail/${mailDomainId}`);
    await page.waitForURL(new RegExp(`/mail/${mailDomainId}`), { timeout: 15000 });

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
