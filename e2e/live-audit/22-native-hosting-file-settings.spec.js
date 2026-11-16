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
async function domain(fixture) {
  const value = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(value.websiteId).toBe(fixture.ledger.websiteId); expect(value.primaryDomain).toBe(fixture.ledger.hostname); return value;
}
async function restore(fixture, original, files) {
  const root = domainPath(fixture), settings = { ...original, indexFiles: original.indexFiles ?? null, errorPages: original.errorPages ?? null };
  const current = await domain(fixture);
  if (!isDeepStrictEqual(current.nginxSettings, settings)) {
    const input = { changes: { nginxSettings: settings } }, preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await domain(fixture);
  if (pending.state !== 'active' || pending.appliedRevision !== pending.desiredRevision) for (const action of ['stage', 'activate']) {
    const job = accepted(await fixture.call('POST', root + '/' + action, {}), 202); expect((await fixture.waitJob(job.id)).status).toBe('succeeded');
  }
  const restored = await domain(fixture); expect(restored.nginxSettings).toEqual(settings); expect(restored.appliedRevision).toBe(restored.desiredRevision);
  for (const filename of files) {
    const listing = accepted(await fixture.call('GET', fixture.endpoint('/files')));
    if (listing.entries.some(entry => entry.name === filename)) await fixture.deleteFile(filename);
  }
  expect((await fixture.http('/')).status).toBe(200); fixture.record('hosting.files-restored', { verified: true, files });
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
 const before=await interruptionDomain(f),settings={...original,indexFiles:original.indexFiles??null,errorPages:original.errorPages??null,...(before.targetType==='php'?{staticAssetCacheSeconds:original.staticAssetCacheSeconds??null}:{})};
 const input={changes:{nginxSettings:settings}},preview=await interruptionMutation(f,'POST',domainPath(f)+'/update-preview',input);
 await interruptionMutation(f,'PATCH',domainPath(f),{...input,previewDigest:preview.previewDigest,confirmation:preview.confirmation});await interruptionDomainJob(f,'stage');await interruptionDomainJob(f,'activate');
 const after=await interruptionDomain(f);expect(after.nginxSettings).toEqual(settings);expect(after.state).toBe('active');expect(after.appliedRevision).toBe(after.desiredRevision);return after;
}
async function interruptionOwnerContext(){try{return native22GuardOwnerContext(await apiContext());}catch{throw new Error('Fresh normal Owner context could not be verified; protected details withheld');}}
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
let native22StickyHold = false, native22CaseActive = false, native22CleanupActive = false, native22CleanupAuthorized = false;
let native22DispatchPhase = 'work', native22CleanupKey = null, native22CleanupBodyVerified = false, native22CleanupComplete = false;
const native22CleanupTitle = '@mutation removes every exact owned hosting fixture and proves physical absence';
const native22StartedCases = new Set(), native22CompletedCases = new Set(), native22ForwardIntents = new Map(), native22CleanupVerifiedKeys = new Set();
function native22Keep(reason) {
  native22StickyHold = true; native22DispatchPhase = 'hold'; native22CaseActive = false; native22CleanupActive = false; native22CleanupAuthorized = false;
  const file = RUN_DIR + '/native22-dispatch-suite-keep.json';
  if (!fs.existsSync(file)) native22DispatchArtifact('suite', 'keep', { version: 1, outcome: 'UNKNOWN_KEEP', reason, observedAt: new Date().toISOString(), automaticRetry: false });
}
function native22CleanupLedger(key) {
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
function native22DispatchArtifact(id, suffix, value) {
  expect(fs.realpathSync(RUN_DIR)).toBe(RUN_DIR);
  const root = fs.lstatSync(RUN_DIR); expect(root.isDirectory()).toBe(true); expect(root.isSymbolicLink()).toBe(false);
  expect(root.uid).toBe(process.getuid()); expect(root.mode & 0o777).toBe(0o700);
  const name = RUN_DIR + '/native22-dispatch-' + id + '-' + suffix + '.json';
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { const meta = fs.fstatSync(fd); expect(meta.isFile()).toBe(true); expect(meta.uid).toBe(process.getuid()); expect(meta.nlink).toBe(1); expect(meta.mode & 0o777).toBe(0o600);
    const bytes = Buffer.from(JSON.stringify(value)); expect(bytes.length).toBeLessThan(4096); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); expect(fs.fstatSync(fd).size).toBe(bytes.length);
  } finally { fs.closeSync(fd); }
  const directory = fs.openSync(RUN_DIR, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function native22SynchronousDispatchGate(method, route) {
  try {
    expect(native22StickyHold, 'UNKNOWN_KEEP forbids any subsequent mutation dispatch').toBe(false);
    expect([...native22ForwardIntents.values()].every(value => value.responseKnown), 'Every prior actual mutation dispatch must have a known HTTP response').toBe(true);
    if (native22DispatchPhase === 'work') {
      expect(native22CaseActive, 'A late continuation cannot dispatch after the active case ended').toBe(true);
    } else {
      expect(native22DispatchPhase).toBe('cleanup'); expect(native22CleanupAuthorized).toBe(true); expect(native22CleanupActive).toBe(true); expect(native22CaseActive).toBe(false);
      expect(native22CompletedCases.size).toBe(6); expect([...native22StartedCases].every(value => native22CompletedCases.has(value))).toBe(true);
      expect(typeof native22CleanupKey).toBe('string');
      const ledger = native22CleanupLedger(native22CleanupKey);
      const allowed = method === 'POST' && route === '/api/panel/websites/' + ledger.websiteId + '/removal'
        || method === 'POST' && /^ws-rem-[a-f0-9-]{36}$/.test(ledger.removalId ?? '') && route === '/api/panel/website-removal-operations/' + ledger.removalId + '/continue'
        || method === 'DELETE' && (ledger.backups ?? []).some(repo => repo.target === '/var/lib/yunpanel/backups/restic/repos/' + repo.id && route === '/api/panel/backups/repositories/' + repo.id);
      expect(allowed, 'Only this current exact recorded owned fixture normal removal flow is authorized').toBe(true);
    }
  } catch (error) { native22Keep('dispatch-gate'); throw error; }
}
function native22BeginDispatch(method, endpoint) {
  const route = String(endpoint).split('?')[0]; expect(route.startsWith('/api/')).toBe(true);
  native22SynchronousDispatchGate(method, route);
  const id = randomBytes(12).toString('hex'), intent = Object.freeze({ version: 1, id, method, route, phase: native22DispatchPhase, issuedAt: new Date().toISOString() });
  const record = { intent, responseKnown: false, status: null }; native22ForwardIntents.set(id, record);
  native22DispatchArtifact(id, 'intent', intent); return record;
}
function native22DispatchResponse(record, response) {
  const status = response.status(); expect(Number.isSafeInteger(status)).toBe(true);
  native22DispatchArtifact(record.intent.id, 'response', { version: 1, id: record.intent.id, status, observedAt: new Date().toISOString() });
  record.status = status; record.responseKnown = true; return response;
}
function native22DispatchUnknown(record) {
  native22Keep('mutation-transport-unknown');
  native22DispatchArtifact(record.intent.id, 'unknown', { version: 1, id: record.intent.id, observedAt: new Date().toISOString(), outcome: 'UNKNOWN_KEEP' });
}
function native22GuardOwnerContext(context) {
  const actual = context.api;
  const guarded = new Proxy(actual, { get(target, key) {
    const value = Reflect.get(target, key, target); if (typeof value !== 'function') return value;
    if (!['fetch', 'post', 'put', 'patch', 'delete'].includes(key)) return value.bind(target);
    return (...args) => {
      const method = key === 'fetch' ? String(args[1]?.method ?? 'GET').toUpperCase() : String(key).toUpperCase();
      if (['GET', 'HEAD'].includes(method)) return value.apply(target, args);
      const record = native22BeginDispatch(method, args[0]);
      // No await, timer, request rewrite or substitute transport between gate and delegation.
      try { return value.apply(target, args).then(response => native22DispatchResponse(record, response), error => { native22DispatchUnknown(record); throw error; }); }
      catch (error) { native22DispatchUnknown(record); throw error; }
    };
  } });
  return { ...context, api: guarded };
}

test.describe('T887 native owned index and error preferences', () => {
  let actor, projectName; const sites = new Map(), keys = new Set();
  async function site(kind) {
    if (!sites.has(kind)) {
      const key = 't887-file-settings-' + kind + '-' + projectName; keys.add(key);
      const fixture = await createOwnedFixture(actor, { key, runtime: kind, ...(kind === 'node' ? { source: nodeSource } : {}) });
      sites.set(kind, fixture);
      if (kind !== 'node') await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 original index</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return sites.get(kind);
  }
  test.beforeAll(async ({}, info) => {
    expect(fs.existsSync(RUN_DIR + '/native22-dispatch-suite-started.json'), 'A previous worker attempt is KEEP; never replay this suite in the same run').toBe(false);
    expect(fs.existsSync(RUN_DIR + '/native22-dispatch-suite-keep.json')).toBe(false);
    native22DispatchArtifact('suite', 'started', { version: 1, project: info.project.name, workerIndex: info.workerIndex, observedAt: new Date().toISOString(), automaticRetry: false });
    projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = native22GuardOwnerContext(await apiContext());
  });
  test.beforeEach(async ({}, info) => {
    expect(native22StickyHold).toBe(false); expect(native22CaseActive).toBe(false); expect(native22CleanupActive).toBe(false);
    if (info.title === native22CleanupTitle) {
      expect(native22DispatchPhase).toBe('work'); expect(native22StartedCases.size).toBe(6); expect(native22CompletedCases.size).toBe(6);
      expect([...native22StartedCases].every(value => native22CompletedCases.has(value))).toBe(true);
      expect(interruptionHold).toBe(false); expect(interruptionUncertain).toBe(false); expect([...native22ForwardIntents.values()].every(value => value.responseKnown)).toBe(true);
      native22DispatchPhase = 'cleanup'; native22CleanupAuthorized = true; native22CleanupActive = true;
    } else {
      expect(native22DispatchPhase).toBe('work'); expect(native22StartedCases.has(info.title)).toBe(false); native22StartedCases.add(info.title); native22CaseActive = true;
    }
  });
  test.afterEach(async ({}, info) => {
    if (info.status !== 'passed' || info.expectedStatus !== 'passed' || native22StickyHold || interruptionHold || interruptionUncertain || [...native22ForwardIntents.values()].some(value => !value.responseKnown)) {
      native22Keep('case-failed-timeout-or-unknown'); return;
    }
    if (info.title === native22CleanupTitle) {
      expect(native22CleanupBodyVerified).toBe(true); native22CleanupComplete = true; native22CleanupActive = false; native22CleanupAuthorized = false;
    } else { native22CompletedCases.add(info.title); native22CaseActive = false; }
  });
  test.afterAll(async ({}, info) => {
    // Close synchronously BEFORE the first await; late GET continuations cannot delegate a mutation.
    const complete = native22CleanupComplete && !native22StickyHold && !interruptionHold && !interruptionUncertain && native22CompletedCases.size === 6 && native22CleanupVerifiedKeys.size === 4 && [...native22ForwardIntents.values()].every(value => value.responseKnown) && info.status === 'passed';
    native22DispatchPhase = 'closed'; native22CaseActive = false; native22CleanupActive = false; native22CleanupAuthorized = false; native22CleanupKey = null;
    if (!complete) native22Keep('suite-closure-incomplete');
    try { await actor?.api.dispose(); } catch (error) { native22Keep('context-close-failed'); throw error; }
    expect(complete, 'UNKNOWN_KEEP: every case and exact cleanup proof must finish; afterAll performs no removal').toBe(true);
    expect(keys.size).toBe(4); for (const key of keys) expect(native22CleanupLedger(key).removed).toBe(true);
    native22DispatchArtifact('suite', 'complete', { version: 1, outcome: 'COMPLETE', completedCases: native22CompletedCases.size, exactFixturesCleaned: native22CleanupVerifiedKeys.size, observedAt: new Date().toISOString(), automaticRetry: false });
  });

  test('@mutation reconciles only owned current ledger index and error preferences and exact test files', async () => {
    test.setTimeout(360000);
    for (const kind of ['php', 'static']) {
    const fixture = await site(kind), before = await domain(fixture);
    const suffix = randomBytes(6).toString('hex'), filename = 'yp-index-' + suffix + '.html';
    fixture.record('hosting.files-recovery.intent', { runtime: kind, originalSettings: before.nginxSettings, files: [filename] });
    fixture.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '22-native-hosting-file-settings.spec.js',
      historicalTitle: '@mutation source recovers only recorded owned index/error preferences and their exact test files',
      reason: 'The October candidate ledger is retired. This fresh owned ledger exercises normal reconciliation without recreating an interrupted historical environment.',
      requiredChannel: 'Owned interrupted current-run recovery through normal API' });
    await uploadOwned(fixture, filename, '<p>T887 recovery owned index</p>');
    const root = domainPath(fixture), input = { changes: { nginxSettings: { ...before.nginxSettings, indexFiles: [filename, 'index.html'] } } };
    try {
      const preview = accepted(await fixture.call('POST', root + '/update-preview', input));
      accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
      expect((await domain(fixture)).desiredRevision).toBeGreaterThan((await domain(fixture)).appliedRevision);
      await restore(fixture, before.nginxSettings, [filename]);
      expect(accepted(await fixture.call('GET', fixture.endpoint('/files'))).entries.some(entry => entry.name === filename)).toBe(false);
    } finally { await restore(fixture, before.nginxSettings, [filename]); }
    }
  });

  for (const kind of ['php', 'static']) test('@mutation ' + kind + ' index and error settings change real content while preserving actual HTTP statuses', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site(kind), before = await domain(fixture), suffix = randomBytes(6).toString('hex');
    expect(before.state).toBe('active'); expect(before.appliedRevision).toBe(before.desiredRevision);
    const names = { index: 'yp-index-' + suffix + '.html', error: 'yp-error-' + suffix + '.html', blocked: 'yp-blocked-' + suffix + '.html', status: 'yp-status-' + suffix + '.php' };
    const markers = { index: 'ACTUAL-INDEX-' + suffix, error: 'ACTUAL-ERROR-' + suffix }, uploaded = []; let failure;
    fixture.record('hosting.files.intent', { originalSettings: before.nginxSettings, filenames: Object.values(names) });
    async function upload(filename, content) { uploaded.push(filename); await uploadOwned(fixture, filename, content); }
    try {
      await upload(names.index, '<!doctype html><p>' + markers.index + '</p>');
      await upload(names.error, '<!doctype html><p>' + markers.error + '</p>');
      await upload(names.blocked, '<p>owned unreadable health</p>');
      accepted(await fixture.call('POST', fixture.endpoint('/files/permissions'), { path: names.blocked, mode: '0600' }));
      if (kind === 'php') await upload(names.status, "<?php $code=(int)($_GET['code']??404); if(!in_array($code,[403,404,500,502,503,504],true)){exit;} http_response_code($code); echo 'ORIGINAL-ERROR-BODY';");
      await ready(page, fixture.route('hosting'));
      await page.getByLabel('Başlangıç dosyaları', { exact: true }).fill(names.index + (kind === 'php' ? ' index.php index.html' : ' index.html'));
      if (kind === 'static') await page.getByRole('checkbox', { name: 'Bulunamayan sayfalarda index.html kullan', exact: true }).uncheck();
      await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
      for (const status of [403, 404, 500, 502, 503, 504]) await page.getByLabel(status + ' hata sayfası', { exact: true }).fill('/' + names.error);
      const offset = page.auditTraffic.length;
      const stageResponse = page.waitForResponse(response => new URL(response.url()).pathname === domainPath(fixture) + '/stage' && response.request().method() === 'POST', { timeout: 120000 }).catch(error => ({ transportError: error }));
      await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
      const staged = await stageResponse; if (staged.transportError) throw staged.transportError;
      const stageBody = await staged.json(); fixture.record('hosting.files.stage-response', { runtime: kind, status: staged.status(), errorCode: stageBody.error?.code ?? null });
      expect(staged.status(), stageBody.error?.code).toBe(202);
      await expect(main(page).getByRole('status').filter({ hasText: 'Barındırma ayarları uygulandı.' })).toBeVisible({ timeout: 120000 });
      const root = domainPath(fixture), mutations = page.auditTraffic.slice(offset).filter(entry => entry.method !== 'GET' && entry.path.startsWith(root));
      for (const endpoint of ['/update-preview', '', '/stage', '/activate']) expect(mutations.filter(entry => entry.path === root + endpoint)).toHaveLength(1);
      const saved = await domain(fixture); expect(saved.appliedRevision).toBe(saved.desiredRevision); expect(saved.nginxSettings.indexFiles[0]).toBe(names.index);
      const home = await fixture.http('/'); expect(home.status).toBe(200); expect(home.body).toContain(markers.index);
      const probes = [['/yp-missing-' + suffix + (kind === 'php' ? '.php' : ''), 404], ['/' + names.blocked, 403], ['/' + names.error, 404],
        ...(kind === 'php' ? [403, 404, 500, 502, 503, 504].map(status => ['/' + names.status + '?code=' + status, status]) : [])];
      for (const [pathname, status] of probes) {
        const response = await fixture.http(pathname); expect(response.status, pathname).toBe(status); expect(response.body).toContain(markers.error);
      }
      await page.reload(); await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveValue(saved.nginxSettings.indexFiles.join(' '));
      expect(page.auditErrors).toEqual([]); fixture.record('hosting.index-errors.real-http', { runtime: kind, verified: true, directErrorDenied: true, originalStatusesPreserved: true });
    } catch (error) { failure = error; }
    try { await restore(fixture, before.nginxSettings, uploaded); }
    catch (error) { fixture.record('hosting.files.cleanup-failure', { runtime: kind, errorKind: error.name, errorCode: error.code ?? null }); failure ??= error; }
    if (failure) throw failure;
  });

  test('@mutation unsafe index and external error preferences reject before any preview or mutation', async ({ page }) => {
    test.setTimeout(240000); const fixture = await site('php'); await ready(page, fixture.route('hosting'));
    const original = await domain(fixture), index = page.getByLabel('Başlangıç dosyaları', { exact: true });
    await index.fill('../outside.php'); const offset = page.auditTraffic.length;
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    await index.fill('index.php index.html'); await main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' }).click();
    await page.getByLabel('404 hata sayfası', { exact: true }).fill('https://foreign.example/error.html');
    await main(page).getByRole('button', { name: 'Kaydet ve uygula', exact: true }).click();
    await expect(main(page).getByRole('alert')).toContainText('Web sunucusu ayarlarını kontrol edin');
    expect(page.auditTraffic.slice(offset).filter(entry => entry.method === 'PATCH' || /\/(?:update-preview|stage|activate)$/.test(entry.path))).toEqual([]);
    expect((await domain(fixture)).nginxSettings).toEqual(original.nginxSettings); expect(page.auditErrors).toEqual([]);
  });

  test('@mutation Passenger hosting excludes PHP and static index and error controls', async ({ page }) => {
    test.setTimeout(360000); const fixture = await site('node'); await ready(page, fixture.route('hosting'));
    await expect(main(page).getByRole('heading', { name: 'Barındırma ayarları', exact: true })).toBeVisible();
    await expect(page.getByLabel('Başlangıç dosyaları', { exact: true })).toHaveCount(0);
    await expect(main(page).locator('summary').filter({ hasText: 'Özel hata sayfaları' })).toHaveCount(0); expect(page.auditErrors).toEqual([]);
  });
  test('@mutation closes current index error clients after acknowledged staging and restores only their exact files and preferences',async()=>{
    test.setTimeout(360000);interruptionHold=true;const protectedKey='t883-files-protect-'+projectName;keys.add(protectedKey);let protectedPhp=await createOwnedFixture(actor,{key:protectedKey,runtime:'php'});sites.set('protected-php',protectedPhp);const proof=await interruptionPhpProbe(protectedPhp);await interruptionFirstPhp(protectedPhp,proof);
    for(const kind of ['php','static']){
      let f=await site(kind);await interruptionWebsite(f);const before=await interruptionDomain(f),initial=await interruptionConfig(f);expect(before.state).toBe('active');expect(before.appliedRevision).toBe(before.desiredRevision);expect(before.appliedChecksum).toBe(initial.sha256);
      const uid=readOnlyHostProbe(f,'owned-site-files').uid;expect(uid).toBeGreaterThan(0);expect(protectedPhp.ledger.websiteId).not.toBe(f.ledger.websiteId);expect(protectedPhp.ledger.applicationId).not.toBe(f.ledger.applicationId);expect(protectedPhp.ledger.domainId).not.toBe(f.ledger.domainId);expect(protectedPhp.ledger.unixUser).not.toBe(f.ledger.unixUser);expect(readOnlyHostProbe(protectedPhp,'owned-site-files').uid).not.toBe(uid);const ownPhpProof=kind==='php'?await interruptionPhpProbe(f):null;if(ownPhpProof)await interruptionFirstPhp(f,ownPhpProof);const suffix=randomBytes(6).toString('hex'),index=await interruptionUpload(f,'yp-client-index-'+suffix+'.html','<p>T883-CLIENT-INDEX-'+f.ledger.nonce+'</p>'),error=await interruptionUpload(f,'yp-client-error-'+suffix+'.html','<p>T883-CLIENT-ERROR-'+f.ledger.nonce+'</p>');
      const input={changes:{nginxSettings:{...before.nginxSettings,indexFiles:[index.name,...(kind==='php'?['index.php','index.html']:['index.html'])],errorPages:{...(before.nginxSettings.errorPages??{}),404:'/'+error.name}}}},preview=await interruptionMutation(f,'POST',domainPath(f)+'/update-preview',input);
      await interruptionMutation(f,'PATCH',domainPath(f),{...input,previewDigest:preview.previewDigest,confirmation:preview.confirmation});const stageJob=await interruptionDomainJob(f,'stage'),staged=await interruptionDomain(f);expect(staged.state).toBe('staged');expect(staged.desiredRevision).toBeGreaterThan(staged.appliedRevision);expect(staged.stagedRevision).toBe(staged.desiredRevision);expect((await interruptionConfig(f)).sha256).toBe(initial.sha256);
      const saved=interruptionCheckpoint(f,{domain:interruptionDomainStamp(staged),stagedSettings:staged.nginxSettings,originalSettings:before.nginxSettings,activeSha256:initial.sha256,stageJob,files:[index,error,...(ownPhpProof?[{name:ownPhpProof.name,sha256:ownPhpProof.sha256}]:[])],unixUid:uid,protectedIdentity:interruptionIdentity(protectedPhp)});
      await actor.api.dispose();actor=null;actor=await interruptionOwnerContext();for(const [runtime,old]of [...sites])sites.set(runtime,await interruptionRebind(actor,old));f=sites.get(kind);protectedPhp=sites.get('protected-php');
      const checkpoint=interruptionReadCheckpoint(saved.file,saved.sha256);await interruptionVerify(f,checkpoint);expect(interruptionIdentity(protectedPhp)).toEqual(checkpoint.protectedIdentity);expect(readOnlyHostProbe(f,'owned-site-files').uid).toBe(checkpoint.unixUid);if(ownPhpProof)await interruptionFirstPhp(f,ownPhpProof);await interruptionFirstPhp(protectedPhp,proof);
      await interruptionPublish(f,checkpoint.originalSettings);expect((await interruptionConfig(f)).sha256).toBe(checkpoint.activeSha256);await interruptionFirstPhp(protectedPhp,proof);if(ownPhpProof)await interruptionFirstPhp(f,ownPhpProof);for(const file of checkpoint.files)await interruptionDelete(f,file);expect((await f.http('/')).status).toBe(200);await interruptionWebsite(f);
      f.record('client-interruption.current-index-errors',{runtime:kind,verified:true,checkpointSha256:saved.sha256,initiatingContextDisposed:true,freshContextRebound:true,backendProcessCrash:false,historicalReceiptConflict:false,originalActiveSha256:checkpoint.activeSha256});
    }
    await interruptionDelete(protectedPhp,proof);interruptionHold=false;
  });

  test(native22CleanupTitle, async () => {
    test.setTimeout(480000);
    expect(native22DispatchPhase).toBe('cleanup'); expect(native22CleanupAuthorized).toBe(true); expect(native22CleanupActive).toBe(true); expect(native22StickyHold).toBe(false);
    expect(keys.size).toBe(4); expect(sites.has('protected-php')).toBe(true);
    const failures = [];
    for (const key of [...[...keys].filter(key=>key!==sites.get('protected-php')?.ledger.key).reverse(),...[...keys].filter(key=>key===sites.get('protected-php')?.ledger.key)]) {
      expect(native22StickyHold).toBe(false); expect(native22CleanupActive).toBe(true); native22CleanupKey = key;
      try {
      const fixture = [...sites.values()].find(value => value.ledger.key === key);
      const ledger = fixture ? await fixture.cleanup() : await cleanupOwnedFixture(actor, { key });
      const absent = readOnlyHostProbe({ ledger }, 'lifecycle-absence');
      expect(absent.unixUserExists).toBe(false); expect(absent.unixGroupExists).toBe(false);
      expect(absent.roots.length).toBeGreaterThanOrEqual(4);
      expect(absent.roots.every(value => !value.exists)).toBe(true); expect(absent.nginxFiles.every(value => !value.exists)).toBe(true);
      expect(absent.fpmFiles).toEqual([]); expect(absent.sockets).toEqual([]); expect(absent.mounts).toEqual([]);
      expect(absent.passengerEnvironmentInclude.path).toBe('/etc/yunpanel/passenger-env/' + ledger.applicationId + '.conf');
      expect(absent.passengerEnvironmentInclude.parentTrustVerified).toBe(true); expect(absent.passengerEnvironmentInclude.exists).toBe(false);
      native22CleanupVerifiedKeys.add(key); native22CleanupKey = null;
      } catch (error) { native22Keep('cleanup-or-physical-proof-failed'); failures.push(error.message); break; }
    }
    expect(failures, 'Every exact owned Website must be cleaned').toEqual([]);
    expect(native22StickyHold).toBe(false); expect(native22CleanupVerifiedKeys.size).toBe(4);
    expect([...native22ForwardIntents.values()].every(value => value.responseKnown)).toBe(true); native22CleanupBodyVerified = true;
  });


});
