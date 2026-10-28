import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SYS-01 IP havuzu, IPv4/IPv6, shared/dedicated ve remap', () => {
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
    };
  }

  test.afterAll(async () => {
    // 0 Artık ilkesi: Bu test yalnızca sistem ağ envanterini ve validasyonlarını
    // sorgular, kalıcı geçici veri bırakmaz.
  });

  test('mutlu yol: sunucu fiziksel ağ arayüzleri ve IPv4/IPv6 adreslerinin tespiti ve API envanteri', async ({ page }) => {
    // 1. Fiziksel kanıt: Host işletim sisteminden gerçek ağ arayüzleri ve IP'leri oku
    const sshOutput = runSsh('ip -br a');
    expect(sshOutput).toContain('ens18');
    expect(sshOutput).toContain('157.180.11.28');

    // 2. Panele giriş yap ve API üzerinden sunucu ağ envanterini sorgula
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    const serversRes = await page.request.get('/api/panel/servers');
    expect(serversRes.status()).toBe(200);
    const serversData = await serversRes.json();
    expect(Array.isArray(serversData.data)).toBe(true);
    expect(serversData.data.length).toBeGreaterThan(0);

    const localServer = serversData.data[0];
    expect(localServer).toBeDefined();
    expect(localServer.id).toBeTruthy();
    expect(localServer.inventory).toBeDefined();
    expect(Array.isArray(localServer.inventory.network)).toBe(true);

    const networkEntries = localServer.inventory.network;
    expect(networkEntries.length).toBeGreaterThan(0);

    // IPv4 ve IPv6 tespiti
    const ipv4Entries = networkEntries.filter((n) => n.family === 'IPv4');
    const ipv6Entries = networkEntries.filter((n) => n.family === 'IPv6');

    expect(ipv4Entries.length).toBeGreaterThan(0);
    expect(ipv6Entries.length).toBeGreaterThan(0);

    const mainIpv4 = ipv4Entries.find((n) => n.address === '157.180.11.28');
    expect(mainIpv4).toBeDefined();
    expect(mainIpv4?.interface).toBe('ens18');

    // Sunucu tekil detay uç noktasını doğrula
    const serverDetailRes = await page.request.get(`/api/panel/servers/${localServer.id}`);
    expect(serverDetailRes.status()).toBe(200);
    const serverDetail = await serverDetailRes.json();
    expect(serverDetail.data.inventory.network).toEqual(networkEntries);

    // 3. Arayüzde DNS & Ağ ayarları ekranını ziyaret et
    await page.goto('/settings?section=dns');
    await expect(page.getByRole('heading', { name: 'Ayarlar' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Network / Authoritative DNS')).toBeVisible({ timeout: 10000 });
  });

  test('hatalı girdi: geçersiz sunucu ID veya geçersiz IP adresi ile ağ parametresi kontrolü', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Var olmayan sunucu ID ile istek yapıldığında 404 dönmeli
    const invalidServerRes = await page.request.get('/api/panel/servers/00000000-0000-0000-0000-000000000000');
    expect(invalidServerRes.status()).toBe(404);
    const invalidServerData = await invalidServerRes.json();
    expect(invalidServerData.error.code).toBe('local_server_required');

    // 2. Sunucu listesini alarak gerçek sunucu ID'sini bul
    const serversRes = await page.request.get('/api/panel/servers');
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    // 3. Geçersiz IP adresi ile DNS/ağ kimliği önizleme isteği gönderildiğinde 400 Bad Request dönmeli
    const invalidIpRes = await page.request.post(`/api/panel/servers/${serverId}/dns/identity/preview`, {
      headers,
      data: {
        settings: {
          publicIpv4: '999.999.999.999',
        },
      },
    });
    expect(invalidIpRes.status()).toBe(400);
    const invalidIpData = await invalidIpRes.json();
    expect(invalidIpData.error.code).toBe('invalid_dns_identity');

    // 4. Yetkisiz (unauthenticated) istek reddedilmeli
    const unauthorizedRes = await page.request.get('/api/panel/servers', {
      headers: { Cookie: '' },
    });
    expect(unauthorizedRes.status()).toBe(401);
  });

  test('Plesk eşdeğerlik eksikliği: IP havuzu yönetimi (Shared/Dedicated IP atama ve IP remap aracı)', async ({ page }) => {
    test.fail(
      true,
      'BULGU SYS-01: Plesk IP Addresses havuzu, Shared/Dedicated IP tür yönetimi ve IP Remap aracı henüz uygulanmadı',
    );

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Plesk'te Araçlar ve Ayarlar altında "IP Adresleri" (IP Addresses) aracı bulunur
    // YunPanel'de /tools-settings sayfasında bu menü öğesi henüz bulunmamaktadır
    await page.goto('/tools-settings');
    await expect(page.getByText('IP Adresleri')).toBeVisible({ timeout: 4000 });

    // Ayrıca ayrılmış IP havuzu yönetimi için özel bir API rotası (/api/panel/servers/:id/network)
    // veya dedicated IP atama mekanizması henüz bulunmamaktadır
    const serversRes = await page.request.get('/api/panel/servers');
    const serversData = await serversRes.json();
    const serverId = serversData.data[0].id;

    const poolRes = await page.request.get(`/api/panel/servers/${serverId}/network`);
    expect(poolRes.status()).toBe(200);
  });
});
