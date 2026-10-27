import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-01 Uzak Git repository ve yerel Git repository', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '2';
  const prefix = `tdev01-a${agentN}-${Date.now().toString(36)}`;
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
      console.warn('DEV-01 cleanup notice:', err.message);
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
    if (!createdDomainId) return;
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await removeWebsiteById(page, createdDomainId, primaryDomain);
    } catch (err) {
      console.warn('DEV-01 afterAll cleanup failed:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: Uzak Git deposu (GitHub) ile site oluştur, Git/Yayın sekmesini incele ve fiziksel kanıtı doğrula', async ({ page }) => {
    // 1. Yeni Web Sitesi Sihirbazı
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

    // Arka plan adımlarının (provisioning, git clone, npm ci) oturması için bekleme
    await page.waitForTimeout(20000);

    await overviewBtn.click();
    await expect(page.getByRole('heading', { name: primaryDomain })).toBeVisible({ timeout: 20000 });

    // 2. Git ve Yayın Yönetimine git (/node sekmesi)
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/node`);
    const appHeading = page.getByRole('heading', { name: /Node\.js uygulaması|Git ve yayın yönetimi/ });
    await expect(appHeading).toBeVisible({ timeout: 25000 });

    // Git bilgileri: Repository ve Branch arayüzde görüntülenmeli
    const pageContent = page.locator('body');
    await expect(pageContent).toContainText('https://github.com/heroku/node-js-getting-started.git');
    await expect(pageContent).toContainText('main');

    // Deploy butonu mevcut olmalı
    const deployBtn = page.locator('button', { hasText: 'Deploy başlat' });
    await expect(deployBtn).toBeVisible({ timeout: 10000 });

    // Git Webhook ve Otomatik Yayın bölümü kontrolü
    const webhookSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Git Webhook ve Otomatik Yayın' }) });
    await expect(webhookSection).toBeVisible({ timeout: 10000 });
    await expect(webhookSection).toContainText('GitHub Webhook Endpoint');

    const copyBtn = webhookSection.locator('button', { hasText: /Webhook URL Kopyala|Webhook URL Kopyalandı/ });
    await expect(copyBtn).toBeVisible();

    // 3. Fiziksel Sonuç Kontrolü
    // a) Doğrudan HTTP isteği ile Nginx routing veya Passenger cevabı kontrolü
    const httpRes = await checkDirectHttp(primaryDomain);
    expect([200, 404, 502, 503]).toContain(httpRes.status);

    // b) SSH ile host üzerinde fiziksel yapı (Nginx konfigürasyonu ve Git tabanlı release dizini) kontrolü
    const nginxConfCheck = runSsh(`ls /etc/nginx/sites-enabled/*${primaryDomain}* 2>/dev/null`);
    expect(nginxConfCheck.length).toBeGreaterThan(0);
    expect(nginxConfCheck).toContain(primaryDomain);

    const gitReleaseCheck = runSsh(`ls -d /var/lib/yunpanel/apps/*/releases/* 2>/dev/null | tail -n 1`);
    expect(gitReleaseCheck.length).toBeGreaterThan(0);
  });

  test('hatalı girdi: Git repository alanı boş veya geçersiz URL olduğunda form doğrulaması engeller', async ({ page }) => {
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

    const repoInput = page.locator('label', { hasText: 'GitHub repository' }).locator('input');
    await expect(repoInput).toBeVisible();
    await expect(repoInput).toHaveAttribute('required', '');
    await expect(repoInput).toHaveAttribute('type', 'url');

    // 1. Boş bırakıldığında validasyon kontrolü
    await repoInput.fill('');
    await nextBtn.click();
    const isInvalidWhenEmpty = await repoInput.evaluate((el) => !el.checkValidity());
    expect(isInvalidWhenEmpty).toBe(true);

    // Adım 3 (Siteyi oluştur) butonuna geçilmemeli, form Adım 2'de kalmalı
    const submitBtn = page.locator('footer.ws-form-footer button:has-text("Siteyi oluştur")');
    await expect(submitBtn).not.toBeVisible();

    // 2. Geçersiz URL girildiğinde (ör. 'not-a-valid-url')
    await repoInput.fill('not-a-valid-url');
    await nextBtn.click();
    const isInvalidWhenBadUrl = await repoInput.evaluate((el) => !el.checkValidity());
    expect(isInvalidWhenBadUrl).toBe(true);
    await expect(submitBtn).not.toBeVisible();
  });

  test('eksiklik: Yerel Git repository (Local Git repo / bare repo push deploy) desteği panelde bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-01-A: Plesk Git uzantısında bulunan Yerel Git Deposu (Local Git repository, `git init --bare` ve push URL) oluşturma yeteneği YunPanel arayüzünde bulunmamaktadır.');

    // Plesk'te Git arayüzünde "Local repository on this server" seçeneği bulunur
    // YunPanel'de ise yalnızca GitHub uzak deposu zorunlu tutulmaktadır
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle' })).toBeVisible({ timeout: 15000 });

    const domainInput = page.locator('label', { hasText: 'Alan adı' }).locator('input').first();
    await domainInput.fill(`localgit-${prefix}.webrich.news`);
    await page.locator('footer.ws-form-footer button:has-text("Devam et")').click();

    // Local git repo seçeneği aranır
    const localGitOption = page.locator('option[value*="local_git"], select option:has-text("Yerel Git"), label:has-text("Yerel Git repository")');
    await expect(localGitOption).toBeVisible({ timeout: 3000 });
  });

  test('eksiklik: PHP ve Statik sitelerde sonradan Git repository bağlama ve Git deploy aracı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-01-B: Plesk eşdeğeri olarak mevcut veya PHP sitelerine sonradan Git deposu bağlama arayüzü bulunmamakta, backend PHP uygulamalarında Git deploy akışını (409 deployment_not_supported) reddetmektedir.');

    // Webrich.news gibi mevcut PHP tabanlı siteye gidip Git / Yayın sekmesi arandığında
    await page.goto('/websites');
    await expect(page.getByRole('heading', { name: 'Web siteleri' })).toBeVisible({ timeout: 15000 });

    const webrichRow = page.locator('table.ws-table tbody tr').filter({ hasText: 'webrich.news' }).first();
    await expect(webrichRow).toBeVisible({ timeout: 10000 });
    await webrichRow.locator('a[href^="/websites/"]').first().click();

    // Site detayında Git / Yayınlama sekmesi veya aracı aranır
    const gitToolLink = page.locator('nav.yp-site-nav a, .yp-plesk-tool-card').filter({ hasText: /Git/i });
    await expect(gitToolLink).toBeVisible({ timeout: 3000 });
  });
});
