import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createServer as createViteServer } from 'vite';
import { createAuthenticatedApi } from '../../api/src/auth-http.js';
import { createAuthStore } from '../../api/src/auth-store.js';
import { createDomainRegistry } from '../../api/src/domain-registry.js';
import { createMailDomainRegistry } from '../../api/src/mail-domain-registry.js';
import { createMailboxRegistry } from '../../api/src/mailbox-registry.js';
import { createApp } from '../../api/src/management-app.js';
import { createOwnerMfaPolicy } from '../../api/src/owner-mfa-policy.js';
import { createServerRegistry } from '../../api/src/server-registry.js';
import { createWebsiteRegistry } from '../../api/src/website-registry.js';
import {
  applyMailConfiguration,
  clearMailboxForwarding,
  clearMailboxQuota,
  createMailAlias,
  createMailbox,
  getMailConnectionSettings,
  getMailDeliveryDiagnostics,
  getMailDiagnostics,
  getMailDkim,
  getMailDomainDeliveryLogs,
  getMailDomainQueue,
  getMailboxConnectionSettings,
  getMailboxDeliveryDiagnostics,
  getServerMailConnectionSettings,
  getServerMailDeliveryDiagnostics,
  listMailDomains,
  listMailboxes,
  previewMailConfiguration,
  rotateMailboxPassword,
  sendMailDomainTestDelivery,
  sendMailboxTestDelivery,
  sendServerMailTestDelivery,
  setMailboxEnabled,
  setMailboxForwarding,
  setMailboxQuota,
} from '../src/workspace/mail-client.js';
import { setSession } from '../src/session-client.js';

const ok = (data) => new Response(JSON.stringify({ data }), { status: 200 });

test('managed mail client uses same-origin panel routes and exact guarded payloads', async (t) => {
  setSession({ csrfToken: 'csrf-mail' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({});
  });
  const domainId = 'mail-domain-1';
  const mailboxId = 'mailbox-1';
  await listMailDomains();
  await listMailboxes(domainId);
  await createMailbox({ mailDomainId: domainId, address: 'user@example.test', password: 'secret-pass' });
  await setMailboxEnabled(mailboxId, { expectedRevision: 2, enabled: false });
  await rotateMailboxPassword(mailboxId, { expectedRevision: 3, password: 'next-pass' });
  await setMailboxQuota(mailboxId, { expectedRevision: 0, quotaBytes: 1024 * 1024 });
  await clearMailboxQuota(mailboxId, { expectedRevision: 1 });
  await setMailboxForwarding(mailboxId, { expectedRevision: 0, mode: 'copy', destinations: ['other@example.test'], enabled: true });
  await clearMailboxForwarding(mailboxId, { expectedRevision: 1 });
  await createMailAlias({ mailDomainId: domainId, source: 'sales@example.test', destinations: ['user@example.test'] });
  await getMailDiagnostics(domainId);
  await getMailDkim(domainId);
  await previewMailConfiguration(domainId, { expectedRevision: 4, status: 'enabled' });
  await applyMailConfiguration(domainId, {
    expectedRevision: 4,
    status: 'enabled',
    preview: {
      previewDigest: 'a'.repeat(64),
      configuration: { sha256: 'b'.repeat(64) },
      confirmation: 'apply-mail-config:mail-domain-1',
    },
  });

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['/api/panel/mail-domains', 'GET'],
    ['/api/panel/mailboxes?mailDomainId=mail-domain-1', 'GET'],
    ['/api/panel/mailboxes', 'POST'],
    ['/api/panel/mailboxes/mailbox-1', 'PATCH'],
    ['/api/panel/mailboxes/mailbox-1/password', 'POST'],
    ['/api/panel/mailboxes/mailbox-1/quota', 'PUT'],
    ['/api/panel/mailboxes/mailbox-1/quota', 'DELETE'],
    ['/api/panel/mailboxes/mailbox-1/forwarding', 'PUT'],
    ['/api/panel/mailboxes/mailbox-1/forwarding', 'DELETE'],
    ['/api/panel/mail-aliases', 'POST'],
    ['/api/panel/mail-domains/mail-domain-1/diagnostics', 'GET'],
    ['/api/panel/mail-domains/mail-domain-1/dkim', 'GET'],
    ['/api/panel/mail-domains/mail-domain-1/config-preview', 'POST'],
    ['/api/panel/mail-domains/mail-domain-1/config-apply', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[6].options.body), {
    expectedRevision: 1,
    confirmation: 'clear-mailbox-quota:mailbox-1',
  });
  assert.deepEqual(JSON.parse(calls[8].options.body), {
    expectedRevision: 1,
    confirmation: 'clear-mailbox-forwarding:mailbox-1',
  });
  assert.deepEqual(JSON.parse(calls[13].options.body), {
    expectedRevision: 4,
    status: 'enabled',
    previewDigest: 'a'.repeat(64),
    configurationSha256: 'b'.repeat(64),
    confirmation: 'apply-mail-config:mail-domain-1',
  });
  for (const call of calls.filter(({ options }) => options.method !== 'GET')) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-mail');
  }
  setSession(null);
});

