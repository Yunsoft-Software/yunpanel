import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {test,expect,ORIGIN,RUN_DIR,manifest,saveManifest,apiCall,waitJob,ready,main} from './support.js';

test.beforeEach(async({context})=>{
 const dist=path.resolve('apps/web/dist');
 await context.route(url=>url.origin===ORIGIN&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/tools/'),async route=>{
  const url=new URL(route.request().url()),file=route.request().isNavigationRequest()?path.join(dist,'index.html'):path.join(dist,url.pathname);
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
  const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
  return route.fulfill({body:fs.readFileSync(file),contentType,headers:{'Cache-Control':'no-store'}});
 });
});
function record(action,proof){const m=manifest();m.fixture.operations.push({action,...proof,at:new Date().toISOString()});saveManifest(m);}
const execute=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
async function actualOwnedEnvironment(target,expectedHash){
 const m=manifest(),sha=process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA;
 if(!/^[a-f0-9]{64}$/.test(sha??'')||!/^[a-f0-9]{64}$/.test(expectedHash)
  ||!m.fixture.createdWebsiteIds.includes(target.websiteId)||!m.fixture.createdDomainIds.includes(target.domainId)
  ||!/^yp-node-[a-z0-9-]+\.157\.180\.11\.28\.sslip\.io$/.test(target.hostname))throw new Error('Owned Node environment fixture required');
 const script=`python3 - <<'PY'
from pathlib import Path
import json,hashlib,pwd,os,time
p=Path('/var/lib/yunpanel/acceptance-candidates/20261010-84576b66');s=json.loads((p/'native-test-window.json').read_text())
assert s['target']=='157.180.11.28' and s['status']=='ready' and s['deployed'] is False and s['archiveSha256']=='${sha}'
e=json.loads((p/'runtime-env.json').read_text());records=json.loads(Path(e['YUNPANEL_WEBSITE_STORE']).read_text())
if isinstance(records,dict):records=records['websites']
w=next(w for w in records if w['id']=='${target.websiteId}')
assert w['applicationId']=='${target.applicationId}' and w['runtimeType']=='node'
assert not any(other['id']!=w['id'] and other.get('unixUser')==w['unixUser'] for other in records)
uid=pwd.getpwnam(w['unixUser']).pw_uid;assert uid>0
catalog=json.loads(Path(e['YUNPANEL_APPLICATION_ENVIRONMENT_STORE']).read_text());meta=next(x for x in catalog['environments'] if x['applicationId']==w['applicationId'])
applications=json.loads(Path(e['YUNPANEL_APPLICATION_STORE']).read_text());app=next(x for x in applications['applications'] if x['id']==w['applicationId'])
assert meta['appliedRevision']==meta['revision'] and meta['appliedReleaseId']==app['currentReleaseId']
include=Path('/etc/yunpanel/passenger-env')/(w['applicationId']+'.conf')
assert include.read_text().splitlines()[0]=='# YunPanel Passenger environment '+w['applicationId']+' revision '+str(meta['revision'])
current=Path('/var/lib/yunpanel/apps')/w['applicationId']/'current';assert os.readlink(current)=='releases/'+app['currentReleaseId']
release=current.resolve(strict=True)
for attempt in range(40):
 found=[]
 for proc in Path('/proc').iterdir():
  if not proc.name.isdigit():continue
  try:
   if proc.stat().st_uid!=uid or os.readlink(proc/'exe').split('/')[-1]!='node':continue
   cwd=(proc/'cwd').resolve(strict=True)
   if not cwd.is_relative_to(release):continue
   values=(proc/'environ').read_bytes().split(b'\\0');value=next((v.split(b'=',1)[1] for v in values if v.startswith(b'YP_NATIVE_ENV_PROOF=')),None)
   if value is not None:found.append(hashlib.sha256(value).hexdigest())
  except (FileNotFoundError,ProcessLookupError,PermissionError):continue
 if found and set(found)=={'${expectedHash}'}:
  print(json.dumps({'verified':True,'siteUserIsNonRoot':True,'processes':len(found),'revisionConsistent':True,'releaseScoped':True,'valueHash':'${expectedHash}'}));break
 time.sleep(.5)
else:raise RuntimeError('owned_runtime_environment_unverified')
PY`;
 try{const result=await execute('python3',[path.resolve('.local/acceptance-candidate/host-control.py'),script],{timeout:50000,maxBuffer:4096});const proof=JSON.parse(result.stdout.split('\n').find(line=>line.startsWith('{'))??'null');if(proof?.verified!==true||proof.siteUserIsNonRoot!==true||proof.revisionConsistent!==true||proof.releaseScoped!==true)throw new Error('unverified');return proof;}
 catch{throw new Error('Actual owned Node process environment was not verified; access material and values withheld');}
}

