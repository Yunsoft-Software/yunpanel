import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { request } from '@playwright/test';
import { test, expect, apiContext, safeApi, ORIGIN, RUN_DIR, ready, main, auditNetworkOptions } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const ACCOUNTS = '/api/panel/users/hosting/accounts';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const keys = ['ra', 'rb', 'ca', 'cb', 'direct'];
const siteKeys = ['a', 'b', 'direct'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner, state, statePath, credentials, fixtures = {};
const actors = [];
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function record(kind, proof) { state.events.push({ kind, ...proof, at: new Date().toISOString() }); save(); }
async function call(actor, method, endpoint, data) {
  let response;
  for (let attempt = 0; ; attempt++) {
    try { response = await actor.api.fetch(endpoint, { method, data, maxRedirects: 0, headers: { Origin: ORIGIN, 'x-csrf-token': actor.csrf, Connection: 'close' }, timeout: 90000 }); }
    catch { if (method === 'GET' && attempt < 3) { await sleep(700); continue; } throw Object.assign(new Error('Tenant API transport failed: ' + method + ' ' + endpoint), { code: 'tenant_transport' }); }
    if (method === 'GET' && [502, 503, 504].includes(response.status()) && attempt < 3) { await sleep(700); continue; } break;
  }
  const body = await response.json().catch(() => ({})); return { status: response.status(), data: body.data ?? body, body };
}
function ok(result, label, allowed = [200]) { expect(allowed, label + ' ' + (result.body?.error?.code ?? '')).toContain(result.status); return result.data; }
async function findCreatedAccount(username) {
  for (const kind of ['reseller', 'customer']) {
    const rows = ok(await call(owner, 'GET', ACCOUNTS + '?kind=' + kind + '&limit=100'), 'Read owned account inventory');
    const found = rows.accounts.find(a => a.username === username); if (found) return found;
  }
  return null;
}
async function createAccount(key, kind, extra = {}) {
  const input = credentials[key]; state.accounts[key] = { username: input.username, kind, createSent: true }; save();
  let account;
  try { account = ok(await call(owner, 'POST', ACCOUNTS + '/create-login', { ...input, kind, ...extra }), 'Create owned ' + key, [201]).account; }
  catch (error) { if (error.code !== 'tenant_transport') throw error; account = await findCreatedAccount(input.username); if (!account) throw error; }
  expect(account.username).toBe(input.username); expect(account.id).toMatch(UUID); expect(state.baselineUserIds).not.toContain(account.id);
  state.accounts[key] = { id: account.id, username: input.username, kind }; save(); return account;
}
function owned(key) { const f = fixtures[key]; expect(f, 'An owned tenant fixture is required').toBeTruthy(); return f; }
function assertPhysicalGone(proof) {
  expect(proof.unixUserExists).toBe(false); expect(proof.unixGroupExists).toBe(false); expect(proof.roots).toHaveLength(4);
  expect(proof.roots.every(p => !p.exists)).toBe(true); expect(proof.fpmFiles).toEqual([]); expect(proof.sockets).toEqual([]);
  expect(proof.nginxFiles.length).toBeGreaterThan(0); expect(proof.nginxFiles.every(p => !p.exists)).toBe(true); expect(proof.mounts).toEqual([]);
}
async function cleanupSites() {
  const failures = [];
  for (const key of siteKeys) {
    if (!state.sites[key]) continue;
    try {
      const result = fixtures[key] ? await fixtures[key].cleanup() : await cleanupOwnedFixture(owner, { key: state.sites[key].key });
      const physical = readOnlyHostProbe({ ledger: result }, 'lifecycle-absence'); assertPhysicalGone(physical);
      state.sites[key].removed = true; state.sites[key].physicalAbsent = true; save();
    } catch (error) { failures.push({ key, message: String(error.message).split('\n')[0] }); }
  }
  return failures;
}
async function cleanupAccounts() {
  const failures = [];
  for (const key of ['ca', 'cb', 'direct', 'ra', 'rb']) {
    const account = state.accounts[key]; if (!account) continue;
    try {
      if (!account.id) { const found = await findCreatedAccount(account.username); if (found) account.id = found.id; }
      if (!account.id) continue;
      expect(state.baselineUserIds).not.toContain(account.id);
      const current = await call(owner, 'GET', ACCOUNTS + '/' + account.id);
      if (current.status === 200) {
        expect(current.data.username).toBe(account.username); expect(current.data.websiteIds ?? []).toEqual([]);
        const revision = current.data.revision;
        ok(await call(owner, 'DELETE', ACCOUNTS + '/' + account.id + '/profile', { revision, confirmation: `unregister-hosting-profile:${account.id}:${revision}` }), 'Remove owned hosting profile');
      } else expect(current.status).toBe(404);
      const users = ok(await call(owner, 'GET', '/api/panel/users?limit=100'), 'Read owned login cleanup');
      const user = users.users.find(u => u.id === account.id);
      if (user) { expect(user.username).toBe(account.username); ok(await call(owner, 'DELETE', '/api/panel/users/' + user.id, { revision: user.revision }), 'Remove owned login'); }
      expect((await call(owner, 'GET', ACCOUNTS + '/' + account.id)).status).toBe(404);
      const remaining = ok(await call(owner, 'GET', '/api/panel/users?limit=100'), 'Verify login absence');
      expect(remaining.users.some(u => u.id === account.id)).toBe(false); account.removed = true; save();
    } catch (error) { failures.push({ key, message: String(error.message).split('\n')[0] }); }
  }
  return failures;
}
async function login(key, browser) {
  const api = safeApi(await request.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: false, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { Origin: ORIGIN }, ...auditNetworkOptions() }));
  const actor = { key, api }; actors.push(actor);
  expect((await api.post('/api/auth/login', { data: credentials[key] })).status()).toBe(200);
  const session = await api.get('/api/auth/session'); expect(session.status()).toBe(200); const data = (await session.json()).data;
  expect(data.user.hosting.kind).toBe(state.accounts[key].kind); actor.csrf = data.csrfToken;
  actor.context = await browser.newContext({ baseURL: ORIGIN, ignoreHTTPSErrors: false, storageState: await api.storageState(), ...auditNetworkOptions() });
  return actor;
}
async function waitOwnedJob(actor, id) {
  expect(id).toMatch(UUID); const stop = Date.now() + 180000;
  while (Date.now() < stop) { const job = ok(await call(actor, 'GET', '/api/panel/jobs/' + id), 'Read owned tenant job'); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) { expect(job.status).toBe('succeeded'); return job; } await sleep(700); }
  throw new Error('Tenant-owned durable job did not finish');
}
async function provision(page, key, customerId, via = 'ui') {
  const fixtureKey = state.fixturePrefix + '-' + key; state.sites[key] = { key: fixtureKey, customerId }; save();
  const f = await createOwnedFixture(owner, { key: fixtureKey, runtime: 'static', create: async (input, _preview, recordInput) => {
    if (via === 'api') {
      recordInput(input);
      const preview = ok(await call(owner, 'POST', '/api/panel/sites/hosted/create-preview', { customerId, input }), 'Preview actual hosted tenant allocation');
      try { return ok(await call(owner, 'POST', '/api/panel/sites/hosted', { customerId, input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'Create actual hosted tenant site', [200, 201]); }
      catch (error) { if (error.code === 'tenant_transport') error.code = 'owned_fixture_transport'; throw error; }
    }
    const nativeErrors = [], responseReads = [];
    const observeResponse = response => { if (/\/sites\/provisioning\/[a-f0-9-]+\/continue$/.test(new URL(response.url()).pathname) && response.status() >= 400) responseReads.push(response.json().then(body => nativeErrors.push({ status: response.status(), code: /^[a-z0-9_]+$/.test(body.error?.code ?? '') ? body.error.code : 'unavailable' })).catch(() => {})); };
    page.on('response', observeResponse);
    const route = '**/api/panel/sites/hosted';
    const observe = async routed => { if (routed.request().method() === 'POST') { const body = routed.request().postDataJSON(); expect(body.customerId).toBe(customerId); recordInput(body.input); } await routed.continue(); };
    await page.route(route, observe);
    try {
      await ready(page, '/websites/new?customer=' + customerId);
      await page.getByLabel('Alan adı', { exact: true }).fill(input.primaryDomain);
      await page.getByLabel('Site sahibi', { exact: true }).selectOption('customer'); await page.getByRole('combobox', { name: 'Müşteri', exact: true }).selectOption(customerId);
      await page.locator('label').filter({ hasText: 'www davranışı' }).locator('select').selectOption('none');
      await main(page).getByRole('button', { name: 'Devam et', exact: true }).click(); await page.getByLabel('Site türü', { exact: true }).selectOption('new_static_upload');
      await main(page).getByRole('button', { name: 'Devam et', exact: true }).click(); await page.getByLabel('DNS yönetimi', { exact: true }).selectOption('external'); await page.getByLabel('Sertifika yönetimi', { exact: true }).selectOption('off');
      await page.getByRole('checkbox', { name: /Otomatik E-Posta|E-posta ve Webmail/ }).uncheck();
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === '/api/panel/sites/hosted' && r.request().method() === 'POST', { timeout: 180000 });
      await main(page).getByRole('button', { name: 'Siteyi oluştur', exact: true }).click(); const response = await pending; expect([200, 201]).toContain(response.status());
      const created = (await response.json()).data;
      try { await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı', { timeout: 180000 }); }
      catch (error) {
        await Promise.allSettled(responseReads);
        const operationId = created.provisioning?.operationId;
        const actual = UUID.test(operationId ?? '') ? await call(owner, 'GET', '/api/panel/sites/provisioning/' + operationId) : null;
        record('native-ui-provisioning-failure', { key, operationId, nativeErrors, backendReady: actual?.data?.ready === true, requiredStepsSucceeded: actual?.data?.steps?.filter(v => v.required).every(v => v.state === 'succeeded') === true, uiText: (await main(page).getByLabel('Site kurulum durumu').innerText()).slice(0, 2500) });
        throw error;
      }
      return created;
    } finally { await Promise.allSettled(responseReads); page.off('response', observeResponse); await page.unroute(route, observe); }
  } });
  fixtures[key] = f; const t = f.ledger;
  const account = ok(await call(owner, 'GET', ACCOUNTS + '/' + customerId), 'Verify tenant allocation'); expect(account.websiteIds).toContain(t.websiteId);
  const marker = 'T888-' + key + '-' + state.nonce; await f.upload('index.html', '<!doctype html><h1>' + marker + '</h1>');
  const actual = await f.http('/'); expect(actual.status).toBe(200); expect(actual.body).toContain(marker);
  const physical = readOnlyHostProbe(f, 'owned-site-files'); expect(physical.uid).toBeGreaterThan(0); expect(physical.indexFile.uid).toBe(physical.uid); expect(physical.currentSymlink).toBe(true);
  const application = ok(await call(owner, 'GET', '/api/panel/applications/' + t.applicationId), 'Read actual tenant release');
  expect(application.currentReleaseId).toMatch(UUID); expect(physical.currentLinkTarget).toBe('releases/' + application.currentReleaseId);
  Object.assign(state.sites[key], t, { marker, unixUid: physical.uid, resolvedRoot: physical.currentResolvedRoot, releaseId: application.currentReleaseId }); save();
}

async function ensureTopology(page, via = 'api') {
  if (state.provisioned) return;
  const ra = await createAccount('ra', 'reseller', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const rb = await createAccount('rb', 'reseller', { limits: { maxCustomers: 1, maxWebsites: 2 } });
  const ca = await createAccount('ca', 'customer', { resellerId: ra.id }); const cb = await createAccount('cb', 'customer', { resellerId: rb.id }); const direct = await createAccount('direct', 'customer', { resellerId: null });
  await provision(page, 'a', ca.id, via); await provision(page, 'b', cb.id, via); await provision(page, 'direct', direct.id, via);
  expect(new Set(siteKeys.map(key => state.sites[key].unixUid)).size).toBe(3); expect(new Set(siteKeys.map(key => state.sites[key].releaseId)).size).toBe(3);
  record('three-sites-ready', { via, distinctNonRootUids: true, distinctReleases: true, exactHttpMarkers: true }); state.provisioned = true; save();
}

test.describe('Owned reseller customer site isolation and revocation', () => {
  test.beforeAll(async ({}, info) => {
    owner = await apiContext(); const nonce = randomBytes(5).toString('hex');
    const project = info.project.name.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase();
    statePath = path.join(RUN_DIR, 'tenant-sites-' + project + '-w' + info.workerIndex + '.json'); expect(fs.existsSync(statePath), 'Each project requires a fresh run').toBe(false);
    state = { nonce, fixturePrefix: 't888-' + project + '-' + info.workerIndex, accounts: {}, sites: {}, events: [], project: info.project.name, baselineUserIds: [] };
    credentials = Object.fromEntries(keys.map(key => [key, { username: 'ypaudit-t888-' + nonce + '-' + key, password: randomBytes(30).toString('base64url') }]));
    fs.writeFileSync(path.join(RUN_DIR, 'tenant-credentials-' + project + '-w' + info.workerIndex + '.json'), JSON.stringify(credentials), { mode: 0o600 });
    state.baselineUserIds = ok(await call(owner, 'GET', '/api/panel/users?limit=100'), 'Read account baseline').users.map(u => u.id); save();
    record('source-proof', { sourceSha256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex') });
  });
  test.afterAll(async () => {
    test.setTimeout(360000); if (!owner || !state) return;
    for (const actor of actors) { await actor.context?.close(); await actor.api.dispose(); }
    const failures = [...await cleanupSites(), ...await cleanupAccounts()]; record('cleanup-final', { failures, allOwnedSitesAndAccountsRemoved: failures.length === 0 });
    await owner.api.dispose(); expect(failures, 'All recorded owned tenant resources must be removed').toEqual([]);
  });

  test('@mutation tenant normal UI creates three distinct real sites for two reseller customers and a direct customer', async ({ page }) => {
    test.setTimeout(600000);
    await ensureTopology(page, 'ui'); expect(page.auditErrors).toEqual([]);
  });

  test('@mutation tenant five actors enforce site API job and tool boundaries and real PTYs revoke only the disabled parent chain', async ({ browser }) => {
    test.setTimeout(600000); await ensureTopology(null, 'api');
    for (const [key, siteKey] of [['ra', 'a'], ['rb', 'b'], ['ca', 'a'], ['cb', 'b'], ['direct', 'direct']]) {
      const actor = await login(key, browser); actor.siteKey = siteKey; const ownSite = state.sites[siteKey];
      const list = ok(await call(actor, 'GET', '/api/panel/websites'), 'Tenant website list'); expect(list.map(v => v.id)).toEqual([ownSite.websiteId]);
      let endpointCount = 0;
      for (const targetKey of siteKeys) {
        const t = state.sites[targetKey], foreign = targetKey !== siteKey, root = '/api/panel/websites/' + t.websiteId;
        const endpoints = [root, root + '/domains', root + '/files', root + '/crons', root + '/consumption', root + '/quotas', root + '/backup-set', root + '/backups', '/api/panel/servers/' + t.serverId + '/websites/' + t.websiteId + '/database-resources', '/api/panel/domains/' + t.domainId, '/api/panel/applications/' + t.applicationId];
        for (const endpoint of endpoints) { const r = await call(actor, 'GET', endpoint); expect(foreign ? [403, 404] : [200], key + ' ' + endpoint).toContain(r.status); endpointCount++; }
        const capability = await call(actor, 'POST', '/api/panel/terminal/capabilities', { scope: 'site', websiteId: t.websiteId }); expect(capability.status).toBe(foreign ? 403 : 201);
        const handoff = await call(actor, 'POST', '/api/panel/servers/' + t.serverId + '/websites/' + t.websiteId + '/elfinder-handoffs', {}); expect(handoff.status).toBe(foreign ? 403 : 201);
        if (foreign) expect((await call(actor, 'POST', '/api/panel/domains/' + t.domainId + '/stage', {})).status).toBe(403);
      }
      expect((await call(actor, 'POST', '/api/panel/terminal/capabilities', { scope: 'server', serverId: ownSite.serverId })).status).toBe(403);
      record('tenant-api-scope', { actor: key, endpointCount, ownSiteId: ownSite.websiteId, foreignScopesRejected: true, rootTerminalRejected: true });
    }
    const ca = actors.find(a => a.key === 'ca'); let jobId;
    const scopedJobs = '/api/panel/jobs?resourceType=domain&resourceId=' + state.sites.a.domainId;
    const beforeJobs = ok(await call(ca, 'GET', scopedJobs), 'Read own jobs before CSRF negative').map(v => v.id).sort();
    const deniedCsrf = await ca.api.post('/api/panel/domains/' + state.sites.a.domainId + '/stage', { data: {}, headers: { Origin: ORIGIN }, maxRedirects: 0 });
    expect(deniedCsrf.status()).toBe(403); expect((await deniedCsrf.json()).error.code).toBe('csrf_invalid');
    expect(ok(await call(ca, 'GET', scopedJobs), 'Verify CSRF denial did not enqueue work').map(v => v.id).sort()).toEqual(beforeJobs);
    record('tenant-csrf-denial', { actor: 'ca', code: 'csrf_invalid', ownedJobCollectionUnchanged: true });
    for (const action of ['stage', 'activate']) { const job = ok(await call(ca, 'POST', '/api/panel/domains/' + state.sites.a.domainId + '/' + action, {}), 'Own tenant ' + action, [202]); jobId = job.id ?? job.job?.id; await waitOwnedJob(ca, jobId); }
    for (const actor of actors) expect((await call(actor, 'GET', '/api/panel/jobs/' + jobId)).status).toBe(['ra', 'ca'].includes(actor.key) ? 200 : 403);
    const terminals = [];
    for (const actor of actors) {
      const t = state.sites[actor.siteKey]; const page = await actor.context.newPage(); const proof = { key: actor.key, identityObserved: false, outputObserved: false, actualUidAndCwdObserved: false, postRevokeOutputObserved: false, closed: false }; let output = '';
      page.on('websocket', socket => { if (new URL(socket.url()).pathname !== '/api/terminal') return;
        socket.on('framereceived', frame => { let data; try { data = JSON.parse(String(frame.payload)); } catch { return; }
          if (data.type === 'ready') proof.identityObserved = data.target?.websiteId === t.websiteId && data.target?.user === t.unixUser;
          if (data.type === 'output') { output = (output + String(data.data)).slice(-8192); proof.outputObserved = output.includes('T888-PTY-' + actor.key + '-' + state.nonce); proof.postRevokeOutputObserved = output.includes('STILL-' + actor.key + '-' + state.nonce + '\r\n'); proof.actualUidAndCwdObserved = output.includes('UIDPROOF=' + t.unixUid + '\r\n') && output.includes('CWDPROOF=' + t.resolvedRoot + '\r\n'); }
        }); socket.on('close', () => { proof.closed = true; });
      });
      await page.addInitScript(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor(...args) { super(...args); this.addEventListener('close', event => { if (new URL(this.url).pathname === '/api/terminal') window.__t888CloseCode = event.code; }); } }; });
      await ready(page, '/websites/' + t.domainId + '/terminal'); await main(page).getByRole('button', { name: 'Terminali aç', exact: true }).click();
      await expect(main(page).getByRole('status').filter({ hasText: /^Bağlı$/ })).toBeVisible({ timeout: 20000 }); await expect.poll(() => proof.identityObserved, { timeout: 5000 }).toBe(true);
      await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.type("printf 'UIDPROOF='; id -u; printf 'CWDPROOF='; pwd -P; printf 'T888-'; printf 'PTY-" + actor.key + '-' + state.nonce + "\\n'"); await page.keyboard.press('Enter');
      await expect.poll(() => proof.outputObserved && proof.actualUidAndCwdObserved, { timeout: 15000 }).toBe(true); terminals.push({ actor, page, proof });
    }
    const parent = ok(await call(owner, 'GET', ACCOUNTS + '/' + state.accounts.ra.id), 'Read parent revision');
    ok(await call(owner, 'PATCH', ACCOUNTS + '/' + state.accounts.ra.id + '/status', { revision: parent.revision, active: false }), 'Disable only owned reseller A'); state.parentDisabled = true; save();
    for (const actor of actors) expect((await call(actor, 'GET', '/api/auth/session')).status).toBe(['ra', 'ca'].includes(actor.key) ? 401 : 200);
    for (const terminal of terminals) {
      if (['ra', 'ca'].includes(terminal.actor.key)) { await expect.poll(() => terminal.proof.closed, { timeout: 25000 }).toBe(true); expect(await terminal.page.evaluate(() => window.__t888CloseCode)).toBe(4001); }
      else {
        expect(terminal.proof.closed).toBe(false);
        await terminal.page.locator('.xterm-helper-textarea').focus(); await terminal.page.keyboard.type("printf 'ST'; printf 'ILL-" + terminal.actor.key + '-' + state.nonce + "\\n'"); await terminal.page.keyboard.press('Enter');
        await expect.poll(() => terminal.proof.postRevokeOutputObserved, { timeout: 10000 }).toBe(true);
      }
    }
    for (const key of siteKeys) { const reply = await owned(key).http('/'); expect(reply.status).toBe(200); expect(reply.body).toContain(state.sites[key].marker); }
    record('parent-chain-revocation', { jobId, terminalChecks: terminals.map(v => ({ ...v.proof, closeCode: ['ra', 'ca'].includes(v.actor.key) ? 4001 : null })), siblingAndDirectSessionsUsable: true, allThreeHttpMarkersPreserved: true }); state.scopeAccepted = true; save();
  });

  test('@mutation tenant normal UI removes the three owned sites before exact hosting profiles and logins are deleted', async ({ page }) => {
    test.setTimeout(600000); await ensureTopology(null, 'api');
    for (const key of siteKeys) {
      const f = owned(key), t = f.ledger; await ready(page, f.route('settings')); await main(page).getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Siteyi kalıcı olarak sil' }); await expect(dialog).toBeVisible(); await dialog.getByRole('textbox').fill(t.hostname);
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === f.endpoint('/removal') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click(); const response = await pending; expect(response.status()).toBe(201); const operation = (await response.json()).data;
      expect(operation.execution.mode).toBe('automatic'); expect(operation.websiteId).toBe(t.websiteId); state.sites[key].removalId = operation.id; save();
      await expect.poll(async () => { const current = ok(await call(owner, 'GET', '/api/panel/website-removal-operations/' + operation.id), 'Read same normal UI removal'); expect(current.id).toBe(operation.id); expect(current.websiteId).toBe(t.websiteId); expect(['failed', 'blocked']).not.toContain(current.status); return current.status; }, { timeout: 180000, intervals: [500, 1000] }).toBe('removed');
      await f.cleanup(); assertPhysicalGone(readOnlyHostProbe(f, 'lifecycle-absence')); state.sites[key].removed = true; state.sites[key].physicalAbsent = true; save();
      for (const other of siteKeys.filter(k => !state.sites[k].removed)) { const reply = await owned(other).http('/'); expect(reply.status).toBe(200); expect(reply.body).toContain(state.sites[other].marker); }
      record('normal-ui-removal', { websiteId: t.websiteId, sameJournalId: operation.id, physicalAbsent: true });
    }
    expect(await cleanupAccounts()).toEqual([]); record('tenant-cleanup-verified', { siteCount: 3, accountCount: 5, physicalAbsence: true });
  });
});
