import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-04 Zamanlama, rotasyon, saklama ve hariç tutmalar', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '2';
  const timestamp = Date.now().toString(36);
  const prefix = `tbak04-a${agentN}-${timestamp}`;
  const repoName = `${prefix}-repo`;

  let createdSite = null;
  let createdRepoId = null;
  let targetDomainId = null;
  let targetWebsiteId = null;
  let csrfToken = '';

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
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');

    const mailCheckbox = page.locator('label:has-text("E-posta ve Webmail etkinleştir") input[type="checkbox"]');
    if (await mailCheckbox.count()) {
      if (await mailCheckbox.isChecked()) {
        await mailCheckbox.uncheck();
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
    test.setTimeout(300000);
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
      const token = (await sessionRes?.json())?.data?.csrfToken || csrfToken;

      // 1. Zamanlamayı devre dışı bırak
      if (targetWebsiteId && createdRepoId && token) {
        await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup-operations`, {
          headers: {
            'x-csrf-token': token,
            Origin: 'https://server.cryptoraichu.website',
            Referer: 'https://server.cryptoraichu.website/',
          },
          data: {
            kind: 'plan',
            repositoryId: createdRepoId,
            schedule: { enabled: false },
          },
        }).catch(() => null);
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

      // 3. Test amaçlı oluşturulan web sitesini kaldır
      if (createdSite) {
        await removeSite(page, createdSite);
      }
    } catch (err) {
      console.warn('BAK-04 cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: otomatik yedekleme zamanlaması ve saklama politikası yapılandırma, UI doğrulaması ve fiziksel schedule/exclusion kanıtı', async ({ page }) => {
    // 1. Kendi test sitemizi oluştur
    createdSite = await createSite(page);
    targetWebsiteId = createdSite.websiteId;
    targetDomainId = createdSite.domainId;
    expect(targetWebsiteId).toBeTruthy();
    expect(targetDomainId).toBeTruthy();

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

    // Depo seçimi (oluşturulan depoyu seç)
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
    await expect(page.locator('button:has-text("Yedekleri yenile")')).toBeEnabled({ timeout: 30000 });
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
    expect(createdSite).toBeTruthy();
    // 1. Web sitesinin Yedekleme sekmesine git
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Yedekleme bilgileri okunuyor…')).not.toBeVisible({ timeout: 30000 });

    const planBtn = page.locator('button:has-text("Plan ve Zamanlama")');
    await expect(planBtn).toBeVisible({ timeout: 15000 });
    await expect(planBtn).toBeEnabled({ timeout: 15000 });
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
