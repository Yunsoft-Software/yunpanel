import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DB-03 Uzak erişim, izinli kaynaklar ve bağlantı bilgileri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '4';
  const runId = Date.now().toString(36);
  const testDbName = `tdb03_a${agentN}_${runId}`;
  let sshAlias = null;
  let testServerId = null;
  let testWebsiteId = null;
  let testDomainId = null;
  let createdBindingId = null;
  let createdCredentialId = null;
  let createdCredentialUsername = null;
  let revealedPassword = null;

  test.beforeAll(() => {
    if (existsSync('.local/test-server.env')) {
      const config = Object.fromEntries(
        readFileSync('.local/test-server.env', 'utf8')
          .split('\n')
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
          })
      );
      sshAlias = config.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    }
  });

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
    // 1. Panel arayüzü ve API üzerinden temizlik
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

      if (testServerId && testWebsiteId) {
        // Site üzerindeki veritabanı kaynaklarını listele
        const res = await page.request.get(
          `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/${encodeURIComponent(testWebsiteId)}/database-resources`
        );
        if (res.status() === 200) {
          const json = await res.json();
          const dbs = json.data?.databases || [];
          const matched = dbs.filter(
            (d) => d.binding?.databaseName === testDbName || d.binding?.databaseName?.startsWith(`tdb03_a${agentN}`)
          );

          for (const item of matched) {
            const b = item.binding;
            const c = item.credential;

            // Önce kullanıcıyı kaldır (varsa)
            if (c) {
              await page.evaluate(
                async ({ sId, credId }) => {
                  const sRes = await fetch('/api/auth/session');
                  const sJson = await sRes.json();
                  const csrf = sJson.data?.csrfToken;
                  const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

                  const prevRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(sId)}/database-credentials/${encodeURIComponent(credId)}/delete-preview`,
                    { headers }
                  );
                  if (prevRes.status !== 200) return;
                  const prevJson = await prevRes.json();
                  const preview = prevJson.data;

                  const qRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(sId)}/database-credentials/${encodeURIComponent(credId)}/delete`,
                    {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        expectedCredentialRevision: preview.expectedCredentialRevision,
                        expectedBindingRevision: preview.expectedBindingRevision,
                        expectedDesiredStateSha256: preview.desiredStateSha256,
                        confirmation: preview.confirmation,
                      }),
                    }
                  );
                  if (qRes.status !== 202) return;
                  const qJson = await qRes.json();
                  const jobId = qJson.data?.job?.id;
                  if (jobId) {
                    for (let i = 0; i < 30; i++) {
                      await new Promise((r) => setTimeout(r, 1000));
                      const jRes = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}`);
                      const jJson = await jRes.json();
                      if (jJson.data?.status === 'succeeded') {
                        await fetch(
                          `/api/panel/servers/${encodeURIComponent(sId)}/database-credentials/${encodeURIComponent(credId)}/delete/finalize`,
                          {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({
                              expectedCredentialRevision: preview.expectedCredentialRevision,
                              expectedBindingRevision: preview.expectedBindingRevision,
                              completedDeleteJobId: jobId,
                            }),
                          }
                        );
                        break;
                      }
                      if (jJson.data?.status === 'failed') break;
                    }
                  }
                },
                { sId: testServerId, credId: c.id }
              ).catch(() => {});
            }

            // Ardından veritabanını sil
            await page.evaluate(
              async ({ sId, dbName }) => {
                const sRes = await fetch('/api/auth/session');
                const sJson = await sRes.json();
                const csrf = sJson.data?.csrfToken;
                await fetch(`/api/panel/servers/${encodeURIComponent(sId)}/databases/${encodeURIComponent(dbName)}`, {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
                  body: JSON.stringify({ confirmation: `delete:${dbName}` }),
                });
              },
              { sId: testServerId, dbName: b.databaseName }
            ).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.warn('DB-03 afterAll UI/API cleanup warning:', e.message);
    } finally {
      await context.close().catch(() => {});
    }

    // 2. SSH ile doğrudan MariaDB fiziksel temizlik ve doğrulama
    if (sshAlias) {
      try {
        const cleanupCmd = `mariadb -e "DROP DATABASE IF EXISTS \\\`${testDbName}\\\`; DROP USER IF EXISTS '${createdCredentialUsername || ''}'@'localhost'; FLUSH PRIVILEGES;"`;
        execFileSync('ssh', [sshAlias, cleanupCmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

        // Temizlik kontrolü
        const checkDb = execFileSync(
          'ssh',
          [sshAlias, `mariadb -e "SHOW DATABASES LIKE '${testDbName}';"`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
        expect(checkDb).not.toContain(testDbName);

        if (createdCredentialUsername) {
          const checkUser = execFileSync(
            'ssh',
            [sshAlias, `mariadb -e "SELECT User FROM mysql.user WHERE User='${createdCredentialUsername}';"`],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
          );
          expect(checkUser).not.toContain(createdCredentialUsername);
        }
      } catch (err) {
        console.warn('DB-03 afterAll SSH cleanup check warning:', err.message);
      }
    }
  });

  test('mutlu yol: Veritabanı ve kullanıcısı oluşturma, Bağlantı bilgileri modalı, Parolaya eriş/kopyala, denetim kaydı ve fiziksel MariaDB bağlantısı', async ({
    page,
    context,
  }) => {
    // 1. Global /databases sayfasına git
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // Server ID ve web sitelerini al
    const serverInfo = await page.evaluate(async () => {
      const serversRes = await fetch('/api/panel/servers');
      const serversJson = await serversRes.json();
      const serverList = serversJson.data?.servers || serversJson.data || [];
      const sId = serverList[0]?.id;

      const domainsRes = await fetch('/api/panel/domains');
      const domainsJson = await domainsRes.json();
      const domainList = domainsJson.data?.domains || domainsJson.data || [];
      const mainDomain = domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
        || domainList.find((d) => !d.parentDomainId)
        || domainList[0];

      return {
        serverId: sId,
        websiteId: mainDomain?.websiteId,
        domainId: mainDomain?.id,
      };
    });

    testServerId = serverInfo.serverId;
    testWebsiteId = serverInfo.websiteId;
    testDomainId = serverInfo.domainId;
    expect(testServerId).toBeTruthy();
    expect(testWebsiteId).toBeTruthy();

    // 2. Arayüzden Veritabanı oluştur butonuna tıkla
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeVisible({ timeout: 10000 });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    const setupDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(setupDialog).toBeVisible({ timeout: 10000 });

    // Web sitesi seç
    const siteSelect = setupDialog.locator('select').first();
    if (await siteSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await siteSelect.selectOption(testWebsiteId);
    }

    // Veritabanı adını doldur
    const dbNameInput = setupDialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
    await expect(dbNameInput).toBeVisible({ timeout: 5000 });
    await dbNameInput.fill(testDbName);

    // Formu gönder
    const submitBtn = setupDialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // Başarı mesajını bekle
    const successMsg = setupDialog.locator('p:has-text("hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")');
    await expect(successMsg).toBeVisible({ timeout: 60000 });

    // Tamam butonuna basıp modalı kapat
    const finishBtn = setupDialog.locator('button:has-text("Tamam")');
    await expect(finishBtn).toBeVisible({ timeout: 5000 });
    await finishBtn.click();
    await expect(setupDialog).toHaveCount(0, { timeout: 10000 });

    // 3. Tabloda oluşturulan veritabanını bul
    const row = page.locator('tr[role="row"]').filter({ hasText: testDbName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Satırdaki Bağlantı bilgileri butonuna tıkla
    const connBtn = row.locator('button:has-text("Bağlantı bilgileri")');
    await expect(connBtn).toBeVisible({ timeout: 10000 });
    await connBtn.click();

    // 4. Bağlantı bilgileri modalını doğrula
    const connDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Bağlantı bilgileri/i });
    await expect(connDialog).toBeVisible({ timeout: 10000 });
    await expect(connDialog).toContainText(testDbName);
    await expect(connDialog).toContainText('localhost');
    await expect(connDialog).toContainText('3306');

    // Varsayılan maskeli parola durumunu doğrula (placeholder: Güvenli depoda saklanıyor, value: boş)
    const passwordInput = connDialog.locator('label:has-text("Parola") input[type="password"]');
    await expect(passwordInput).toBeVisible({ timeout: 5000 });
    await expect(passwordInput).toHaveAttribute('placeholder', 'Güvenli depoda saklanıyor');
    const initialPasswordVal = await passwordInput.inputValue();
    expect(initialPasswordVal).toBe('');

    // Parolaya eriş butonunu bul ve tıkla
    const revealBtn = connDialog.locator('button:has-text("Parolaya eriş")');
    await expect(revealBtn).toBeVisible({ timeout: 5000 });
    await revealBtn.click();

    // Parola çözülünce input value dolmalı
    await expect(async () => {
      const val = await passwordInput.inputValue();
      expect(val.length).toBeGreaterThanOrEqual(16);
    }).toPass({ timeout: 10000 });

    revealedPassword = await passwordInput.inputValue();
    expect(revealedPassword).toBeTruthy();

    // Parolayı kopyala butonunun görünür olduğunu doğrula
    const copyBtn = connDialog.locator('button:has-text("Parolayı kopyala")');
    await expect(copyBtn).toBeVisible({ timeout: 5000 });

    // Panoya kopyalama izni ver ve kopyala
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    await copyBtn.click();

    // 5. Oluşturulan veritabanı bağlamından binding ve credential bilgilerini al
    const bindingInfo = await page.evaluate(
      async ({ sId, wId, dbName }) => {
        const res = await fetch(
          `/api/panel/servers/${encodeURIComponent(sId)}/websites/${encodeURIComponent(wId)}/database-resources`
        );
        const json = await res.json();
        const dbs = json.data?.databases || [];
        const found = dbs.find((d) => d.binding?.databaseName === dbName);
        return {
          bindingId: found?.binding?.id,
          credentialId: found?.credential?.id,
          username: found?.credential?.username,
          host: found?.credential?.host,
        };
      },
      { sId: testServerId, wId: testWebsiteId, dbName: testDbName }
    );

    createdBindingId = bindingInfo.bindingId;
    createdCredentialId = bindingInfo.credentialId;
    createdCredentialUsername = bindingInfo.username;

    expect(createdBindingId).toBeTruthy();
    expect(createdCredentialId).toBeTruthy();
    expect(createdCredentialUsername).toMatch(/^ydb_/);
    expect(bindingInfo.host).toBe('localhost');

    // Modalı kapat
    const closeBtn = connDialog.locator('button[aria-label="Kapat"], button:has-text("Kapat")').first();
    if (await closeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(connDialog).toHaveCount(0, { timeout: 10000 });

    // 6. Denetim (audit) kaydını doğrula: database.credential.reveal kaydı parola sızdırmadan düşmüş olmalı
    const auditRes = await page.evaluate(async () => {
      const res = await fetch('/api/panel/audit?action=database.credential.reveal&limit=5');
      return { status: res.status, json: await res.json() };
    });
    expect(auditRes.status).toBe(200);
    const auditEvents = auditRes.json.data?.events || auditRes.json.data || [];
    const revealEvent = auditEvents.find(
      (e) => e.action === 'database.credential.reveal' && e.resourceId === createdCredentialId
    ) || auditEvents[0];
    expect(revealEvent).toBeTruthy();
    expect(revealEvent.action).toBe('database.credential.reveal');
    expect(revealEvent.outcome).toBe('accepted');
    // Parolanın audit verisinde sızmadığını doğrula
    expect(JSON.stringify(revealEvent)).not.toContain(revealedPassword);

    // 7. Fiziksel Sonuç: Gerçek MariaDB bağlantısını test et
    // SSH üzerinden oluşturulan kullanıcı ve parola ile MariaDB'ye bağlan, tablo oluştur ve veri sorgula
    if (sshAlias) {
      const testSql = `mariadb -h localhost -P 3306 -u ${createdCredentialUsername} -p'${revealedPassword.replace(/'/g, "'\\''")}' ${testDbName} -e "CREATE TABLE IF NOT EXISTS tdb03_proof (id INT PRIMARY KEY, marker VARCHAR(30)); INSERT INTO tdb03_proof VALUES (1, 't831_ok'); SELECT marker FROM tdb03_proof WHERE id=1;"`;
      const sqlOut = execFileSync('ssh', [sshAlias, testSql], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(sqlOut).toContain('t831_ok');
    }
  });

  test('hatalı girdi ve API sınır değerleri: Geçersiz DB adı/parola reddi ve bozuk bağlantı isteğinde 400/404', async ({
    page,
  }) => {
    // 1. Veritabanı kurulumu negatif girdileri
    const setupInvalidChecks = await page.evaluate(
      async ({ sId, wId }) => {
        const sRes = await fetch('/api/auth/session');
        const sJson = await sRes.json();
        const csrf = sJson.data?.csrfToken;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
        const url = `/api/panel/servers/${encodeURIComponent(sId)}/websites/${encodeURIComponent(wId)}/databases`;

        const r1 = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ databaseName: 'mysql', mode: 'create', expectedWebsiteRevision: 1 }),
        });
        const r2 = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ databaseName: 'invalid-hyphen-db', mode: 'create', expectedWebsiteRevision: 1 }),
        });
        const r3 = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            databaseName: 'valid_name_test',
            mode: 'create',
            password: 'short',
            expectedWebsiteRevision: 1,
          }),
        });

        return { r1Status: r1.status, r2Status: r2.status, r3Status: r3.status };
      },
      { sId: testServerId, wId: testWebsiteId }
    );

    expect([400, 422]).toContain(setupInvalidChecks.r1Status);
    expect([400, 422]).toContain(setupInvalidChecks.r2Status);
    expect([400, 422]).toContain(setupInvalidChecks.r3Status);

    // 2. Bağlantı bilgileri API uç noktası sınır değerleri
    if (createdBindingId) {
      const connValidationChecks = await page.evaluate(
        async ({ sId, wId, bId }) => {
          const sRes = await fetch('/api/auth/session');
          const sJson = await sRes.json();
          const csrf = sJson.data?.csrfToken;
          const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
          const baseConnUrl = `/api/panel/servers/${encodeURIComponent(sId)}/websites/${encodeURIComponent(wId)}/databases`;

          // Boş gövde -> 400
          const emptyBodyRes = await fetch(`${baseConnUrl}/${encodeURIComponent(bId)}/connection`, {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
          });

          // Yanlış tip (string revealPassword) -> 400
          const invalidTypeRes = await fetch(`${baseConnUrl}/${encodeURIComponent(bId)}/connection`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ revealPassword: 'true' }),
          });

          // Fazladan şema dışı alan -> 400
          const extraFieldRes = await fetch(`${baseConnUrl}/${encodeURIComponent(bId)}/connection`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ revealPassword: false, allowedHosts: ['%'] }),
          });

          // Var olmayan bindingId -> 404
          const notFoundRes = await fetch(
            `${baseConnUrl}/00000000-0000-0000-0000-000000000000/connection`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ revealPassword: false }),
            }
          );

          return {
            emptyStatus: emptyBodyRes.status,
            invalidTypeStatus: invalidTypeRes.status,
            extraFieldStatus: extraFieldRes.status,
            notFoundStatus: notFoundRes.status,
          };
        },
        { sId: testServerId, wId: testWebsiteId, bId: createdBindingId }
      );

      expect(connValidationChecks.emptyStatus).toBe(400);
      expect(connValidationChecks.invalidTypeStatus).toBe(400);
      expect(connValidationChecks.extraFieldStatus).toBe(400);
      expect(connValidationChecks.notFoundStatus).toBe(404);
    }
  });

  test('yetki ve rol izolasyonu (RBAC): Giriş yapmamış veya yabancı website bağlantı bilgilerine erişemez (401/403)', async ({
    page,
    browser,
  }) => {
    // 1. Giriş yapmamış unauthenticated istek 401/403 almalı
    const unauthContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthRes = await unauthContext.request.post(
        `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/${encodeURIComponent(testWebsiteId)}/databases/${encodeURIComponent(createdBindingId || 'dummy')}/connection`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: { revealPassword: false },
        }
      );
      expect([401, 403]).toContain(unauthRes.status());
    } finally {
      await unauthContext.close();
    }

    // 2. Yabancı / var olmayan websiteId üzerinden bağlantı bilgisi istenmesi 403/404 ile engellenmeli
    const foreignRes = await page.evaluate(
      async ({ sId, bId }) => {
        const sRes = await fetch('/api/auth/session');
        const sJson = await sRes.json();
        const csrf = sJson.data?.csrfToken;
        const res = await fetch(
          `/api/panel/servers/${encodeURIComponent(sId)}/websites/11111111-1111-1111-1111-111111111111/databases/${encodeURIComponent(bId || 'dummy')}/connection`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({ revealPassword: false }),
          }
        );
        return res.status;
      },
      { sId: testServerId, bId: createdBindingId }
    );
    expect([400, 403, 404]).toContain(foreignRes);
  });

  test('uzak erişim politikası ve izinli kaynak tanımlama (H-1 / H-2): Plesk eşdeğeri uzak erişim ve /access uç noktası kontrolü', async ({
    page,
  }) => {
    test.fail(
      true,
      'BULGU DB-03 / H-1 ve H-2: Veritabanı kullanıcısı bazında uzak erişim politikası (localhost/%, IP listesi) yönetimi yok; tüm kullanıcılar sabit localhost ve /access rotası 404'
    );

    // Plesk eşdeğeri veritabanı kullanıcısına uzak IP / '%' tanımlama yeteneği ve /access uç noktası çağrısı
    const accessRes = await page.evaluate(
      async ({ sId, dbName, credId }) => {
        const sRes = await fetch('/api/auth/session');
        const sJson = await sRes.json();
        const csrf = sJson.data?.csrfToken;
        // non-reseller-capabilities kataloğunda tamamlandı görünen uç nokta
        const res = await fetch(
          `/api/panel/servers/${encodeURIComponent(sId)}/databases/${encodeURIComponent(dbName)}/credentials/${encodeURIComponent(credId)}/access`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({ host: '%', allowedHosts: ['%'] }),
          }
        );
        return { status: res.status };
      },
      { sId: testServerId, dbName: testDbName, credId: createdCredentialId }
    );

    // Gerçekte bu uç nokta 404 döner ve arayüzde/backend'de uzak erişim yoktur; bu yüzden test.fail ile işaretlenmiştir.
    // Beklenen başarılı durum (Plesk eşdeğerliği sağlandığında): 200 OK
    expect(accessRes.status).toBe(200);
  });

  test('bağlantı bilgileri modalı kullanılabilirlik (H-3): Parolaya eriş sonrasında ekranda düz metin göster/gizle anahtarı ve .env şablonu', async ({
    page,
  }) => {
    test.fail(
      true,
      'BULGU DB-03 / H-3: Bağlantı bilgileri modalında Parolaya eriş tıklandıktan sonra şifre ekranda düz metin görülemiyor ve .env DB_PASSWORD sabit kalıyor'
    );

    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const row = page.locator('tr[role="row"]').filter({ hasText: testDbName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    const connBtn = row.locator('button:has-text("Bağlantı bilgileri")');
    await connBtn.click();

    const connDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Bağlantı bilgileri/i });
    await expect(connDialog).toBeVisible({ timeout: 10000 });

    const revealBtn = connDialog.locator('button:has-text("Parolaya eriş")');
    await revealBtn.click();

    // Beklenti: Kullanıcı parolayı ekranda düz metin okumak için göster/gizle (göz) butonuna basabilmeli
    // veya input type="text" olabilmeli ve .env şablonundaki DB_PASSWORD=<parolanız> çözülen parola ile güncellenmeli
    const toggleEyeBtn = connDialog.locator('button[aria-label*="Göster"], button[aria-label*="Show"], button.ws-password-toggle');
    await expect(toggleEyeBtn).toBeVisible({ timeout: 3000 });

    const envBlock = connDialog.locator('pre.ws-code');
    await expect(envBlock).toContainText(`DB_PASSWORD=${revealedPassword}`);
  });
});
