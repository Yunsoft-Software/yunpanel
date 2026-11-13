import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test, expect, apiContext, manifest, privateJson, ORIGIN } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';
import { createWebsitePathContract } from '../../packages/host-runtime/src/website-path-contract.js';
import { phpFpmSocketPath } from '../../packages/config-templates/src/index.js';
import { elFinderFpmSocketPath } from '../../packages/config-templates/src/elfinder-fpm.js';

const TARGET = '157.180.11.28', SERVICE = 'php8.3-fpm.service';
const PINNED_HELPER = path.resolve('.local/reinstall-20261011/host.py');
const HELPER_SHA = 'd69ac81f74b24aefa379a3556e6b72966acab8ffb3be55774cd4673b1be11fa7';
const hash = value => createHash('sha256').update(value).digest('hex');
const proof = { sourceSha256: hash(fs.readFileSync(new URL(import.meta.url))),
  helperSha256: hash(fs.readFileSync(new URL('./owned-fixture.js', import.meta.url))),
  service: SERVICE, historical502Cause: 'OPEN', phases: [], cleanups: [] };
export const openAcceptances = [
  { id: 'T897.historical502-cause', reason: 'A fresh retirement invariant test does not identify the cause of the historical first502.' },
  { id: 'T897.fault-injection', reason: 'Crash, inactive-service and tampered foreign/retained receipt channels require a supported real channel; no fake service or root state mutation is used.' },
];
let actor, original;
const owned = [];
const accepted = reply => { expect(reply.status, reply.body?.error?.code).toBe(200); return reply.data; };
async function get(route) {
  const reply = await actor.api.get(route, { timeout: 10000, maxRedirects: 0, headers: { Connection: 'close' } });
  return { status: reply.status(), data: (await reply.json().catch(() => null))?.data };
}

function exclusiveWindow() {
  for (const name of ['sunucu-28-1', 'sunucu-28-2', 'sunucu-28-3', 'sunucu-28-genel']) {
    expect(fs.readFileSync(path.join('tasks/locks', name, 'owner'), 'utf8').split('|')[0],
      'Shared-service journal attribution requires one root operator').toBe('AGENT_4');
  }
}

