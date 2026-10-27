import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, openFirstWebsiteWorkspace } from '../helpers.js';

test.use({ trace: 'off' });

function runSsh(command) {
  try {
    return execSync(`ssh -o BatchMode=yes -o ConnectTimeout=10 yunpanel-test ${JSON.stringify(command)}`, {
      encoding: 'utf8',
      timeout: 20000,
    }).trim();
  } catch (err) {
    console.warn(`SSH command failed: ${command} -> ${err.message}`);
    return '';
  }
}

function generateEd25519Key() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const rawPub = publicKey.subarray(publicKey.length - 32);
  const sshType = Buffer.from('ssh-ed25519');
  const typeLen = Buffer.alloc(4);
  typeLen.writeUInt32BE(sshType.length, 0);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(rawPub.length, 0);
  const sshPubWire = Buffer.concat([typeLen, sshType, keyLen, rawPub]);
  return `ssh-ed25519 ${sshPubWire.toString('base64')}`;
}

async function getApiHeaders(page) {
  const origin = 'https://server.cryptoraichu.website';
  const sessionRes = await page.request.get('/api/auth/session').catch(() => null);
  const sessionJson = sessionRes ? await sessionRes.json().catch(() => ({})) : {};
  const csrf = sessionJson?.data?.csrfToken || sessionJson?.csrfToken || '';
  return {
    Origin: origin,
    'x-csrf-token': csrf,
  };
}

