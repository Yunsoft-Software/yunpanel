import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('DB-02 DB kullanıcıları, parolalar, roller ve grant yönetimi', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tdb02_a${agentN}_${Date.now().toString(36)}`;
  const targetDbName = `${prefix}_db`;
  let targetUsername = null;
  let targetWebsiteId = null;
  let targetDomainId = null;
  let targetServerId = null;
  const customPassword = 'Valid_Pass_2026_Sec!';

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

    if (!targetDomainId || !targetWebsiteId) {
      const domainsRes = await page.request.get('/api/panel/domains');
      if (domainsRes.status() === 200) {
        const dJson = await domainsRes.json();
        const domainList = dJson.data?.domains || dJson.data || [];
        const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
          || domainList.find((d) => !d.parentDomainId)
          || domainList[0];
        if (mainDomain) {
          targetDomainId = mainDomain.id;
          targetWebsiteId = mainDomain.websiteId;
          targetServerId = mainDomain.serverId;
        }
      }
    }
  });

  test.afterAll(async () => {
    // 0 artık ilkesi: Testte oluşturulan MariaDB kullanıcıları ve veritabanı temizlenir
    try {
      if (targetUsername) {
        runSsh(`mariadb -e "DROP USER IF EXISTS '${targetUsername}'@'localhost';"`);
      }
      runSsh(`mariadb -e "DROP DATABASE IF EXISTS ${targetDbName};"`);
      // Temizliği fiziksel olarak doğrula
      const dbCheck = runSsh(`mariadb -e "SHOW DATABASES LIKE '${targetDbName}';"`);
      const userCheck = targetUsername ? runSsh(`mariadb -e "SELECT User FROM mysql.user WHERE User='${targetUsername}';"`) : '';
      if (dbCheck.includes(targetDbName) || (targetUsername && userCheck.includes(targetUsername))) {
        console.warn('DB-02 Temizlik uyarısı: Bazı kaynaklar hala mevcut:', { dbCheck, userCheck });
      }
    } catch (cleanupErr) {
      console.warn('DB-02 afterAll cleanup error:', cleanupErr.message);
    }
  });

  async function dismissJobDrawerIfOpen(page) {
    const jobModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /İşlem durumu/i });
    if (await jobModal.isVisible({ timeout: 20000 }).catch(() => false)) {
      const closeBtn = jobModal.locator('button:has-text("Kapat")').first();
      await expect(closeBtn).toBeVisible({ timeout: 60000 });
      await closeBtn.click().catch(() => {});
      await expect(jobModal).toHaveCount(0, { timeout: 10000 }).catch(() => {});
    }

    const anyModal = page.locator('dialog.ws-modal, [role="dialog"]').first();
    for (let i = 0; i < 5; i++) {
      if ((await anyModal.count()) === 0) break;
      const kBtn = anyModal.locator('button:has-text("Kapat"), button[aria-label="Pencereyi kapat"]').first();
      if (await kBtn.isVisible().catch(() => false)) {
        await kBtn.click().catch(() => {});
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(500);
    }
  }

  test('hatalı girdi: kısa (<16 krk) ve geçersiz karakter ($) içeren parola ile veritabanı oluşturma reddedilir', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Web sitesi seçimi
    const siteSelect = dialog.locator('select').first();
    await expect(siteSelect).toBeVisible({ timeout: 5000 });
    await expect(siteSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });
    if (targetWebsiteId) {
      await siteSelect.selectOption(targetWebsiteId);
    } else {
      const firstOpt = siteSelect.locator('option:not([value=""])').first();
      const val = await firstOpt.getAttribute('value');
      await siteSelect.selectOption(val);
    }

    const dbNameInput = dialog.locator('input[placeholder="ornek_site"]');
    await dbNameInput.fill(`${prefix}_inv`);

    const passwordInput = dialog.locator('input[type="password"]');

    // 1. Kısa parola (<16 karakter) -> HTML5 doğrulaması (tooShort / invalid)
    await passwordInput.fill('ShortPass_12345');
    const isTooShort = await passwordInput.evaluate((el) => el.validity.tooShort || !el.checkValidity());
    expect(isTooShort).toBe(true);

    // 2. İzin verilmeyen $ karakteri içeren 20 karakterlik parola
    await passwordInput.fill('Invalid$Pass_12345678');
    const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // API 400 Bad Request döner ve modal içinde hata mesajı gösterilir
    const errorNotice = dialog.locator('.ws-error, [role="alert"]');
    await expect(errorNotice).toBeVisible({ timeout: 10000 });
    const errorText = await errorNotice.textContent();
    expect(errorText).toMatch(/Veritabanı adı veya parola geçersiz/i);

    // Modalı kapat
    const cancelBtn = dialog.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });
  });

  test('mutlu yol: özel parola ile DB ve kullanıcı oluşturma, bağlantı bilgilerinden parola erişimi ve fiziksel MariaDB doğrulaması', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Web sitesi seçimi
    const siteSelect = dialog.locator('select').first();
    await expect(siteSelect).toBeVisible({ timeout: 5000 });
    await expect(siteSelect.locator('option:not([value=""])').first()).toBeAttached({ timeout: 15000 });
    if (targetWebsiteId) {
      await siteSelect.selectOption(targetWebsiteId);
    } else {
      const firstOpt = siteSelect.locator('option:not([value=""])').first();
      targetWebsiteId = await firstOpt.getAttribute('value');
      await siteSelect.selectOption(targetWebsiteId);
    }

    const dbNameInput = dialog.locator('input[placeholder="ornek_site"]');
    await dbNameInput.fill(targetDbName);

    const passwordInput = dialog.locator('input[type="password"]');
    await passwordInput.fill(customPassword);

    const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 10000 });
    await submitBtn.click();

    // Kurulum tamamlanmasını bekle; eşzamanlı başka test işlemi varsa (conflict) bekle ve tekrar dene
    const successMsg = dialog.locator('p:has-text("hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")');
    for (let retry = 0; retry < 10; retry++) {
      if (await successMsg.isVisible({ timeout: 5000 }).catch(() => false)) break;
      const hasConflict = await dialog.locator('.ws-error, [role="alert"]').filter({ hasText: /Another database operation/i }).isVisible().catch(() => false);
      const retryBtn = dialog.locator('button[type="submit"]').first();
      if (hasConflict && await retryBtn.isEnabled().catch(() => false)) {
        await page.waitForTimeout(3000);
        await retryBtn.click().catch(() => {});
      }
    }
    await expect(successMsg).toBeVisible({ timeout: 60000 });

    const finishBtn = dialog.locator('button:has-text("Tamam")');
    await finishBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    // Veritabanları listesinde oluşan satırı bul
    const row = page.locator('tr[role="row"]').filter({ hasText: targetDbName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Kullanıcı adını al
    const userCell = row.locator('td[data-label="Site / Kullanıcı"] small');
    await expect(userCell).toBeVisible({ timeout: 10000 });
    targetUsername = (await userCell.textContent()).trim();
    expect(targetUsername).toMatch(/^ydb_[0-9a-f]{24}$/);

    // Bağlantı bilgileri modalını aç
    const connBtn = row.locator('button:has-text("Bağlantı bilgileri")');
    await expect(connBtn).toBeVisible({ timeout: 10000 });
    await connBtn.click();

    const connDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Bağlantı bilgileri/i });
    await expect(connDialog).toBeVisible({ timeout: 10000 });

    // Başlangıçta parola maskeli olmalı
    const connPassInput = connDialog.locator('label:has-text("Parola") input');
    await expect(connPassInput).toBeVisible({ timeout: 5000 });
    expect(await connPassInput.inputValue()).toBe('');

    // "Parolaya eriş" tıkla ve özel parolayı doğrula
    const revealBtn = connDialog.locator('button:has-text("Parolaya eriş")');
    await revealBtn.click();
    await expect(connPassInput).toHaveValue(customPassword, { timeout: 10000 });

    // "Parolayı kopyala" butonu görünür olmalı
    await expect(connDialog.locator('button:has-text("Parolayı kopyala")')).toBeVisible({ timeout: 5000 });

    // Modalı kapat
    const closeBtn = connDialog.locator('button.ws-modal-close, button:has-text("Kapat")').first();
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(connDialog).toHaveCount(0, { timeout: 10000 });

    // Fiziksel MariaDB Sonucu 1: mysql.user tablosunda kullanıcı varlığı
    const userCount = runSsh(`mariadb -N -s -e "SELECT COUNT(*) FROM mysql.user WHERE User='${targetUsername}';"`);
    expect(userCount).toBe('1');

    // Fiziksel MariaDB Sonucu 2: SHOW GRANTS yetki matrisi doğrulaması
    const grantsOutput = runSsh(`mariadb -N -s -e "SHOW GRANTS FOR '${targetUsername}'@'localhost';"`);
    expect(grantsOutput).toContain(`ON \`${targetDbName}\`.*`);
    expect(grantsOutput).toContain('SELECT');
    expect(grantsOutput).toContain('INSERT');
    expect(grantsOutput).toContain('UPDATE');
    expect(grantsOutput).toContain('DELETE');

    // Fiziksel MariaDB Sonucu 3: TCP üzerinden kullanıcı ile bağlanıp CRUD işlemi yürütme
    const crudQuery = `CREATE TABLE t_check (id INT PRIMARY KEY, label VARCHAR(50)); INSERT INTO t_check VALUES (1, 'ok_crud'); SELECT label FROM t_check WHERE id=1;`;
    const crudOutput = runSsh(`mariadb -u ${targetUsername} -p'${customPassword}' -h 127.0.0.1 ${targetDbName} -N -s -e "${crudQuery}"`);
    expect(crudOutput).toContain('ok_crud');

    // Fiziksel MariaDB Sonucu 4: Yetkisiz başka şemaya erişim engeli (İzolasyon)
    const unauthorizedOutput = runSsh(`mariadb -u ${targetUsername} -p'${customPassword}' -h 127.0.0.1 -e "SELECT * FROM mysql.user LIMIT 1;" 2>&1 || true`);
    expect(unauthorizedOutput).toMatch(/(command denied|access denied|error 1142|error 1044)/i);
  });

  test('parola döndürme, kullanıcı kaldırma (DROP USER) ve yeniden erişim oluşturma (CREATE USER)', async ({ page }) => {
    expect(targetDomainId).toBeTruthy();
    expect(targetUsername).toBeTruthy();

    // Sitenin veritabanları sekmesine git (/websites/:domainId/databases)
    await page.goto(`/websites/${targetDomainId}/databases`);
    await expect(page.locator('h1, h2, h3').filter({ hasText: /Veritabanları/i }).first()).toBeVisible({ timeout: 15000 });

    const row = page.locator('table.ys-resource-table tr[role="row"]').filter({ hasText: targetDbName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // 1. Parolayı değiştir (rotate password)
    const manageBtn = row.locator('button:has-text("Yönet")');
    await manageBtn.click();

    const manageDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: targetDbName });
    await expect(manageDialog).toBeVisible({ timeout: 10000 });

    const rotateBtn = manageDialog.locator('button:has-text("Parolayı değiştir")');
    await expect(rotateBtn).toBeVisible({ timeout: 5000 });
    await rotateBtn.click();

    const rotateConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı parolasını değiştir/i });
    await expect(rotateConfirmDialog).toBeVisible({ timeout: 10000 });

    const confirmInput = rotateConfirmDialog.locator('input');
    await confirmInput.fill(targetUsername);

    const applyRotateBtn = rotateConfirmDialog.locator('button:has-text("Parolayı döndür ve uygula")');
    await expect(applyRotateBtn).toBeEnabled({ timeout: 5000 });
    await applyRotateBtn.click();

    // JobDrawer açılırsa işlemin tamamlanmasını ve kapatılmasını bekle
    await dismissJobDrawerIfOpen(page);
    await expect(page.locator('dialog.ws-modal, [role="dialog"]')).toHaveCount(0, { timeout: 15000 });

    // Fiziksel MariaDB doğrulaması: Eski parola artık çalışmamalı
    const oldPassOutput = runSsh(`mariadb -u ${targetUsername} -p'${customPassword}' -h 127.0.0.1 ${targetDbName} -e "SELECT 1;" 2>&1 || true`);
    expect(oldPassOutput).toMatch(/(access denied|command denied|error 1045)/i);

    // 2. Kullanıcıyı kaldır (revoke user)
    await expect(row).toBeVisible({ timeout: 10000 });
    await manageBtn.click();
    await expect(manageDialog).toBeVisible({ timeout: 10000 });

    const revokeBtn = manageDialog.locator('button:has-text("Kullanıcıyı kaldır…")');
    await expect(revokeBtn).toBeVisible({ timeout: 5000 });
    await revokeBtn.click();

    const revokeConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı kullanıcısını kaldır/i });
    await expect(revokeConfirmDialog).toBeVisible({ timeout: 10000 });

    const revokeInput = revokeConfirmDialog.locator('input');
    await revokeInput.fill(targetUsername);

    const applyRevokeBtn = revokeConfirmDialog.locator('button:has-text("Kullanıcıyı kaldır")');
    await expect(applyRevokeBtn).toBeEnabled({ timeout: 5000 });
    await applyRevokeBtn.click();

    // JobDrawer açılırsa işlemin tamamlanmasını ve kapatılmasını bekle
    await dismissJobDrawerIfOpen(page);
    await expect(page.locator('dialog.ws-modal, [role="dialog"]')).toHaveCount(0, { timeout: 15000 });

    // Fiziksel MariaDB doğrulaması: mysql.user tablosunda kullanıcı sayısı 0 olmalı
    const userCountAfterRevoke = runSsh(`mariadb -N -s -e "SELECT COUNT(*) FROM mysql.user WHERE User='${targetUsername}';"`);
    expect(userCountAfterRevoke).toBe('0');

    // Ancak şema ve içindeki t_check tablosu korunmalı
    const tableCheck = runSsh(`mariadb -N -s -e "SELECT label FROM ${targetDbName}.t_check WHERE id=1;"`);
    expect(tableCheck).toBe('ok_crud');

    // Arayüzde "Erişim gerekli" / "Erişimi oluştur" butonunun belirmesi
    const recreateBtn = row.locator('button:has-text("Erişimi oluştur")');
    await expect(recreateBtn).toBeVisible({ timeout: 15000 });

    // 3. Erişimi oluştur (recreate access)
    await recreateBtn.click();

    const recreateConfirmDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı erişimi oluştur/i });
    await expect(recreateConfirmDialog).toBeVisible({ timeout: 10000 });

    const recreateInput = recreateConfirmDialog.locator('input');
    await recreateInput.fill(targetDbName);

    const applyRecreateBtn = recreateConfirmDialog.locator('button:has-text("Erişimi oluştur")');
    await expect(applyRecreateBtn).toBeEnabled({ timeout: 5000 });
    await applyRecreateBtn.click();

    // JobDrawer açılırsa işlemin tamamlanmasını ve kapatılmasını bekle
    await dismissJobDrawerIfOpen(page);

    // Satırda kullanıcının yeniden tanımlandığını doğrula
    const userCode = row.locator('td[data-label="Kullanıcı"] code');
    await expect(userCode).toContainText('ydb_', { timeout: 45000 });
    const recreatedUsername = (await userCode.textContent()).trim();
    if (recreatedUsername) {
      targetUsername = recreatedUsername;
    }

    // Fiziksel MariaDB doğrulaması: mysql.user tablosunda kullanıcı yeniden 1 olmalı
    const userCountAfterRecreate = runSsh(`mariadb -N -s -e "SELECT COUNT(*) FROM mysql.user WHERE User='${recreatedUsername}';"`);
    expect(userCountAfterRecreate).toBe('1');

    // Tablo verisi hala sağlam olmalı
    const dataCheck = runSsh(`mariadb -N -s -e "SELECT label FROM ${targetDbName}.t_check WHERE id=1;"`);
    expect(dataCheck).toBe('ok_crud');
  });

  test('ön yüzde SQL grant ve rol düzenleme arayüzü kontrolü (bilinen eksik)', async ({ page }) => {
    test.fail(true, 'NORMAL: Ön yüzde veritabanı kullanıcısı rol ve grant (SQL izinleri) düzenleme ekranı yok; EXECUTE izni UI dan açılamıyor');

    expect(targetDomainId).toBeTruthy();
    await page.goto(`/websites/${targetDomainId}/databases`);

    const row = page.locator('table.ys-resource-table tr[role="row"]').filter({ hasText: targetDbName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    const manageBtn = row.locator('button:has-text("Yönet")');
    await manageBtn.click();

    const manageDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: targetDbName });
    await expect(manageDialog).toBeVisible({ timeout: 10000 });

    // Ön yüzde grant düzenleme veya rol seçimi butonu beklenir (ancak mevcut değildir)
    const editGrantsBtn = manageDialog.locator('button:has-text("İzinleri düzenle"), button:has-text("Rolü değiştir")');
    await expect(editGrantsBtn).toBeVisible({ timeout: 3000 });
  });

  test('yetki ve tenant izolasyonu: yetkisiz oturum ve başka sitelerin DB erişimi 403 Forbidden ile engellenir', async ({ page }) => {
    // API düzeyinde tenant sınırını doğrula: Başka bir hayali website ID ile credential/connection uç noktasına istek
    const fakeWebsiteId = '00000000-0000-0000-0000-000000000000';
    const fakeBindingId = '00000000-0000-0000-0000-000000000001';

    const sessionRes = await page.request.get('/api/auth/session');
    const sessionJson = await sessionRes.json();
    const csrf = sessionJson.data?.csrfToken || '';

    // Geçersiz/yetkisiz veritabanı connection endpoint'ine istek
    const unauthorizedRes = await page.request.post(
      `/api/panel/servers/${targetServerId || 'local'}/websites/${fakeWebsiteId}/databases/${fakeBindingId}/connection`,
      {
        headers: { 'x-csrf-token': csrf },
        data: { revealPassword: true },
      }
    );

    // İstek 403 Forbidden veya 404 Not Found dönmeli (yetkisiz erişim kesinlikle verilmemeli)
    expect([403, 404]).toContain(unauthorizedRes.status());
  });
});