// Only the real pinned helper is allowed. This probe reads no configuration contents,
// environment, request payload, journal MESSAGE or private receipt into its output.
function fpmRead(fixtures, afterCursor = null, completionId = null) {
  exclusiveWindow(); expect(fs.realpathSync(PINNED_HELPER)).toBe(PINNED_HELPER);
  expect(hash(fs.readFileSync(PINNED_HELPER))).toBe(HELPER_SHA);
  const rows = fixtures.map(fixture => {
    const l = fixture.ledger;
    return { websiteId: l.websiteId, applicationId: l.applicationId, operationId: l.provisioningId,
      unixUser: l.unixUser, runtime: l.runtime, target: l.target,
      phpSocket: phpFpmSocketPath(l.unixUser), elfinderSocket: elFinderFpmSocketPath(l.unixUser) };
  });
  const payload = Buffer.from(JSON.stringify({ rows, afterCursor, completionId })).toString('base64');
  const python = String.raw`import os,sys,json,re,stat,hashlib,subprocess,base64
x=json.loads(base64.b64decode(sys.argv[1]));unit='php8.3-fpm.service'
uuid=re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
addresses=json.loads(subprocess.check_output(['ip','-j','-4','addr'],text=True))
assert any(a.get('local')=='157.180.11.28' for i in addresses for a in i.get('addr_info',[]))
for row in x['rows']:
 assert row['target']=='157.180.11.28' and all(uuid.fullmatch(row[k]) for k in ['websiteId','applicationId','operationId'])
 assert row['unixUser']=='yunapp-'+hashlib.sha256(row['applicationId'].encode()).hexdigest()[:12]
 assert row['phpSocket']=='/run/php/yunpanel-'+row['unixUser']+'.sock'
 assert row['elfinderSocket']=='/run/php/yunpanel-elfinder-'+row['unixUser']+'.sock'
pid=subprocess.check_output(['/usr/bin/systemctl','show',unit,'--property=MainPID','--value'],text=True).strip()
assert re.fullmatch('[1-9][0-9]*',pid)
assert subprocess.run(['/usr/bin/systemctl','is-active','--quiet',unit],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
raw=subprocess.check_output(['/usr/bin/ss','-H','-xlpn'],text=True);assert len(raw.encode())<=1048576
listeners=[]
for line in raw.splitlines():
 if not re.search(r'\bpid='+pid+r',',line):continue
 fields=line.split();assert 'LISTEN' in fields
 names=[v for v in fields if v.startswith('/')];assert len(names)==1
 name=names[0];assert re.fullmatch(r'/[A-Za-z0-9._/-]+',name) and os.path.normpath(name)==name
 meta=os.lstat(name);assert stat.S_ISSOCK(meta.st_mode) and not stat.S_ISLNK(meta.st_mode)
 listeners.append({'path':name,'uid':meta.st_uid,'gid':meta.st_gid,'mode':stat.S_IMODE(meta.st_mode)})
assert listeners and len({v['path'] for v in listeners})==len(listeners)
arguments=['/usr/bin/journalctl','--no-pager','-u',unit,'-o','json','-n','512']
if x['afterCursor']:
 assert isinstance(x['afterCursor'],str) and len(x['afterCursor'])<=2048 and not any(c.isspace() for c in x['afterCursor'])
 arguments+=['--after-cursor='+x['afterCursor']]
journal=subprocess.check_output(arguments,text=True);assert len(journal.encode())<=2097152
records=[json.loads(line) for line in journal.splitlines() if line.strip()]
if x['afterCursor']:assert len(records)<512,'A saturated journal window cannot prove an exact reload count'
def completion(record):
 return record.get('_PID')=='1' and record.get('UNIT')==unit and isinstance(record.get('MESSAGE'),str) and record['MESSAGE'].startswith('Reloaded '+unit)
completed=[r for r in records if completion(r)]
identity=x['completionId']
if identity is None:
 assert completed,'A real current systemd reload-completion event is required for calibration'
 identity=completed[-1].get('MESSAGE_ID');assert isinstance(identity,str) and re.fullmatch('[a-f0-9]{32}',identity)
else:assert re.fullmatch('[a-f0-9]{32}',identity)
assert all(r.get('MESSAGE_ID')==identity for r in completed)
cursor=records[-1].get('__CURSOR') if records else x['afterCursor'];assert isinstance(cursor,str) and cursor
owned_receipts=[]
for row in x['rows']:
 p='/var/lib/yunpanel/staging/elfinder-fpm-sites/'+row['operationId']+'.json'
 assert os.path.realpath(p)==p
 parent=os.path.dirname(p)
 while True:
  ancestor=os.lstat(parent);assert stat.S_ISDIR(ancestor.st_mode) and not stat.S_ISLNK(ancestor.st_mode) and ancestor.st_uid==0 and ancestor.st_gid==0 and not stat.S_IMODE(ancestor.st_mode)&0o022
  if parent=='/':break
  parent=os.path.dirname(parent)
 def receiptIdentity(meta):return (meta.st_dev,meta.st_ino,meta.st_mode,meta.st_uid,meta.st_gid,meta.st_nlink,meta.st_size,meta.st_mtime_ns,meta.st_ctime_ns)
 try:fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 except FileNotFoundError:
  owned_receipts.append({'websiteId':row['websiteId'],'operationId':row['operationId'],'absent':True});continue
 try:
  meta=os.fstat(fd);assert stat.S_ISREG(meta.st_mode) and meta.st_uid==0 and meta.st_gid==0 and stat.S_IMODE(meta.st_mode)==0o600 and meta.st_nlink==1 and meta.st_size<=65536
  with os.fdopen(fd,'rb',closefd=False) as handle:raw=handle.read(65537)
  assert len(raw)<=65536 and len(raw)==meta.st_size and receiptIdentity(os.fstat(fd))==receiptIdentity(meta) and receiptIdentity(os.lstat(p))==receiptIdentity(meta)
 finally:os.close(fd)
 receipt=json.loads(raw)
 assert all(receipt[k]==row[k] for k in ['websiteId','applicationId','unixUser','operationId'])
 owned_receipts.append({'websiteId':row['websiteId'],'operationId':row['operationId'],'state':receipt['state'],'mutated':receipt['mutated'],'previousConfigIsNull':receipt['previousConfig'] is None,'configSha256':receipt['configSha256'],'receiptSha256':hashlib.sha256(raw).hexdigest()})
print(json.dumps({'serviceUnit':unit,'mainPid':int(pid),'listeners':sorted(listeners,key=lambda v:v['path']),'journalCursor':cursor,'reloadCompletionMessageId':identity,'reloadCompletions':[{'cursor':r['__CURSOR'],'monotonicTimestamp':r.get('__MONOTONIC_TIMESTAMP'),'realtimeTimestamp':r.get('__REALTIME_TIMESTAMP')} for r in completed],'ownedReceipts':owned_receipts}))
`;
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let result;
  try {
    result = JSON.parse(execFileSync('python3', [PINNED_HELPER, 'python3 -c ' + quote(python) + ' ' + quote(payload)],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 3 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch { throw new Error('The exact pinned FPM read-only observation failed; protected details withheld'); }
  expect(hash(fs.readFileSync(PINNED_HELPER))).toBe(HELPER_SHA); exclusiveWindow(); return result;
}

async function originalHttp(scheme) {
  const hostname = original.hostname;
  const addresses = await dns.lookup(hostname, { all: true });
  expect(addresses.length).toBeGreaterThan(0); expect(addresses.every(row => row.address === TARGET)).toBe(true);
  return new Promise((resolve, reject) => {
    const client = scheme === 'https' ? https : http;
    const req = client.get({ hostname: TARGET, port: scheme === 'https' ? 443 : 80, path: '/', agent: false,
      headers: { Host: hostname, Connection: 'close' }, timeout: 15000,
      ...(scheme === 'https' ? { servername: hostname, rejectUnauthorized: true,
        checkServerIdentity: (servername, cert) => servername === hostname ? checkServerIdentity(hostname, cert) : new Error('Original sibling TLS identity changed') } : {}),
    }, response => {
      let bytes = 0; const locations = [], tlsVerified = scheme === 'https' ? response.socket?.authorized === true : null;
      for (let n = 0; n < response.rawHeaders.length; n += 2) if (response.rawHeaders[n].toLowerCase() === 'location') locations.push(response.rawHeaders[n + 1]);
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 4194304) req.destroy(new Error('Original sibling response exceeded')); });
      response.on('end', () => resolve({ status: response.statusCode, locations, tlsVerified }));
      response.on('error', () => reject(new Error('Original sibling response failed')));
    });
    req.on('timeout', () => req.destroy(new Error('Original sibling response timed out')));
    req.on('error', () => reject(new Error('Original sibling canonical request failed')));
  });
}

