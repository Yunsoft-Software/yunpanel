import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ORIGIN, RUN_DIR, envFile, manifest } from './runtime.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { nginxConfigFileName, phpFpmPoolName, phpFpmSocketPath } from '../../packages/config-templates/src/index.js';
import { elFinderFpmPoolName, elFinderFpmSocketPath } from '../../packages/config-templates/src/elfinder-fpm.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KEY = /^[a-z0-9][a-z0-9-]{0,43}$/i;
const USER = /^yunapp-[a-z0-9]{8,32}$/;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const codeOf = body => /^[a-z0-9_]{1,100}$/i.test(body?.error?.code ?? '') ? body.error.code : 'unknown';
function checked(result, label, statuses = [200]) {
  if (!statuses.includes(result.status)) throw new Error(`${label}: HTTP ${result.status} ${codeOf(result.body)}`);
  return result.data;
}
function publicValue(value) {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    assert.ok(!/password|secret|cookie|authorization|csrf|token|private.?key/i.test(key), 'Private values cannot enter the fixture ledger');
    return [key, publicValue(item)];
  }));
  assert.ok(value == null || ['string', 'number', 'boolean'].includes(typeof value), 'Unsupported ledger value');
  return value;
}
async function target() {
  const ip = envFile('.local/test-server.env').YUNPANEL_TEST_SERVER_HOST;
  assert.equal(ip, '157.180.11.28', 'Only the authorized test host is permitted');
  const addresses = await dns.lookup(new URL(ORIGIN).hostname, { all: true });
  assert.ok(addresses.length && addresses.every(a => a.address === ip), 'Panel DNS target changed');
  return ip;
}
async function hostAtTarget(hostname, ip) {
  const addresses = await dns.lookup(hostname, { all: true });
  assert.ok(addresses.length && addresses.every(a => a.address === ip), 'Owned hostname resolves outside the allowed test host');
}
function requestHost(ip, hostname, pathname, options = {}) {
  assert.ok(typeof pathname === 'string' && pathname.startsWith('/') && !pathname.startsWith('//'), 'Expected an owned HTTP path');
  const { method = 'GET', body = null, headers = {}, timeoutMs = 30000, scheme = 'http', maxBytes = 4 * 1024 * 1024 } = options;
  assert.ok(['http', 'https'].includes(scheme));
  assert.ok(Object.keys(headers).every(k => !/^(host|cookie|authorization)$/i.test(k)), 'HTTP probe cannot carry panel credentials or replace its host');
  const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return new Promise((resolve, reject) => {
    const req = (scheme === 'https' ? https : http).request({ hostname: ip, servername: hostname, port: scheme === 'https' ? 443 : 80,
      path: pathname, method, headers: { ...headers, Host: hostname, ...(data ? { 'Content-Length': data.length } : {}) }, timeout: timeoutMs }, res => {
      const buffers = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > maxBytes) req.destroy(new Error('HTTP probe response too large')); else buffers.push(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(buffers).toString('utf8'), headers: res.headers }));
      res.on('error', () => reject(new Error('Owned HTTP response failed')));
    });
    req.on('timeout', () => req.destroy(new Error('Owned HTTP probe timed out')));
    req.on('error', () => reject(new Error('Owned HTTP probe transport failed')));
    req.end(data);
  });
}