test('@mutation source normal Node form provisions a dedicated real Passenger application from the public Heroku sample',async({page,liveApi})=>{
 test.setTimeout(360000);const m=manifest();expect(m.fixture.provisioningReady).toBe(true);
 if(!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA??''))throw new Error('Exact native source required');
 let target=m.fixture.extraNode?.removed?null:m.fixture.extraNode;
 if(!target){
  const hostname='yp-node-'+m.runId+'.157.180.11.28.sslip.io';
  await ready(page,'/websites/new');await page.getByLabel('Alan adı',{exact:true}).fill(hostname);
  await main(page).getByRole('button',{name:'Devam et',exact:true}).click();
  await page.getByLabel('Site türü',{exact:true}).selectOption('new_node');
  await page.getByLabel('GitHub repository',{exact:true}).fill('https://github.com/heroku/node-js-getting-started.git');
  await page.getByLabel('Branch',{exact:true}).fill('main');
  await page.getByLabel('Başlangıç dosyası',{exact:true}).fill('index.js');
  await page.getByLabel('Sağlık kontrolü yolu',{exact:true}).fill('/');
  await main(page).getByRole('button',{name:'Devam et',exact:true}).click();
  await page.getByLabel('Sertifika yönetimi',{exact:true}).selectOption('off');
  await page.getByRole('checkbox',{name:/Otomatik E-Posta/}).uncheck();
  const reply=page.waitForResponse(response=>response.url().endsWith('/api/panel/sites')&&response.request().method()==='POST');
  await main(page).getByRole('button',{name:'Siteyi oluştur',exact:true}).click();
  const response=await reply;expect([200,201]).toContain(response.status());const created=(await response.json()).data;
  target={hostname,websiteId:created.website.id,applicationId:created.application.id,provisioningOperationId:created.provisioning.operationId};
  const saved=manifest();saved.fixture.extraNode=target;saved.fixture.createdWebsiteIds.push(target.websiteId);saveManifest(saved);
  await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı',{timeout:240000});
 }
 // Inspect the existing durable operation, never create another Website to
 // recover an ambiguous or interrupted first submission.
 for(let attempt=0;attempt<240;attempt++){
  const result=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/sites/provisioning/'+target.provisioningOperationId);
  expect(result.status).toBe(200);const operation=result.data;
  record('node.provisioning.phase',{operationId:target.provisioningOperationId,status:operation.status,ready:operation.ready});
  if(operation.ready)break;
  expect(['failed','blocked']).not.toContain(operation.status);
  const next=operation.steps.find(step=>step.state==='pending');
  if(next){
   const advance=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/sites/provisioning/'+target.provisioningOperationId+'/continue',{confirmation:'continue-site-provisioning:'+target.provisioningOperationId});
   expect([200,202,409]).toContain(advance.status);
  }
  await new Promise(resolve=>setTimeout(resolve,750));
 }
 const operation=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/sites/provisioning/'+target.provisioningOperationId);expect(operation.data.ready).toBe(true);
 const domains=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+target.websiteId+'/domains');expect(domains.status).toBe(200);
 const domain=domains.data.find(item=>item.primaryDomain===target.hostname);expect(domain?.websiteId).toBe(target.websiteId);
 const saved=manifest();saved.fixture.extraNode.domainId=domain.id;if(!saved.fixture.createdDomainIds.includes(domain.id))saved.fixture.createdDomainIds.push(domain.id);saveManifest(saved);
 const application=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/applications/'+target.applicationId);expect(application.status).toBe(200);
 expect(application.data.state).toBe('active');expect(application.data.currentCommitSha).toMatch(/^[a-f0-9]{40}$/);
 expect(application.data.runtimeAdapter).toBe('passenger');expect(application.data.activeRuntime.port).toBe(null);
 const actual=await liveApi.api.get('http://'+target.hostname+'/');expect(actual.status()).toBe(200);
 expect((await actual.text()).toLowerCase()).toContain('node');
 await ready(page,'/websites/'+domain.id+'/node');expect(page.auditErrors).toEqual([]);
 record('node.physical-provisioning',{verified:true,websiteId:target.websiteId,applicationId:target.applicationId,commitSha:application.data.currentCommitSha});
});