async function preserveOriginal(phase, first = null) {
  const actual = first ?? await originalHttp(original.scheme);
  proof.phases.push({ phase, original: actual }); expect(actual.status).toBe(200);
  if (original.scheme === 'https') expect(actual.tlsVerified).toBe(true);
  const rows = accepted(await get('/api/panel/websites'));
  expect(original.websiteIds.every(id => rows.some(row => row.id === id))).toBe(true);
  for (const [resource, id] of original.identities) expect((await get('/api/panel/' + resource + '/' + id)).status).toBe(200);
}

async function dynamic(entry, phase) {
  const response = await entry.fixture.http('/' + entry.filename + '?phase=' + encodeURIComponent(phase) + '&nonce=' + randomBytes(6).toString('hex'));
  const result = { key: entry.key, phase, status: response.status, cacheControl: response.headers['cache-control'] ?? null };
  proof.phases.push(result);
  expect(response.status, 'First real dynamic PHP response, no retry').toBe(200);
  const body = JSON.parse(response.body);
  expect(body.nonce).toBe(entry.nonce); expect(body.uid).toBe(entry.uid);
  expect(body.sapi).toBe('fpm-fcgi'); expect(body.phpVersion).toBe('8.3');
  expect((response.headers['cache-control'] ?? '').split(',').map(v => v.trim())).toContain('no-store');
  Object.assign(result, { nonceSha256: hash(body.nonce), unixUid: body.uid, sapi: body.sapi, phpVersion: body.phpVersion });
}

