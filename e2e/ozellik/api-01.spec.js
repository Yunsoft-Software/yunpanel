import { test, expect, request as apiRequest } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

// Real panel scenarios: one-time key display and persistence, validation/CSRF,
// and authenticated Customer/Reseller denial. Credentials remain in memory;
// screenshots, videos and traces must never retain the one-time key.
const owner = JSON.parse(readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const baseURL = new URL(owner.url).origin;
// The installed Playwright recorder honors this switch before taking failure DOM snapshots.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL, trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 15_000, navigationTimeout: 30_000 });

test.describe.serial('API-01 API keys through the real panel', () => {
  test.setTimeout(180_000);
  const prefix = `tapi01-acodex-${Date.now().toString(36)}`;
  const scope = `${prefix}.157-180-11-28.sslip.io`;
  const definition = { name: prefix, parentDomain: scope, portMin: 32000, portMax: 32009 };
  const ownedKeys = new Map();
  const accounts = [];
  let machine;
  let sshAlias;

  const panelPath = '/api/panel/api-keys';
  const isResponse = (path, method) => (response) => new URL(response.url()).pathname === path
    && response.request().method() === method;
  const keySection = (page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'API anahtarları', exact: true }) });
  const dialog = (page, title) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

  async function fillSecret(field, value) {
    try { await field.fill(value); }
    catch { throw new Error('Secret input could not be filled'); }
  }

  async function call(context, method, path, options) {
    try { return await context[method](path, options); }
    catch { throw new Error(`Live ${method.toUpperCase()} request failed before a response`); }
  }

  async function login(page, username = OWNER_USERNAME, password = OWNER_PASSWORD) {
    await page.goto('/');
    const bar = page.locator('.auth-sessionbar');
    const form = page.locator('form.auth-form');
    await expect(bar.or(form)).toBeVisible({ timeout: 30_000 });
    if (await bar.isVisible()) {
      if ((await bar.innerText()).includes(username)) return;
      await bar.getByRole('button', { name: 'Çıkış yap', exact: true }).click();
    }
    await expect(form).toBeVisible();
    await form.locator('[name="username"]').fill(username);
    await fillSecret(form.locator('[name="password"]'), password);
    await form.locator('button.auth-primary').click();
    await expect(bar).toContainText(username, { timeout: 30_000 });
  }

  async function openKeys(page) {
    await page.goto('/settings?section=api');
    await expect(keySection(page).getByRole('button', { name: 'Anahtar oluştur', exact: true })).toBeVisible();
  }

  async function createKey(page, name = definition.name) {
    await openKeys(page);
    const section = keySection(page);
    await section.getByLabel('Ad', { exact: true }).fill(name);
    await section.getByLabel('Üst alan adı', { exact: true }).fill(scope);
    await section.getByLabel('İlk port', { exact: true }).fill(String(definition.portMin));
    await section.getByLabel('Son port', { exact: true }).fill(String(definition.portMax));
    const pending = page.waitForResponse(isResponse(panelPath, 'POST'));
    await section.getByRole('button', { name: 'Anahtar oluştur', exact: true }).click();
    const response = await pending;
    expect(response.status()).toBe(201);
    const result = (await response.json()).data;
    ownedKeys.set(name, result.key.id);
    await expect(section.locator('.ws-secret')).toHaveCount(1);
    const token = await section.locator('.ws-secret').textContent();
    expect(token === result.token).toBe(true);
    expect(/^ypk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(result.key.scope).toEqual({ parentDomain: scope, portMin: 32000, portMax: 32009 });
    return { id: result.key.id, token, name };
  }

  async function revokeKey(page, name) {
    await openKeys(page);
    const row = keySection(page).getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });
    await expect(row).toBeVisible();
    const start = row.getByRole('button', { name: 'İptal…', exact: true });
    if (await start.count()) {
      await start.click();
      const pending = page.waitForResponse(isResponse(`${panelPath}/${ownedKeys.get(name)}`, 'DELETE'));
      await row.getByRole('button', { name: 'İptal et', exact: true }).click();
      expect((await pending).status()).toBe(200);
    }
    await expect(row).toContainText('İptal edildi');
  }

  function persistedKey(id) {
    if (!/^[a-f0-9]{12}$/.test(id)) throw new Error('Unexpected key identity');
    // Only this test key's non-plaintext metadata is returned, never other keys.
    const script = `import json,pathlib\ns=json.loads(pathlib.Path('/var/lib/yunpanel/control-plane/api-keys.json').read_text())\nr=next((r for r in s['keys'] if r['id']=='${id}'),None)\nprint(json.dumps({'exists':r is not None,'hash':r.get('hash') if r else None,'revoked':bool(r.get('revokedAt')) if r else False,'plaintextFields':any(k.lower() in ['token','secret','password'] for k in r) if r else False}))`;
    const result = execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias,
      `python3 - <<'PY'\n${script}\nPY`], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(result);
  }

  async function mutationHeaders(page) {
    const response = await call(page.request, 'get', '/api/auth/session');
    expect(response.status()).toBe(200);
    const session = (await response.json()).data;
    expect(typeof session.csrfToken === 'string' && session.csrfToken.length > 0).toBe(true);
    return { origin: baseURL, 'x-csrf-token': session.csrfToken };
  }

  async function userRow(page, username) {
    await page.goto('/settings/users');
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Hesaplar', exact: true }) });
    await expect(section).toBeVisible();
    for (let number = 0; number < 100; number += 1) {
      await expect(section.locator('.ws-loading')).toHaveCount(0);
      const row = section.getByRole('row').filter({ has: page.getByRole('rowheader', { name: username, exact: true }) });
      if (await row.count()) return row;
      const next = section.getByRole('button', { name: 'Sonraki', exact: true });
      if (await next.isDisabled()) break;
      const pending = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/panel/users' && r.request().method() === 'GET');
      await next.click();
      expect((await pending).status()).toBe(200);
    }
    throw new Error('This test account was not found through user pagination');
  }

  async function createAccount(page, kind) {
    const account = { username: `${prefix}-${kind}`, password: randomBytes(24).toString('base64url'), kind, profile: false };
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'Kullanıcı ekle', exact: true }).click();
    const form = dialog(page, 'Kullanıcı ekle');
    await form.locator('[name="username"]').fill(account.username);
    await fillSecret(form.locator('[name="new-password"]'), account.password);
    await form.getByLabel(/^Rol/).selectOption('site_manager');
    const pending = page.waitForResponse(isResponse('/api/panel/users', 'POST'));
    await form.getByRole('button', { name: 'Hesap oluştur', exact: true }).click();
    const created = await pending;
    expect(created.status()).toBe(201);
    account.id = (await created.json()).data.user.id;
    accounts.push(account);
    await expect(form).toHaveCount(0);
    const row = await userRow(page, account.username);
    await row.getByRole('button', { name: `${account.username} bayi veya müşteri profilini yönet`, exact: true }).click();
    const profile = dialog(page, 'Bayi / müşteri profili');
    await profile.getByLabel(/^Profil türü/).selectOption(kind);
    if (kind === 'reseller') {
      await profile.getByLabel('Toplam müşteri', { exact: true }).fill('0');
      await profile.getByLabel('Toplam site', { exact: true }).fill('0');
    }
    const registered = page.waitForResponse(isResponse('/api/panel/users/hosting/accounts', 'POST'));
    await profile.getByRole('button', { name: 'Profili bağla', exact: true }).click();
    const response = await registered;
    expect(response.status()).toBe(201);
    account.profile = true;
    expect((await response.json()).data.account.kind).toBe(kind);
    await expect(profile).toHaveCount(0);
    return account;
  }

  async function removeAccount(page, account) {
    let row = await userRow(page, account.username);
    if (account.profile) {
      await row.getByRole('button', { name: `${account.username} bayi veya müşteri profilini yönet`, exact: true }).click();
      const profile = dialog(page, 'Bayi / müşteri profili');
      await profile.getByRole('button', { name: 'Profili kaldır', exact: true }).click();
      await profile.locator('input[autocomplete="off"]').fill(account.username);
      const pending = page.waitForResponse(isResponse(`/api/panel/users/hosting/accounts/${account.id}/profile`, 'DELETE'));
      await profile.getByRole('button', { name: 'Profili kaldır', exact: true }).click();
      expect((await pending).status()).toBe(200);
      await expect(profile).toHaveCount(0);
      account.profile = false;
      row = await userRow(page, account.username);
    }
    await row.getByRole('button', { name: `${account.username} hesabını sil`, exact: true }).click();
    const remove = dialog(page, 'Kullanıcıyı sil');
    await remove.locator('input[autocomplete="off"]').fill(account.username);
    const pending = page.waitForResponse(isResponse(`/api/panel/users/${account.id}`, 'DELETE'));
    await remove.getByRole('button', { name: 'Hesabı sil', exact: true }).click();
    expect((await pending).status()).toBe(200);
    await expect(remove).toHaveCount(0);
    let exists = false;
    let total = 1;
    for (let offset = 0; offset < total; offset += 25) {
      const response = await call(page.request, 'get', `/api/panel/users?limit=25&offset=${offset}`);
      expect(response.status()).toBe(200);
      const result = (await response.json()).data;
      total = result.total;
      if (result.users.some((user) => user.id === account.id)) { exists = true; break; }
    }
    expect(exists).toBe(false);
  }

  test.beforeAll(async () => {
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
      }));
    sshAlias = config.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    const resolved = execFileSync('ssh', ['-G', sshAlias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST
      && config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')).toBe(true);
    machine = await apiRequest.newContext({ baseURL, ignoreHTTPSErrors: false });
  });

  test.afterAll(async ({ browser }) => {
    if (!ownedKeys.size && !accounts.length) { await machine?.dispose(); return; }
    const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: false });
    context.setDefaultTimeout(15_000);
    const page = await context.newPage();
    const errors = [];
    try {
      await login(page);
      for (const [name] of ownedKeys) {
        try { await revokeKey(page, name); }
        catch { errors.push(`Could not revoke test key ${name} through the UI`); }
      }
      for (const account of [...accounts].reverse()) {
        try { await removeAccount(page, account); }
        catch { errors.push(`Could not remove test account ${account.username} through the UI`); }
      }
      const remaining = await call(page.request, 'get', panelPath);
      expect(remaining.status()).toBe(200);
      const keys = (await remaining.json()).data.keys;
      expect(keys.some((key) => key.name.startsWith(prefix) && !key.revokedAt)).toBe(false);
    } finally {
      await context.close();
      await machine?.dispose();
    }
    if (errors.length) throw new Error(errors.join('; '));
  });

  test('Owner creates a one-time key, the real host stores only its hash, and revocation stops machine access', async ({ page }) => {
    await login(page);
    const key = await createKey(page);
    const secret = /^ypk_[a-f0-9]{12}_([A-Za-z0-9_-]{43})$/.exec(key.token)[1];
    const persisted = persistedKey(key.id);
    expect(persisted.exists && !persisted.plaintextFields && !persisted.revoked).toBe(true);
    expect(persisted.hash === createHash('sha256').update(secret).digest('hex')).toBe(true);
    const listed = await call(page.request, 'get', panelPath);
    expect(listed.status()).toBe(200);
    expect(listed.headers()['cache-control']).toContain('no-store');
    expect((await listed.text()).includes(key.token)).toBe(false);
    const headers = { authorization: `Bearer ${key.token}` };
    const identity = await call(machine, 'get', '/api/automation/whoami', { headers });
    expect(identity.status()).toBe(200);
    expect((await identity.json()).data.scope).toEqual({ parentDomain: scope, portMin: 32000, portMax: 32009 });
    expect((await call(machine, 'get', panelPath, { headers })).status()).toBe(401);
    expect((await call(machine, 'get', '/api/automation/whoami', { headers: { ...headers, origin: baseURL } })).status()).toBe(403);
    expect((await call(page.request, 'get', '/api/automation/whoami', { headers })).status()).toBe(403);
    expect((await call(page.request, 'delete', `${panelPath}/${key.id}`, { headers: { origin: baseURL } })).status()).toBe(403);
    expect((await call(machine, 'get', '/api/automation/whoami', { headers })).status()).toBe(200);
    await keySection(page).getByRole('button', { name: 'Kapat', exact: true }).click();
    await page.reload();
    await expect(keySection(page).getByRole('button', { name: 'Anahtar oluştur', exact: true })).toBeVisible();
    await expect(page.locator('.ws-secret')).toHaveCount(0);
    await revokeKey(page, key.name);
    expect((await call(machine, 'get', '/api/automation/whoami', { headers })).status()).toBe(401);
    expect(persistedKey(key.id).revoked).toBe(true);
  });

  test('required fields and port limits use real DOM validation; invalid domains and reversed ranges return 400', async ({ page }) => {
    await login(page);
    await openKeys(page);
    const section = keySection(page);
    const form = section.locator('form');
    expect(await form.evaluate((element) => element.checkValidity())).toBe(false);
    await section.getByLabel('Ad', { exact: true }).fill(`${prefix}-invalid`);
    await section.getByLabel('Üst alan adı', { exact: true }).fill(scope);
    await section.getByLabel('İlk port', { exact: true }).fill('80');
    expect(await section.getByLabel('İlk port', { exact: true }).evaluate((input) => input.validity.rangeUnderflow)).toBe(true);
    await section.getByLabel('İlk port', { exact: true }).fill('32000');
    await section.getByLabel('Son port', { exact: true }).fill('65536');
    expect(await section.getByLabel('Son port', { exact: true }).evaluate((input) => input.validity.rangeOverflow)).toBe(true);
    await section.getByLabel('Son port', { exact: true }).fill('32009');
    await section.getByLabel('Üst alan adı', { exact: true }).fill('localhost');
    let pending = page.waitForResponse(isResponse(panelPath, 'POST'));
    await section.getByRole('button', { name: 'Anahtar oluştur', exact: true }).click();
    let response = await pending;
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_api_key_domain');
    await expect(section.locator('.ws-error, [role="alert"]').first()).toBeVisible();
    await section.getByLabel('Üst alan adı', { exact: true }).fill(scope);
    await section.getByLabel('İlk port', { exact: true }).fill('32999');
    await section.getByLabel('Son port', { exact: true }).fill('32000');
    pending = page.waitForResponse(isResponse(panelPath, 'POST'));
    await section.getByRole('button', { name: 'Anahtar oluştur', exact: true }).click();
    response = await pending;
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('invalid_api_key_ports');
    await expect(section.getByLabel('Ad', { exact: true })).toHaveValue(`${prefix}-invalid`);
    const keys = (await (await call(page.request, 'get', panelPath)).json()).data.keys;
    expect(keys.some((key) => key.name === `${prefix}-invalid`)).toBe(false);
    expect((await call(machine, 'get', '/api/automation/whoami')).status()).toBe(401);
  });

  test('real Customer and Reseller sessions cannot list, create or revoke Owner API keys', async ({ page, browser }) => {
    await login(page);
    const key = await createKey(page, `${prefix}-rbac`);
    for (const kind of ['customer', 'reseller']) {
      const account = await createAccount(page, kind);
      const restrictedContext = await browser.newContext({ baseURL, ignoreHTTPSErrors: false });
      restrictedContext.setDefaultTimeout(15_000);
      try {
        const restricted = await restrictedContext.newPage();
        await login(restricted, account.username, account.password);
        const sessionResponse = await call(restricted.request, 'get', '/api/auth/session');
        expect(sessionResponse.status()).toBe(200);
        expect((await sessionResponse.json()).data.user.id === account.id).toBe(true);
        const headers = await mutationHeaders(restricted);
        expect((await call(restricted.request, 'get', panelPath)).status()).toBe(403);
        expect((await call(restricted.request, 'post', panelPath, { headers, data: { ...definition, name: `${prefix}-${kind}-denied` } })).status()).toBe(403);
        expect((await call(restricted.request, 'delete', `${panelPath}/${key.id}`, { headers })).status()).toBe(403);
        await restricted.goto('/settings?section=api');
        await expect(restricted.getByRole('button', { name: 'Anahtar oluştur', exact: true })).toHaveCount(0);
        expect((await call(machine, 'get', '/api/automation/whoami', { headers: { authorization: `Bearer ${key.token}` } })).status()).toBe(200);
      } finally { await restrictedContext.close(); }
    }
    await revokeKey(page, key.name);
    expect((await call(machine, 'get', '/api/automation/whoami', { headers: { authorization: `Bearer ${key.token}` } })).status()).toBe(401);
  });
});
