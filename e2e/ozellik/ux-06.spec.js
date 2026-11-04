import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('UX-06 İş ilerlemesi, güvenli yeniden deneme ve gerçek durum', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '4';
  const prefix = `tux06-a${agentN}-${Date.now().toString(36)}`;
  const CUST_USER = `${prefix}-cust`;
  const TEST_PASS = 'TuX06_P@ss!2026';

  let capturedJobId = null;
  let capturedFailedJobId = null;

  async function ensureOwnerLoggedIn(page) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await page.goto('/');
      }
    }
  }

  async function findAccountRow(page, username) {
    for (let pageNum = 0; pageNum < 6; pageNum++) {
      await expect(page.locator('table.ws-table, .ws-empty-state')).toBeVisible({ timeout: 15000 });
      const row = page.locator('table.ws-table tbody tr', { hasText: username });
      if (await row.count() > 0 && await row.first().isVisible()) {
        return row.first();
      }
      const nextBtn = page.locator('footer.ws-pagination button:has-text("Sonraki")');
      if (await nextBtn.isVisible() && !await nextBtn.isDisabled()) {
        await nextBtn.click();
        await expect(page.locator('table.ws-table')).toBeVisible({ timeout: 10000 });
      } else {
        break;
      }
    }
    const finalRow = page.locator('table.ws-table tbody tr', { hasText: username }).first();
    await expect(finalRow).toBeVisible({ timeout: 10000 });
    return finalRow;
  }

  async function cleanupAllTestAccounts(browser, pfx = prefix) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    try {
      await ensureOwnerLoggedIn(page);

      await page.evaluate(async (pfx) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const currentOwner = sessionData?.data?.user?.username;
        const headers = { 'Content-Type': 'application/json', 'x-csrf-token': csrf };

        // 1. Müşteri profillerini sil
        const res = await fetch('/api/panel/users/hosting/accounts?kind=customer&limit=100').catch(() => null);
        const data = await res?.json().catch(() => null);
        for (const acc of data?.data?.accounts || []) {
          const u = acc.username || '';
          if (u.startsWith(pfx)) {
            await fetch(`/api/panel/users/hosting/accounts/${encodeURIComponent(acc.id)}/profile`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({
                revision: acc.revision ?? 1,
                confirmation: `unregister-hosting-profile:${acc.id}:${acc.revision ?? 1}`,
              }),
            }).catch(() => null);
          }
        }

        // 2. /api/panel/users listesinden kullanıcıları sil
        const usersRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const usersData = await usersRes?.json().catch(() => null);
        for (const u of usersData?.data?.users || []) {
          const uname = u.username || '';
          if (uname !== currentOwner && uname.startsWith(pfx)) {
            await fetch(`/api/panel/users/${encodeURIComponent(u.id)}`, {
              method: 'DELETE',
              headers,
              body: JSON.stringify({ revision: u.revision }),
            }).catch(() => null);
          }
        }

        // 3. Doğrula: öneke ait kullanıcı kalmadığını onayla
        const verifyRes = await fetch('/api/panel/users?limit=100').catch(() => null);
        const verifyData = await verifyRes?.json().catch(() => null);
        const remaining = (verifyData?.data?.users || []).filter((u) => u.username && u.username.startsWith(pfx));
        if (remaining.length > 0) {
          throw new Error(`Temizlik başarısız: ${remaining.length} kullanıcı kaldı: ${remaining.map((u) => u.username).join(', ')}`);
        }
      }, pfx);
    } finally {
      await context.close().catch(() => {});
    }
  }

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

  test.beforeAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test.afterAll(async ({ browser }) => {
    await cleanupAllTestAccounts(browser);
  });

  test('mutlu yol: /jobs listesi, JobDrawer açma, gerçek durum ve aşama doğrulaması, sayfa yenilemede URL filtre kalıcılığı ve fiziksel API/disk kanıtı', async ({ page }) => {
    await ensureOwnerLoggedIn(page);

    // 1. Arayüzden /jobs sayfasına git ve Tamamlandı (succeeded) filtresini seç
    await page.goto('/jobs');
    await expect(page.locator('h1', { hasText: 'İşler' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Sunucuda sıraya alınan ve tamamlanan işlemler')).toBeVisible();

    const statusSelect = page.locator('label:has-text("Durum") select');
    await expect(statusSelect).toBeVisible();
    await statusSelect.selectOption('succeeded');
    await expect(page).toHaveURL(/status=succeeded/);

    const jobsTable = page.locator('table.ws-jobs-table, table.ws-table');
    await expect(jobsTable).toBeVisible({ timeout: 15000 });

    const rows = jobsTable.locator('tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    const initialRowCount = await rows.count();
    expect(initialRowCount).toBeGreaterThan(0);

    // İlk satırdaki iş bilgilerini al
    const firstRow = rows.first();
    const operationName = (await firstRow.locator('td[data-label="İşlem"] strong').textContent() || '').trim();
    expect(operationName.length).toBeGreaterThan(0);

    // 2. JobDrawer (İşlem durumu modalı) aç
    const inspectBtn = firstRow.locator('button:has-text("İncele")');
    await expect(inspectBtn).toBeVisible();
    await inspectBtn.click();

    const modal = page.locator('dialog.ws-modal, .ws-modal');
    await expect(modal).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('h2, .ws-modal-title', { hasText: 'İşlem durumu' })).toBeVisible();

    // Sahte yüzde/kesir (%50, 1/3 vb.) bulunmadığını doğrula
    const modalText = await modal.innerText();
    expect(modalText).not.toMatch(/\b\d+%/);

    // Gerçek durum, aşama ve deneme sayısı alanlarını doğrula
    await expect(modal.getByText('İş kimliği', { exact: true })).toBeVisible();
    await expect(modal.getByText('Kaynak', { exact: true })).toBeVisible();
    await expect(modal.getByText('Aşama', { exact: true })).toBeVisible();
    await expect(modal.getByText('Deneme sayısı', { exact: true })).toBeVisible();

    // Modal içerisinden tam iş kimliğini çek
    const jobDt = modal.locator('dt').filter({ hasText: /^İş kimliği$/ }).first();
    const jobDd = jobDt.locator('xpath=following-sibling::dd').first();
    capturedJobId = (await jobDd.textContent().catch(() => ''))?.trim();
    if (!capturedJobId || capturedJobId.length < 10) {
      const match = modalText.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
      capturedJobId = match ? match[0] : null;
    }
    expect(capturedJobId).toBeTruthy();

    // Modalı kapat ve kapandığını doğrula
    const closeBtn = modal.locator('button:has-text("Kapat")');
    await closeBtn.click();
    await expect(modal).toBeHidden({ timeout: 10000 });

    // 3. Üst barda Bildirim ve Görev Merkezi çekmecesini aç ve kapat
    const bellBtn = page.locator('button[aria-label="Bildirim ve Görev Merkezi"], button[title="Bildirim ve Görev Merkezi"]');
    await expect(bellBtn).toBeVisible();
    await bellBtn.click();

    const notifDrawer = page.locator('.yp-notification-drawer, dialog.ws-modal, [role="dialog"]').first();
    await expect(notifDrawer).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(notifDrawer).toBeHidden({ timeout: 10000 }).catch(async () => {
      const drawerClose = notifDrawer.locator('button:has-text("Kapat"), button[aria-label="Kapat"]').first();
      if (await drawerClose.isVisible().catch(() => false)) await drawerClose.click();
    });

    // 4. Arama filtresi ve sayfa yenileme (reload) kalıcılığı
    const searchInput = page.locator('.ws-filter-search input[type="search"]');
    const searchSnippet = capturedJobId.slice(0, 8);
    await searchInput.fill(searchSnippet);
    await expect(page).toHaveURL(new RegExp(`q=${searchSnippet}`));

    // Sayfayı yenile (reload) ve URL ile filtrelenmiş kaydın korunduğunu doğrula
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`status=succeeded`));
    await expect(page).toHaveURL(new RegExp(`q=${searchSnippet}`));
    await expect(jobsTable).toBeVisible({ timeout: 15000 });
    const filteredRows = jobsTable.locator('tbody tr');
    await expect(filteredRows.first()).toBeVisible({ timeout: 15000 });
    const filteredCount = await filteredRows.count();
    expect(filteredCount).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < filteredCount; i++) {
      await expect(filteredRows.nth(i).locator('td[data-label="İşlem"] small')).toContainText(searchSnippet);
    }

    // 5. Fiziksel Sonuç Kontrolleri (API ve Disk)
    // a) API üzerinden iş kaydı sorgusu: payload maskelenmiş olmalı, id ve durum uyuşmalı
    const jobApiRes = await page.request.get(`/api/panel/jobs/${encodeURIComponent(capturedJobId)}`);
    expect(jobApiRes.status()).toBe(200);
    const jobApiData = await jobApiRes.json();
    expect(jobApiData?.data?.id).toBe(capturedJobId);
    expect(jobApiData?.data?.status).toBe('succeeded');
    expect(jobApiData?.data?.payload).toBeUndefined();

    // b) Fiziksel sunucu disk doğrulaması (/var/lib/yunpanel/control-plane/job-registry.json)
    const diskCheck = runSsh(`python3 -c 'import json; d=json.load(open("/var/lib/yunpanel/control-plane/job-registry.json")); match=[j for j in d.get("jobs", []) if j.get("id") == "${capturedJobId}"]; print("FOUND" if match else "MISSING")'`);
    expect(diskCheck).toContain('FOUND');
  });

  test('hatalı girdi ve sınır durumları: eşleşmeyen Türkçe arama, sayfalama butonları, olmayan iş kimliği, geçersiz durum ve tamamlanmış işi iptal engeli', async ({ page }) => {
    await ensureOwnerLoggedIn(page);
    await page.goto('/jobs');
    await expect(page.locator('h1', { hasText: 'İşler' })).toBeVisible({ timeout: 15000 });

    // 1. Türkçe karakterli eşleşmeyen arama
    const searchInput = page.locator('.ws-filter-search input[type="search"]');
    await searchInput.fill('ğüşıöçİ-eşleşmeyen-kayıt-99999');
    await expect(page).toHaveURL(/q=%C4%9F%C3%BC%C5%9F/);

    const emptyOrNoRows = page.locator('.ws-empty, .ws-empty-state').or(page.getByText('Henüz işlem kaydı yok')).or(page.getByText('0 kayıt'));
    await expect(emptyOrNoRows.first()).toBeVisible({ timeout: 10000 });

    // Sayfalama butonları devre dışı olmalı
    const prevBtn = page.locator('footer.ws-pagination button:has-text("Önceki")');
    const nextBtn = page.locator('footer.ws-pagination button:has-text("Sonraki")');
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeDisabled();

    // 2. Tamamlanmış iş satırlarında "İptal et" butonu bulunmamalı
    await page.goto('/jobs?status=succeeded');
    const tableRows = page.locator('table.ws-jobs-table tbody tr, table.ws-table tbody tr');
    await expect(tableRows.first()).toBeVisible({ timeout: 15000 });
    const cancelButtonsInRow = tableRows.first().locator('button:has-text("İptal et")');
    await expect(cancelButtonsInRow).toHaveCount(0);

    // 3. API Sınır Kontrolleri
    // a) Olmayan iş kimliği -> 404 job_not_found
    const missingRes = await page.request.get('/api/panel/jobs/00000000-0000-4000-8000-000000000000');
    expect(missingRes.status()).toBe(404);
    const missingData = await missingRes.json();
    expect(missingData?.error?.code || missingData?.code).toBe('job_not_found');

    // b) Geçersiz durum filtresi -> 400 invalid_status
    const invalidStatusRes = await page.request.get('/api/panel/jobs?status=invented_status');
    expect(invalidStatusRes.status()).toBe(400);
    const invalidStatusData = await invalidStatusRes.json();
    expect(invalidStatusData?.error?.code || invalidStatusData?.code).toBe('invalid_status');

    // c) Sırada olmayan (tamamlanmış) işi API üzerinden iptal etme denemesi -> 409 job_not_cancellable
    if (capturedJobId) {
      const cancelAttempt = await page.evaluate(async (jobId) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const res = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => null);
        return { status: res.status, data };
      }, capturedJobId);

      expect(cancelAttempt.status).toBe(409);
      expect(cancelAttempt.data?.error?.code || cancelAttempt.data?.code).toBe('job_not_cancellable');
    }
  });

  test('yetki ve kiracı izolasyonu (RBAC): Müşteri (Customer) hesabı yalnız kendi sitelerinin işlerini görebilir; Owner/başka işlere erişemez', async ({ page, browser }) => {
    await ensureOwnerLoggedIn(page);

    // 1. Owner olarak Müşteriler (/customers) ekranından doğrudan yeni bir müşteri hesabı oluştur
    await page.goto('/customers');
    await expect(page.locator('h1', { hasText: 'Müşteriler' })).toBeVisible({ timeout: 15000 });

    await page.locator('button:has-text("Müşteri ekle")').click();
    const createDialog = page.locator('dialog[open], .ws-modal');
    await expect(createDialog).toBeVisible({ timeout: 10000 });
    await createDialog.locator('label:has-text("Kullanıcı adı") input').fill(CUST_USER);
    await createDialog.locator('label:has-text("İlk parola") input').fill(TEST_PASS);
    await createDialog.locator('button[type="submit"]:has-text("Hesabı oluştur")').click();
    await expect(createDialog).toBeHidden({ timeout: 15000 });

    // Müşterinin listede var olduğunu doğrula
    await page.goto('/customers');
    const custRow = await findAccountRow(page, CUST_USER);
    await expect(custRow).toBeVisible();

    // 2. Yeni tarayıcı bağlamında Müşteri olarak oturum aç
    const custContext = await browser.newContext({ ignoreHTTPSErrors: true });
    const custPage = await custContext.newPage();
    try {
      await loginAs(custPage, CUST_USER, TEST_PASS);

      // Müşteri /jobs sayfasına gider
      await custPage.goto('/jobs');
      await expect(custPage.locator('h1', { hasText: 'İşler' })).toBeVisible({ timeout: 15000 });

      // Müşterinin hiç sitesi olmadığı için tablo boş olmalı (0 kayıt / Henüz işlem kaydı yok)
      const emptyState = custPage.locator('.ws-empty, .ws-empty-state').or(custPage.getByText('Henüz işlem kaydı yok')).or(custPage.getByText('0 kayıt'));
      await expect(emptyState.first()).toBeVisible({ timeout: 10000 });

      // 3. Müşteri oturumundan Owner'ın iş kimliğine doğrudan erişim engellenmeli (403 site_scope_forbidden)
      if (capturedJobId) {
        const forbiddenGetRes = await custPage.request.get(`/api/panel/jobs/${encodeURIComponent(capturedJobId)}`);
        expect(forbiddenGetRes.status()).toBe(403);
        const forbiddenGetData = await forbiddenGetRes.json();
        expect(forbiddenGetData?.error?.code || forbiddenGetData?.code).toBe('site_scope_forbidden');

        // Müşteri oturumundan Owner'ın işini iptal etme denemesi engellenmeli (403 site_scope_forbidden)
        const forbiddenCancel = await custPage.evaluate(async (jobId) => {
          const sessionResp = await fetch('/api/auth/session').catch(() => null);
          const sessionData = await sessionResp?.json().catch(() => null);
          const csrf = sessionData?.data?.csrfToken;
          const res = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
            body: JSON.stringify({}),
          });
          const data = await res.json().catch(() => null);
          return { status: res.status, data };
        }, capturedJobId);

        expect(forbiddenCancel.status).toBe(403);
        expect(forbiddenCancel.data?.error?.code || forbiddenCancel.data?.code).toBe('site_scope_forbidden');
      }
    } finally {
      await custContext.close();
    }
  });

  test('bilinen hata (test.fail): Başarısız işler için manuel Yeniden dene (retry) butonu ve HTTP rotası bağlı değil', async ({ page }) => {
    test.fail(true, 'BULGU UX-06: Başarısız işler için manuel Yeniden dene (retry) butonu arayüzde bağlı değil ve POST /api/jobs/:jobId/retry HTTP rotası bulunmuyor');

    await ensureOwnerLoggedIn(page);

    // Sunucudaki başarısız bir işin kimliğini tespit et
    const failedCheck = runSsh(`python3 -c 'import json; d=json.load(open("/var/lib/yunpanel/control-plane/job-registry.json")); failed=[j["id"] for j in d.get("jobs", []) if j.get("status") == "failed"]; print(failed[0] if failed else "NONE")'`);
    if (failedCheck && failedCheck !== 'NONE' && failedCheck.includes('-')) {
      capturedFailedJobId = failedCheck.trim();
    }

    // /jobs ekranında Başarısız işleri filtrele
    await page.goto('/jobs?status=failed');
    await expect(page.locator('h1', { hasText: 'İşler' })).toBeVisible({ timeout: 15000 });

    const failedRows = page.locator('table.ws-jobs-table tbody tr, table.ws-table tbody tr');
    await expect(failedRows.first()).toBeVisible({ timeout: 10000 });

    // Başarısız iş satırında veya JobDrawer içinde "Yeniden dene" butonunun görünür olması beklenir
    // Ancak onRetry prop'u geçilmediğinden ve backend rotası olmadığından buton render edilmez ve bu test düşer (test.fail yakalar)
    const retryBtn = failedRows.first().locator('button:has-text("Yeniden dene")');
    await expect(retryBtn).toBeVisible({ timeout: 3000 });

    // Eğer buton görünür olursa API rotasının da 200 dönmesi beklenir:
    if (capturedFailedJobId) {
      const retryResult = await page.evaluate(async (jobId) => {
        const sessionResp = await fetch('/api/auth/session').catch(() => null);
        const sessionData = await sessionResp?.json().catch(() => null);
        const csrf = sessionData?.data?.csrfToken;
        const res = await fetch(`/api/panel/jobs/${encodeURIComponent(jobId)}/retry`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({}),
        });
        return { status: res.status };
      }, capturedFailedJobId);

      expect(retryResult.status).toBe(200);
    }
  });
});
