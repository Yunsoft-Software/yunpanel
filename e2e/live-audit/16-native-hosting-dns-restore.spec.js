import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { test, expect, apiContext, RUN_DIR } from './support.js';
import { createOwnedFixture, cleanupOwnedFixture, readOnlyHostProbe } from './owned-fixture.js';

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
async function config(fixture) {
  const value = await readOnlyHostProbe(fixture, 'nginx-config');
  expect(value.regular).toBe(true); expect(value.symlink).toBe(false); expect(value.uid).toBe(0);
  expect(value.mode & 0o022).toBe(0); expect(value.bytes).toBeGreaterThan(0); return value;
}
async function domain(fixture) {
  const value = accepted(await fixture.call('GET', domainPath(fixture)));
  expect(value.websiteId).toBe(fixture.ledger.websiteId); expect(value.primaryDomain).toBe(fixture.ledger.hostname); return value;
}
async function publish(fixture, settings) {
  const root = domainPath(fixture), current = await domain(fixture);
  if (!isDeepStrictEqual(current.nginxSettings, settings)) {
    const input = { changes: { nginxSettings: settings } }, preview = accepted(await fixture.call('POST', root + '/update-preview', input));
    accepted(await fixture.call('PATCH', root, { ...input, previewDigest: preview.previewDigest, confirmation: preview.confirmation }));
  }
  const pending = await domain(fixture);
  if (pending.state !== 'active' || pending.appliedRevision !== pending.desiredRevision) for (const action of ['stage', 'activate']) {
    const job = accepted(await fixture.call('POST', root + '/' + action, {}), 202); expect((await fixture.waitJob(job.id)).status).toBe('succeeded');
  }
  const applied = await domain(fixture); expect(applied.nginxSettings).toEqual(settings); expect(applied.appliedRevision).toBe(applied.desiredRevision);
}
async function zone(fixture) { return accepted(await fixture.call('GET', domainPath(fixture) + '/dns/zone')); }
const recordMatches = (fixture, owner, rrset) => rrset.type === 'TXT' && [owner, owner + '.' + fixture.ledger.hostname, owner + '.' + fixture.ledger.hostname + '.'].includes(rrset.owner);
async function writeTxt(fixture, owner, value) {
  const current = await zone(fixture);
  return accepted(await fixture.call('POST', domainPath(fixture) + '/dns/records', { owner, type: 'TXT', ttl: 300, values: [value], expectedSerial: current.serial }));
}
async function deleteTxt(fixture, owner) {
  const current = await zone(fixture);
  if (current.rrsets.some(rrset => recordMatches(fixture, owner, rrset))) accepted(await fixture.call('POST', domainPath(fixture) + '/dns/records/delete', { owner, type: 'TXT', expectedSerial: current.serial }));
}
async function finished(fixture, operation, status = 'succeeded') {
  const job = await fixture.waitJob(operation.jobId, 180000); expect(job.status).toBe('succeeded');
  const result = accepted(await fixture.call('GET', fixture.endpoint('/backup-operations/' + operation.id)));
  expect(result.status, result.error?.code).toBe(status); return result;
}
async function restoreSnapshot(fixture, repositoryId, snapshotId, healthPath = '/') {
  const input = { repositoryId, snapshotId, include: ['dns', 'hosting'], healthPath, timeoutSeconds: healthPath === '/' ? 30 : 5 };
  const preview = accepted(await fixture.call('POST', fixture.endpoint('/restore/preview'), input));
  return accepted(await fixture.call('POST', fixture.endpoint('/backup-operations'), { kind: 'restore', ...input, expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation }), 202);
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
async function interruptionOwnerContext(){try{return await apiContext();}catch{throw new Error('Fresh normal Owner context could not be verified; protected details withheld');}}
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

test.describe('T887 real owned DNS and hosting restore', () => {
  let actor, fixture, projectName, key, protectedFixture, protectedKey;
  async function site() {
    if (!fixture) {
      key = 't887-dns-hosting-' + projectName;
      fixture = await createOwnedFixture(actor, { key, runtime: 'static', dns: { mode: 'local' } });
      await uploadOwned(fixture, 'index.html', '<!doctype html><p>T887 owned DNS hosting restore</p>');
      expect((await fixture.http('/')).status).toBe(200);
    }
    return fixture;
  }
  test.beforeAll(async ({}, info) => { projectName = (info.project.name.startsWith('firefox') ? 'ff' : 'cr') + '-w' + info.workerIndex; actor = await apiContext(); });
  test.afterAll(async () => {
    if(interruptionHold){await actor?.api.dispose();throw new Error('UNKNOWN_KEEP: current client-interruption checkpoint was not fully reconciled; no cleanup mutations');}
    const failures=[];
    for(const cleanupKey of [protectedKey,key].filter(Boolean))try{
      const current=[protectedFixture,fixture].find(value=>value?.ledger.key===cleanupKey),ledger=current?await current.cleanup():await cleanupOwnedFixture(actor,{key:cleanupKey});
      const absent=readOnlyHostProbe({ledger},'lifecycle-absence');expect(absent.unixUserExists).toBe(false);expect(absent.unixGroupExists).toBe(false);expect(absent.roots.length).toBeGreaterThanOrEqual(4);expect(absent.roots.every(value=>!value.exists)).toBe(true);expect(absent.nginxFiles.every(value=>!value.exists)).toBe(true);expect(absent.fpmFiles).toEqual([]);expect(absent.sockets).toEqual([]);expect(absent.mounts).toEqual([]);
    }catch(error){failures.push({key:cleanupKey,errorKind:error.name});}
    await actor?.api.dispose();expect(failures,'Every exact owned Website must be cleaned normally').toEqual([]);
  });

  test('@mutation reconciles only the current owned ledger DNS hosting and health artifacts', async () => {
    test.setTimeout(300000); const f = await site(), before = await domain(f), owner = '_yprestore_' + randomBytes(6).toString('hex');
    const filename = 'yp-t887-health-' + randomBytes(6).toString('hex') + '.html';
    f.record('dns-hosting.recovery.intent', { owner, filename, originalSettings: before.nginxSettings });
    f.record('openAcceptance', { historicalCommit: 'ba33f4a8^', historicalFile: '16-native-hosting-dns-restore.spec.js',
      historicalTitle: '@mutation source recovers only the owned DNS and health-file artifacts left by the earlier Nginx receipt conflict',
      reason: 'The original interrupted October candidate and receipt conflict are intentionally not restored. Current normal API reconciliation is exercised with this exact fresh ledger.',
      requiredChannel: 'Owned interrupted current-run reconciliation through normal API' });
    try {
      await writeTxt(f, owner, 'T887-own-recovery'); await uploadOwned(f, filename, '<p>T887 own recovery health</p>');
      await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
      expect((await config(f)).clientMaxBodySizeMb).toBe(17);
      await publish(f, before.nginxSettings); expect((await config(f)).clientMaxBodySizeMb).not.toBe(17);
      await deleteTxt(f, owner); expect((await zone(f)).rrsets.some(rrset => recordMatches(f, owner, rrset))).toBe(false);
      await f.deleteFile(filename);
      expect(accepted(await f.call('GET', f.endpoint('/files'))).entries.some(entry => entry.name === filename)).toBe(false);
      expect((await f.http('/')).status).toBe(200); f.record('dns-hosting.recovery.current-ledger', { verified: true });
    } finally { await publish(f, before.nginxSettings); await deleteTxt(f, owner); }
  });

  test('@mutation repository create with initialization returns a ready catalog and a physically valid repository', async () => {
    test.setTimeout(240000); const f = await site(); let repository, failure;
    const name = 'ypaudit-t887-init-' + f.ledger.nonce;
    const observations = [], pollerFailures = [];
    let createStartedAt = null, createFinishedAt = null, pollers = [];
    f.record('backup.repository.intent', { name, initialize: true });
    try {
      const baseline = accepted(await f.call('GET', '/api/panel/backups/repositories'));
      expect(Array.isArray(baseline)).toBe(true);
      expect(baseline.some(row => row.name === name)).toBe(false);
      const baselineIds = new Set(baseline.map(row => row.id));
      createStartedAt = Date.now();
      // Exactly one mutation. Concurrent catalog reads never replay a lost POST.
      const creation = f.call('POST', '/api/panel/backups/repositories', {
        name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: true,
      }).finally(() => { createFinishedAt = Date.now(); });
      const pollUntil = createStartedAt + 15000;
      pollers = [1, 2].map(async poller => {
        let lastStartedAt = null, lastPendingAtStart = null;
        try {
          for (let attempt = 0; attempt < 100 && createFinishedAt === null && Date.now() < pollUntil; attempt++) {
            const startedAt = Date.now(), postPendingAtStart = createFinishedAt === null;
            lastStartedAt = startedAt; lastPendingAtStart = postPendingAtStart;
            const reply = await f.call('GET', '/api/panel/backups/repositories', undefined, { requestTimeoutMs: 10000, retryGets: false });
            const finishedAt = Date.now(), postPendingAtEnd = createFinishedAt === null;
            const rows = Array.isArray(reply.data) ? reply.data : [];
            const ownRows = rows.filter(row => row.name === name).map(row => ({
              id: /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.id ?? '') ? row.id : null,
              status: ['uninitialized', 'ready', 'error'].includes(row.status) ? row.status : 'unknown',
            }));
            const observation = { poller, attempt, startedAt, finishedAt, postPendingAtStart, postPendingAtEnd,
              httpStatus: reply.status, ownRows };
            observations.push(observation); f.record('backup.repository.concurrent-list', observation);
            accepted(reply); expect(Array.isArray(reply.data)).toBe(true);
            expect(ownRows.every(row => row.id !== null && !baselineIds.has(row.id))).toBe(true);
            if (createFinishedAt !== null) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } catch (error) {
          pollerFailures.push(error);
          f.record('backup.repository.concurrent-list-failure', { poller, startedAt: lastStartedAt, finishedAt: Date.now(),
            postPendingAtStart: lastPendingAtStart, postPendingAtEnd: createFinishedAt === null,
            errorKind: error.name, errorCode: error.code ?? null });
        }
      });
      const created = accepted(await creation, 201);
      expect(created.name).toBe(name); expect(created.backend).toBe('local'); expect(created.serverId).toBe(f.ledger.serverId);
      expect(created.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
      expect(baselineIds.has(created.id)).toBe(false); expect(typeof created.target).toBe('string'); expect(created.target.length).toBeGreaterThan(0);
      repository = created;
      f.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name });
      await Promise.all(pollers);
      if (pollerFailures.length) throw pollerFailures[0];
      const concurrent = observations.filter(row => row.httpStatus === 200 && row.postPendingAtStart && row.postPendingAtEnd);
      expect(concurrent.length, 'At least one real catalog response must return while the single create POST is pending').toBeGreaterThan(0);
      const ownUninitialized = concurrent.some(row => row.ownRows.some(own => own.id === repository.id && own.status === 'uninitialized'));
      f.record('backup.repository.concurrent-init-window', { repositoryId: repository.id, createStartedAt, createFinishedAt,
        successfulListsWhilePending: concurrent.length, ownUninitializedObserved: ownUninitialized, causalAcceptance: ownUninitialized ? 'observed' : 'open' });
      if (!ownUninitialized) f.record('openAcceptance', { id: 'T893.actual-uninitialized-list-window',
        reason: 'Concurrent real catalog reads completed before create returned, but this run did not observe its owned row uninitialized during that window.',
        requiredChannel: 'A real native initialization window with the exact owned uninitialized catalog row; no fake delay or engine response' });
      const readback = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id));
      const checked = await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {});
      const snapshots = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id + '/snapshots'));
      f.record('backup.repository.initialize-contract', { createStatus: repository.status, readbackStatus: readback.status,
        physicalCheckHttpStatus: checked.status, physicalCheckErrorCode: checked.body?.error?.code ?? null,
        emptySnapshots: Array.isArray(snapshots) && snapshots.length === 0 });
      expect(repository.status).toBe('ready'); expect(readback.status).toBe('ready'); expect(checked.status, checked.body?.error?.code).toBe(200);
      expect(snapshots).toEqual([]);
    } catch (error) { failure = error; }
    finally {
      await Promise.all(pollers);
      if (createStartedAt !== null && !repository) f.record('backup.repository.create-unconfirmed', { name, createStartedAt, createFinishedAt,
        postReplayed: false, observedOwnRepositoryIds: [...new Set(observations.flatMap(row => row.ownRows.map(own => own.id)))], automaticCleanupAttempted: false });
    }
    if (repository) try {
      const current = accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id));
      expect(current.id).toBe(repository.id); expect(current.name).toBe(name); expect(current.target).toBe(repository.target);
      expect(current.serverId).toBe(f.ledger.serverId); expect(current.backend).toBe('local');
      accepted(await f.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
      expect((await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
      f.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true });
    } catch (error) { f.record('backup.repository.cleanup-failure', { errorKind: error.name }); failure ??= error; }
    if (failure) throw failure;
  });

  test('@mutation restores actual TXT Nginx bytes and settings twice and rolls back a real failed health check', async () => {
    test.setTimeout(480000); const f = await site(), before = await domain(f), initial = await config(f);
    expect(initial.bytes).toBeGreaterThan(0); expect(initial.sha256).toMatch(/^[a-f0-9]{64}$/);
    const owner = '_yprestore_' + randomBytes(6).toString('hex'), value = 'T887-DNS-' + randomBytes(12).toString('hex');
    const matches = rrset => recordMatches(f, owner, rrset); expect((await zone(f)).rrsets.some(matches)).toBe(false);
    let repository, healthFile, failure;
    f.record('dns-hosting.restore.intent', { owner, originalSettings: before.nginxSettings, originalConfigSha256: initial.sha256 });
    try {
      await writeTxt(f, owner, value); expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(value);
      const name = 'ypaudit-t887-dns-' + f.ledger.nonce;
      f.record('backup.repository.intent', { name, websiteId: f.ledger.websiteId });
      repository = accepted(await f.call('POST', '/api/panel/backups/repositories', { name, backend: 'local', password: randomBytes(36).toString('base64url'), initialize: false }), 201);
      f.record('backup.repository.owned', { repositoryId: repository.id, target: repository.target, name });
      expect(repository.status).toBe('uninitialized');
      const initialized = accepted(await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/init', {})); expect(initialized.status).toBe('ready');
      accepted(await f.call('POST', '/api/panel/backups/repositories/' + repository.id + '/check', {}));
      expect(accepted(await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe('ready');
      f.record('backup.repository.explicit-init-check', { verified: true, repositoryId: repository.id });
      const preview = accepted(await f.call('POST', f.endpoint('/backup/preview'), { repositoryId: repository.id }));
      const backup = accepted(await f.call('POST', f.endpoint('/backup-operations'), { kind: 'backup', repositoryId: repository.id, expectedPreviewDigest: preview.backupSetDigest, confirmation: preview.confirmation, tags: ['t887-dns-' + f.ledger.nonce] }), 202);
      const snapshotId = (await finished(f, backup)).result?.snapshot?.snapshotId; expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
      f.record('backup.snapshot.owned', { repositoryId: repository.id, snapshotId });
      for (let pass = 1; pass <= 2; pass++) {
        await writeTxt(f, owner, value + '-CHANGED-' + pass); await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
        const changed = await config(f); expect(changed.clientMaxBodySizeMb).toBe(17); expect(changed.sha256).not.toBe(initial.sha256);
        const operation = await restoreSnapshot(f, repository.id, snapshotId); await finished(f, operation);
        expect((await config(f)).sha256).toBe(initial.sha256);
        expect((await domain(f)).nginxSettings).toEqual(before.nginxSettings);
        expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(value);
        expect((await f.http('/')).status).toBe(200);
        f.record('dns-hosting.restore.real', { verified: true, pass, snapshotId, operationId: operation.id, configSha256: initial.sha256 });
      }
      healthFile = 'yp-t887-health-' + randomBytes(6).toString('hex') + '.html';
      f.record('dns-hosting.bad-health.intent', { filename: healthFile }); await uploadOwned(f, healthFile, '<p>T887 unreadable health</p>');
      accepted(await f.call('POST', f.endpoint('/files/permissions'), { path: healthFile, mode: '0600' }));
      expect((await f.http('/' + healthFile)).status).toBe(403);
      const preserve = value + '-PRESERVE'; await writeTxt(f, owner, preserve); await publish(f, { ...before.nginxSettings, clientMaxBodySizeMb: 17 });
      const changed = await config(f), operation = await restoreSnapshot(f, repository.id, snapshotId, '/' + healthFile);
      const result = await finished(f, operation, 'rolled_back'); expect(result.result?.rollbackReason).toBe('health_check_failed');
      expect((await config(f)).sha256).toBe(changed.sha256);
      expect((await domain(f)).nginxSettings.clientMaxBodySizeMb).toBe(17);
      expect((await zone(f)).rrsets.find(matches)?.records.map(record => record.value)).toContain(preserve);
      expect((await f.http('/')).status).toBe(200); f.record('dns-hosting.rollback.real', { verified: true, operationId: operation.id, httpStatus: 403 });
    } catch (error) { failure = error; }
    {
      const failures = [];
      for (const cleanup of [() => publish(f, before.nginxSettings), () => deleteTxt(f, owner), ...(healthFile ? [() => f.deleteFile(healthFile)] : []),
        ...(repository ? [async () => { accepted(await f.call('DELETE', '/api/panel/backups/repositories/' + repository.id));
          expect((await f.call('GET', '/api/panel/backups/repositories/' + repository.id)).status).toBe(404);
          f.record('backup.repository.physical-cleanup-required', { repositoryId: repository.id, target: repository.target, name: repository.name, registryAbsent: true }); }] : [])]) {
        try { await cleanup(); } catch (error) { failures.push(error.name); failure ??= error; }
      }
      if (failures.length) f.record('dns-hosting.cleanup-failure', { errorKinds: failures });
    }
    if (failure) throw failure;
  });
  test('@mutation closes the current DNS hosting client after acknowledged staging then reconciles the exact checkpoint in a fresh Owner context', async()=>{
    test.setTimeout(300000);interruptionHold=true;let f=await site();await interruptionWebsite(f);
    protectedKey='t883-dns-protect-'+projectName;protectedFixture=await createOwnedFixture(actor,{key:protectedKey,runtime:'php'});const proof=await interruptionPhpProbe(protectedFixture);await interruptionFirstPhp(protectedFixture,proof);
    const before=await interruptionDomain(f),initial=await interruptionConfig(f);expect(before.state).toBe('active');expect(before.appliedRevision).toBe(before.desiredRevision);expect(before.appliedChecksum).toBe(initial.sha256);
    const uid=readOnlyHostProbe(f,'owned-site-files').uid;expect(uid).toBeGreaterThan(0);const suffix=randomBytes(6).toString('hex'),owner='_ypclient_'+suffix,value='T883-CLIENT-DNS-'+f.ledger.nonce;
    expect((await zone(f)).rrsets.some(rrset=>recordMatches(f,owner,rrset))).toBe(false);const file=await interruptionUpload(f,'yp-client-'+suffix+'.html','<p>'+value+'</p>');
    const zoneBefore=await zone(f);await interruptionMutation(f,'POST',domainPath(f)+'/dns/records',{owner,type:'TXT',ttl:300,values:[value],expectedSerial:zoneBefore.serial});
    const input={changes:{nginxSettings:{...before.nginxSettings,clientMaxBodySizeMb:before.nginxSettings.clientMaxBodySizeMb===17?18:17}}},preview=await interruptionMutation(f,'POST',domainPath(f)+'/update-preview',input);
    await interruptionMutation(f,'PATCH',domainPath(f),{...input,previewDigest:preview.previewDigest,confirmation:preview.confirmation});const stageJob=await interruptionDomainJob(f,'stage'),staged=await interruptionDomain(f);
    expect(staged.state).toBe('staged');expect(staged.desiredRevision).toBeGreaterThan(staged.appliedRevision);expect(staged.stagedRevision).toBe(staged.desiredRevision);expect((await interruptionConfig(f)).sha256).toBe(initial.sha256);
    const currentZone=await zone(f);expect(currentZone.rrsets.find(rrset=>recordMatches(f,owner,rrset)).records.map(row=>row.value)).toEqual([value]);
    const saved=interruptionCheckpoint(f,{domain:interruptionDomainStamp(staged),stagedSettings:staged.nginxSettings,originalSettings:before.nginxSettings,activeSha256:initial.sha256,stageJob,files:[file],txtOwner:owner,txtValue:value,zoneSerial:currentZone.serial,unixUid:uid,protectedIdentity:interruptionIdentity(protectedFixture)});
    await actor.api.dispose();actor=null;actor=await interruptionOwnerContext();fixture=await interruptionRebind(actor,f);f=fixture;protectedFixture=await interruptionRebind(actor,protectedFixture);
    const checkpoint=interruptionReadCheckpoint(saved.file,saved.sha256);await interruptionVerify(f,checkpoint);expect(interruptionIdentity(protectedFixture)).toEqual(checkpoint.protectedIdentity);expect(readOnlyHostProbe(f,'owned-site-files').uid).toBe(checkpoint.unixUid);
    const resumedZone=await zone(f);expect(resumedZone.serial).toBe(checkpoint.zoneSerial);expect(resumedZone.rrsets.find(rrset=>recordMatches(f,checkpoint.txtOwner,rrset)).records.map(row=>row.value)).toEqual([checkpoint.txtValue]);await interruptionFirstPhp(protectedFixture,proof);
    await interruptionPublish(f,checkpoint.originalSettings);expect((await interruptionConfig(f)).sha256).toBe(checkpoint.activeSha256);await interruptionFirstPhp(protectedFixture,proof);
    const removalZone=await zone(f);expect(removalZone.rrsets.find(rrset=>recordMatches(f,checkpoint.txtOwner,rrset)).records.map(row=>row.value)).toEqual([checkpoint.txtValue]);await interruptionMutation(f,'POST',domainPath(f)+'/dns/records/delete',{owner:checkpoint.txtOwner,type:'TXT',expectedSerial:removalZone.serial});
    expect((await zone(f)).rrsets.some(rrset=>recordMatches(f,checkpoint.txtOwner,rrset))).toBe(false);await interruptionDelete(f,file);await interruptionDelete(protectedFixture,proof);expect((await f.http('/')).status).toBe(200);await interruptionWebsite(f);
    f.record('client-interruption.current-dns-hosting',{verified:true,checkpointSha256:saved.sha256,initiatingContextDisposed:true,freshContextRebound:true,backendProcessCrash:false,historicalReceiptConflict:false,originalActiveSha256:checkpoint.activeSha256});interruptionHold=false;
  });

});
