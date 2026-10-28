import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { OWNER_USERNAME, OWNER_PASSWORD } from '../helpers.js';

const owner = JSON.parse(fs.readFileSync('.local/yunpanel-owner-password-only.json', 'utf8'));
const origin = new URL(owner.url).origin;
process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';
test.use({ baseURL: origin, trace: 'off', screenshot: 'off', video: 'off' });

function generateCertificate(hostname) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yunpanel-tls03-'));
  try {
    const certificatePath = path.join(directory, 'cert.pem');
    const keyPath = path.join(directory, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`,
      '-keyout', keyPath, '-out', certificatePath], { stdio: 'pipe' });
    return { certificatePem: fs.readFileSync(certificatePath, 'utf8'),
      privateKeyPem: fs.readFileSync(keyPath, 'utf8'), chainPem: '' };
  } catch { throw new Error('Isolated certificate generation failed'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test.describe.serial('TLS-03 isolated custom certificate lifecycle', () => {
  test.setTimeout(180_000);
  const prefix = `ttls03-codex-${Date.now().toString(36)}`;
  const resources = [];
  let primary;
  let sentinel;
  let sentinelEvidence;
  let sshAlias;

  function saveReceipt() {
    const directory = '.local/manuel-test/TLS-03';
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, `${prefix}.json`), JSON.stringify({ resources }, null, 2), { mode: 0o600 });
  }

  async function login(page) {
    await page.goto('/');
    const session = page.locator('.auth-sessionbar');
    const form = page.locator('form.auth-form');
    await expect(session.or(form)).toBeVisible({ timeout: 30_000 });
    if (await session.isVisible()) { await expect(session).toContainText(OWNER_USERNAME); return; }
    await form.locator('[name="username"]').fill(OWNER_USERNAME);
    try { await form.locator('[name="password"]').fill(OWNER_PASSWORD); }
    catch { throw new Error('Owner password field could not be filled'); }
    await form.locator('button.auth-primary').click();
    await expect(session).toContainText(OWNER_USERNAME, { timeout: 30_000 });
  }

  async function call(page, method, endpoint, data) {
    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
    const csrf = (await session.json()).data.csrfToken;
    try {
      return await page.request.fetch(endpoint, { method, ...(data === undefined ? {} : { data }),
        headers: { Origin: origin, 'x-csrf-token': csrf } });
    } catch { throw new Error(`Live certificate ${method} request failed before a response`); }
  }

  async function publish(page, resource) {
    for (const action of ['stage', 'activate']) {
      const response = await call(page, 'POST', `/api/panel/domains/${resource.domainId}/${action}`, {});
      expect(response.status()).toBe(202);
      const job = (await response.json()).data;
      await expect.poll(async () => {
        const result = await page.request.get(`/api/panel/jobs/${job.id}`);
        expect(result.status()).toBe(200);
        const current = (await result.json()).data;
        if (['failed', 'cancelled'].includes(current.status)) throw new Error('Owned domain publication failed');
        return current.status;
      }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toBe('succeeded');
    }
  }

  async function createSite(page, suffix) {
    const hostname = `${prefix}-${suffix}.157-180-11-28.sslip.io`;
    await page.goto('/websites/new');
    await expect(page.getByRole('heading', { name: 'Web sitesi ekle', exact: true })).toBeVisible();
    await page.getByLabel('Alan adı', { exact: true }).fill(hostname);
    await page.getByLabel('www davranışı').selectOption('none');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await page.getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('external');
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
    const mail = page.getByRole('checkbox', { name: /E-posta ve Webmail/ });
    if (await mail.count()) await mail.uncheck();
    const creation = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/panel/sites');
    await page.getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
    const createdResponse = await creation;
    expect(createdResponse.status()).toBe(201);
    const created = (await createdResponse.json()).data;
    const resource = { hostname, domainId: created.primaryDomain.id, websiteId: created.website.id, certificateId: null };
    resources.push(resource);
    saveReceipt();
    const result = page.locator('.ws-site-create-result');
    await expect(result).toBeVisible({ timeout: 90_000 });
    const link = result.locator('a[href^="/websites/"]').first();
    await expect(link).toBeVisible({ timeout: 90_000 });
    const domainId = (await link.getAttribute('href')).match(/\/websites\/([^/?#]+)/)?.[1];
    expect(domainId).toBeTruthy();
    const response = await page.request.get(`/api/panel/domains/${domainId}`);
    expect(response.status()).toBe(200);
    const domain = (await response.json()).data;
    expect(domain.primaryDomain).toBe(hostname);
    expect(domainId).toBe(resource.domainId);
    expect(domain.websiteId).toBe(resource.websiteId);
    await expect.poll(async () => {
      const response = await page.request.get(`/api/panel/domains/${domainId}`);
      return (await response.json()).data.state;
    }, { timeout: 90_000 }).toBe('active');
    return resource;
  }

  function physicalEvidence(resource) {
    expect(resources.includes(resource)).toBe(true);
    expect(resource.certificateId).toMatch(/^[a-f0-9-]{36}$/);
    const code = `import os,json,hashlib,stat,sys
root='/var/lib/yunpanel/control-plane/custom-certificates/'+sys.argv[1]
files=[]
for name in ['cert.pem','fullchain.pem','privkey.pem']:
 p=os.path.join(root,name); info=os.stat(p)
 files.append({'name':name,'mode':format(stat.S_IMODE(info.st_mode),'04o'),'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest()})
print(json.dumps({'files':files,'routingPresent':os.path.isfile('/etc/nginx/sites-enabled/yunpanel-'+sys.argv[2]+'.conf')}))`;
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    try {
      return JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias,
        `python3 -c ${quote(code)} ${quote(resource.certificateId)} ${quote(resource.hostname)}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }));
    } catch { throw new Error('Owned certificate physical metadata inspection failed'); }
  }

  async function installCertificate(page, resource) {
    const changes = { httpsMode: 'managed', httpsRedirect: false };
    const updateResponse = await call(page, 'POST', `/api/panel/domains/${resource.domainId}/update-preview`, { changes });
    expect(updateResponse.status()).toBe(200);
    const update = (await updateResponse.json()).data;
    const updated = await call(page, 'PATCH', `/api/panel/domains/${resource.domainId}`, {
      changes, previewDigest: update.previewDigest, confirmation: update.confirmation,
    });
    expect(updated.status()).toBe(200);
    const material = generateCertificate(resource.hostname);
    const response = await call(page, 'POST', `/api/panel/domains/${resource.domainId}/certificates/custom-preview`, material);
    expect(response.status()).toBe(200);
    const preview = (await response.json()).data;
    expect(preview.operation).toBe('custom_certificate_import');
    expect(preview.certificate.source).toBe('custom');
    expect(preview.certificate.domains).toContain(resource.hostname);
    expect(preview.previewDigest).toMatch(/^[a-f0-9]{64}$/);
    const applied = await call(page, 'POST', `/api/panel/domains/${resource.domainId}/certificates/custom`, {
      ...material, previewDigest: preview.previewDigest, confirmation: preview.confirmation,
    });
    expect(applied.status()).toBe(201);
    const certificate = (await applied.json()).data.certificate;
    resource.certificateId = certificate.id;
    saveReceipt();
    expect(certificate.source).toBe('custom');
    expect(certificate.state).toBe('active');
    await publish(page, resource);
    const evidence = physicalEvidence(resource);
    expect(evidence.files.map(file => file.name)).toEqual(['cert.pem', 'fullchain.pem', 'privkey.pem']);
    expect(evidence.files.every(file => file.mode === '0600')).toBe(true);
    expect(evidence.files.find(file => file.name === 'cert.pem').sha256
      === createHash('sha256').update(material.certificatePem).digest('hex')).toBe(true);
    expect(evidence.routingPresent).toBe(true);
    return evidence;
  }

  async function removeSite(page, resource) {
    expect(resources.includes(resource)).toBe(true);
    const existing = await page.request.get(`/api/panel/domains/${resource.domainId}`);
    if (existing.status() === 404) return;
    expect(existing.status()).toBe(200);
    expect((await existing.json()).data.primaryDomain).toBe(resource.hostname);
    await page.goto(`/websites/${resource.domainId}/settings`);
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Siteyi sil', exact: true }) });
    await expect(section.getByRole('button', { name: 'Siteyi sil…', exact: true })).toBeVisible({ timeout: 30_000 });
    await section.getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Siteyi kalıcı olarak sil', exact: true }) });
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill(resource.hostname);
    await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click();
    await expect(section.getByText('Site silindi', { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect.poll(async () => (await page.request.get(`/api/panel/domains/${resource.domainId}`)).status()).toBe(404);
    expect((await page.request.get(`/api/panel/websites/${resource.websiteId}`)).status()).toBe(404);
    if (resource.certificateId) {
      const certificate = await page.request.get(`/api/panel/certificates/${resource.certificateId}`);
      expect(certificate.status()).toBe(200);
      expect((await certificate.json()).data.state).toBe('retired');
    }
    resource.removed = true;
    saveReceipt();
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    const env = Object.fromEntries(fs.readFileSync('.local/test-server.env', 'utf8').split('\n')
      .filter(line => /^[A-Z_]+=/.test(line)).map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }));
    sshAlias = env.YUNPANEL_TEST_SERVER_SSH_ALIAS;
    const resolved = execFileSync('ssh', ['-G', sshAlias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(resolved.match(/^hostname (.+)$/m)?.[1] === env.YUNPANEL_TEST_SERVER_HOST
      && env.YUNPANEL_TEST_SERVER_HOST.endsWith('.28')).toBe(true);
    const page = await browser.newPage();
    try {
      await login(page);
      primary = await createSite(page, 'main');
      sentinel = await createSite(page, 'other');
      sentinelEvidence = await installCertificate(page, sentinel);
    } finally { await page.close(); }
  });
  test.beforeEach(async ({ page }) => { await login(page); });
  test.afterAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const page = await browser.newPage();
    const errors = [];
    try {
      await login(page);
      for (const resource of resources) {
        try { await removeSite(page, resource); }
        catch { errors.push(resource.hostname); }
      }
    } finally { await page.close(); }
    expect(errors, 'Only owned resources must be removed through the panel; no registry or host fallback').toEqual([]);
  });

  test('custom certificate import, exact material hashes, inventory and UI', async ({ page }) => {
    await installCertificate(page, primary);
    const response = await page.request.get(`/api/panel/certificates/${primary.certificateId}`);
    expect(response.status()).toBe(200);
    const certificate = (await response.json()).data;
    expect(certificate.source).toBe('custom');
    expect(certificate.state).toBe('active');
    expect(certificate.domains).toContain(primary.hostname);
    await page.goto(`/websites/${primary.domainId}/ssl`);
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'SSL sertifikası', exact: true }) });
    await expect(section).toBeVisible();
    await expect(section.locator('dd', { hasText: primary.hostname }).first()).toBeVisible();
  });
  test('a mismatched private key is rejected with 409', async ({ page }) => {
    const valid = generateCertificate(primary.hostname);
    const other = generateCertificate('different.example.test');
    const response = await call(page, 'POST', `/api/panel/domains/${primary.domainId}/certificates/custom-preview`, {
      ...valid, privateKeyPem: other.privateKeyPem,
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('certificate_private_key_mismatch');
  });
  test('a certificate for another hostname is rejected with 409', async ({ page }) => {
    const response = await call(page, 'POST', `/api/panel/domains/${primary.domainId}/certificates/custom-preview`, generateCertificate('different.example.test'));
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('certificate_domain_mismatch');
  });
  test('CSR creation wizard', async ({ page }) => {
    await page.goto(`/websites/${primary.domainId}/ssl`);
    await expect(page.getByRole('heading', { name: 'SSL sertifikası', exact: true })).toBeVisible();
    test.fail(true, 'TLS-03: CSR creation UI is missing');
    await expect(page.locator('button:has-text("CSR"), a:has-text("CSR"), button:has-text("İstek oluştur")')).toBeVisible();
  });
  test('certificate, private key and CA chain upload form', async ({ page }) => {
    await page.goto(`/websites/${primary.domainId}/ssl`);
    await expect(page.getByRole('heading', { name: 'SSL sertifikası', exact: true })).toBeVisible();
    test.fail(true, 'TLS-03: Custom certificate upload UI is missing');
    await expect(page.locator('textarea[name="certificatePem"], input[type="file"][accept*=".crt"], textarea[placeholder*="BEGIN CERTIFICATE"]')).toBeVisible();
  });
  test('server certificate inventory screen', async ({ page }) => {
    await page.goto('/ssl');
    await expect(page.locator('#workspace-main')).toBeVisible();
    test.fail(true, 'TLS-03: Server certificate repository UI is missing');
    await expect(page.locator('th:has-text("Geçerlilik"), th:has-text("Veren"), th:has-text("Issuer"), th:has-text("Parmak İzi")')).toBeVisible();
  });
  test('removing one owned site preserves the other site and certificate material', async ({ page }) => {
    await removeSite(page, primary);
    expect(physicalEvidence(primary).routingPresent).toBe(false);
    const domain = await page.request.get(`/api/panel/domains/${sentinel.domainId}`);
    expect(domain.status()).toBe(200);
    expect((await domain.json()).data.primaryDomain).toBe(sentinel.hostname);
    expect((await page.request.get(`/api/panel/websites/${sentinel.websiteId}`)).status()).toBe(200);
    const certificate = await page.request.get(`/api/panel/certificates/${sentinel.certificateId}`);
    expect(certificate.status()).toBe(200);
    expect((await certificate.json()).data.state).toBe('active');
    expect(physicalEvidence(sentinel)).toEqual(sentinelEvidence);
  });
});