test('managed mail client rejects unsafe revisions and incomplete mutation inputs before fetch', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return ok({}); });
  assert.throws(() => setMailboxEnabled('mailbox-1', { expectedRevision: 0, enabled: true }), /expectedRevision is invalid/);
  assert.throws(() => setMailboxQuota('mailbox-1', { expectedRevision: 0, quotaBytes: 0 }), /quotaBytes is invalid/);
  assert.throws(() => setMailboxForwarding('mailbox-1', { expectedRevision: 0, mode: 'invalid', destinations: ['a@example.test'] }), /forwarding mode is invalid/);
  assert.throws(() => createMailAlias({ mailDomainId: 'domain-1', source: '', destinations: [] }), /mail alias input is invalid/);
  assert.throws(() => applyMailConfiguration('domain-1', { expectedRevision: 1, status: 'enabled', preview: {} }), /preview is required/);
  assert.throws(() => sendMailDomainTestDelivery('domain-1', { recipient: '' }), /recipient is required/);
  assert.throws(() => sendMailboxTestDelivery('mailbox-1', { recipient: '' }), /recipient is required/);
  assert.throws(() => sendServerMailTestDelivery('server-1', { recipient: '' }), /recipient is required/);
  assert.equal(calls, 0);
});

test('managed mail delivery diagnostics client routes and payloads', async (t) => {
  setSession({ csrfToken: 'csrf-diag' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return ok({});
  });
  const domainId = 'domain-xyz';
  const mailboxId = 'mailbox-abc';
  const serverId = 'server-local';

  await getMailDeliveryDiagnostics(domainId);
  await getMailConnectionSettings(domainId);
  await getMailDomainQueue(domainId, { limit: 50, search: 'user' });
  await getMailDomainDeliveryLogs(domainId, { limit: 100, search: 'postfix' });
  await sendMailDomainTestDelivery(domainId, { recipient: 'test@example.com', subject: 'Ping' });
  await getMailboxDeliveryDiagnostics(mailboxId);
  await getMailboxConnectionSettings(mailboxId);
  await sendMailboxTestDelivery(mailboxId, { recipient: 'inbox@example.com', subject: 'Hello' });
  await getServerMailDeliveryDiagnostics(serverId);
  await getServerMailConnectionSettings(serverId);
  await sendServerMailTestDelivery(serverId, { sender: 'postmaster@example.com', recipient: 'admin@example.com', subject: 'Server Test' });

  assert.deepEqual(calls.map(({ url, options }) => [url, options.method]), [
    ['/api/panel/mail-domains/domain-xyz/delivery-diagnostics', 'GET'],
    ['/api/panel/mail-domains/domain-xyz/connection-settings', 'GET'],
    // The server reads the search term from q; search= was silently ignored (fixed 2026-10-27).
    ['/api/panel/mail-domains/domain-xyz/queue?limit=50&q=user', 'GET'],
    ['/api/panel/mail-domains/domain-xyz/delivery-logs?limit=100&q=postfix', 'GET'],
    ['/api/panel/mail-domains/domain-xyz/test-delivery', 'POST'],
    ['/api/panel/mailboxes/mailbox-abc/delivery-diagnostics', 'GET'],
    ['/api/panel/mailboxes/mailbox-abc/connection-settings', 'GET'],
    ['/api/panel/mailboxes/mailbox-abc/test-delivery', 'POST'],
    ['/api/panel/servers/server-local/mail/delivery-diagnostics', 'GET'],
    ['/api/panel/servers/server-local/mail/connection-settings', 'GET'],
    ['/api/panel/servers/server-local/mail/test-delivery', 'POST'],
  ]);
  assert.deepEqual(JSON.parse(calls[4].options.body), { recipient: 'test@example.com', subject: 'Ping' });
  assert.deepEqual(JSON.parse(calls[7].options.body), { recipient: 'inbox@example.com', subject: 'Hello' });
  assert.deepEqual(JSON.parse(calls[10].options.body), { sender: 'postmaster@example.com', recipient: 'admin@example.com', subject: 'Server Test' });
  for (const call of calls.filter(({ options }) => options.method !== 'GET')) {
    assert.equal(call.options.headers['x-csrf-token'], 'csrf-diag');
  }
  setSession(null);
});

