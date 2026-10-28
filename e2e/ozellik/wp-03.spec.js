import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WP-03 Toplu yönetim ve plugin/theme setleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const targetDomainName = 'yp-wp.webrich.news';
  const targetWebsiteId = 'af2e0dfc-2e63-5bdb-b6f2-68bee01bafa7';
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
    // 0 artık ilkesi: test salt-okunur ve doğrulama amaçlı çalışmıştır;
    // canlı sunucu ve veri tabanında hiçbir artık bırakılmamıştır.
  });

  test('mutlu yol: WordPress kurulumları tespiti, tekil durum denetimi ve sistem WordPress/WP-CLI altyapı doğrulaması', async ({ page }) => {
    // 1. Web Siteleri arayüzünde WordPress kurulu hedef sitenin varlığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(targetDomainName)}`);
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });
    const siteCard = page.locator('article').filter({ hasText: targetDomainName }).first();
    await expect(siteCard).toBeVisible({ timeout: 10000 });

    // 2. Hedef sitenin detay sayfasına ve WordPress sekmesine git
    await page.goto(`/websites/${encodeURIComponent(targetDomainName)}/wordpress`);
    await expect(page.locator('section').filter({ hasText: /Eklentiler|WordPress|WP-CLI/ }).first()).toBeVisible({ timeout: 20000 });

    // 3. Gerçek API üzerinden tekil site WordPress durumunu sorgula
    const apiRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/wordpress`);
    expect(apiRes.status()).toBe(200);
    const json = await apiRes.json();
    expect(json).toHaveProperty('data');
    expect(json.data.installed).toBe(true);
    expect(Array.isArray(json.data.plugins)).toBe(true);
    expect(Array.isArray(json.data.themes)).toBe(true);

    // 4. Fiziksel kanıt 1: Sunucuda WP-CLI binary'sinin çalıştığını ve wp-config.php dosyasını doğrula
    const wpCliVersion = runSsh('/usr/lib/yunpanel/vendor/wp-cli/wp --version --allow-root 2>/dev/null');
    expect(wpCliVersion).toContain('WP-CLI 2.');

    const wpConfigCheck = runSsh('test -f /var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public/wp-config.php && echo "WP_CONFIG_EXISTS"');
    expect(wpConfigCheck).toBe('WP_CONFIG_EXISTS');

    const coreInstalledCheck = runSsh('/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path=/var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public core is-installed && echo "CORE_OK"');
    expect(coreInstalledCheck).toBe('CORE_OK');

    // 5. Fiziksel kanıt 2: non-reseller-capabilities envanterinde WP-03 yeteneğinin tanımlı olduğunu doğrula
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("WP-03");
        console.log(JSON.stringify({ id: c.id, status: c.status, serviceAdapters: c.serviceAdapters }));
      });
    '`);
    expect(capOutput).toContain('"id":"WP-03"');
    expect(capOutput).toContain('"status":"deferred"');
    expect(capOutput).toContain('"serviceAdapters":"Linux Shell / WP-CLI"');
  });

  test('hatalı girdi: geçersiz eylem ve geçersiz paket adı doğrulaması reddedilir (400 validation)', async ({ page }) => {
    // 1. Tanımlanmamış / geçersiz toplu aksiyon (bulk.update) gönderildiğinde 400 wordpress_action_invalid dönmeli
    const invalidActionRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'bulk.update',
        },
      },
    });
    expect(invalidActionRes.status()).toBe(400);
    const actionJson = await invalidActionRes.json();
    expect(actionJson.error?.code).toBe('wordpress_action_invalid');

    // 2. Desteklenmeyen set kurulum aksiyonu (set.install) gönderildiğinde 400 wordpress_action_invalid dönmeli
    const setActionRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'set.install',
        },
      },
    });
    expect(setActionRes.status()).toBe(400);
    const setJson = await setActionRes.json();
    expect(setJson.error?.code).toBe('wordpress_action_invalid');

    // 3. Geçersiz karakterler içeren eklenti paketi adı gönderildiğinde 400 wordpress_package_invalid dönmeli
    const invalidPkgRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'plugin.install',
          package: 'Invalid_Package_Name!@#',
        },
      },
    });
    expect(invalidPkgRes.status()).toBe(400);
    const pkgJson = await invalidPkgRes.json();
    expect(pkgJson.error?.code).toBe('wordpress_package_invalid');
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit global toplu yönetim (Mass Actions) ekranı ve çoklu seçim bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-03: Plesk WP Toolkit global toplu yönetim (Mass Actions) ekranı YunPanel arayüzünde bulunmuyor (deferred).');

    // Plesk'te sol menüde global WordPress / WP Toolkit ekranı yer alır.
    // Bu ekranda tüm siteler tek tabloda toplanır ve çoklu seçim (checkbox) ile "Toplu Güncelle" aksiyonu tetiklenebilir.
    await page.goto('/wordpress');

    // YunPanel'de /wordpress rotası yalnızca SiteToolEntryPage bileşenini açarak tekil site seçtirir;
    // merkezi çoklu seçim (checkbox) ve toplu işlem düğmesi (Mass Update / Toplu Güncelle) yer almaz.
    const massActionBtn = page.locator('button:has-text("Toplu Güncelle"), button:has-text("Mass Update"), [data-testid="mass-actions"]');
    await expect(massActionBtn).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit Plugin & Theme Sets (Eklenti ve Tema Setleri) API ve yönetim arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-03: Plesk WP Toolkit eklenti ve tema setleri (Plugin & Theme Sets) yönetimi YunPanel API ve arayüzünde bulunmuyor (deferred).');

    // Plesk WP Toolkit'te eklenti ve temalardan oluşan setlerin ("Sets") listelendiği, oluşturulduğu ve
    // sitelere topluca yüklendiği API ve arayüz bulunur.
    // YunPanel'de ise bu uç nokta tanımlı değildir (404 döner).
    const setsApiRes = await page.request.get('/api/panel/wordpress/sets');
    expect(setsApiRes.status()).toBe(200);
    const setsJson = await setsApiRes.json();
    expect(setsJson).toHaveProperty('data');
  });
});
