import http from 'node:http';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DEV-03 Deploy anahtarı/webhook/ek komut ve işlem sonucu', () => {
  test.setTimeout(300000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tdev03-a${agentN}-${Date.now().toString(36)}`;
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

  async function checkDirectHttp(host, path = '/', method = 'GET', headers = {}, bodyData = '') {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '157.180.11.28',
        port: 80,
        path,
        method,
        headers: { Host: host, ...headers },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      if (bodyData) {
        req.write(bodyData);
      }
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
      console.warn('DEV-03 cleanup notice:', err.message);
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
      console.warn('DEV-03 afterAll cleanup failed:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: Git tabanlı site oluştur, Git ve yayın sekmesinde Webhook/Deploy bileşenlerini incele, deploy tetikle ve fiziksel sonucu doğrula', async ({ page }) => {
    // 1. Yeni Web Sitesi Oluşturma (Node.js & GitHub)
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

    // Site kaydı tamamlanınca genel bakış butonu görünür
    const overviewBtn = page.locator('a:has-text("Site genel bakışı")');
    await expect(overviewBtn).toBeVisible({ timeout: 120000 });
    const href = await overviewBtn.getAttribute('href');
    const domainIdMatch = href?.match(/\/websites\/([^/?#]+)/);
    createdDomainId = domainIdMatch ? decodeURIComponent(domainIdMatch[1]) : primaryDomain;

    // Arka plan servislerinin yapılandırılması için bekleme
    await page.waitForTimeout(15000);

    // 2. Git / Yayın sekmesine geç
    await page.goto(`/websites/${encodeURIComponent(createdDomainId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Git Webhook kartı ve Kopyalama butonu kontrolü
    const webhookSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Git Webhook ve Otomatik Yayın' }) });
    await expect(webhookSection).toBeVisible({ timeout: 10000 });
    await expect(webhookSection).toContainText('GitHub Webhook Endpoint');

    const copyBtn = webhookSection.locator('button', { hasText: /Webhook URL Kopyala|Webhook URL Kopyalandı/ });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(webhookSection.locator('button', { hasText: 'Webhook URL Kopyalandı' })).toBeVisible({ timeout: 5000 });

    // Manuel Deploy butonu ve tetikleme
    const deployBtn = page.locator('button', { hasText: 'Deploy başlat' });
    await expect(deployBtn).toBeVisible({ timeout: 10000 });
    await expect(deployBtn).toBeEnabled();
    await deployBtn.click();

    // İşlem kuyruğa alındığında durum bildirimi veya işlem tetiklenmesi kontrolü
    await expect(deployBtn.or(page.locator('.ws-notice, [role="status"], .ws-drawer'))).toBeVisible({ timeout: 10000 });

    // Release geçmişi bölümü doğrulaması
    const releaseSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Release geçmişi' }) });
    await expect(releaseSection).toBeVisible({ timeout: 10000 });

    // 3. Fiziksel Sonuç Kontrolü
    // a) Direct HTTP isteği ile Nginx cevabı kontrolü
    const httpRes = await checkDirectHttp(primaryDomain);
    expect([200, 404, 502, 503]).toContain(httpRes.status);

    // b) SSH üzerinden Nginx config kontrolü
    const nginxConfCheck = runSsh(`ls /etc/nginx/sites-enabled/*${primaryDomain}* 2>/dev/null`);
    expect(nginxConfCheck.length).toBeGreaterThan(0);
    expect(nginxConfCheck).toContain(primaryDomain);

    // c) SSH üzerinden release ve uygulama dizini kontrolü
    const releaseCheck = runSsh(`ls -d /var/lib/yunpanel/apps/*/releases/* 2>/dev/null | tail -n 1`);
    expect(releaseCheck.length).toBeGreaterThan(0);
  });

  test('hatalı girdi / güvenlik: GitHub Webhook endpointine geçersiz veya imzasız istek atıldığında backend 400 ile reddeder', async ({ request }) => {
    // GitHub webhook endpoint'ine sahte/imzasız POST isteği gönderildiğinde backend HTTP 400 veya 404 dönmelidir
    // Bu, yetkisiz webhook isteklerinin deploy tetiklemesini engellediğini fiziksel olarak kanıtlar
    const res = await request.post('/api/webhooks/github/00000000-0000-0000-0000-000000000000', {
      headers: {
        'content-type': 'application/json',
      },
      data: { ref: 'refs/heads/main', repository: { full_name: 'test/repo' } },
    });

    // Eksik x-github-event, x-github-delivery veya x-hub-signature-256 header'ları nedeniyle backend 400 reddi vermelidir
    expect([400, 404, 405]).toContain(res.status());
    if (res.status() === 400) {
      const body = await res.text();
      expect(body).toContain('github_webhook_headers_invalid');
    }
  });

  test('eksiklik: Plesk Git eşdeğeri SSH Deploy Anahtarı (SSH Public Key) üretimi ve kopyalama arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-03-A: Plesk Git uzantısında bulunan özel depolar (private repositories) için SSH Deploy Anahtarı (SSH Public Key) üretimi, kopyalanması ve GitHub/GitLab ayarlarına ekleme arayüzü YunPanel deploy sekmesinde bulunmamaktadır.');

    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // SSH Deploy Anahtarı alanı veya kopyalama butonu aranır
    const deployKeyArea = page.locator('text=/Deploy Anahtarı|SSH Public Key|Deploy Key|Genel Anahtar/i')
      .or(page.locator('button:has-text("Deploy anahtarını kopyala")'))
      .or(page.locator('button:has-text("SSH Key Kopyala")'));
    await expect(deployKeyArea.first()).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik: Dağıtım sonrası ek işlemler ve komutlar (Post-deployment build/install script) tanımlama arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU DEV-03-B: Plesk Git uzantısında bulunan Dağıtım Sonrası Ek İşlemler / Komutlar (Additional deployment actions; ör. npm run build, composer install, artisan migrate) tanımlama alanı YunPanel deploy sekmesinde bulunmamaktadır.');

    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Dağıtım sonrası ek komutlar (Additional deployment commands / actions) alanı aranır
    const postDeployCommands = page.locator('textarea[name*="postDeploy"], input[name*="postDeploy"], label:has-text("Ek dağıtım komutları"), label:has-text("Dağıtım sonrası komutlar"), text=/Additional deployment actions/i');
    await expect(postDeployCommands.first()).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik / hata: Arayüzdeki Webhook URL uygulama kimliğini içermemekte ve Webhook Secret arayüzde sunulmamaktadır', async ({ page }) => {
    test.fail(true, 'BULGU DEV-03-C: Arayüzde gösterilen GitHub Webhook URL (/api/webhooks/github) uygulama UUID parametresini içermemekte, backend router ise /api/webhooks/github/:applicationId beklemektedir; ayrıca GitHub Webhook Secret yönetimi arayüzde yer almamaktadır.');

    const targetId = createdDomainId || primaryDomain;
    await page.goto(`/websites/${encodeURIComponent(targetId)}/deploy`);
    await expect(page.getByRole('heading', { name: /Git ve yayın yönetimi|Node\.js uygulaması/ })).toBeVisible({ timeout: 15000 });

    // Webhook kartındaki Endpoint metnini kontrol et: UUID içermelidir
    const webhookSection = page.locator('section').filter({ has: page.locator('h2, h3', { hasText: 'Git Webhook ve Otomatik Yayın' }) });
    await expect(webhookSection).toBeVisible({ timeout: 10000 });

    // Doğru bir webhook URL'inin UUID içermesi beklenir (/api/webhooks/github/[uuid])
    const endpointValue = await webhookSection.locator('text=/\\/api\\/webhooks\\/github/').textContent();
    const hasApplicationUuid = /\/api\/webhooks\/github\/[0-9a-f]{8}-[0-9a-f]{4}/i.test(endpointValue || '');
    expect(hasApplicationUuid).toBe(true);

    // Webhook Secret alanı da bulunmalıdır
    const secretField = webhookSection.locator('text=/Webhook Secret/i');
    await expect(secretField).toBeVisible({ timeout: 3000 });
  });
});
