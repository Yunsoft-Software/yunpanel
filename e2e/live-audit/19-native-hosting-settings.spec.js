import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, expect, apiContext, ready, main, RUN_DIR } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

const nodeSource = { kind: 'new_node', repositoryUrl: 'https://github.com/heroku/node-js-getting-started.git', branch: 'main', retention: 2,
  runtime: { nodeMajor: 24, installMode: 'ci', buildScript: null, startMode: 'node', entryFile: 'index.js', healthPath: '/', healthTimeoutSeconds: 30, restartPolicy: 'on-failure' } };
const accepted = (result, status = 200) => { expect(result.status, result.body?.error?.code).toBe(status); return result.data; };
const domainPath = fixture => '/api/panel/domains/' + fixture.ledger.domainId;
async function uploadOwned(fixture, filename, value) {
  try { await fixture.upload(filename, value); }
  catch (error) {
    if (error.code !== 'owned_fixture_transport') throw error;
    let readback;
    try { readback = await fixture.readText(filename); }
    catch { fixture.record('files.upload.unconfirmed', { filename, receiptKnown: false }); throw error; }
    const sha256 = createHash('sha256').update(value).digest('hex');
    expect(readback.sha256).toBe(sha256); expect(readback.content).toBe(Buffer.from(value).toString('utf8'));
    fixture.record('files.upload.reconciled', { filename, sha256, receiptKnown: false, actualContentVerified: true });
  }
}
async function currentDomain(fixture) {
  const domain = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(domain.websiteId).toBe(fixture.ledger.websiteId); expect(domain.primaryDomain).toBe(fixture.ledger.hostname); return domain;
}
async function publish(fixture, settings) {
  const root = domainPath(fixture), before = await currentDomain(fixture);
  // PATCH merges settings. A legacy PHP envelope omits cache, so clearing a
  // cache introduced by this test requires an explicit canonical null value.
  const desired = before.targetType === 'php'
    ? { ...settings, staticAssetCacheSeconds: settings.staticAssetCacheSeconds ?? null }
    : settings;
  if (!isDeepStrictEqual(before.nginxSettings, desired)) {
    const input = { changes: { nginxSettings: desired } };
    const preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await currentDomain(fixture);
  if (pending.state !== 'active' || pending.desiredRevision !== pending.appliedRevision) {
    for (const action of ['stage', 'activate']) {
      const queued = accepted(await fixture.call('POST', root + '/' + action, {}), 202);
      expect((await fixture.waitJob(queued.id)).status).toBe('succeeded');
    }
  }
  const result = await currentDomain(fixture); expect(result.nginxSettings).toEqual(desired);
  expect(result.appliedRevision).toBe(result.desiredRevision); return result;
}

// PRIVATE draft: a real client interruption, not a backend crash or historical receipt conflict.
let interruptionHold=false,interruptionUncertain=false;
const interruptionSha=value=>createHash('sha256').update(value).digest('hex');
const interruptionIdentity=f=>Object.fromEntries(['key','runId','nonce','serverId','websiteId','applicationId','domainId','unixUser','documentRoot','hostname'].map(key=>[key,f.ledger[key]]));
function interruptionTuple(s){return[s.dev,s.ino,s.mode,s.uid,s.gid,s.nlink,s.size,s.mtimeMs,s.ctimeMs];}
function interruptionReadCheckpoint(file,sha256){
 const before=fs.lstatSync(file);const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const first=fs.fstatSync(fd);expect(first.isFile()).toBe(true);expect(first.mode&0o777).toBe(0o600);expect(first.uid).toBe(process.getuid());expect(first.nlink).toBe(1);expect(first.size).toBeGreaterThan(0);expect(first.size).toBeLessThan(65536);expect(interruptionTuple(before)).toEqual(interruptionTuple(first));
  const buffer=Buffer.alloc(65536),length=fs.readSync(fd,buffer,0,buffer.length,0),bytes=buffer.subarray(0,length);expect(length).toBe(first.size);expect(interruptionTuple(fs.fstatSync(fd))).toEqual(interruptionTuple(first));expect(interruptionTuple(fs.lstatSync(file))).toEqual(interruptionTuple(first));expect(interruptionSha(bytes)).toBe(sha256);return JSON.parse(bytes.toString('utf8'));
 }finally{fs.closeSync(fd);}
}
function interruptionCheckpoint(f,data){
 const bytes=Buffer.from(JSON.stringify({version:1,identity:interruptionIdentity(f),...data}));expect(bytes.length).toBeLessThan(65536);
 const file=path.join(RUN_DIR,'t883-client-checkpoint-'+f.ledger.nonce+'-'+randomBytes(6).toString('hex')+'.json');const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const sha256=interruptionSha(bytes);interruptionReadCheckpoint(file,sha256);f.record('client-interruption.checkpoint',{sha256,websiteId:f.ledger.websiteId,domainId:f.ledger.domainId,contextClosed:false});return{file,sha256};
}
async function interruptionMutation(f,method,endpoint,data,status=200){
 expect(interruptionUncertain,'UNKNOWN_KEEP forbids another mutation').toBe(false);interruptionUncertain=true;const reply=await f.call(method,endpoint,data);const result=accepted(reply,status);if(status!==202)interruptionUncertain=false;return result;
}
function interruptionJobBinding(job,expected,terminal=false){
 expect(Object.fromEntries(['id','serverId','type','operation','resourceType','resourceId','createdAt'].map(key=>[key,job?.[key]]))).toEqual(expected);
 if(terminal)expect(job.status).toBe('succeeded');return job;
}
async function interruptionDomainJob(f,action){
 const acceptedJob=await interruptionMutation(f,'POST',domainPath(f)+'/'+action,{},202),id=acceptedJob?.id;expect(id).toMatch(/^[a-f0-9-]{36}$/i);expect(Number.isFinite(Date.parse(acceptedJob.createdAt))).toBe(true);
 const expected=Object.freeze({id,serverId:f.ledger.serverId,type:'domain.'+action,operation:'domain.'+action,resourceType:'domain',resourceId:f.ledger.domainId,createdAt:acceptedJob.createdAt});interruptionJobBinding(acceptedJob,expected);
 const terminal=await f.waitJob(id,120000);interruptionJobBinding(terminal,expected,true);interruptionUncertain=false;f.record('client-interruption.job',{...expected,status:terminal.status});return expected;
}
async function interruptionDomain(f){
 const value=accepted(await f.call('GET',domainPath(f)));expect(value.id).toBe(f.ledger.domainId);expect(value.serverId).toBe(f.ledger.serverId);expect(value.websiteId).toBe(f.ledger.websiteId);expect(value.primaryDomain).toBe(f.ledger.hostname);return value;
}
async function interruptionWebsite(f){
 const value=accepted(await f.call('GET',f.endpoint()));expect(value.id).toBe(f.ledger.websiteId);expect(value.applicationId).toBe(f.ledger.applicationId);expect(value.serverId).toBe(f.ledger.serverId);expect(value.unixUser).toBe(f.ledger.unixUser);expect(value.documentRoot).toBe(f.ledger.documentRoot);return value;
}
async function interruptionConfig(f){const value=readOnlyHostProbe(f,'nginx-config');expect(value.regular).toBe(true);expect(value.symlink).toBe(false);expect(value.uid).toBe(0);expect(value.mode&0o022).toBe(0);expect(value.sha256).toMatch(/^[a-f0-9]{64}$/);return value;}
async function interruptionUpload(f,name,content){
 expect(accepted(await f.call('GET',f.endpoint('/files'))).entries.some(entry=>entry.name===name)).toBe(false);expect(interruptionUncertain).toBe(false);interruptionUncertain=true;await uploadOwned(f,name,content);const read=await f.readText(name);expect(read.sha256).toBe(interruptionSha(content));interruptionUncertain=false;return{name,sha256:read.sha256};
}
async function interruptionDelete(f,file){
 const read=await f.readText(file.name);expect(read.sha256).toBe(file.sha256);expect(interruptionUncertain).toBe(false);interruptionUncertain=true;await f.deleteFile(file.name);expect(accepted(await f.call('GET',f.endpoint('/files'))).entries.some(entry=>entry.name===file.name)).toBe(false);interruptionUncertain=false;
}
async function interruptionRebind(current,old){
 const identity=interruptionIdentity(old);expect(old.ledger.ready).toBe(true);expect(old.ledger.provisioningId).toBe(old.ledger.operationId);
 const fresh=await createOwnedFixture(current,{key:identity.key,runtime:old.ledger.runtime,cleanupOnly:true});expect(interruptionIdentity(fresh)).toEqual(identity);await interruptionWebsite(fresh);return fresh;
}
async function interruptionPublish(f,original){
 await interruptionDomain(f);const settings={...original};
 const input={changes:{nginxSettings:settings}},preview=await interruptionMutation(f,'POST',domainPath(f)+'/update-preview',input);
 await interruptionMutation(f,'PATCH',domainPath(f),{...input,previewDigest:preview.previewDigest,confirmation:preview.confirmation});await interruptionDomainJob(f,'stage');await interruptionDomainJob(f,'activate');
 const after=await interruptionDomain(f);expect(after.nginxSettings).toEqual(settings);expect(after.state).toBe('active');expect(after.appliedRevision).toBe(after.desiredRevision);return after;
}
async function interruptionOwnerContext(){try{return native19GuardOwnerContext(await apiContext());}catch{throw new Error('Fresh normal Owner context could not be verified; protected details withheld');}}
async function interruptionPhpProbe(f){
 const php=accepted(await f.call('GET',f.endpoint('/php-tools/config')));expect(php.phpVersion).toMatch(/^\d+\.\d+$/);const uid=readOnlyHostProbe(f,'owned-site-files').uid;expect(uid).toBeGreaterThan(0);const marker='T883-CLIENT-'+f.ledger.nonce,name='yp-client-'+randomBytes(6).toString('hex')+'.php';
 const content='<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(["marker"=>'+JSON.stringify(marker)+',"version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);';
 return{...(await interruptionUpload(f,name,content)),uid,marker,version:php.phpVersion};
}
async function interruptionFirstPhp(f,proof){const first=await f.http('/'+proof.name);expect(first.status,'The first dynamic sibling reply must succeed without retry').toBe(200);expect(first.headers['cache-control']).toContain('no-store');expect(JSON.parse(first.body)).toEqual({marker:proof.marker,version:proof.version,uid:proof.uid,sapi:'fpm-fcgi'});f.record('client-interruption.first-php',{verified:true,version:proof.version,uid:proof.uid,sapi:'fpm-fcgi',firstHttpStatus:first.status});}
function interruptionDomainStamp(value){return Object.fromEntries(['id','websiteId','serverId','state','desiredRevision','stagedRevision','appliedRevision','stagedChecksum','appliedChecksum','updatedAt'].map(key=>[key,value[key]]));}
async function interruptionVerify(f,checkpoint){
 expect(interruptionIdentity(f)).toEqual(checkpoint.identity);await interruptionWebsite(f);const current=await interruptionDomain(f);expect(interruptionDomainStamp(current)).toEqual(checkpoint.domain);expect(current.nginxSettings).toEqual(checkpoint.stagedSettings);expect((await interruptionConfig(f)).sha256).toBe(checkpoint.activeSha256);
 const job=accepted(await f.call('GET','/api/panel/jobs/'+checkpoint.stageJob.id));interruptionJobBinding(job,checkpoint.stageJob,true);
 for(const file of checkpoint.files)expect((await f.readText(file.name)).sha256).toBe(file.sha256);return current;
}

