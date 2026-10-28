import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs } from '../helpers.js';

test.use({ trace: 'off' });

test.describe('BAK-05 Yerel ve uzak FTP/cloud/object storage hedefleri', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180000);

  const agentN = process.env.AGENT_N || '1';
  const timestamp = Date.now().toString(36);
  const targetDomainName = 'yp-node.webrich.news';

  const remoteName = `tbak05_a${agentN}_${timestamp}_s3`;
  const remoteRepoName = `tbak05-a${agentN}-${timestamp}-remoterepo`;
  const localRepoName = `tbak05-a${agentN}-${timestamp}-localrepo`;

  let createdRemoteId = null;
  let createdRemoteRepoId = null;
  let createdLocalRepoId = null;

  let targetDomainId = null;
  let targetWebsiteId = null;
  let csrfToken = '';

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

    const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
    if (sessionRes && sessionRes.ok()) {
      const json = await sessionRes.json().catch(() => ({}));
      csrfToken = json?.data?.csrfToken || '';
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    try {
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
      const token = (await sessionRes?.json())?.data?.csrfToken || csrfToken;

      const headers = {
        'x-csrf-token': token,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      };

      // 1. Oluşturulan Rclone reposunu sil
      if (createdRemoteRepoId && token) {
        await page.request.delete(`/api/panel/backups/repositories/${createdRemoteRepoId}`, { headers }).catch(() => null);
      }

      // 2. Oluşturulan Yerel depoyu sil
      if (createdLocalRepoId && token) {
        await page.request.delete(`/api/panel/backups/repositories/${createdLocalRepoId}`, { headers }).catch(() => null);
      }

      // 3. Oluşturulan Rclone uzak hedefini sil
      if (createdRemoteId && token) {
        await page.request.delete(`/api/panel/backups/remotes/${createdRemoteId}`, { headers }).catch(() => null);
      }

      // 4. Fiziksel artık temizliği (SSH)
      try {
        if (createdLocalRepoId) {
          execSync(
            `ssh yunpanel-test "rm -rf /var/lib/yunpanel/backups/restic/repos/${createdLocalRepoId}"`,
            { timeout: 15000 }
          );
        }
      } catch (cleanErr) {
        console.warn('Physical cleanup notice:', cleanErr.message);
      }
    } catch (err) {
      console.warn('BAK-05 cleanup error:', err.message);
    } finally {
      await page.close().catch(() => {});
    }
  });

  test('mutlu yol: sistem yedekleme motoru doğrulama, yerel ve uzak depolama hedefleri oluşturma, site arayüzünde repo/uzak depo tespiti ve fiziksel disk/ayar kanıtı', async ({ page }) => {
    // 1. Sunucu arayüzünde Sistem Ayarları / Tanılama altında Yedekleme ve Depolama motorlarını doğrula
    await page.goto('/servers');
    await expect(page.locator('h1:has-text("Sunucu")')).toBeVisible({ timeout: 15000 });
    const diagnosticsDetails = page.locator('details#server-diagnostics');
    await expect(diagnosticsDetails).toBeAttached({ timeout: 10000 });
    await diagnosticsDetails.evaluate((el) => { el.open = true; });
    const backupSection = page.locator('section.ws-section', { hasText: 'Yedekleme ve depolama' });
    await expect(backupSection).toBeVisible({ timeout: 10000 });
    await expect(backupSection).toContainText('restic (Durable snapshot & retention)');
    await expect(backupSection).toContainText('rclone (S3, B2, Google Cloud, SFTP desteği)');
    await expect(backupSection).toContainText('/var/lib/yunpanel/backups');

    // 2. Hedef site (yp-node.webrich.news) websiteId ve domainId bilgilerini al
    const sitesRes = await page.request.get('/api/panel/websites');
    expect(sitesRes.ok()).toBe(true);
    const sitesJson = await sitesRes.json();
    const sites = Array.isArray(sitesJson.data) ? sitesJson.data : sitesJson.data?.websites || [];
    const site = sites.find((w) => w.name === targetDomainName);
    expect(site).toBeTruthy();
    targetWebsiteId = site.id;

    const domainsRes = await page.request.get('/api/panel/domains');
    expect(domainsRes.ok()).toBe(true);
    const domainsJson = await domainsRes.json();
    const domains = Array.isArray(domainsJson.data) ? domainsJson.data : domainsJson.data?.domains || [];
    const domain = domains.find((d) => d.websiteId === targetWebsiteId);
    expect(domain).toBeTruthy();
    targetDomainId = domain.id;

    // 3. Uzak Depolama Hedefi (Rclone Remote: S3 Object Storage) oluştur
    const createRemoteRes = await page.request.post('/api/panel/backups/remotes', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: remoteName,
        type: 's3',
        parameters: {
          provider: 'AWS',
          region: 'eu-central-1',
          endpoint: 'https://s3.eu-central-1.amazonaws.com',
        },
        credentials: {
          access_key_id: 'AKIA_TEST_KEY_ID_123',
          secret_access_key: 'SuperSecretAccessKeyForBackupStorage999!',
        },
      },
    });
    expect(createRemoteRes.status()).toBe(201);
    const remoteJson = await createRemoteRes.json();
    createdRemoteId = remoteJson.data?.id;
    expect(createdRemoteId).toBeTruthy();
    expect(remoteJson.data?.name).toBe(remoteName);
    expect(remoteJson.data?.type).toBe('s3');
    expect(remoteJson.data?.status).toBe('untested');
    expect(remoteJson.data?.credentials).toBeUndefined();

    // 4. Uzak Depoya Bağlı Restic Reposu oluştur (backend: rclone)
    const createRemoteRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: remoteRepoName,
        backend: 'rclone',
        target: `${remoteName}:yunpanel-backup-bucket/daily`,
        password: `Pass-${timestamp}-R3m0te!`,
        initialize: false,
      },
    });
    expect(createRemoteRepoRes.status()).toBe(201);
    const remoteRepoJson = await createRemoteRepoRes.json();
    createdRemoteRepoId = remoteRepoJson.data?.id;
    expect(createdRemoteRepoId).toBeTruthy();
    expect(remoteRepoJson.data?.backend).toBe('rclone');
    expect(remoteRepoJson.data?.target).toBe(`${remoteName}:yunpanel-backup-bucket/daily`);

    // 5. Yerel Restic Yedek Deposu oluştur ve başlat (backend: local)
    const createLocalRepoRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: localRepoName,
        backend: 'local',
        password: `Pass-${timestamp}-L0c4l!`,
        initialize: true,
      },
    });
    expect(createLocalRepoRes.status()).toBe(201);
    const localRepoJson = await createLocalRepoRes.json();
    createdLocalRepoId = localRepoJson.data?.id;
    expect(createdLocalRepoId).toBeTruthy();
    expect(localRepoJson.data?.backend).toBe('local');
    expect(localRepoJson.data?.status).toBe('ready');

    // 6. Panel Web Sitesi Yedekleme Arayüzü Doğrulaması
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // Özet kartında "Uzak depo (rclone)" satırının algılandığını doğrula
    const remoteRepoStatusRow = page.locator('dt:has-text("Uzak depo (rclone)") + dd');
    await expect(remoteRepoStatusRow).toBeVisible({ timeout: 10000 });
    await expect(remoteRepoStatusRow).not.toHaveText('Yapılandırılmadı');

    // Depolar listesinde Yerel Depo kartını doğrula
    const localRepoSection = page.locator('.ws-section', { hasText: localRepoName });
    await expect(localRepoSection).toBeVisible({ timeout: 10000 });
    await expect(localRepoSection).toContainText('Yerel depo · Hazır');
    const healthCheckBtn = localRepoSection.locator('button:has-text("Sağlık Denetimi")');
    await expect(healthCheckBtn).toBeVisible({ timeout: 5000 });
    await expect(healthCheckBtn).toBeEnabled();

    // Depolar listesinde Uzak Depo kartını doğrula
    const remoteRepoSection = page.locator('.ws-section', { hasText: remoteRepoName });
    await expect(remoteRepoSection).toBeVisible({ timeout: 10000 });
    await expect(remoteRepoSection).toContainText('Uzak depo · Hazırlanmadı');

    // "Plan ve Zamanlama" modalında depoların listelendiğini doğrula
    const planBtn = page.locator('button:has-text("Plan ve Zamanlama")');
    await expect(planBtn).toBeVisible({ timeout: 5000 });
    await planBtn.click();
    const modal = page.locator('dialog.ws-modal, [role="dialog"]').filter({ hasText: 'Yedekleme Planı ve Saklama Politikası' });
    await expect(modal).toBeVisible({ timeout: 10000 });
    const repoSelect = modal.locator('select').first();
    await expect(repoSelect).toBeVisible({ timeout: 5000 });
    const options = await repoSelect.locator('option').allTextContents();
    expect(options.some((opt) => opt.includes(localRepoName))).toBe(true);
    await modal.locator('button:has-text("Vazgeç")').click();
    await expect(modal).not.toBeVisible({ timeout: 5000 });

    // 7. Fiziksel Kanıtlar (SSH)
    // Fiziksel kanıt 1: rclone-remotes.json dosyasında uzak hedef ve AES-256-GCM ile şifrelenmiş kimlik bilgisi
    const remotesJsonRaw = execSync(
      'ssh yunpanel-test "cat /var/lib/yunpanel/control-plane/rclone-remotes.json"',
      { encoding: 'utf8', timeout: 15000 }
    );
    const remotesDisk = JSON.parse(remotesJsonRaw);
    const foundRemote = remotesDisk.remotes.find((r) => r.id === createdRemoteId);
    expect(foundRemote).toBeTruthy();
    expect(foundRemote.name).toBe(remoteName);
    expect(foundRemote.type).toBe('s3');
    expect(foundRemote.encryptedCredentials?.ciphertext).toBeTruthy();
    expect(foundRemote.encryptedCredentials?.iv).toBeTruthy();
    expect(foundRemote.encryptedCredentials?.tag).toBeTruthy();

    // Fiziksel kanıt 2: restic-repositories.json dosyasında hem yerel hem uzak repo kayıtları
    const reposJsonRaw = execSync(
      'ssh yunpanel-test "cat /var/lib/yunpanel/control-plane/restic-repositories.json"',
      { encoding: 'utf8', timeout: 15000 }
    );
    const reposDisk = JSON.parse(reposJsonRaw);
    const foundLocalRepo = reposDisk.repositories.find((r) => r.id === createdLocalRepoId);
    const foundRemoteRepo = reposDisk.repositories.find((r) => r.id === createdRemoteRepoId);
    expect(foundLocalRepo).toBeTruthy();
    expect(foundLocalRepo.backend).toBe('local');
    expect(foundRemoteRepo).toBeTruthy();
    expect(foundRemoteRepo.backend).toBe('rclone');

    // Fiziksel kanıt 3: Yerel Restic reposunun config dosyasının disk üzerinde oluşması
    const localRepoDirCheck = execSync(
      `ssh yunpanel-test "ls -la /var/lib/yunpanel/backups/restic/repos/${createdLocalRepoId}/config"`,
      { encoding: 'utf8', timeout: 15000 }
    );
    expect(localRepoDirCheck).toContain('config');
  });

  test('hatalı girdi: geçersiz remote türü (FTP reddi), geçersiz karakterli isim, eksik hedef ve yetkisiz erişim kontrolleri', async ({ page, request }) => {
    // 1. Desteklenmeyen remote türü: rclone registry yalnız s3, b2, sftp, webdav destekler; FTP türü 400 ile reddedilir
    const invalidTypeRes = await page.request.post('/api/panel/backups/remotes', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: `tinvaltype_${timestamp}`,
        type: 'ftp',
        parameters: { host: 'ftp.example.com', port: 21 },
      },
    });
    expect(invalidTypeRes.status()).toBe(400);
    const invalidTypeJson = await invalidTypeRes.json();
    expect(invalidTypeJson.error?.code).toBe('rclone_remote_type_unsupported');

    // 2. Geçersiz karakterli remote adı (boşluk veya özel karakter): 400 rclone_remote_name_invalid
    const invalidNameRes = await page.request.post('/api/panel/backups/remotes', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: 'invalid remote name with spaces!',
        type: 's3',
      },
    });
    expect(invalidNameRes.status()).toBe(400);
    const invalidNameJson = await invalidNameRes.json();
    expect(invalidNameJson.error?.code).toBe('rclone_remote_name_invalid');

    // 3. Rclone backend repo için eksik hedef (target): 400 restic_target_invalid
    const invalidTargetRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: `trepotarget_${timestamp}`,
        backend: 'rclone',
        target: '',
        password: 'Password123!',
      },
    });
    expect(invalidTargetRes.status()).toBe(400);
    const invalidTargetJson = await invalidTargetRes.json();
    expect(invalidTargetJson.error?.code).toBe('restic_target_invalid');

    // 4. Kısa parola (< 8 karakter) ile repo oluşturma: 400 restic_password_invalid
    const shortPassRes = await page.request.post('/api/panel/backups/repositories', {
      headers: {
        'x-csrf-token': csrfToken,
        Origin: 'https://server.cryptoraichu.website',
        Referer: 'https://server.cryptoraichu.website/',
      },
      data: {
        name: `trepopass_${timestamp}`,
        backend: 'local',
        password: 'short',
      },
    });
    expect(shortPassRes.status()).toBe(400);
    const shortPassJson = await shortPassRes.json();
    expect(shortPassJson.error?.code).toBe('restic_password_invalid');

    // 5. Kimlik doğrulamasız / CSRF korumasız istek reddi: 401 veya 403 (Unauthorized / Forbidden)
    const unauthRes = await request.post('https://server.cryptoraichu.website/api/panel/backups/remotes', {
      data: { name: 'unauth_remote', type: 's3' },
    });
    expect([401, 403]).toContain(unauthRes.status());
  });

  test('Plesk eşdeğerliği: UI üzerinde uzak depolama yapılandırma sihirbazı (Remote Storage Settings / FTP / S3 form)', async ({ page }) => {
    test.fail(
      true,
      'BULGU BAK-05: Plesk Backup Manager Remote Storage Settings (FTP Storage / Amazon S3 / Cloud wizard) arayüz formu YunPanel UI üzerinde bulunmuyor; yalnızca API seviyesinde rclone remotes destekleniyor ve eski FTP protokolü yerine yalnız SFTP/S3/B2/WebDAV sunuluyor.'
    );

    // Web sitesi yedekleme sayfasına git
    await page.goto(`/websites/${targetDomainId}/backup`);
    await expect(page.locator('h2:has-text("Yedekleme ve Geri Yükleme")')).toBeVisible({ timeout: 15000 });

    // Plesk eşdeğeri "Uzak Depolama Ayarları" / "Uzak Depo Ekle" veya "FTP Deposu" butonu aranır
    const remoteStorageConfigBtn = page.locator('button:has-text("Uzak Depo Ekle"), button:has-text("Remote Storage"), button:has-text("FTP Deposu"), a:has-text("Uzak Depolama Ayarları")');
    await expect(remoteStorageConfigBtn).toBeVisible({ timeout: 5000 });
  });
});
