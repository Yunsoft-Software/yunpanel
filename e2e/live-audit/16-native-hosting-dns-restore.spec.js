import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {test,expect,manifest,saveManifest,apiCall,waitJob} from './support.js';

const execute=promisify(execFile);
function record(action,proof){const m=manifest();m.fixture.operations.push({action,...proof,at:new Date().toISOString()});saveManifest(m);}
function checked(result,action,status=200){record(action,{status:result.status,code:result.body.error?.code});expect(result.status,action).toBe(status);return result.data;}
async function actualConfig(m){
 const sha=process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA;
 if(!/^[a-f0-9]{64}$/.test(sha??'')||!/^yp-(?:static|dns)-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(m.fixture.hostname)
  ||!m.fixture.createdWebsiteIds.includes(m.fixture.websiteId)||!m.fixture.createdDomainIds.includes(m.fixture.domainId))throw new Error('Owned native source fixture required');
 const helper=path.resolve('.local/acceptance-candidate/host-control.py');
 const script=`python3 - <<'PY'
from pathlib import Path
import json,hashlib,os
p=Path('/var/lib/yunpanel/acceptance-candidates/20261010-84576b66')
s=json.loads((p/'native-test-window.json').read_text())
assert s['target']=='157.180.11.28' and s['status']=='ready' and s['deployed'] is False and s['archiveSha256']=='${sha}'
env=json.loads((p/'runtime-env.json').read_text());domains=json.loads(Path(env['YUNPANEL_DOMAIN_STORE']).read_text())
if isinstance(domains,dict):domains=domains['domains']
d=next(d for d in domains if d['id']=='${m.fixture.domainId}')
assert d['websiteId']=='${m.fixture.websiteId}' and d['primaryDomain']=='${m.fixture.hostname}'
f=Path('/etc/nginx/sites-enabled')/('yunpanel-'+d['primaryDomain']+'.conf');st=f.lstat()
assert f.is_file() and not f.is_symlink() and st.st_uid==0 and not st.st_mode&0o022
b=f.read_bytes();print(json.dumps({'checksum':hashlib.sha256(b).hexdigest(),'bytes':len(b),'limit17':b'client_max_body_size 17m;' in b}))
PY`;
 try{const result=await execute('python3',[helper,script],{timeout:55000,maxBuffer:4096});return JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('{'))??'null');}
 catch{throw new Error('Owned physical Nginx verification failed; access material withheld');}
}

