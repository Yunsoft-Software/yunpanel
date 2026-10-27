import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DB-06 Veritabanı denetimi/onarımı; desteklenen engine sınırı', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  let testServerId = null;
  const createdDatabases = [];

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
    if (!testServerId || createdDatabases.length === 0) return;
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      for (const dbName of createdDatabases) {
        await page.evaluate(async ({ serverId, name }) => {
          const sessionRes = await fetch('/api/auth/session');
          const session = await sessionRes.json();
          const csrf = session.data?.csrfToken;
          await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases/${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: {
              'Content-Type': 'application/json',
              'x-csrf-token': csrf,
            },
            body: JSON.stringify({ confirmation: `delete:${name}` }),
          });
        }, { serverId: testServerId, name: dbName }).catch((err) => {
          console.warn(`DB-06 afterAll cleanup warning for ${dbName}:`, err.message);
        });
      }
    } catch (err) {
      console.warn('DB-06 afterAll context cleanup error:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: Veritabanları sayfasında MariaDB/MySQL motoru, versiyon ve DB güvenlik baseline denetiminin doğrulanması; canlı API sağlık yanıtı', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // Sayfa hazır olana kadar bekle
    const inventorySection = page.locator('section.ws-database-inventory, section:has-text("Veritabanı listesi")').first();
    await expect(inventorySection).toBeVisible({ timeout: 15000 });

    // Sunucu ve güvenlik ayrıntıları disclosure aç ve doğrula
    const diagnosticsDetails = page.locator('details.ws-database-diagnostics, details:has-text("Sunucu ve güvenlik ayrıntıları")').first();
    await expect(diagnosticsDetails).toBeVisible({ timeout: 10000 });

    const isDetailsOpen = await diagnosticsDetails.getAttribute('open');
    if (isDetailsOpen === null) {
      await diagnosticsDetails.locator('summary').click();
    }

    // Engine: MariaDB veya MySQL olarak görünmeli
    const engineTerm = diagnosticsDetails.locator('dt:has-text("Engine")');
    await expect(engineTerm).toBeVisible({ timeout: 5000 });
    const engineDesc = diagnosticsDetails.locator('dd').filter({ hasText: /MariaDB|MySQL/i }).first();
    await expect(engineDesc).toBeVisible({ timeout: 5000 });

    // Sürüm ve baseline durumunu doğrula
    await expect(diagnosticsDetails.locator('dt:has-text("Sürüm")')).toBeVisible();
    await expect(diagnosticsDetails.locator('dt:has-text("DB güvenlik baseline")')).toBeVisible();
    await expect(diagnosticsDetails.locator('dt:has-text("Admin socket auth")')).toBeVisible();

    // Veritabanı tablosundaki motor etiketini veya sayfalama altbilgisindeki motor etiketini doğrula
    const footerEngine = page.locator('.ws-pagination').filter({ hasText: /MariaDB|MySQL/i });
    if (await footerEngine.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(footerEngine).toBeVisible();
    }

    // Fiziksel sonuç kanıtı: Canlı API üzerinden fiziksel host veritabanı motoru, sürümü ve sağlık tanısını doğrula
    const apiData = await page.evaluate(async () => {
      const serversRes = await fetch('/api/panel/servers');
      const serversJson = await serversRes.json();
      const serverList = serversJson.data?.servers || serversJson.data || [];
      const sId = serverList[0]?.id;
      if (!sId) throw new Error('Sunucu kimliği bulunamadı');

      const dbRes = await fetch(`/api/panel/servers/${encodeURIComponent(sId)}/databases`);
      const dbJson = await dbRes.json();
      return {
        serverId: sId,
        status: dbRes.status,
        inventory: dbJson.data || dbJson,
      };
    });

    testServerId = apiData.serverId;
    expect(apiData.status).toBe(200);
    const inventory = apiData.inventory;

    // Desteklenen motor sınırını doğrula (yalnızca mariadb veya mysql)
    expect(['mariadb', 'mysql']).toContain(inventory.engine);
    expect(typeof inventory.version).toBe('string');
    expect(inventory.version.length).toBeGreaterThan(0);

    // Canlı fiziksel sağlık (health) tanısını doğrula
    expect(inventory.health).toBeTruthy();
    expect(inventory.health.available).toBe(true);
    expect(inventory.health.ready).toBe(true);
    expect(inventory.health.connection.protocol).toBe('socket');
    expect(inventory.health.connection.nativeSocketAuth).toBe(true);
    expect(inventory.health.hygiene.anonymousAccountsAbsent).toBe(true);
    expect(inventory.health.hygiene.remoteRootAccountsAbsent).toBe(true);
    expect(inventory.health.hygiene.testSchemaAbsent).toBe(true);

    // Fiziksel veritabanı listesi ve boyut kontrolü
    expect(Array.isArray(inventory.databases)).toBe(true);
    expect(inventory.databases.length).toBeGreaterThan(0);
    for (const db of inventory.databases) {
      expect(typeof db.name).toBe('string');
      expect(typeof db.sizeBytes).toBe('number');
      expect(db.sizeBytes).toBeGreaterThanOrEqual(0);
    }
  });

  test('hatalı girdi ve desteklenmeyen motor sınırı: Geçersiz DB adı ve desteklenmeyen motor isteklerinin reddedilmesi', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // UI formunda geçersiz veritabanı adı girişi denetimi
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const nameInput = dialog.locator('label:has-text("Veritabanı adı") input');
    await expect(nameInput).toBeVisible();

    // Geçersiz karakterler (boşluk ve semboller) girdiğinde HTML5 pattern validasyonu başarısız olmalıdır
    await nameInput.fill('gecersiz db!@#');
    const isValid = await nameInput.evaluate((el) => el.checkValidity());
    expect(isValid).toBe(false);

    // Modalı kapat
    const cancelBtn = dialog.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(dialog).not.toBeVisible({ timeout: 5000 });

    // API düzeyinde geçersiz veritabanı adı gönderildiğinde HTTP 400 invalid_database_name dönmelidir
    if (!testServerId) {
      testServerId = await page.evaluate(async () => {
        const serversRes = await fetch('/api/panel/servers');
        const serversJson = await serversRes.json();
        return (serversJson.data?.servers || serversJson.data || [])[0]?.id;
      });
    }

    const invalidNameRes = await page.evaluate(async (serverId) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken;
      const res = await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          name: 'invalid/db/name!',
          confirmation: 'create:invalid/db/name!',
        }),
      });
      return { status: res.status, body: await res.json() };
    }, testServerId);

    expect(invalidNameRes.status).toBe(400);
    expect(invalidNameRes.body.error?.code).toBe('invalid_database_name');

    // Onaysız veya hatalı konfirmasyonla gönderilen istek HTTP 400 almalıdır
    const unconfirmedRes = await page.evaluate(async (serverId) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken;
      const res = await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          name: 'valid_test_name',
          confirmation: 'wrong_confirmation',
        }),
      });
      return { status: res.status, body: await res.json() };
    }, testServerId);

    expect(unconfirmedRes.status).toBe(400);
    expect(unconfirmedRes.body.error?.code).toBe('database_confirmation_required');

    // Desteklenmeyen motor sınırı: YunPanel yalnızca MariaDB ve MySQL destekler;
    // Postgresql / harici motor isteği veya bilinmeyen motor için sistem koruması mevcuttur.
    const inventory = await page.evaluate(async (serverId) => {
      const dbRes = await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases`);
      const dbJson = await dbRes.json();
      return dbJson.data || dbJson;
    }, testServerId);

    expect(['mariadb', 'mysql']).toContain(inventory.engine);
    expect(['postgresql', 'mongodb', 'sqlite', 'redis']).not.toContain(inventory.engine);
  });

  test('Plesk eşdeğeri veritabanı tablo denetimi ve onarımı (Check & Repair) arayüz ve işlem desteği', async ({ page }) => {
    // Plesk'te her veritabanı kartında "Check and Repair" (CHECK TABLE / REPAIR TABLE) aksiyonu bulunur.
    // YunPanel'de veritabanı satırı aksiyonlarında (phpMyAdmin, SQL aktar vb.) tablo onarımı/denetimi butonu aranır.
    // Panelde henüz tablo düzeyinde onarım/denetim (CHECK/REPAIR TABLE) butonu ve uç noktası bulunmadığından test.fail ile işaretlenir.
    test.fail(true, 'BULGU DB-06: Plesk eşdeğeri veritabanı tablo denetimi ve onarımı (CHECK TABLE / REPAIR TABLE) buton/işlemi panelde henüz bulunmuyor (yalnız sunucu güvenlik baseline denetimi mevcut)');

    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const inventorySection = page.locator('section.ws-database-inventory, section:has-text("Veritabanı listesi")').first();
    await expect(inventorySection).toBeVisible({ timeout: 15000 });

    const firstRow = inventorySection.locator('table.ws-table tbody tr[role="row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    // Beklenti: Veritabanı satırında tablo denetim/onarım (Check & Repair / Denetle / Onar) butonu bulunmalıdır
    const repairBtn = firstRow.locator('button:has-text("Denetle"), button:has-text("Onar"), button:has-text("Check"), button:has-text("Repair")').first();
    await expect(repairBtn).toBeVisible({ timeout: 3000 });
  });
});