async function verifyRemoval(entry, ledger) {
  expect(entry.verificationAttempted, 'A failed physical verification is retained, not retried').not.toBe(true);
  entry.verificationAttempted = true;
  const first = entry.originalFirst ?? (original ? await originalHttp(original.scheme) : null);
  const actual = readOnlyHostProbe({ ledger }, 'lifecycle-absence'), contract = createWebsitePathContract(ledger);
  const roots = [ledger.documentRoot, contract.runtime.applicationRoot, contract.workspace.homeDirectory, contract.static.buildRoot, contract.static.publishRoot];
  expect(actual.roots.map(row => row.path).sort()).toEqual([...new Set(roots)].sort());
  expect(actual.roots.every(row => !row.exists)).toBe(true);
  expect(actual.unixUserExists).toBe(false); expect(actual.unixGroupExists).toBe(false);
  expect(actual.fpmFiles).toEqual([]); expect(actual.sockets).toEqual([]); expect(actual.mounts).toEqual([]);
  expect(actual.nginxFiles).toHaveLength(2); expect(actual.nginxFiles.every(row => !row.exists)).toBe(true);
  for (const [resource, id] of [['websites', ledger.websiteId], ['domains', ledger.domainId], ['applications', ledger.applicationId]]) expect((await get('/api/panel/' + resource + '/' + id)).status).toBe(404);
  entry.removed = true; proof.cleanups.push({ key: entry.key, threeMetadata404: true, physicalAbsent: true });
  if (first) await preserveOriginal('cleanup-' + entry.key, first);
}
async function cleanup(entry) {
  if (entry.removed) return;
  expect(entry.cleanupAttempted, 'An uncertain removal is retained and never blindly retried').not.toBe(true);
  entry.cleanupAttempted = true;
  const ledger = entry.fixture ? await entry.fixture.cleanup() : await cleanupOwnedFixture(actor, { key: entry.key });
  entry.removalLedger = ledger;
  await verifyRemoval(entry, ledger);
}

