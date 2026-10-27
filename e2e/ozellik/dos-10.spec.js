import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

function runSsh(command) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 20000,
      }).trim();
    } catch (err) {
      if (attempt === 3) {
        console.warn(`SSH command failed: ${command} -> ${err.message}`);
        return '';
      }
      try { execSync('sleep 1'); } catch {}
    }
  }
  return '';
}

test.describe('DOS-10 FTP/FTPS hesapları, dizin kapsamı ve kota', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const testFtpUsername = `tdos10-a${agentN}-${timestamp}`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;
  let resolvedUnixUser = null;
  let resolvedDocRoot = null;

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

  test.afterAll(async () => {
    // Test sırasında sunucuda veya panelde oluşturulmuş olabilecek test FTP hesaplarını ve artıklarını temizle
    try {
      if (testFtpUsername) {
        runSsh(`id -u "${testFtpUsername}" >/dev/null 2>&1 && (userdel -r "${testFtpUsername}" || true) || true`);
      }
    } catch (err) {
      console.warn('DOS-10 cleanup warning:', err.message);
    }
  });

  test('mutlu yol 1: Panel arayüzünde mevcut dosya erişim protokolü (SFTP/SSH) ve Unix kullanıcı parametrelerinin doğrulanması', async ({ page }) => {
    // 1. Web siteleri listesine git ve webrich.news alan adına eriş
    await page.goto('/websites?q=webrich.news');
    await expect(page.locator('h1', { hasText: 'Web Siteleri' })).toBeVisible({ timeout: 15000 });

    const siteLink = page.locator('article a[href^="/websites/"][href*="/overview"]').first();
    await expect(siteLink).toBeVisible({ timeout: 15000 });

    const href = await siteLink.getAttribute('href');
    const match = href.match(/\/websites\/([^/]+)/);
    expect(match).toBeTruthy();
    resolvedDomainId = match[1];

    // 2. Erişim hesapları sekmesine git
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/access`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // 3. Erişim Hesapları başlığı ve açıklamasını doğrula
    await expect(page.locator('h2', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=SFTP, SSH ve sistem kullanıcısı erişim parametreleri')).toBeVisible({ timeout: 10000 });

    // 4. Paneldeki mevcut dosya erişim parametrelerini doğrula
    const dl = page.locator('dl.ws-keyvalues').first();
    await expect(dl).toBeVisible({ timeout: 10000 });

    // Protokol ve port bilgisi
    await expect(dl.locator('div:has(dt:has-text("Protokol")) dd')).toHaveText('SFTP / SSH');
    await expect(dl.locator('div:has(dt:has-text("Bağlantı noktası (Port)")) dd')).toHaveText('22');

    // Unix kullanıcı adı
    const userDd = dl.locator('div:has(dt:has-text("Kullanıcı adı")) dd');
    await expect(userDd).toBeVisible();
    resolvedUnixUser = (await userDd.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]{12}$/);

    // Belge kök dizini
    const docRootDd = dl.locator('div:has(dt:has-text("Belge kök dizini (Docroot)")) dd');
    await expect(docRootDd).toBeVisible();
    resolvedDocRoot = (await docRootDd.textContent()).trim();
    expect(resolvedDocRoot).toContain('/var/www/yunpanel/apps/');

    // İzolasyon durumu rozeti
    await expect(page.locator('.ws-badge:has-text("Dedicated Unix kullanıcısı (İzole)")')).toBeVisible({ timeout: 10000 });
  });

  test('mutlu yol 2 (Plesk eşdeğerliği): Panel arayüzünde FTP/FTPS hesabı oluşturma, dizin kapsamı ve kota yönetim arayüzü', async ({ page }) => {
    test.fail(
      true,
      'BULGU DOS-10: Panel arayüzünde Plesk eşdeğeri FTP/FTPS hesabı ekleme formu, dizin kapsamı belirleme (chroot/docroot) ve disk kota tanımlama kontrolleri bulunmuyor; panel yalnızca tekil sistem kullanıcısı ve SFTP/SSH (port 22) destekliyor.',
    );

    if (!resolvedDomainId) {
      resolvedDomainId = '09efa3a3-81ed-5764-b925-3a6770516a6f';
    }

    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/access`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Plesk eşdeğerliğinde "FTP Erişimi" veya "FTP Hesabı Ekle" butonu/alanı yer almalıdır
    const ftpActionButton = page.locator('button:has-text("FTP Hesabı Ekle"), button:has-text("Yeni FTP Hesabı"), a:has-text("FTP Erişimi"), button:has-text("FTP Ekle")');
    await expect(ftpActionButton).toBeVisible({ timeout: 3000 });

    // Ayrıca FTP kota ve dizin kapsamı (Home Directory / Quota) ayar alanlarının varlığı beklenir
    const ftpQuotaInput = page.locator('input[name="quota"], input[name="ftpQuota"], input[name="directory"], input[name="homeDir"]');
    await expect(ftpQuotaInput.first()).toBeVisible({ timeout: 2000 });
  });

  test('fiziksel kontrol: Sunucuda FTP/FTPS servisi (port 21) ve FTP daemon varlığı', async () => {
    test.fail(
      true,
      'BULGU DOS-10: Canlı test sunucusunda (.28) FTP/FTPS servisi (vsftpd/proftpd/pure-ftpd) kurulu değil ve 21 numaralı FTP bağlantı noktası dinlemede değil; YunPanel dosya erişimini tamamen OpenSSH internal-sftp (port 22) üzerinden yürütüyor.',
    );

    // 1. Port 21 dinleme durumunu kontrol et
    const port21Output = runSsh("ss -tulpn | grep ':21 ' || true");

    // 2. Kurulu FTP daemon paketlerini kontrol et
    const installedFtpPackages = runSsh("dpkg -l | grep -iE 'vsftpd|proftpd|pure-ftpd' || true");

    // 3. FTP servis durumunu kontrol et
    const ftpServiceActive = runSsh("systemctl is-active vsftpd proftpd pure-ftpd 2>/dev/null || true");

    // Plesk eşdeğerliğinde port 21 dinlemede ve bir FTP daemon aktif olmalıdır
    expect(port21Output.length, 'Port 21 dinlemede olmalıdır').toBeGreaterThan(0);
    expect(installedFtpPackages.length, 'vsftpd veya proftpd paketi kurulu olmalıdır').toBeGreaterThan(0);
    expect(ftpServiceActive).toMatch(/active/);
  });

  test('hatalı girdi ve güvenlik: FTP hesap API\'sinde docroot dışına path traversal ve geçersiz kota engeli', async ({ page }) => {
    test.fail(
      true,
      'BULGU DOS-10: Arka uçta FTP/FTPS hesap ve kota yönetim API rotası (/api/websites/:id/ftp/accounts) mevcut değil; endpoint 404 dönüyor.',
    );

    const targetWebsiteId = resolvedWebsiteId || '7fe9a711-a5b0-550e-a5e5-49fee4c66a73';

    // Geçersiz kullanıcı adı, docroot dışına path traversal dizin kapsamı ve negatif kota içeren payload
    const invalidPayload = {
      username: 'ftp_user..bad!',
      directory: '../../../../etc/shadow',
      quotaMb: -100,
    };

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
    const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';

    const response = await page.request.post(`/api/websites/${encodeURIComponent(targetWebsiteId)}/ftp/accounts`, {
      headers: {
        Origin: 'https://server.cryptoraichu.website',
        'x-csrf-token': csrf,
      },
      data: invalidPayload,
    });

    // Beklenen: API mevcut olmalı ve geçersiz girdileri (path traversal / negatif kota) 400 Bad Request ile reddetmeli
    expect(response.status()).toBe(400);
    const body = await response.json().catch(() => ({}));
    expect(['ftp_path_traversal_invalid', 'ftp_quota_invalid', 'ftp_username_invalid']).toContain(body.error?.code);
  });
});
