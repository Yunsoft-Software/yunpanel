import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { request } from '@playwright/test';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { test, expect, apiContext, safeApi, ORIGIN, RUN_DIR, ready, main, auditNetworkOptions, envFile } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const ACCOUNTS = '/api/panel/users/hosting/accounts';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const keys = ['ra', 'rb', 'ca', 'cb', 'direct'];
const siteKeys = ['a', 'b', 'direct'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let owner, state, statePath, credentials, fixtures = {};
const actors = [];
const terminals = [];
const ttydPages = [];
const pendingActions = [];
const HELPER = path.resolve('.local/reinstall-20261011/host.py');
const HELPER_SHA = 'd69ac81f74b24aefa379a3556e6b72966acab8ffb3be55774cd4673b1be11fa7';
export const openAcceptances = [
  { id: 'T898.pending-open-causality', reason: 'Each real overlap attempt is recorded; an unobserved pending lease remains OPEN and is never manufactured with a delay.' },
  { id: 'T898.detached-processes', reason: 'Only verified manager-owned child/session identities are drained; arbitrary detached site processes and unsupported OS fault channels are not claimed.' },
  { id: 'T898.legacy-ttyd-faults', reason: 'The removed fake unsafe-runtime/socket-root/global-capacity outcomes are not native coverage; mutating a shared runtime or foreign socket root is unsupported here.' },
];

// Read only the known API children, exact own session sockets and /proc stat
// identities. No UID search, command/environment dump, signal or host mutation.
function terminalHostRead({ shells = [], ttyd = [], known = [] } = {}) {
  for (const name of ['sunucu-28-1', 'sunucu-28-2', 'sunucu-28-3', 'sunucu-28-genel']) {
    expect(fs.readFileSync(path.join('tasks/locks', name, 'owner'), 'utf8').split('|')[0]).toBe('AGENT_4');
  }
  expect(envFile('.local/test-server.env').YUNPANEL_TEST_SERVER_HOST).toBe('157.180.11.28');
  expect(fs.realpathSync(HELPER)).toBe(HELPER);
  expect(createHash('sha256').update(fs.readFileSync(HELPER)).digest('hex')).toBe(HELPER_SHA);
  for (const value of shells) expect(Number.isSafeInteger(value) && value > 1).toBe(true);
  for (const value of ttyd) expect(value).toMatch(UUID);
  const payload = Buffer.from(JSON.stringify({ shells, ttyd, known })).toString('base64');
  const python = String.raw`
import base64,json,os,re,stat,subprocess,sys
x=json.loads(base64.b64decode(sys.argv[1],validate=True));assert os.getuid()==0
def pid():
 value=subprocess.check_output(['/usr/bin/systemctl','show','yunpanel-api','--property=MainPID','--value'],text=True,timeout=5).strip()
 assert value.isdecimal() and int(value)>1;return int(value)
def proc(n):
 try:
  text=open('/proc/'+str(n)+'/stat').read(8193);assert len(text)<=8192
  fields=text[text.rfind(')')+2:].split();assert len(fields)>=20
  return {'pid':int(n),'ppid':int(fields[1]),'pgid':int(fields[2]),'sid':int(fields[3]),'starttime':fields[19]}
 except FileNotFoundError:return None
def sock(name):
 try:
  s=os.lstat(name);assert stat.S_ISSOCK(s.st_mode) and s.st_nlink==1
  return {'path':name,'exists':True,'dev':str(s.st_dev),'ino':str(s.st_ino),'uid':s.st_uid,'gid':s.st_gid,'mode':stat.S_IMODE(s.st_mode)}
 except FileNotFoundError:return {'path':name,'exists':False}
api=pid();assert proc(api) is not None
names=[n for n in os.listdir('/proc') if n.isdecimal()];assert len(names)<=32768
current={p['pid']:p for p in (proc(int(n)) for n in names) if p is not None}
roots=[];sockets=[]
for shell in x['shells']:
 assert type(shell) is int and shell>1 and shell in current
 chain=[];item=current[shell]
 for _ in range(16):
  if item['pid']==api:break
  chain.append(item);assert item['ppid'] in current;item=current[item['ppid']]
 assert item['pid']==api and chain
 root=chain[-1];assert root['ppid']==api and root['sid']==root['pid'] and root['pgid']==root['pid']
 roots.append({'kind':'node-pty','shell':shell,'root':root,'ancestry':chain})
for session in x['ttyd']:
 assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',session)
 name='/run/yunpanel/ttyd/'+session+'.sock';meta=sock(name)
 rows=[line.split() for line in open('/proc/net/unix') if line.split()[-1:]==[name]]
 assert all(len(row)==8 and row[6].isdecimal() and re.fullmatch(r'[0-9a-fA-F]{8}',row[3]) and re.fullmatch(r'[0-9a-fA-F]{4}',row[4]) and re.fullmatch(r'[0-9a-fA-F]{2}',row[5]) for row in rows)
 assert all(row[3] in ('00000000','00010000') and row[4]=='0001' and row[5] in ('01','02','03','04') for row in rows)
 listeners=[row for row in rows if row[3]=='00010000' and row[5]=='01'];assert len(listeners)<=1
 meta.update(namedKernelRows=len(rows),listenerCount=len(listeners));sockets.append(meta)
 if not meta['exists'] or not listeners:continue
 inode=listeners[0][6]
 owners=[]
 for child in current.values():
  if child['ppid']!=api:continue
  try:
   matches=[]
   for fd in os.listdir('/proc/'+str(child['pid'])+'/fd'):
    try:matches.append(os.readlink('/proc/'+str(child['pid'])+'/fd/'+fd)=='socket:['+inode+']')
    except FileNotFoundError:continue
   if any(matches):owners.append(child)
  except FileNotFoundError:continue
 assert len(owners)==1
 root=owners[0];assert root['sid']==root['pid'] and root['pgid']==root['pid']
 roots.append({'kind':'ttyd','sessionId':session,'root':root})
ttyd_roots={row['root']['pid'] for row in roots if row['kind']=='ttyd'}
for row in roots:
 if row['kind']=='node-pty' and row['root']['pid'] in ttyd_roots:row['kind']='ttyd-shell'
for row in roots:
 owned={row['root']['pid']:row['root']};changed=True
 while changed:
  changed=False;sids={v['sid'] for v in owned.values()}
  for n,p in current.items():
   if n not in owned and (p['ppid'] in owned or p['sid'] in sids):owned[n]=p;changed=True
 assert len(owned)<=256;row['processes']=sorted(owned.values(),key=lambda v:v['pid'])
checks=[]
for old in x['known']:
 assert set(old)==set(('pid','ppid','pgid','sid','starttime')) and type(old['pid']) is int and old['pid']>1 and str(old['starttime']).isdecimal()
 actual=current.get(old['pid']);checks.append({'identity':old,'absent':actual is None,'pidReused':actual is not None and actual['starttime']!=old['starttime'],
 'sessionAbsent':not any(v['sid']==old['sid'] for v in current.values())})
assert pid()==api
print(json.dumps({'apiPid':api,'apiIdentity':current[api],'roots':roots,'sockets':sockets,'known':checks}))
`;
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let result;
  try { result = JSON.parse(execFileSync('python3', [HELPER, 'python3 -c ' + quote(python) + ' ' + quote(payload)],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch { throw new Error('The exact terminal identity read-only probe failed; protected diagnostics withheld'); }
  expect(createHash('sha256').update(fs.readFileSync(HELPER)).digest('hex')).toBe(HELPER_SHA);
  return result;
}

async function typeConsole(console, command) {
  await console.page.locator('.xterm-helper-textarea').focus();
  await console.page.keyboard.type(command); await console.page.keyboard.press('Enter');
}

async function consolePid(console, label) {
  await typeConsole(console, "printf '\\nT898-'; printf '" + label + "=%s\\n' \"$$\"");
  const pattern = new RegExp('\\r?\\nT898-' + label + '=([0-9]+)\\r?\\n');
  await expect.poll(() => pattern.test(console.output()), { timeout: 10000 }).toBe(true);
  return Number(console.output().match(pattern)[1]);
}

async function createTtyd(siteKey, actor = owner) {
  const capability = ok(await call(actor, 'POST', '/api/panel/terminal/capabilities',
    { scope: 'site', websiteId: state.sites[siteKey].websiteId }), 'Issue actual Owner site ttyd capability', [201]);
  const result = ok(await call(actor, 'POST', '/api/panel/terminal/ttyd-sessions', { capability: capability.capability }), 'Create actual Owner ttyd', [201]);
  expect(result.sessionId).toMatch(UUID); expect(result.target.websiteId).toBe(state.sites[siteKey].websiteId);
  expect(result.protocol).toBe('yunpanel-ttyd-v1'); expect(result.basePath).toBe('/tools/ttyd/' + result.sessionId + '/');
  state.ttyd ??= []; state.ttyd.push({ sessionId: result.sessionId, websiteId: result.target.websiteId, siteKey, createdAt: new Date().toISOString() }); save();
  return result;
}

async function connectTtyd(context, session) {
  const page = await context.newPage(); ttydPages.push(page);
  let output = '', connected = false, closed = false;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== session.basePath + 'ws') return;
    connected = true;
    socket.on('framereceived', frame => { output = (output + Buffer.from(frame.payload).toString('utf8')).slice(-16384); });
    socket.on('close', () => { closed = true; });
  });
  const response = await page.goto(session.basePath, { waitUntil: 'domcontentloaded' }); expect(response.status()).toBe(200);
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached({ timeout: 15000 });
  await expect.poll(() => connected && output.length > 0, { timeout: 15000 }).toBe(true);
  const console = { page, output: () => output, closed: () => closed };
  const shellPid = await consolePid(console, 'TTYD-' + state.nonce);
  const expected = Object.values(state.sites).find(value => value.websiteId === session.target.websiteId);
  expect(expected.unixUid).toBeGreaterThan(0);
  await typeConsole(console, "printf '\\nT898-'; printf 'TTYD-UID='; id -u");
  await expect.poll(() => output.includes('\nT898-TTYD-UID=' + expected.unixUid + '\r\n'), { timeout: 10000 }).toBe(true);
  return { ...console, shellPid, sessionId: session.sessionId };
}

async function ownerRootConsole(context) {
  const page = await context.newPage(); ttydPages.push(page);
  let output = '', serverReady = false, closed = false;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/terminal') return;
    socket.on('framereceived', frame => {
      let data; try { data = JSON.parse(String(frame.payload)); } catch { return; }
      if (data.type === 'ready') serverReady = data.target?.scope === 'server' && data.target?.user === 'root';
      if (data.type === 'output') output = (output + String(data.data)).slice(-16384);
    }); socket.on('close', () => { closed = true; });
  });
  await ready(page, '/servers'); await main(page).getByRole('button', { name: 'Terminali aç', exact: true }).click();
  await expect.poll(() => serverReady, { timeout: 20000 }).toBe(true);
  const console = { page, output: () => output, closed: () => closed };
  console.shellPid = await consolePid(console, 'ROOT-' + state.nonce);
  await typeConsole(console, "printf '\\nT898-'; printf 'ROOT-UID='; id -u");
  await expect.poll(() => /\r?\nT898-ROOT-UID=0\r?\n/.test(output), { timeout: 10000 }).toBe(true);
  return console;
}