test('Owner can load, revise and clear mailbox delivery settings in Chromium', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'yunpanel-mail-policy-browser-'));
  const masterKey = randomBytes(32);
  const store = createAuthStore({ filePath: path.join(directory, 'auth.sqlite'), masterKey });
  let browser, server, vite;
  t.after(async () => {
    await browser?.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await vite?.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const registry = createServerRegistry({ filePath: path.join(directory, 'servers.json') });
  const local = await registry.createLocalServer({ hostname: 'mail-policy.example.test' });
  const serverExists = async id => Boolean(await registry.getServer(id));
  const websiteRegistry = createWebsiteRegistry({ filePath: path.join(directory, 'websites.json'), serverExists });
  const website = await websiteRegistry.createWebsite({
    name: 'Mail policy', serverId: local.id, runtimeType: 'proxy', proxyTarget: { host: '127.0.0.1', port: 8500 },
  });
  const domainRegistry = createDomainRegistry({
    filePath: path.join(directory, 'domains.json'), serverExists, getWebsite: websiteRegistry.getWebsite,
  });
  const webDomain = await domainRegistry.createDomain({
    serverId: local.id, websiteId: website.id, primaryDomain: 'mail-policy.example.test',
    targetType: 'proxy', target: { upstreamPort: 8500 },
  });
  const mailDomainRegistry = createMailDomainRegistry({
    filePath: path.join(directory, 'mail-domains.json'), getWebDomain: domainRegistry.getDomain,
  });
  const domain = await mailDomainRegistry.createMailDomain({
    domainName: webDomain.primaryDomain, webDomainId: webDomain.id, managementMode: 'local',
  });
  await mailDomainRegistry.transitionLocalStatus(domain.id, { expectedRevision: domain.revision, status: 'enabled' });
  const mailboxOptions = { filePath: path.join(directory, 'mailboxes.json'), masterKey, getMailDomain: mailDomainRegistry.getMailDomain };
  const mailboxRegistry = createMailboxRegistry(mailboxOptions);
  const password = randomBytes(24).toString('hex');
  const mailbox = await mailboxRegistry.createMailbox({
    mailDomainId: domain.id, address: `owner@${domain.domainName}`, password,
  });
  const setup = store.issueSetupToken();
  await store.completeSetup({ setupToken: setup.token, username: 'owner', password });
  const owner = await store.login({ username: 'owner', password });
  await store.users.create(owner.token, createOwnerMfaPolicy({ store, required: false }).requireManagement, {
    username: 'siteuser', password, role: 'site_manager', websiteIds: [website.id],
  });

  vite = await createViteServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  let api;
  server = createServer((request, response) => {
    if (request.url.startsWith('/api/')) return api(request, response);
    return vite.middlewares(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  api = createAuthenticatedApi({ store, publicOrigin: origin, development: true, ownerMfaRequired: false,
    createHandler: () => createApp({ registry, websiteRegistry, domainRegistry, mailDomainRegistry, mailboxRegistry, localServerId: local.id }),
  });

  browser = await chromium.launch();
  const endpoint = `${origin}/mail/${domain.id}`;
  async function signIn(page, username) {
    await page.goto(endpoint);
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  }
  const page = await browser.newPage();
  await signIn(page, 'owner');
  const settings = page.getByRole('button', { name: 'Posta kutusu ayarları', exact: true });
  await settings.click();
  await expect(page.getByRole('button', { name: 'Kotayı kaydet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yönlendirmeyi kaydet' })).toBeVisible();
  const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Otomatik yanıt ve spam ayarları' }) });
  const vacation = section.getByRole('checkbox', { name: 'Otomatik yanıtı etkinleştir' });
  const allowed = section.getByRole('textbox', { name: 'Güvenilen gönderenler' });
  const denied = section.getByRole('textbox', { name: 'Şüpheli gönderenler' });
  await expect(vacation).not.toBeChecked();
  await expect(allowed).toHaveValue('');
  await expect(denied).toHaveValue('');
  await allowed.fill('first@sender.example.test');
  await mailboxRegistry.rotatePassword(mailbox.id, { expectedRevision: 1, password: randomBytes(24).toString('hex') });

  const nextWrite = () => page.waitForResponse(response => response.url().endsWith(`/mailboxes/${mailbox.id}/delivery-policy`)
    && response.request().method() === 'PUT');
  const save = section.getByRole('button', { name: 'Ayarları kaydet' });
  const stale = nextWrite();
  await save.click();
  assert.equal((await stale).status(), 409);
  await expect(section.getByRole('alert')).toContainText('güncel ayarları yükleyin');
  await expect(save).toBeDisabled();
  await section.getByRole('button', { name: 'Güncel ayarları yükle' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ayarları yükle' }).click();
  await expect(allowed).toHaveValue('');

  await vacation.check();
  await section.getByRole('textbox', { name: 'Yanıt konusu' }).fill('Ofis dışında');
  await section.getByRole('textbox', { name: 'Yanıt metni' }).fill('Dönünce yanıtlayacağım.');
  await allowed.fill('first@sender.example.test');
  await denied.fill('second@sender.example.test');
  const saved = nextWrite();
  const preview = page.waitForResponse(response => response.url().endsWith(`/mail-domains/${domain.id}/config-preview`));
  await save.click();
  assert.equal((await saved).status(), 200);
  assert.equal((await preview).status(), 200);
  const expected = {
    mailboxId: mailbox.id, revision: 3, vacation: { subject: 'Ofis dışında', body: 'Dönünce yanıtlayacağım.' },
    allow: ['first@sender.example.test'], deny: ['second@sender.example.test'],
  };
  assert.deepEqual(await createMailboxRegistry(mailboxOptions).getDeliveryPolicy(mailbox.id), expected);
  await expect(section.getByText('Teslimat ayarları kaydedildi.')).toHaveCount(0);

  await settings.click();
  await expect(section).toHaveCount(0);
  await settings.click();
  await expect(section.getByRole('textbox', { name: 'Yanıt konusu' })).toHaveValue(expected.vacation.subject);
  await expect(allowed).toHaveValue(expected.allow[0]);
  await expect(denied).toHaveValue(expected.deny[0]);
  await section.getByRole('button', { name: 'Ayarları temizle' }).click();
  const cleared = nextWrite();
  await page.getByRole('dialog').getByRole('button', { name: 'Ayarları temizle' }).click();
  assert.equal((await cleared).status(), 200);
  assert.deepEqual(await createMailboxRegistry(mailboxOptions).getDeliveryPolicy(mailbox.id), {
    mailboxId: mailbox.id, revision: 4, vacation: null, allow: [], deny: [],
  });
  await settings.click();

  const siteUser = await browser.newPage();
  await signIn(siteUser, 'siteuser');
  await siteUser.getByRole('button', { name: 'Kota ve yönlendirme' }).click();
  await expect(siteUser.getByRole('heading', { name: 'Otomatik yanıt ve spam ayarları' })).toHaveCount(0);
});