test.describe('DOS-11 SSH/SFTP/shell erişimi ve anahtarlar; kullanıcı izolasyonu', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120000);

  const agentN = process.env.AGENT_N || '3';
  const timestamp = Date.now().toString(36);
  const keyLabel = `tdos11-a${agentN}-${timestamp}`;

  let resolvedDomainId = null;
  let resolvedWebsiteId = null;
  let resolvedUnixUser = null;
  let resolvedDocRoot = null;
  let createdKeyId = null;
  let expectedRevision = 1;

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

  test.afterAll(async ({ browser }) => {
    if (resolvedWebsiteId && createdKeyId) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
        const headers = await getApiHeaders(page);
        await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys/${encodeURIComponent(createdKeyId)}/revoke`, {
          headers,
          data: { expectedRevision },
        }).catch(() => {});

        // Sunucuda fiziksel temizliği teyit et
        if (resolvedUnixUser) {
          runSsh(`grep -v "${keyLabel}" /etc/ssh/yunpanel-authorized-keys/${resolvedUnixUser} > /tmp/ak-clean && mv /tmp/ak-clean /etc/ssh/yunpanel-authorized-keys/${resolvedUnixUser}`);
        }
      } catch (err) {
        console.warn('DOS-11 cleanup warning:', err.message);
      } finally {
        await context.close().catch(() => {});
      }
    }
  });

  test('mutlu yol 1: UI üzerinde SSH/SFTP erişim bilgileri ve Unix izolasyon parametrelerinin görüntülenmesi', async ({ page }) => {
    // 1. webrich.news sitesinin erişim sekmesine doğrudan git
    resolvedDomainId = '09efa3a3-81ed-5764-b925-3a6770516a6f';
    resolvedWebsiteId = '7fe9a711-a5b0-550e-a5e5-49fee4c66a73';

    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/access`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // 2. Erişim Hesapları başlığı ve açıklamasını doğrula
    await expect(page.locator('h2', { hasText: 'Erişim hesapları' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=SFTP, SSH ve sistem kullanıcısı erişim parametreleri')).toBeVisible({ timeout: 10000 });

    // 3. İzolasyon rozetini doğrula
    await expect(page.locator('.ws-badge:has-text("Dedicated Unix kullanıcısı (İzole)")')).toBeVisible({ timeout: 10000 });

    // 4. KeyValues parametrelerini doğrula
    const dl = page.locator('dl.ws-keyvalues').first();
    await expect(dl).toBeVisible({ timeout: 10000 });

    // Protokol
    await expect(dl.locator('div:has(dt:has-text("Protokol")) dd')).toHaveText('SFTP / SSH');

    // Bağlantı noktası
    await expect(dl.locator('div:has(dt:has-text("Bağlantı noktası (Port)")) dd')).toHaveText('22');

    // Kullanıcı adı
    const userDd = dl.locator('div:has(dt:has-text("Kullanıcı adı")) dd');
    await expect(userDd).toBeVisible();
    resolvedUnixUser = (await userDd.textContent()).trim();
    expect(resolvedUnixUser).toMatch(/^yunapp-[a-f0-9]{12}$/);

    // Belge kök dizini
    const docRootDd = dl.locator('div:has(dt:has-text("Belge kök dizini (Docroot)")) dd');
    await expect(docRootDd).toBeVisible();
    resolvedDocRoot = (await docRootDd.textContent()).trim();
    expect(resolvedDocRoot).toContain('/var/www/yunpanel/apps/');

    // İzolasyon durumu
    await expect(dl.locator('div:has(dt:has-text("İzolasyon durumu")) dd')).toHaveText('Dedicated Unix kullanıcısı (İzole)');

    // 5. Hızlı erişim linkleri (Site terminali & Dosya yöneticisi)
    await expect(page.locator(`a.ws-button[href*="/websites/${resolvedDomainId}/terminal"]`)).toBeVisible();
    await expect(page.locator(`a.ws-button[href*="/websites/${resolvedDomainId}/files"]`)).toBeVisible();

    // 6. Gelişmiş güvenlik denetimi ve geçiş araçları akordiyonu
    await expect(page.locator('summary:has-text("Gelişmiş güvenlik denetimi ve geçiş araçları")')).toBeVisible();

    expect(resolvedWebsiteId).toBeTruthy();
    expect(resolvedWebsiteId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('mutlu yol 2: SFTP/SSH anahtarı ekleme, listeleme ve fiziksel sunucuda authorized_keys / chroot doğrulaması', async ({ page }) => {
    expect(resolvedWebsiteId).toBeTruthy();
    expect(resolvedUnixUser).toBeTruthy();

    const validKey = generateEd25519Key();
    const headers = await getApiHeaders(page);

    // 1. API üzerinden SFTP/SSH public key ekle
    const addRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys`, {
      headers,
      data: {
        label: keyLabel,
        publicKey: validKey,
      },
    });

    expect(addRes.status()).toBe(201);
    const addJson = await addRes.json();
    expect(addJson.data).toBeTruthy();
    expect(addJson.data.key).toBeTruthy();
    expect(addJson.data.key.label).toBe(keyLabel);
    expect(addJson.data.key.fingerprint).toMatch(/^SHA256:/);
    expect(addJson.data.key.revision).toBe(1);

    createdKeyId = addJson.data.key.id;
    expectedRevision = addJson.data.key.revision;

    // 2. Anahtarları listele ve doğrula
    const listRes = await page.request.get(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys`);
    expect(listRes.status()).toBe(200);
    const listJson = await listRes.json();
    expect(Array.isArray(listJson.data?.keys)).toBe(true);
    const foundKey = listJson.data.keys.find((k) => k.id === createdKeyId);
    expect(foundKey).toBeTruthy();
    expect(foundKey.label).toBe(keyLabel);

    // 3. FİZİKSEL SONUÇ 1: Sunucuda authorized_keys dosyasına public key yazıldı mı?
    const akContent = runSsh(`cat /etc/ssh/yunpanel-authorized-keys/${resolvedUnixUser}`);
    expect(akContent).toContain(validKey);

    // 4. FİZİKSEL SONUÇ 2: Sunucuda dedicated Unix kullanıcısı ve grup izolasyonu
    const idOutput = runSsh(`id ${resolvedUnixUser}`);
    expect(idOutput).toContain(`uid=`);
    expect(idOutput).toContain(resolvedUnixUser);
    expect(idOutput).not.toContain('uid=0(root)'); // Kesinlikle root olmamalı

    // 5. FİZİKSEL SONUÇ 3: OpenSSH chroot ve SFTP izolasyonu konfigürasyonu
    const sshdConfig = runSsh(`cat /etc/ssh/sshd_config.d/90-yunpanel-sftp-${resolvedUnixUser}.conf`);
    expect(sshdConfig).toContain(`Match User ${resolvedUnixUser}`);
    expect(sshdConfig).toContain('ForceCommand internal-sftp -d /site -u 0027');
    expect(sshdConfig).toContain('PermitTTY no');
    expect(sshdConfig).toContain('PasswordAuthentication no');
    expect(sshdConfig).toContain(`/etc/ssh/yunpanel-authorized-keys/${resolvedUnixUser}`);
  });

  test('hatalı girdi: Geçersiz anahtar formatı ve eksik/fazla alanlar reddedilir', async ({ page }) => {
    expect(resolvedWebsiteId).toBeTruthy();
    const headers = await getApiHeaders(page);

    // 1. Bozuk / geçersiz anahtar formatı
    const invalidKeyRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys`, {
      headers,
      data: {
        label: `${keyLabel}-bad`,
        publicKey: 'invalid-ssh-key-not-openssh-format',
      },
    });
    expect(invalidKeyRes.status()).toBe(400);
    const invalidKeyJson = await invalidKeyRes.json();
    expect(['sftp_authorized_key_invalid', 'sftp_public_key_type_unsupported']).toContain(invalidKeyJson.error?.code);

    // 2. Eksik alanlar (publicKey olmadan)
    const missingFieldRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys`, {
      headers,
      data: {
        label: `${keyLabel}-missing`,
      },
    });
    expect(missingFieldRes.status()).toBe(400);
    const missingFieldJson = await missingFieldRes.json();
    expect(missingFieldJson.error?.code).toBe('sftp_key_add_input_invalid');

    // 3. Fazla/izinsiz alanlar (strict exactBody guard)
    const extraFieldRes = await page.request.post(`/api/panel/websites/${encodeURIComponent(resolvedWebsiteId)}/sftp/keys`, {
      headers,
      data: {
        label: `${keyLabel}-extra`,
        publicKey: generateEd25519Key(),
        maliciousField: 'unexpected',
      },
    });
    expect(extraFieldRes.status()).toBe(400);
    const extraFieldJson = await extraFieldRes.json();
    expect(extraFieldJson.error?.code).toBe('sftp_key_add_input_invalid');
  });

  test('Plesk eşdeğerliği: Panel arayüzünde SSH/SFTP anahtar yönetim ve kullanıcı parolası formu', async ({ page }) => {
    test.fail(
      true,
      'BULGU DOS-11: Panel arayüzünde SSH/SFTP anahtar ekleme/yönetme formu ve kullanıcı parolası değiştirme formu (SSH Keys UI) bulunmuyor; özellik yalnızca arka uç API (/api/websites/:id/sftp/keys) seviyesinde mevcut.',
    );

    // Plesk'te "SSH Access" ve "SSH Keys" sekmesinde kullanıcının doğrudan arayüzden anahtar yükleyebileceği bir form yer alır.
    await page.goto(`/websites/${encodeURIComponent(resolvedDomainId)}/access`);
    await page.waitForLoadState('networkidle').catch(() => {});

    // Panel arayüzünde SSH anahtarı ekleme butonu veya formu var mı?
    const addKeyBtn = page.locator('button:has-text("SSH Anahtarı Ekle"), button:has-text("Anahtar Ekle"), button:has-text("SSH Key")');
    await expect(addKeyBtn).toBeVisible({ timeout: 3000 });
  });
});
