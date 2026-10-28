import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-06 Laravel scheduled task, log ve deployment senaryosu', () => {
  test.setTimeout(360000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tdev06-a${agentN}-${Date.now().toString(36)}`;
  const siteDomain = `${prefix}.157.180.11.28.sslip.io`;

  let createdDomainId = null;
  let createdWebsiteId = null;
  const createdTaskIds = new Set();

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  function checkHttp(host, path = '/') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method: 'GET',
        headers: { Host: host },
        timeout: 15000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HTTP request timeout'));
      });
      req.end();
    });
  }

  async function removeWebsiteById(page, domainId, domainName) {
    if (!domainId) return;
    try {
      await page.goto(`/websites/${encodeURIComponent(domainId)}/settings`);
      const removalSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Siteyi sil' }) });
      if (await removalSection.isVisible({ timeout: 7000 }).catch(() => false)) {
        const deleteBtn = removalSection.locator('button', { hasText: 'Siteyi sil…' });
        if (await deleteBtn.isVisible().catch(() => false)) {
          await deleteBtn.click();
          const dialog = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Siteyi kalıcı olarak sil' });
          if (await dialog.isVisible({ timeout: 5000 }).catch(() => false)) {
            const input = dialog.locator('input');
            await input.fill(domainName);
            const submitBtn = dialog.locator('button', { hasText: 'Silme işlemini başlat' });
            if (await submitBtn.isEnabled({ timeout: 3000 }).catch(() => false)) {
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
      console.warn('DEV-06 cleanup notice:', err.message);
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
      'Content-Type': 'application/json',
    };
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
    // 1. Arayüz üzerinden siteyi sil
    if (createdDomainId) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, siteDomain);
      } catch (err) {
        console.warn('DEV-06 afterAll cleanup notice:', err.message);
      } finally {
        await page.close().catch(() => {});
      }
    }

    // 2. Kalan spesifik cron dosyaları varsa yalnız bu teste ait olanları temizle (asla /etc/cron.d/yunpanel-* genel deseni kullanılmaz)
    for (const taskId of createdTaskIds) {
      runSsh(`rm -f /etc/cron.d/yunpanel-${taskId} 2>/dev/null || true`);
    }
    if (siteDomain) {
      const matchingFiles = runSsh(`grep -l "${siteDomain}" /etc/cron.d/yunpanel-* 2>/dev/null || true`);
      for (const f of matchingFiles.split('\n').filter(Boolean)) {
        if (f.startsWith('/etc/cron.d/yunpanel-')) {
          runSsh(`rm -f ${f} 2>/dev/null || true`);
        }
      }
    }

    // 3. Fiziksel temizlik kontrolü (0 artık ilkesi - yalnız bu teste ait Nginx dosyaları)
    runSsh(`rm -f /etc/nginx/sites-enabled/*${siteDomain}* /etc/nginx/sites-available/*${siteDomain}* 2>/dev/null; systemctl reload nginx 2>/dev/null || true`);
  });

  test('mutlu yol: PHP sitesi oluştur, cron sekmesini aç, Laravel schedule:run görevini ekle, fiziksel cron.d dosyasını doğrula ve görevi temizle', async ({ page }) => {
    // 1. Yeni Web Sitesi Sihirbazı
    await page.goto('/websites/new');
    await expect(page.locator('h1', { hasText: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill(siteDomain);

    const wwwSelect = page.locator('label:has-text("www davranışı") select');
    if (await wwwSelect.isVisible()) {
      await wwwSelect.selectOption('none');
    }

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 2: PHP barındırma türü seçimi
    await expect(page.locator('h3:has-text("Barındırma türü")')).toBeVisible({ timeout: 10000 });
    const sourceSelect = page.locator('label:has-text("Site türü") select');
    await sourceSelect.selectOption('new_php');

    await page.click('button[type="submit"]:has-text("Devam et")');

    // Adım 3: DNS, HTTPS ve Posta ayarları
    const summarySection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Son kontrol ve kurulum' }) });
    await expect(summarySection).toBeVisible({ timeout: 10000 });

    const dnsSelect = page.locator('label:has-text("DNS yönetimi") select');
    if (await dnsSelect.isVisible()) {
      await dnsSelect.selectOption('external');
    }

    const httpsSelect = page.locator('label:has-text("Sertifika yönetimi") select');
    if (await httpsSelect.isVisible()) {
      await httpsSelect.selectOption('off');
    }

    const mailCheck = page.locator('label.ws-check:has-text("E-posta ve Webmail") input[type="checkbox"]');
    if (await mailCheck.isVisible() && await mailCheck.isChecked()) {
      await mailCheck.uncheck();
    }

    const submitBtn = page.locator('button[type="submit"]:has-text("Siteyi oluştur")');
    await submitBtn.click();

    // Kurulum adımlarının tamamlanmasını bekle
    const resultElement = page.locator('.ws-site-create-result');
    await expect(resultElement).toBeVisible({ timeout: 60000 });
    await expect(resultElement).toContainText(siteDomain);

    await expect(resultElement.locator('.ws-spinner')).toHaveCount(0, { timeout: 120000 });
    const overviewLink = resultElement.locator('a:has-text("Site genel bakışı")');
    await expect(overviewLink).toBeVisible({ timeout: 30000 });

    const href = await overviewLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/?#]+)/);
    expect(match).toBeTruthy();
    createdDomainId = match[1];

    // Detay genel bakış sayfasına git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 20000 });

    const domainsRes = await page.request.get('/api/panel/domains');
    const domainsData = await domainsRes.json();
    const matchingDomain = domainsData.data?.find((d) => d.id === createdDomainId || d.primaryDomain === siteDomain);
    createdWebsiteId = matchingDomain?.websiteId;
    expect(createdWebsiteId).toBeTruthy();

    // Fiziksel Kontrol 1: Canlı HTTP yanıtı
    let httpOk = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const httpRes = await checkHttp(siteDomain, '/');
        if ([200, 403, 404].includes(httpRes.status)) {
          httpOk = true;
          break;
        }
      } catch {
        // Yeniden dene
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(httpOk).toBe(true);

    // Cron (Zamanlanmış Görevler) sekmesine git
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/cron`);
    const cronHeading = page.locator('h2, h3', { hasText: 'Zamanlanmış Görevler' });
    await expect(cronHeading.first()).toBeVisible({ timeout: 20000 });

    // "Görev ekle" modalını aç
    const addBtn = page.locator('button:has-text("Görev ekle")');
    await expect(addBtn).toBeVisible({ timeout: 15000 });
    await addBtn.click();

    const cronModal = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Zamanlanmış görev ekle' });
    await expect(cronModal).toBeVisible({ timeout: 10000 });

    // Formu Laravel schedule:run komutuyla doldur
    const taskName = 'Laravel Schedule Worker';
    const cronSchedule = '* * * * *';
    const cronCommand = `php /var/lib/yunpanel/sites/${siteDomain}/artisan schedule:run >> /dev/null 2>&1`;

    await cronModal.locator('label:has-text("Görev adı") input').fill(taskName);
    await cronModal.locator('label:has-text("Cron ifadesi") input').fill(cronSchedule);
    await cronModal.locator('label:has-text("Çalıştırılacak komut") input').fill(cronCommand);

    const reviewBtn = cronModal.locator('button[type="submit"]:has-text("Değişikliği incele")');
    await reviewBtn.click();

    // İnceleme adımında onayla ve sunucuya uygula
    const applyBtn = cronModal.locator('button:has-text("Kaydet ve sunucuya uygula")');
    await expect(applyBtn).toBeVisible({ timeout: 10000 });
    await applyBtn.click();

    // Modalın kapanmasını ve tablonun güncellenmesini bekle
    await expect(cronModal).toBeHidden({ timeout: 45000 });
    const taskRow = page.locator('tr').filter({ hasText: taskName });
    await expect(taskRow).toBeVisible({ timeout: 45000 });
    await expect(taskRow).toContainText(cronSchedule);
    await expect(taskRow.locator('text=Yapılandırma hazır')).toBeVisible({ timeout: 45000 });

    // Panel API'sinden bu testin oluşturduğu görevin taskId'sini al
    const cronsRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`);
    expect(cronsRes.ok()).toBeTruthy();
    const cronsData = await cronsRes.json();
    const mainTask = cronsData.data?.tasks?.find((t) => t.name === taskName);
    expect(mainTask).toBeTruthy();
    const mainTaskId = mainTask.id || mainTask.taskId;
    expect(mainTaskId).toBeTruthy();
    createdTaskIds.add(mainTaskId);

    // Fiziksel Kontrol 2: SSH ile /etc/cron.d/ dizininde yalnız bu göreve ait dosyanın doğrulaması
    const mainCronFilePath = `/etc/cron.d/yunpanel-${mainTaskId}`;
    const cronFileCheck = runSsh(`cat ${mainCronFilePath} 2>/dev/null`);
    expect(cronFileCheck.length).toBeGreaterThan(0);
    expect(cronFileCheck).toContain(cronSchedule);
    expect(cronFileCheck).toContain('artisan schedule:run');
    expect(cronFileCheck).toContain(siteDomain);

    // İki ayrı test kaynağı izolasyon doğrulaması: İkinci bir zamanlanmış görev oluştur
    const companionTaskName = 'Laravel Backup Clean Worker';
    const companionSchedule = '0 3 * * *';
    const companionCommand = `php /var/lib/yunpanel/sites/${siteDomain}/artisan backup:clean >> /dev/null 2>&1`;

    const apiHeaders = await getApiHeaders(page);
    const addCompanionRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`, {
      headers: apiHeaders,
      data: {
        name: companionTaskName,
        schedule: companionSchedule,
        command: companionCommand,
      },
    });
    expect(addCompanionRes.ok()).toBeTruthy();
    const addCompanionData = await addCompanionRes.json();
    const companionTaskId = addCompanionData.data?.task?.id || addCompanionData.data?.id;
    expect(companionTaskId).toBeTruthy();
    createdTaskIds.add(companionTaskId);

    // İkinci görevin dosyasının oluştuğunu SSH ile doğrula
    const companionCronPath = `/etc/cron.d/yunpanel-${companionTaskId}`;
    let companionCreated = false;
    for (let i = 0; i < 15; i++) {
      const check = runSsh(`cat ${companionCronPath} 2>/dev/null`);
      if (check.includes('backup:clean')) {
        companionCreated = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(companionCreated).toBe(true);

    // İşlem durumu modalı açıksa kapat
    const jobModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'İşlem durumu' });
    if (await jobModal.isVisible({ timeout: 5000 }).catch(() => false)) {
      const closeBtn = jobModal.locator('button:has-text("Kapat")').or(jobModal.locator('button[aria-label="Pencereyi kapat"]')).first();
      await closeBtn.click();
      await expect(jobModal).toBeHidden({ timeout: 10000 });
    }

    // Görevi arayüzden sil (0 artık ilkesi)
    const deleteBtn = taskRow.locator('button:has-text("Sil…")');
    await deleteBtn.click();

    const deleteModal = page.locator('dialog.ws-modal, [role="dialog"], .ws-modal').filter({ hasText: 'Zamanlanmış görevi sil' });
    await expect(deleteModal).toBeVisible({ timeout: 10000 });
    await deleteModal.locator('input').fill(taskName);

    const confirmDeleteBtn = deleteModal.locator('button[type="submit"]:has-text("Görevi sil")');
    await confirmDeleteBtn.click();
    await expect(deleteModal).toBeHidden({ timeout: 45000 });

    // Silme sonrası açılan işlem durumu modalı varsa kapat
    if (await jobModal.isVisible({ timeout: 5000 }).catch(() => false)) {
      const closeBtn = jobModal.locator('button:has-text("Kapat")').or(jobModal.locator('button[aria-label="Pencereyi kapat"]')).first();
      await closeBtn.click();
      await expect(jobModal).toBeHidden({ timeout: 10000 });
    }

    // Tabloda silinen ilk görevin kaldırıldığını doğrula
    await expect(page.locator('tr').filter({ hasText: taskName })).toHaveCount(0, { timeout: 30000 });

    // Fiziksel Kontrol 3: SSH ile yalnız bu testin silinen cron dosyasının kaldırıldığını doğrula
    const postDeleteCron = runSsh(`test -f ${mainCronFilePath} && echo "EXISTS" || echo "NOT_FOUND"`);
    expect(postDeleteCron).toBe('NOT_FOUND');
    createdTaskIds.delete(mainTaskId);

    // İZOLASYON KANITI: İlk görev silindiğinde ikinci görevin dosyası ve registry kaydı KORUNDU
    const companionStillExists = runSsh(`test -f ${companionCronPath} && echo "EXISTS" || echo "NOT_FOUND"`);
    expect(companionStillExists).toBe('EXISTS');

    const verifyApiRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons`);
    expect(verifyApiRes.ok()).toBeTruthy();
    const verifyApiData = await verifyApiRes.json();
    const companionInRegistry = verifyApiData.data?.tasks?.find((t) => (t.id === companionTaskId || t.taskId === companionTaskId));
    expect(companionInRegistry).toBeTruthy();
    expect(companionInRegistry.name).toBe(companionTaskName);
    expect(companionInRegistry.hostFileExists).toBe(true);

    // Temizlik: İkinci görevi de API üzerinden sil ve sunucu dosyasının temizlendiğini doğrula (0 artık)
    const deleteCompanionRes = await page.request.delete(
      `/api/panel/websites/${encodeURIComponent(createdWebsiteId)}/crons/${encodeURIComponent(companionTaskId)}`,
      {
        headers: apiHeaders,
        data: { expectedRevision: companionInRegistry.revision },
      },
    );
    expect(deleteCompanionRes.ok()).toBeTruthy();

    let companionCleaned = false;
    for (let i = 0; i < 15; i++) {
      const postDeleteCompanion = runSsh(`test -f ${companionCronPath} && echo "EXISTS" || echo "NOT_FOUND"`);
      if (postDeleteCompanion === 'NOT_FOUND') {
        companionCleaned = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(companionCleaned).toBe(true);
    createdTaskIds.delete(companionTaskId);
  });

  test('hatalı girdi / güvenlik: Geçersiz veya eksik parametrelerle cron oluşturma backend tarafından 400 ile engellenir ve var olmayan site 404 döner', async ({ page }) => {
    expect(createdWebsiteId).toBeTruthy();

    const result = await page.evaluate(async (websiteId) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken || session.csrfToken;
      const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

      // 1. İzin verilmeyen/fazla alan içeren gövde 400 döner (exactBody kontrolü)
      const res1 = await fetch(`/api/panel/websites/${encodeURIComponent(websiteId)}/crons`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Bad Cron',
          schedule: '* * * * *',
          command: 'ls -la',
          unexpectedKey: 'injection',
        }),
      });
      const data1 = await res1.json().catch(() => ({}));

      // 2. Eksik alan (command yok) içeren istek 400 döner
      const res2 = await fetch(`/api/panel/websites/${encodeURIComponent(websiteId)}/crons`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'Missing Command Cron',
          schedule: '0 * * * *',
        }),
      });
      const data2 = await res2.json().catch(() => ({}));

      // 3. Var olmayan bir websiteId ile cron listeleme 404 döner
      const res3 = await fetch('/api/panel/websites/00000000-0000-0000-0000-000000000000/crons', {
        headers,
      });

      return {
        status1: res1.status,
        code1: data1?.error?.code,
        status2: res2.status,
        status3: res3.status,
      };
    }, createdWebsiteId);

    expect(result.status1).toBe(400);
    expect(result.code1).toBe('cron_create_input_invalid');
    expect(result.status2).toBe(400);
    expect([404, 503]).toContain(result.status3);
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri hazır Schedule (Scheduled Tasks) yöneticisi ve artisan schedule:run otomatik entegrasyonu bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-06-A: Plesk Laravel Toolkit uzantısında yer alan hazır Laravel Zamanlanmış Görevler (Schedule) aracı, artisan schedule:run otomatik entegrasyonu ve Kernel.php/console.php görevlerini arayüzde ayrıştırma yeteneği YunPanel arayüzünde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // Plesk Laravel Toolkit'teki özel Schedule / Laravel Scheduler sekmesi veya 1-tıkla scheduler açma düğmesi aranır
    const laravelScheduler = page.locator('a:has-text("Laravel Schedule"), button:has-text("Enable Laravel Scheduler"), text=/Laravel Görevleri/i, text=/Laravel Scheduler/i');
    await expect(laravelScheduler.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri Laravel günlükleri (storage/logs/laravel.log) görüntüleyici, seviye filtreleme ve temizleme aracı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-06-B: Plesk Laravel Toolkit uzantısında yer alan Laravel uygulama günlükleri (storage/logs/laravel.log) görüntüleme, log seviyesi filtreleme (error, warning, info) ve log temizleme arayüzü bulunmamaktadır; mevcut panel yalnızca Nginx web sunucusu günlüklerini göstermektedir.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // Sitenin Günlükler sekmesini aç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/logs`);
    await expect(page.locator('h2, h3', { hasText: 'Günlükler' }).first()).toBeVisible({ timeout: 15000 });

    // Laravel log kaynağı seçeneği veya storage/logs/laravel.log görüntüleyicisi aranır
    const laravelLogOption = page.locator('select option:has-text("laravel.log"), button:has-text("Laravel Log"), text=/storage\\/logs\\/laravel\\.log/i');
    await expect(laravelLogOption.first()).toBeVisible({ timeout: 4000 });
  });

  test('eksiklik: Plesk Laravel Toolkit eşdeğeri Laravel dağıtım senaryoları (Deployment Script / composer install, artisan migrate, maintenance mode) otomasyonu bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-06-C: Plesk Laravel Toolkit uzantısında yer alan hazır Laravel dağıtım senaryoları (Deployment Script / composer install, php artisan migrate, maintenance mode açıp kapama, route/config cache) ve dağıtım adımları otomasyonu YunPanel PHP sitelerinde bulunmamaktadır.');

    expect(createdDomainId).toBeTruthy();
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/overview`);
    await expect(page.locator('h1, h2', { hasText: siteDomain }).first()).toBeVisible({ timeout: 15000 });

    // Plesk'te yer alan Laravel dağıtım senaryosu editörü veya Deployment Script aracı aranır
    const deploymentScript = page.locator('a:has-text("Dağıtım Senaryosu"), a:has-text("Deployment Script"), button:has-text("Run Deployment Script"), text=/Laravel Deployment/i');
    await expect(deploymentScript.first()).toBeVisible({ timeout: 4000 });
  });
});
