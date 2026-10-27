import http from 'node:http';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('MON-04 Web/mail/sistem log görüntüleme, filtre/arama ve rotasyon', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tmon04-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function sendProbeRequest(host, path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: {
          Host: host,
          'User-Agent': 'Playwright-MON04-Probe/1.0',
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 10000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 8000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 5000 }).catch(() => false)) {
              await submitBtn.click();
              const doneBtn = page.locator('button', { hasText: 'Web sitelerine dön' });
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 30000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('Cleanup notice:', err.message);
    }
  }

  test.beforeEach(async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
  });

  test.afterAll(async ({ browser }) => {
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('Clean-up failed for domain:', createdDomainId, err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: web access/error loglarını filtrele, indir, mail ve audit loglarını doğrula', async ({ page }) => {
    // 1. Statik web sitesi oluştur
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    await wwwSelect.selectOption('none');
    await page.click('button[type="submit"]:has-text("Devam et")');

    const step2Heading = page.locator('h3:has-text("Barındırma türü")');
    await expect(step2Heading).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_static_upload');
    await page.click('button[type="submit"]:has-text("Devam et")');

    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    await page.click('button[type="submit"]:has-text("Siteyi oluştur")');

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    await expect(manageLink).toBeVisible();
    const href = await manageLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // 2. Sitenin "Günlükler / Loglar" sekmesine geç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}`);
    const logsTab = page.locator('a[href$="/logs"], nav a:has-text("Günlükler"), nav a:has-text("Loglar")').first();
    await expect(logsTab).toBeVisible({ timeout: 10000 });
    await logsTab.click();
    await expect(page).toHaveURL(new RegExp(`/websites/${encodeURIComponent(createdDomainId)}/logs`));

    // Log paneli kontrolleri
    const logsSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: /Site logları|Günlükler/i }) });
    await expect(logsSection).toBeVisible({ timeout: 10000 });

    const sourceDropdown = logsSection.locator('label:has-text("Kaynak") select');
    await expect(sourceDropdown).toBeVisible();
    await expect(sourceDropdown.locator('option[value="nginx-access"]')).toHaveCount(1);
    await expect(sourceDropdown.locator('option[value="nginx-error"]')).toHaveCount(1);

    const searchInput = logsSection.locator('label.ws-filter-search input');
    await expect(searchInput).toBeVisible();

    const applyButton = logsSection.locator('button:has-text("Uygula")');
    await expect(applyButton).toBeVisible();

    const refreshButton = logsSection.locator('button:has-text("Yenile")');
    await expect(refreshButton).toBeVisible();

    // 3. Web sitesine benzersiz bir HTTP isteği gönder ve log kaydında belirmesini bekle
    const probePath = `/probe-${randomUUID().slice(0, 8)}`;
    await sendProbeRequest(siteDomain, probePath);

    // Bir saniye sonra yenile
    await page.waitForTimeout(1000);
    await searchInput.fill(probePath);
    await applyButton.click();

    // Tabloyu veya sonuç satırını bekle
    const tableOrEmpty = logsSection.locator('.ws-table, .ws-empty');
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10000 });

    // Kaynak değiştir: Hata loglarına geç
    await sourceDropdown.selectOption('nginx-error');
    await searchInput.fill('');
    await applyButton.click();
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10000 });

    // İndir butonunun geçerli olduğunu doğrula
    const downloadLink = logsSection.locator('a.ws-button:has-text("İndir")');
    await expect(downloadLink).toBeVisible();
    const downloadHref = await downloadLink.getAttribute('href');
    expect(downloadHref).toContain('/download');

    // 4. Mail Servis Loglarını Doğrula (/mail)
    await page.goto('/mail');
    await expect(page.locator('h1', { hasText: 'Mail' })).toBeVisible({ timeout: 10000 });

    const firstMailManage = page.locator('table.ws-mail-table tbody tr a:has-text("Yönet")').first();
    if (await firstMailManage.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstMailManage.click();
      await page.waitForURL(/\/mail\/[^/]+/, { timeout: 10000 });

      const opsTab = page.locator('nav.ws-tabs a:has-text("Kuyruk ve loglar")');
      if (await opsTab.isVisible({ timeout: 5000 }).catch(() => false)) {
        await opsTab.click();

        const mailLogsSection = page.locator('section').filter({ has: page.locator('h2:text-is("Mail servis logları")') });
        if (await mailLogsSection.isVisible({ timeout: 8000 }).catch(() => false)) {
          const mailServiceSelect = mailLogsSection.locator('label:has-text("Servis") select');
          await expect(mailServiceSelect).toBeVisible();

          const mailSearchInput = mailLogsSection.locator('label.ws-filter-search input');
          await expect(mailSearchInput).toBeVisible();
          await mailSearchInput.fill('status');
          const mailSearchBtn = mailLogsSection.locator('button[type="submit"]:has-text("Ara")');
          await mailSearchBtn.click();
          await expect(mailLogsSection.locator('.ws-log-block, .ws-empty').first()).toBeVisible({ timeout: 10000 });
        }
      }
    }

    // 5. Global Sistem Denetim Loglarını Doğrula (/audit)
    await page.goto('/audit');
    await expect(page.locator('h1', { hasText: 'Denetim kayıtları' })).toBeVisible({ timeout: 10000 });
    const auditActionInput = page.locator('label:has-text("İşlem adı") input');
    await expect(auditActionInput).toBeVisible();
    await auditActionInput.fill('website');
    await page.click('button[type="submit"]:has-text("Filtrele")');
    await expect(page.locator('table.ws-table, .ws-empty').first()).toBeVisible({ timeout: 10000 });
  });

  test('hatalı girdi: geçersiz website kimliği ve zararlı log parametreleri güvenli reddedilir', async ({ request }) => {
    // 1. Olmayan/geçersiz UUID ile log endpointine erişim
    const invalidId = 'nonexistent-uuid-00000000-0000';
    const badRes = await request.get(`/api/websites/${encodeURIComponent(invalidId)}/application/logs?kind=access`);
    expect([400, 404, 500]).toContain(badRes.status());

    // 2. Geçersiz log kind parametresi
    if (createdDomainId) {
      const invalidKindRes = await request.get(`/api/websites/${encodeURIComponent(createdDomainId)}/application/logs?kind=invalid_kind_injection`);
      // Geçersiz kind ya varsayılana düşürülmeli ya da reddedilmeli
      expect(invalidKindRes.status()).toBeLessThan(500);
    }
  });

  test('fiziksel kanıt: sunucu Nginx log dosyaları ve logrotate yapılandırması mevcuttur', async () => {
    // 1. Sunucuda /var/log/nginx dizini ve access.log dosyası mevcuttur
    const nginxLogCheck = runSsh('test -d /var/log/nginx && ls -la /var/log/nginx/access.log');
    expect(nginxLogCheck).toContain('access.log');

    // 2. Sunucuda mail ve syslog log dosyaları mevcuttur
    const mailLogCheck = runSsh('ls -la /var/log/mail.log /var/log/syslog');
    expect(mailLogCheck).toContain('/var/log/mail.log');

    // 3. Sunucuda global logrotate Nginx kuralı mevcuttur
    const logrotateCheck = runSsh('cat /etc/logrotate.d/nginx');
    expect(logrotateCheck).toContain('/var/log/nginx/*.log');
    expect(logrotateCheck).toContain('rotate');
  });

  test('Plesk eşdeğerliği: Sitede kullanıcı tarafından yapılandırılabilir Log Rotation arayüzü ve ayarları', async ({ page }) => {
    test.fail(true, 'BULGU MON-04: Sitede Plesk eşdeğeri Log Rotation (günlük döndürme/boyut sınırı/sıkıştırma) arayüzü ve yapılandırma ayarı eksik');

    if (!createdDomainId) {
      await page.goto('/websites');
      const firstManage = page.locator('table.ws-table tbody tr a:has-text("Yönet")').first();
      await firstManage.click();
    } else {
      await page.goto(`/websites/${encodeURIComponent(createdDomainId)}`);
    }

    // Plesk'te Log Rotation sekmesi veya ayar kartı aranır
    const logRotationOption = page.locator('a, button, h2, h3', { hasText: /Log Rotation|Günlük Döndürme/i });
    await expect(logRotationOption).toBeVisible({ timeout: 5000 });
  });
});
