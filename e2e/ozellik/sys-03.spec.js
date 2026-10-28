import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SYS-03 Hostname, saat/saat dilimi ve sistem ayarları', () => {
  test.setTimeout(180000);

  let initialSettings = null;

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

  async function apiCall(page, path, options = {}) {
    return page.evaluate(async ({ path, options }) => {
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

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const res = await apiCall(page, '/api/panel/settings');
    if (res.ok && res.data?.data) {
      initialSettings = res.data.data;
    }
    await page.close();
  });

  test.afterAll(async ({ browser }) => {
    // 0 artık ilkesi: Başlangıçtaki sistem ayarlarını orijinal haline getir
    if (initialSettings) {
      try {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        await apiCall(page, '/api/panel/settings', {
          method: 'PATCH',
          body: {
            dnsSsl: {
              acmeEmail: initialSettings.dnsSsl?.acmeEmail ?? null,
              autoRenewDaysBeforeExpiry: initialSettings.dnsSsl?.autoRenewDaysBeforeExpiry ?? 30,
            },
            websiteDefaults: {
              defaultRuntime: initialSettings.websiteDefaults?.defaultRuntime ?? 'node',
              defaultNodeMajor: initialSettings.websiteDefaults?.defaultNodeMajor ?? 24,
              defaultPhpVersion: initialSettings.websiteDefaults?.defaultPhpVersion ?? '8.3',
            },
            backupDefaults: {
              retentionDaily: initialSettings.backupDefaults?.retentionDaily ?? 7,
              retentionWeekly: initialSettings.backupDefaults?.retentionWeekly ?? 4,
              retentionMonthly: initialSettings.backupDefaults?.retentionMonthly ?? 12,
            },
          },
        });
        await page.close();
      } catch {
        // ignore cleanup errors
      }
    }
  });

  test('Mutlu yol: Sunucu hostname, çalışma süresi ve sistem ayarları arayüz ve API üzerinden doğrulanır', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    // 1. Sunucu sayfası başlığı ve ana kart
    await expect(page.getByRole('heading', { name: 'Sunucu' })).toBeVisible({ timeout: 15000 });

    // 2. Tanılama ve yazılım bilgileri akordiyonu açılır
    const diagnosticsDetails = page.locator('#server-diagnostics');
    await expect(diagnosticsDetails).toBeVisible({ timeout: 10000 });
    const isOpened = await diagnosticsDetails.getAttribute('open');
    if (isOpened === null) {
      await diagnosticsDetails.locator('summary').click();
    }

    // 3. Panel ve sunucu bölümü doğrulanır
    const panelSection = page.locator('section').filter({ hasText: 'Panel ve sunucu' });
    await expect(panelSection).toBeVisible({ timeout: 10000 });
    await expect(panelSection.getByText('Panel sürümü')).toBeVisible();
    await expect(panelSection.getByText('Node.js sürümü')).toBeVisible();
    await expect(panelSection.getByText('Sunucu adı (Hostname)')).toBeVisible();

    // 4. API üzerinden sistem ayarları detayları sorgulanır
    const res = await apiCall(page, '/api/panel/settings');
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);

    const data = res.data.data;
    expect(data.panel).toBeDefined();
    expect(typeof data.panel.version).toBe('string');
    expect(data.panel.platform).toBe('linux');
    expect(typeof data.panel.hostname).toBe('string');
    expect(data.panel.hostname.length).toBeGreaterThan(0);
    expect(data.panel.executionMode).toBe('local');

    // Varsayılan çalışma zamanları ve depolama servisleri
    expect(data.websiteDefaults).toBeDefined();
    expect(data.dnsSsl).toBeDefined();
    expect(data.mail).toBeDefined();
    expect(data.database).toBeDefined();
    expect(data.security).toBeDefined();

    // 5. Sistem ayarları PATCH güncellemesi ve doğrulaması (zararsız alan testi)
    const patchRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: {
        dnsSsl: {
          autoRenewDaysBeforeExpiry: 25,
        },
      },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.data.dnsSsl.autoRenewDaysBeforeExpiry).toBe(25);
  });

  test('Hatalı girdi: Geçersiz sistem ayarları ve geçersiz formatlar 400 ile reddedilir', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    const getErrorCode = (r) => r.data?.error?.code || r.data?.code;

    // 1. Geçersiz ACME email formatı
    const invalidEmailRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: {
        dnsSsl: {
          acmeEmail: 'invalid-not-an-email',
        },
      },
    });
    expect(invalidEmailRes.status).toBe(400);
    expect(getErrorCode(invalidEmailRes)).toBe('invalid_acme_email');

    // 2. Desteklenmeyen varsayılan runtime
    const invalidRuntimeRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: {
        websiteDefaults: {
          defaultRuntime: 'unsupported-ruby',
        },
      },
    });
    expect(invalidRuntimeRes.status).toBe(400);
    expect(getErrorCode(invalidRuntimeRes)).toBe('invalid_default_runtime');

    // 3. Sınır dışı Node.js sürümü (< 18 veya > 30)
    const invalidNodeRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: {
        websiteDefaults: {
          defaultNodeMajor: 12,
        },
      },
    });
    expect(invalidNodeRes.status).toBe(400);
    expect(getErrorCode(invalidNodeRes)).toBe('invalid_default_node_major');

    // 4. Sınır dışı otomatik yenileme gün sayısı (> 90)
    const invalidDaysRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: {
        dnsSsl: {
          autoRenewDaysBeforeExpiry: 120,
        },
      },
    });
    expect(invalidDaysRes.status).toBe(400);
    expect(getErrorCode(invalidDaysRes)).toBe('invalid_auto_renew_days');

    // 5. Geçersiz patch yapısı (dizi gönderimi)
    const invalidPatchRes = await apiCall(page, '/api/panel/settings', {
      method: 'PATCH',
      body: ['not', 'an', 'object'],
    });
    expect(invalidPatchRes.status).toBe(400);
    expect(getErrorCode(invalidPatchRes)).toBe('invalid_patch');
  });

  test('Fiziksel kanıt: SSH ile sunucu hostname, timedatectl saat/saat dilimi ve API tutarlılığı', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 1. Canlı test sunucusunda doğrudan SSH ile hostname sorgulanır
    const sshHostname = runSsh('hostname');
    expect(sshHostname.length).toBeGreaterThan(0);

    // 2. Canlı test sunucusunda timedatectl ile saat ve saat dilimi sorgulanır
    const timedatectlOutput = runSsh('timedatectl status');
    expect(timedatectlOutput).toContain('Time zone:');
    expect(timedatectlOutput).toContain('Local time:');

    // 3. Panel API'sinden okunan hostname fiziksel sunucu ile tutarlıdır
    const res = await apiCall(page, '/api/panel/settings');
    expect(res.status).toBe(200);
    const panelHostname = res.data.data.panel.hostname;
    expect(panelHostname).toBe(sshHostname);

    // 4. Uptime süresi pozitif bir tamsayıdır
    expect(res.data.data.panel.uptimeSeconds).toBeGreaterThan(0);
  });

  test('Plesk Parity Eksikliği: Sistem saati, saat dilimi (Timezone) ve NTP yapılandırma arayüzü', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    // Plesk "Tools & Settings" -> "System Time" ekranında:
    // - Sistem tarihi ve saati gösterilir.
    // - Saat dilimi (Time zone) bir dropdown listeden seçilip kaydedilebilir (ör. timedatectl set-timezone).
    // - Otomatik zaman eşitlemesi için NTP sunucusu (NTP server address) yapılandırılabilir ve "Update Now" ile eşitlenebilir.
    // YunPanel arayüzünde ve sistem ayarları API'sinde bu kontroller yer almamaktadır.
    test.fail(
      true,
      'BULGU SYS-03-A: Plesk eşdeğeri Sistem Saati, Saat Dilimi (Time Zone) değiştirme ve NTP senkronizasyon yönetimi YunPanel arayüzünde ve sistem ayarları API sinde bulunmuyor',
    );

    const timeSection = page.locator('section').filter({ hasText: /Sistem Saati|Saat Dilimi|NTP/i });
    await expect(timeSection).toBeVisible({ timeout: 5000 });
  });

  test('Plesk Parity Eksikliği: Sunucu Hostname (FQDN) değiştirme ve kaydetme arayüzü', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/servers');

    // Plesk "Tools & Settings" -> "Server Settings" ekranında:
    // - Sunucunun tam hostname'i (Full hostname / FQDN) bir girdi alanında düzenlenip kaydedilebilir.
    // YunPanel'de hostname salt okunur gösterilmektedir; düzenleme formu veya PATCH/PUT endpoint desteği yoktur.
    test.fail(
      true,
      'BULGU SYS-03-B: Plesk eşdeğeri Sunucu Hostname (FQDN) değiştirme/güncelleme formu ve ayar uç noktası bulunmuyor (Hostname salt okunur)',
    );

    const hostnameInput = page.locator('input[name="hostname"], input#server-hostname');
    await expect(hostnameInput).toBeVisible({ timeout: 5000 });
  });
});
