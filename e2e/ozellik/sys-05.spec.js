import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const owner = JSON.parse(readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const baseURL = new URL(owner.url).origin;
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL, trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 15000 });

test.describe.serial('SYS-05 owned terminal sessions and isolated repair', () => {
  test.setTimeout(180000);
  const prefix = 'tsys05-a' + (process.env.AGENT_N || 'codex') + '-' + Date.now().toString(36);
  const hostname = prefix + '.157-180-11-28.sslip.io';
  const username = prefix + '_sm';
  const password = randomBytes(24).toString('base64url') + '!aA1';
  const ownedSessions = new Map();
  let sshAlias;
  let accountCreated = false;
  let ownedSite = null;

  async function fillSecret(locator, value) {
    try { await locator.fill(value); }
    catch { throw new Error('Secret input could not be filled'); }
  }

  async function login(page, user = owner.username, secret = owner.password) {
    await page.goto('/');
    const bar = page.locator('.auth-sessionbar');
    const form = page.locator('form.auth-form');
    await expect(bar.or(form)).toBeVisible();
    if (await bar.isVisible()) {
      if ((await bar.innerText()).includes(user)) return;
      await bar.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
    }
    await form.locator('[name="username"]').fill(user);
    await fillSecret(form.locator('[name="password"]'), secret);
    await form.locator('button.auth-primary').click();
    await expect(bar).toContainText(user, { timeout: 30000 });
  }

  async function logout(page) {
    if (page.isClosed()) return;
    await page.goto('/');
    const button = page.locator('.auth-sessionbar').getByRole('button', { name: 'Çıkış yap', exact: true });
    if (await button.isVisible()) {
      await button.click();
      await expect(page.locator('form.auth-form')).toBeVisible();
    }
  }

  async function api(page, path, method = 'GET', body) {
    try {
      return await page.evaluate(async ({ path, method, body }) => {
        const headers = { 'content-type': 'application/json' };
        if (method !== 'GET') {
          const session = await fetch('/api/auth/session').then(r => r.json());
          headers['x-csrf-token'] = session.data.csrfToken;
        }
        const response = await fetch('/api/panel' + path, {
          method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      }, { path, method, body });
    } catch { throw new Error('Live panel request failed: ' + method + ' ' + path); }
  }

  // Read-only SSH inspects exact owned sockets or exact owned application paths.
  function inspectPhysical(input) {
    const code = [
      'import json,os,stat,sys',
      'value=json.load(sys.stdin)',
      "if value['kind']=='socket':",
      " p='/run/yunpanel/ttyd/'+value['id']+'.sock'",
      ' pids=[]',
      " for entry in os.scandir('/proc'):",
      '  if not entry.name.isdecimal(): continue',
      '  try:',
      "   args=open(entry.path+'/cmdline','rb').read().split(b'\\0')",
      "   if args[0]==b'/usr/bin/ttyd' and p.encode() in args: pids.append(int(entry.name))",
      '  except (FileNotFoundError,PermissionError,ProcessLookupError): pass',
      " print(json.dumps({'socket':os.path.exists(p) and stat.S_ISSOCK(os.stat(p).st_mode),'pids':pids}))",
      'else:',
      " root='/var/lib/yunpanel/data/'+value['applicationId']",
      " paths=[root,root+'/tmp',root+'/logs']",
      " print(json.dumps({'paths':[{'path':p,'exists':os.path.exists(p),'mode':oct(stat.S_IMODE(os.stat(p).st_mode))} for p in paths]}))",
    ].join('\n');
    try {
      const quoted = "'" + code.replaceAll("'", "'\\''") + "'";
      return JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias,
        'python3 -c ' + quoted], { input: JSON.stringify(input), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 }));
    } catch { throw new Error('Owned resource physical inspection failed'); }
  }

  async function closeSession(sessionId) {
    const page = ownedSessions.get(sessionId);
    if (!page) return;
    const result = await api(page, '/terminal/ttyd-sessions/' + sessionId, 'DELETE');
    expect([204, 404].includes(result.status)).toBe(true);
    await expect.poll(() => inspectPhysical({ kind: 'socket', id: sessionId }).socket).toBe(false);
    ownedSessions.delete(sessionId);
  }

  async function createSession(page, serverId) {
    const issued = await api(page, '/terminal/capabilities', 'POST', { scope: 'server', serverId });
    expect(issued.status).toBe(201);
    const capability = issued.body?.data?.capability;
    expect(typeof capability === 'string' && /^[A-Za-z0-9_-]{43}$/.test(capability)).toBe(true);
    const result = await api(page, '/terminal/ttyd-sessions', 'POST', { capability });
    expect(result.status).toBe(201);
    const sessionId = result.body?.data?.sessionId;
    expect(typeof sessionId === 'string' && /^[a-f0-9-]{36}$/.test(sessionId)).toBe(true);
    ownedSessions.set(sessionId, page);
    expect(result.body.data.protocol).toBe('yunpanel-ttyd-v1');
    const physical = inspectPhysical({ kind: 'socket', id: sessionId });
    expect(physical.socket).toBe(true);
    expect(physical.pids.length).toBe(1);
    return { sessionId, pid: physical.pids[0] };
  }

  async function findUserRow(page) {
    await page.goto('/settings/users');
    await expect(page.getByRole('heading', { name: 'Kullanıcılar', exact: true })).toBeVisible();
    for (let index = 0; index < 50; index++) {
      // The table and pager are disabled while the page loads; wait until the account total is shown.
      await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hesaplar', exact: true }) })
        .locator('.ws-pagination')).toContainText(/\d+ hesap/, { timeout: 30_000 });
      const row = page.getByRole('row').filter({ has: page.getByText(username, { exact: true }) });
      if (await row.count()) return row;
      const next = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hesaplar', exact: true }) })
        .getByRole('button', { name: 'Sonraki', exact: true });
      if (!await next.isEnabled()) return null;
      const pagination = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hesaplar', exact: true }) }).locator('.ws-pagination');
      const current = await pagination.innerText();
      await next.click();
      await expect(pagination).not.toHaveText(current);
    }
    throw new Error('Owned user pagination exceeded bounded search');
  }

  async function removeUser(page) {
    if (!accountCreated) return;
    const row = await findUserRow(page);
    expect(row).not.toBeNull();
    await row.getByRole('button', { name: username + ' hesabını sil', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Kullanıcıyı sil', exact: true }) });
    await dialog.locator('input').fill(username);
    await dialog.getByRole('button', { name: 'Hesabı sil', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toHaveCount(0);
    accountCreated = false;
  }

  async function removeSite(page) {
    if (!ownedSite) return;
    const current = await api(page, '/domains/' + ownedSite.domainId);
    if (current.status === 404) {
      expect((await api(page, '/websites/' + ownedSite.websiteId)).status).toBe(404);
      ownedSite = null;
      return;
    }
    expect(current.status).toBe(200);
    expect(current.body.data.primaryDomain).toBe(hostname);
    expect(current.body.data.websiteId).toBe(ownedSite.websiteId);
    await page.goto('/websites/' + ownedSite.domainId + '/settings');
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Siteyi sil', exact: true }) });
    await expect(section).toBeVisible();
    await section.getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: 'Siteyi kalıcı olarak sil' });
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill(hostname);
    await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click();
    await expect(page.getByText('Site silindi', { exact: true })).toBeVisible({ timeout: 90000 });
    await expect.poll(async () => (await api(page, '/domains/' + ownedSite.domainId)).status).toBe(404);
    expect((await api(page, '/websites/' + ownedSite.websiteId)).status).toBe(404);
    ownedSite = null;
  }

  test.beforeAll(() => {
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
      .map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')]; }));
    sshAlias = config.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    const resolved = execFileSync('ssh', ['-G', sshAlias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST
      && config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')).toBe(true);
  });

  test.beforeEach(async ({ page }) => { await login(page); });
  test.afterEach(async ({ page }) => { await logout(page); });
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL, ignoreHTTPSErrors: true });
    try {
      await login(page);
      await removeUser(page);
      await removeSite(page);
    } finally {
      await logout(page);
      await page.close();
    }
    expect(ownedSessions.size).toBe(0);
  });

  test('root terminal executes a real command and disconnects only this WebSocket', async ({ page }) => {
    const outputs = [];
    page.on('websocket', socket => socket.on('framereceived', event => {
      try {
        const message = JSON.parse(String(event.payload));
        if (message.type === 'output') outputs.push(message.data);
      } catch { /* Other WebSocket protocols are outside this terminal observation. */ }
    }));
    await page.goto('/servers');
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Sunucu terminali', exact: true }) });
    await expect(section).toBeVisible();
    try {
      await section.getByRole('button', { name: /Terminali aç|Yeniden bağlan/ }).click();
      await expect(section.getByRole('status')).toHaveText('Bağlı');
      const marker = 'SYS05_' + randomBytes(8).toString('hex');
      await section.locator('.ws-terminal-surface').click();
      await page.keyboard.type("printf '%s_UID_%s_USER_%s\\n' '" + marker + "' \"$(id -u)\" \"$(whoami)\"");
      await page.keyboard.press('Enter');
      await expect.poll(() => outputs.join('').includes(marker + '_UID_0_USER_root')).toBe(true);
      await expect(section.locator('.xterm-accessibility')).toContainText(marker + '_UID_0_USER_root');
    } finally {
      const disconnect = section.getByRole('button', { name: 'Bağlantıyı kapat', exact: true });
      if (await disconnect.isVisible()) {
        await disconnect.click();
        await expect(section.getByRole('status')).toHaveText('Bağlantı kapandı');
      }
      await page.goto('/');
    }
  });

  test('closing one owned ttyd session preserves another real session and its PID', async ({ browser, page }) => {
    const servers = await api(page, '/servers');
    expect(servers.status).toBe(200);
    const server = servers.body.data.find(item => item.executionMode === 'local');
    expect(server?.id).toBeDefined();
    const contexts = [];
    try {
      const sessions = [];
      for (let index = 0; index < 2; index++) {
        const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
        contexts.push(context);
        const terminalPage = await context.newPage();
        await login(terminalPage);
        sessions.push(await createSession(terminalPage, server.id));
      }
      expect(sessions[0].sessionId).not.toBe(sessions[1].sessionId);
      await closeSession(sessions[0].sessionId);
      const preserved = inspectPhysical({ kind: 'socket', id: sessions[1].sessionId });
      expect(preserved.socket).toBe(true);
      expect(preserved.pids).toEqual([sessions[1].pid]);
      await closeSession(sessions[1].sessionId);
    } finally {
      const failures = [];
      for (const sessionId of [...ownedSessions.keys()]) {
        try { await closeSession(sessionId); }
        catch (error) { failures.push({ sessionId, message: error.message }); }
      }
      for (const context of contexts) {
        for (const sessionPage of context.pages()) await logout(sessionPage);
        await context.close();
      }
      expect(failures, 'Every owned terminal must close through its API').toEqual([]);
    }
  });

  test('forged capability and site manager cannot start a root terminal', async ({ browser, page }) => {
    const forged = await api(page, '/terminal/ttyd-sessions', 'POST', { capability: 'F'.repeat(43) });
    expect([400, 401, 403].includes(forged.status)).toBe(true);
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Kullanıcı ekle', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Kullanıcı ekle', exact: true }) });
    await dialog.locator('[name="username"]').fill(username);
    await fillSecret(dialog.locator('[name="new-password"]'), password);
    await dialog.locator('select').filter({ has: page.locator('option[value="site_manager"]') }).selectOption('site_manager');
    const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/panel/users'
      && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Hesap oluştur', exact: true }).click();
    const createdResponse = await created;
    accountCreated = createdResponse.status() === 201;
    expect(createdResponse.status()).toBe(201);
    await expect(dialog).not.toBeVisible();
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true });
    try {
      const restricted = await context.newPage();
      await login(restricted, username, password);
      await restricted.goto('/servers');
      await expect(restricted.getByRole('heading', { name: 'Sunucu terminali', exact: true })).toHaveCount(0);
      const capability = await api(restricted, '/terminal/capabilities', 'POST', { scope: 'server', serverId: 'local' });
      expect(capability.status).toBe(403);
      const session = await api(restricted, '/terminal/ttyd-sessions', 'POST', { capability: 'F'.repeat(43) });
      expect([401, 403].includes(session.status)).toBe(true);
      await logout(restricted);
    } finally {
      await context.close();
      await removeUser(page);
    }
  });

  test('permission repair and invalid actions target only the created test website', async ({ page }) => {
    try {
      await page.goto('/websites/new');
      await page.getByPlaceholder('example.com', { exact: true }).fill(hostname);
      await page.getByLabel('www davranışı').selectOption('none');
      await page.getByRole('button', { name: 'Devam et', exact: true }).click();
      await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
      await page.getByRole('button', { name: 'Devam et', exact: true }).click();
      await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('external');
      await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
      const mail = page.getByRole('checkbox', { name: /E-posta ve Webmail etkinleştir/ });
      if (await mail.isChecked()) await mail.uncheck();
      const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/panel/sites'
        && response.request().method() === 'POST');
      await page.getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
      const response = await created;
      const data = (await response.json()).data;
      if (data?.primaryDomain?.primaryDomain === hostname) {
        ownedSite = { domainId: data.primaryDomain.id, websiteId: data.website.id, applicationId: data.website.applicationId };
      }
      expect([200, 201].includes(response.status())).toBe(true);
      expect(ownedSite).not.toBeNull();
      await expect(page.getByText('Kurulum planındaki zorunlu adımlar tamamlandı. Yayın, SSL ve posta durumunu ilgili site araçlarından doğrulayın.', { exact: true })).toBeVisible({ timeout: 60000 });
      const repair = await api(page, '/websites/' + ownedSite.websiteId + '/health/repair', 'POST', { action: 'repair_permissions' });
      expect(repair.status).toBe(200);
      expect(repair.body.data.websiteId).toBe(ownedSite.websiteId);
      expect(repair.body.data.success).toBe(true);
      expect(repair.body.data.repairedLayer).toBe('filesystem');
      expect(repair.body.data.verified).toBe(true);
      const physical = inspectPhysical({ kind: 'paths', applicationId: ownedSite.applicationId });
      expect(physical.paths.map(item => item.exists)).toEqual([true, true, true]);
      expect(physical.paths.map(item => item.mode)).toEqual(['0o750', '0o700', '0o750']);
      const invalid = await api(page, '/websites/' + ownedSite.websiteId + '/health/repair', 'POST', { action: 'invalid_action_xyz' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('invalid_repair_action');
    } finally { await removeSite(page); }
  });

  test('event handlers and repair kit UI remain an explicit product gap', async ({ page }) => {
    await page.goto('/tools-settings');
    await expect(page.getByRole('heading', { name: 'Araçlar ve Ayarlar', exact: true })).toBeVisible();
    test.fail(true, 'SYS-05: event handlers and central repair tools UI are not available');
    await expect(page.getByRole('link', { name: /Olay tetikleyicileri|Olay yöneticisi/i })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('link', { name: /Onarım araçları|Sistem onarımı/i })).toBeVisible({ timeout: 3000 });
  });
});
