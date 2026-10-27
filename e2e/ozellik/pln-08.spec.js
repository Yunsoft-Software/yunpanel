import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.describe('PLN-08 Disk, trafik, domain, mailbox, DB ve kullanıcı adet limitleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '1';
  const prefix = `tpln08-a${agentN}-${Date.now().toString(36)}`;
  const resellerUser = `${prefix}-res`;
  const customerUser = `${prefix}-cust`;
  const testPassword = 'Password12345678!';
  const firstDomain = `${prefix}.example.internal`;
  const overflowDomain = `${prefix}-overflow.example.internal`;

  let ownerContext = null;
  let page = null;
  let resellerContext = null;
  let resellerPage = null;

  let resellerId = null;
  let customerId = null;
  let createdSiteId = null;
  let localServerId = null;

  async function apiCall(targetPage, path, options = {}) {
    return targetPage.evaluate(async ({ path, options }) => {
      const headers = { ...(options.headers || {}) };
      if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
        const s = await fetch('/api/auth/session').then((r) => r.json()).catch(() => null);
        const csrf = s?.data?.csrfToken || s?.csrfToken;
        if (csrf) {
          headers['x-csrf-token'] = csrf;
        }
      }
      if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, ok: res.ok, data };
    }, { path, options });
  }

  async function ensureOwnerLoggedIn(targetPage) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await loginAs(targetPage, OWNER_USERNAME, OWNER_PASSWORD);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await targetPage.goto('/');
        await targetPage.waitForTimeout(2000);
      }
    }
  }

  test.beforeAll(async ({ browser }) => {
    ownerContext = await browser.newContext({ ignoreHTTPSErrors: true });
    page = await ownerContext.newPage();
    await ensureOwnerLoggedIn(page);
  });

  test.afterAll(async () => {
    try {
      if (page) {
        // 1. Oluşturulan web sitesini temizle
        if (createdSiteId) {
          await page.request.delete(`/api/websites/${encodeURIComponent(createdSiteId)}`).catch((err) => {
            console.warn('PLN-08 cleanup website warning:', err.message);
          });
        }

        // 2. Müşteri hesabını temizle
        if (customerId) {
          await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(customerId)}/login`, {
            data: {},
          }).catch((err) => {
            console.warn('PLN-08 cleanup customer warning:', err.message);
          });
        }

        // 3. Bayi hesabını temizle (profil unregister + user delete)
        if (resellerId) {
          const resProfile = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(resellerId)}`).then((r) => r.json()).catch(() => null);
          if (resProfile?.data?.revision) {
            const rev = resProfile.data.revision;
            await page.request.delete(`/api/panel/users/hosting/accounts/${encodeURIComponent(resellerId)}/profile`, {
              data: {
                revision: rev,
                confirmation: `unregister-hosting-profile:${resellerId}:${rev}`,
              },
            }).catch((err) => {
              console.warn('PLN-08 cleanup reseller profile warning:', err.message);
            });
          }

          const userObj = await page.request.get(`/api/panel/users/${encodeURIComponent(resellerId)}`).then((r) => r.json()).catch(() => null);
          const userRev = userObj?.data?.revision ?? 1;
          await page.request.delete(`/api/panel/users/${encodeURIComponent(resellerId)}`, {
            data: { revision: userRev },
          }).catch((err) => {
            console.warn('PLN-08 cleanup reseller user warning:', err.message);
          });
        }
      }
    } catch (err) {
      console.warn('PLN-08 afterAll error:', err.message);
    } finally {
      if (resellerContext) await resellerContext.close().catch(() => {});
      if (ownerContext) await ownerContext.close().catch(() => {});
    }
  });

  test('01. Mutlu yol: Müşteriye disk, trafik, domain/website ve veritabanı limitlerinin atanması ve arayüzde gösterimi', async () => {
    // 1. Bayi oluştur (Owner oturumu)
    await page.goto('/resellers');
    await expect(page.locator('h1', { hasText: 'Bayiler' })).toBeVisible({ timeout: 15000 });

    const addResellerBtn = page.locator('button:has-text("Bayi ekle")');
    await expect(addResellerBtn).toBeVisible();
    await addResellerBtn.click();

    const resModal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Bayi ekle' });
    await expect(resModal).toBeVisible({ timeout: 10000 });

    await resModal.locator('label:has-text("Kullanıcı adı") input').fill(resellerUser);
    await resModal.locator('label:has-text("İlk parola") input').fill(testPassword);
    await resModal.locator('label:has-text("En fazla müşteri") input').fill('5');
    await resModal.locator('label:has-text("En fazla web sitesi") input').fill('5');

    const submitResBtn = resModal.locator('button[type="submit"]:has-text("Hesabı oluştur")');
    await expect(submitResBtn).toBeEnabled();
    await submitResBtn.click();

    const resNotice = page.locator('.ws-notice').filter({ hasText: 'hesabı oluşturuldu' });
    await expect(resNotice).toContainText(new RegExp(`${resellerUser} hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Bayi ID'sini al
    const resListRes = await page.request.get('/api/panel/users/hosting/accounts?kind=reseller&limit=50');
    expect(resListRes.status()).toBe(200);
    const resListData = await resListRes.json();
    const createdRes = resListData.data.accounts.find((a) => a.username === resellerUser);
    expect(createdRes).toBeTruthy();
    resellerId = createdRes.id;

    // 2. Ayrı tarayıcı bağlamında Reseller oturumu aç (Owner oturumu bozulmaz)
    resellerContext = await page.context().browser().newContext({ ignoreHTTPSErrors: true });
    resellerPage = await resellerContext.newPage();
    await loginAs(resellerPage, resellerUser, testPassword);
    await resellerPage.goto('/customers');
    await expect(resellerPage.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    // 3. Müşteri oluştur (Reseller tarafından)
    const addCustBtn = resellerPage.locator('button:has-text("Müşteri ekle")');
    await expect(addCustBtn).toBeVisible();
    await addCustBtn.click();

    const custModal = resellerPage.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Müşteri ekle' });
    await expect(custModal).toBeVisible({ timeout: 10000 });

    await custModal.locator('label:has-text("Kullanıcı adı") input').fill(customerUser);
    await custModal.locator('label:has-text("İlk parola") input').fill(testPassword);

    const submitCustBtn = custModal.locator('button[type="submit"]:has-text("Müşteriyi oluştur")');
    await expect(submitCustBtn).toBeEnabled();
    await submitCustBtn.click();

    const custNotice = resellerPage.locator('.ws-notice').filter({ hasText: 'müşteri hesabı oluşturuldu' });
    await expect(custNotice).toContainText(new RegExp(`${customerUser} müşteri hesabı oluşturuldu`, 'i'), { timeout: 15000 });

    // Müşteri satırını bul
    const custRow = resellerPage.locator('table.ws-table tbody tr', { hasText: customerUser });
    await expect(custRow).toBeVisible({ timeout: 10000 });

    // Müşteri ID'sini al
    const custListRes = await page.request.get('/api/panel/users/hosting/accounts?kind=customer&limit=50');
    expect(custListRes.status()).toBe(200);
    const custListData = await custListRes.json();
    const createdCust = custListData.data.accounts.find((a) => a.username === customerUser);
    expect(createdCust).toBeTruthy();
    customerId = createdCust.id;

    // 4. Müşteriye kaynak kotalarını ata (1 Web Sitesi, 1024 MB Disk, 10240 MB Trafik, 2 Veritabanı)
    const quotaBtn = custRow.locator('button:has-text("Kota tahsis et")');
    await expect(quotaBtn).toBeVisible();
    await quotaBtn.click();

    const quotaModal = resellerPage.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Kaynak Kotalarını Yönet' });
    await expect(quotaModal).toBeVisible({ timeout: 10000 });

    await quotaModal.locator('label:has-text("Web Sitesi Kotası") input').fill('1');
    await quotaModal.locator('label:has-text("Disk Kotası") input').fill('1024');
    await quotaModal.locator('label:has-text("Aylık Trafik Kotası") input').fill('10240');
    await quotaModal.locator('label:has-text("Veritabanı Kotası") input').fill('2');

    const saveQuotaBtn = quotaModal.locator('button[type="submit"]:has-text("Kotaları kaydet")');
    await expect(saveQuotaBtn).toBeEnabled();
    await saveQuotaBtn.click();

    const quotaSuccessNotice = resellerPage.locator('.ws-notice').filter({ hasText: 'kotaları güncellendi' });
    await expect(quotaSuccessNotice).toContainText(new RegExp(`${customerUser} müşterisinin kaynak kotaları güncellendi`, 'i'), { timeout: 15000 });

    // 5. Arayüzde kotaların gösterimini doğrula
    await expect(custRow.locator('td').nth(1)).toContainText('0 / 1'); // Web siteleri
    await expect(custRow.locator('td').nth(2)).toContainText('1024 MB'); // Disk kotası
    await expect(custRow.locator('td').nth(3)).toContainText('10240 MB'); // Trafik kotası
    await expect(custRow.locator('td').nth(4)).toContainText('2'); // DB kotası

    // 6. Fiziksel Sonuç Kanıtı (API Kota nesnesi kontrolü)
    const verifyRes = await page.request.get(`/api/panel/users/hosting/accounts/${encodeURIComponent(customerId)}`);
    expect(verifyRes.status()).toBe(200);
    const verifyData = await verifyRes.json();
    const quotas = verifyData.data?.quotas;
    expect(quotas).toBeDefined();
    expect(quotas.maxWebsites).toBe(1);
    expect(quotas.maxDiskMb).toBe(1024);
    expect(quotas.maxTrafficMb).toBe(10240);
    expect(quotas.maxDatabases).toBe(2);
  });

  test('02. Sınır ve aşım senaryosu: Tanımlanan adet limitine ulaşıldığında yeni kaynak oluşturma engeli (UI uyarısı ve 409 customer_quota_exceeded)', async () => {
    // 1. Müşteriye tanımlanan 1 adet siteyi yetkili API üzerinden tahsis et (Owner bağlamı)
    const srvRes = await apiCall(page, '/api/panel/servers');
    expect(srvRes.ok).toBe(true);
    const serverList = Array.isArray(srvRes.data?.data) ? srvRes.data.data : Array.isArray(srvRes.data) ? srvRes.data : [];
    localServerId = serverList[0]?.id;
    expect(localServerId).toBeTruthy();

    const siteInput = {
      operationId: crypto.randomUUID(),
      serverId: localServerId,
      name: firstDomain,
      primaryDomain: firstDomain,
      parentDomainId: null,
      wwwMode: 'alias',
      httpsMode: 'managed',
      source: { kind: 'new_php' },
      database: { mode: 'none' },
      mail: { mode: 'local' },
      dns: { mode: 'local' },
    };

    // Önizleme oluştur
    const previewRes = await apiCall(page, '/api/panel/sites/hosted/create-preview', {
      method: 'POST',
      body: { customerId, input: siteInput },
    });
    expect(previewRes.status).toBe(200);
    const preview = previewRes.data?.data;

    // Siteyi uygula ve tahsis et
    const applyRes = await apiCall(page, '/api/panel/sites/hosted', {
      method: 'POST',
      body: {
        customerId,
        input: siteInput,
        previewDigest: preview.previewDigest,
        confirmation: preview.confirmation,
      },
    });
    expect([200, 201]).toContain(applyRes.status);
    createdSiteId = applyRes.data?.data?.website?.id || applyRes.data?.data?.websiteId || applyRes.data?.data?.id;

    // 2. Reseller oturumu ile /customers sayfasına git ve arayüzdeki kota aşımı durumunu doğrula
    // Not: Site tahsis edildiğinde sistem güvenlik amacıyla reseller oturumunu yeniler (revokeLiveUser: hosting_website_attached).
    await loginAs(resellerPage, resellerUser, testPassword);
    await resellerPage.goto('/customers');
    await expect(resellerPage.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    const custRow = resellerPage.locator('table.ws-table tbody tr', { hasText: customerUser });
    await expect(custRow).toBeVisible({ timeout: 10000 });

    // Satırda kullanım 1 / 1 olmalı
    await expect(custRow.locator('td').nth(1)).toContainText('1 / 1');

    // UI Rozet durumu: 'Etkin (Kota Doldu)'
    await expect(custRow.locator('td').nth(0)).toContainText('Etkin (Kota Doldu)');

    // UI Uyarı metni: 'Kota doldu'
    await expect(custRow.locator('.ws-field-hint', { hasText: 'Kota doldu' })).toBeVisible();

    // UI Buton engeli: 'Site tahsis et' butonu devre dışı (disabled) olmalı
    const disabledAllocateBtn = custRow.locator('button:has-text("Site tahsis et")');
    await expect(disabledAllocateBtn).toBeDisabled();
    await expect(disabledAllocateBtn).toHaveAttribute('title', 'Müşteri web sitesi kotası doldu');

    // 3. Fiziksel Sonuç Kanıtı: API Kaynak Sınırı (409 Conflict customer_quota_exceeded)
    const overflowInput = {
      operationId: crypto.randomUUID(),
      serverId: localServerId,
      name: overflowDomain,
      primaryDomain: overflowDomain,
      parentDomainId: null,
      wwwMode: 'alias',
      httpsMode: 'managed',
      source: { kind: 'new_php' },
      database: { mode: 'none' },
      mail: { mode: 'local' },
      dns: { mode: 'local' },
    };

    const overflowRes = await apiCall(page, '/api/panel/sites/hosted/create-preview', {
      method: 'POST',
      body: { customerId, input: overflowInput },
    });

    expect(overflowRes.status).toBe(409);
    const errorCode = overflowRes.data?.error?.code || overflowRes.data?.code;
    expect(errorCode).toBe('customer_quota_exceeded');
  });

  test('03. Bilinen Bulgu: Reseller rolü servers.read iznine sahip olmadığı için AllocateSiteDialog serverId yükleyemiyor ve form kilitli kalıyor', async () => {
    test.fail(true, 'BULGU PLN-08: Reseller kullanıcısının servers.read yetkisi bulunmadığı için AllocateSiteDialog içinde serverId yüklenemiyor ve form disabled kalıyor');

    await resellerPage.goto('/customers');
    await expect(resellerPage.locator('h1', { hasText: 'Müşterilerim' })).toBeVisible({ timeout: 15000 });

    const custRow = resellerPage.locator('table.ws-table tbody tr', { hasText: customerUser });
    const allocateBtn = custRow.locator('button:has-text("Site tahsis et")');

    // Bu test, formun etkin olmasını bekler; ancak servers.read yetkisi eksik olduğundan form disabled kalır ve test.fail ile işaretlenmiştir.
    await expect(allocateBtn).toBeEnabled({ timeout: 2000 });
  });
});