// Every mutation is sent once. An uncertain response is recovered by reading the same durable identity.
export async function createOwnedFixture(liveApi, options = {}) {
  assert.ok(liveApi?.api && typeof liveApi.csrf === 'string', 'A real authenticated API context is required');
  const { key, runtime = 'php', source, create, timeoutMs = 300000, dns: dnsMode = { mode: 'external' }, mail = { mode: 'none' }, database = { mode: 'none' }, cleanupOnly = false } = options;
  assert.match(key ?? '', KEY);
  assert.ok(['php', 'static', 'node', 'python'].includes(runtime), 'Unsupported owned runtime');
  assert.ok(process.env.YUNPANEL_AUDIT_RUN_DIR && path.basename(RUN_DIR) !== 'current', 'Use an explicit fresh audit run directory');
  assert.ok(RUN_DIR.startsWith(path.resolve('.local') + path.sep), 'Audit evidence must stay in the private local directory');
  const run = manifest(); const ip = await target();
  assert.equal(run.origin, ORIGIN); assert.equal(run.target, ip);
  assert.ok(typeof run.runId === 'string' && run.runId.length > 4);
  const directory = path.join(RUN_DIR, 'owned-fixtures'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, key + '.json');
  let ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  let activeInput;
  const call = async (method, endpoint, data) => {
    assert.ok(endpoint.startsWith('/api/'), 'Expected a panel API route');
    let response;
    for (let attempt = 0; ; attempt++) {
      try { response = await liveApi.api.fetch(endpoint, { method, data, headers: { Origin: ORIGIN, 'x-csrf-token': liveApi.csrf }, maxRedirects: 0, timeout: 120000 }); }
      catch { if (method === 'GET' && attempt < 3) { await wait(700); continue; } throw Object.assign(new Error(`Owned fixture transport failed: ${method} ${endpoint.split('?')[0]}`), { code: 'owned_fixture_transport' }); }
      if (method === 'GET' && [502, 503, 504].includes(response.status()) && attempt < 3) { await wait(700); continue; }
      break;
    }
    const body = await response.json().catch(() => null);
    return { status: response.status(), body, data: body?.data ?? body };
  };
  function save() {
    const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
  }
  function record(kind, data = {}) { ledger.events.push({ kind, at: new Date().toISOString(), ...publicValue(data) }); save(); }
  function rememberInput(input) {
    assert.ok(input && UUID.test(input.operationId));
    assert.equal(input.serverId, ledger.serverId); assert.equal(input.name, ledger.hostname); assert.equal(input.primaryDomain, ledger.hostname);
    assert.equal(input.source?.kind, 'new_' + runtime); assert.ok(input.parentDomainId == null);
    // Password-bearing UI fields are kept only in memory, never in the durable public identity ledger.
    activeInput = structuredClone(input); ledger.operationId = input.operationId;
    ledger.input = structuredClone(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'siteAdmin')));
    publicValue(ledger.input); save();
  }
  const servers = checked(await call('GET', '/api/panel/servers'), 'server inventory');
  assert.equal(servers.length, 1); assert.match(servers[0].id, UUID);
  if (!ledger) {
    assert.equal(cleanupOnly, false, 'No owned ledger exists for cleanup');
    const sites = checked(await call('GET', '/api/panel/websites'), 'site baseline');
    const repos = checked(await call('GET', '/api/panel/backups/repositories'), 'repository baseline');
    const nonce = randomBytes(5).toString('hex');
    const hostname = `ypaudit-${key.toLowerCase()}-${nonce}.${ip}.sslip.io`;
    assert.ok(!sites.some(s => s.name === hostname));
    ledger = { key, runId: run.runId, target: ip, origin: ORIGIN, nonce, runtime, hostname, serverId: servers[0].id,
      baselineSiteIds: sites.filter(s => !/^ypaudit-/.test(s.name)).map(s => s.id), baselineRepositories: repos.map(r => r.id), events: [], createdAt: new Date().toISOString() };
    ledger.baselineHttp = [];
    const domains = checked(await call('GET', '/api/panel/domains'), 'HTTP sibling baseline');
    for (const domain of domains.filter(d => ledger.baselineSiteIds.includes(d.websiteId))) {
      try {
        await hostAtTarget(domain.primaryDomain, ip);
        const reply = await requestHost(ip, domain.primaryDomain, '/', { timeoutMs: 10000 });
        if (reply.status === 200) ledger.baselineHttp.push({ hostname: domain.primaryDomain, status: reply.status });
      } catch { /* External or initially unavailable siblings are never used as healthy HTTP controls. */ }
    }
    const selectedSource = source ?? (runtime === 'php' || runtime === 'static' ? { kind: 'new_' + runtime } : null);
    assert.ok(selectedSource && selectedSource.kind === 'new_' + runtime, 'Node/Python require an explicit normal source configuration');
    rememberInput({ operationId: randomUUID(), serverId: ledger.serverId, name: hostname, primaryDomain: hostname,
      parentDomainId: null, wwwMode: 'none', httpsMode: 'off', source: selectedSource,
      database, mail, dns: dnsMode });
  } else {
    assert.equal(ledger.key, key); assert.equal(ledger.runId, run.runId); assert.equal(ledger.serverId, servers[0].id);
    assert.equal(ledger.origin, ORIGIN); assert.equal(ledger.target, ip); assert.equal(ledger.runtime, runtime);
    assert.equal(ledger.hostname, `ypaudit-${key.toLowerCase()}-${ledger.nonce}.${ip}.sslip.io`);
    assert.ok(cleanupOnly || !ledger.removed, 'This fixture is already removed; use a new key for a new lifecycle');
    activeInput = ledger.input;
  }
  await hostAtTarget(ledger.hostname, ip);
  const endpoint = suffix => '/api/panel/websites/' + ledger.websiteId + (suffix ?? '');
  function bindPreview(preview) {
    assert.equal(preview.operationId, ledger.operationId);
    assert.match(preview.ids?.websiteId ?? '', UUID); assert.match(preview.ids?.applicationId ?? '', UUID); assert.match(preview.ids?.primaryDomainId ?? '', UUID);
    assert.ok(!ledger.baselineSiteIds.includes(preview.ids.websiteId));
    ledger.websiteId = preview.ids.websiteId; ledger.applicationId = preview.ids.applicationId; ledger.domainId = preview.ids.primaryDomainId;
    ledger.provisioningId = preview.provisioning?.operationId ?? ledger.provisioningId;
    if (ledger.provisioningId) assert.match(ledger.provisioningId, UUID);
    save();
  }
  async function recoverCreation() {
    const preview = checked(await call('POST', '/api/panel/sites/create-preview', { input: activeInput }), 'recover exact create preview');
    bindPreview(preview);
    const latest = await call('GET', '/api/panel/sites/' + ledger.websiteId + '/provisioning/latest');
    if (latest.status === 200) {
      const operation = latest.data.operation ?? latest.data; assert.equal(operation.websiteId, ledger.websiteId);
      if (ledger.provisioningId) assert.equal(operation.operationId, ledger.provisioningId);
      assert.match(operation.operationId, UUID); ledger.provisioningId = operation.operationId; save(); return true;
    }
    return false;
  }
  if (cleanupOnly && ledger.provisioningId !== ledger.operationId) assert.ok(await recoverCreation(), 'The UI creation identity could not be recovered for cleanup');
  if (!cleanupOnly) {
  if (!ledger.createSent) {
    const preview = checked(await call('POST', '/api/panel/sites/create-preview', { input: activeInput }), 'site preview'); bindPreview(preview);
    ledger.createSent = true; save();
    let created;
    try {
      created = create ? await create(activeInput, preview, rememberInput) : checked(await call('POST', '/api/panel/sites', { input: activeInput, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'site create', [200, 201]);
      if (created?.created && typeof created.created === 'object' && created?.input) { rememberInput(created.input); created = created.created; }
      if (create && ledger.operationId !== preview.operationId) {
        const actualPreview = checked(await call('POST', '/api/panel/sites/create-preview', { input: activeInput }), 'UI identity preview'); bindPreview(actualPreview);
      }
      assert.equal(created.website?.id, ledger.websiteId); assert.equal(created.website?.name, ledger.hostname);
      assert.equal(created.application?.id ?? created.website?.applicationId, ledger.applicationId);
      ledger.provisioningId = created.provisioning?.operationId ?? ledger.provisioningId; assert.match(ledger.provisioningId ?? '', UUID);
      record('created', { websiteId: ledger.websiteId, provisioningId: ledger.provisioningId });
    } catch (error) {
      if (error?.code !== 'owned_fixture_transport') throw error;
      record('create-response-uncertain');
      if (!await recoverCreation()) throw error;
    }
  } else if (!ledger.provisioningId || !ledger.ready) {
    assert.ok(await recoverCreation(), 'A prior create is uncertain; do not send another creation request');
  }
  assert.match(ledger.websiteId, UUID); assert.match(ledger.applicationId, UUID); assert.match(ledger.domainId, UUID);
  const provisionPath = '/api/panel/sites/provisioning/' + ledger.provisioningId;
  const deadline = Date.now() + timeoutMs; let lastAdvance = null; let busyRetries = 0;
  while (!ledger.ready && Date.now() < deadline) {
    let state = checked(await call('GET', provisionPath), 'provisioning'); assert.equal(state.websiteId, ledger.websiteId); assert.equal(state.operationId, ledger.provisioningId);
    const failed = state.steps.find(s => s.required && ['failed', 'blocked', 'compensation_failed'].includes(s.state));
    if (failed) { record('provisioning-failed', { step: failed.id, state: failed.state, error: failed.error }); throw new Error(`Required provisioning failed: ${failed.id} ${failed.error ?? failed.state}; owned ledger retained`); }
    if (state.ready) { ledger.ready = true; save(); break; }
    const idle = state.steps.every(s => ['pending', 'succeeded'].includes(s.state));
    const stamp = JSON.stringify(state.steps.map(s => [s.id, s.state]));
    if (idle && stamp !== lastAdvance) {
      lastAdvance = stamp;
      try {
        const result = await call('POST', provisionPath + '/continue', { confirmation: 'continue-site-provisioning:' + ledger.provisioningId });
        if (result.status === 409 && codeOf(result.body) === 'site_mutation_locked') {
          // The server rejected this call before execution. Read the same operation before a bounded retry.
          assert.ok(busyRetries < 10, 'Provisioning remained busy after bounded authoritative reads');
          busyRetries += 1; lastAdvance = null;
          record('provisioning-busy', { operationId: ledger.provisioningId, code: codeOf(result.body), readRetry: busyRetries });
          await wait(800);
        } else { checked(result, 'provisioning continue', [200, 202]); busyRetries = 0; }
      } catch (error) { if (error?.code !== 'owned_fixture_transport') throw error; record('provisioning-response-uncertain'); }
    }
    await wait(700);
  }
  assert.equal(ledger.ready, true, 'Provisioning did not finish before the test deadline');
  }
  const siteResponse = await call('GET', endpoint());
  if (!cleanupOnly || siteResponse.status === 200) {
  const site = checked(siteResponse, 'owned site identity');
  assert.equal(site.id, ledger.websiteId); assert.equal(site.name, ledger.hostname); assert.equal(site.serverId, ledger.serverId);
  assert.equal(site.applicationId, ledger.applicationId); assert.match(site.unixUser ?? '', USER);
  ledger.unixUser = site.unixUser; ledger.documentRoot = site.documentRoot; save();
  } else assert.equal(siteResponse.status, 404);
  const fixture = {
    get ledger() { return structuredClone(ledger); }, api: liveApi.api, csrf: liveApi.csrf, call, record,
    endpoint, route: (tab = 'overview') => '/websites/' + ledger.domainId + '/' + tab,
    waitJob: async (id, duration = timeoutMs) => {
      assert.match(id, UUID); const stop = Date.now() + duration;
      while (Date.now() < stop) { const job = checked(await call('GET', '/api/panel/jobs/' + id), 'job read'); if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job; await wait(700); }
      throw new Error('Owned durable job did not finish before the test deadline');
    },
    upload: async (name, data) => checked(await call('PUT', endpoint('/files/upload?path=' + encodeURIComponent(name)), Buffer.isBuffer(data) ? data : Buffer.from(data)), 'file upload', [200, 201]),
    readText: async name => checked(await call('GET', endpoint('/files/text?path=' + encodeURIComponent(name))), 'file read'),
    deleteFile: async name => checked(await call('DELETE', endpoint('/files'), { path: name, confirmation: `delete:${ledger.websiteId}:${name}` }), 'file delete'),
    http: async (pathname = '/', opts = {}) => { await hostAtTarget(ledger.hostname, ip); const reply = await requestHost(ip, ledger.hostname, pathname, opts); if (opts.status != null) assert.equal(reply.status, opts.status); if (opts.contains != null) assert.ok(reply.body.includes(opts.contains)); return reply; },
    remove: async () => {
      assert.ok(!ledger.baselineSiteIds.includes(ledger.websiteId));
      const current = await call('GET', endpoint());
      if (current.status === 200) {
        assert.equal(current.data.name, ledger.hostname); assert.equal(current.data.id, ledger.websiteId);
        const repos = checked(await call('GET', '/api/panel/backups/repositories'), 'owned repositories');
        const ownedRepos = repos.filter(r => r.name === 'website-' + ledger.websiteId);
        for (const repo of ownedRepos) {
          assert.ok(!ledger.baselineRepositories.includes(repo.id)); assert.equal(repo.serverId, ledger.serverId); assert.match(repo.id, UUID);
          assert.equal(repo.backend, 'local'); assert.equal(repo.target, '/var/lib/yunpanel/backups/restic/repos/' + repo.id);
          const snapshots = checked(await call('GET', '/api/panel/backups/repositories/' + repo.id + '/snapshots'), 'owned snapshots');
          assert.ok(snapshots.every(s => s.tags?.includes('website:' + ledger.websiteId)), 'Backup ownership could not be proved');
          ledger.backups ??= []; if (!ledger.backups.some(r => r.id === repo.id)) ledger.backups.push({ id: repo.id, target: repo.target, snapshotCount: snapshots.length }); save();
        }
        const preview = checked(await call('GET', endpoint('/removal')), 'removal preview');
        let operation = (preview.operations ?? []).find(o => o.status !== 'removed');
        if (!operation) {
          assert.equal(preview.preview?.readyToStart, true, 'Normal removal is blocked; dependencies must be resolved through the panel');
          try { const started = checked(await call('POST', endpoint('/removal'), { previewDigest: preview.preview.previewDigest, confirmation: preview.preview.confirmation }), 'removal start', [200, 201, 202]); operation = started.operation ?? started; }
          catch (error) { if (error?.code !== 'owned_fixture_transport') throw error; const reread = checked(await call('GET', endpoint('/removal')), 'read uncertain removal'); operation = (reread.operations ?? []).find(o => o.websiteId === ledger.websiteId); assert.ok(operation, 'Removal response lost without a durable journal; ledger retained'); }
        }
        assert.equal(operation.websiteId, ledger.websiteId); assert.match(operation.id, /^ws-rem-[a-f0-9-]{36}$/i);
        ledger.removalId = operation.id; save();
        let last = null; const stop = Date.now() + timeoutMs;
        while (Date.now() < stop) {
          operation = checked(await call('GET', '/api/panel/website-removal-operations/' + ledger.removalId), 'removal journal');
          assert.equal(operation.websiteId, ledger.websiteId); if (operation.status === 'removed') break;
          const step = operation.steps?.find(s => s.status !== 'succeeded');
          const failure = operation.steps?.find(s => ['failed', 'blocked'].includes(s.status));
          if (failure) throw new Error(`Owned removal stopped: ${failure.kind} ${failure.error?.code ?? failure.status}`);
          const confirmation = operation.actions?.stepContinuationConfirmation; const stamp = step?.id + ':' + operation.updatedAt;
          if (step && confirmation && stamp !== last) {
            last = stamp;
            try { const advanced = await call('POST', '/api/panel/website-removal-operations/' + ledger.removalId + '/continue', { expectedUpdatedAt: operation.updatedAt, stepId: step.id, confirmation });
              if (![200, 201, 202].includes(advanced.status) && !['website_removal_busy', 'website_removal_step_continuation_stale'].includes(codeOf(advanced.body))) checked(advanced, 'removal continue');
            } catch (error) { if (error?.code !== 'owned_fixture_transport') throw error; record('removal-response-uncertain'); }
          }
          await wait(700);
        }
        assert.equal(operation.status, 'removed', 'Normal owned removal did not finish');
      } else assert.equal(current.status, 404);
      for (const [resource, id] of [['websites', ledger.websiteId], ['domains', ledger.domainId], ['applications', ledger.applicationId]]) assert.equal((await call('GET', '/api/panel/' + resource + '/' + id)).status, 404, 'Owned resource remains after removal');
      const survivors = checked(await call('GET', '/api/panel/websites'), 'sibling preservation');
      assert.ok(ledger.baselineSiteIds.every(id => survivors.some(s => s.id === id)), 'A baseline sibling disappeared');
      for (const sibling of ledger.baselineHttp ?? []) { await hostAtTarget(sibling.hostname, ip); assert.equal((await requestHost(ip, sibling.hostname, '/')).status, sibling.status, 'A previously healthy sibling HTTP response changed'); }
      for (const repo of ledger.backups ?? []) {
        const url = '/api/panel/backups/repositories/' + repo.id; const currentRepo = await call('GET', url);
        if (currentRepo.status === 200) { assert.equal(currentRepo.data.name, 'website-' + ledger.websiteId); assert.equal(currentRepo.data.target, repo.target); checked(await call('DELETE', url), 'owned backup metadata removal', [200, 204]); }
        else assert.equal(currentRepo.status, 404);
        assert.equal((await call('GET', url)).status, 404); repo.metadataRemoved = true; repo.physicalCleanupRequired = true;
      }
      ledger.removed = true; record('removed', { websiteDomainApplicationAbsent: true, siblingsPreserved: true, baselineSiblingCount: ledger.baselineSiteIds.length }); return structuredClone(ledger);
    },
  };
  fixture.cleanup = fixture.remove;
  return fixture;
}

export async function cleanupOwnedFixture(liveApi, { key, timeoutMs } = {}) {
  assert.match(key ?? '', KEY);
  const ledger = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'owned-fixtures', key + '.json'), 'utf8'));
  const fixture = await createOwnedFixture(liveApi, { key, runtime: ledger.runtime, timeoutMs, cleanupOnly: true });
  return fixture.remove();
}

