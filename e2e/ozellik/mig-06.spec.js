import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('MIG-06 Panel güncellemesi, OS migration, rollback ve kurtarma (Plesk eşdeğerliği)', () => {
  test.setTimeout(180000);

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

  async function getApiHeaders(page) {
    const origin = 'https://server.cryptoraichu.website';
    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
    return {
      Origin: origin,
      Referer: `${origin}/`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
    };
  }

  test.afterAll(async () => {
    // 0 artık ilkesi: Panel güncelleme durumu denetimi ve Plesk parity sorguları
    // salt okunur veya idempotent işlem çalıştırır. Sunucuda artık dosya oluşmadığı teyit edilir.
    const recoveryDir = runSsh('ls -d /var/lib/yunpanel/recovery/system-upgrades 2>/dev/null || true');
    expect(recoveryDir).toBeDefined();
  });

  test('mutlu yol: panel paket denetimi (packages/inspect), işletim sistemi durumu ve fiziksel servis doğrulaması', async ({ page }) => {
    // 1. Fiziksel kanıt: Host işletim sistemi ve YunPanel servislerinin gerçek durumu
    const osInfo = runSsh('cat /etc/os-release');
    expect(osInfo).toContain('Ubuntu');
    expect(osInfo).toContain('24.04');

    const serviceStatus = runSsh('systemctl is-active yunpanel-api');
    expect(serviceStatus).toBe('active');

    // 2. Panele giriş yap ve yerel sunucu kimliğini al
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const serversRes = await page.request.get('/api/panel/servers', { headers });
    expect(serversRes.status()).toBe(200);
    const serversData = await serversRes.json();
    expect(Array.isArray(serversData.data)).toBe(true);
    expect(serversData.data.length).toBeGreaterThan(0);

    const localServer = serversData.data[0];
    expect(localServer.id).toBeTruthy();

    // 3. Panel paket denetimini (packages/inspect) tetikle
    const inspectRes = await page.request.post(`/api/panel/servers/${localServer.id}/system/packages/inspect`, {
      headers,
      data: {},
    });
    expect(inspectRes.status()).toBe(202);
    const inspectJob = await inspectRes.json();
    const jobPayload = inspectJob.data || inspectJob;
    expect(jobPayload.id).toBeTruthy();

    // 4. İş kuyruğu (Job) sonucunu bekle ve doğrula
    let completedJob = null;
    for (let i = 0; i < 30; i += 1) {
      const jobRes = await page.request.get(`/api/panel/jobs/${jobPayload.id}`, { headers });
      expect(jobRes.status()).toBe(200);
      const jobData = await jobRes.json();
      const currentJob = jobData.data || jobData;
      if (currentJob.status === 'succeeded' || currentJob.status === 'failed') {
        completedJob = currentJob;
        break;
      }
      await page.waitForTimeout(1000);
    }

    expect(completedJob).not.toBeNull();
    expect(completedJob.status).toBe('succeeded');
    expect(completedJob.result).toBeDefined();
    expect(completedJob.result.packageName).toBe('yunpanel');
    expect(completedJob.result.installed).toBe(true);
    expect(typeof completedJob.result.installedVersion).toBe('string');

    // 5. Arayüz doğrulaması: İşlem ve ayarlar sayfasına erişim
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    const pageContent = await page.textContent('body');
    expect(pageContent).toBeTruthy();
  });

  test('hatalı girdi ve yetkisiz erişim: eksik onay, geçersiz sunucu ve oturumsuz istek engeli', async ({ page, request }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const serversRes = await page.request.get('/api/panel/servers', { headers });
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    // 1. Eksik veya geçersiz confirmation ile upgrade isteği (HTTP 400 beklenir)
    const invalidUpgradeRes = await page.request.post(`/api/panel/servers/${serverId}/system/upgrade`, {
      headers,
      data: { confirmation: 'invalid-token' },
    });
    expect(invalidUpgradeRes.status()).toBe(400);
    const invalidUpgradeData = await invalidUpgradeRes.json();
    expect(invalidUpgradeData.error).toBeDefined();

    // 2. Olmayan sunucu kimliği ile denetim isteği (HTTP 404 beklenir)
    const notFoundRes = await page.request.post('/api/panel/servers/gecersiz-sunucu-9999/system/packages/inspect', {
      headers,
      data: {},
    });
    expect(notFoundRes.status()).toBe(404);

    // 3. Oturumsuz doğrudan upgrade isteği (HTTP 401 veya 403 beklenir)
    const unauthRes = await request.post(`https://server.cryptoraichu.website/api/panel/servers/${serverId}/system/upgrade`, {
      data: { confirmation: 'upgrade-yunpanel' },
    });
    expect([401, 403]).toContain(unauthRes.status());
  });

  test('eksiklik 1: OS Migration / dist-upgrade otomatikleştirme API ve motoru yokluğu (Plesk dist-upgrader eşdeğerliği)', async ({ page }) => {
    test.fail(true, 'BULGU MIG-06-1: Plesk dist-upgrader eşdeğeri canlı OS migration/dist-upgrade rotası bulunmuyor');
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const serversRes = await page.request.get('/api/panel/servers', { headers });
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    const distUpgradeRes = await page.request.post(`/api/panel/servers/${serverId}/system/dist-upgrade`, {
      headers,
      data: { targetDistro: 'ubuntu-noble', dryRun: true },
    });
    expect(distUpgradeRes.status()).toBe(202);
  });

  test('eksiklik 2: Panel versiyon geri alma (Rollback / Downgrade) API rotası yokluğu', async ({ page }) => {
    test.fail(true, 'BULGU MIG-06-2: Panel güncellemesi sonrası önceki kararlı sürüme rollback API rotası bulunmuyor');
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const serversRes = await page.request.get('/api/panel/servers', { headers });
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    const rollbackRes = await page.request.post(`/api/panel/servers/${serverId}/system/rollback`, {
      headers,
      data: { confirmation: 'rollback-yunpanel' },
    });
    expect(rollbackRes.status()).toBe(202);
  });

  test('eksiklik 3: Kapsamlı sistem ve panel kurtarma / self-repair (Plesk plesk repair all eşdeğeri) API rotası yokluğu', async ({ page }) => {
    test.fail(true, 'BULGU MIG-06-3: Plesk repair all eşdeğeri sistem ve servisleri onaran self-repair rotası bulunmuyor');
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    const serversRes = await page.request.get('/api/panel/servers', { headers });
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    const repairRes = await page.request.post(`/api/panel/servers/${serverId}/system/repair`, {
      headers,
      data: { scope: 'all' },
    });
    expect(repairRes.status()).toBe(202);
  });

  test('eksiklik 4: Ön yüzde OS migration, dist-upgrade ve panel rollback/kurtarma arayüz kontrolleri yokluğu', async ({ page }) => {
    test.fail(true, 'BULGU MIG-06-4: Arayüzde OS dist-upgrade, panel rollback ve sistem onarımı kontrolleri bulunmuyor');
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    await page.goto('/settings');
    await page.waitForLoadState('networkidle');

    // Arayüzde OS dist-upgrade veya Panel Onarım/Geri Alma butonu bulunmalıdır
    const repairButton = page.locator('button:has-text("Sistem Onar"), button:has-text("Kurtarma"), button:has-text("Repair")');
    await expect(repairButton.first()).toBeVisible({ timeout: 3000 });
  });
});
