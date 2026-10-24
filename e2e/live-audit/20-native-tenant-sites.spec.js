import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '@playwright/test';
import { elFinderFpmPoolPath, elFinderFpmSocketPath, nginxConfigFileName } from '@yunpanel/config-templates';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { test, expect, manifest, saveManifest, apiCall, safeApi, waitJob, ready, main, ORIGIN, RUN_DIR, auditNetworkOptions } from './support.js';

const ACCOUNTS = '/api/panel/users/hosting/accounts';
const SECRET_PATH = path.join(RUN_DIR, 'tenant-site-secrets.json');
async function candidateUi(context) {
  const dist = path.resolve('apps/web/dist');
  await context.route(url => url.origin === ORIGIN && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/tools/'), async route => {
    const url = new URL(route.request().url()), file = route.request().isNavigationRequest() ? path.join(dist, 'index.html') : path.join(dist, url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.continue();
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
    return route.fulfill({ body: fs.readFileSync(file), contentType, headers: { 'Cache-Control': 'no-store' } });
  });
}
test.beforeEach(async ({ context }) => candidateUi(context));
function state() {
  const m = manifest();
  if (!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA ?? '') || m.target !== '157.180.11.28') throw new Error('Exact authorized native candidate required');
  return m.fixture.tenantSites;
}
function update(change) { const m = manifest(); change(m.fixture.tenantSites); saveManifest(m); }
function record(action, proof) { const m = manifest(); m.fixture.operations.push({ action, ...proof, at: new Date().toISOString() }); saveManifest(m); }
function secret(key) { return JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8'))[key]; }
async function inspectOwnedFiles() {
  const sites = state().sites;
  for (const key of ['a', 'b', 'direct']) ownedSite(key);
  const script = `python3 - <<'PY'
from pathlib import Path
import pwd,json
sites=json.loads(${JSON.stringify(JSON.stringify(sites))})
checks=[]
for key,t in sites.items():
 root=Path('/var/www/yunpanel/apps')/t['applicationId']
 assert t['documentRoot']==str(root/'current')
 user=pwd.getpwnam(t['unixUser']);assert user.pw_uid>0
 current=(root/'current').resolve(strict=True)
 assert any(current.is_relative_to(Path(base)/t['applicationId']) for base in ['/var/www/yunpanel/apps','/var/lib/yunpanel/apps'])
 assert (current/'index.html').stat().st_uid==user.pw_uid
 checks.append({'websiteId':t['websiteId'],'unixUid':user.pw_uid,'resolvedRoot':str(current),'contentOwnedBySiteUser':True})
assert len(checks)==3 and len({c['unixUid'] for c in checks})==3
print(json.dumps({'verified':True,'sites':checks}))
PY`;
  let result;
  try { result = await promisify(execFile)('python3', [path.resolve('.local/acceptance-candidate/host-control.py'), script], { timeout: 55000, maxBuffer: 4096 }); }
  catch { throw new Error('Exact owned site physical ownership inspection failed; access details withheld'); }
  const proof = JSON.parse(result.stdout.trim()); expect(proof.verified).toBe(true);
  update(s => { for (const check of proof.sites) Object.assign(Object.values(s.sites).find(t => t.websiteId === check.websiteId), check); });
  record('tenant.physical-file-ownership', proof);
}
async function inspectRemovedOwnedSites() {
  const m = manifest();
  const targets = ['a', 'b', 'direct'].map(key => {
    const target = state().sites[key];
    if (!target?.removed || !m.fixture.createdWebsiteIds.includes(target.websiteId)
      || !m.fixture.createdDomainIds.includes(target.domainId)
      || !/^yp-role-(?:a|b|direct)-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(target.hostname)
      || !/^yunapp-[a-f0-9]{12}$/.test(target.unixUser ?? '')) throw new Error('Exact removed owned tenant site required');
    const contract = createWebsitePathContract(target);
    return { websiteId: target.websiteId, unixUser: target.unixUser,
      paths: [contract.runtime.applicationRoot, contract.workspace.homeDirectory,
        contract.static.buildRoot, contract.static.publishRoot, elFinderFpmPoolPath(target.unixUser),
        elFinderFpmSocketPath(target.unixUser), '/etc/nginx/sites-enabled/yunpanel-' + nginxConfigFileName(target.hostname)] };
  });
  const script = `python3 - <<'PY'
import os,pwd,grp,json
targets=json.loads(${JSON.stringify(JSON.stringify(targets))})
assert len(targets)==3 and len({t['unixUser'] for t in targets})==3
for t in targets:
 assert all(not os.path.lexists(p) for p in t['paths'])
 try: pwd.getpwnam(t['unixUser'])
 except KeyError: pass
 else: raise AssertionError('Owned Unix user remains')
 try: grp.getgrnam(t['unixUser'])
 except KeyError: pass
 else: raise AssertionError('Owned Unix group remains')
print(json.dumps({'verified':True,'siteCount':len(targets),'rootsAndFileManagerAndNginxAbsent':True,'unixUsersAndGroupsAbsent':True}))
PY`;
  let result;
  try { result = await promisify(execFile)('python3', [path.resolve('.local/acceptance-candidate/host-control.py'), script], { timeout: 55000, maxBuffer: 4096 }); }
  catch { throw new Error('Exact owned tenant physical removal inspection failed; access details withheld'); }
  const proof = JSON.parse(result.stdout.trim()); expect(proof.verified).toBe(true);
  update(s => { s.physicalCleanupAccepted = true; });
  record('tenant.physical-site-cleanup', proof);
}
function ownedSite(key) {
  const m = manifest(), target = state().sites[key];
  if (!target || target.removed || !m.fixture.createdWebsiteIds.includes(target.websiteId)
    || !m.fixture.createdDomainIds.includes(target.domainId) || !/^yp-role-(?:a|b|direct)-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(target.hostname)) throw new Error('Recorded owned tenant site required');
  return target;
}
async function createAccount(liveApi, key, kind, extra = {}) {
  if (state().accounts[key]) return state().accounts[key];
  const credentials = secret(key);
  // No retry of a create request. Its unique username and private credentials
  // are persisted before submission so a lost response can be inspected.
  const result = await apiCall(liveApi.api, liveApi.csrf, 'POST', ACCOUNTS + '/create-login', { kind, ...credentials, ...extra });
  expect(result.status).toBe(201); const account = result.data.account;
  const m = manifest(); m.fixture.tenantSites.accounts[key] = { id: account.id, kind, username: credentials.username };
  m.fixture.createdUserIds.push(account.id); saveManifest(m); return state().accounts[key];
}
async function provision(page, liveApi, key, customer) {
  let target = state().sites[key];
  if (!target) {
    const hostname = 'yp-role-' + key + '-' + state().generation + '.157.180.11.28.sslip.io';
    await ready(page, '/websites/new?customer=' + customer.id);
    await page.getByLabel('Alan adı', { exact: true }).fill(hostname);
    await page.getByLabel('Site sahibi', { exact: true }).selectOption('customer');
    await page.getByRole('combobox', { name: 'Müşteri', exact: true }).selectOption(customer.id);
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
    await main(page).getByRole('button', { name: 'Devam et', exact: true }).click();
    await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
    await page.getByRole('checkbox', { name: /Otomatik E-Posta/ }).uncheck();
    const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/panel/sites/hosted' && r.request().method() === 'POST');
    await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click();
    const response = await pending; expect([200, 201]).toContain(response.status()); const created = (await response.json()).data;
    target = { hostname, websiteId: created.website.id, applicationId: created.website.applicationId, customerId: customer.id, provisioningOperationId: created.provisioning.operationId };
    const m = manifest(); m.fixture.tenantSites.sites[key] = target; m.fixture.createdWebsiteIds.push(target.websiteId); saveManifest(m);
    await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı', { timeout: 180000 });
  }
  const operation = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/sites/provisioning/' + target.provisioningOperationId);
  expect(operation.status).toBe(200); expect(operation.data.ready).toBe(true);
  const domains = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + target.websiteId + '/domains'); expect(domains.status).toBe(200);
  const domain = domains.data.find(item => item.primaryDomain === target.hostname); expect(domain.websiteId).toBe(target.websiteId);
  const website = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + target.websiteId); expect(website.status).toBe(200);
  const account = await apiCall(liveApi.api, liveApi.csrf, 'GET', ACCOUNTS + '/' + customer.id); expect(account.status).toBe(200);
  expect(account.data.websiteIds).toContain(target.websiteId); expect(website.data.unixUser).toMatch(/^yunapp-[a-f0-9]{12}$/);
  const m = manifest(); Object.assign(m.fixture.tenantSites.sites[key], { domainId: domain.id, unixUser: website.data.unixUser, documentRoot: website.data.documentRoot });
  if (!m.fixture.createdDomainIds.includes(domain.id)) m.fixture.createdDomainIds.push(domain.id); saveManifest(m);
  const marker = 'TENANT-' + key + '-' + state().generation;
  const uploaded = await liveApi.api.put('/api/panel/websites/' + target.websiteId + '/files/upload?path=index.html', {
    data: Buffer.from('<!doctype html><title>Owned tenant acceptance</title><h1>' + marker + '</h1>'),
    headers: { Origin: ORIGIN, 'x-csrf-token': liveApi.csrf, 'Content-Type': 'application/octet-stream' },
  }); expect([200, 201]).toContain(uploaded.status());
  const http = await liveApi.api.get('http://' + target.hostname + '/'); expect(http.status()).toBe(200); expect(await http.text()).toContain(marker);
  record('tenant.owned-site-provisioned', { websiteId: target.websiteId, customerId: customer.id, realHttpContent: true });
}
async function login(account, browser = null) {
  const key = Object.keys(state().accounts).find(key => state().accounts[key].id === account.id), credentials = secret(key);
  const api = safeApi(await request.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Origin: ORIGIN }, ...auditNetworkOptions() }));
  expect((await api.post('/api/auth/login', { data: credentials })).status()).toBe(200);
  const response = await api.get('/api/auth/session'); expect(response.status()).toBe(200);
  expect(response.headers()['x-yunpanel-acceptance-source']).toBe(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA);
  const session = (await response.json()).data; expect(session.user.hosting.kind).toBe(account.kind);
  const actor = { api, csrf: session.csrfToken };
  if (browser) { actor.context = await browser.newContext({ baseURL: ORIGIN, storageState: await api.storageState(), viewport: { width: 1440, height: 1000 }, ...auditNetworkOptions() }); await candidateUi(actor.context); }
  return actor;
}

