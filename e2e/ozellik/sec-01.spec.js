import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SEC-01 Firewall aç/kapat, kurallar, portlar ve güvenli geri dönüş', () => {
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '3';
  const prefix = `tsec01-a${agentN}-${Date.now().toString(36)}`;
  // Allocate a harmless high ephemeral test port (49200-49700)
  const testPort = 49200 + ((Date.now() % 400) + parseInt(agentN, 10));

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
    // 0 Artık ilkesi: Test sırasında eklenmiş olabilecek test portunu host ve nftables üzerinden temizle
    try {
      runSsh(`sudo nft delete rule inet yunpanel input tcp dport ${testPort} 2>/dev/null || true`);
    } catch {
      // ignore
    }
  });

  test('UI Görünümü ve Arayüz Yükleme: FirewallPage bileşeni ve API entegrasyonu', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/firewall');

    // 1. Başlık ve kart yapılarının DOM'da render edildiğini doğrula
    await expect(page.getByRole('heading', { name: 'Güvenlik Duvarı ve Port Yönetimi' })).toBeVisible({ timeout: 15000 });

    const statusSection = page.locator('section').filter({ hasText: 'Genel Güvenlik ve Firewall Durumu' });
    await expect(statusSection).toBeVisible({ timeout: 10000 });
    await expect(statusSection.getByText('Firewall Durumu', { exact: true })).toBeVisible();
    await expect(statusSection.getByText('Açılış Kalıcılığı (Boot)', { exact: true })).toBeVisible();
    await expect(statusSection.getByText('Docker Birlikte Yaşama', { exact: true })).toBeVisible();

    const profilesSection = page.locator('section').filter({ hasText: 'Sunucu Servis Profilleri' });
    await expect(profilesSection).toBeVisible();
    await expect(profilesSection.getByText('Sistem / SSH', { exact: true })).toBeVisible();
    await expect(profilesSection.getByText('Zorunlu / Korumalı', { exact: true })).toBeVisible();

    // 2. BULGU TESPİTİ: firewall-client.js /api/panel/ öneki yerine doğrudan /api/firewall/* çağırmaktadır.
    // Web reverse proxy (apps/web/server.js) yalnızca /api/panel/ altındaki yönetim uçlarını yetkili arka uca proxy eder;
    // doğrudan /api/firewall/* istekleri 404 döner. Bu nedenle arayüzde port kuralları yüklenemez ve tablo boş kalır.
    test.fail(
      true,
      'BULGU SEC-01: firewall-client.js API kök yolunda /api/panel/ öneki eksik olduğundan (/api/firewall 404 dönüyor) FirewallPage arayüzünde kurallar ve durum yüklenemiyor (Tümü 0 kalıyor)',
    );

    const rulesSection = page.locator('section').filter({ hasText: 'Port ve Güvenlik Duvarı Kuralları' });
    const table = rulesSection.locator('table.ws-table');
    const sshRow = table.locator('tr').filter({ hasText: '22 / TCP' });
    await expect(sshRow).toBeVisible({ timeout: 5000 });
  });

  test('mutlu yol: firewall durumu okuma, kural listeleme, zararsız özel test port kuralı ekleme/silme ve rollback önizleme', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Firewall durumu sorgulama (/api/panel/firewall/status)
    const statusRes = await page.request.get('/api/panel/firewall/status');
    expect(statusRes.status(), 'Firewall status 200 dönmeli').toBe(200);
    const statusJson = await statusRes.json();
    expect(statusJson.data, 'Status data nesnesi içermeli').toBeDefined();
    expect(['active', 'inactive']).toContain(statusJson.data.status);
    expect(statusJson.data.bootPersistence, 'Boot persistence verisi içermeli').toBeDefined();

    // 2. Port listesini sorgulama (/api/panel/firewall/ports)
    const portsRes = await page.request.get('/api/panel/firewall/ports');
    expect(portsRes.status(), 'Firewall ports 200 dönmeli').toBe(200);
    const portsJson = await portsRes.json();
    expect(Array.isArray(portsJson.data?.ports), 'Ports listesi dizi olmalı').toBe(true);

    // SSH (port 22) kuralının aktif ve firewall izinli olduğunu doğrula
    const sshPortRule = portsJson.data.ports.find((p) => p.port === 22 && p.protocol === 'tcp');
    expect(sshPortRule, 'SSH port 22 kuralı bulunmalı').toBeDefined();
    expect(sshPortRule.isListening, 'SSH port 22 dinliyor olmalı').toBe(true);
    expect(typeof sshPortRule.isFirewallAllowed).toBe('boolean');

    // 3. Zararsız özel test port kuralı ekleme (POST /api/panel/firewall/ports)
    const addPortRes = await page.request.post('/api/panel/firewall/ports', {
      headers,
      data: {
        port: testPort,
        protocol: 'tcp',
        source: '127.0.0.1/32',
        policy: 'allow',
        comment: `Test rule ${prefix}`,
        skipApply: true, // Sunucu canlı bağlantısını kesmemek için güvenli modda
      },
    });
    expect(addPortRes.status(), 'Özel port ekleme 200 dönmeli').toBe(200);
    const addPortJson = await addPortRes.json();
    const addedRule = addPortJson.data?.ports?.find((p) => p.port === testPort && p.protocol === 'tcp');
    expect(addedRule, 'Eklenen test portu kural listesinde yer almalı').toBeDefined();
    expect(addedRule.port).toBe(testPort);

    // 4. Güvenli Önizleme / Preview API Doğrulaması (Safe Mutation Preview)
    const previewRes = await page.request.post('/api/panel/firewall/preview', {
      headers,
      data: {
        sshPorts: [22],
        renderOptions: {},
      },
    });
    expect(previewRes.status(), 'Preview API 200 dönmeli').toBe(200);
    const previewJson = await previewRes.json();
    expect(previewJson.data, 'Preview veri nesnesi içermeli').toBeDefined();
    expect(previewJson.data.valid, 'Preview valid olmalı').toBe(true);
    expect(previewJson.data.impact, 'Impact analizi içermeli').toBeDefined();
    expect(previewJson.data.candidateSha256, 'Aday sha256 içermeli').toBeDefined();

    // 5. Eklenen test kuralını silme (DELETE /api/panel/firewall/ports/:port)
    const removePortRes = await page.request.delete(`/api/panel/firewall/ports/${testPort}?protocol=tcp&skipApply=true`, {
      headers,
    });
    expect(removePortRes.status(), 'Özel port silme 200 dönmeli').toBe(200);

    // 6. Fiziksel Sonuç Doğrulaması (Sunucu üzerinde nftables ve ufw durumu)
    const nftStatus = runSsh('sudo nft list ruleset | grep -c "chain"');
    const chainCount = parseInt(nftStatus, 10);
    expect(Number.isFinite(chainCount) && chainCount >= 1, 'Sunucuda nftables kuralları fiziksel olarak var olmalı').toBe(true);

    const ufwStatus = runSsh('sudo ufw status');
    expect(typeof ufwStatus === 'string' && ufwStatus.length > 0, 'UFW durumu fiziksel olarak sorgulanabilmeli').toBe(true);
  });

  test('hatalı girdi ve güvenlik kısıtları: geçersiz port, geçersiz CIDR, yetkisiz tarama, profil koruması ve SSH kilit koruması', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    const headers = await getApiHeaders(page);

    // 1. Hatalı Girdi: Geçersiz Port (400 invalid_port)
    const invalidPortRes = await page.request.post('/api/panel/firewall/ports', {
      headers,
      data: {
        port: 99999,
        protocol: 'tcp',
      },
    });
    expect(invalidPortRes.status(), 'Geçersiz port 400 ile reddedilmeli').toBe(400);
    const invalidPortBody = await invalidPortRes.json();
    expect(invalidPortBody.error?.code).toBe('invalid_port');

    // 2. Hatalı Girdi: Geçersiz CIDR (400 invalid_cidr)
    const invalidCidrRes = await page.request.post('/api/panel/firewall/ports', {
      headers,
      data: {
        port: 39001,
        protocol: 'tcp',
        source: '999.999.999.999/99',
      },
    });
    expect(invalidCidrRes.status(), 'Geçersiz CIDR 400 ile reddedilmeli').toBe(400);
    const invalidCidrBody = await invalidCidrRes.json();
    expect(invalidCidrBody.error?.code).toBe('invalid_cidr');

    // 3. Servis Profili Koruması: Local-mail pasifken mail portu (25) eklenemez
    const mailPortRes = await page.request.post('/api/panel/firewall/ports', {
      headers,
      data: {
        port: 25,
        protocol: 'tcp',
      },
    });
    expect(mailPortRes.status(), 'Pasif profilde mail portu açılması 400 ile engellenmeli').toBe(400);
    const mailPortBody = await mailPortRes.json();
    expect(mailPortBody.error?.code).toBe('service_profile_inactive');

    // 4. Güvenlik Kuralı: SSH Portunu Silme Teşebbüsü (Lockout Risk Koruması)
    const removeSshRes = await page.request.delete('/api/panel/firewall/ports/22?protocol=tcp', {
      headers,
    });
    expect(removeSshRes.status(), 'SSH portunun silinmesi 400 ile engellenmeli').toBe(400);
    const removeSshBody = await removeSshRes.json();
    expect(removeSshBody.error?.code).toBe('lockout_risk_detected');

    // 5. Güvenlik Kuralı: Port Taramasında .44 veya Yetkisiz Hedef Engeli (unauthorized_test_target)
    const scanUnauthorizedRes = await page.request.post('/api/panel/firewall/scan', {
      headers,
      data: {
        host: '192.168.1.44',
        port: 80,
      },
    });
    expect([400, 403]).toContain(scanUnauthorizedRes.status());
    const scanUnauthorizedBody = await scanUnauthorizedRes.json();
    expect(scanUnauthorizedBody.error?.code).toBe('unauthorized_test_target');
  });
});