async function preparePendingNode(context, site) {
  const page = await context.newPage(); ttydPages.push(page);
  const proof = { startedAt: null, readyAt: null, closedAt: null, capabilityPosts: 0, readyWebsiteMatches: false };
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/panel/terminal/capabilities' && response.request().method() === 'POST') proof.capabilityPosts++;
  });
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/terminal') return;
    socket.on('framereceived', frame => {
      let data; try { data = JSON.parse(String(frame.payload)); } catch { return; }
      if (data.type === 'ready') { proof.readyAt = new Date().toISOString(); proof.readyWebsiteMatches = data.target?.websiteId === site.websiteId; }
    }); socket.on('close', () => { proof.closedAt = new Date().toISOString(); });
  });
  await ready(page, '/websites/' + site.domainId + '/terminal');
  return { page, proof, async start() {
    proof.startedAt = new Date().toISOString();
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/panel/terminal/capabilities' && value.request().method() === 'POST');
    response.catch(() => {});
    await main(page).getByRole('button', { name: 'Terminali aç', exact: true }).click();
    const actual = await response;
    proof.capabilityStatus = actual.status();
    expect([201, 409]).toContain(actual.status());
    return proof;
  } };
}

function trackPendingAction(kind, websiteId, promise) {
  const proof = { kind, websiteId, startedAt: new Date().toISOString(), outcome: 'PENDING' };
  const observed = promise.then(value => {
    if (kind === 'ttyd') {
      expect([201, 401, 409]).toContain(value.status);
      if (value.status === 201) {
        expect(value.data.sessionId).toMatch(UUID); expect(value.data.target.websiteId).toBe(websiteId);
        proof.sessionId = value.data.sessionId;
        state.ttyd.push({ sessionId: value.data.sessionId, websiteId, siteKey: 'b', overlap: true });
      } else expect(value.body.error.code).toBe(value.status === 401 ? 'terminal_capability_invalid' : 'terminal_website_removing');
      proof.status = value.status;
    }
    proof.outcome = 'KNOWN'; proof.completedAt = new Date().toISOString();
    record('T898-pending-action-completed', { ...proof });
    return value;
  }).catch(error => {
    proof.outcome = 'UNKNOWN_KEEP'; proof.completedAt = new Date().toISOString();
    record('T898-pending-action-unknown', { ...proof, errorClass: /^[A-Za-z]{1,50}$/.test(error?.name ?? '') ? error.name : 'Error', noRetry: true });
    throw error;
  });
  observed.catch(() => {});
  pendingActions.push({ proof, promise: observed });
  return observed;
}

