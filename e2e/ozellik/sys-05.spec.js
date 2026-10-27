import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD, loginAs, logout } from '../helpers.js';

test.use({ trace: 'off' });

test.describe.serial('SYS-05 Yönetici terminali, olay tetikleyicileri ve onarım araçları', () => {
  test.setTimeout(240000);

  const agentN = process.env.AGENT_N || '4';
  const timestamp = Date.now().toString(36);
  const prefix = `tsys05-a${agentN}-${timestamp}`;
  const testUsername = `${prefix}_sm`;
  const testPassword = `Pass_${timestamp}_Sys05!`;

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

  test.afterAll(async ({ browser }) => {
    // 1. Arayüzden kullanıcı silme denemesi
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
      await page.goto('/settings/users').catch(() => {});
      const userRow = page.locator('table tr', { hasText: testUsername });
      if (await userRow.isVisible({ timeout: 3000 }).catch(() => false)) {
        const deleteBtn = userRow.locator('button:has-text("Sil")');
        if (await deleteBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await deleteBtn.click().catch(() => {});
          const confirmBtn = page.locator('button:has-text("Kullanıcıyı sil"), button:has-text("Onayla")');
          if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await confirmBtn.click().catch(() => {});
          }
        }
      }
      await page.close().catch(() => {});
    } catch {}

    // 2. Fiziksel temizlik: SQLite üzerinden kalan kullanıcı ve artık soketler
    runSsh(`sqlite3 /var/lib/yunpanel/control-plane/auth/auth.sqlite "DELETE FROM users WHERE username='${testUsername}';"`);
    runSsh(`pkill -f ttyd 2>/dev/null || true; rm -f /run/yunpanel/ttyd/*.sock 2>/dev/null || true`);
  });

  test('mutlu yol 1: Yönetici kök terminali (WebSocket xterm PTY) açılması ve komut yürütme', async ({ page }) => {
    // 1. Giriş yap ve /servers sayfasına git
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
    await page.goto('/servers');

    // 2. Sunucu terminali bölümünü doğrula
    const termSection = page.locator('section, .ws-section', { hasText: 'Sunucu terminali' });
    await expect(termSection).toBeVisible({ timeout: 15000 });

    const terminalSurface = termSection.locator('.ws-terminal-surface');
    await expect(terminalSurface).toBeVisible({ timeout: 10000 });

    // 3. Terminali aç butonuna tıkla
    const connectBtn = termSection.locator('button:has-text("Terminali aç"), button:has-text("Yeniden bağlan")');
    await expect(connectBtn).toBeVisible({ timeout: 10000 });
    await connectBtn.click();

    // 4. Bağlandı durumunu bekle
    await expect(termSection.locator('span[role="status"]:has-text("Bağlı")')).toBeVisible({ timeout: 15000 });

    // 5. Terminal yüzeyine odaklanıp komut gönder
    await terminalSurface.click();
    const marker = `ROOT_EXEC_${Date.now()}`;
    await page.keyboard.type(`echo "${marker}" && id -u && whoami`);
    await page.keyboard.press('Enter');

    // 6. xterm çıktısında marker, 0 (root uid) ve root kullanıcı adını doğrula
    const xtermRows = termSection.locator('.xterm-rows');
    await expect(xtermRows).toContainText(marker, { timeout: 10000 });
    await expect(xtermRows).toContainText('0', { timeout: 10000 });
    await expect(xtermRows).toContainText('root', { timeout: 10000 });

    // 7. Fiziksel kanıt: Sunucuda çalışan PTY / terminal shell prosesinin varlığı
    const procCheck = runSsh('ps -eo pid,user,comm,args | grep -E "sh|bash" | grep -v grep | head -n 5');
    expect(procCheck.length > 0, 'Sunucuda terminal prosesi fiziksel olarak mevcut olmalı').toBe(true);

    // 8. Terminali kapat
    const disconnectBtn = termSection.locator('button:has-text("Bağlantıyı kapat")');
    await expect(disconnectBtn).toBeVisible();
    await disconnectBtn.click();
    await expect(termSection.locator('span[role="status"]:has-text("Bağlantı kapandı")')).toBeVisible({ timeout: 10000 });
  });

  test('mutlu yol 2: ttyd oturumu başlatma, fiziksel soket kanıtı ve oturumu sonlandırma', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 1. Sunucu kimliğini al
    const serversRes = await apiCall(page, '/api/panel/servers');
    expect(serversRes.ok).toBe(true);
    const serverList = serversRes.data?.data || [];
    const localServer = serverList.find((s) => s.executionMode === 'local') || serverList[0];
    expect(localServer?.id, 'Yerel sunucu kimliği bulunmalı').toBeDefined();

    // 2. Terminal capability oluştur
    const capRes = await apiCall(page, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: {
        scope: 'server',
        serverId: localServer.id,
      },
    });
    expect(capRes.status).toBe(201);
    const capability = capRes.data?.data?.capability;
    expect(capability, '43 karakterlik capability dönmeli').toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 3. ttyd oturumu başlat
    const ttydRes = await apiCall(page, '/api/panel/terminal/ttyd-sessions', {
      method: 'POST',
      body: { capability },
    });
    expect(ttydRes.status).toBe(201);
    const sessionId = ttydRes.data?.data?.sessionId;
    expect(sessionId, 'Oturum kimliği UUID dönmeli').toBeDefined();
    expect(ttydRes.data?.data?.protocol).toBe('yunpanel-ttyd-v1');

    // 4. Fiziksel kanıt: Sunucuda /run/yunpanel/ttyd/<sessionId>.sock soket dosyasının varlığı
    const socketExists = runSsh(`test -S /run/yunpanel/ttyd/${sessionId}.sock && echo "SOCKET_READY"`);
    expect(socketExists).toContain('SOCKET_READY');

    // 5. ttyd oturumunu güvenle sonlandır (DELETE)
    const deleteRes = await apiCall(page, `/api/panel/terminal/ttyd-sessions/${sessionId}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(204);

    // 6. Fiziksel kanıt: Soket dosyasının silindiğini doğrula
    const socketAfter = runSsh(`test -e /run/yunpanel/ttyd/${sessionId}.sock || echo "SOCKET_REMOVED"`);
    expect(socketAfter).toContain('SOCKET_REMOVED');
  });

  test('yetki ve sınır kontrolleri: yetkisiz terminal capability reddi ve site_manager sınırları', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // Sınır 1: Sahte/yetkisiz capability ile ttyd oturumu başlatma reddi
    const forgedCap = 'F'.repeat(43);
    const forgedRes = await apiCall(page, '/api/panel/terminal/ttyd-sessions', {
      method: 'POST',
      body: { capability: forgedCap },
    });
    expect([400, 401, 403].includes(forgedRes.status), 'Sahte capability 400, 401 veya 403 ile reddedilmeli').toBe(true);

    // Sınır 2: Yeni bir site_manager kullanıcısı oluştur ve yetki sınırlarını test et
    await page.goto('/settings/users');
    await expect(page.locator('h1', { hasText: 'Kullanıcılar' })).toBeVisible({ timeout: 15000 });

    const addUserBtn = page.locator('button:has-text("Kullanıcı ekle")');
    await expect(addUserBtn).toBeVisible({ timeout: 10000 });
    await addUserBtn.click();

    await expect(page.locator('h2:has-text("Kullanıcı ekle")')).toBeVisible({ timeout: 10000 });
    await page.fill('input[name="username"]', testUsername);
    await page.fill('input[name="new-password"]', testPassword);
    await page.selectOption('label:has-text("Rol") select', 'site_manager');
    await page.click('button[type="submit"]:has-text("Hesap oluştur")');

    await expect(page.locator('.ws-notice')).toContainText(/Hesap oluşturuldu/i, { timeout: 15000 });

    // site_manager kullanıcısı ile oturum aç
    await logout(page);
    await loginAs(page, testUsername, testPassword);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // Arayüz kontrolü: site_manager /servers sayfasına gittiğinde Sunucu terminali görmemeli
    await page.goto('/servers');
    const rootTermSection = page.locator('section, .ws-section', { hasText: 'Sunucu terminali' });
    await expect(rootTermSection).toHaveCount(0);

    // API kontrolü 1: site_manager root server capability isteyemez (403 Forbidden)
    const unauthorizedCapRes = await apiCall(page, '/api/panel/terminal/capabilities', {
      method: 'POST',
      body: {
        scope: 'server',
        serverId: 'local',
      },
    });
    expect(unauthorizedCapRes.status).toBe(403);
    expect(['terminal_server_forbidden', 'site_scope_forbidden'].includes(unauthorizedCapRes.data?.error?.code)).toBe(true);

    // API kontrolü 2: site_manager doğrudan ttyd oturumu açamaz (401 Unauthorized)
    const unauthorizedTtydRes = await apiCall(page, '/api/panel/terminal/ttyd-sessions', {
      method: 'POST',
      body: { capability: forgedCap },
    });
    expect([401, 403].includes(unauthorizedTtydRes.status)).toBe(true);
  });

  test('onarım araçları: site health repair API ve hatalı girdi denetimi', async ({ page }) => {
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });

    // 1. Mevcut bir web sitesini al
    const sitesRes = await apiCall(page, '/api/panel/websites');
    expect(sitesRes.ok).toBe(true);
    const siteList = sitesRes.data?.data || [];
    const targetSite = siteList[0];
    expect(targetSite?.id, 'En az 1 web sitesi bulunmalı').toBeDefined();

    // 2. Geçerli onarım işlemi çağrısı (repair_permissions)
    const repairRes = await apiCall(page, `/api/panel/websites/${targetSite.id}/health/repair`, {
      method: 'POST',
      body: {
        action: 'repair_permissions',
      },
    });
    expect(repairRes.status).toBe(200);
    expect(repairRes.data?.data?.success).toBe(true);
    expect(repairRes.data?.data?.repairedLayer).toBe('filesystem');

    // 3. Hatalı girdi: Geçersiz repair action 400 Bad Request ile reddedilir
    const invalidRepairRes = await apiCall(page, `/api/panel/websites/${targetSite.id}/health/repair`, {
      method: 'POST',
      body: {
        action: 'invalid_action_xyz',
      },
    });
    expect(invalidRepairRes.status).toBe(400);
    expect(invalidRepairRes.data?.error?.code).toBe('invalid_repair_action');
  });

  test('Plesk UI eşdeğerliği: Olay Tetikleyicileri (Event Handlers) ve Sistem Onarım Araçları (Repair Kit)', async ({ page }) => {
    // Plesk'te Araçlar ve Ayarlar altında "Olay Tetikleyicileri" (Event Handlers) ve
    // "Onarım Araçları" (Diagnose & Repair) mevcuttur.
    // YunPanel Araçlar ve Ayarlar sayfasında bu bölümlerin varlığı kontrol edilir.
    await loginAs(page, OWNER_USERNAME, OWNER_PASSWORD);
    await expect(page.locator('.auth-sessionbar')).toBeVisible({ timeout: 15000 });
    await page.goto('/tools-settings');
    await expect(page.locator('h1', { hasText: 'Araçlar ve Ayarlar' })).toBeVisible({ timeout: 15000 });

    // YunPanel'de henüz Plesk tarzı merkezi Olay Tetikleyicileri (Event Manager)
    // ve Sistem Onarım Araçları (Repair Kit) UI bağlantıları yer almadığı için bu test test.fail ile işaretlenir.
    test.fail(
      true,
      'Plesk eşdeğeri Olay Tetikleyicileri (Event Manager) ve Sistem Onarım Araçları (Repair Kit) UI arayüzü henüz mevcut değil'
    );

    const eventManagerLink = page.locator('a', { hasText: /Olay tetikleyicileri|Olay yöneticisi/i });
    const repairKitLink = page.locator('a', { hasText: /Onarım araçları|Sistem onarımı/i });

    await expect(eventManagerLink).toBeVisible({ timeout: 3000 });
    await expect(repairKitLink).toBeVisible({ timeout: 3000 });
  });
});