test('@mutation source recovers only the owned DNS and health-file artifacts left by the earlier Nginx receipt conflict',async({liveApi})=>{
 test.setTimeout(120000);const base=manifest(),target=base.fixture.extraStatic;
 expect(target?.removed).not.toBe(true);expect(base.fixture.createdWebsiteIds).toContain(target.websiteId);
 const m={...base,fixture:{...base.fixture,...target}},root='/api/panel/websites/'+target.websiteId,domainRoot='/api/panel/domains/'+target.domainId;
 const domain=checked(await apiCall(liveApi.api,liveApi.csrf,'GET',domainRoot),'hosting.recovery-identity');
 expect(domain.websiteId).toBe(target.websiteId);expect(domain.nginxSettings.clientMaxBodySizeMb).not.toBe(17);
 if((await actualConfig(m)).limit17){
  for(const action of ['stage','activate']){
   const job=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',domainRoot+'/'+action,{}),'hosting.recovery-'+action,202);
   const result=await waitJob(liveApi.api,job.id);record('hosting.recovery-'+action+'.job',{status:result.status,code:result.error?.code});expect(result.status).toBe('succeeded');
  }
  expect((await actualConfig(m)).limit17).toBe(false);
 }
 const saved=base.fixture.nativeHostingDnsBackup;
 if(saved?.websiteId===target.websiteId&&/^_yprestore_[a-f0-9]{12}$/.test(saved.owner)){
  const zone=checked(await apiCall(liveApi.api,liveApi.csrf,'GET',domainRoot+'/dns/zone'),'dns.recovery-read');
  if(zone.rrsets.some(rr=>rr.owner===saved.owner+'.'+target.hostname))checked(await apiCall(liveApi.api,liveApi.csrf,'POST',domainRoot+'/dns/records/delete',{owner:saved.owner,type:'TXT',expectedSerial:zone.serial}),'dns.recovery-owned-delete');
 }
 const files=checked(await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/files'),'hosting.recovery-files');expect(Array.isArray(files.entries)).toBe(true);
 for(const entry of files.entries.filter(item=>/^owned-restore-health-[a-f0-9-]{36}\.html$/.test(item.name)))
  checked(await apiCall(liveApi.api,liveApi.csrf,'DELETE',root+'/files',{path:entry.name,confirmation:'delete:'+target.websiteId+':'+entry.name}),'hosting.recovery-owned-health-delete');
 expect((await liveApi.api.get('http://'+target.hostname+'/')).status()).toBe(200);
 record('hosting-dns.earlier-fixture-recovered',{verified:true,websiteId:target.websiteId});
});

test('@mutation source DNS and hosting restore restores actual TXT records, Nginx bytes and Domain settings twice',async({liveApi})=>{
 test.setTimeout(300000);const base=manifest();expect(base.fixture.provisioningReady).toBe(true);
 expect(base.fixture.extraStatic?.removed).not.toBe(true);expect(base.fixture.extraStatic?.domainId).toBeTruthy();
 const m={...base,fixture:{...base.fixture,...base.fixture.extraStatic}};
 const root='/api/panel/websites/'+m.fixture.websiteId,domainRoot='/api/panel/domains/'+m.fixture.domainId,dns=domainRoot+'/dns';
 const owner='_yprestore_'+randomUUID().replaceAll('-','').slice(0,12),value='OWNED-DNS-RESTORE-'+m.runId;
 async function getDomain(){return checked(await apiCall(liveApi.api,liveApi.csrf,'GET',domainRoot),'hosting.identity');}
 async function zone(){return checked(await apiCall(liveApi.api,liveApi.csrf,'GET',dns+'/zone'),'dns.read');}
 async function writeTxt(text){const current=await zone();return checked(await apiCall(liveApi.api,liveApi.csrf,'POST',dns+'/records',{owner,type:'TXT',ttl:300,values:[text],expectedSerial:current.serial}),'dns.write');}
 async function publishSettings(settings){
  const input={changes:{nginxSettings:settings}};
  const p=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',domainRoot+'/update-preview',input),'hosting.preview');
  checked(await apiCall(liveApi.api,liveApi.csrf,'PATCH',domainRoot,{...input,previewDigest:p.previewDigest,confirmation:p.confirmation}),'hosting.save');
  for(const action of ['stage','activate']){
   const job=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',domainRoot+'/'+action,{}),'hosting.'+action,202);
   const result=await waitJob(liveApi.api,job.id);record('hosting.'+action+'.job',{status:result.status,code:result.error?.code});expect(result.status).toBe('succeeded');
  }
 }
 async function finish(operation){
  const job=await waitJob(liveApi.api,operation.jobId,180000);record('hosting-dns.job',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
  const done=checked(await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/backup-operations/'+operation.id),'hosting-dns.operation');expect(done.status).toBe('succeeded');return done;
 }
 const initial=await getDomain();expect(initial.websiteId).toBe(m.fixture.websiteId);expect(initial.primaryDomain).toBe(m.fixture.hostname);
 const configBefore=await actualConfig(m);expect(configBefore?.bytes).toBeGreaterThan(0);
 const matches=rr=>rr.type==='TXT'&&(rr.owner===owner||rr.owner===owner+'.'+m.fixture.hostname||rr.owner===owner+'.'+m.fixture.hostname+'.');
 expect((await zone()).rrsets.some(matches)).toBe(false);
 let changedSettings=false,txtCreated=false,healthFile=null;
 try{
  await writeTxt(value);txtCreated=true;
  const initialRecord=(await zone()).rrsets.find(matches);expect(initialRecord?.records?.map(item=>item.value)).toContain(value);
  const repositories=checked(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/backups/repositories'),'hosting-dns.repositories');
  const repository=repositories.find(item=>item.name==='website-'+m.fixture.websiteId)
   ??checked(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/backups/repositories',{
    name:'website-'+m.fixture.websiteId,backend:'local',password:randomBytes(36).toString('base64url'),initialize:true,
   }),'hosting-dns.repository-create',201);expect(repository?.status).toBe('ready');
  const preview=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup/preview',{repositoryId:repository.id}),'hosting-dns.backup-preview');
  const backup=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'backup',repositoryId:repository.id,expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['native-hosting-dns-'+m.runId]}),'hosting-dns.backup',202);
  const snapshotId=(await finish(backup)).result?.snapshot?.snapshotId;expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
  const saved=manifest();saved.fixture.nativeHostingDnsBackup={websiteId:m.fixture.websiteId,repositoryId:repository.id,snapshotId,operationId:backup.id,owner};saveManifest(saved);
  for(let pass=0;pass<2;pass++){
   await writeTxt(value+'-CHANGED-'+pass);
   changedSettings=true;await publishSettings({...initial.nginxSettings,clientMaxBodySizeMb:17});
   const changed=await actualConfig(m);expect(changed.limit17).toBe(true);expect(changed.checksum).not.toBe(configBefore.checksum);
   const input={repositoryId:repository.id,snapshotId,include:['dns','hosting'],healthPath:'/',timeoutSeconds:30};
   const restorePreview=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'hosting-dns.restore-preview');
   const operation=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation}),'hosting-dns.restore',202);
   await finish(operation);
   expect((await actualConfig(m)).checksum).toBe(configBefore.checksum);expect((await getDomain()).nginxSettings).toEqual(initial.nginxSettings);changedSettings=false;
   const restoredZone=await zone();const rr=restoredZone.rrsets.find(matches);
   record('dns.restore-owned-records',{records:restoredZone.rrsets.filter(item=>item.owner.includes(owner)).map(item=>({owner:item.owner,type:item.type,records:item.records}))});
   expect(rr?.records?.map(item=>item.value)).toContain(value);
   expect((await liveApi.api.get('http://'+m.fixture.hostname+'/')).status()).toBe(200);
   record('hosting-dns.physical-restore',{verified:true,pass:pass+1,snapshotId,operationId:operation.id,configChecksum:configBefore.checksum});
  }
  // A real unreadable, owned file forces Nginx HTTP 403. It is deliberately
  // outside the restore selection, so successful rollback must recover the
  // pre-restore DNS and hosting values rather than repeat the old snapshot.
  healthFile='owned-restore-health-'+randomUUID()+'.html';
  checked(await apiCall(liveApi.api,liveApi.csrf,'PUT',root+'/files/upload?path='+healthFile,Buffer.from('<p>owned health proof</p>')),'hosting-dns.health-upload',201);
  checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/files/permissions',{path:healthFile,mode:'0600'}),'hosting-dns.health-permissions');
  expect((await liveApi.api.get('http://'+m.fixture.hostname+'/'+healthFile)).status()).toBe(403);
  const kept=value+'-PRESERVE-ON-FAILURE';await writeTxt(kept);changedSettings=true;
  await publishSettings({...initial.nginxSettings,clientMaxBodySizeMb:17});const changedConfig=await actualConfig(m);
  const input={repositoryId:repository.id,snapshotId,include:['dns','hosting'],healthPath:'/'+healthFile,timeoutSeconds:5};
  const rollbackPreview=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'hosting-dns.rollback-preview');
  const rollback=checked(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:rollbackPreview.previewDigest,confirmation:rollbackPreview.confirmation}),'hosting-dns.rollback',202);
  const rollbackManifest=manifest();rollbackManifest.fixture.nativeHostingRollback={websiteId:m.fixture.websiteId,operationId:rollback.id,jobId:rollback.jobId};saveManifest(rollbackManifest);
  const rollbackJob=await waitJob(liveApi.api,rollback.jobId,120000);expect(rollbackJob.status).toBe('succeeded');
  const result=checked(await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/backup-operations/'+rollback.id),'hosting-dns.rollback-result');
  expect(result.status).toBe('rolled_back');expect(result.result?.rollbackReason).toBe('health_check_failed');
  expect((await actualConfig(m)).checksum).toBe(changedConfig.checksum);
  expect((await getDomain()).nginxSettings.clientMaxBodySizeMb).toBe(17);
  expect((await zone()).rrsets.find(matches)?.records?.map(item=>item.value)).toContain(kept);
  record('hosting-dns.physical-rollback',{verified:true,operationId:rollback.id,httpStatus:403});
 }finally{
  const cleanup=[];
  if(changedSettings)cleanup.push(()=>publishSettings(initial.nginxSettings));
  if(txtCreated)cleanup.push(async()=>{const current=await zone();checked(await apiCall(liveApi.api,liveApi.csrf,'POST',dns+'/records/delete',{owner,type:'TXT',expectedSerial:current.serial}),'dns.owned-cleanup');});
  if(healthFile)cleanup.push(()=>apiCall(liveApi.api,liveApi.csrf,'DELETE',root+'/files',{path:healthFile,confirmation:'delete:'+m.fixture.websiteId+':'+healthFile}).then(result=>checked(result,'hosting-dns.health-cleanup')));
  let cleanupError;for(const action of cleanup){try{await action();}catch(error){cleanupError??=error;}}
  if(cleanupError)throw cleanupError;
 }
});