async function settlePendingActions() {
  const results = await Promise.allSettled(pendingActions.map(value => value.promise));
  const unknown = pendingActions.filter((value, index) => results[index].status === 'rejected' || value.proof.outcome !== 'KNOWN');
  const ownTtyd = pendingActions.filter(value => value.proof.kind === 'ttyd' && value.proof.sessionId);
  if (ownTtyd.length) {
    try {
      const current = terminalHostRead({ ttyd: ownTtyd.map(value => value.proof.sessionId) });
      const metadata = [];
      for (const value of ownTtyd) {
        const reply = await call(owner, 'GET', '/api/panel/websites/' + value.proof.websiteId);
        expect([200, 404]).toContain(reply.status);
        if (reply.status === 200) expect(reply.data.id).toBe(value.proof.websiteId);
        metadata.push({ websiteId: value.proof.websiteId, status: reply.status });
      }
      record('T898-pending-known-identities-reconciled-before-cleanup', { current, metadata, readOnly: true,
        socketAbsenceAloneIsNotProcessClosure: true });
    } catch {
      unknown.push({ proof: { kind: 'known-terminal-reconciliation', outcome: 'UNKNOWN_KEEP' } });
    }
  }
  record('T898-pending-actions-joined-before-cleanup', { actions: pendingActions.map(value => ({ ...value.proof })),
    unknownCount: unknown.length, noMutationReplay: true });
  return unknown;
}