export function readOnlyHostProbe(fixture, name) {
  const ledger = fixture.ledger;
  assert.ok(['nginx-config', 'owned-site-files', 'lifecycle-absence', 'node-environment'].includes(name), 'Unknown read-only probe');
  assert.match(ledger.websiteId, UUID); assert.match(ledger.applicationId, UUID); assert.match(ledger.domainId, UUID); assert.match(ledger.unixUser, USER);
  assert.match(ledger.hostname, /^ypaudit-[a-z0-9.-]+\.157\.180\.11\.28\.sslip\.io$/);
  assert.equal(envFile('.local/test-server.env').YUNPANEL_TEST_SERVER_HOST, ledger.target);
  const helper = process.env.YUNPANEL_AUDIT_HOST_HELPER;
  assert.ok(helper, 'Set an explicit private, pinned test-host helper for physical probes');
  const absolute = fs.realpathSync(path.resolve(helper)); assert.ok(absolute.startsWith(fs.realpathSync('.local') + path.sep));
  assert.ok(fs.statSync(absolute).isFile() && ['.py', '.mjs'].includes(path.extname(absolute)), 'Unsupported private host helper');
  const contract = createWebsitePathContract(ledger);
  const payload = Buffer.from(JSON.stringify({ name, applicationId: ledger.applicationId, hostname: ledger.hostname,
    unixUser: ledger.unixUser, documentRoot: ledger.documentRoot, ip: ledger.target,
    nginxName: 'yunpanel-' + nginxConfigFileName(ledger.hostname),
    roots: [contract.runtime.applicationRoot, contract.workspace.homeDirectory, contract.static.buildRoot, contract.static.publishRoot],
    pools: [phpFpmPoolName(ledger.unixUser), elFinderFpmPoolName(ledger.unixUser)],
    socketPaths: [phpFpmSocketPath(ledger.unixUser), elFinderFpmSocketPath(ledger.unixUser)],
  })).toString('base64');
  const code = String.raw`import os,sys,json,base64,hashlib,stat,pwd,grp,glob,re,subprocess
p=json.loads(base64.b64decode(sys.argv[1])); assert p['ip']=='157.180.11.28'
addresses=json.loads(subprocess.check_output(['ip','-j','-4','addr'],text=True))
assert any(a.get('local')==p['ip'] for i in addresses for a in i.get('addr_info',[]))
u=p['unixUser']; host=p['hostname']; app=p['applicationId']; root=p.get('documentRoot')
assert re.fullmatch(r'yunapp-[a-z0-9]{8,32}',u) and re.fullmatch(r'ypaudit-[a-z0-9.-]+\.157\.180\.11\.28\.sslip\.io',host)
if root: assert any(root==r or root.startswith(r+'/') for r in p['roots']) and '..' not in root.split('/')
def meta(f):
 try:
  s=os.lstat(f);return {'path':f,'exists':True,'regular':stat.S_ISREG(s.st_mode),'symlink':stat.S_ISLNK(s.st_mode),'uid':s.st_uid,'gid':s.st_gid,'mode':s.st_mode&4095,'bytes':s.st_size}
 except FileNotFoundError:return {'path':f,'exists':False}
try: account=pwd.getpwnam(u); uid=account.pw_uid
except KeyError: account=None;uid=None
try: group=grp.getgrnam(u).gr_gid
except KeyError: group=None
if p['name']=='nginx-config':
 f='/etc/nginx/sites-enabled/'+p['nginxName'];m=meta(f)
 if m.get('regular') and not m.get('symlink'):
  data=open(f,'rb').read();m['sha256']=hashlib.sha256(data).hexdigest();hit=re.search(rb'client_max_body_size\s+(\d+)[mM]\s*;',data);m['clientMaxBodySizeMb']=int(hit[1]) if hit else None
 print(json.dumps(m))
else:
 roots=list(dict.fromkeys([x for x in [root]+p['roots'] if x]))
 fpm=[f for base in p['pools'] for f in glob.glob('/etc/php/*/fpm/pool.d/'+base+'.conf')]
 sockets=[f for f in p['socketPaths'] if os.path.lexists(f)]
 resolved=os.path.realpath(root) if root else None
 result={'unixUserExists':account is not None,'unixGroupExists':group is not None,'uid':uid,'unixUid':uid,'gid':group,'resolvedRoot':resolved,'roots':[meta(x) for x in roots],'documentRoot':meta(root) if root else None,'currentResolvedRoot':resolved,'currentSymlink':os.path.islink(root) if root else False,'currentLinkTarget':os.readlink(root) if root and os.path.islink(root) else None,'indexJsFile':meta(os.path.join(root,'index.js')) if root else None,'indexFile':meta(os.path.join(root,'index.html')) if root else None,'phpIndexFile':meta(os.path.join(root,'index.php')) if root else None,'fpmFiles':fpm,'sockets':sockets,'nginxFiles':[meta('/etc/nginx/'+d+'/'+p['nginxName']) for d in ['sites-available','sites-enabled']],'mounts':[s.split(' - ')[0].split()[4] for s in open('/proc/self/mountinfo') if u in s or app in s]}
 if p['name']=='node-environment':
  rows=[]
  for proc in glob.glob('/proc/[0-9]*'):
   try:
    if uid is None or os.stat(proc).st_uid!=uid or os.path.basename(os.readlink(proc+'/exe')) not in ['node','nodejs']:continue
    cwd=os.path.realpath(os.readlink(proc+'/cwd'))
    assert cwd and any(cwd==r or cwd.startswith(r+'/') for r in p['roots'])
    values=open(proc+'/environ','rb').read().split(b'\0');v=next((s.split(b'=',1)[1] for s in values if s.startswith(b'YP_T887_ENV_PROOF=')),None)
    rows.append({'pid':int(os.path.basename(proc)),'uid':uid,'cwd':cwd,'proofSha256':hashlib.sha256(v).hexdigest() if v is not None else None})
   except (OSError,PermissionError):pass
  result['processes']=rows
 include='/etc/yunpanel/passenger-env/'+app+'.conf'
 try:
  with open(include) as handle:first=handle.readline().strip()
  hit=re.fullmatch(r'# YunPanel Passenger environment ([a-f0-9-]{36}) revision ([0-9]+)',first)
  result['environmentIncludeApplicationId']=hit[1] if hit else None;result['environmentIncludeRevision']=int(hit[2]) if hit else None
 except FileNotFoundError:result['environmentIncludeApplicationId']=None;result['environmentIncludeRevision']=None
 print(json.dumps(result))`;
  const command = 'python3 -c ' + "'" + code.replaceAll("'", "'\\''") + "' '" + payload + "'";
  try {
    const output = execFileSync(path.extname(absolute) === '.py' ? 'python3' : process.execPath, [absolute, command], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(output);
  } catch { throw new Error('The pinned read-only host probe failed; protected diagnostics withheld'); }
}
