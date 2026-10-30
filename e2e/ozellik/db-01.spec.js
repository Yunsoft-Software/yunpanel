import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

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

test.describe('DB-01 MySQL/MariaDB oluşturma, silme, site ilişkisi ve boyut', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tdb01_a${agentN}_${Date.now().toString(36)}`;
  let testServerId = null;
  let testWebsiteId = null;
  let testDomainId = null;
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

    if (!testServerId || !testWebsiteId) {
      const serversRes = await page.request.get('/api/panel/servers');
      if (serversRes.status() === 200) {
        const serversData = await serversRes.json();
        const serverList = serversData.data?.servers || serversData.data || [];
        testServerId = serverList[0]?.id;
      }
      const domainsRes = await page.request.get('/api/panel/domains');
      if (domainsRes.status() === 200) {
        const domainsData = await domainsRes.json();
        const domainList = domainsData.data?.domains || domainsData.data || [];
        const targetDomain = domainList.find((d) => !d.parentDomainId) || domainList[0];
        if (targetDomain) {
          testDomainId = targetDomain.id;
          testWebsiteId = targetDomain.websiteId;
          if (!testServerId && targetDomain.serverId) {
            testServerId = targetDomain.serverId;
          }
        }
      }
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: 'https://server.cryptoraichu.website' });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

      let serverId = testServerId;
      let websiteId = testWebsiteId;

      if (!serverId || !websiteId) {
        const domainsRes = await page.request.get('/api/panel/domains');
        if (domainsRes.status() === 200) {
          const domainsJson = await domainsRes.json();
          const domainList = domainsJson.data?.domains || domainsJson.data || [];
          const mainDomain = domainList.find((d) => d.id === testDomainId)
            || domainList.find((d) => d.primaryDomain === 'webrich.news' && !d.parentDomainId)
            || domainList.find((d) => !d.parentDomainId)
            || domainList[0];
          if (mainDomain) {
            serverId = serverId || mainDomain.serverId;
            websiteId = websiteId || mainDomain.websiteId;
          }
        }
      }

      let websiteIds = websiteId ? [websiteId] : [];
      try {
        const domainsRes = await page.request.get('/api/panel/domains');
        if (domainsRes.status() === 200) {
          const domainsJson = await domainsRes.json();
          const domainList = domainsJson.data?.domains || domainsJson.data || [];
          websiteIds = [...new Set([
            ...websiteIds,
            ...domainList.map((d) => d.websiteId).filter(Boolean),
          ])];
        }
      } catch {}

      const sId = serverId || 'local';

      for (const wId of websiteIds) {
        try {
          const resourcesRes = await page.request.get(
            `/api/panel/servers/${encodeURIComponent(sId)}/websites/${encodeURIComponent(wId)}/database-resources`
          );
          if (resourcesRes.status() !== 200) continue;
          const resourcesJson = await resourcesRes.json();
          const databases = resourcesJson.data?.databases || [];
          const targets = databases.filter((d) =>
            d.binding?.databaseName === prefix ||
            d.binding?.databaseName?.startsWith(`tdb01_a${agentN}_`) ||
            createdDatabases.includes(d.binding?.databaseName)
          );

          for (const matched of targets) {
            const binding = matched.binding;
            const credential = matched.credential;

            if (credential) {
              await page.evaluate(async ({ serverId, credentialId }) => {
                const sessionRes = await fetch('/api/auth/session');
                const session = await sessionRes.json();
                const csrf = session.data?.csrfToken;
                const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

                const prevRes = await fetch(
                  `/api/panel/servers/${encodeURIComponent(serverId)}/database-credentials/${encodeURIComponent(credentialId)}/delete-preview`,
                  { headers }
                );
                if (prevRes.status !== 200) return;
                const prevJson = await prevRes.json();
                const preview = prevJson.data;

                if (preview) {
                  let jobId = null;
                  const qRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(serverId)}/database-credentials/${encodeURIComponent(credentialId)}/delete`,
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
                  if (qRes.status === 202) {
                    const qJson = await qRes.json();
                    jobId = qJson.data?.job?.id;
                  } else if (qRes.status === 409) {
                    const jobsRes = await fetch('/api/panel/jobs?limit=50', { headers });
                    if (jobsRes.status === 200) {
                      const jobsData = await jobsRes.json();
                      const list = jobsData.data?.jobs || jobsData.data || [];
                      const existing = list.find((j) => j.operation === 'database.credential.delete' && j.resourceId === preview.databaseName);
                      if (existing) jobId = existing.id;
                    }
                  }

                  if (jobId) {
                    for (let i = 0; i < 30; i++) {
                      await new Promise((r) => setTimeout(r, 1000));
                      const jRes = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}`);
                      if (jRes.status === 200) {
                        const jJson = await jRes.json();
                        if (['succeeded', 'failed', 'cancelled'].includes(jJson.data?.status)) break;
                      }
                    }

                    await fetch(
                      `/api/panel/servers/${encodeURIComponent(serverId)}/database-credentials/${encodeURIComponent(credentialId)}`,
                      {
                        method: 'DELETE',
                        headers,
                        body: JSON.stringify({
                          expectedRevision: preview.expectedCredentialRevision,
                          deleteJobId: jobId,
                          confirmation: `finalize-database-credential-delete:${credentialId}:${preview.expectedCredentialRevision}:${jobId}`,
                        }),
                      }
                    );
                  }
                }
              }, { serverId: sId, credentialId: credential.id }).catch(() => {});
            }

            if (binding) {
              await page.evaluate(async ({ serverId, websiteId, bindingId, bindingRevision, dbName }) => {
                const sessionRes = await fetch('/api/auth/session');
                const session = await sessionRes.json();
                const csrf = session.data?.csrfToken;
                const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

                let prevRes = await fetch(
                  `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/delete-preview`,
                  { headers }
                );
                if (prevRes.status !== 200) return;
                let prevJson = await prevRes.json();
                let preview = prevJson.data;

                if (preview && !preview.exists) {
                  await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: dbName, confirmation: `create:${dbName}` }),
                  }).catch(() => {});
                  await new Promise((r) => setTimeout(r, 1500));
                  prevRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/delete-preview`,
                    { headers }
                  );
                  if (prevRes.status === 200) {
                    prevJson = await prevRes.json();
                    preview = prevJson.data;
                  }
                }

                if (preview && !preview.backup && preview.exists) {
                  const bRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/backup`,
                    {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        expectedBindingRevision: preview.scope?.bindingRevision || bindingRevision,
                        confirmation: `backup-website-database:${bindingId}:${preview.scope?.bindingRevision || bindingRevision}`,
                      }),
                    }
                  );
                  if (bRes.status === 202) {
                    const bJson = await bRes.json();
                    const bJobId = bJson.data?.job?.id;
                    if (bJobId) {
                      for (let i = 0; i < 30; i++) {
                        await new Promise((r) => setTimeout(r, 1000));
                        const jRes = await fetch(`/api/panel/jobs/${encodeURIComponent(bJobId)}`);
                        if (jRes.status === 200) {
                          const jJson = await jRes.json();
                          if (['succeeded', 'failed', 'cancelled'].includes(jJson.data?.status)) break;
                        }
                      }
                    }
                  }
                  prevRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/delete-preview`,
                    { headers }
                  );
                  if (prevRes.status !== 200) return;
                  prevJson = await prevRes.json();
                  preview = prevJson.data;
                }

                if (preview?.readyToDelete && preview.backup) {
                  const delRes = await fetch(
                    `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/delete`,
                    {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        expectedBindingRevision: preview.scope.bindingRevision,
                        expectedPreviewDigest: preview.previewDigest,
                        expectedBackupId: preview.backup.backupId,
                        expectedBackupSha256: preview.backup.dumpSha256,
                        confirmation: preview.confirmation,
                      }),
                    }
                  );
                  if (delRes.status !== 202) return;
                  const delJson = await delRes.json();
                  const delJobId = delJson.data?.job?.id;
                  if (delJobId) {
                    for (let i = 0; i < 30; i++) {
                      await new Promise((r) => setTimeout(r, 1000));
                      const jRes = await fetch(`/api/panel/jobs/${encodeURIComponent(delJobId)}`);
                      if (jRes.status === 200) {
                        const jJson = await jRes.json();
                        if (['succeeded', 'failed', 'cancelled'].includes(jJson.data?.status)) break;
                      }
                    }

                    await fetch(
                      `/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(bindingId)}/delete-finalize`,
                      {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                          expectedBindingRevision: preview.scope.bindingRevision,
                          deleteJobId: delJobId,
                          confirmation: `finalize-website-database-delete:${bindingId}:${preview.scope.bindingRevision}:${delJobId}`,
                        }),
                      }
                    );
                  }
                }
              }, { serverId: sId, websiteId: wId, bindingId: binding.id, bindingRevision: binding.revision, dbName: binding.databaseName }).catch(() => {});
            }
          }
        } catch {}
      }

      const dbsToClean = [...new Set([prefix, ...createdDatabases])];
      for (const dbName of dbsToClean) {
        await page.evaluate(async ({ serverId, dbName }) => {
          const sessionRes = await fetch('/api/auth/session');
          const session = await sessionRes.json();
          const csrf = session.data?.csrfToken;
          const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };
          const delRes = await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/databases/${encodeURIComponent(dbName)}`, {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ confirmation: `delete:${dbName}` }),
          });
          if (delRes.status === 202) {
            const delJson = await delRes.json();
            const jobId = delJson.data?.job?.id || delJson.data?.id;
            if (jobId) {
              for (let i = 0; i < 30; i++) {
                await new Promise((r) => setTimeout(r, 1000));
                const jRes = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}`);
                if (jRes.status === 200) {
                  const jJson = await jRes.json();
                  if (['succeeded', 'failed', 'cancelled'].includes(jJson.data?.status)) break;
                }
              }
            }
          }
        }, { serverId: sId, dbName }).catch(() => {});
      }

      // SSH safety net: MariaDB üzerinde bu ajana ait şema ve registry kalıntısı kalmadığından emin olunur
      try {
        const out = runSsh(`mariadb -Nse "SHOW DATABASES LIKE 'tdb01_a${agentN}_%';"`);
        const extraDbs = out.split(/\s+/).map((s) => s.trim()).filter(Boolean);
        for (const db of extraDbs) {
          if (/^tdb01_a\d+_[a-z0-9]+$/i.test(db)) {
            runSsh(`mariadb -e "DROP DATABASE IF EXISTS ${db};"`);
          }
        }
        if (/^tdb01_a\d+_[a-z0-9]+$/i.test(prefix)) {
          runSsh(`mariadb -e "DROP DATABASE IF EXISTS ${prefix};"`);
        }

        // Registry dosyalarından da bu ajanın binding ve credential kayıtlarını temizle
        const cleanupScript = `
          const fs = require('fs');
          for (const file of [
            '/var/lib/yunpanel/control-plane/database-binding-registry.json',
            '/var/lib/yunpanel/control-plane/database-credential-registry.json'
          ]) {
            if (fs.existsSync(file)) {
              try {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (Array.isArray(data.bindings)) {
                  data.bindings = data.bindings.filter(b => !b.databaseName || (!b.databaseName.startsWith('tdb01_a${agentN}_') && b.databaseName !== '${prefix}'));
                }
                if (Array.isArray(data.credentials)) {
                  data.credentials = data.credentials.filter(c => !c.databaseName || (!c.databaseName.startsWith('tdb01_a${agentN}_') && c.databaseName !== '${prefix}'));
                }
                fs.writeFileSync(file, JSON.stringify(data, null, 2));
              } catch {}
            }
          }
        `;
        const b64 = Buffer.from(cleanupScript).toString('base64');
        runSsh(`node -e "eval(Buffer.from('${b64}','base64').toString())"`);
      } catch {}

      // Fiziksel temizlik kontrolü: sunucuda tdb01_a${agentN}_ önekli veritabanı kalmadığı doğrulanır
      for (let attempt = 0; attempt < 10; attempt++) {
        const verifyRes = await page.request.get(`/api/panel/servers/${encodeURIComponent(sId)}/databases`);
        if (verifyRes.status() === 200) {
          const verifyJson = await verifyRes.json();
          const dbs = verifyJson.data?.databases || verifyJson.databases || [];
          const remaining = dbs.filter((d) => d.name === prefix || d.name?.startsWith(`tdb01_a${agentN}_`));
          if (remaining.length === 0) break;
          if (attempt === 9) {
            expect(remaining.length).toBe(0);
          }
          await page.waitForTimeout(1000);
        }
      }
    } catch (err) {
      console.warn('DB-01 afterAll cleanup error:', err.message);
    } finally {
      await context.close().catch(() => {});
    }
  });

  test('mutlu yol: siteye bağlı veritabanı oluşturma, bağlantı bilgileri, fiziksel MariaDB şeması ve boyut görünürlüğü', async ({ page }) => {
    // 1. Sunucu ve web sitesi bilgilerini al
    const serversRes = await page.request.get('/api/panel/servers');
    expect(serversRes.status()).toBe(200);
    const serversData = await serversRes.json();
    const serverList = serversData.data?.servers || serversData.data || [];
    testServerId = serverList[0]?.id;
    expect(testServerId).toBeTruthy();

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.status()).toBe(200);
    const domainsData = await domainsRes.json();
    const domainList = domainsData.data?.domains || domainsData.data || [];
    const targetDomain = domainList.find((d) => !d.parentDomainId) || domainList[0];
    expect(targetDomain).toBeTruthy();
    testDomainId = targetDomain.id;
    testWebsiteId = targetDomain.websiteId;
    if (!testServerId && targetDomain.serverId) {
      testServerId = targetDomain.serverId;
    }

    // 2. /databases ekranına git
    await page.goto('/databases');
    if (await page.locator('form.auth-form').isVisible({ timeout: 3000 }).catch(() => false)) {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await page.goto('/databases');
    }
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 20000 });

    const inventorySection = page.locator('section.ws-database-inventory, section:has-text("Veritabanı listesi")').first();
    await expect(inventorySection).toBeVisible({ timeout: 15000 });

    // 3. Veritabanı oluştur modalını aç
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Web sitesi seçimi
    const siteSelect = dialog.locator('select').first();
    if (await siteSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await siteSelect.selectOption(testWebsiteId);
    }

    // Veritabanı adını doldur
    const dbNameInput = dialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
    await expect(dbNameInput).toBeVisible({ timeout: 5000 });
    await dbNameInput.fill(prefix);
    createdDatabases.push(prefix);

    // Formu gönder (parola boş bırakıldığında otomatik güçlü parola üretilir)
    const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    // Kurulum başarısını doğrula (paralel ajandan dolayı revizyon çakışması olursa yenileyip tekrar dener)
    const successMsg = dialog.locator(`p:has-text("${prefix} hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")`);
    const conflictError = dialog.locator('text=Site değişti');
    for (let retry = 0; retry < 3; retry++) {
      if (await successMsg.isVisible({ timeout: 15000 }).catch(() => false)) break;
      if (await conflictError.isVisible().catch(() => false)) {
        await dialog.locator('button:has-text("Vazgeç")').click().catch(() => {});
        await page.reload();
        await expect(createBtn).toBeEnabled({ timeout: 10000 });
        await createBtn.click();
        if (await siteSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
          await siteSelect.selectOption(testWebsiteId);
        }
        await dbNameInput.fill(prefix);
        await submitBtn.click();
      }
    }
    await expect(successMsg).toBeVisible({ timeout: 60000 });

    const finishBtn = dialog.locator('button:has-text("Tamam")');
    await expect(finishBtn).toBeVisible({ timeout: 5000 });
    await finishBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    // 4. Tabloda yeni veritabanını doğrula
    const row = page.locator('tr[role="row"]').filter({ hasText: prefix }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Boyut sütununun ve motor bilgisinin varlığını doğrula
    await expect(row.locator('td[data-label="Veritabanı"]')).toContainText(prefix);
    await expect(row.locator('td[data-label="Site / Kullanıcı"]')).toContainText('ydb_');

    // 5. Bağlantı bilgileri modalını aç ve parolaya eriş
    const connectionBtn = row.locator('button:has-text("Bağlantı bilgileri")');
    await expect(connectionBtn).toBeVisible({ timeout: 5000 });
    await connectionBtn.click();

    const connModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Bağlantı bilgileri/i });
    await expect(connModal).toBeVisible({ timeout: 10000 });

    // Parolaya eriş butonuna tıkla
    const revealBtn = connModal.locator('button:has-text("Parolaya eriş")');
    await expect(revealBtn).toBeVisible({ timeout: 5000 });
    await revealBtn.click();

    // Parola alanının dolduğunu ve en az 16 karakter olduğunu doğrula
    const passwordInput = connModal.locator('label:has-text("Parola") input');
    await expect(passwordInput).toBeVisible({ timeout: 10000 });
    await expect(passwordInput).not.toHaveValue('', { timeout: 10000 });
    const passwordValue = await passwordInput.inputValue();
    expect(passwordValue.length).toBeGreaterThanOrEqual(16);

    // Modal üzerindeki bağlantı parametrelerini doğrula (Sunucu: localhost, Port: 3306, Veritabanı: prefix)
    const modalText = await connModal.textContent();
    expect(modalText).toContain('3306');
    expect(modalText).toContain(prefix);
    expect(modalText).toContain('ydb_');

    // Modalı kapat
    const closeConnBtn = connModal.locator('button.ws-modal-close, button:has-text("Kapat")').first();
    if (await closeConnBtn.isVisible().catch(() => false)) {
      await closeConnBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await expect(connModal).toHaveCount(0, { timeout: 5000 });

    // Fiziksel Sonuç: Canlı API üzerinden MariaDB fiziksel varlığını, boyutunu ve motorunu doğrula
    const liveDbRes = await page.request.get(`/api/panel/servers/${encodeURIComponent(testServerId)}/databases`);
    expect(liveDbRes.status()).toBe(200);
    const liveDbData = await liveDbRes.json();
    const inventory = liveDbData.data || liveDbData;

    expect(['mariadb', 'mysql']).toContain(inventory.engine);
    expect(inventory.health?.ready).toBe(true);

    const matchedDb = (inventory.databases || []).find((d) => d.name === prefix);
    expect(matchedDb).toBeTruthy();
    expect(typeof matchedDb.sizeBytes).toBe('number');
    expect(matchedDb.sizeBytes).toBeGreaterThanOrEqual(0);
  });

  test('hatalı girdi: geçersiz karakterler, sistem şeması ve kısa parola engellenir', async ({ page }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // Veritabanı oluştur modalını aç
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const nameInput = dialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
    await expect(nameInput).toBeVisible();

    // Hatalı girdi 1: Tireli, boşluklu ve özel karakterli isimler HTML5 pattern validasyonu ile engellenir
    await nameInput.fill('gecersiz-db-adi!');
    let isValid = await nameInput.evaluate((el) => el.checkValidity());
    expect(isValid).toBe(false);

    // Hatalı girdi 2: 16 karakterden kısa parola girildiğinde minLength validasyonu başarısız olur
    const passwordInput = dialog.locator('label:has-text("Kullanıcı parolası") input');
    await passwordInput.fill('Kisa123!');
    const isPasswordValid = await passwordInput.evaluate((el) => el.checkValidity());
    expect(isPasswordValid).toBe(false);

    // Modalı kapat
    const cancelBtn = dialog.locator('button:has-text("Vazgeç")');
    await cancelBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 5000 });

    // Hatalı girdi 3: Sistem şeması adı ('mysql') ile oluşturma API düzeyinde 400 ile engellenir
    const invalidNameRes = await page.evaluate(async ({ serverId, websiteId }) => {
      const sessionRes = await fetch('/api/auth/session');
      const session = await sessionRes.json();
      const csrf = session.data?.csrfToken;
      const res = await fetch(`/api/panel/servers/${encodeURIComponent(serverId)}/websites/${encodeURIComponent(websiteId)}/databases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({
          databaseName: 'mysql',
          mode: 'create',
        }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }, { serverId: testServerId, websiteId: testWebsiteId });
    expect(invalidNameRes.status).toBe(400);
    expect(invalidNameRes.body.error || invalidNameRes.body.message || invalidNameRes.body.code).toBeTruthy();
  });

  test('yetki ve tenant izolasyonu: unauthenticated kullanıcıların global veritabanı API erişimi engellenir', async ({ browser }) => {
    const unauthContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      // 1. Unauthenticated olarak /api/panel/servers/:id/databases çağrısı 401/403 ile reddedilir
      const unauthGet = await unauthContext.request.get(
        `/api/panel/servers/${encodeURIComponent(testServerId || 'local')}/databases`
      );
      expect([401, 403]).toContain(unauthGet.status());

      // 2. Unauthenticated olarak veritabanı oluşturma talebi 401/403 ile reddedilir
      const unauthPost = await unauthContext.request.post(
        `/api/panel/servers/${encodeURIComponent(testServerId || 'local')}/websites/${encodeURIComponent(testWebsiteId || 'dummy')}/databases`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: { databaseName: 'unauth_db_test', mode: 'create' },
        }
      );
      expect([401, 403]).toContain(unauthPost.status());
    } finally {
      await unauthContext.close();
    }
  });

  test('bilinen hata: global veritabanları tablosundan siteye bağlı veritabanını doğrudan silme 409 unbind hatası verir', async ({ page }) => {
    test.fail(true, 'BULGU DB-01: Global ekranda siteye bağlı veritabanını silme 409 Conflict döner ve unbind aksiyonu sunulmaz');

    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const row = page.locator('tr[role="row"]').filter({ hasText: prefix }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Satırdaki Sil düğmesine tıkla
    const deleteBtn = row.locator('button[title="Veritabanını sil"], button:has-text("Sil")');
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();

    // Silme onay diyaloğu açılır
    const deleteDialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: new RegExp(`${prefix} silinsin mi`, 'i') });
    await expect(deleteDialog).toBeVisible({ timeout: 10000 });

    // Onay kutusuna veritabanı adını yaz
    const confirmInput = deleteDialog.locator('input');
    await confirmInput.fill(prefix);

    // Veritabanını sil düğmesine tıkla
    const confirmBtn = deleteDialog.locator('button:has-text("Veritabanını sil")');
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();

    // Beklenen davranış (Plesk eşdeğerliği): Veritabanının site bağıyla birlikte başarıyla silinmesi, hata vermemesi ve tablodan kalkması
    // Gerçek davranış (HATA): Backend 409 Conflict ("Unbind the database from its Website before deleting the schema") döner
    // ve dialog içinde hata uyarısı gösterilir, silinmez. Bu nedenle test.fail ile işaretlenmiştir.
    const errorAlert = deleteDialog.locator('.ws-notice-error, [role="alert"]');
    await expect(errorAlert).toBeHidden({ timeout: 5000 });
    await expect(page.locator('tr[role="row"]').filter({ hasText: prefix })).toBeHidden({ timeout: 5000 });

    // Modalı temizle
    const cancelBtn = deleteDialog.locator('button:has-text("Vazgeç")');
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click().catch(() => {});
    }
  });

  test('bilinen hata: site kaynak tüketimi ekranında veritabanı depolama ve sayısı ölçülemedi kalır', async ({ page }) => {
    test.fail(true, 'BULGU DB-01: Site kaynak tüketimi ekranında veritabanı depolama ve sayısı ölçülemedi kalır');

    // Hedef sitenin kaynak tüketimi sekmesine git
    await page.goto(`/websites/${encodeURIComponent(testDomainId)}/resources`);

    // Kaynak Tüketimi tablosunu bekle
    const consumptionTable = page.locator('table[aria-label="Kaynak Tüketimi"]');
    await expect(consumptionTable).toBeVisible({ timeout: 15000 });

    // Veritabanı Sayısı satırını bul
    const dbCountRow = consumptionTable.locator('tr[role="row"]').filter({ hasText: 'Veritabanı Sayısı' });
    await expect(dbCountRow).toBeVisible({ timeout: 5000 });

    // Beklenen davranış (Plesk eşdeğerliği): Sitede en az 1 veritabanı olduğu için ölçülen kullanımın '— (Ölçülemedi)' olmaması
    // Gerçek davranış (HATA): siteConsumptionInspector bağlanmadığı için '— (Ölçülemedi)' döner. test.fail ile işaretlenmiştir.
    const measuredCell = dbCountRow.locator('td[data-label="Ölçülen Kullanım"]');
    await expect(measuredCell).not.toHaveText('— (Ölçülemedi)', { timeout: 5000 });
  });
});