test('@mutation source restores a secret in the actual running dedicated Node process twice from the same Restic snapshot',async({liveApi})=>{
 test.setTimeout(300000);const m=manifest(),target=m.fixture.extraNode;expect(target?.domainId).toBeTruthy();
 expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);const root='/api/panel/websites/'+target.websiteId;
 const secretFile=path.join(RUN_DIR,'fixture-secrets.json'),secrets=JSON.parse(fs.readFileSync(secretFile,'utf8'));
 secrets.nodeEnvironmentProof??=randomBytes(32).toString('base64url');fs.writeFileSync(secretFile,JSON.stringify(secrets),{mode:0o600});
 async function setAndRestart(value){
  const saved=await apiCall(liveApi.api,liveApi.csrf,'PUT','/api/panel/applications/'+target.applicationId+'/environment/YP_NATIVE_ENV_PROOF',{value,secret:true});expect(saved.status).toBe(200);
  const queued=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/application/restart',{});record('node.env.restart-queue',{status:queued.status,code:queued.body.error?.code});expect(queued.status).toBe(202);
  const job=await waitJob(liveApi.api,queued.data.id,120000);record('node.env.restart',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
  expect((await liveApi.api.get('http://'+target.hostname+'/')).status()).toBe(200);return actualOwnedEnvironment(target,hash(value));
 }
 async function finish(operation){const job=await waitJob(liveApi.api,operation.jobId,150000);record('node.env.backup-job',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');const result=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/backup-operations/'+operation.id);expect(result.status).toBe(200);expect(result.data.status).toBe('succeeded');return result.data;}
 record('node.env.original-process',await setAndRestart(secrets.nodeEnvironmentProof));
 const repositories=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/backups/repositories');expect(repositories.status).toBe(200);
 let repository=repositories.data.find(item=>item.name==='website-'+target.websiteId);
 if(!repository){const created=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/backups/repositories',{name:'website-'+target.websiteId,backend:'local',password:randomBytes(36).toString('base64url'),initialize:true});expect(created.status).toBe(201);repository=created.data;}
 const preview=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup/preview',{repositoryId:repository.id});expect(preview.status).toBe(200);
 const backup=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'backup',repositoryId:repository.id,expectedPreviewDigest:preview.data.backupSetDigest,confirmation:preview.data.confirmation,tags:['native-node-env-'+m.runId]});expect(backup.status).toBe(202);
 const snapshotId=(await finish(backup.data)).result?.snapshot?.snapshotId;expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);
 const current=manifest();current.fixture.extraNode.environmentBackup={repositoryId:repository.id,snapshotId,operationId:backup.data.id};saveManifest(current);
 for(let pass=0;pass<2;pass++){
  const changed=randomBytes(32).toString('base64url');record('node.env.changed-process',await setAndRestart(changed));
  const input={repositoryId:repository.id,snapshotId,include:['environment'],healthPath:'/',timeoutSeconds:30};
  const p=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input);expect(p.status).toBe(200);
  const queued=await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:p.data.previewDigest,confirmation:p.data.confirmation});expect(queued.status).toBe(202);await finish(queued.data);
  expect((await liveApi.api.get('http://'+target.hostname+'/')).status()).toBe(200);
  record('node.env.actual-restored-process',{...await actualOwnedEnvironment(target,hash(secrets.nodeEnvironmentProof)),pass:pass+1,operationId:queued.data.id,snapshotId});
  const status=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/applications/'+target.applicationId+'/environment/status');expect(status.status).toBe(200);expect(status.data.appliedToRunningProcess).toBe(true);
 }
});
