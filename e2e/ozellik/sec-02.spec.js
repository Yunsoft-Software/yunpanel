import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SEC-02 IP erişim kısıtları, brute-force koruması ve ban/unban', () => {
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '4';
  // Güvenli TEST-NET-2 IP adresi (RFC 5737 - Test ortamı için ayrılmış, asla yerel/istemci IP değil)
  const testBanIp = `198.51.100.${70 + Number(agentN)}`;
  const invalidIp = '999.999.999.999';

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

  test.afterAll(async () => {
    // 0 Artık ilkesi: Test IP'sini ve olası kararları host üzerinden temizle
    try {
      runSsh(`cscli decisions delete --ip ${testBanIp} 2>/dev/null || true`);
    } catch {
      // Temizlik denemesi
    }
  });

  test('mutlu yol: arayüzden CrowdSec ban yönetimi alanı görüntülenir ve ban/unban akışı doğrulanır', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // 1. Güvenlik Duvarı sayfasına git
    await page.goto('/firewall');
    await expect(page.locator('.ws-firewall-page')).toBeVisible({ timeout: 15000 });

    // 2. CrowdSec Tehdit ve Ban Yönetimi bölümünü doğrula
    const crowdsecSection = page.locator('section:has-text("CrowdSec Tehdit ve Ban Yönetimi")');
    await expect(crowdsecSection).toBeVisible({ timeout: 10000 });

    // Tablo başlıkları ve form alanlarının mevcut olduğunu doğrula
    await expect(crowdsecSection.locator('th:has-text("Engellenen IP")')).toBeVisible();
    await expect(crowdsecSection.locator('#firewall-ban-ip')).toBeVisible();
    await expect(crowdsecSection.locator('#firewall-ban-duration')).toBeVisible();
    await expect(crowdsecSection.locator('#firewall-ban-reason')).toBeVisible();

    // 3. Fiziksel altyapı kontrolü (cscli veya fail2ban varlığı)
    const cscliCheck = runSsh('which cscli || echo "not_found"');
    const isCscliInstalled = cscliCheck.includes('/cscli');

    if (!isCscliInstalled) {
      // Plesk eşdeğeri IP ban / brute-force servisi sunucuda cscli/fail2ban kurulu olmadığı için
      // panel bu backend motorunu bekler ancak işletim sistemi düzeyinde eksiktir.
      test.fail(true, 'BULGU SEC-02: Sunucuda cscli (CrowdSec) veya fail2ban kurulu değil, IP ban motoru fiziksel olarak aktifleşemiyor.');
    }

    // 4. Test IP'si ile ban ekleme işlemi
    await crowdsecSection.locator('#firewall-ban-ip').fill(testBanIp);
    await crowdsecSection.locator('#firewall-ban-duration').selectOption('1h');
    await crowdsecSection.locator('#firewall-ban-reason').fill('SEC-02 Otomatik Test Engeli');

    await crowdsecSection.locator('button:has-text("IP Engelle")').click();

    // Listede eklenen IP'nin görünmesini bekle
    const row = crowdsecSection.locator(`tr:has-text("${testBanIp}")`);
    await expect(row).toBeVisible({ timeout: 10000 });

    // Fiziksel kanıt: cscli kararlarında bu IP'nin listelenmesi
    const physicalList = runSsh(`cscli decisions list -o json`);
    expect(physicalList).toContain(testBanIp);

    // 5. Engeli kaldır
    const unbanBtn = row.locator('button:has-text("Engeli Kaldır")');
    await unbanBtn.click();
    await expect(crowdsecSection.locator(`tr:has-text("${testBanIp}")`)).toHaveCount(0, { timeout: 10000 });
  });

  test('hatalı girdi: geçersiz IP formatı ve eksik parametre reddedilir', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/firewall');
    await expect(page.locator('.ws-firewall-page')).toBeVisible({ timeout: 15000 });

    const crowdsecSection = page.locator('section:has-text("CrowdSec Tehdit ve Ban Yönetimi")');
    await expect(crowdsecSection).toBeVisible({ timeout: 10000 });

    // 1. UI düzeyi doğrulama: Boş IP ile form submit edildiğinde HTML5 required validasyonu devreye girer
    const ipInput = crowdsecSection.locator('#firewall-ban-ip');
    await ipInput.fill('');
    const submitBtn = crowdsecSection.locator('button:has-text("IP Engelle")');
    await submitBtn.click();

    // HTML5 validation: input geçersiz durumda olmalı
    const isInvalid = await ipInput.evaluate((el) => !el.checkValidity());
    expect(isInvalid).toBe(true);

    // 2. Arayüzden geçersiz IP adresi girilerek ekleme denenir
    await ipInput.fill(invalidIp);
    await crowdsecSection.locator('#firewall-ban-reason').fill('Test Geçersiz IP');
    await submitBtn.click();

    // Ekranda hata bildiriminin gösterildiği doğrulanır
    const errorStrong = crowdsecSection.locator('strong:has-text("Hata:")');
    await expect(errorStrong).toBeVisible({ timeout: 10000 });

    // 3. API düzeyinde CSRF korumalı istek ile doğrudan geçersiz ve eksik IP parametreleri denetimi
    const sessionRes = await page.request.get('/api/auth/session');
    const sessionData = await sessionRes.json();
    const csrfToken = sessionData.data?.csrfToken || sessionData.session?.csrfToken || sessionData.csrfToken || '';
    const origin = page.url().split('/').slice(0, 3).join('/');

    const apiHeaders = {
      'x-csrf-token': csrfToken,
      Origin: origin,
      Referer: `${origin}/firewall`,
    };

    // A) Hatalı IP gönderimi (999.999.999.999) -> 400 invalid_ip dönmeli
    const badApiRes = await page.request.post('/api/panel/firewall/bans', {
      headers: apiHeaders,
      data: {
        ip: invalidIp,
        duration: '1h',
        reason: 'Bad IP Test',
      },
    });
    expect(badApiRes.status()).toBe(400);
    const badBody = await badApiRes.json();
    expect(badBody.error?.code).toBe('invalid_ip');

    // B) Eksik IP gönderimi -> 400 missing_ip dönmeli
    const missingIpRes = await page.request.post('/api/panel/firewall/bans', {
      headers: apiHeaders,
      data: {
        duration: '1h',
        reason: 'Missing IP Test',
      },
    });
    expect(missingIpRes.status()).toBe(400);
    const missingBody = await missingIpRes.json();
    expect(missingBody.error?.code).toBe('missing_ip');
  });

  test('fiziksel kanıt: sistem güvenlik servisi ve brute-force bouncer durumu denetimi', async () => {
    // Plesk SEC-02 eşdeğerliği: Sistemde brute-force korumasının (CrowdSec / Fail2ban) çalışır olması gerekir
    const crowdsecStatus = runSsh('systemctl is-active crowdsec || echo "inactive"');
    const bouncerStatus = runSsh('systemctl is-active crowdsec-firewall-bouncer || echo "inactive"');
    const fail2banStatus = runSsh('systemctl is-active fail2ban || echo "inactive"');

    const hasActiveDefense = (crowdsecStatus === 'active') || (bouncerStatus === 'active') || (fail2banStatus === 'active');

    if (!hasActiveDefense) {
      test.fail(true, 'BULGU SEC-02: Sunucuda aktif brute-force / IPS servisi (CrowdSec veya Fail2ban) çalışmıyor.');
    }

    expect(hasActiveDefense).toBe(true);
  });
});