test.beforeAll(async () => {
  exclusiveWindow(); actor = await apiContext(); expect(actor.session.user.role).toBe('owner');
  const run = manifest(); expect(run.target).toBe(TARGET);
  const response = await actor.api.get('/api/panel/websites'); expect(response.status()).toBe(200);
  const rows = (await response.json()).data, php = rows.find(row => row.id === run.existingPhpWebsiteId); assert.ok(php);
  original = { hostname: run.existingPhpDomain, scheme: 'http', websiteIds: rows.map(row => row.id),
    identities: [['websites', php.id], ['applications', php.applicationId], ['domains', run.existingPhpDomainId]] };
  const first = await originalHttp('http');
  if (first.status !== 200) {
    expect([301, 308]).toContain(first.status); expect(first.locations).toHaveLength(1);
    const target = first.locations[0]; assert.ok(typeof target === 'string' && target.length < 2048 && !/[\u0000-\u0020\u007f@?#]/.test(target));
    expect(new URL(target).href).toBe('https://' + original.hostname + '/'); original.scheme = 'https';
  }
  const version = await actor.api.get('/api/panel/system/diagnostics/version'); expect(version.status()).toBe(200);
  const deployed = (await version.json()).data; expect(deployed.commit).toBe(run.sourceCommit); expect(deployed.sourceInfo.sourceMatchesDeployed).toBe(true);
  proof.run = { runId: run.runId, sourceCommit: run.sourceCommit, actualBuildCommit: deployed.commit, buildId: deployed.buildId, assetId: deployed.assetId };
});
test.afterAll(async () => {
  test.setTimeout(600000); const errors = [];
  for (const entry of [...owned].reverse()) {
    if (entry.cleanupAttempted && !entry.removed) { errors.push({ key: entry.key, retainedUncertainCleanup: true }); continue; }
    try { await cleanup(entry); } catch (error) { errors.push({ key: entry.key, errorKind: error.name }); }
  }
  proof.cleanupFailures = errors; privateJson('t897-native-fpm-retirement.json', proof);
  await actor?.api.dispose(); expect(errors, 'Exact owned resources must be removed through normal lifecycle').toEqual([]);
});

test('@mutation normal static removal reloads shared FPM once and preserves two fresh PHP siblings', async ({}, info) => {
  test.setTimeout(900000); let failure;
  try {
    for (const kind of ['php-a', 'php-b', 'static']) {
      const entry = { key: 't897-' + kind + '-cr-w' + info.workerIndex }; owned.push(entry);
      entry.fixture = await createOwnedFixture(actor, { key: entry.key, runtime: kind === 'static' ? 'static' : 'php' });
      const metadata = readOnlyHostProbe(entry.fixture, 'owned-site-files');
      expect(metadata.unixUserExists).toBe(true); expect(metadata.uid).toBeGreaterThan(0); entry.uid = metadata.uid;
      if (kind !== 'static') {
        entry.nonce = randomBytes(18).toString('hex'); entry.filename = 'index.php';
        const php = "<?php header('Content-Type: application/json'); header('Cache-Control: no-store'); echo json_encode(['nonce'=>'" + entry.nonce + "','uid'=>posix_geteuid(),'sapi'=>php_sapi_name(),'phpVersion'=>PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION]);";
        await entry.fixture.upload(entry.filename, php);
        const uploaded = readOnlyHostProbe(entry.fixture, 'owned-site-files');
        expect(uploaded.phpIndexFile?.uid).toBe(entry.uid);
        await dynamic(entry, 'initial');
      }
    }
    const siblings = owned.slice(0, 2), retiring = owned[2];
    await preserveOriginal('before-removal');
    const before = fpmRead(owned.map(entry => entry.fixture));
    proof.before = before;
    for (const entry of siblings) {
      expect(before.listeners.some(row => row.path === phpFpmSocketPath(entry.fixture.ledger.unixUser))).toBe(true);
      await dynamic(entry, 'before-static-removal');
    }
    const retiringSocket = elFinderFpmSocketPath(retiring.fixture.ledger.unixUser);
    const protectedListeners = before.listeners.filter(row => row.path !== retiringSocket);
    expect(before.listeners.some(row => row.path === retiringSocket)).toBe(true);
    expect(protectedListeners.length).toBeGreaterThanOrEqual(4);
    retiring.cleanupAttempted = true;
    const removed = await retiring.fixture.cleanup(); retiring.removalLedger = removed;
    // Collect the earliest actual dynamic responses before slow journal/config inspection.
    const firstReads = await Promise.allSettled([...siblings.map(entry => dynamic(entry, 'first-after-static-removal')),
      originalHttp(original.scheme).then(result => { retiring.originalFirst = result; })]);
    let firstError = firstReads.find(row => row.status === 'rejected')?.reason, after;
    try { after = fpmRead(owned.map(entry => entry.fixture), before.journalCursor, before.reloadCompletionMessageId); proof.after = after; }
    catch (error) { firstError ??= error; }
    try { await verifyRemoval(retiring, removed); } catch (error) { firstError ??= error; }
    if (firstError) throw firstError;
    expect(after.reloadCompletions, 'One normal static retirement must issue exactly one shared FPM reload').toHaveLength(1);
    expect(after.listeners.some(row => row.path === retiringSocket)).toBe(false);
    for (const listener of protectedListeners) expect(after.listeners.find(row => row.path === listener.path)).toEqual(listener);
    const operation = accepted(await retiring.fixture.call('GET', '/api/panel/website-removal-operations/' + removed.removalId));
    expect(operation.websiteId).toBe(removed.websiteId); expect(operation.status).toBe('removed');
    for (const kind of ['file_cleanup', 'unix_identity_cleanup']) expect(operation.steps.find(row => row.kind === kind)?.status).toBe('succeeded');
    // Re-reading the already removed public lifecycle must not issue another reload.
    // The manager's two normal calls are exercised by file/Unix cleanup above;
    // this public no-op is not claimed as a direct extra manager invocation.
    await retiring.fixture.cleanup();
    const noopReads = await Promise.allSettled(siblings.map(entry => dynamic(entry, 'first-after-public-removal-noop')));
    const noopError = noopReads.find(row => row.status === 'rejected')?.reason;
    if (noopError) throw noopError;
    const noop = fpmRead(owned.map(entry => entry.fixture), after.journalCursor, before.reloadCompletionMessageId);
    proof.publicRemovalNoop = noop;
    expect(noop.reloadCompletions).toEqual([]);
    proof.retirement = { exactReloadCount: after.reloadCompletions.length, twoCleanupStepsVerified: true,
      protectedListenerCount: protectedListeners.length, actualListenerReadiness: true, historical502Cause: 'OPEN' };
  } catch (error) { failure = error; }
  finally {
    for (const entry of [...owned].reverse()) if (!entry.cleanupAttempted) {
      try { await cleanup(entry); } catch (error) { failure ??= error; }
    }
    privateJson('t897-native-fpm-retirement.json', proof);
  }
  if (failure) throw failure;
});
