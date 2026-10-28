import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('EKL-01 Uygulama kurucu/katalog; site ve DB kurulum bütünlüğü', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

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
    // 0 artık ilkesi: test katalog listeleme, filtreleme, önizleme ve doğrulama
    // amaçlı çalışmış olup kalıcı proje kaydı veya container oluşturmamıştır.
    // Canlı sunucu ve veritabanında hiçbir artık bırakılmamıştır.
  });

  test('mutlu yol: Uygulama Marketi arayüzü, kategori filtreleri, şablon kartları ve tek tıkla kurulum önizlemesi', async ({ page }) => {
    // 1. Sol menüden veya doğrudan /docker rotasından Uygulama Marketi sayfasına git
    await page.goto('/docker');
    await expect(page.locator('h1', { hasText: /Docker & Compose|Uygulama Marketi/ })).toBeVisible({ timeout: 15000 });

    // 2. Uygulama Marketi katalog ızgarasının ve kartlarının ekranda görüntülendiğini doğrula
    const catalogGrid = page.locator('.yp-docker-catalog-grid');
    await expect(catalogGrid).toBeVisible({ timeout: 10000 });
    const catalogCards = page.locator('.yp-docker-catalog-card');
    const count = await catalogCards.count();
    expect(count).toBeGreaterThanOrEqual(5);

    // 3. Kategori filtreleme kontrolü: "Otomasyon & AI" filtresine tıkla
    const aiCategoryBtn = page.locator('.ws-filters button', { hasText: 'Otomasyon & AI' });
    if (await aiCategoryBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await aiCategoryBtn.click();
      await expect(page.locator('.yp-docker-catalog-card', { hasText: /n8n|Open WebUI/ }).first()).toBeVisible({ timeout: 10000 });
      // Tümü filtresine geri dön
      await page.locator('.ws-filters button', { hasText: 'Tümü' }).click();
    }

    // 4. Arama kutusu ile filtreleme: "pocketbase" ara
    const searchInput = page.locator('input[type="search"]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill('pocketbase');
    const pocketbaseCard = page.locator('.yp-docker-catalog-card', { hasText: /PocketBase/i }).first();
    await expect(pocketbaseCard).toBeVisible({ timeout: 10000 });

    // 5. "Tek Tıkla Kur" butonuna tıkla ve kurulum yapılandırma modalının açıldığını doğrula
    const installButton = pocketbaseCard.locator('button', { hasText: /Tek Tıkla Kur|Bu İmajla Oluştur/ });
    await expect(installButton).toBeVisible();
    await installButton.click();

    // Modalın görünür olduğunu, proje adı ve alan adı ayarlarını içerdiğini doğrula
    const modal = page.locator('.ws-modal');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(modal.locator('input[placeholder="shop_app"]')).toBeVisible();

    // Gelişmiş ayarlar akordiyonunu aç ve üretilen Compose dokümanı alanını doğrula
    const advancedSummary = modal.locator('summary', { hasText: /Gelişmiş/i });
    if (await advancedSummary.isVisible({ timeout: 5000 }).catch(() => false)) {
      await advancedSummary.click();
      await expect(modal.locator('textarea')).toBeVisible({ timeout: 5000 });
    }

    // Modalı vazgeç ile kapat
    await modal.locator('button', { hasText: 'Vazgeç' }).click();
    await expect(modal).not.toBeVisible({ timeout: 10000 });

    // 6. Gerçek API üzerinden /api/panel/docker/one-click-apps listesini doğrula
    const appsRes = await page.request.get('/api/panel/docker/one-click-apps');
    expect(appsRes.status()).toBe(200);
    const appsJson = await appsRes.json();
    expect(Array.isArray(appsJson.data)).toBe(true);
    expect(appsJson.data.length).toBeGreaterThanOrEqual(10);

    const pocketbaseItem = appsJson.data.find((item) => item.id === 'pocketbase');
    expect(pocketbaseItem).toBeTruthy();
    expect(pocketbaseItem.innerPort).toBe(8090);
    expect(pocketbaseItem.outerPort).toBe(18090);
    expect(pocketbaseItem.category).toBe('jamstack_baas');

    // 7. Gerçek API üzerinden /api/panel/docker/one-click-apps/prepare kurulum önizlemesini doğrula
    const prepareRes = await page.request.post('/api/panel/docker/one-click-apps/prepare', {
      headers: apiHeaders(),
      data: {
        templateId: 'pocketbase',
        projectName: 't_pocketbase_preview',
      },
    });
    expect(prepareRes.status()).toBe(200);
    const prepareJson = await prepareRes.json();
    expect(prepareJson.data.projectName).toBe('t_pocketbase_preview');
    expect(prepareJson.data.document).toContain('ghcr.io/muchobien/pocketbase');
    expect(prepareJson.data.document).toContain('18090:8090');
    expect(prepareJson.data.portMapping.innerPort).toBe(8090);
    expect(prepareJson.data.portMapping.outerPort).toBe(18090);
  });

  test('fiziksel kanıt: sunucuda katalog tanımları, docker compose generator çıktısı ve EKL-01 yetenek kaydı', async () => {
    // 1. Sunucuda docker-plesk-catalog.js kaynak dosyasının fiziksel mevcudiyeti
    const catalogFileExists = runSsh('test -f /usr/lib/yunpanel/apps/api/src/docker-plesk-catalog.js && echo "CATALOG_FILE_OK"');
    expect(catalogFileExists).toBe('CATALOG_FILE_OK');

    // 2. Sunucuda Node.js ortamında katalog listesi ve şablon sayısının fiziksel doğrulanması
    const catalogCount = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/docker-plesk-catalog.js").then(m => {
        const apps = m.listEasypanelOneClickApps();
        const dck = m.PLESK_DOCKER_CATALOG;
        console.log(JSON.stringify({ oneClickCount: apps.length, dockerCatalogCount: dck.length }));
      });
    '`);
    expect(catalogCount).toContain('"oneClickCount":');
    const parsed = JSON.parse(catalogCount);
    expect(parsed.oneClickCount).toBeGreaterThanOrEqual(10);
    expect(parsed.dockerCatalogCount).toBeGreaterThanOrEqual(5);

    // 3. Sunucuda prepareOneClickAppProvision fonksiyonunun fiziksel compose üretimi ve parola tuzlama doğrulaması
    const provisionTest = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/docker-plesk-catalog.js").then(m => {
        const prep = m.prepareOneClickAppProvision({ templateId: "postgres", projectName: "test_pg" });
        console.log(JSON.stringify({
          projectName: prep.projectName,
          hasPassword: prep.document.includes("POSTGRES_PASSWORD"),
          hasVolume: prep.document.includes("postgres_data"),
          secretsCount: prep.generatedSecretsCount
        }));
      });
    '`);
    expect(provisionTest).toContain('"projectName":"test_pg"');
    expect(provisionTest).toContain('"hasPassword":true');
    expect(provisionTest).toContain('"hasVolume":true');

    // 4. non-reseller-capabilities envanterinde EKL-01 yeteneğinin tanımını doğrula
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("EKL-01");
        console.log(JSON.stringify({ id: c.id, title: c.title, category: c.category }));
      });
    '`);
    expect(capOutput).toContain('"id":"EKL-01"');
    expect(capOutput).toContain('Uygulama kataloğu');
  });

  test('hatalı girdi: geçersiz şablon ID, eksik parametreler ve port hataları 400/404 ile reddedilir', async ({ page }) => {
    // 1. templateId boş gönderildiğinde 400 Bad Request (invalid_template_id) dönmeli
    const emptyIdRes = await page.request.post('/api/panel/docker/one-click-apps/prepare', {
      headers: apiHeaders(),
      data: {
        templateId: '',
      },
    });
    expect(emptyIdRes.status()).toBe(400);
    const emptyIdJson = await emptyIdRes.json();
    expect(emptyIdJson.error.code).toBe('invalid_template_id');

    // 2. Olmayan/geçersiz şablon ID gönderildiğinde 404 Not Found (one_click_template_not_found) dönmeli
    const unknownIdRes = await page.request.post('/api/panel/docker/one-click-apps/prepare', {
      headers: apiHeaders(),
      data: {
        templateId: 'gecersiz-ve-olmayan-sablon-99999',
      },
    });
    expect(unknownIdRes.status()).toBe(404);
    const unknownIdJson = await unknownIdRes.json();
    expect(unknownIdJson.error.code).toBe('one_click_template_not_found');

    // 3. Geçersiz dış port (1-65535 dışı) verildiğinde 400 Bad Request (invalid_outer_port) dönmeli
    const invalidPortRes = await page.request.post('/api/panel/docker/one-click-apps/prepare', {
      headers: apiHeaders(),
      data: {
        templateId: 'pocketbase',
        outerPort: 999999,
      },
    });
    expect(invalidPortRes.status()).toBe(400);
    const invalidPortJson = await invalidPortRes.json();
    expect(invalidPortJson.error.code).toBe('invalid_outer_port');

    // 4. /api/panel/docker/catalog/generate-compose hatalı proje adı verildiğinde 400 (invalid_project_name) dönmeli
    const invalidNameRes = await page.request.post('/api/panel/docker/catalog/generate-compose', {
      headers: apiHeaders(),
      data: {
        projectName: 'INVALID PROJECT NAME WITH SPACES & CAPS!',
        image: 'redis',
      },
    });
    expect(invalidNameRes.status()).toBe(400);
    const invalidNameJson = await invalidNameRes.json();
    expect(invalidNameJson.error.code).toBe('invalid_project_name');
  });

  test('Plesk eşdeğerlik eksikliği: Plesk Application Vault / APS katalog lisans ve sürüm seçici yokluğu', async ({ page }) => {
    test.fail(
      true,
      'BULGU EKL-01: Plesk Application Vault / APS katalogunda bulunan uygulama sürüm seçici (ör. v5/v6 seçimi), ticari lisans anahtarı yönetimi (Application Vault -> Manage Licenses) ve otomatik güncelleme motoru YunPanel hazır uygulama katalogunda yer almamaktadır.',
    );

    // Plesk'te /api/v2/applications/catalog veya APS Vault üzerinde uygulama sürümü seçilebilir ve lisans yüklenebilir.
    // YunPanel'de ise bu uç nokta ve sürüm seçici bulunmamaktadır (HTTP 404).
    const apsVaultRes = await page.request.get('/api/panel/applications/vault');
    expect(apsVaultRes.status()).toBe(200);
  });

  test('Plesk eşdeğerlik eksikliği: non-reseller yeteneklerinde listelenen /api/applications/catalog rotasının eksikliği', async ({ page }) => {
    test.fail(
      true,
      'BULGU EKL-01: non-reseller-capabilities.js içinde EKL-01 yeteneği için tanımlanan /api/applications/catalog rotası backend HTTP servisine bağlanmamıştır (HTTP 404).',
    );

    const appCatalogRes = await page.request.get('/api/panel/applications/catalog');
    expect(appCatalogRes.status()).toBe(200);
  });
});
