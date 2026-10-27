import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SYS-06 Cron/scheduled tasks; kullanıcı, zamanlama ve çıktı bildirimi', () => {
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tsys06-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.webrich.news`;
  let createdDomainId = null;
  let createdWebsiteId = null;
  let createdTaskId = null;

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

  async function getApiHeaders(page) {
    const origin = new URL(page.url()).origin;
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      'x-csrf-token': csrf,
    };
  }

  async function closeAnyOpenModal(page) {
    const openDialog = page.locator('dialog[open].ws-modal');
    if (await openDialog.isVisible({ timeout: 1500 }).catch(() => false)) {
      const discardBtn = openDialog.locator('button:has-text("Değişiklikleri bırak")').first();
      if (await discardBtn.isVisible().catch(() => false)) {
        await discardBtn.click();
      } else {
        const closeBtn = openDialog.locator('button:has-text("Kapat"), button[aria-label="Pencereyi kapat"]').first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
      }
      await expect(openDialog).toHaveCount(0, { timeout: 5000 }).catch(() => {});
    }
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
              await expect(doneBtn.or(page.locator('text=Site silindi'))).toBeVisible({ timeout: 40000 }).catch(() => {});
              if (await doneBtn.isVisible().catch(() => false)) {
                await doneBtn.click();
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn('sys-06 cleanup notice:', err.message);
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
  });

  test.afterAll(async ({ browser }) => {
    if (createdTaskId) {
      runSsh(`rm -f /etc/cron.d/yunpanel-${createdTaskId}`);
    }
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, siteDomain);
    } catch (err) {
      console.warn('sys-06 afterAll cleanup notice:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: site zamanlanmış görevi ekleme, zamanlama ve komut inceleme, crontab fiziksel doğrulaması ve temizleme', async ({ page }) => {
    // 1. Yeni statik test web sitesi oluştur
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
    if (await mailCheck.isVisible().catch(() => false) && await mailCheck.isChecked().catch(() => false)) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });

    const manageLink = resultElement.locator('a[href^="/websites/"]').first();
    const href = await manageLink.getAttribute('href');
    const domainIdMatch = href?.match(/\/websites\/([^/?#]+)/);
    createdDomainId = domainIdMatch ? decodeURIComponent(domainIdMatch[1]) : null;
    expect(createdDomainId).toBeTruthy();

    // websiteId'yi /api/panel/domains üzerinden çöz
    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBeTruthy();
    const domainsJson = await domainsRes.json();
    const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.items ?? []);
    const matchingDomain = domainList.find((d) => d.id === createdDomainId || d.primaryDomain === siteDomain);
    createdWebsiteId = matchingDomain?.websiteId;
    expect(createdWebsiteId).toBeTruthy();

    // 2. Zamanlanmış Görevler sekmesine git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/cron`);
    const section = page.locator('section').filter({ hasText: 'Zamanlanmış Görevler' });
    await expect(section).toBeVisible({ timeout: 15000 });

    const addBtn = section.locator('button', { hasText: 'Görev ekle' });
    await expect(addBtn).toBeVisible({ timeout: 10000 });
    await addBtn.click();

    // 3. Görev ekleme formunu doldur
    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Zamanlanmış görev ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    const taskName = `${prefix}-cronjob`;
    const taskSchedule = '*/10 * * * *';
    const taskCommand = `echo "sys06-verified-${prefix}" > /tmp/cron-${prefix}.txt`;

    await modal.locator('label:has-text("Görev adı") input').fill(taskName);
    await modal.locator('label:has-text("Cron ifadesi") input').fill(taskSchedule);
    await modal.locator('label:has-text("Çalıştırılacak komut") input').fill(taskCommand);

    const reviewBtn = modal.locator('button[type="submit"]:has-text("Değişikliği incele")');
    await expect(reviewBtn).toBeEnabled({ timeout: 5000 });
    await reviewBtn.click();

    // 4. İnceleme ekranı kontrolü ve kaydetme
    await expect(modal.locator('text=Bu kayıt kaydedilecek ve aynı işlemle sunucuya uygulanacak.')).toBeVisible({ timeout: 5000 });
    await expect(modal.locator('text=Sistem kullanıcısı')).toBeVisible();

    const saveBtn = modal.locator('button:has-text("Kaydet ve sunucuya uygula")');
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();

    // Modal kapanmalı veya JobDrawer açıldığında kapatılabilmeli
    await expect(modal).not.toBeVisible({ timeout: 30000 });

    // JobDrawer modalı açıldıysa tamamlanmasını bekle ve kapat
    const jobDrawer = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /İşlem durumu|cron\.apply/i });
    if (await jobDrawer.isVisible({ timeout: 4000 }).catch(() => false)) {
      await expect(jobDrawer.locator('p:has-text("Sunucu işlemi başarıyla tamamladı."), .ws-badge:has-text("succeeded")').first()).toBeVisible({ timeout: 45000 }).catch(() => {});
      const closeBtn = jobDrawer.locator('button:has-text("Kapat"), button[aria-label="Pencereyi kapat"]').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
      }
      await expect(jobDrawer).toHaveCount(0, { timeout: 10000 }).catch(() => {});
    }
    await closeAnyOpenModal(page);

    const taskRow = page.locator('tr').filter({ hasText: taskName });
    await expect(taskRow).toBeVisible({ timeout: 15000 });
    await expect(taskRow.locator(`text=${taskSchedule}`)).toBeVisible({ timeout: 10000 });
    await expect(taskRow.getByText('Yapılandırma hazır')).toBeVisible({ timeout: 30000 });

    // 5. Fiziksel doğrulama: Sunucu crontab dosyası (/etc/cron.d/yunpanel-<taskId>)
    const sshGrep = runSsh(`grep -l "sys06-verified-${prefix}" /etc/cron.d/yunpanel-* 2>/dev/null || true`);
    expect(sshGrep).toContain('/etc/cron.d/yunpanel-');
    const cronFilePath = sshGrep.trim();

    const fileContent = runSsh(`cat ${cronFilePath}`);
    expect(fileContent).toContain('# Managed by YunPanel. Manual edits are overwritten.');
    expect(fileContent).toContain('SHELL=/bin/sh');
    expect(fileContent).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(fileContent).toContain('MAILTO=""');
    expect(fileContent).toContain(taskSchedule);
    expect(fileContent).toContain(taskCommand);

    const match = cronFilePath.match(/yunpanel-([a-f0-9-]+)/);
    expect(match).toBeTruthy();
    createdTaskId = match[1];

    // 6. Fiziksel doğrulama: Panel API doğrulaması
    const apiRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`);
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    expect(apiData.data.cronServiceActive).toBe(true);
    const apiTask = apiData.data.tasks.find((t) => (t.id === createdTaskId || t.taskId === createdTaskId));
    expect(apiTask).toBeTruthy();
    expect(apiTask.hostFileExists).toBe(true);
    expect(apiTask.hostFileExact).toBe(true);

    // 7. Görevi arayüz üzerinden silme ve fiziksel temizliği doğrulama
    await closeAnyOpenModal(page);

    const deleteBtn = taskRow.locator('button', { hasText: 'Sil…' });
    await deleteBtn.click();

    const deleteModal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Zamanlanmış görevi sil' });
    await expect(deleteModal).toBeVisible({ timeout: 5000 });
    await deleteModal.locator('input').fill(taskName);

    const confirmDeleteBtn = deleteModal.locator('button[type="submit"]:has-text("Görevi sil")');
    await expect(confirmDeleteBtn).toBeEnabled({ timeout: 5000 });
    await confirmDeleteBtn.click();

    // Silme işlemi JobDrawer açarsa bekle ve kapat
    const deleteJobDrawer = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /İşlem durumu|cron\.remove/i });
    if (await deleteJobDrawer.isVisible({ timeout: 4000 }).catch(() => false)) {
      await expect(deleteJobDrawer.locator('p:has-text("Sunucu işlemi başarıyla tamamladı."), .ws-badge:has-text("succeeded")').first()).toBeVisible({ timeout: 45000 }).catch(() => {});
      const closeBtn = deleteJobDrawer.locator('button:has-text("Kapat"), button[aria-label="Pencereyi kapat"]').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
      }
      await expect(deleteJobDrawer).toHaveCount(0, { timeout: 10000 }).catch(() => {});
    }
    await closeAnyOpenModal(page);

    await expect(taskRow).not.toBeVisible({ timeout: 30000 });

    // Sunucudan dosyanın silindiğini doğrula
    const sshCheckAfterDelete = runSsh(`test -f ${cronFilePath} && echo "exists" || echo "removed"`);
    expect(sshCheckAfterDelete).toBe('removed');
    createdTaskId = null;
  });

  test('hatalı girdi: geçersiz cron zamanlama sözdizimi ve eksik zorunlu alanlar arayüz ve API tarafından reddedilir', async ({ page }) => {
    expect(createdDomainId).toBeTruthy();

    if (!createdWebsiteId) {
      const domainsRes = await page.request.get('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const domainList = Array.isArray(domainsJson.data) ? domainsJson.data : (domainsJson.data?.items ?? []);
      const matchingDomain = domainList.find((d) => d.id === createdDomainId || d.primaryDomain === siteDomain);
      createdWebsiteId = matchingDomain?.websiteId;
    }
    expect(createdWebsiteId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/cron`);
    const section = page.locator('section').filter({ hasText: 'Zamanlanmış Görevler' });
    await expect(section).toBeVisible({ timeout: 15000 });

    await closeAnyOpenModal(page);

    const addBtn = section.locator('button', { hasText: 'Görev ekle' });
    await addBtn.click();

    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Zamanlanmış görev ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // 1. Arayüz doğrulaması: 5 alandan az olan geçersiz cron ifadesi
    await modal.locator('label:has-text("Görev adı") input').fill('invalid-schedule-task');
    await modal.locator('label:has-text("Cron ifadesi") input').fill('*/5 * *');
    await modal.locator('label:has-text("Çalıştırılacak komut") input').fill('echo test');

    const reviewBtn = modal.locator('button[type="submit"]:has-text("Değişikliği incele")');
    await reviewBtn.click();

    const errorNotice = modal.locator('.ws-error, .ws-notice-error, [role="alert"]').or(page.getByText('beş alandan oluşmalıdır'));
    await expect(errorNotice.first()).toBeVisible({ timeout: 5000 });

    await modal.locator('button:has-text("Vazgeç")').click();
    const discardBtn = modal.locator('button:has-text("Değişiklikleri bırak")');
    if (await discardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await discardBtn.click();
    }
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    const headers = await getApiHeaders(page);

    // 2. API doğrulaması: sınır dışı sayısal değerler (99 99 99 99 99)
    const invalidScheduleRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`, {
      headers,
      data: {
        name: 'bad-schedule',
        schedule: '99 99 99 99 99',
        command: 'echo bad',
      },
    });
    expect(invalidScheduleRes.status()).toBe(400);
    const badScheduleJson = await invalidScheduleRes.json();
    expect(badScheduleJson.error.code).toBe('cron_schedule_invalid');

    // 3. API doğrulaması: zorunlu alan eksikliği (command yok)
    const missingFieldRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`, {
      headers,
      data: {
        name: 'missing-command',
        schedule: '0 0 * * *',
      },
    });
    expect(missingFieldRes.status()).toBe(400);
    const missingFieldJson = await missingFieldRes.json();
    expect(missingFieldJson.error.code).toBe('cron_create_input_invalid');
  });

  test('Plesk SYS-06 eksikliği: zamanlanmış görev çıktısı için e-posta bildirimi (MAILTO) ve kullanıcı seçimi sunulmalıdır', async ({ page }) => {
    test.fail(true, 'Plesk SYS-06 eşdeğerliği: Zamanlanmış görev çıktısının e-posta ile bildirilmesi (çıktı bildirimi/MAILTO tercihi) ve kullanıcı seçimi arayüzde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();

    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/cron`);
    const section = page.locator('section').filter({ hasText: 'Zamanlanmış Görevler' });
    await expect(section).toBeVisible({ timeout: 15000 });

    await closeAnyOpenModal(page);

    const addBtn = section.locator('button', { hasText: 'Görev ekle' });
    await addBtn.click();

    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: 'Zamanlanmış görev ekle' });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Plesk'te cron görevleri için e-posta bildirimi (her seferinde / hata durumunda / hiçbiri) ve sistem kullanıcısı seçimi bulunur.
    const notificationField = modal.locator('label:has-text("E-posta bildirimi"), label:has-text("Çıktı bildirimi"), select[name="notification"], input[name="mailto"]');
    await expect(notificationField).toBeVisible({ timeout: 3000 });
  });
});
