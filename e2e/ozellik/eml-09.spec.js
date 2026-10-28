import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

const owner = JSON.parse(readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const origin = new URL(owner.url).origin;
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL: origin, trace: 'off', screenshot: 'off', video: 'off' });

test.describe.serial('EML-09 isolated DKIM and mail security', () => {
  test.setTimeout(360_000);
  const prefix = `teml09-acodex-${Date.now().toString(36)}`;
  const sites = [];
  let context, page, sshAlias, foreignKeys, guardKey;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const section = (title) => page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const modal = (title) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

  // Host inspection returns digests/permissions, never private key bytes.
  function hostRead(code, args = []) {
    try {
      return JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias,
        `python3 -c ${quote(code)} ${args.map(quote).join(' ')}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
      }));
    } catch { throw new Error('Read-only test-host inspection failed'); }
  }

  function keySnapshot(excluded = []) {
    return hostRead(`import os,sys,json,hashlib,stat
root='/var/lib/yunpanel/control-plane/mail-dkim'
excluded=set(json.loads(sys.argv[1])); result={}
for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
 if name in excluded: continue
 directory=os.path.join(root,name)
 if not os.path.isdir(directory) or os.path.islink(directory): continue
 files={}
 for filename in ['metadata.json','private.pem']:
  p=os.path.join(directory,filename)
  if os.path.isfile(p):
   info=os.stat(p)
   files[filename]={'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest(),'mode':stat.S_IMODE(info.st_mode),'uid':info.st_uid,'gid':info.st_gid}
 result[name]=files
print(json.dumps(result))`, [JSON.stringify(excluded)]);
  }

  async function call(method, path, data) {
    try {
      const session = await page.request.get('/api/auth/session');
      expect(session.status()).toBe(200);
      const csrf = (await session.json()).data.csrfToken;
      return await page.request.fetch(`/api/panel${path}`, { method, data, headers: { Origin: origin, 'x-csrf-token': csrf } });
    } catch { throw new Error(`Live panel ${method} request failed before a usable response`); }
  }

  async function login() {
    await page.goto('/');
    const form = page.locator('form.auth-form');
    const bar = page.locator('.auth-sessionbar');
    await expect(form.or(bar)).toBeVisible({ timeout: 30_000 });
    if (await form.isVisible()) {
      await form.locator('[name="username"]').fill(OWNER_USERNAME);
      try { await form.locator('[name="password"]').fill(OWNER_PASSWORD); }
      catch { throw new Error('Owner password field could not be filled'); }
      await form.locator('button.auth-primary').click();
    }
    await expect(bar).toContainText(OWNER_USERNAME, { timeout: 30_000 });
  }

  async function createSite(suffix) {
    const hostname = `${prefix}-${suffix}.webrich.news`;
    await page.goto('/websites/new');
    await page.getByPlaceholder('example.com', { exact: true }).fill(hostname);
    await page.getByLabel('www davranışı').selectOption('none');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('local');
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('managed');
    await page.getByLabel(/E-posta ve Webmail etkinleştir/).check();
    const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/panel/sites'
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const result = (await response.json()).data;
    const site = { hostname, domainId: result.primaryDomain.id, websiteId: result.website.id, operationId: result.operationId };
    sites.push(site);
    await expect(page.locator('.ws-site-create-result')).toBeVisible({ timeout: 30_000 });
    let lastUpdate = null;
    let idlePolls = 0;
    await expect.poll(async () => {
      // Provisioning reloads Nginx, which can drop a request. The result page then stops
      // advancing and leaves "Devam et" to the user, so a stalled run is continued the same way.
      try {
        const response = await page.request.get(`/api/panel/sites/provisioning/${site.operationId}`);
        expect(response.status()).toBe(200);
        const operation = (await response.json()).data;
        if (operation.ready) return true;
        idlePolls = operation.updatedAt === lastUpdate ? idlePolls + 1 : 0;
        lastUpdate = operation.updatedAt;
        if (idlePolls >= 3) {
          idlePolls = 0;
          await call('POST', `/sites/provisioning/${site.operationId}/continue`,
            { confirmation: `continue-site-provisioning:${site.operationId}` });
        }
      } catch (error) {
        if (!/socket hang up|ECONNRESET|failed before a usable response/.test(String(error?.message))) throw error;
      }
      return false;
    }, { timeout: 240_000, intervals: [3_000], message: 'Owned mail site provisioning must complete' }).toBe(true);
    const responseMail = await page.request.get('/api/panel/mail-domains');
    expect(responseMail.status()).toBe(200);
    const payload = (await responseMail.json()).data;
    const mail = (payload.mailDomains ?? payload).find((entry) => entry.webDomainId === site.domainId);
    expect(mail?.domainName).toBe(hostname);
    site.mailDomainId = mail.id;
    return site;
  }

  async function removeSite(site) {
    if (site.removed) return;
    expect(site.hostname.startsWith(prefix + '-')).toBe(true);
    const current = await page.request.get(`/api/panel/domains/${site.domainId}`);
    if (current.status() === 404) { site.removed = true; return; }
    expect(current.status()).toBe(200);
    expect((await current.json()).data.primaryDomain).toBe(site.hostname);
    await page.goto(`/websites/${site.domainId}/settings`);
    await page.getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
    const dialog = modal('Siteyi kalıcı olarak sil');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill(site.hostname);
    await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click();
    await expect(page.getByText('Site silindi', { exact: true })).toBeVisible({ timeout: 120_000 });
    expect((await page.request.get(`/api/panel/domains/${site.domainId}`)).status()).toBe(404);
    if (site.mailDomainId) expect((await page.request.get(`/api/panel/mail-domains/${site.mailDomainId}`)).status()).toBe(404);
    site.removed = true;
  }

  async function openDkim(site) {
    await page.goto(`/mail/${site.mailDomainId}?section=security`);
    await expect(section('DKIM')).toBeVisible();
    await expect(section('DKIM').locator('dt').filter({ hasText: /^Selector$/ })).toBeVisible({ timeout: 30_000 });
    return section('DKIM');
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
        const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^['"]|['"]$/g, '')];
      }));
    sshAlias = config.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    const resolved = execFileSync('ssh', ['-G', sshAlias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST
      && config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')).toBe(true);
    foreignKeys = keySnapshot();
    context = await browser.newContext({ baseURL: origin, ignoreHTTPSErrors: false });
    page = await context.newPage();
    await login();
    await createSite('guard');
    guardKey = keySnapshot()[sites[0].mailDomainId];
    expect(guardKey?.['private.pem']?.mode).toBe(0o600);
    await createSite('target');
  });

  test.afterAll(async () => {
    test.setTimeout(420_000);
    const failures = [];
    if (page) {
      for (const site of [...sites].reverse()) {
        try { await login(); await removeSite(site); }
        catch { failures.push(`Owned site cleanup incomplete: ${site.domainId}`); }
      }
      try {
        await page.goto('/');
        await page.locator('.auth-sessionbar').getByRole('button', { name: 'Çıkış yap', exact: true }).click();
      } catch { failures.push('Owner test session logout failed'); }
    }
    if (foreignKeys) {
      try { expect(keySnapshot(sites.map((site) => site.mailDomainId).filter(Boolean))).toEqual(foreignKeys); }
      catch { failures.push('Unrelated DKIM material changed'); }
    }
    await context?.close();
    expect(failures, 'Owned cleanup and unrelated-key preservation must both succeed').toEqual([]);
  });

  test('site wizard creates isolated DKIM keys, DNS records and relay-safe configuration', async () => {
    const target = sites[1];
    const dkim = await openDkim(target);
    // The wizard derives a per-operation selector (yp- + 24 hex) instead of a shared "mail".
    const selectorCell = dkim.locator('dt').filter({ hasText: /^Selector$/ }).locator('+ dd');
    await expect(selectorCell).toHaveText(/^yp-[a-f0-9]{24}$/);
    const selector = (await selectorCell.innerText()).trim();
    await expect(dkim.locator('dt').filter({ hasText: /^Algoritma$/ }).locator('+ dd')).toHaveText('rsa-sha256');
    await expect(dkim.locator('dt').filter({ hasText: /^DNS adı$/ }).locator('+ dd')).toContainText(`${selector}._domainkey.${target.hostname}`);
    await expect(dkim.locator('dt').filter({ hasText: /^DNS değer$/ }).locator('+ dd')).toContainText('v=DKIM1');
    await dkim.getByRole('button', { name: 'Signing preview', exact: true }).click();
    await expect(dkim.locator('dt').filter({ hasText: /^Preview digest$/ }).locator('+ dd')).toHaveText(/^[a-f0-9]{64}$/);
    const key = keySnapshot()[target.mailDomainId];
    expect(key?.['private.pem']?.mode).toBe(0o600);
    expect(key?.['metadata.json']?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(keySnapshot()[sites[0].mailDomainId]).toEqual(guardKey);
    const physical = hostRead(`import subprocess,json,sys
host=sys.argv[1]
def run(args): return subprocess.check_output(args,text=True).strip()
spf=run(['dig','@127.0.0.1','TXT',host,'+short'])
dmarc=run(['dig','@127.0.0.1','TXT','_dmarc.'+host,'+short'])
mx=run(['dig','@127.0.0.1','MX',host,'+short'])
relay=run(['postconf','-h','smtpd_relay_restrictions'])
auth=run(['postconf','-h','smtpd_sasl_auth_enable'])
submission=run(['postconf','-P','submission/inet/smtpd_relay_restrictions','submission/inet/smtpd_sasl_auth_enable'])
print(json.dumps({'spf':spf,'dmarc':dmarc,'mxPresent':bool(mx),'relaySafe':'reject_unauth_destination' in relay,'anonymousSmtpAuthDisabled':auth=='no','submissionAuthRequired':'permit_sasl_authenticated,reject' in submission and 'smtpd_sasl_auth_enable=yes' in submission}))`, [target.hostname]);
    expect(physical.spf).toContain('v=spf1');
    expect(physical.dmarc).toContain('v=DMARC1');
    expect(physical.mxPresent).toBe(true);
    expect(physical.relaySafe).toBe(true);
    expect(physical.anonymousSmtpAuthDisabled).toBe(true);
    expect(physical.submissionAuthRequired).toBe(true);
  });

  test('invalid selectors, missing input, anonymous writes and CSRF do not replace a key', async ({ playwright }) => {
    const target = sites[1];
    const before = keySnapshot()[target.mailDomainId];
    const bad = await call('POST', `/mail-domains/${target.mailDomainId}/dkim`, { expectedRevision: 0, selector: 'INVALID_SELECTOR_$$!' });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('invalid_mail_dkim_selector');
    expect((await call('POST', `/mail-domains/${target.mailDomainId}/dkim`, {})).status()).toBe(400);
    expect((await call('POST', '/mail-domains/00000000-0000-0000-0000-000000000000/dkim', { expectedRevision: 0, selector: 'mail' })).status()).toBe(404);
    const missingCsrf = await page.request.post(`/api/panel/mail-domains/${target.mailDomainId}/dkim`, {
      headers: { Origin: origin }, data: { expectedRevision: 0, selector: 'mail' },
    });
    expect(missingCsrf.status()).toBe(403);
    const anonymous = await playwright.request.newContext({ baseURL: origin });
    try {
      expect((await anonymous.post(`/api/panel/mail-domains/${target.mailDomainId}/dkim`, {
        headers: { Origin: origin }, data: { expectedRevision: 0, selector: 'mail' },
      })).status()).toBe(401);
    } finally { await anonymous.dispose(); }
    expect(keySnapshot()[target.mailDomainId]).toEqual(before);
    expect(keySnapshot()[sites[0].mailDomainId]).toEqual(guardKey);
  });

  test('delivery diagnostics display real SPF, DKIM, DMARC and connection settings', async () => {
    await openDkim(sites[1]);
    await expect(section('DNS Teslimat Gereksinimleri')).toBeVisible({ timeout: 20_000 });
    await expect(section('İstemci Bağlantı Bilgileri')).toBeVisible();
    await expect(section('DNS Teslimat Gereksinimleri').locator('dt').filter({ hasText: /^SPF Kaydı$/ }).locator('+ dd')).toContainText('Geçerli');
    await expect(section('DNS Teslimat Gereksinimleri').locator('dt').filter({ hasText: /^DMARC Kaydı$/ }).locator('+ dd')).toContainText('Geçerli');
  });

  test('smarthost rejects malformed input without changing global relay settings', async () => {
    const domainResponse = await page.request.get(`/api/panel/domains/${sites[1].domainId}`);
    expect(domainResponse.status()).toBe(200);
    const serverId = (await domainResponse.json()).data.serverId;
    const endpoint = `/servers/${serverId}/mail/smarthost`;
    const before = await call('GET', endpoint);
    expect(before.status()).toBe(200);
    const beforeData = (await before.json()).data;
    const invalid = await call('PUT', endpoint, { host: 'invalid host!', port: 587, username: '', password: '', confirmation: 'smarthost-apply' });
    expect(invalid.status()).toBe(400);
    const after = await call('GET', endpoint);
    expect(after.status()).toBe(200);
    expect((await after.json()).data).toEqual(beforeData);
  });

  test('removing one owned mail site preserves the other real DKIM key', async () => {
    await removeSite(sites[1]);
    expect(keySnapshot()[sites[0].mailDomainId]).toEqual(guardKey);
    const guard = await page.request.get(`/api/panel/mail-domains/${sites[0].mailDomainId}/dkim`);
    expect(guard.status()).toBe(200);
    expect((await guard.json()).data.selector).toMatch(/^yp-[a-f0-9]{24}$/);
    expect(keySnapshot(sites.map((site) => site.mailDomainId))).toEqual(foreignKeys);
  });
});
