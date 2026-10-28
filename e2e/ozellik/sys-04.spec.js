import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('SYS-04 Sistem/PHP/panel güncellemeleri ve bileşen yönetimi', () => {
  test.setTimeout(180000);

  function runSsh(command) {
    try {
      return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
        encoding: 'utf8',
        timeout: 25000,
      }).trim();
    } catch (err) {
      return (err.stdout || '') + (err.stderr || '');
    }
  }

  async function apiCall(page, path, options = {}) {
    const fullPath = path.startsWith('/api/') ? path : `/api/panel${path.startsWith('/') ? path : `/${path}`}`;
    return page.evaluate(async ({ fullPath, options }) => {
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
      const res = await fetch(fullPath, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      return { status: res.status, ok: res.ok, data };
    }, { fullPath, options });
  }

  test.afterAll(async () => {
    // 0 Artık ve Sağlık Doğrulaması: Sunucu servis ve paket durumu kontrolü
    const apiStatus = runSsh('systemctl is-active yunpanel-api');
    expect(apiStatus).toBe('active');

    const pkgPolicy = runSsh('apt-cache policy yunpanel');
    expect(pkgPolicy).toContain('Installed:');
  });

  test('Mutlu yol: Panel sürüm denetimi, kurulu PHP sürümü ve sistem güncelleme sorgusu', async ({ page }) => {
    // 1. Giriş yap ve Ayarlar -> Güncellemeler bölümüne git
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings?section=updates');

    // Oturumun ve sayfanın yüklendiğini doğrula
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // Güncellemeler bölümünün başlığını ve container'ını bul
    const updatesHeading = page.locator('h2, h3, .panel-heading').filter({ hasText: /YunPanel updates|YunPanel güncellemeleri/i }).first();
    await expect(updatesHeading).toBeVisible({ timeout: 15000 });

    // Güncelleme kontrol butonu
    const checkBtn = page.locator('button').filter({ hasText: /Check updates|Güncellemeleri denetle|Kontrol et/i }).first();
    await expect(checkBtn).toBeVisible({ timeout: 10000 });

    // Güncellemeleri kontrol et butonuna tıkla
    await checkBtn.click();

    // İşlem durumunun güncellenmesini bekle (versiyon hücresi veya mesaj görünür olmalı)
    const installedCell = page.locator('.domain-cell strong, .domain-primary span').filter({ hasText: /0\.3\./ }).first();
    await expect(installedCell).toBeVisible({ timeout: 60000 });

    const displayedVersion = (await installedCell.textContent()) || '';
    console.log('Arayüzde gösterilen sürüm:', displayedVersion);
    expect(displayedVersion).toContain('0.3.');

    // 2. Fiziksel Kanıt 1: SSH ile yunpanel APT paketi durumu
    const sshAptPolicy = runSsh('apt-cache policy yunpanel');
    console.log('SSH apt-cache policy çıktısı:\n', sshAptPolicy);
    expect(sshAptPolicy).toContain('Installed: 0.3.');
    expect(sshAptPolicy).toContain('Candidate: 0.3.');

    // 3. Fiziksel Kanıt 2: SSH ile sunucudaki PHP sürümü ve PHP-FPM servisi
    const sshPhpVersion = runSsh('php -v');
    console.log('SSH php -v çıktısı:\n', sshPhpVersion);
    expect(sshPhpVersion).toContain('PHP 8.3');

    const sshPhpFpmStatus = runSsh('systemctl is-active php8.3-fpm || systemctl is-active php-fpm');
    console.log('SSH php-fpm durumu:', sshPhpFpmStatus);
    expect(sshPhpFpmStatus).toMatch(/active/);

    // 4. Fiziksel Kanıt 3: SSH ile sistem güncelleme durumu (upgradable paketler)
    const sshUpgradable = runSsh('apt list --upgradable 2>/dev/null | head -n 10');
    console.log('SSH apt upgradable listesi (ilk 10 satır):\n', sshUpgradable);
    expect(sshUpgradable).toContain('Listing...');
  });

  test('Hatalı girdi: Geçersiz onay kodu ile sistem yükseltme reddedilir ve 400 döner', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);

    // Sunucu ID'sini API üzerinden al (/api/panel/servers)
    const serverRes = await apiCall(page, '/servers');
    expect(serverRes.status).toBe(200);
    const serverList = serverRes.data?.data || [];
    expect(serverList.length).toBeGreaterThan(0);
    const serverId = serverList[0].id;

    // 1. Geçersiz onay parametresi ile upgrade isteği (hatalı girdi)
    const badUpgradeRes = await apiCall(page, `/servers/${serverId}/system/upgrade`, {
      method: 'POST',
      body: { confirmation: 'invalid-upgrade-code' },
    });
    console.log('Geçersiz upgrade yanıtı:', badUpgradeRes.status, badUpgradeRes.data);
    expect(badUpgradeRes.status).toBe(400);
    expect(badUpgradeRes.data?.error?.code).toBe('upgrade_confirmation_required');

    // 2. Boş body ile upgrade isteği
    const emptyUpgradeRes = await apiCall(page, `/servers/${serverId}/system/upgrade`, {
      method: 'POST',
      body: {},
    });
    expect(emptyUpgradeRes.status).toBe(400);
    expect(emptyUpgradeRes.data?.error?.code).toBe('upgrade_confirmation_required');

    // 3. Var olmayan sunucu ID'si ile inspect isteği
    const notFoundRes = await apiCall(page, '/servers/non-existent-server-9999/system/packages/inspect', {
      method: 'POST',
      body: {},
    });
    expect(notFoundRes.status).toBe(404);
  });

  test('Plesk Parity Eksikliği: Sistem güncellemeleri arayüzü (Plesk System Updates) eksikliği', async ({ page }) => {
    test.fail(true, 'BULGU SYS-04-1: Plesk "System Updates" eşdeğeri tüm işletim sistemi paketlerini (APT) listeleme, seçmeli güncelleme ve otomatik güvenlik güncelleme politikası arayüzü YunPanel üzerinde mevcut değil');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings?section=updates');

    // Plesk'te bulunan System Updates (Tüm OS paketlerinin güncelleme tablosu ve otomatik kural seçimi) aranır
    const systemAptTable = page.locator('table').filter({ hasText: /Operating System Updates|Sistem Paketleri|Kernel|Security Updates/i });
    await expect(systemAptTable).toBeVisible({ timeout: 5000 });
  });

  test('Plesk Parity Eksikliği: Sunucu geneli bileşen ekleme/kaldırma (Add/Remove Components) eksikliği', async ({ page }) => {
    test.fail(true, 'BULGU SYS-04-2: Plesk "Updates and Upgrades -> Add/Remove Components" eşdeğeri sunucu geneli çoklu PHP sürümlerini (7.4/8.1/8.2), web/mail bileşenlerini kurma ve kaldırma arayüzü mevcut değil');

    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await page.goto('/settings?section=updates');

    // Plesk'te bulunan bileşen yöneticisi (Bileşenleri Yönet / Add/Remove Components) aranır
    const componentsManager = page.locator('button, a, section').filter({ hasText: /Bileşen Yönetimi|Add and Remove Components|Bileşenleri Yönet/i });
    await expect(componentsManager).toBeVisible({ timeout: 5000 });
  });
});