test('@mutation source provisions distinct real Websites for two reseller customers and a direct customer through the normal form', async ({ page, liveApi }) => {
  test.setTimeout(360000); state();
  if (!manifest().fixture.tenantSites || state().cleaned) {
    const generation = manifest().runId + '-' + randomBytes(3).toString('hex'), credentials = {};
    for (const key of ['ra', 'rb', 'ca', 'cb', 'direct']) credentials[key] = { username: 'ypaudit-' + generation + '-' + key, password: randomBytes(28).toString('base64url') };
    fs.writeFileSync(SECRET_PATH, JSON.stringify(credentials), { mode: 0o600 }); fs.chmodSync(SECRET_PATH, 0o600);
    const m = manifest(); m.fixture.tenantSites = { generation, accounts: {}, sites: {}, cleaned: false }; saveManifest(m);
  }
  const ra = await createAccount(liveApi, 'ra', 'reseller', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const rb = await createAccount(liveApi, 'rb', 'reseller', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const ca = await createAccount(liveApi, 'ca', 'customer', { resellerId: ra.id });
  const cb = await createAccount(liveApi, 'cb', 'customer', { resellerId: rb.id });
  const direct = await createAccount(liveApi, 'direct', 'customer', { resellerId: null });
  for (const [key, customer] of [['a', ca], ['b', cb], ['direct', direct]]) await provision(page, liveApi, key, customer);
  expect(new Set(Object.values(state().sites).map(site => site.unixUser)).size).toBe(3);
  await inspectOwnedFiles();
  expect(page.auditErrors).toEqual([]); update(s => { s.provisioned = true; });
});

test('@mutation source real tenant site APIs, jobs and open terminals isolate A B and direct ownership and revoke the parent chain', async ({ browser, liveApi }) => {
  test.setTimeout(240000); expect(state().provisioned).toBe(true);
  const sites = { a: ownedSite('a'), b: ownedSite('b'), direct: ownedSite('direct') }, accounts = state().accounts, actors = [];
  const terminalChecks = [];
  try {
    for (const [key, siteKey] of [['ra', 'a'], ['rb', 'b'], ['ca', 'a'], ['cb', 'b'], ['direct', 'direct']]) {
      const actor = await login(accounts[key], browser); actors.push(actor); actor.key = key; actor.site = sites[siteKey];
      const list = await apiCall(actor.api, actor.csrf, 'GET', '/api/panel/websites'); expect(list.status).toBe(200);
      expect(list.data.map(item => item.id)).toEqual([actor.site.websiteId]);
      for (const [otherKey, target] of Object.entries(sites)) {
        const foreign = otherKey !== siteKey;
        const root = '/api/panel/websites/' + target.websiteId;
        const routes = [root, root + '/domains', root + '/files', root + '/crons', root + '/consumption', root + '/quotas', root + '/backup-set', root + '/backups',
          '/api/panel/servers/' + manifest().serverId + '/websites/' + target.websiteId + '/database-resources',
          '/api/panel/domains/' + target.domainId, '/api/panel/applications/' + target.applicationId];
        for (const endpoint of routes) {
          const result = await actor.api.get(endpoint); expect(foreign ? [403, 404] : [200], key + ' ' + endpoint).toContain(result.status());
        }
        const capability = await apiCall(actor.api, actor.csrf, 'POST', '/api/panel/terminal/capabilities', { scope: 'site', websiteId: target.websiteId });
        expect(capability.status).toBe(foreign ? 403 : 201);
        const handoff = await apiCall(actor.api, actor.csrf, 'POST', '/api/panel/servers/' + manifest().serverId + '/websites/' + target.websiteId + '/elfinder-handoffs', {});
        expect(handoff.status).toBe(foreign ? 403 : 201);
        if (foreign) expect((await apiCall(actor.api, actor.csrf, 'POST', '/api/panel/domains/' + target.domainId + '/stage', {})).status).toBe(403);
      }
      expect((await apiCall(actor.api, actor.csrf, 'POST', '/api/panel/terminal/capabilities', { scope: 'server', serverId: manifest().serverId })).status).toBe(403);
      record('tenant.site-http-scope', { userId: accounts[key].id, ownWebsiteId: actor.site.websiteId, foreignMetadataDenied: true, foreignJobsAndToolsDenied: true, rootTerminalDenied: true });
    }
    // Actual same-config stage/activate jobs establish ownership of the durable
    // work rather than treating a permission-only denial as native acceptance.
    const ca = actors.find(actor => actor.key === 'ca');
    let ownedJob;
    for (const action of ['stage', 'activate']) {
      const queued = await apiCall(ca.api, ca.csrf, 'POST', '/api/panel/domains/' + sites.a.domainId + '/' + action, {}); expect(queued.status).toBe(202);
      ownedJob = queued.data.id; expect((await waitJob(ca.api, ownedJob)).status).toBe('succeeded');
    }
    for (const actor of actors) expect((await actor.api.get('/api/panel/jobs/' + ownedJob)).status()).toBe(['ra', 'ca'].includes(actor.key) ? 200 : 403);
    for (const key of ['ra', 'ca', 'cb']) {
      const actor = actors.find(actor => actor.key === key), page = await actor.context.newPage();
      const check = { key, connected: false, closed: false, closeCode: null, identityObserved: false, outputObserved: false, actualUidAndCwdObserved: false };
      let proofOutput = '';
      terminalChecks.push(check);
      // Retain only proof booleans and the close code. WebSocket protocols,
      // capabilities, complete frames and terminal output never enter reports.
      page.on('websocket', socket => {
        if (new URL(socket.url()).pathname !== '/api/terminal') return;
        socket.on('framereceived', frame => {
          let message; try { message = JSON.parse(String(frame.payload)); } catch { return; }
          if (message.type === 'ready') check.identityObserved = message.target?.websiteId === actor.site.websiteId && message.target?.user === actor.site.unixUser;
          if (message.type === 'output') {
            proofOutput = (proofOutput + String(message.data)).slice(-4096);
            check.outputObserved = proofOutput.includes('TENANT-TERMINAL-' + key);
            check.actualUidAndCwdObserved = proofOutput.includes('UIDPROOF=' + actor.site.unixUid + '\r\n')
              && proofOutput.includes('CWDPROOF=' + actor.site.resolvedRoot + '\r\n');
          }
        });
        socket.on('close', () => { check.closed = true; });
      });
      await page.addInitScript(() => {
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(...args) { super(...args); this.addEventListener('close', event => { window.__tenantTerminalCloseCode = event.code; }); }
        };
      });
      await ready(page, '/websites/' + actor.site.domainId + '/terminal');
      await main(page).getByRole('button', { name: 'Terminali aç', exact: true }).click();
      await expect(main(page).getByRole('status').filter({ hasText: /^Bağlı$/ })).toBeVisible({ timeout: 20000 });
      expect(check.identityObserved).toBe(true); check.connected = true;
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type("printf 'UIDPROOF='; id -u; printf 'CWDPROOF='; pwd -P; printf 'TENANT-'; printf 'TERMINAL-" + key + "\\n'"); await page.keyboard.press('Enter');
      await expect.poll(() => check.outputObserved && check.actualUidAndCwdObserved, { timeout: 10000 }).toBe(true); check.page = page;
    }
    const parent = await apiCall(liveApi.api, liveApi.csrf, 'GET', ACCOUNTS + '/' + accounts.ra.id); expect(parent.status).toBe(200);
    expect((await apiCall(liveApi.api, liveApi.csrf, 'PATCH', ACCOUNTS + '/' + accounts.ra.id + '/status', { revision: parent.data.revision, active: false })).status).toBe(200);
    update(s => { s.parentDisabled = true; });
    for (const actor of actors) expect((await actor.api.get('/api/auth/session')).status()).toBe(['ra', 'ca'].includes(actor.key) ? 401 : 200);
    for (const check of terminalChecks) {
      if (check.key === 'cb') { expect(check.closed).toBe(false); continue; }
      await expect.poll(() => check.closed, { timeout: 20000 }).toBe(true);
      check.closeCode = await check.page.evaluate(() => window.__tenantTerminalCloseCode); expect(check.closeCode).toBe(4001);
    }
    for (const target of Object.values(sites)) expect((await liveApi.api.get('http://' + target.hostname + '/')).status()).toBe(200);
    record('tenant.site-and-terminal-parent-revoke', { verified: true, ownDurableJobId: ownedJob,
      terminals: terminalChecks.map(({ key, connected, closed, closeCode, identityObserved, outputObserved, actualUidAndCwdObserved }) => ({ key, connected, closed, closeCode, identityObserved, outputObserved, actualUidAndCwdObserved })),
      siblingAndDirectSessionsPreserved: true, sitesPreserved: true }); update(s => { s.scopeAccepted = true; });
  } finally { for (const actor of actors) { if (actor.context) await actor.context.close(); await actor.api.dispose(); } }
});

test('@mutation source cleans only the recorded three owned tenant sites through normal removal before deleting their account profiles', async ({ page, liveApi }) => {
  test.setTimeout(300000); expect(state().provisioned).toBe(true);
  for (const key of ['a', 'b', 'direct']) {
    if (state().sites[key].removed) continue;
    const target = ownedSite(key), root = '/api/panel/websites/' + target.websiteId;
    let operation;
    if (!target.removalOperationId) {
      await ready(page, '/websites/' + target.domainId + '/settings');
      await main(page).getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Siteyi kalıcı olarak sil' }); await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox').fill(target.hostname);
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === root + '/removal' && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click();
      const result = await pending; expect(result.status()).toBe(201); operation = (await result.json()).data;
      expect(operation.execution.mode).toBe('automatic'); update(s => { s.sites[key].removalOperationId = operation.id; });
    }
    const endpoint = '/api/panel/website-removal-operations/' + state().sites[key].removalOperationId;
    await expect.poll(async () => {
      let current;
      try { current = await apiCall(liveApi.api, liveApi.csrf, 'GET', endpoint); }
      catch (error) {
        // Nginx retirement can close a reused connection. Reconcile with the
        // same read-only journal endpoint; never replay the removal POST.
        if (/^API transport failed FETCH .*\(Error, socket hang up\)/.test(error.message)) return 'read-unavailable';
        throw error;
      }
      expect(current.status).toBe(200); operation = current.data;
      expect(['failed', 'blocked']).not.toContain(operation.status); return operation.status;
    }, { timeout: 90000, intervals: [500, 1000] }).toBe('removed');
    expect(operation.error).toBeNull();
    for (const [kind, id] of [['websites', target.websiteId], ['domains', target.domainId], ['applications', target.applicationId]]) expect((await liveApi.api.get('/api/panel/' + kind + '/' + id)).status()).toBe(404);
    update(s => { s.sites[key].removed = true; }); record('tenant.normal-site-removal', { websiteId: target.websiteId, operationId: operation.id, verifiedApiAbsence: true, physicalAbsencePending: true });
  }
  for (const key of ['ca', 'cb', 'direct', 'ra', 'rb']) {
    const account = state().accounts[key], current = await apiCall(liveApi.api, liveApi.csrf, 'GET', ACCOUNTS + '/' + account.id);
    if (current.status === 200) {
      expect(current.data.username).toBe(account.username); const revision = current.data.revision;
      expect((await apiCall(liveApi.api, liveApi.csrf, 'DELETE', ACCOUNTS + '/' + account.id + '/profile', { revision, confirmation: 'unregister-hosting-profile:' + account.id + ':' + revision })).status).toBe(200);
    } else expect(current.status).toBe(404);
    const users = await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/users?limit=100'); expect(users.status).toBe(200);
    const user = users.data.users.find(user => user.id === account.id);
    if (user) { expect(user.username).toBe(account.username); expect((await apiCall(liveApi.api, liveApi.csrf, 'DELETE', '/api/panel/users/' + user.id, { revision: user.revision })).status).toBe(200); }
    update(s => { s.accounts[key].removed = true; });
  }
  await inspectRemovedOwnedSites();
  expect((await liveApi.api.get('https://' + manifest().fixture.hostname + '/')).status()).toBe(200);
  update(s => { s.cleaned = true; }); record('tenant.fixture-cleanup', { verified: true, profilesAndUsersRemoved: true, primarySitePreserved: true, physicalSshAbsenceVerified: true });
});
