import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('DB-04 phpMyAdmin geçişi ve oturum/yetki izolasyonu', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const targetDatabaseName = `tdb04_a${agentN}_${Date.now().toString(36)}`;
  let testServerId = null;
  let createdWebsiteId = null;

  // Removes the database this run created through the panel's own flow:
  // credential delete + finalize, binding backup, database delete + finalize.
  test.afterAll(async ({ browser }) => {
    test.setTimeout(300000);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const origin = new URL(page.url()).origin;
      const csrf = (await (await page.request.get('/api/auth/session')).json().catch(() => ({}))).data?.csrfToken;
      const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Origin: origin };
      const call = async (method, path, data) => {
        const res = await page.request.fetch(`/api/panel${path}`, { method, headers, data });
        return { status: res.status(), data: (await res.json().catch(() => ({})))?.data };
      };
      const waitJob = async (jobId) => {
        for (let i = 0; jobId && i < 120; i++) {
          const job = (await call('GET', `/jobs/${encodeURIComponent(jobId)}`)).data;
          if (['succeeded', 'failed', 'cancelled'].includes(job?.status)) return job;
          await new Promise((r) => setTimeout(r, 1000));
        }
        return null;
      };

      // The panel lists servers as an array; the second test falls back to the 'local' alias, which these routes do not accept.
      const servers = (await call('GET', '/servers')).data;
      const serverId = servers?.servers?.[0]?.id || servers?.[0]?.id;
      if (!serverId) return;
      const server = `/servers/${encodeURIComponent(serverId)}`;
      const websiteIds = createdWebsiteId
        ? [createdWebsiteId]
        : ((await call('GET', '/websites')).data || []).map((w) => w.id);

      for (const websiteId of websiteIds) {
        const resources = await call('GET', `${server}/websites/${encodeURIComponent(websiteId)}/database-resources`);
        const matched = (resources.data?.databases || []).find((d) => d.binding?.databaseName === targetDatabaseName);
        if (!matched) continue;
        const { binding, credential } = matched;

        if (credential) {
          const credentialPath = `${server}/database-credentials/${encodeURIComponent(credential.id)}`;
          const preview = (await call('GET', `${credentialPath}/delete-preview`)).data;
          const queued = await call('POST', `${credentialPath}/delete`, {
            expectedCredentialRevision: preview?.expectedCredentialRevision,
            expectedBindingRevision: preview?.expectedBindingRevision,
            expectedDesiredStateSha256: preview?.desiredStateSha256,
            confirmation: preview?.confirmation,
          });
          const job = await waitJob(queued.data?.job?.id);
          if (job?.status !== 'succeeded') throw new Error(`credential delete ${queued.status} ${job?.status}`);
          await call('DELETE', credentialPath, {
            expectedRevision: credential.revision,
            deleteJobId: job.id,
            confirmation: `finalize-database-credential-delete:${credential.id}:${credential.revision}:${job.id}`,
          });
        }

        const bindingPath = `${server}/websites/${encodeURIComponent(websiteId)}/database-bindings/${encodeURIComponent(binding.id)}`;
        let preview = (await call('GET', `${bindingPath}/delete-preview`)).data;
        if (preview?.exists && !preview.backup) {
          const queued = await call('POST', `${bindingPath}/backup`, {
            expectedBindingRevision: binding.revision,
            confirmation: `backup-website-database:${binding.id}:${binding.revision}`,
          });
          const job = await waitJob(queued.data?.job?.id);
          if (job?.status !== 'succeeded') throw new Error(`database backup ${queued.status} ${job?.status}`);
          preview = (await call('GET', `${bindingPath}/delete-preview`)).data;
        }
        if (!preview?.readyToDelete) throw new Error(`database delete blocked: ${(preview?.blockers || []).join(',')}`);
        const queued = await call('POST', `${bindingPath}/delete`, {
          expectedBindingRevision: binding.revision,
          expectedPreviewDigest: preview.previewDigest,
          expectedBackupId: preview.backup.backupId,
          expectedBackupSha256: preview.backup.dumpSha256,
          confirmation: preview.confirmation,
        });
        const job = await waitJob(queued.data?.job?.id);
        if (job?.status !== 'succeeded') throw new Error(`database delete ${queued.status} ${job?.status}`);
        const finalized = await call('POST', `${bindingPath}/delete-finalize`, {
          expectedBindingRevision: binding.revision,
          deleteJobId: job.id,
          confirmation: `finalize-website-database-delete:${binding.id}:${binding.revision}:${job.id}`,
        });
        if (finalized.status !== 200) throw new Error(`database delete finalize ${finalized.status}`);
      }
    } catch (cleanupErr) {
      console.warn('DB-04 cleanup error:', cleanupErr.message);
    } finally {
      await context.close().catch(() => {});
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

  test('mutlu yol: Veritabanları ekranından phpMyAdmin SSO oturum açma, veritabanına erişim ve tablo listeleme', async ({ page, context }) => {
    // 0. phpMyAdmin servis köprüsü ve havuzunun hazır/güncel olduğundan emin ol
    const serversRes = await page.request.get('/api/panel/servers');
    if (serversRes.status() === 200) {
      const serversJson = await serversRes.json();
      const sId = serversJson.data?.servers?.[0]?.id || serversJson.data?.[0]?.id;
      if (sId) {
        const installRes = await page.request.post(`/api/panel/servers/${encodeURIComponent(sId)}/services/phpmyadmin/install`, {
          data: { confirmation: 'install:phpmyadmin' },
        });
        if (installRes.status() === 202) {
          const installJson = await installRes.json();
          const jobId = installJson.data?.id;
          if (jobId) {
            for (let i = 0; i < 40; i++) {
              await new Promise((r) => setTimeout(r, 1000));
              const jRes = await page.request.get(`/api/panel/jobs/${encodeURIComponent(jobId)}`);
              if (jRes.status() === 200) {
                const jJson = await jRes.json();
                if (['succeeded', 'failed', 'cancelled'].includes(jJson.data?.status)) break;
              }
            }
          }
        }
      }
    }

    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    const inventorySection = page.locator('section.ws-database-inventory, section:has-text("Veritabanı listesi")').first();
    await expect(inventorySection).toBeVisible({ timeout: 15000 });

    // Her zaman yeni benzersiz test veritabanı oluştur
    const createBtn = page.locator('button:has-text("Veritabanı oluştur")').first();
    await expect(createBtn).toBeEnabled({ timeout: 10000 });
    await createBtn.click();

    const dialog = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: /Veritabanı oluştur/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    // Web sitesi seçimi
    const siteSelect = dialog.locator('select').first();
    if (await siteSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const options = await siteSelect.locator('option').all();
      for (const opt of options) {
        const val = await opt.getAttribute('value');
        if (val) {
          createdWebsiteId = val;
          await siteSelect.selectOption(val);
          break;
        }
      }
    }

    const dbNameInput = dialog.locator('label:has-text("Veritabanı adı") input, input[placeholder="ornek_site"]');
    await expect(dbNameInput).toBeVisible({ timeout: 5000 });
    await dbNameInput.fill(targetDatabaseName);

    const submitBtn = dialog.locator('button[type="submit"]:has-text("Oluştur")');
    await expect(submitBtn).toBeEnabled({ timeout: 5000 });
    await submitBtn.click();

    const successMsg = dialog.locator('p:has-text("hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.")');
    await expect(successMsg).toBeVisible({ timeout: 60000 });

    const finishBtn = dialog.locator('button:has-text("Tamam")');
    await expect(finishBtn).toBeVisible({ timeout: 5000 });
    await finishBtn.click();
    await expect(dialog).toHaveCount(0, { timeout: 10000 });

    // Arama kutusu ile yeni veritabanını filtrele
    const searchInput = page.getByRole('searchbox', { name: 'Veritabanı ara' });
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill(targetDatabaseName);

    const row = page.locator('tr[role="row"]').filter({ hasText: targetDatabaseName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });

    // Satırdaki phpMyAdmin butonunu bul
    const phpMyAdminBtn = row.locator('button:has-text("phpMyAdmin")');
    await expect(phpMyAdminBtn).toBeVisible({ timeout: 10000 });
    await expect(phpMyAdminBtn).toBeEnabled();

    // phpMyAdmin SSO açılışını tetikle ve yeni pencereyi dinle
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 25000 }),
      phpMyAdminBtn.click(),
    ]);

    // Popup yönlendirmesini bekle
    await popup.waitForURL((url) => url.pathname.includes('/tools/phpmyadmin'), { timeout: 25000 });
    await popup.waitForLoadState('networkidle');

    // Fiziksel Sonuç 1: Popup URL'si phpMyAdmin route ve veritabanı adını içermeli
    const popupUrl = popup.url();
    expect(popupUrl).toContain('/tools/phpmyadmin/index.php');
    expect(decodeURIComponent(popupUrl)).toContain(targetDatabaseName);

    // Fiziksel Sonuç 2: phpMyAdmin sayfa başlığı (title) phpMyAdmin ve veritabanı adını doğrulamalı
    await expect(popup).toHaveTitle(/phpMyAdmin/i, { timeout: 15000 });
    const pageTitle = await popup.title();
    expect(pageTitle).toContain(targetDatabaseName);

    // Fiziksel Sonuç 3: phpMyAdmin menüsünde veritabanı sekmesi ("Yapı" veya "Structure") aktif olmalı
    const topMenu = popup.locator('#topmenu, .navigation');
    await expect(topMenu).toBeVisible({ timeout: 15000 });
    const structureTab = popup.locator('#topmenu').filter({ hasText: /Yapı|Structure/i });
    await expect(structureTab).toBeVisible({ timeout: 10000 });

    // Fiziksel Sonuç 4: Veritabanı içeriği ve tablo listeleme ekranı doğrulanmalı
    const dbContainer = popup.locator('#tableslistcontainer, #page_content, #pma_navigation_tree_content');
    await expect(dbContainer.first()).toBeVisible({ timeout: 15000 });

    await popup.close();
  });

  test('yetki ve izolasyon: unauthenticated veya yabancı website phpMyAdmin handoff erişimi engellenir', async ({ page, browser }) => {
    await page.goto('/databases');
    await expect(page.locator('h1:has-text("Veritabanları")')).toBeVisible({ timeout: 15000 });

    // 1. Session bilgisini al
    const sessionRes = await page.request.get('/api/auth/session');
    expect(sessionRes.status()).toBe(200);
    const sessionData = (await sessionRes.json()).data;
    const csrfToken = sessionData.csrfToken;
    expect(csrfToken).toBeTruthy();

    // 2. Yerel sunucu bilgisini al
    const serversRes = await page.request.get('/api/panel/servers');
    expect(serversRes.status()).toBe(200);
    const serversData = await serversRes.json();
    testServerId = serversData.data?.servers?.[0]?.id || 'local';

    // Yetki İzolasyonu 1: Giriş yapmamış (unauthenticated) istekler 401/403 ile reddedilir
    const unauthContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const unauthHandoff = await unauthContext.request.post(
        `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/dummy-website-id/phpmyadmin-handoffs`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: { credentialId: 'dummy-credential' },
        }
      );
      expect([401, 403]).toContain(unauthHandoff.status());

      const unauthSignon = await unauthContext.request.post(
        '/tools/phpmyadmin/__yunpanel/signon',
        {
          form: { capability: 'invalid-capability-token-must-fail-closed-401' },
          maxRedirects: 0,
        }
      );
      expect([401, 403]).toContain(unauthSignon.status());
    } finally {
      await unauthContext.close();
    }

    // Yetki İzolasyonu 2: Var olmayan veya yetkisiz website üzerinden handoff talebi 403/404 ile engellenir
    const fakeWebsiteId = 'non-existent-website-0000-000000000000';
    const forbiddenHandoff = await page.request.post(
      `/api/panel/servers/${encodeURIComponent(testServerId)}/websites/${fakeWebsiteId}/phpmyadmin-handoffs`,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        data: { credentialId: 'fake-credential' },
      }
    );
    expect([403, 404]).toContain(forbiddenHandoff.status());

    // Yetki İzolasyonu 3: phpMyAdmin signon endpoint'ine sahte capability ile istek fail-closed reddedilir
    const invalidSignon = await page.request.post(
      '/tools/phpmyadmin/__yunpanel/signon',
      {
        headers: {
          'x-csrf-token': csrfToken,
        },
        form: { capability: 'A'.repeat(43) },
        maxRedirects: 0,
      }
    );
    expect([401, 403, 404]).toContain(invalidSignon.status());
  });
});
