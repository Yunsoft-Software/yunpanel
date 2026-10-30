import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

const owner = JSON.parse(readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const baseURL = new URL(owner.url).origin;
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL, trace: 'off', screenshot: 'off', video: 'off', actionTimeout: 15_000, navigationTimeout: 30_000 });

test.describe.serial('DNS-04 isolated DNSSEC lifecycle and preserved foreign history', () => {
  test.setTimeout(240_000);
  const prefix = `tdns04-acodex-${Date.now().toString(36)}`;
  const hostname = `${prefix}.webrich.news`;
  const owned = [];
  let baseline;
  let rootSite;
  let childSite;
  let sshAlias;

  async function login(page) {
    await page.goto('/');
    const bar = page.locator('.auth-sessionbar');
    const form = page.locator('form.auth-form');
    await expect(bar.or(form)).toBeVisible({ timeout: 30_000 });
    if (await bar.isVisible()) {
      await expect(bar).toContainText(OWNER_USERNAME);
      return;
    }
    await form.locator('[name="username"]').fill(OWNER_USERNAME);
    try { await form.locator('[name="password"]').fill(OWNER_PASSWORD); }
    catch { throw new Error('Owner secret input failed'); }
    await form.locator('button.auth-primary').click();
    await expect(bar).toContainText(OWNER_USERNAME, { timeout: 30_000 });
  }

  async function call(page, method, path, data) {
    try {
      const session = await page.request.get('/api/auth/session');
      const token = (await session.json()).data?.csrfToken;
      const response = await page.request.fetch(`/api/panel${path}`, {
        method,
        headers: { origin: baseURL, ...(method === 'GET' ? {} : { 'x-csrf-token': token }) },
        ...(data === undefined ? {} : { data }),
      });
      return { status: response.status(), body: await response.json().catch(() => null) };
    } catch { throw new Error(`Live ${method} request failed before a response`); }
  }

  // SSH performs metadata reads only: no PowerDNS mutation, registry edit or service restart.
  function physical(site = null) {
    const code = `import hashlib,json,subprocess,sys,os
cfg=json.load(sys.stdin)
p='/var/lib/yunpanel/control-plane/dnssec-operations.json'
state=json.load(open(p)) if os.path.isfile(p) else {'operations':[]}
ops=state.get('operations',[]) if isinstance(state,dict) else state
foreign={o['id']:hashlib.sha256(json.dumps(o,sort_keys=True,separators=(',',':')).encode()).hexdigest() for o in ops if o.get('domainId') not in cfg['ownedDomainIds']}
existing=subprocess.run(['pdnsutil','show-zone','webrich.news'],capture_output=True,text=True)
result={'foreignOperations':foreign,'existingZoneDigest':hashlib.sha256(existing.stdout.encode()).hexdigest(),'existingZoneStatus':existing.returncode}
if cfg.get('hostname'):
 shown=subprocess.run(['pdnsutil','show-zone',cfg['hostname']],capture_output=True,text=True)
 answer=subprocess.run(['dig','@127.0.0.1','DNSKEY',cfg['hostname'],'+noall','+answer'],capture_output=True,text=True)
 result.update({'zoneExists':shown.returncode==0,'signed':('Zone is actively secured' in shown.stdout or 'Zone has NSEC' in shown.stdout),'hasDnskey':'DNSKEY' in answer.stdout})
print(json.dumps(result))`;
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    try {
      return JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias, `python3 -c ${quote(code)}`], {
        input: JSON.stringify({ ownedDomainIds: owned.map((item) => item.domainId), hostname: site?.hostname ?? null }),
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000,
      }));
    } catch { throw new Error('Read-only DNSSEC host inspection failed'); }
  }

  function foreignUnchanged() {
    const after = physical();
    expect(after.existingZoneStatus).toBe(baseline.existingZoneStatus);
    expect(after.existingZoneDigest).toBe(baseline.existingZoneDigest);
    for (const [id, digest] of Object.entries(baseline.foreignOperations)) {
      expect(after.foreignOperations[id], 'Existing DNSSEC history must remain unchanged').toBe(digest);
    }
  }

  async function createSite(page, parent = null) {
    const name = parent ? `child.${hostname}` : hostname;
    await page.goto(parent ? `/websites/new?parent=${parent.domainId}` : '/websites/new');
    if (parent) await page.getByLabel('Alt alan adı', { exact: true }).fill('child');
    else await page.getByLabel('Alan adı', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('local');
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
    const mail = page.getByRole('checkbox', { name: /E-posta ve Webmail etkinleştir/ });
    if (await mail.count()) await mail.uncheck();
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/panel/sites'
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
    const response = await responsePromise;
    const result = (await response.json()).data;
    if (result?.primaryDomain?.id && result?.website?.id) {
      const site = { domainId: result.primaryDomain.id, websiteId: result.website.id, hostname: result.primaryDomain.primaryDomain };
      owned.push(site);
      expect(site.hostname).toBe(name);
      expect(result.primaryDomain.parentDomainId ?? null).toBe(parent?.domainId ?? null);
    }
    expect(response.status()).toBe(201);
    const created = owned.find((site) => site.hostname === name);
    expect(created).toBeDefined();
    await expect(page.locator('.ws-site-create-result')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı.', { timeout: 120_000 });
    return created;
  }

  async function openDns(page) {
    await page.goto(`/websites/${rootSite.domainId}/dns`);
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'DNSSEC', exact: true }) });
    await expect(section).toBeVisible();
    return section;
  }

  async function changeSigning(page, enabled) {
    const section = await openDns(page);
    await section.getByRole('button', { name: enabled ? 'DNSSEC’i aç' : 'DNSSEC’i kapat', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ hasText: enabled ? 'DNSSEC signing aç' : 'DNSSEC signing kapat' });
    await expect(dialog).toBeVisible();
    const confirmation = (await dialog.locator('label strong').innerText()).trim();
    await dialog.locator('input').fill(confirmation);
    await dialog.locator('button[type="submit"]').click();
    await expect(dialog).toBeHidden({ timeout: 45_000 });
    await expect(section.locator('dt', { hasText: 'Local signing' }).locator('..')).toContainText(enabled ? 'Açık' : 'Kapalı', { timeout: 45_000 });
    return section;
  }

  async function removeSite(page, site) {
    expect(site.hostname === hostname || site.hostname === `child.${hostname}`).toBe(true);
    const existing = await call(page, 'GET', `/websites/${site.websiteId}`);
    if (existing.status === 404) return;
    expect(existing.status).toBe(200);
    const preview = await call(page, 'POST', `/websites/${site.websiteId}/removal-preview`, {});
    expect(preview.status).toBe(200);
    expect(preview.body.data.readyToStart).toBe(true);
    const started = await call(page, 'POST', `/websites/${site.websiteId}/removal`, {
      previewDigest: preview.body.data.previewDigest, confirmation: preview.body.data.confirmation,
    });
    expect(started.status).toBe(201);
    const operationId = started.body.data.id;
    await expect.poll(async () => {
      const result = await call(page, 'GET', `/website-removal-operations/${operationId}`);
      expect(result.status).toBe(200);
      const operation = result.body.data;
      if (operation.status === 'removed') return 'removed';
      if (['failed', 'blocked'].includes(operation.status)) throw new Error('Owned site removal is blocked: ' + (operation.error?.code ?? operation.status));
      const run = await call(page, 'POST', `/website-removal-operations/${operationId}/run`, {
        expectedUpdatedAt: operation.updatedAt,
        confirmation: `run-website-remove:${site.websiteId}:${operationId}:${operation.updatedAt}`,
      });
      expect([202, 409]).toContain(run.status);
      if (run.status === 409) expect(['website_removal_busy', 'website_removal_execution_stale']).toContain(run.body?.error?.code);
      return run.body?.data?.status ?? operation.status;
    }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toBe('removed');
    expect((await call(page, 'GET', `/websites/${site.websiteId}`)).status).toBe(404);
    expect((await call(page, 'GET', `/domains/${site.domainId}`)).status).toBe(404);
  }

  test.beforeAll(() => {
    const config = Object.fromEntries(readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
    sshAlias = config.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    const resolved = execFileSync('ssh', ['-G', sshAlias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(resolved.match(/^hostname (.+)$/m)?.[1] === config.YUNPANEL_TEST_SERVER_HOST && config.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')).toBe(true);
    baseline = physical();
    expect(baseline.existingZoneStatus).toBe(0);
  });
  test.beforeEach(async ({ page }) => login(page));
  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL });
    try {
      await login(page);
      if (rootSite && physical(rootSite).signed) await changeSigning(page, false);
      for (const site of [...owned].reverse()) await removeSite(page, site);
      for (const site of owned) expect(physical(site).zoneExists).toBe(false);
      foreignUnchanged();
    } finally { await page.close(); }
  });

  test('owned root zone: UI signing, physical DNSKEY/DS and safe disable preserve foreign history', async ({ page }) => {
    rootSite = await createSite(page);
    expect(physical(rootSite).signed).toBe(false);
    const section = await changeSigning(page, true);
    await expect(section.locator('.dns-ds-box code').first()).toContainText(/^\d+\s+\d+\s+\d+\s+[A-Fa-f0-9]+$/);
    expect(physical(rootSite).signed).toBe(true);
    // PowerDNS may answer from its query cache for a short TTL after signing is enabled.
    await expect.poll(() => physical(rootSite).hasDnskey, { timeout: 120_000, intervals: [5_000] }).toBe(true);
    await changeSigning(page, false);
    expect(physical(rootSite).signed).toBe(false);
    foreignUnchanged();
  });

  test('owned child has no independent DNSSEC; malformed and unknown inputs are rejected', async ({ page }) => {
    expect(rootSite).toBeDefined();
    childSite = await createSite(page, rootSite);
    await page.goto(`/websites/${childSite.domainId}/dns`);
    await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'DNSSEC', exact: true }) })).toHaveCount(0);
    const child = await call(page, 'POST', `/domains/${childSite.domainId}/dns/dnssec/preview`, { enabled: true });
    expect(child.status).toBe(409);
    expect(child.body.error.code).toBe('dnssec_root_domain_required');
    const malformed = await call(page, 'POST', `/domains/${rootSite.domainId}/dns/dnssec/preview`, { enabled: 'yes' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('dnssec_preview_input_invalid');
    expect((await call(page, 'GET', '/domains/00000000-0000-4000-8000-000000000000/dns/dnssec')).status).toBe(404);
    foreignUnchanged();
  });

  test('owned root exposes a key rollover action', async ({ page }) => {
    expect(rootSite).toBeDefined();
    const section = await openDns(page);
    await expect(section.getByRole('button', { name: 'DNSSEC’i aç', exact: true })).toBeVisible();
    test.fail(true, 'BULGU DNS-04: DNSSEC key rollover action is absent from the panel');
    await expect(section.getByRole('button', { name: /Rollover|Anahtar yenile|Roll Over Keys/ })).toBeVisible();
  });
});