async function assertKnownGone(snapshot, sessionId = null) {
  const known = snapshot.roots.flatMap(value => value.processes);
  let after;
  await expect.poll(() => {
    after = terminalHostRead({ known, ttyd: sessionId ? [sessionId] : [] });
    return after.known.every(value => value.absent && value.sessionAbsent && !value.pidReused)
      && after.sockets.every(value => !value.exists && value.namedKernelRows === 0);
  }, { timeout: 80000, intervals: [500, 1000, 2000] }).toBe(true);
  return after;
}
function save() { fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); }
function record(kind, proof) { state.events.push({ kind, ...proof, at: new Date().toISOString() }); save(); }
async function call(actor, method, endpoint, data) {
  let response;
  for (let attempt = 0; ; attempt++) {
    try { response = await actor.api.fetch(endpoint, { method, data, maxRedirects: 0, maxRetries: 0, headers: { Origin: ORIGIN, 'x-csrf-token': actor.csrf, Connection: 'close' }, timeout: 90000 }); }
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
function assertPhysicalGone(proof, ledger) {
  const contract = createWebsitePathContract(ledger);
  const expectedRoots = [ledger.documentRoot, contract.runtime.applicationRoot, contract.workspace.homeDirectory, contract.static.buildRoot, contract.static.publishRoot];
  expect(proof.roots.map(p => p.path).sort()).toEqual([...new Set(expectedRoots)].sort());
  expect(proof.unixUserExists).toBe(false); expect(proof.unixGroupExists).toBe(false);
  expect(proof.roots.every(p => !p.exists)).toBe(true); expect(proof.fpmFiles).toEqual([]); expect(proof.sockets).toEqual([]);
  expect(proof.nginxFiles.length).toBeGreaterThan(0); expect(proof.nginxFiles.every(p => !p.exists)).toBe(true); expect(proof.mounts).toEqual([]);
}
async function cleanupSites() {
  const failures = [];
  for (const key of siteKeys) {
    if (!state.sites[key]) continue;
    try {
      const result = fixtures[key] ? await fixtures[key].cleanup() : await cleanupOwnedFixture(owner, { key: state.sites[key].key });
      const physical = readOnlyHostProbe({ ledger: result }, 'lifecycle-absence'); assertPhysicalGone(physical, result);
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
    const unknown = await settlePendingActions();
    for (const page of ttydPages) await page.close();
    for (const actor of actors) { await actor.context?.close(); await actor.api.dispose(); }
    if (unknown.length) {
      record('cleanup-final', { failures: [{ code: 'pending_terminal_mutation_unknown' }], allOwnedSitesAndAccountsRemoved: false, outcome: 'UNKNOWN_KEEP', noReplay: true });
      await owner.api.dispose();
      throw new Error('Pending terminal outcome is unknown; owned resources are kept for authoritative review without mutation replay');
    }
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
      await expect.poll(() => proof.outputObserved && proof.actualUidAndCwdObserved, { timeout: 15000 }).toBe(true); terminals.push({ actor, page, proof, output: () => output });
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

  test('@mutation tenant normal UI removes the three owned sites before exact hosting profiles and logins are deleted', async ({ page, browser }) => {
    test.setTimeout(600000); await ensureTopology(null, 'api');
    expect(state.scopeAccepted, 'The complete five-actor RBAC/CSRF/PTY scenario must precede removal').toBe(true);
    const root = await ownerRootConsole(page.context());
    const b = terminals.find(value => value.actor.key === 'rb');
    const direct = terminals.find(value => value.actor.key === 'direct');
    expect(b).toBeTruthy(); expect(direct).toBeTruthy();
    const bShell = await consolePid(b, 'B-' + state.nonce), directShell = await consolePid(direct, 'DIRECT-' + state.nonce);
    await typeConsole(b, "set -m; sleep 240 & printf '\\nT898-'; printf 'BACKGROUND=%s\\n' \"$!\"; sleep 240");
    await expect.poll(() => /\r?\nT898-BACKGROUND=[0-9]+\r?\n/.test(b.output()), { timeout: 10000 }).toBe(true);

    const explicit = await createTtyd('direct');
    const explicitBefore = terminalHostRead({ ttyd: [explicit.sessionId] });
    const foreignClose = await call(actors.find(value => value.key === 'rb'), 'DELETE', '/api/panel/terminal/ttyd-sessions/' + explicit.sessionId, {});
    expect([401, 403]).toContain(foreignClose.status);
    const notClosed = terminalHostRead({ ttyd: [explicit.sessionId] });
    expect(notClosed.roots[0].root).toEqual(explicitBefore.roots[0].root);

    const revokeAuth = process.env.YUNPANEL_T898_REVOCATION_AUTH_STATE;
    expect(typeof revokeAuth, 'Provide one independently logged-in normal Owner session for exact logout testing').toBe('string');
    const revokePath = path.resolve(revokeAuth);
    expect(fs.realpathSync(revokePath)).toBe(revokePath);
    expect(revokePath.startsWith(fs.realpathSync('.local') + path.sep)).toBe(true);
    const revokeStat = fs.lstatSync(revokePath);
    expect(revokeStat.isFile() && !revokeStat.isSymbolicLink() && revokeStat.size <= 1024 * 1024 && (revokeStat.mode & 0o777) === 0o600).toBe(true);
    const auxiliary = await apiContext(revokePath);
    expect(auxiliary.session.user.role).toBe('owner'); expect(auxiliary.session.user.id).toBe(owner.session.user.id);
    expect(auxiliary.session.id).not.toBe(owner.session.id);
    auxiliary.key = 'owner-revoke';
    auxiliary.context = await browser.newContext({ baseURL: ORIGIN, storageState: revokePath, ignoreHTTPSErrors: false, ...auditNetworkOptions() });
    actors.push(auxiliary);
    const wrongOwnerSession = await call(auxiliary, 'DELETE', '/api/panel/terminal/ttyd-sessions/' + explicit.sessionId, {});
    expect(wrongOwnerSession.status).toBe(404); expect(wrongOwnerSession.body.error.code).toBe('ttyd_session_not_found');
    expect(terminalHostRead({ ttyd: [explicit.sessionId] }).roots[0].root).toEqual(explicitBefore.roots[0].root);
    ok(await call(owner, 'DELETE', '/api/panel/terminal/ttyd-sessions/' + explicit.sessionId, {}), 'Normal Owner ttyd close', [204]);
    const explicitAfter = await assertKnownGone(explicitBefore, explicit.sessionId);
    record('T898-real-ttyd-explicit-close', { sessionId: explicit.sessionId, deniedForeignStatus: foreignClose.status, deniedDifferentOwnerSessionStatus: wrongOwnerSession.status,
      before: explicitBefore, after: explicitAfter, actualProcessAndSocketAbsent: true });

    const revocable = await createTtyd('direct', auxiliary);
    const revokeConsole = await connectTtyd(auxiliary.context, revocable);
    const revokeBefore = terminalHostRead({ shells: [revokeConsole.shellPid], ttyd: [revocable.sessionId] });
    ok(await call(auxiliary, 'POST', '/api/auth/logout', {}), 'Revoke only auxiliary normal Owner session', [204]);
    expect((await call(auxiliary, 'GET', '/api/auth/session')).status).toBe(401);
    expect((await call(owner, 'GET', '/api/auth/session')).status).toBe(200);
    await expect.poll(() => revokeConsole.closed(), { timeout: 10000 }).toBe(true);
    const revokeAfter = await assertKnownGone(revokeBefore, revocable.sessionId);
    expect(root.closed()).toBe(false); expect(direct.proof.closed).toBe(false);
    record('T898-real-Owner-session-revocation', { sessionId: revocable.sessionId, separateSameOwnerSession: true,
      mainOwnerStillAuthenticated: true, rootAndOtherSitePtyStillConnected: true, before: revokeBefore, after: revokeAfter });

    // No mutable TTL or fake clock: this session never reaches the gateway and
    // must expire through the product's actual 60-second startup deadline.
    const expirationStartedAt = new Date().toISOString();
    const expiring = await createTtyd('direct');
    const expirationBefore = terminalHostRead({ ttyd: [expiring.sessionId] });
    const expirationAfter = await assertKnownGone(expirationBefore, expiring.sessionId);
    const expirationCompletedAt = new Date().toISOString();
    expect(Date.parse(expirationCompletedAt) - Date.parse(expirationStartedAt)).toBeGreaterThanOrEqual(60000);
    record('T898-real-ttyd-unconnected-expiration', { sessionId: expiring.sessionId, expirationStartedAt, expirationCompletedAt,
      before: expirationBefore, after: expirationAfter, normalStartupDeadline: true });

    const connectedSession = await createTtyd('b');
    const connected = await connectTtyd(page.context(), connectedSession);
    let bBefore = terminalHostRead({ shells: [bShell, connected.shellPid], ttyd: [connectedSession.sessionId] });
    const bPty = bBefore.roots.find(value => value.kind === 'node-pty' && value.shell === bShell);
    const shellIdentity = bPty.processes.find(value => value.pid === bShell);
    expect(bPty.processes.filter(value => value.ppid === bShell && value.pgid !== shellIdentity.pgid).length).toBeGreaterThanOrEqual(2);
    expect(new Set(bPty.processes.filter(value => value.ppid === bShell).map(value => value.pgid)).size).toBeGreaterThanOrEqual(2);
    expect(bBefore.sockets.every(value => value.exists && value.mode === 0o660)).toBe(true);
    expect(bBefore.sockets.find(value => value.path.endsWith(connectedSession.sessionId + '.sock')).namedKernelRows).toBeGreaterThanOrEqual(2);
    const preserved = terminalHostRead({ shells: [root.shellPid, directShell] });
    record('T898-real-owned-terminal-baseline', { websiteId: state.sites.b.websiteId, b: bBefore, preserved,
      connectedTtyd: connectedSession.sessionId,
      distinctForegroundAndBackgroundGroups: true });


    for (const key of siteKeys) {
      const f = owned(key), t = f.ledger; await ready(page, f.route('settings')); await main(page).getByRole('button', { name: 'Siteyi sil…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Siteyi kalıcı olarak sil' }); await expect(dialog).toBeVisible(); await dialog.getByRole('textbox').fill(t.hostname);
      let consumeCapability, pendingTtyd, pendingTtydFinished = false, overlapStartAt, pendingNode, nodeStart;
      if (key === 'b') {
        const unconnectedSession = await createTtyd('b');
        bBefore = terminalHostRead({ shells: [bShell, connected.shellPid], ttyd: [connectedSession.sessionId, unconnectedSession.sessionId] });
        record('T898-real-unconnected-at-removal', { websiteId: t.websiteId, sessionId: unconnectedSession.sessionId, before: bBefore });
        pendingNode = await preparePendingNode(page.context(), t);
        consumeCapability = ok(await call(owner, 'POST', '/api/panel/terminal/capabilities', { scope: 'site', websiteId: t.websiteId }), 'Issue unused pre-fence capability', [201]);
        const raceCapability = ok(await call(owner, 'POST', '/api/panel/terminal/capabilities', { scope: 'site', websiteId: t.websiteId }), 'Issue one real overlap capability', [201]);
        overlapStartAt = new Date().toISOString();
        record('T898-pending-open-attempts-started', { websiteId: t.websiteId, overlapStartAt, nodeUiClicks: 1, ttydPosts: 1, outcome: 'PENDING' });
        nodeStart = trackPendingAction('node-ui', t.websiteId, pendingNode.start());
        pendingTtyd = trackPendingAction('ttyd', t.websiteId, call(owner, 'POST', '/api/panel/terminal/ttyd-sessions', { capability: raceCapability.capability }))
          .then(value => { pendingTtydFinished = true; return value; })
          .catch(error => { record('T898-pending-ttyd-transport-unknown', { websiteId: t.websiteId, outcome: 'UNKNOWN_KEEP', noPostRetry: true }); throw error; });
        pendingTtyd.catch(() => {});
      }
      const pending = page.waitForResponse(r => new URL(r.url()).pathname === f.endpoint('/removal') && r.request().method() === 'POST');
      await dialog.getByRole('button', { name: 'Silme işlemini başlat', exact: true }).click(); const response = await pending; expect(response.status()).toBe(201); const operation = (await response.json()).data;
      expect(operation.execution.mode).toBe('automatic'); expect(operation.websiteId).toBe(t.websiteId); state.sites[key].removalId = operation.id; save();
      const generation = operation.plan.terminalLifecycle.generationBoundary;
      expect(generation.verified).toBe(true); expect(generation.source).toBe('systemd_cgroup_v2');
      expect(generation.unit).toBe('yunpanel-api.service'); expect(generation.killMode).toBe('control-group');
      expect(generation.sendSigkill).toBe(true); expect(generation.onlyCurrentApiMember).toBe(true);
      expect(generation.socketNamespace.path).toBe('/run/yunpanel/ttyd'); expect(generation.socketNamespace.empty).toBe(true);
      expect(generation.api).toEqual(preserved.apiIdentity);
      for (const lease of operation.plan.terminalLifecycle.leases.filter(value => value.evidence.started)) {
        expect(lease.evidence.creator.pid).toBe(generation.api.pid); expect(lease.evidence.creator.starttime).toBe(generation.api.starttime);
      }
      if (key === 'b') {
        const pendingAtRemovalResponse = !pendingTtydFinished;
        const nodePendingAtRemovalResponse = pendingNode.proof.readyAt === null;
        await nodeStart;
        expect((await call(owner, 'GET', '/api/auth/session')).status).toBe(200);
        expect((await call(owner, 'GET', '/api/panel/websites/' + t.websiteId)).status).toBe(200);
        const denied = await call(owner, 'POST', '/api/panel/terminal/capabilities', { scope: 'site', websiteId: t.websiteId });
        expect(denied.status).toBe(409); expect(denied.body.error.code).toBe('terminal_website_removing');
        expect((await call(owner, 'GET', '/api/panel/websites/' + t.websiteId)).status).toBe(200);
        const consumed = await call(owner, 'POST', '/api/panel/terminal/ttyd-sessions', { capability: consumeCapability.capability });
        expect(consumed.status).toBe(401); expect(consumed.body.error.code).toBe('terminal_capability_invalid');
        const overlap = await pendingTtyd;
        expect([201, 401, 409]).toContain(overlap.status);
        if (overlap.status === 409) expect(overlap.body.error.code).toBe('terminal_website_removing');
        if (overlap.status === 401) expect(overlap.body.error.code).toBe('terminal_capability_invalid');
        const pendingLeaseObserved = operation.plan.terminalLifecycle.leases.some(value => value.backend === 'ttyd' && value.evidence.started === false);
        record('T898-real-pending-ttyd-overlap', { operationId: operation.id, overlapStartAt, observedAt: new Date().toISOString(), pendingAtRemovalResponse,
          responseStatus: overlap.status, sessionId: overlap.data?.sessionId ?? null, pendingLeaseObserved,
          causality: pendingLeaseObserved && pendingAtRemovalResponse ? 'OBSERVED' : 'OPEN', noPostRetry: true });
        const nodePendingLeaseObserved = operation.plan.terminalLifecycle.leases.some(value => value.backend === 'node-pty' && value.evidence.started === false);
        record('T898-real-pending-node-overlap', { operationId: operation.id, observedAt: new Date().toISOString(), nodePendingAtRemovalResponse,
          pendingLeaseObserved: nodePendingLeaseObserved, proof: { ...pendingNode.proof },
          causality: nodePendingLeaseObserved && nodePendingAtRemovalResponse ? 'OBSERVED' : 'OPEN', oneClick: true });
        record('T898-native-fence-denials', { operationId: operation.id, websiteId: t.websiteId, authenticatedBeforeAndAfter: true,
          websitePresentBeforeAndAfter: true, issueStatus: denied.status, issueCode: denied.body.error.code,
          consumeStatus: consumed.status, consumeCode: consumed.body.error.code });
      }
      let removed;
      await expect.poll(async () => { const current = ok(await call(owner, 'GET', '/api/panel/website-removal-operations/' + operation.id), 'Read same normal UI removal'); expect(current.id).toBe(operation.id); expect(current.websiteId).toBe(t.websiteId); expect(['failed', 'blocked']).not.toContain(current.status); removed = current; return current.status; }, { timeout: 180000, intervals: [500, 1000] }).toBe('removed');
      for (const kind of ['file_cleanup', 'unix_identity_cleanup']) {
        const step = removed.steps.find(value => value.kind === kind); expect(step.status).toBe('succeeded');
        expect(step.result.terminalDrain.verified).toBe(true); expect(step.result.terminalDrain.websiteId).toBe(t.websiteId);
        expect(step.result.terminalDrain.operationId).toBe(operation.id);
        expect(step.result.terminalDrain.snapshotSha256).toBe(createHash('sha256').update(JSON.stringify(operation.plan.terminalLifecycle)).digest('hex'));
        expect(step.result.terminalDrain.leaseCount).toBe(operation.plan.terminalLifecycle.leases.length);
        expect(Date.parse(step.result.terminalDrain.completedAt)).toBeLessThanOrEqual(Date.parse(step.updatedAt));
      }
      expect(Date.parse(removed.steps.find(value => value.kind === 'file_cleanup').updatedAt))
        .toBeLessThanOrEqual(Date.parse(removed.steps.find(value => value.kind === 'unix_identity_cleanup').updatedAt));
      if (key === 'b') {
        await expect.poll(() => b.proof.closed && terminals.find(value => value.actor.key === 'cb').proof.closed && connected.closed(), { timeout: 10000 }).toBe(true);
        const known = [...new Map(bBefore.roots.flatMap(value => value.processes).map(value => [value.pid, value])).values()];
        const after = terminalHostRead({ known, ttyd: state.ttyd.filter(value => value.websiteId === t.websiteId).map(value => value.sessionId) });
        expect(after.known.every(value => value.absent && value.sessionAbsent && !value.pidReused)).toBe(true);
        expect(after.sockets.every(value => !value.exists && value.namedKernelRows === 0)).toBe(true);
        const receipt = removed.steps.find(value => value.kind === 'file_cleanup').result.terminalDrain;
        const drained = receipt.leases.flatMap(value => value.processes);
        for (const process of known) expect(drained.some(value => value.pid === process.pid && value.starttime === process.starttime)).toBe(true);
        record('T898-real-drain-before-unix', { websiteId: t.websiteId, operationId: operation.id, terminalDrain: receipt, after,
          nodePtyClosed: true, connectedTtydClosed: true, knownForegroundBackgroundAndTtydProcessesAbsent: true });
        expect(pendingNode.proof.capabilityPosts).toBe(1);
        if (pendingNode.proof.readyAt !== null) {
          expect(pendingNode.proof.readyWebsiteMatches).toBe(true);
          await expect.poll(() => pendingNode.proof.closedAt !== null, { timeout: 10000 }).toBe(true);
        }
        record('T898-pending-node-final', { operationId: operation.id, proof: { ...pendingNode.proof } });
      }
      await f.cleanup(); assertPhysicalGone(readOnlyHostProbe(f, 'lifecycle-absence'), t); state.sites[key].removed = true; state.sites[key].physicalAbsent = true; save();
      for (const other of siteKeys.filter(k => !state.sites[k].removed)) { const reply = await owned(other).http('/'); expect(reply.status).toBe(200); expect(reply.body).toContain(state.sites[other].marker); }
      record('normal-ui-removal', { websiteId: t.websiteId, sameJournalId: operation.id, physicalAbsent: true });
      if (key !== 'direct') {
        expect(root.closed()).toBe(false); expect(direct.proof.closed).toBe(false);
        const current = terminalHostRead({ shells: [root.shellPid, directShell] });
        expect(current.roots.map(value => value.root)).toEqual(preserved.roots.map(value => value.root));
        const marker = 'PRESERVED-' + key + '-' + state.nonce;
        for (const console of [root, direct]) {
          await typeConsole(console, "printf '\\nT898-'; printf '" + marker + "\\n'");
          await expect.poll(() => console.output().includes('\nT898-' + marker + '\r\n'), { timeout: 10000 }).toBe(true);
        }
        record('T898-root-and-other-Website-preserved', { afterRemoving: t.websiteId, sameActualIdentities: current, firstDynamicOutput: true });
        if (key === 'a') {
          const bStillLive = terminalHostRead({ shells: [bShell, connected.shellPid], ttyd: [connectedSession.sessionId] });
          expect(bStillLive.roots.map(value => value.root)).toEqual(bBefore.roots.map(value => value.root));
          expect(bStillLive.sockets.every(value => value.exists)).toBe(true); expect(connected.closed()).toBe(false);
          record('T898-B-site-preserved-during-A-removal', { current: bStillLive, sameActualIdentities: true });
        }
      }
    }
    expect(await cleanupAccounts()).toEqual([]); record('tenant-cleanup-verified', { siteCount: 3, accountCount: 5, physicalAbsence: true });
  });
});
