import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('EML-06 Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `teml06-a${agentN}-${Date.now().toString(36)}`;
  let externalSite = null;
  let localSite = null;
  let externalMailDomainId = '';
  let externalDomainName = '';
  let localMailDomainId = '';
  let localDomainName = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    });
  }

  async function getApiHeaders(page) {
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: 'https://server.cryptoraichu.website',
      'x-csrf-token': csrf,
    };
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

  async function createSite(page, suffix, mailEnabled = false) {
    const name = `${prefix}-${suffix}.webrich.news`;
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
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption(mailEnabled ? 'managed' : 'off');

    const mailCheckbox = page.locator('label:has-text("E-posta ve Webmail etkinleştir") input[type="checkbox"]');
    if (await mailCheckbox.count()) {
      if (mailEnabled) {
        if (!(await mailCheckbox.isChecked())) await mailCheckbox.check();
      } else {
        if (await mailCheckbox.isChecked()) await mailCheckbox.uncheck();
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

    if (mailEnabled) {
      const mailRes = await page.request.get('/api/panel/mail-domains');
      const mailBody = await mailRes.json();
      const mailDomains = Array.isArray(mailBody.data) ? mailBody.data : (mailBody.data?.mailDomains || []);
      const found = mailDomains.find((m) => m.webDomainId === site.domainId || m.domainName === site.hostname);
      expect(found).toBeTruthy();
      site.mailDomainId = found.id;
    }
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

  async function waitForMailJobsIdle(timeoutMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const count = runSsh(`python3 -c "
import json, os
p = '/var/lib/yunpanel/control-plane/job-registry.json'
if not os.path.exists(p):
    print(0)
    exit()
d = json.load(open(p))
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

  async function fillAndConfirm(modalLocator, confirmButtonSelector = 'button:has-text("Mail config apply")') {
    const code = (await modalLocator.locator('label strong').textContent())?.trim();
    if (code) {
      await modalLocator.locator('label input').fill(code);
    }
    await waitForMailJobsIdle();
    const btn = modalLocator.locator(confirmButtonSelector);
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
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      if (externalSite) await removeSite(page, externalSite);
      if (localSite) await removeSite(page, localSite);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol 1: Harici posta sağlayıcısı (external) ile mail domain oluşturma, UI gösterimi ve fiziksel Postfix izolasyonunun doğrulanması', async ({ page }) => {
    // 1. Harici posta testi için e-posta kapalı bir test sitesi oluştur
    externalSite = await createSite(page, 'ext', false);
    externalDomainName = externalSite.hostname;

    // 2. Mail sayfasına git
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    // Mail alan adı ekle butonuna tıkla
    const addDomainBtn = page.locator('button:has-text("Mail alan adı ekle")').first();
    await expect(addDomainBtn).toBeVisible({ timeout: 10000 });
    await addDomainBtn.click();

    // Modal açıldığını doğrula
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Posta alan adı ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Oluşturduğumuz external test alan adını seç
    const domainSelect = modal.locator('label:has-text("Alan adı") select');
    await expect(domainSelect).toBeVisible({ timeout: 10000 });
    await expect(domainSelect.locator('option')).not.toHaveCount(0, { timeout: 15000 });

    const options = await domainSelect.locator('option').all();
    let chosenValue = null;
    for (const opt of options) {
      const val = await opt.getAttribute('value');
      const txt = (await opt.textContent())?.trim() || '';
      if (txt === externalDomainName || val === externalSite.domainId) {
        chosenValue = val;
        break;
      }
    }
    expect(chosenValue).toBeTruthy();
    await domainSelect.selectOption(chosenValue);

    // Yönetim modunu "Harici posta sağlayıcısı" olarak ayarla
    const modeSelect = modal.locator('label:has-text("Yönetim modu") select');
    await modeSelect.selectOption('external');

    // Posta hizmetini oluştur
    const submitBtn = modal.locator('button[type="submit"]:has-text("Posta hizmetini oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 10000 });
    await submitBtn.click();

    // Modal kapanmalı
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    // Detay sayfasına geçişi bekle
    await page.waitForURL((url) => url.pathname.startsWith('/mail/') && url.pathname.length > 6, { timeout: 20000 });
    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    externalMailDomainId = urlMatch ? urlMatch[1] : '';
    expect(externalMailDomainId).toBeTruthy();

    // UI Doğrulaması: "Harici sağlayıcı" rozeti ve yerel mailbox sekmelerinin olmadığı teyit edilir
    await expect(page.locator('.ws-site-meta:has-text("Harici sağlayıcı")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('h2:has-text("Harici mail sağlayıcısı"), h3:has-text("Harici mail sağlayıcısı")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Posta hesapları harici sağlayıcıda yönetiliyor')).toBeVisible({ timeout: 10000 });

    // Yerel yönetim sekmelerinin (Posta kutuları, Takma adlar vb.) DOM'da sunulmadığını doğrula
    await expect(page.locator('.ws-tabs a:has-text("Posta kutuları")')).not.toBeVisible();
    await expect(page.locator('.ws-tabs a:has-text("Yapılandırma")')).not.toBeVisible();

    // Fiziksel Sonuç Doğrulaması: Harici alan adı SQLite / Postfix virtual_domains tablosuna ASLA yazılmaz
    const virtualDomainCount = runSsh(
      `sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT count(*) FROM virtual_domains WHERE domain = '${externalDomainName}';"`
    ).trim();
    expect(virtualDomainCount).toBe('0');
  });

  test('mutlu yol 2: Yerel mail alan adında posta servisini açma/kapatma (Activate/Suspend/Deactivate) ve fiziksel virtual_domains yansıması', async ({ page }) => {
    // 1. Yerel posta testi için e-posta kapalı bir test sitesi oluştur
    localSite = await createSite(page, 'loc', false);
    localDomainName = localSite.hostname;

    // 2. Mail sayfasına git ve bu site için yerel posta hizmetini ekle
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const addDomainBtn = page.locator('button:has-text("Mail alan adı ekle")').first();
    await expect(addDomainBtn).toBeVisible({ timeout: 10000 });
    await addDomainBtn.click();

    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Posta alan adı ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    const domainSelect = modal.locator('label:has-text("Alan adı") select');
    await expect(domainSelect).toBeVisible({ timeout: 10000 });
    await expect(domainSelect.locator('option')).not.toHaveCount(0, { timeout: 15000 });

    const options = await domainSelect.locator('option').all();
    let chosenValue = null;
    for (const opt of options) {
      const val = await opt.getAttribute('value');
      const txt = (await opt.textContent())?.trim() || '';
      if (txt === localDomainName || val === localSite.domainId) {
        chosenValue = val;
        break;
      }
    }
    expect(chosenValue).toBeTruthy();
    await domainSelect.selectOption(chosenValue);

    const modeSelect = modal.locator('label:has-text("Yönetim modu") select');
    await modeSelect.selectOption('local');

    const submitBtn = modal.locator('button[type="submit"]:has-text("Posta hizmetini oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 10000 });
    await submitBtn.click();

    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await page.waitForURL((url) => url.pathname.startsWith('/mail/') && url.pathname.length > 6, { timeout: 20000 });
    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    localMailDomainId = urlMatch ? urlMatch[1] : '';
    expect(localMailDomainId).toBeTruthy();

    // 3. Doğrudan bu yerel mail alan adının "Yapılandırma" sekmesine git
    await page.goto(`/mail/${localMailDomainId}?section=configuration`);
    await page.waitForURL(/section=configuration/, { timeout: 15000 });

    // Host mail configuration panelini doğrula
    await expect(page.locator('h2:has-text("Host mail configuration")')).toBeVisible({ timeout: 15000 });

    // 3. Posta servisini kapatma (Deactivate / Disabled) testi
    const targetStatusSelect = page.locator('label:has-text("Hedef durum") select');
    await expect(targetStatusSelect).toBeVisible({ timeout: 10000 });
    await targetStatusSelect.selectOption('disabled');

    // Preview oluştur
    const previewBtn = page.locator('button:has-text("Preview oluştur")');
    await expect(previewBtn).toBeEnabled({ timeout: 10000 });
    await previewBtn.click();

    // Preview ayrıntılarının geldiğini doğrula
    await expect(page.locator('dl dt:has-text("Hedef durum") + dd:has-text("disabled")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=apply edilebilir').first()).toBeVisible({ timeout: 15000 });

    // Preview'ı uygula
    const applyPreviewBtn = page.locator('button:has-text("Bu preview’ı apply et")');
    await expect(applyPreviewBtn).toBeEnabled({ timeout: 10000 });
    await applyPreviewBtn.click();

    // Onay modalını doldur ve gönder
    const confirmModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Mail host konfigürasyonunu uygula' });
    await expect(confirmModal).toBeVisible({ timeout: 10000 });
    await fillAndConfirm(confirmModal);

    // Job kuyruğa alındı bildirimini ve job tamamlanmasını bekle
    await expect(page.locator('text=Mail configuration işi kuyruğa alındı')).toBeVisible({ timeout: 20000 });
    await waitForMailJobsIdle();

    // Fiziksel Sonuç Doğrulaması 1: Alan adı virtual_domains tablosunda devre dışı kalmıştır
    const disabledCount = runSsh(
      `sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT count(*) FROM virtual_domains WHERE domain = '${localDomainName}' AND enabled = 1;"`
    ).trim();
    expect(disabledCount).toBe('0');

    // 4. Posta servisini tekrar açma (Re-activate / Enabled) testi
    await page.reload();
    await expect(page.locator('h2:has-text("Host mail configuration")')).toBeVisible({ timeout: 15000 });

    const reTargetStatusSelect = page.locator('label:has-text("Hedef durum") select');
    await expect(reTargetStatusSelect).toBeVisible({ timeout: 10000 });
    await reTargetStatusSelect.selectOption('enabled');

    const rePreviewBtn = page.locator('button:has-text("Preview oluştur")');
    await expect(rePreviewBtn).toBeEnabled({ timeout: 10000 });
    await rePreviewBtn.click();

    await expect(page.locator('dl dt:has-text("Hedef durum") + dd:has-text("enabled")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=apply edilebilir').first()).toBeVisible({ timeout: 15000 });

    const reApplyPreviewBtn = page.locator('button:has-text("Bu preview’ı apply et")');
    await expect(reApplyPreviewBtn).toBeEnabled({ timeout: 10000 });
    await reApplyPreviewBtn.click();

    await expect(confirmModal).toBeVisible({ timeout: 10000 });
    await fillAndConfirm(confirmModal);

    await expect(page.locator('text=Mail configuration işi kuyruğa alındı')).toBeVisible({ timeout: 20000 });
    await waitForMailJobsIdle();

    // Fiziksel Sonuç Doğrulaması 2: Alan adı virtual_domains tablosunda tekrar enabled = 1 olmuştur
    const enabledCount = runSsh(
      `sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 "SELECT count(*) FROM virtual_domains WHERE domain = '${localDomainName}' AND enabled = 1;"`
    ).trim();
    expect(enabledCount).toBe('1');
  });

  test('hatalı girdi ve sınır durumları: Harici yönetilen alan adında yerel konfigürasyon reddedilir ve yetkisiz/geçersiz durum geçişleri engellenir', async ({ page }) => {
    expect(externalMailDomainId).toBeTruthy();

    const headers = await getApiHeaders(page);

    // 1. Harici bir alan adı için doğrudan konfigürasyon preview istenirse 409 mail_domain_not_locally_managed döner
    const extPreviewRes = await page.request.post(`/api/panel/mail-domains/${encodeURIComponent(externalMailDomainId)}/config-preview`, {
      headers,
      data: {
        expectedRevision: 1,
        status: 'disabled',
      },
    });
    expect(extPreviewRes.status()).toBe(409);
    const extPreviewBody = await extPreviewRes.json().catch(() => ({}));
    expect(extPreviewBody.code || extPreviewBody.error?.code).toBe('mail_domain_not_locally_managed');

    // 2. Olmayan bir mail domain id ile preview istendiğinde 404 mail_domain_not_found döner
    const fakePreviewRes = await page.request.post('/api/panel/mail-domains/00000000-0000-0000-0000-000000000000/config-preview', {
      headers,
      data: {
        expectedRevision: 1,
        status: 'enabled',
      },
    });
    expect(fakePreviewRes.status()).toBe(404);
    const fakePreviewBody = await fakePreviewRes.json().catch(() => ({}));
    expect(fakePreviewBody.code || fakePreviewBody.error?.code).toBe('mail_domain_not_found');

    // 3. UI üzerinde geçersiz mail URL erişimi graceful şekilde hata/yükleme bildirimi gösterir
    await page.goto('/mail/00000000-0000-0000-0000-000000000000');
    await expect(page.locator('.ws-notice-warn, [role="alert"]').or(page.locator('text=Veri alınamadı'))).toBeVisible({ timeout: 15000 });
  });

  test('Plesk Parity kontrolü: Bulunmayan alıcı politikası (Mail for non-existent users: Bounce / Reject / Forward / Catch-all)', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-06: Plesk Mail Settings eşdeğeri bulunmayan alıcı politikası (Catch-all / Bounce / Reject) arayüzü ve backend konfigürasyonu eksik.',
    );

    await page.goto(`/mail/${encodeURIComponent(localMailDomainId || 'c46068e1-82f3-4956-aa3f-f1e04d7ff9ee')}?section=configuration`);
    await expect(page.locator('h2:has-text("Host mail configuration")')).toBeVisible({ timeout: 15000 });

    const catchAllSelector = page.locator('label:has-text("Bulunmayan alıcı"), label:has-text("Catch-all"), label:has-text("Non-existent"), select[name="nonExistentPolicy"]');
    await expect(catchAllSelector).toBeVisible({ timeout: 3000 });
  });
});
