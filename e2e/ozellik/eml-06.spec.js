import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('EML-06 Domain mail aç/kapat, harici mail ve bulunmayan alıcı politikası', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `teml06-a${agentN}-${Date.now().toString(36)}`;
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

  test.afterAll(async () => {
    // 0 Artık ilkesi: Test sırasında açılan harici mail domain kaydını temizle ve yerel domainin enabled olduğundan emin ol
    try {
      if (externalMailDomainId || externalDomainName) {
        runSsh(`node -e "
          const fs = require('fs');
          const p = '/var/lib/yunpanel/control-plane/mail-domain-registry.json';
          if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            data.mailDomains = (data.mailDomains || []).filter(m => m.id !== '${externalMailDomainId}' && m.domainName !== '${externalDomainName}');
            fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\\n');
          }
        " 2>/dev/null || true`);
        // API in-memory senkronizasyonu için servisi sessizce yeniden başlat
        runSsh('systemctl restart yunpanel-api');
      }

      // Yerel domainin her durumda enabled kaldığından emin ol
      if (localDomainName) {
        runSsh(`node -e "
          const fs = require('fs');
          const p = '/var/lib/yunpanel/control-plane/mail-domain-registry.json';
          if (fs.existsSync(p)) {
            const data = JSON.parse(fs.readFileSync(p, 'utf8'));
            const item = (data.mailDomains || []).find(m => m.domainName === '${localDomainName}');
            if (item && item.status !== 'enabled') {
              item.status = 'enabled';
              fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\\n');
            }
          }
          const { execSync } = require('child_process');
          try {
            execSync(\\"sqlite3 /var/lib/yunpanel/mail-auth/virtual-mail.sqlite3 \\\\\\"INSERT OR REPLACE INTO virtual_domains(domain, enabled) VALUES ('${localDomainName}', 1);\\\\\\"\\");
          } catch {}
        " 2>/dev/null || true`);
      }
    } catch {
      // Temizlik adımı
    }
  });

  test('mutlu yol 1: Harici posta sağlayıcısı (external) ile mail domain oluşturma, UI gösterimi ve fiziksel Postfix izolasyonunun doğrulanması', async ({ page, request }) => {
    // 1. Mail sayfasına git
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    // Mevcut kayıtlı mail alan adlarını doğrulanmış sayfa oturumuyla al
    const res = await page.request.get('/api/panel/mail-domains');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const existingDomains = Array.isArray(body) ? body : body.data || body.items || [];
    const trackedNames = new Set(existingDomains.map((d) => d.domainName));
    console.log('TRACKED_MAIL_DOMAINS_COUNT:', trackedNames.size);

    // Mail alan adı ekle butonuna tıkla
    const addDomainBtn = page.locator('button:has-text("Mail alan adı ekle")').first();
    await expect(addDomainBtn).toBeVisible({ timeout: 10000 });
    await addDomainBtn.click();

    // Modal açıldığını doğrula
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Posta alan adı ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Henüz mail domain'i olmayan bir üst alan adı seç
    const domainSelect = modal.locator('label:has-text("Alan adı") select');
    await expect(domainSelect).toBeVisible({ timeout: 10000 });
    await expect(domainSelect.locator('option')).not.toHaveCount(0, { timeout: 15000 });

    const options = await domainSelect.locator('option').all();
    let chosenValue = null;
    for (const opt of options) {
      const val = await opt.getAttribute('value');
      const txt = (await opt.textContent())?.trim() || '';
      if (val && txt && !trackedNames.has(txt)) {
        chosenValue = val;
        externalDomainName = txt;
        break;
      }
    }
    expect(chosenValue).toBeTruthy();
    expect(externalDomainName).toBeTruthy();
    console.log('CHOSEN_EXTERNAL_DOMAIN:', externalDomainName, 'ID:', chosenValue);

    await domainSelect.selectOption(chosenValue);

    // Yönetim modunu "Harici posta sağlayıcısı" olarak ayarla
    const modeSelect = modal.locator('label:has-text("Yönetim modu") select');
    await modeSelect.selectOption('external');

    // Posta hizmetini oluştur
    const submitBtn = modal.locator('button[type="submit"]:has-text("Posta hizmetini oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 10000 });
    await submitBtn.click();

    // İstek sonucunu bekle ve hata varsa logla
    const alertEl = modal.locator('[role="alert"]');
    try {
      await expect(modal).not.toBeVisible({ timeout: 15000 });
    } catch (err) {
      if (await alertEl.isVisible().catch(() => false)) {
        const alertMsg = await alertEl.textContent();
        console.error('MODAL_ALERT_FOUND:', alertMsg);
      }
      throw err;
    }

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
    // 1. Mail sayfasına git ve yerel mail alan adını bul
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    localDomainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';

    // Detay sayfasına geç
    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    localMailDomainId = urlMatch ? urlMatch[1] : '';
    expect(localMailDomainId).toBeTruthy();

    // 2. "Yapılandırma" sekmesine git
    const configTab = page.locator('.ws-tabs a:has-text("Yapılandırma")');
    await expect(configTab).toBeVisible({ timeout: 10000 });
    await configTab.click();
    await page.waitForURL(/section=configuration/, { timeout: 10000 });

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
    // Sayfayı yeniden yükle ki güncel revision ve status (disabled) temizce yüklensin
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
    // Plesk Parity Gereksinimi EML-06:
    // Plesk'te alan adı bazında "Mail Settings" -> "What to do with mail for non-existent users" seçenekleri bulunur:
    // 1. Bounce with message (Geri çevir - 550 hata kodu ile)
    // 2. Forward to address (Catch-all - tanımlı olmayan tüm postaları belirli bir adrese yönlendir)
    // 3. Reject (Gelen postayı sessizce/doğrudan reddet)
    test.fail(
      true,
      'BULGU EML-06: Plesk Mail Settings eşdeğeri bulunmayan alıcı politikası (Catch-all / Bounce / Reject) arayüzü ve backend konfigürasyonu eksik.',
    );

    await page.goto(`/mail/${encodeURIComponent(localMailDomainId || 'c46068e1-82f3-4956-aa3f-f1e04d7ff9ee')}?section=configuration`);
    await expect(page.locator('h2:has-text("Host mail configuration")')).toBeVisible({ timeout: 15000 });

    // Panelde Catch-all veya bulunmayan alıcı tercihi (Bounce / Reject / Forward) form kontrolü aranır
    const catchAllSelector = page.locator('label:has-text("Bulunmayan alıcı"), label:has-text("Catch-all"), label:has-text("Non-existent"), select[name="nonExistentPolicy"]');
    await expect(catchAllSelector).toBeVisible({ timeout: 3000 });
  });
});
