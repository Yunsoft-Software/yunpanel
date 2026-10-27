import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-04 Zamanlama, rotasyon, saklama ve hariç tutmalar', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);
  const repoName = `tbak04-a${agentN}-${timestamp}-repo`;
  const targetDomainName = 'yp-node.webrich.news';

  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
  let csrfToken = '';

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

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
      const token = (await sessionRes?.json())?.data?.csrfToken || csrfToken;

      // 1. Hedef sitedeki zamanlama kaydını devre dışı bırak / temizle
      if (targetWebsiteId && token) {
        try {
          execSync(
            `ssh yunpanel-test "node -e \\"const fs=require('fs');const p='/var/lib/yunpanel/control-plane/website-backup-schedules.json';if(fs.existsSync(p)){const d=JSON.parse(fs.readFileSync(p,'utf8'));d.schedules=d.schedules.filter(s=>s.websiteId!=='${targetWebsiteId}');fs.writeFileSync(p,JSON.stringify(d,null,2));}\\""`,
            { timeout: 15000 }
          );
        } catch (cleanErr) {
          console.warn('Backup schedule remote cleanup notice:', cleanErr.message);
        }
      }

      // 2. Test amaçlı oluşturulan Restic reposunu temizle
      if (createdRepoId && token) {
        const delRes = await page.request.delete(`/api/panel/backups/repositories/${createdRepoId}`, {
          headers: {
            'x-csrf-token': token,
            Origin: 'https://server.cryptoraichu.website',
            Referer: 'https://server.cryptoraichu.website/',
          },
        }).catch(() => null);
        if (delRes && delRes.ok()) {
          console.log(`Cleaned up test restic repo: ${createdRepoId}`);
        }
      }
    } catch (err) {
      console.warn('BAK-04 cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: otomatik yedekleme zamanlaması ve saklama politikası yapılandırma, UI doğrulaması ve fiziksel schedule/exclusion kanıtı', async ({ page }) => {
    // 1. Hedef web sitesinin websiteId ve domainId bilgilerini al
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName);
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId);
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    // 2. Test amaçlı Restic yedek deposunu oluştur (11 Ekim kuralı: test amaçlı izinli, bitince temizlenir)
    const createRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: repoName,
        backend: 'local',
        password: `Pass-${timestamp}-B3kUp!`,
        initialize: true,
      },
    });
    expect(createRepoRes.status()).toBe(201);
    const repoJson = await createRepoRes.json();
    createdRepoId = repoJson.data?.id;
    expect(createdRepoId).toBeTruthy();

    // 3. Web sitesinin Yedekleme sekmesine git
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // 4. "Plan ve Zamanlama" butonunun aktif olduğunu doğrula ve tıkla
    const planBtn = page.locator('button:has-text("Plan ve Zamanlama")');
    await expect(planBtn).toBeVisible({ timeout: 15000 });
    await expect(planBtn).toBeEnabled({ timeout: 15000 });
    await planBtn.click();

    // 5. Modal açılışını doğrula
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedekleme Planı ve Saklama Politikası' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Depo seçimi (birden fazla repo varsa yeni oluşturulan depoyu seç)
    const repoSelect = modal.locator('select').first();
    if (await repoSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const options = await repoSelect.locator('option').allTextContents();
      if (options.some((opt) => opt.includes(repoName))) {
        await repoSelect.selectOption(createdRepoId);
      }
    }

    // Otomatik yedekleme onay kutusunu kontrol et
    const enabledCheckbox = modal.locator('label.ws-check input[type="checkbox"]');
    await expect(enabledCheckbox).toBeVisible({ timeout: 5000 });
    if (!(await enabledCheckbox.isChecked())) {
      await enabledCheckbox.check();
    }

    // Sıklık seçimi: "Her gün" (daily)
    const frequencySelect = modal.locator('select#backup-frequency');
    await expect(frequencySelect).toBeVisible({ timeout: 5000 });
    await frequencySelect.selectOption('daily');

    // Saat ayarı: 03:30
    const timeInput = modal.locator('input#backup-time');
    await expect(timeInput).toBeVisible({ timeout: 5000 });
    await timeInput.fill('03:30');

    // Saklama politikası (retention) sayılarını ayarla:
    // Son N Kopya: 5, Günlük: 5, Haftalık: 3
    const keepLastInput = modal.locator('label', { hasText: 'Son N Kopya' }).locator('input');
    const keepDailyInput = modal.locator('label', { hasText: 'Günlük' }).locator('input');
    const keepWeeklyInput = modal.locator('label', { hasText: 'Haftalık' }).locator('input');

    await keepLastInput.fill('5');
    await keepDailyInput.fill('5');
    await keepWeeklyInput.fill('3');

    // 6. Planı Kaydet butonuna tıkla
    const submitBtn = modal.locator('button:has-text("Planı Kaydet")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // 7. Modalin kapandığını doğrula
    await expect(modal).toBeHidden({ timeout: 15000 });

    // 8. İşlem takibi: Durable operation kartının "Başarılı" olmasını bekle
    const opSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Yedekleme ayarları' }) });
    await expect(opSection).toBeVisible({ timeout: 15000 });
    await expect(opSection.locator('.ws-badge').filter({ hasText: 'Başarılı' })).toBeVisible({ timeout: 60000 });

    const closeOpBtn = opSection.locator('button:has-text("Kapat")');
    if (await closeOpBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeOpBtn.click();
    }

    // 9. Sayfayı yenile ve genel özet kartındaki dl.ws-keyvalues içeriğinde güncellemeleri doğrula
    await page.reload();
    const summarySection = page.locator('section').filter({ hasText: 'Yedekleme ve Geri Yükleme' });
    const summaryKeyValues = summarySection.locator('dl.ws-keyvalues');
    await expect(summaryKeyValues).toContainText('Son 5 · Günlük 5 · Haftalık 3', { timeout: 15000 });
    await expect(summaryKeyValues).not.toContainText('Planlanmadı', { timeout: 10000 });

    // 10. Fiziksel kanıt 1: Panel üzerinden zamanlama ve saklama verisini doğrula
    const backupData = await page.evaluate(async (wId) => {
      const res = await fetch(`/api/panel/websites/${wId}/backups`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Backups fetch failed: ${res.status}`);
      const json = await res.json();
      return json.data;
    }, targetWebsiteId);

    expect(backupData.schedule).toBeTruthy();
    expect(backupData.schedule.enabled).toBe(true);
    expect(backupData.schedule.expression).toBe('30 3 * * *');
    expect(backupData.schedule.repositoryId).toBe(createdRepoId);
    expect(backupData.retentionPolicy).toEqual({
      keepDaily: 5,
      keepLast: 5,
      keepWeekly: 3,
    });
    expect(backupData.nextScheduledRunAt).toBeTruthy();
    const nextRunDate = new Date(backupData.nextScheduledRunAt);
    expect(nextRunDate.getTime()).toBeGreaterThan(Date.now());

    // 11. Fiziksel kanıt 2: Test sunucusundaki website-backup-schedules.json dosyasını doğrula
    const sshOutput = execSync(
      `ssh yunpanel-test "cat /var/lib/yunpanel/control-plane/website-backup-schedules.json"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    const schedulesStore = JSON.parse(sshOutput);
    const matchedSchedule = schedulesStore.schedules?.find((s) => s.websiteId === targetWebsiteId);
    expect(matchedSchedule).toBeTruthy();
    expect(matchedSchedule.expression).toBe('30 3 * * *');
    expect(matchedSchedule.retentionPolicy).toEqual({
      keepDaily: 5,
      keepLast: 5,
      keepWeekly: 3,
    });
    expect(matchedSchedule.enabled).toBe(true);

    // 12. Fiziksel kanıt 3: Hariç tutmalar (exclusions) - backup-set endpointinden excludePatterns doğrulaması
    const backupSetData = await page.evaluate(async (wId) => {
      const res = await fetch(`/api/panel/websites/${wId}/backup-set`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Backup-set fetch failed: ${res.status}`);
      const json = await res.json();
      return json.data;
    }, targetWebsiteId);
    const excludePatterns = backupSetData?.excludePatterns || [];
    expect(Array.isArray(excludePatterns)).toBe(true);
    expect(excludePatterns.length).toBeGreaterThan(0);
    // Varsayılan dosya ve veri dışlama kalıplarını içerdiğini doğrula
    const hasGitExclusion = excludePatterns.some((pattern) => pattern.includes('.git'));
    const hasCacheExclusion = excludePatterns.some((pattern) => pattern.includes('node_modules/.cache') || pattern.includes('tmp'));
    expect(hasGitExclusion || hasCacheExclusion).toBe(true);
  });

  test('hatalı girdi: geçersiz saklama sayısı ve geçersiz cron zamanlaması reddedilir', async ({ page }) => {
    // 1. Web sitesinin Yedekleme sekmesine git
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    const planBtn = page.locator('button:has-text("Plan ve Zamanlama")');
    await expect(planBtn).toBeVisible({ timeout: 15000 });
    await planBtn.click();

    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedekleme Planı ve Saklama Politikası' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // HATA SENARYOSU 1: Geçersiz saklama sayısı (0 veya 100'den büyük)
    const keepLastInput = modal.locator('label', { hasText: 'Son N Kopya' }).locator('input');
    await keepLastInput.fill('0');

    const submitBtn = modal.locator('button:has-text("Planı Kaydet")');
    await submitBtn.click();

    // Frontend / API doğrulaması: Hata bildirimi görünmeli ve modal kapanmamalı
    const notice = modal.locator('.ws-notice-error, .ws-error, [role="alert"]');
    await expect(notice).toBeVisible({ timeout: 5000 });
    await expect(notice).toContainText(/Yedekleme bilgileri alınamadı|Saklanacak yedek sayıları/i);
    await expect(modal).toBeVisible();

    // HATA SENARYOSU 2: Geçersiz cron ifadesi (Özel zamanlama)
    // Önce saklama sayısını geçerli bir değere getir
    await keepLastInput.fill('7');

    // Sıklığı "Özel zamanlama" (custom) olarak seç
    const frequencySelect = modal.locator('select#backup-frequency');
    await frequencySelect.selectOption('custom');

    const cronInput = modal.locator('input#backup-cron');
    await expect(cronInput).toBeVisible({ timeout: 5000 });

    // Geçersiz cron ifadesi yaz
    await cronInput.fill('99 99 * * *');
    await submitBtn.click();

    // Backend / frontend hata mesajı kontrolü (geçersiz zamanlama)
    await expect(notice).toBeVisible({ timeout: 10000 });
    await expect(notice).toContainText(/Yedekleme bilgileri alınamadı|zamanlama/i);
    await expect(modal).toBeVisible();

    // Modalı temiz şekilde kapat
    const cancelBtn = modal.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(modal).toBeHidden({ timeout: 5000 });
  });
});
