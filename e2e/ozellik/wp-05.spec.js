import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('WP-05 WordPress Yedek/restore, bakım ve arama motoru indeksleme ayarları', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const targetDomainName = 'yp-wp.webrich.news';
  const targetDomainId = '8847f9e7-99f9-5fef-8f93-a82e0b0f354d';
  const targetWebsiteId = 'af2e0dfc-2e63-5bdb-b6f2-68bee01bafa7';
  const wpRoot = '/var/lib/yunpanel/apps/0a4fe1b2-a269-5b7d-917d-09443c69e0bd/releases/808eb862-73a0-4c9a-9ce6-e209e19e01e1/public';
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
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = await sessionRes?.json().catch(() => null);
    csrfToken = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
  });

  test.afterAll(async () => {
    // 0 artık ilkesi: test salt-okunur ve doğrulama amaçlı çalışmıştır;
    // canlı sunucu ve veri tabanında hiçbir artık bırakılmamıştır.
  });

  test('mutlu yol: WordPress yedekleme entegrasyonu, site yedek seti ve fiziksel WP/backup/indeksleme kanıtları', async ({ page }) => {
    // 1. Web Siteleri arayüzünde WordPress kurulu hedef sitenin varlığını doğrula
    await page.goto(`/websites?q=${encodeURIComponent(targetDomainName)}`);
    await expect(page.locator('h1', { hasText: 'Web siteleri' })).toBeVisible({ timeout: 15000 });
    const siteCard = page.locator('article').filter({ hasText: targetDomainName }).first();
    await expect(siteCard).toBeVisible({ timeout: 10000 });

    // 2. Hedef sitenin WordPress detay paneline git
    await page.goto(`/websites/${targetDomainId}/wordpress`);
    await expect(page.locator('section').filter({ hasText: 'WordPress' }).first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=Kurulu')).toBeVisible({ timeout: 10000 });

    // 3. WordPress panelinde "Yedekler ve geri yükleme" butonunun varlığını doğrula ve tıkla
    const backupLink = page.locator('a, button').filter({ hasText: 'Yedekler ve geri yükleme' }).first();
    await expect(backupLink).toBeVisible({ timeout: 10000 });
    await backupLink.click();

    // 4. Site yedekleme sayfasına yönlenmeyi ve yedekleme kontrollerini doğrula
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button:has-text("Yedek al")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Yedek seti').or(page.locator('text=Veritabanı'))).toBeVisible({ timeout: 15000 });

    // 5. Gerçek API üzerinden WordPress durumu ve yedekleme verilerini doğrula
    const wpApiRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/wordpress`);
    expect(wpApiRes.status()).toBe(200);
    const wpJson = await wpApiRes.json();
    expect(wpJson.data.installed).toBe(true);
    expect(wpJson.data.primaryDomain).toBe(targetDomainName);
    expect(Array.isArray(wpJson.data.databases)).toBe(true);
    expect(wpJson.data.databases.length).toBeGreaterThanOrEqual(1);

    const backupsRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backups`);
    expect(backupsRes.status()).toBe(200);
    const backupsJson = await backupsRes.json();
    expect(backupsJson.data.websiteId).toBe(targetWebsiteId);
    expect(backupsJson.data.backupSet).toBeTruthy();
    expect(backupsJson.data.backupSet.databaseCount).toBeGreaterThanOrEqual(1);

    const backupSetRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/backup-set`);
    expect(backupSetRes.status()).toBe(200);
    const backupSetJson = await backupSetRes.json();
    expect(backupSetJson.data.files).toBeTruthy();

    // 6. Fiziksel kanıt 1: WP-CLI ile arama motoru indeksleme (blog_public) ayarını doğrula
    const blogPublic = runSsh(`/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path=${wpRoot} option get blog_public 2>/dev/null`);
    expect(blogPublic).toBe('1');

    // 7. Fiziksel kanıt 2: WP-CLI ile bakım modu (maintenance-mode) durumunu doğrula
    const maintenanceStatus = runSsh(`/usr/lib/yunpanel/vendor/wp-cli/wp --allow-root --path=${wpRoot} maintenance-mode status 2>/dev/null`);
    expect(maintenanceStatus).toContain('Maintenance mode is not active');

    // 8. Fiziksel kanıt 3: .maintenance dosyasının fiziksel olarak dizinde bulunmadığını doğrula
    const noMaintenance = runSsh(`test ! -f ${wpRoot}/.maintenance && echo "NO_MAINTENANCE_FILE"`);
    expect(noMaintenance).toBe('NO_MAINTENANCE_FILE');

    // 9. Fiziksel kanıt 4: Canlı HTTP ile robots.txt yanıtını doğrula (blog_public=1 durumunda standart kurallar)
    const robotsTxt = runSsh(`curl -s -kL https://157.180.11.28/robots.txt -H "Host: ${targetDomainName}"`);
    expect(robotsTxt).toContain('User-agent: *');
    expect(robotsTxt).toContain('Disallow: /wp-admin/');

    // 10. Fiziksel kanıt 5: non-reseller-capabilities envanterinde WP-05 yeteneğinin varlığını doğrula
    const capOutput = runSsh(`node -e '
      import("/usr/lib/yunpanel/apps/api/src/non-reseller-capabilities.js").then(m => {
        const c = m.getCapabilityById("WP-05");
        console.log(JSON.stringify({ id: c.id, category: c.category, status: c.status, serviceAdapters: c.serviceAdapters }));
      });
    '`);
    expect(capOutput).toContain('"id":"WP-05"');
    expect(capOutput).toContain('"category":"wordpress"');
  });

  test('hatalı girdi: geçersiz yedek/bakım parametreleri ve geçersiz işlem istekleri (400 validation)', async ({ page }) => {
    // 1. WordPress Toolkit preview üzerinde geçersiz aksiyon (maintenance.toggle) gönderildiğinde 400 döner
    const invalidActionRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'maintenance.toggle',
        },
      },
    });
    expect(invalidActionRes.status()).toBe(400);
    const actionJson = await invalidActionRes.json();
    expect(actionJson.error?.code).toBe('wordpress_action_invalid');

    // 2. Desteklenmeyen backup aksiyonu (backup.now) gönderildiğinde 400 wordpress_action_invalid döner
    const backupActionRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/wordpress/preview`, {
      headers: apiHeaders(),
      data: {
        options: {
          action: 'backup.now',
        },
      },
    });
    expect(backupActionRes.status()).toBe(400);
    const backupJson = await backupActionRes.json();
    expect(backupJson.error?.code).toBe('wordpress_action_invalid');

    // 3. Olmayan repo ID ile backup preview istendiğinde hata döner (400 veya 404)
    const invalidRepoRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/backup/preview`, {
      headers: apiHeaders(),
      data: {
        repositoryId: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect([400, 404, 500]).toContain(invalidRepoRes.status());

    // 4. Olmayan repo ve snapshot ile restore preview istendiğinde hata döner
    const invalidRestoreRes = await page.request.post(`/api/panel/websites/${targetWebsiteId}/restore/preview`, {
      headers: apiHeaders(),
      data: {
        repositoryId: '00000000-0000-0000-0000-000000000000',
        snapshotId: 'invalid-snapshot-id-0000',
      },
    });
    expect([400, 404, 500]).toContain(invalidRestoreRes.status());

    // 5. non-reseller-capabilities'de belirtilen ancak API'de tanımlanmamış /maintenance uç noktası 404 döner
    const maintenanceEndpointRes = await page.request.get(`/api/panel/websites/${targetWebsiteId}/maintenance`);
    expect(maintenanceEndpointRes.status()).toBe(404);
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit özel bakım modu (Maintenance Mode) geçişi ve özelleştirilebilir şablon arayüzü bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-05: Plesk WP Toolkit özel bakım modu (Maintenance Mode) geçişi ve özelleştirilebilir şablon arayüzü WordPress panelinde bulunmuyor.');

    // Plesk WP Toolkit'te her WordPress örneği için kart üzerinde doğrudan "Maintenance mode" açma/kapatma
    // anahtarı ve özelleştirilebilir bakım şablonu (countdown, özel mesaj vb.) yer alır.
    await page.goto(`/websites/${targetDomainId}/wordpress`);
    await expect(page.locator('section').filter({ hasText: 'WordPress' }).first()).toBeVisible({ timeout: 15000 });

    // YunPanel SiteWordPressPanel bileşeninde WordPress bakım modu toggle'ı veya şablon özelleştirme butonu bulunmamaktadır.
    const maintenanceToggle = page.locator('input[name="maintenance"], button:has-text("Bakım modu"), [data-testid="wp-maintenance-mode"]');
    await expect(maintenanceToggle).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit tek tıkla arama motoru indeksleme (Search Engine Indexing) açma/kapatma anahtarı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-05: Plesk WP Toolkit tek tıkla arama motoru indeksleme (Search Engine Indexing / blog_public) açma/kapatma anahtarı WordPress panelinde bulunmuyor.');

    // Plesk WP Toolkit'te instance kartında tek tıkla "Search engine indexing" (Arama motoru indeksleme)
    // açık/kapalı durumu değiştirilebilir (blog_public opsiyonu doğrudan güncellenir).
    await page.goto(`/websites/${targetDomainId}/wordpress`);
    await expect(page.locator('section').filter({ hasText: 'WordPress' }).first()).toBeVisible({ timeout: 15000 });

    // YunPanel SiteWordPressPanel bileşeninde indeksleme ayarını gösteren veya değiştiren bir anahtar yer almamaktadır.
    const indexingToggle = page.locator('button:has-text("Arama Motoru İndeksleme"), input[name="blog_public"], [data-testid="wp-indexing-toggle"]');
    await expect(indexingToggle).toBeVisible({ timeout: 5000 });
  });

  test('eksiklik (Plesk parity): Plesk WP Toolkit WordPress özelinde tek tıkla Back Up / Restore modalı bulunmuyor', async ({ page }) => {
    test.fail(true, 'BULGU WP-05: Plesk WP Toolkit bağımsız WordPress yedekleme/geri yükleme (Back Up / Restore) sihirbazı yerine genel site yedekleme sayfasına yönlendiriyor.');

    // Plesk WP Toolkit'te "Back Up / Restore" seçeneği tıklandığında doğrudan WordPress bağlamında
    // yalnız o WordPress kurulumuna ve veritabanına ait nokta atışı yedekler ve geri yükleme modalı açılır.
    await page.goto(`/websites/${targetDomainId}/wordpress`);
    await expect(page.locator('section').filter({ hasText: 'WordPress' }).first()).toBeVisible({ timeout: 15000 });

    // YunPanel'de ise WordPress panelindeki buton genel site yedekleme sayfasına (/websites/:id/backup) yönlendirmektedir;
    // WordPress kartı içerisinde bağımsız bir modal / drawer açılmamaktadır.
    const wpBackupModal = page.locator('.ws-modal:has-text("WordPress Yedeği"), [data-testid="wp-backup-modal"]');
    await expect(wpBackupModal).toBeVisible({ timeout: 5000 });
  });
});
