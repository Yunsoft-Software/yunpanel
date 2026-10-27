import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-02 Branch, deployment path, manuel/otomatik deployment', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tdev02-a${agentN}-${Date.now().toString(36)}`;
  const parentSuffix = 'webrich.news';
  const primaryDomain = `${prefix}.${parentSuffix}`;
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

  async function checkDirectHttp(host) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path: '/',
        method: 'GET',
        headers: { Host: host },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
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
      if (await removalSection.isVisible({ timeout: 5000 }).catch(() => false)) {
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
      console.warn('DEV-02 cleanup notice:', err.message);
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
    if (createdDomainId) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await removeWebsiteById(page, createdDomainId, primaryDomain);
      } catch (err) {
        console.warn('DEV-02 afterAll cleanup failed:', err.message);
      } finally {
        await page.close().catch(() => {});
      }
    }
    // Host seviyesinde kalıntı temizliği (sıfır artık)
    runSsh(`rm -f /etc/nginx/sites-enabled/yunpanel-*${prefix}*.conf`);
  });

  test('mutlu yol: Git deposu ile site kur, branch/yol bilgilerini doğrula, manuel deploy tetikle ve webhook arayüzünü incele', async ({ page }) => {
    // 1. Yeni Web Sitesi Oluşturma (Node.js & Git)
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(primaryDomain);
    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    // Adım 2: Site Türü: Node.js (Git ile yayınla)
    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_node');

    const entryFileInput = page.locator('label', { hasText: 'Başlangıç dosyası' }).locator('input');
    await expect(entryFileInput).toBeVisible();
    await entryFileInput.fill('index.js');

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await repoInput.fill('https://github.com/heroku/node-js-getting-started.git');

    const branchInput = page.locator('label', { hasText: 'Branch' }).locator('input');
    if (await branchInput.isVisible()) {
      await branchInput.fill('main');
    }

    // Adım 3: İnceleme ve Siteyi oluştur
    await nextBtn.click();
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).toBeVisible({ timeout: 10000 });
    await submitBtn.click();

    // Site kaydı oluşturulduğunda Site genel bakışı butonu belirir
    const overviewBtn = page.locator('a:has-text("Site genel bakışı")');
    await expect(overviewBtn).toBeVisible({ timeout: 120000 });
    const href = await overviewBtn.getAttribute('href');
    const domainIdMatch = href?.match(/\/websites\/([^/?#]+)/);
    createdDomainId = domainIdMatch ? decodeURIComponent(domainIdMatch[1]) : primaryDomain;

    // Arka plan servislerinin yapılandırılması için kısa bekleme
    await page.waitForTimeout(15000);

    // 2. Git / Yayın sekmesine geç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Branch ve Repository bilgilerinin doğrulanması
    const pageContent = page.locator('body');
    await expect(pageContent).toContainText('https://github.com/heroku/node-js-getting-started.git');
    await expect(pageContent).toContainText('main');

    // Manuel Deploy butonu kontrolü ve el ile tetikleme
    const deployBtn = page.locator('button', { hasText: 'Deploy başlat' });
    await expect(deployBtn).toBeVisible({ timeout: 10000 });
    await expect(deployBtn).toBeEnabled();

    // Manuel deploy butonuna tıkla
    await deployBtn.click();

    // Tıklama sonrası buton sayfada görünmeye devam etmelidir
    await expect(deployBtn).toBeVisible({ timeout: 10000 });

    // 3. Otomatik Yayın (Webhook) ve Dağıtım Yolu Bilgilerinin Kontrolü
    const webhookSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Git Webhook ve Otomatik Yayın' }) });
    await expect(webhookSection).toBeVisible({ timeout: 10000 });
    await expect(webhookSection).toContainText('GitHub Webhook Endpoint');
    await expect(webhookSection).toContainText('refs/heads/main');

    // Webhook URL Kopyalama butonu kontrolü
    const copyBtn = webhookSection.locator('button', { hasText: /Webhook URL Kopyala|Webhook URL Kopyalandı/ });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(webhookSection.locator('button', { hasText: 'Webhook URL Kopyalandı' })).toBeVisible({ timeout: 5000 });

    // Build & Çalışma Özeti içinde Dağıtım Yolu (Çıktı Dizini) ve Başlangıç Dosyası kontrolü
    await expect(webhookSection).toContainText('Çıktı Dizini');
    await expect(webhookSection).toContainText('Başlangıç Dosyası');

    // 4. Fiziksel Sonuç Kontrolü
    // a) Direct HTTP isteği ile Nginx routing / servis cevabı kontrolü
    const httpRes = await checkDirectHttp(primaryDomain);
    expect([200, 404, 502, 503]).toContain(httpRes.status);

    // b) SSH üzerinden fiziksel Nginx sites-enabled konfigürasyon kontrolü
    const siteLookup = runSsh(`grep -l "${primaryDomain}" /etc/nginx/sites-enabled/* 2>/dev/null || ls -1 /etc/nginx/sites-enabled/*${prefix}* 2>/dev/null`);
    expect(siteLookup.length).toBeGreaterThan(0);
  });

  test('hatalı girdi: Form doğrulamasında boş GitHub repository ile ilerleme engellenir', async ({ page }) => {
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    // Adım 1: Alan adı
    const fakeDomain = `err-${prefix}.webrich.news`;
    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(fakeDomain);

    const nextBtn = page.locator('footer.ws-form-footer button:has-text("Devam et")');
    await nextBtn.click();

    // Adım 2: Site Türü: Node.js (Git ile yayınla)
    const sourceSelect = page.locator('select[aria-label="Site türü"]');
    await expect(sourceSelect).toBeVisible({ timeout: 10000 });
    await sourceSelect.selectOption('new_node');

    // Repository alanını boş bırak
    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await repoInput.fill('');

    // Devam et butonuna tıkla
    await nextBtn.click();

    // İlerleme engellenmeli ve Adım 3 (Siteyi oluştur) butonuna geçilmemeli
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).not.toBeVisible();

    // Tarayıcı form validasyonu ile repository alanı geçersiz (invalid) olarak işaretlenmeli
    const isInvalid = await repoInput.evaluate((el) => !el.checkValidity());
    expect(isInvalid).toBe(true);
  });

  test('eksiklik: Panelde dal değiştirme (Switch Branch) ve depodaki dalları seçme arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-02-A: Plesk Git uzantısında bulunan aktif dalı değiştirme (Switch Branch - ör. main -> staging/develop) ve depodaki dalları listeleme yeteneği YunPanel arayüzünde bulunmamakta, branch salt okunur metin olarak kalmaktadır.');

    // Sitenin deploy sayfasına git
    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Dal seçici veya değiştirici (select, switch branch button, vs.) aranır
    const branchSelector = page.locator('select[name*="branch"], button:has-text("Dal değiştir"), button:has-text("Switch branch")');
    await expect(branchSelector).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik: Panelde dağıtım yolu (Deployment Path / Target Directory) düzenleme arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-02-B: Plesk Git uzantısında bulunan hedef dağıtım dizini (Deployment Directory / Target path in document root) belirleme ve değiştirme arayüzü YunPanel deploy sekmesinde bulunmamakta, çıktı dizini salt okunur gösterilmektedir.');

    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Dağıtım yolu düzenleme inputu veya butonu aranır
    const deployPathEditor = page.locator('button:has-text("Dağıtım yolunu değiştir"), input[name*="deploymentPath"], input[name*="outputDir"], button:has-text("Dizin seç")');
    await expect(deployPathEditor).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik: Panelde Dağıtım Modu (Otomatik vs Manuel Dağıtım / Webhook toggle) seçimi bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-02-C: Plesk Git uzantısında bulunan Dağıtım Modu seçimi (Deployment Mode: Automatic / Manual / None) YunPanel arayüzünde bulunmamakta, otomatik webhook tetiklemesini devre dışı bırakma veya modu değiştirme seçeneği sunulmamaktadır.');

    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Dağıtım modu toggle veya seçicisi aranır
    const deployModeToggle = page.locator('select[name*="deployMode"], input[value="manual"], input[value="automatic"], button:has-text("Otomatik yayını kapat"), label:has-text("Dağıtım Modu")');
    await expect(deployModeToggle).toBeVisible({ timeout: 5000 });
  });
});
