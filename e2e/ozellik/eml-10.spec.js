import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EML-10 Giden posta limitleri, kuyruk ve teslimat tanılama', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `teml10-a${agentN}-${Date.now().toString(36)}`;
  let mailDomainId = '';
  let domainName = '';

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

  test('mutlu yol: Posta kuyruğu izleme, teslimat takibi (delivery tracking), servis logları ve fiziksel Postfix çıktısı', async ({ page }) => {
    // 1. Mail sayfasına git ve yerel mail domainini seç
    await page.goto('/mail');
    await expect(page.locator('h1:has-text("Mail")')).toBeVisible({ timeout: 15000 });

    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await expect(localDomainRow).toBeVisible({ timeout: 15000 });

    const domainNameEl = localDomainRow.locator('td strong').first();
    domainName = (await domainNameEl.textContent())?.trim() || 'yp-form.webrich.news';

    const manageLink = localDomainRow.locator('a:has-text("Yönet")');
    await manageLink.click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    const urlMatch = page.url().match(/\/mail\/([^/?]+)/);
    expect(urlMatch).not.toBeNull();
    mailDomainId = decodeURIComponent(urlMatch[1]);

    // 2. "Teslimat" sekmesine geç ve teslimat takibi panelini doğrula
    await expect(page.locator('nav.ws-tabs')).toBeVisible({ timeout: 15000 });
    const deliveryTab = page.locator('nav.ws-tabs a:has-text("Teslimat")');
    await expect(deliveryTab).toBeVisible({ timeout: 10000 });
    await deliveryTab.click();
    await expect(page).toHaveURL(new RegExp(`section=delivery`), { timeout: 10000 });

    const deliverySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Teslimat takibi' }) });
    await expect(deliverySection).toBeVisible({ timeout: 15000 });

    // Filtre formu elemanlarını doğrula: Aralık seçimi, arama alanı ve butonlar
    const rangeSelect = deliverySection.locator('select');
    await expect(rangeSelect).toBeVisible();
    await expect(rangeSelect.locator('option[value="1"]')).toHaveText('24 saat');
    await expect(rangeSelect.locator('option[value="3"]')).toHaveText('3 gün');
    await expect(rangeSelect.locator('option[value="7"]')).toHaveText('7 gün');

    const searchInput = deliverySection.locator('input[placeholder*="Adres veya kuyruk kimliği"]');
    await expect(searchInput).toBeVisible();

    const applyButton = deliverySection.locator('button:has-text("Uygula")');
    await expect(applyButton).toBeVisible();

    const refreshButton = deliverySection.locator('button:has-text("Yenile")');
    await expect(refreshButton).toBeVisible();

    // 3. "Kuyruk ve loglar" sekmesine geç ve operasyon panellerini doğrula
    const opsTab = page.locator('nav.ws-tabs a:has-text("Kuyruk ve loglar")');
    await expect(opsTab).toBeVisible({ timeout: 10000 });
    await opsTab.click();
    await expect(page).toHaveURL(new RegExp(`section=operations`), { timeout: 10000 });

    // A. Postfix mail queue paneli
    const queueSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Postfix mail queue' }) });
    await expect(queueSection).toBeVisible({ timeout: 15000 });
    await expect(queueSection.locator('input[placeholder*="queue ID, sender"]')).toBeVisible();

    // B. Mail servis logları paneli
    const logsSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail servis logları' }) });
    await expect(logsSection).toBeVisible({ timeout: 15000 });
    const serviceSelect = logsSection.locator('select');
    await expect(serviceSelect).toBeVisible();
    await expect(serviceSelect.locator('option[value="postfix"]')).toHaveText('Postfix');
    await expect(serviceSelect.locator('option[value="dovecot"]')).toHaveText('Dovecot');
    await expect(serviceSelect.locator('option[value="rspamd"]')).toHaveText('Rspamd');

    // C. Servis teslimat doğrulama testi paneli
    const testDeliverySection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Servis teslimat doğrulama testi' }) });
    await expect(testDeliverySection).toBeVisible({ timeout: 15000 });
    await expect(testDeliverySection.locator('input[placeholder="test@example.com"]')).toBeVisible();
    await expect(testDeliverySection.locator('button:has-text("Test Gönder")')).toBeVisible();

    // D. Mail servis bağlantı ve port durumu paneli
    const connSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Mail servis bağlantı ve port durumu' }) });
    await expect(connSection).toBeVisible({ timeout: 15000 });
    await expect(connSection.locator('table')).toBeVisible();

    // 4. Fiziksel kanıt kontrolü: SSH ile fiziksel postqueue sorgusu ve API doğrulaması
    const sshOutput = runSsh('postqueue -p').trim();
    // Postfix kuyruğu boş veya geçerli bir postqueue çıktısı olmalı
    expect(sshOutput.length).toBeGreaterThan(0);

    // API üzerinden mail queue yanıtı
    const queueRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/queue?limit=50`);
    expect(queueRes.status()).toBe(200);
    const queueJson = await queueRes.json();
    expect(queueJson.data).toHaveProperty('entries');
    expect(queueJson.data).toHaveProperty('summary');
    expect(typeof queueJson.data.summary.totalCount).toBe('number');

    // API üzerinden delivery logs yanıtı
    const logsRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-logs?service=postfix&limit=10`);
    expect(logsRes.status()).toBe(200);
    const logsJson = await logsRes.json();
    expect(logsJson.data).toHaveProperty('entries');
    expect(Array.isArray(logsJson.data.entries)).toBe(true);

    // API üzerinden teslimat takibi (tek sayfalık kısa zaman penceresi)
    const now = Date.now();
    const shortSince = new Date(now - 60000).toISOString();
    const shortUntil = new Date(now).toISOString();
    const trackingRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-tracking?since=${shortSince}&until=${shortUntil}&limit=50`);
    expect(trackingRes.status()).toBe(200);
    const trackingJson = await trackingRes.json();
    expect(trackingJson.data).toHaveProperty('messages');
    expect(Array.isArray(trackingJson.data.messages)).toBe(true);
    expect(trackingJson.data).toHaveProperty('range');
  });

  test('hatalı girdi: Kuyruk ve teslimat takibi API sorgularında geçersiz parametreler 400 ile reddedilir', async ({ page }) => {
    // Mail domain ID yoksa /api/panel/mail-domains'ten alalım
    if (!mailDomainId) {
      const listRes = await page.request.get('/api/panel/mail-domains');
      expect(listRes.status()).toBe(200);
      const list = await listRes.json();
      const first = (list.data || []).find((d) => d.managementMode === 'local');
      mailDomainId = first?.id;
    }
    expect(mailDomainId).toBeTruthy();

    // 1. Teslimat takibi: limit sınır dışı (250 > max 200) -> 400
    const overLimitRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-tracking?limit=250`);
    expect(overLimitRes.status()).toBe(400);
    const overLimitJson = await overLimitRes.json();
    expect(overLimitJson.error.code).toBe('invalid_delivery_tracking_query');

    // 2. Teslimat takibi: geçersiz ISO tarihi -> 400
    const invalidDateRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-tracking?since=gecersiz-tarih`);
    expect(invalidDateRes.status()).toBe(400);

    // 3. Teslimat takibi: 100 karakterden uzun arama sorgusu -> 400
    const longQuery = 'a'.repeat(101);
    const longQueryRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-tracking?q=${longQuery}`);
    expect(longQueryRes.status()).toBe(400);

    // 4. Olmayan mail alan adı için kuyruk sorgusu -> 404
    const notFoundRes = await page.request.get('/api/panel/mail-domains/00000000-0000-4000-8000-000000000000/queue');
    expect(notFoundRes.status()).toBe(404);

    // 5. Test teslimatında UI/form seviyesinde boş alıcı adresi gönderimi engellenir (required)
    await page.goto(`/mail/${encodeURIComponent(mailDomainId)}?section=operations`);
    await expect(page.locator('section').filter({ has: page.locator('h2', { hasText: 'Servis teslimat doğrulama testi' }) })).toBeVisible({ timeout: 10000 });
    const recipientInput = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Servis teslimat doğrulama testi' }) }).locator('input[placeholder="test@example.com"]');
    await expect(recipientInput).toHaveAttribute('required', '');
    const submitBtn = page.locator('button:has-text("Test Gönder")');
    await expect(submitBtn).toBeDisabled();
  });

  test('BULGU EML-10-A: Teslimat takibinde çok sayfalı journalctl log sorgusunda --since ve --cursor çakışması (503)', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-10-A: journalLogReader çok sayfalı Postfix log okumasında --since ve --cursor argümanlarını birlikte göndererek journalctl hatasına (Please specify only one of --since=, --cursor=, and --after-cursor=.) ve 503 durumuna yol açıyor'
    );

    if (!mailDomainId) {
      const listRes = await page.request.get('/api/panel/mail-domains');
      const list = await listRes.json();
      const first = (list.data || []).find((d) => d.managementMode === 'local');
      mailDomainId = first?.id;
    }

    // Varsayılan 24 saatlik aralıkta 1000'den fazla log olduğunda 200 dönmesi gerekirken 503 fırlatıyor
    const trackingRes = await page.request.get(`/api/panel/mail-domains/${mailDomainId}/delivery-tracking?limit=50`);
    expect(trackingRes.status()).toBe(200);
  });

  test('BULGU EML-10-B: Plesk Parity — Giden posta limitleri (Outbound Rate Limits) ve kuyruk boşaltma/silme (Flush/Delete)', async ({ page }) => {
    test.fail(
      true,
      'BULGU EML-10-B: Plesk eşdeğeri giden posta limitleri (Outbound Mail Control / rate limiting) ve kuyruk boşaltma/silme (Flush queue / Delete message) panelde veya API\'de henüz mevcut değil'
    );

    await page.goto('/mail');
    const localDomainRow = page.locator('table.ws-table tbody tr', { hasText: 'Bu sunucuda' }).first();
    await localDomainRow.locator('a:has-text("Yönet")').click();
    await page.waitForURL(/\/mail\/[^/?]+/, { timeout: 15000 });

    // 1. Posta kuyruğu yönetiminde mesaj silme veya kuyruğu boşaltma butonları aranır
    await expect(page.locator('nav.ws-tabs')).toBeVisible({ timeout: 15000 });
    await page.locator('nav.ws-tabs a:has-text("Kuyruk ve loglar")').click();
    const queueSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Postfix mail queue' }) });
    await expect(queueSection).toBeVisible({ timeout: 10000 });

    // Plesk'te bulunan "Flush Queue" (Kuyruğu Boşalt/Gönder) ve "Delete" (Kuyruktan Sil) butonları
    const flushBtn = queueSection.locator('button:has-text("Boşalt"), button:has-text("Flush"), button:has-text("Kuyruğu Gönder")');
    await expect(flushBtn).toBeVisible({ timeout: 3000 });

    // 2. Yapılandırma veya Alan adı ayarlarında giden posta saatlik/günlük limiti (Outbound message rate limits)
    await page.locator('nav.ws-tabs a:has-text("Yapılandırma")').click();
    const rateLimitField = page.locator('label:has-text("Giden posta limiti"), label:has-text("Outbound rate limit"), label:has-text("Saatlik limit")');
    await expect(rateLimitField).toBeVisible({ timeout: 3000 });
  });
});