// Synchronous gate delegates the actual Owner API client; no request/reply is substituted.
let native19StickyHold = false, native19CaseActive = false, native19CleanupActive = false, native19CleanupAuthorized = false;
let native19DispatchPhase = 'work', native19CleanupKey = null, native19CleanupBodyVerified = false, native19CleanupComplete = false;
const native19CleanupTitle = '@mutation removes every exact owned hosting fixture and proves physical absence';
const native19StartedCases = new Set(), native19CompletedCases = new Set(), native19ForwardIntents = new Map(), native19CleanupVerifiedKeys = new Set();
function native19Keep(reason) {
  native19StickyHold = true; native19DispatchPhase = 'hold'; native19CaseActive = false; native19CleanupActive = false; native19CleanupAuthorized = false;
  const file = RUN_DIR + '/native19-dispatch-suite-keep.json';
  if (!fs.existsSync(file)) native19DispatchArtifact('suite', 'keep', { version: 1, outcome: 'UNKNOWN_KEEP', reason, observedAt: new Date().toISOString(), automaticRetry: false });
}
function native19CleanupLedger(key) {
  expect(key).toMatch(/^[a-z0-9][a-z0-9-]{1,100}$/);
  const file = path.join(RUN_DIR, 'owned-fixtures', key + '.json'); expect(fs.realpathSync(file)).toBe(file);
  const before = fs.lstatSync(file), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const m = fs.fstatSync(fd); expect(m.isFile()).toBe(true); expect(m.uid).toBe(process.getuid()); expect(m.nlink).toBe(1); expect(m.mode & 0o777).toBe(0o600); expect(m.size).toBeLessThan(4194304);
    expect(interruptionTuple(m)).toEqual(interruptionTuple(before)); const bytes = fs.readFileSync(fd); expect(bytes.length).toBe(m.size);
    expect(interruptionTuple(fs.fstatSync(fd))).toEqual(interruptionTuple(m)); expect(interruptionTuple(fs.lstatSync(file))).toEqual(interruptionTuple(m));
    const ledger = JSON.parse(bytes); expect(ledger.key).toBe(key); expect(ledger.target).toBe('157.180.11.28'); expect(ledger.origin).toBe('https://server.cryptoraichu.website');
    for (const field of ['websiteId', 'domainId', 'applicationId', 'serverId']) expect(ledger[field]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ledger.baselineSiteIds).not.toContain(ledger.websiteId); return ledger;
  } finally { fs.closeSync(fd); }
}
function native19DispatchArtifact(id, suffix, value) {
  expect(fs.realpathSync(RUN_DIR)).toBe(RUN_DIR);
  const root = fs.lstatSync(RUN_DIR); expect(root.isDirectory()).toBe(true); expect(root.isSymbolicLink()).toBe(false);
  expect(root.uid).toBe(process.getuid()); expect(root.mode & 0o777).toBe(0o700);
  const name = RUN_DIR + '/native19-dispatch-' + id + '-' + suffix + '.json';
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { const meta = fs.fstatSync(fd); expect(meta.isFile()).toBe(true); expect(meta.uid).toBe(process.getuid()); expect(meta.nlink).toBe(1); expect(meta.mode & 0o777).toBe(0o600);
    const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBeLessThan(4096); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); expect(fs.fstatSync(fd).size).toBe(bytes.length);
  } finally { fs.closeSync(fd); }
  const directory = fs.openSync(RUN_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function native19SynchronousDispatchGate(method, route) {
  try {
    expect(native19StickyHold, 'UNKNOWN_KEEP forbids any subsequent mutation dispatch').toBe(false);
    expect([...native19ForwardIntents.values()].every(value => value.responseKnown), 'Every prior actual mutation dispatch must have a known HTTP response').toBe(true);
    if (native19DispatchPhase === 'work') {
      expect(native19CaseActive, 'A late continuation cannot dispatch after the active case ended').toBe(true);
    } else {
      expect(native19DispatchPhase).toBe('cleanup'); expect(native19CleanupAuthorized).toBe(true); expect(native19CleanupActive).toBe(true); expect(native19CaseActive).toBe(false);
      expect(native19CompletedCases.size).toBe(10); expect([...native19StartedCases].every(value => native19CompletedCases.has(value))).toBe(true);
      expect(typeof native19CleanupKey).toBe('string');
      const ledger = native19CleanupLedger(native19CleanupKey);
      const allowed = method === 'POST' && route === '/api/panel/websites/' + ledger.websiteId + '/removal'
        || method === 'POST' && /^ws-rem-[a-f0-9-]{36}$/.test(ledger.removalId ?? '') && route === '/api/panel/website-removal-operations/' + ledger.removalId + '/continue'
        || method === 'DELETE' && (ledger.backups ?? []).some(repo => repo.target === '/var/lib/yunpanel/backups/restic/repos/' + repo.id && route === '/api/panel/backups/repositories/' + repo.id);
      expect(allowed, 'Only this current exact recorded owned fixture normal removal flow is authorized').toBe(true);
    }
  } catch (error) { native19Keep('dispatch-gate'); throw error; }
}
function native19BeginDispatch(method, endpoint) {
  const route = String(endpoint).split('?')[0]; expect(route.startsWith('/api/')).toBe(true);
  native19SynchronousDispatchGate(method, route);
  const id = randomBytes(12).toString('hex'), intent = Object.freeze({ version: 1, id, method, route, phase: native19DispatchPhase, issuedAt: new Date().toISOString() });
  const record = { intent, responseKnown: false, status: null }; native19ForwardIntents.set(id, record);
  native19DispatchArtifact(id, 'intent', intent); return record;
}
function native19DispatchResponse(record, response) {
  const status = response.status(); expect(Number.isSafeInteger(status)).toBe(true);
  native19DispatchArtifact(record.intent.id, 'response', { version: 1, id: record.intent.id, status, observedAt: new Date().toISOString() });
  record.status = status; record.responseKnown = true; return response;
}
function native19DispatchUnknown(record) {
  native19Keep('mutation-transport-unknown');
  native19DispatchArtifact(record.intent.id, 'unknown', { version: 1, id: record.intent.id, observedAt: new Date().toISOString(), outcome: 'UNKNOWN_KEEP' });
}
function native19GuardOwnerContext(context) {
  const actual = context.api;
  const guarded = new Proxy(actual, { get(target, key) {
    const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
    if (!['fetch', 'post', 'put', 'patch', 'delete'].includes(key)) return value.bind(target);
    return (...args) => {
      const method = key === 'fetch' ? String(args[1]?.method ?? 'GET').toUpperCase() : String(key).toUpperCase();
      if (['GET', 'HEAD'].includes(method)) return value.apply(target, args);
      const record = native19BeginDispatch(method, args[0]);
      // No await, timer, request rewrite or substitute transport between gate and delegation.
      try { return value.apply(target, args).then(response => native19DispatchResponse(record, response), error => { native19DispatchUnknown(record); throw error; }); }
      catch (error) { native19DispatchUnknown(record); throw error; }
    };
  } });
  return { ...context, api: guarded };
}

test.describe('T887 native owned hosting settings', () => {
  let actor, projectName; const sites = new Map(), originals = new Map(), keys = new Set();
  async function site(kind) {
    if (!sites.has(kind)) {
      const key = 't887-hosting-' + kind + '-' + projectName; keys.add(key);
      const fixture = await createOwnedFixture(actor, { key, runtime: kind, ...(kind === 'node' ? { source: nodeSource } : {}) });
      sites.set(kind, fixture); originals.set(kind, (await currentDomain(fixture)).nginxSettings);
      if (kind !== 'node') await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 owned ' + kind + ' hosting</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return sites.get(kind);
  }
  test.beforeAll(async ({}, info) => {
    expect(fs.existsSync(RUN_DIR + '/native19-dispatch-suite-started.json'), 'A previous worker attempt is KEEP; never replay this suite in the same run').toBe(false);
    expect(fs.existsSync(RUN_DIR + '/native19-dispatch-suite-keep.json')).toBe(false);
    native19DispatchArtifact('suite', 'started', { version: 1, project: info.project.name, workerIndex: info.workerIndex, observedAt: new Date().toISOString(), automaticRetry: false });
    projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = native19GuardOwnerContext(await apiContext());
  });
  test.beforeEach(async ({}, info) => {
    expect(native19StickyHold).toBe(false); expect(native19CaseActive).toBe(false); expect(native19CleanupActive).toBe(false);
    if (info.title === native19CleanupTitle) {
      expect(native19DispatchPhase).toBe('work'); expect(native19StartedCases.size).toBe(10); expect(native19CompletedCases.size).toBe(10);
      expect([...native19StartedCases].every(value => native19CompletedCases.has(value))).toBe(true);
      expect(interruptionHold).toBe(false); expect(interruptionUncertain).toBe(false); expect([...native19ForwardIntents.values()].every(value => value.responseKnown)).toBe(true);
      native19DispatchPhase = 'cleanup'; native19CleanupAuthorized = true; native19CleanupActive = true;
    } else {
      expect(native19DispatchPhase).toBe('work'); expect(native19StartedCases.has(info.title)).toBe(false); native19StartedCases.add(info.title); native19CaseActive = true;
    }
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== 'passed' || info.expectedStatus !== 'passed' || native19StickyHold || interruptionHold || interruptionUncertain || [...native19ForwardIntents.values()].some(value => !value.responseKnown)) {
      native19Keep('case-failed-timeout-or-unknown'); return;
    }
    if (info.title === native19CleanupTitle) {
      expect(native19CleanupBodyVerified).toBe(true); native19CleanupComplete = true; native19CleanupActive = false; native19CleanupAuthorized = false;
    } else { native19CompletedCases.add(info.title); native19CaseActive = false; }
  });
  test.afterAll(async ({}, info) => {
    // Close synchronously BEFORE the first await; late GET continuations cannot delegate a mutation.
    const complete = native19CleanupComplete && !native19StickyHold && !interruptionHold && !interruptionUncertain && native19CompletedCases.size === 10 && native19CleanupVerifiedKeys.size === 4 && [...native19ForwardIntents.values()].every(value => value.responseKnown) && info.status === 'passed';
    native19DispatchPhase = 'closed'; native19CaseActive = false; native19CleanupActive = false; native19CleanupAuthorized = false; native19CleanupKey = null;
    if (!complete) native19Keep('suite-closure-incomplete');
    try { await actor?.api.dispose(); } catch (error) { native19Keep('context-close-failed'); throw error; }
    expect(complete, 'UNKNOWN_KEEP: every case and exact cleanup proof must finish; afterAll performs no removal').toBe(true);
    expect(keys.size).toBe(4); for (const key of keys) expect(native19CleanupLedger(key).removed).toBe(true);
    native19DispatchArtifact('suite', 'complete', { version: 1, outcome: 'COMPLETE', completedCases: native19CompletedCases.size, exactFixturesCleaned: native19CleanupVerifiedKeys.size, observedAt: new Date().toISOString(), automaticRetry: false });
  });

  test('@mutation reconciles only this run ledger hosting draft and removes only its recorded health file', async () => {
    test.setTimeout(480000);
    for (const kind of ['php', 'node', 'static']) {
    const fixture = await site(kind), original = originals.get(kind);
    const filename = 'yp-t887-recovery-' + randomBytes(6).toString('hex') + '.html';
    fixture.record('hosting.recovery.intent', { runtime: kind, filename, originalSettings: original });
    fixture.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '19-native-hosting-settings.spec.js',
      historicalTitle: '@mutation source recovers only the recorded owned hosting drafts from the interrupted acceptance run',
      reason: 'The October candidate ledger is intentionally retired. This fresh ledger reconciliation covers current normal recovery; an actual interrupted old run cannot be recreated without restoring the prohibited acceptance environment.',
      requiredChannel: 'Owned interrupted current-run recovery through normal API' });
    try {
      await uploadOwned(fixture, filename, '<p>owned recovery</p>');
      await publish(fixture, { ...original, clientMaxBodySizeMb: 17 });
      expect((await readOnlyHostProbe(fixture, 'nginx-config')).clientMaxBodySizeMb).toBe(17);
      await publish(fixture, original); await fixture.deleteFile(filename);
      const listing = accepted(await fixture.call('GET', fixture.endpoint('/files')));
      expect(listing.entries.some(entry => entry.name === filename)).toBe(false);
      expect((await fixture.http('/')).status).toBe(200);
      fixture.record('hosting.recovery.current-ledger', { runtime: kind, verified: true });
    } finally { await publish(fixture, original); }
    }
  });

  for (const kind of ['php', 'node', 'static']) test('@mutation ' + kind + ' hosting saves once and changes actual response headers body limits and cache', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site(kind), before = await currentDomain(fixture), original = before.nginxSettings;
    expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
    expect(original.headers.some(header => header.name.toLowerCase() === 'x-yunpanel-t887')).toBe(false);
    const headerValue = 't887-' + kind + '-' + randomBytes(6).toString('hex'); let css, cacheBaseline, failure;
    const cssBody = 'body{color:#123}';
    fixture.record('hosting.ui.original', { runtime: kind, nginxSettings: original });
    try {
      if (['php', 'static'].includes(kind)) {
        expect(original.staticAssetCacheSeconds ?? null).not.toBe(120);
        css = 'yp-t887-' + randomBytes(6).toString('hex') + '.css';
        await uploadOwned(fixture, css, cssBody);
        const baseline = await fixture.http('/' + css);
        expect(baseline.status).toBe(200); expect(baseline.body).toBe(cssBody);
        cacheBaseline = baseline.headers['cache-control'] ?? null;
        expect((cacheBaseline ?? '').split(',').map(value => value.trim().toLowerCase())).not.toContain('max-age=120');
        fixture.record('hosting.ui.cache-baseline', { runtime: kind, filename: css, cacheControl: cacheBaseline });
      }
      await ready(page, fixture.route('hosting'));
      await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true }).fill('2');
      await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
      const index = original.headers.length + 1;
      await page.getByLabel('Başlık ' + index + ' adı', { exact: true }).fill('X-YunPanel-T887');
      await page.getByLabel('Başlık ' + index + ' değeri', { exact: true }).fill(headerValue);
      // PHP gained static-cache controls after the retired October scenario.
      if (['php', 'static'].includes(kind)) await page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true }).fill('120');
      else await expect(page.getByLabel('Statik dosya önbelleği (saniye)', { exact: true })).toHaveCount(0);
      if (kind === 'static') await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
      else await expect(page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Uygulama yanıt süresi (saniye)', { exact: true })).toHaveCount(0);
      const offset = page.auditTraffic.length;
      const stageResponse = page.waitForResponse(response => new URL(response.url()).pathname === domainPath(fixture) + '/stage' && response.request().method() === 'POST', { timeout: 120000 }).catch(error => ({ transportError: error }));
      await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
      const staged = await stageResponse; if (staged.transportError) throw staged.transportError;
      const stageBody = await staged.json();
      fixture.record('hosting.ui.stage-response', { runtime: kind, status: staged.status(), errorCode: stageBody.error?.code ?? null });
      expect(staged.status(), stageBody.error?.code).toBe(202);
      await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
      const root = domainPath(fixture), mutations = page.auditTraffic.slice(offset).filter(entry => entry.method !== 'GET' && entry.path.startsWith(root));
      for (const endpoint of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(entry => entry.path === root + endpoint)).toHaveLength(1);
      const saved = await currentDomain(fixture); expect(saved.nginxSettings.clientMaxBodySizeMb).toBe(2);
      expect(saved.appliedRevision).toBe(saved.desiredRevision);
      expect(saved.nginxSettings.headers.at(-1)).toEqual({ name: 'X-YunPanel-T887', value: headerValue, always: true });
      const home = await fixture.http('/'); expect(home.status).toBe(200); expect(home.headers['x-yunpanel-t887']).toBe(headerValue);
      const oversized = await fixture.http('/', { method: 'POST', body: Buffer.alloc(3 * 1024 * 1024, 'x') });
      expect(oversized.status).toBe(413); expect(oversized.headers['x-yunpanel-t887']).toBe(headerValue);
      if (kind === 'static') expect((await fixture.http('/yp-t887-missing-' + headerValue)).status).toBe(404);
      if (['php', 'static'].includes(kind)) {
        const asset = await fixture.http('/' + css); expect(asset.status).toBe(200); expect(asset.body).toBe(cssBody);
        expect(asset.headers['cache-control']).toContain('max-age=120');
      }
      await page.reload(); await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toHaveValue('2');
      expect(page.auditErrors).toEqual([]); fixture.record('hosting.ui.http', { runtime: kind, verified: true, phpCacheEvolution: kind === 'php' });
    } catch (error) { failure = error; }
    for (const cleanup of [() => publish(fixture, original), ...(css && cacheBaseline !== undefined ? [async () => {
      const restored = await fixture.http('/' + css);
      expect(restored.status).toBe(200); expect(restored.body).toBe(cssBody);
      expect(restored.headers['cache-control'] ?? null).toBe(cacheBaseline);
      expect(restored.headers['x-yunpanel-t887'] ?? null).toBeNull();
      fixture.record('hosting.ui.cache-restored', { runtime: kind, filename: css, cacheControl: restored.headers['cache-control'] ?? null, verified: true });
    }] : []), ...(css ? [() => fixture.deleteFile(css)] : [])]) {
      try { await cleanup(); }
      catch (error) { fixture.record('hosting.ui.cleanup-failure', { runtime: kind, errorKind: error.name, errorCode: error.code ?? null }); failure ??= error; }
    }
    if (failure) throw failure;
  });

  for (const width of [320, 390, 834, 1440]) test('@mutation hosting settings retain one reachable form at width ' + width, async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await page.setViewportSize({ width, height: 1000 });
    await ready(page, fixture.route('hosting'));
    await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
    await expect(page.getByLabel('En büyük yükleme boyutu (MB)', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true })).toHaveCount(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    expect(page.auditErrors).toEqual([]);
  });

  test('@mutation hosting rejects protocol-managed headers before any preview or write request', async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await ready(page, fixture.route('hosting'));
    const current = await currentDomain(fixture), index = current.nginxSettings.headers.length + 1;
    await main(page).getByRole('button', { name: 'Yanıt başlığı ekle', exact: true }).click();
    await page.getByLabel('Başlık ' + index + ' adı', { exact: true }).fill('Set-Cookie');
    await page.getByLabel('Başlık ' + index + ' değeri', { exact: true }).fill('invalid=blocked');
    const offset = page.auditTraffic.length;
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    expect(page.auditTraffic.slice(offset).filter(entry => entry.method === 'PATCH' || /\/(?:update-preview|stage|activate)$/.test(entry.path))).toEqual([]);
    expect((await currentDomain(fixture)).nginxSettings).toEqual(current.nginxSettings); expect(page.auditErrors).toEqual([]);
  });
  test('@mutation closes current hosting clients after acknowledged staging and restores each exact PHP Node and static checkpoint',async()=>{
    test.setTimeout(480000);interruptionHold=true;const protectedKey='t883-hosting-protect-'+projectName;keys.add(protectedKey);let protectedPhp=await createOwnedFixture(actor,{key:protectedKey,runtime:'php'});sites.set('protected-php',protectedPhp);const proof=await interruptionPhpProbe(protectedPhp);await interruptionFirstPhp(protectedPhp,proof);
    for(const kind of ['php','node','static']){
      let f=await site(kind);await interruptionWebsite(f);const before=await interruptionDomain(f),initial=await interruptionConfig(f);expect(before.state).toBe('active');expect(before.appliedRevision).toBe(before.desiredRevision);expect(before.appliedChecksum).toBe(initial.sha256);
      const uid=readOnlyHostProbe(f,'owned-site-files').uid;expect(uid).toBeGreaterThan(0);expect(protectedPhp.ledger.websiteId).not.toBe(f.ledger.websiteId);expect(protectedPhp.ledger.applicationId).not.toBe(f.ledger.applicationId);expect(protectedPhp.ledger.domainId).not.toBe(f.ledger.domainId);expect(protectedPhp.ledger.unixUser).not.toBe(f.ledger.unixUser);expect(readOnlyHostProbe(protectedPhp,'owned-site-files').uid).not.toBe(uid);const ownPhpProof=kind==='php'?await interruptionPhpProbe(f):null;if(ownPhpProof)await interruptionFirstPhp(f,ownPhpProof);const file=await interruptionUpload(f,'yp-client-'+randomBytes(6).toString('hex')+'.html','<p>T883-CLIENT-HOSTING-'+f.ledger.nonce+'</p>');
      const input={changes:{nginxSettings:{...before.nginxSettings,clientMaxBodySizeMb:before.nginxSettings.clientMaxBodySizeMb===17?18:17}}},preview=await interruptionMutation(f,'POST',domainPath(f)+'/update-preview',input);
      await interruptionMutation(f,'PATCH',domainPath(f),{...input,previewDigest:preview.previewDigest,confirmation:preview.confirmation});const stageJob=await interruptionDomainJob(f,'stage'),staged=await interruptionDomain(f);expect(staged.state).toBe('staged');expect(staged.desiredRevision).toBeGreaterThan(staged.appliedRevision);expect(staged.stagedRevision).toBe(staged.desiredRevision);expect((await interruptionConfig(f)).sha256).toBe(initial.sha256);
      const saved=interruptionCheckpoint(f,{domain:interruptionDomainStamp(staged),stagedSettings:staged.nginxSettings,originalSettings:before.nginxSettings,activeSha256:initial.sha256,stageJob,files:[file,...(ownPhpProof?[{name:ownPhpProof.name,sha256:ownPhpProof.sha256}]:[])],unixUid:uid,protectedIdentity:interruptionIdentity(protectedPhp)});
      await actor.api.dispose();actor=null;actor=await interruptionOwnerContext();for(const [runtime,old]of [...sites])sites.set(runtime,await interruptionRebind(actor,old));f=sites.get(kind);protectedPhp=sites.get('protected-php');
      const checkpoint=interruptionReadCheckpoint(saved.file,saved.sha256);await interruptionVerify(f,checkpoint);expect(interruptionIdentity(protectedPhp)).toEqual(checkpoint.protectedIdentity);expect(readOnlyHostProbe(f,'owned-site-files').uid).toBe(checkpoint.unixUid);if(ownPhpProof)await interruptionFirstPhp(f,ownPhpProof);await interruptionFirstPhp(protectedPhp,proof);
      await interruptionPublish(f,checkpoint.originalSettings);expect((await interruptionConfig(f)).sha256).toBe(checkpoint.activeSha256);await interruptionFirstPhp(protectedPhp,proof);if(ownPhpProof){await interruptionFirstPhp(f,ownPhpProof);await interruptionDelete(f,ownPhpProof);}await interruptionDelete(f,file);expect((await f.http('/')).status).toBe(200);await interruptionWebsite(f);
      f.record('client-interruption.current-hosting',{runtime:kind,verified:true,checkpointSha256:saved.sha256,initiatingContextDisposed:true,freshContextRebound:true,backendProcessCrash:false,historicalReceiptConflict:false,originalActiveSha256:checkpoint.activeSha256});
    }
    await interruptionDelete(protectedPhp,proof);interruptionHold=false;
  });

  test(native19CleanupTitle, async () => {
    test.setTimeout(480000);
    expect(native19DispatchPhase).toBe('cleanup'); expect(native19CleanupAuthorized).toBe(true); expect(native19CleanupActive).toBe(true); expect(native19StickyHold).toBe(false);
    expect(keys.size).toBe(4); expect(sites.has('protected-php')).toBe(true);
    const failures = [];
    for (const key of [...[...keys].filter(key=>key!==sites.get('protected-php')?.ledger.key).reverse(),...[...keys].filter(key=>key===sites.get('protected-php')?.ledger.key)]) {
      expect(native19StickyHold).toBe(false); expect(native19CleanupActive).toBe(true); native19CleanupKey = key;
      try {
        const fixture = [...sites.values()].find(value => value.ledger.key === key);
        const ledger = fixture ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
        const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
        expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
        expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
        expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
      expect(absent.passengerEnvironmentInclude.path).toBe('/etc/yunpanel/passenger-env/' + ledger.applicationId + '.conf');
      expect(absent.passengerEnvironmentInclude.parentTrustVerified).toBe(true); expect(absent.passengerEnvironmentInclude.exists).toBe(false);
        native19CleanupVerifiedKeys.add(key); native19CleanupKey = null;
      } catch (error) { native19Keep('cleanup-or-physical-proof-failed'); failures.push(error.message); break; }
    }
    expect(failures, 'Every exact owned Website must be cleaned').toEqual([]);
    expect(native19StickyHold).toBe(false); expect(native19CleanupVerifiedKeys.size).toBe(4);
    expect([...native19ForwardIntents.values()].every(value => value.responseKnown)).toBe(true); native19CleanupBodyVerified = true;
  });


});
