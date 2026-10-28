import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WP-04 WordPress klonlama, staging ve veri senkronizasyonu', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const sourceDomainName = 'yp-wp.webrich.news';
  const sourceWebsiteId = 'af2e0dfc-2e63-5bdb-b6f2-68bee01bafa7';
  const stagingDomainName = 'yp-staging.webrich.news';
  const stagingWebsiteId = '171da678-3833-59d1-a861-392fcae7f24a';
  let csrfToken = '';

  function runSsh(command) {
    const b64 = Buffer.from(command).toString('base64');
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test "echo ${b64} | base64 -d | bash"`, {
      encoding: 'utf8',
      timeout: 30000,
    }).trim();
  }

  function apiHeaders() {
    return {
      'x-csrf-token': csrfToken,
      'content-type': 'application/json',
      origin: 'https://server.cryptoraichu.website',
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
    const sessionRes = await page.request.get('/api/auth/session');
    const sessionJson = await sessionRes.json().catch(() => null);
    csrfToken = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
  });

  test.afterAll(async () => {
    // 0 artık ilkesi: test doğrulama ve salt-okunur denetim odaklı yürütülmüştür;
    // mevcut üretim (yp-wp) ve staging (yp-staging) sitelerinde veya DB'de hiçbir artık bırakılmamıştır.
  });

  test('mutlu yol: WordPress klon ve staging arayüzü, modal kontrolleri, tekil durum API ve fiziksel staging kanıtı', async ({ page }) => {
    // 1. Web Siteleri arayüzünde kaynak WordPress sitesinin varlığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(sourceDomainName)}`);
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });
    const siteCard = page.locator('article').filter({ hasText: sourceDomainName }).first();
    await expect(siteCard).toBeVisible({ timeout: 10000 });

    // 2. Hedef sitenin detay sayfasına ve WordPress sekmesine git
    await page.goto(`/websites/${encodeURIComponent(sourceDomainName)}/wordpress`);
    await expect(page.locator('section').filter({ hasText: /WordPress/ }).first()).toBeVisible({ timeout: 20000 });

    // 3. Durumun "Kurulu" olduğunu ve "Klonla / staging" butonunun mevcut olduğunu doğrula
    const cloneBtn = page.locator('button', { hasText: 'Klonla / staging' });
    await expect(cloneBtn).toBeVisible({ timeout: 10000 });
    await expect(cloneBtn).toBeEnabled();

    // 4. "Klonla / staging" butonuna tıkla ve açılan modal bileşenini doğrula
    await cloneBtn.click();
    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: /Staging oluştur|WordPress klonla/ });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // 5. Modal içi form alanlarını doğrula: Hedef PHP sitesi, İşlem (staging/clone), Hedef protokol
    const targetSiteSelect = modal.locator('select').first();
    await expect(targetSiteSelect).toBeVisible();

    const actionSelect = modal.locator('label:has-text("İşlem") select');
    await expect(actionSelect).toBeVisible();
    await expect(actionSelect.locator('option[value="staging"]')).toHaveCount(1);
    await expect(actionSelect.locator('option[value="clone"]')).toHaveCount(1);

    const schemeSelect = modal.locator('label:has-text("Hedef protokol") select');
    await expect(schemeSelect).toBeVisible();
    await expect(schemeSelect.locator('option[value="https"]')).toHaveCount(1);
    await expect(schemeSelect.locator('option[value="http"]')).toHaveCount(1);

    // Modal açıklama metnini doğrula
    await expect(modal.locator('.ws-muted')).toContainText('Hedef site klasörü ve veritabanı boş olmalıdır');
    await expect(modal.locator('.ws-muted')).toContainText('Staging indeksleme ve WP cron çalışmasını kapatır');

    // Modaldan güvenle çıkış yap (Vazgeç)
    const cancelBtn = modal.locator('button', { hasText: 'Vazgeç' });
    await cancelBtn.click();
    await expect(modal).toBeHidden({ timeout: 5000 });

    // 6. Gerçek API üzerinden kaynak sitenin WordPress ve klon durumunu doğrula
    const apiRes = await page.request.get(`/api/panel/websites/${sourceWebsiteId}/wordpress`);
    expect(apiRes.status()).toBe(200);
    const json = await apiRes.json();
    expect(json.data.installed).toBe(true);
    expect(json.data.cloneAvailable).toBe(true);
    expect(json.data.primaryDomain).toBe(sourceDomainName);

    // 7. Gerçek API üzerinden staging ortamının durumunu doğrula
    const stagingApiRes = await page.request.get(`/api/panel/websites/${stagingWebsiteId}/wordpress`);
    expect(stagingApiRes.status()).toBe(200);
    const stagingJson = await stagingApiRes.json();
    expect(stagingJson.data.installed).toBe(true);
    expect(stagingJson.data.primaryDomain).toBe(stagingDomainName);

    // 8. Fiziksel kanıt 1: Kaynak sitede (production) blog_public ayarının '1' (indekslenebilir) olduğunu doğrula
    const prodBlogPublic = runSsh('/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path=/var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public option get blog_public 2>/dev/null');
    expect(prodBlogPublic).toBe('1');

    // 9. Fiziksel kanıt 2: Staging sitesinde blog_public ayarının '0' (arama motorlarına kapalı) olduğunu doğrula
    const stagingBlogPublic = runSsh('/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path=/var/lib/yunpanel/apps/140c004d-3a56-5835-80fb-8aa584e89906/current/public option get blog_public 2>/dev/null');
    expect(stagingBlogPublic).toBe('0');

    // 10. Fiziksel kanıt 3: Staging sitesinin wp-config.php dosyasında WP_ENVIRONMENT_TYPE='staging' ve DISABLE_WP_CRON=true olduğunu doğrula
    const stagingConfigEnv = runSsh("grep -E '(WP_ENVIRONMENT_TYPE|DISABLE_WP_CRON)' /var/lib/yunpanel/apps/140c004d-3a56-5835-80fb-8aa584e89906/current/public/wp-config.php 2>/dev/null");
    expect(stagingConfigEnv).toContain("define( 'WP_ENVIRONMENT_TYPE', 'staging' )");
    expect(stagingConfigEnv).toContain("define( 'DISABLE_WP_CRON', true )");

    // 11. Fiziksel kanıt 4: non-reseller-capabilities envanterinde WP-04 yeteneğinin 'partial' olarak tanımlandığını doğrula
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("WP-04");
        console.log(JSON.stringify({ id: c.id, status: c.status, title: c.title, serviceAdapters: c.serviceAdapters }));
      });
    '`);
    expect(capOutput).toContain('"id":"WP-04"');
    expect(capOutput).toContain('"status":"partial"');
    expect(capOutput).toContain('Klonlama, staging ve veri senkronizasyonu');
  });

  test('hatalı girdi: geçersiz klon parametreleri, aynı hedefe kopyalama ve dolu hedef dizin reddedilir (400/409 validation)', async ({ page }) => {
    // 1. Geçersiz UUID formatında hedef site kimliği ile preview isteği gönderildiğinde 400 wordpress_clone_input_invalid dönmeli
    const invalidTargetRes = await page.request.post(`/api/panel/websites/${sourceWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'clone',
          targetWebsiteId: 'invalid-target-uuid-format',
          databaseBindingId: '33333333-3333-4333-8333-333333333333',
          scheme: 'https',
        },
      },
    });
    expect(invalidTargetRes.status()).toBe(400);
    const targetJson = await invalidTargetRes.json();
    expect(targetJson.error?.code).toBe('wordpress_clone_input_invalid');

    // 2. Desteklenmeyen şema/protokol (ftp) gönderildiğinde 400 wordpress_clone_input_invalid dönmeli
    const invalidSchemeRes = await page.request.post(`/api/panel/websites/${sourceWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'staging',
          targetWebsiteId: stagingWebsiteId,
          databaseBindingId: '33333333-3333-4333-8333-333333333333',
          scheme: 'ftp',
        },
      },
    });
    expect(invalidSchemeRes.status()).toBe(400);
    const schemeJson = await invalidSchemeRes.json();
    expect(schemeJson.error?.code).toBe('wordpress_clone_input_invalid');

    // 3. Hedef site kaynak sitenin kendisi seçildiğinde 409 wordpress_clone_target_invalid dönmeli
    const selfTargetRes = await page.request.post(`/api/panel/websites/${sourceWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'clone',
          targetWebsiteId: sourceWebsiteId,
          databaseBindingId: '33333333-3333-4333-8333-333333333333',
          scheme: 'https',
        },
      },
    });
    expect(selfTargetRes.status()).toBe(409);
    const selfJson = await selfTargetRes.json();
    expect(selfJson.error?.code).toBe('wordpress_clone_target_invalid');

    // 4. Hedef dizin boş olmadığında (dolu staging dizini) 409 wordpress_clone_target_not_empty dönmeli
    const nonEmptyTargetRes = await page.request.post(`/api/panel/websites/${sourceWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'clone',
          targetWebsiteId: stagingWebsiteId,
          databaseBindingId: '33333333-3333-4333-8333-333333333333',
          scheme: 'http',
        },
      },
    });
    expect(nonEmptyTargetRes.status()).toBe(409);
    const nonEmptyJson = await nonEmptyTargetRes.json();
    expect(nonEmptyJson.error?.code).toBe('wordpress_clone_target_not_empty');

    // 5. UI form doğrulaması: Modal açıldığında hedef seçilmeden form gönderimi HTML5 required ile engellenir
    await page.goto(`/websites/${encodeURIComponent(sourceDomainName)}/wordpress`);
    await page.locator('button', { hasText: 'Klonla / staging' }).click();
    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: /Staging oluştur|WordPress klonla/ });
    await expect(modal).toBeVisible({ timeout: 10000 });

    const targetSelect = modal.locator('label:has-text("Hedef PHP sitesi") select');
    await expect(targetSelect).toHaveAttribute('required', '');
    const isRequired = await targetSelect.evaluate((el) => el.required);
    expect(isRequired).toBe(true);

    await modal.locator('button', { hasText: 'Vazgeç' }).click();
  });

  test('eksiklik (Plesk parity 1): Plesk WP Toolkit Veri Senkronizasyonu (Data Sync / Copy Data / Push-Pull) aracı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-04: Plesk WP Toolkit Veri Senkronizasyonu (Data Sync / Copy Data / Push-Pull) özelliği YunPanel arayüzünde ve API\'sinde bulunmuyor (partial/deferred).');

    // Plesk WP Toolkit'te staging ve production siteleri arasında veritabanı, dosyalar veya
    // seçili tabloları çift yönlü senkronize etmek için "Copy Data" / "Data Sync" aracı bulunur.
    await page.goto(`/websites/${encodeURIComponent(stagingDomainName)}/wordpress`);
    await expect(page.locator('section').filter({ hasText: /WordPress/ }).first()).toBeVisible({ timeout: 20000 });

    // Arayüzde veri senkronizasyonu / canlıya aktarım butonunun varlığını ara
    const syncBtn = page.locator('button:has-text("Veri Senkronizasyonu"), button:has-text("Veri Eşitle"), button:has-text("Copy Data"), button:has-text("Canlıya Aktar"), button:has-text("Senkronize et")');
    await expect(syncBtn).toBeVisible({ timeout: 5000 });

    // API düzeyinde de sync aksiyonu desteklenmemektedir (400 wordpress_action_invalid döner)
    const syncApiRes = await page.request.post(`/api/panel/websites/${stagingWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'sync',
        },
      },
    });
    expect(syncApiRes.status()).toBe(200);
  });

  test('eksiklik (Plesk parity 2): Plesk WP Toolkit klonlama sihirbazında anında yeni hedef/subdomain oluşturma desteği bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-04: Plesk WP Toolkit klon sihirbazında doğrudan yeni alt alan adı oluşturma (Create New Subdomain on-the-fly) seçeneği bulunmuyor.');

    // Plesk'te "Clone" modalı açıldığında kullanıcı doğrudan "Create new subdomain" seçip
    // subdomain adını yazdığında Plesk alt alan adını, sanal hostu ve DB'yi kendisi tek tıkla açar.
    // YunPanel'de ise kullanıcının önce çıkıp Web Siteleri ekranından ayrı bir PHP sitesi açması ve dosyalarını temizlemesi gerekir.
    await page.goto(`/websites/${encodeURIComponent(sourceDomainName)}/wordpress`);
    await page.locator('button', { hasText: 'Klonla / staging' }).click();
    const modal = page.locator('.ws-modal, [role="dialog"]').filter({ hasText: /Staging oluştur|WordPress klonla/ });
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Klon modalında anında yeni subdomain adı girilebilecek bir input veya seçenek ara
    const inlineSubdomainOption = modal.locator('input[placeholder*="subdomain"], label:has-text("Yeni alt alan adı"), input[name="newSubdomain"], [data-testid="create-subdomain-clone"]');
    await expect(inlineSubdomainOption).toBeVisible({ timeout: 5000 });
  });
});
