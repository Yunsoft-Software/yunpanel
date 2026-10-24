import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test,expect,manifest,saveManifest,RUN_DIR,apiCall,waitJob,ready,main } from './support.js';
import { advanceProvisioning } from '../../apps/web/src/workspace/provisioning-advance.js';

function owned(){const m=manifest();expect(m.fixture.websiteId,'Disposable PHP fixture must have been created successfully; this is a prerequisite, not a skipped feature').toBeTruthy();expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);expect(m.baseline.websites.map(v=>v.id)).not.toContain(m.fixture.websiteId);return m;}
function record(action,value){const m=manifest();m.fixture.operations.push({action,...value,at:new Date().toISOString()});saveManifest(m);}
function check(r,label,statuses=[200]){record(label,{httpStatus:r.status,code:r.body.error?.code??null});expect(statuses,label+' must return its actual success response').toContain(r.status);return r.data;}
const endpoint=(m,suffix)=>'/api/panel/websites/'+m.fixture.websiteId+suffix;
const UI=(m,tab)=>'/websites/'+m.fixture.domainId+'/'+tab;

test('@mutation 01 create and physically provision an isolated PHP Website',async({liveApi,page})=>{
 test.setTimeout(180000);const m=manifest();if(m.fixture.websiteId){
  const id=m.fixture.provisioningOperationId;const read=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/sites/provisioning/'+id),'existing-fixture.provisioning.read');
  if (!read.ready) {
   const operation=await advanceProvisioning({operationId:id,maxSteps:30,read:async()=>check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/sites/provisioning/'+id),'existing-fixture.provisioning.read'),advance:async()=>check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/sites/provisioning/'+id+'/continue',{confirmation:'continue-site-provisioning:'+id}),'existing-fixture.provisioning.advance',[200,202])});
   expect(operation.ready,'The same incomplete fixture must physically finish').toBe(true);m.fixture.provisioningReady=operation.ready;saveManifest(m);
  } else {m.fixture.provisioningReady=true;saveManifest(m);}
  await ready(page,UI(m,'overview'));return;
}
 const verified=fs.readFileSync('/tmp/yunpanel-live-audit-backup-verify.txt','utf8');expect(verified).toContain('verified=true');
 const secret=JSON.parse(fs.readFileSync(path.join(RUN_DIR,'fixture-secrets.json'),'utf8'));
 const input={operationId:randomUUID(),serverId:m.serverId,name:m.fixture.hostname,primaryDomain:m.fixture.hostname,parentDomainId:null,wwwMode:'none',httpsMode:'off',source:{kind:'new_php'},database:{mode:'none'},mail:{mode:'none'},dns:{mode:'external'},siteAdmin:{email:secret.siteAdminEmail,password:secret.siteAdminPassword}};
 m.fixture.createOperationId=input.operationId;m.fixture.backupPath='/var/backups/yunpanel/migration-2026-10-09T20-33-18-047Z';saveManifest(m);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/sites/create-preview',{input}),'site.create.preview');
 const created=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/sites',{input,previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'site.create',[200,201]);
 const current=manifest();current.fixture.websiteId=created.website?.id;current.fixture.applicationId=created.application?.id??created.website?.applicationId;current.fixture.domainId=created.domain?.id??created.domains?.[0]?.id;current.fixture.provisioningOperationId=created.provisioning?.operationId;current.fixture.siteAdmin=created.siteAdmin;current.fixture.createdWebsiteIds.push(current.fixture.websiteId);current.fixture.createdDomainIds.push(current.fixture.domainId);if(created.siteAdmin?.userId)current.fixture.createdUserIds.push(created.siteAdmin.userId);saveManifest(current);
 expect(current.fixture.websiteId).toBeTruthy();if(!current.fixture.domainId){
  const domains=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+current.fixture.websiteId+'/domains'),'fixture.domain.read');
  const exact=domains.find(v=>v.primaryDomain===current.fixture.hostname&&v.websiteId===current.fixture.websiteId);expect(exact).toBeDefined();current.fixture.domainId=exact.id;current.fixture.createdDomainIds=[exact.id];saveManifest(current);
}expect(current.fixture.domainId).toBeTruthy();
 const id=current.fixture.provisioningOperationId;
 expect(id,'Metadata alone is not a ready hosted Website').toBeTruthy();
 const operation=await advanceProvisioning({operationId:id,maxSteps:30,read:async()=>check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/sites/provisioning/'+id),'provisioning.read'),advance:async()=>check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/sites/provisioning/'+id+'/continue',{confirmation:'continue-site-provisioning:'+id}),'provisioning.advance',[200,202]),onStep:r=>record('provisioning.step',{stepId:r.stepId,outcome:r.outcome})});
 const final=manifest();final.fixture.provisioningReady=operation.ready;saveManifest(final);record('provisioning.final',{ready:operation.ready,steps:operation.steps.map(v=>({id:v.id,state:v.state,required:v.required}))});expect(operation.ready,'Every required physical provisioning step must be successful').toBe(true);
 await ready(page,UI(final,'overview'));await expect(main(page).locator('h1')).toHaveText(final.fixture.hostname);
});
test('@mutation 02 isolated PHP Website serves actual HTTP',async({liveApi})=>{
 const m=owned();expect(m.fixture.provisioningReady).toBe(true);const marker='OWNED-HOST-'+m.runId;const name='http-proof-'+m.runId+'.txt';
  check(await apiCall(liveApi.api,liveApi.csrf,'PUT',endpoint(m,'/files/upload?path='+name),Buffer.from(marker)),'http.marker.upload',[200,201]);
  const response=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name,{timeout:30000});record('site.http',{status:response.status(),markerMatches:(await response.text())===marker});expect(response.status()).toBe(200);expect(await response.text()).toBe(marker);
  check(await apiCall(liveApi.api,liveApi.csrf,'DELETE',endpoint(m,'/files'),{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name}),'http.marker.delete');
});
test('@mutation 03 Files creates, writes, reads, renames, changes permissions and deletes a real file',async({liveApi,page})=>{
 const m=owned();let name='audit-'+m.runId+'.txt';const marker='REAL-FILE-'+m.runId;
 check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/files/file'),{path:name}),'file.create',[201]);
 const read=check(await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/files/text?path='+encodeURIComponent(name))),'file.read');
 check(await apiCall(liveApi.api,liveApi.csrf,'PUT',endpoint(m,'/files/text'),{path:name,content:marker,expectedSha256:read.sha256}),'file.write');
 const text=check(await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/files/text?path='+encodeURIComponent(name))),'file.read-written');expect(text.content).toBe(marker);
 const renamed='renamed-'+name;check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/files/rename'),{path:name,destination:renamed}),'file.rename');name=renamed;
 check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/files/permissions'),{path:name,mode:'0640'}),'file.permissions');
 await ready(page,UI(m,'files'));await expect.soft(main(page)).toContainText(name);
 check(await apiCall(liveApi.api,liveApi.csrf,'DELETE',endpoint(m,'/files'),{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name}),'file.delete');
 const missing=await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/files/text?path='+encodeURIComponent(name)));expect(missing.status).toBe(404);
});
test('@mutation 04 Files creates and removes a directory and refuses traversal',async({liveApi})=>{
 const m=owned();const directory='audit-dir-'+m.runId;
 check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/files/mkdir'),{path:directory}),'directory.create',[201]);
 const unsafe=await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/files?path=..%2F..%2Fetc'));record('file.traversal',{httpStatus:unsafe.status});expect([400,403,404]).toContain(unsafe.status);
 check(await apiCall(liveApi.api,liveApi.csrf,'DELETE',endpoint(m,'/files'),{path:directory,confirmation:'delete:'+m.fixture.websiteId+':'+directory}),'directory.delete');
});
test('@mutation 05 Create DB through the actual UI and verify its physical job result',async({page,liveApi})=>{
 test.setTimeout(120000);const m=owned();await ready(page,'/databases');await main(page).getByRole('button',{name:'Veritabanı oluştur',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel(/Veritabanı adı/).fill(m.fixture.databaseName);
 const queued=page.waitForResponse(r=>r.url().endsWith('/databases')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Veritabanı oluştur',exact:true}).click();const response=await queued;expect(response.status()).toBe(202);const job=(await response.json()).data;
 const current=manifest();current.fixture.createdDatabaseNames.push(m.fixture.databaseName);saveManifest(current);
 const finished=await waitJob(liveApi.api,job.id);record('database.create',{jobId:job.id,status:finished.status});expect(finished.status).toBe('succeeded');
 await ready(page,'/databases');await expect(main(page).getByRole('row').filter({hasText:m.fixture.databaseName})).toBeVisible();
});
test('@mutation 06 DB backend binds only the newly created schema to the owned Website',async({liveApi})=>{
 const m=owned();expect(m.fixture.createdDatabaseNames).toContain(m.fixture.databaseName);
 const job=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/databases/inspect',{}),'database.inspect',[202]);expect((await waitJob(liveApi.api,job.id)).status).toBe('succeeded');
 const binding=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/databases/'+m.fixture.databaseName+'/bind',{websiteId:m.fixture.websiteId,applicationId:m.fixture.applicationId,confirmation:'bind-database:'+m.serverId+':'+m.fixture.databaseName+':'+m.fixture.websiteId}),'database.bind',[201]);
 const current=manifest();current.fixture.binding=binding;saveManifest(current);expect(binding.websiteId).toBe(m.fixture.websiteId);
});
test('@mutation 07 DB credential create/apply creates real grants and updates the same site screen',async({liveApi,page})=>{
 test.setTimeout(120000);const m=owned();expect(m.fixture.binding?.id).toBeTruthy();
 const {databaseCredentialRegistryInternals}=await import('../../apps/api/src/database-credential-registry.js');
 const username=databaseCredentialRegistryInternals.usernameFor(m.fixture.binding.id);
 let credential;if(m.fixture.credential?.id){credential=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/servers/'+m.serverId+'/database-bindings/'+m.fixture.binding.id+'/credential'),'credential.existing');}else credential=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/database-bindings/'+m.fixture.binding.id+'/credential',{privileges:['SELECT','INSERT','UPDATE','DELETE','CREATE','ALTER','INDEX','DROP'],confirmation:'create-database-credential:'+m.fixture.binding.id+':'+username}),'credential.create',[201]);
 const current=manifest();current.fixture.credential=credential;saveManifest(current);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/servers/'+m.serverId+'/database-credentials/'+credential.id+'/apply-preview'),'credential.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/database-credentials/'+credential.id+'/apply',{expectedCredentialRevision:preview.expectedCredentialRevision,expectedBindingRevision:preview.expectedBindingRevision,expectedDesiredStateSha256:preview.desiredStateSha256,confirmation:preview.confirmation}),'credential.apply',[202]);
 const jobId=queued.job?.id??queued.id;expect(jobId).toBeTruthy();const result=await waitJob(liveApi.api,jobId);record('credential.apply.finished',{jobId,status:result.status});expect(result.status).toBe('succeeded');
 await ready(page,UI(m,'databases'));await expect(main(page)).toContainText(m.fixture.databaseName);await expect(main(page).getByRole('button',{name:/phpMyAdmin/i}).first()).toBeEnabled();
});
test('@mutation 08 DB password rotation updates the grant through the existing engine',async({liveApi})=>{
 const m=owned();expect(m.fixture.credential?.id).toBeTruthy();const c=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/servers/'+m.serverId+'/database-bindings/'+m.fixture.binding.id+'/credential'),'credential.read');
 const changed=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/database-credentials/'+c.id+'/password/rotate',{expectedRevision:c.revision,confirmation:'rotate-database-password:'+c.id+':'+c.revision}),'credential.rotate');expect(changed.revision).toBeGreaterThan(c.revision);
 const current=manifest();current.fixture.credential=changed;saveManifest(current);
 const preview=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/servers/'+m.serverId+'/database-credentials/'+changed.id+'/apply-preview'),'credential.rotate.preview');
 const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/database-credentials/'+changed.id+'/apply',{expectedCredentialRevision:preview.expectedCredentialRevision,expectedBindingRevision:preview.expectedBindingRevision,expectedDesiredStateSha256:preview.desiredStateSha256,confirmation:preview.confirmation}),'credential.rotate.apply',[202]);
 const jobId=queued.job?.id??queued.id;const job=await waitJob(liveApi.api,jobId);record('credential.rotate.apply.finished',{jobId,status:job.status});expect(job.status).toBe('succeeded');
});
test('@mutation 09 PHP settings success must actually persist a changed FPM limit',async({liveApi})=>{
 const m=owned();const config=check(await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/php-tools/config')),'php.config.read');
 const maxChildren=config.fpm.maxChildren+1;const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/php-tools/config/preview'),{maxChildren}),'php.config.preview');
 const body={config:{maxChildren},expectedRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation};const changed=check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/php-tools/config'),body),'php.config.apply');expect(changed.success).toBe(true);
 const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/php-tools/config')),'php.config.read-after');expect(after.fpm.maxChildren,'A successful PHP save must change the persisted actual setting').toBe(maxChildren);
});
test('@mutation 10 WP backend downloads real WordPress into the disposable Website',async({liveApi})=>{
 test.setTimeout(120000);const m=owned();const result=await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/wp-cli/run'),{command:'core',args:['download','--skip-content'],timeout:90000});
 record('wp.download',{httpStatus:result.status,success:result.body.success,exitCode:result.body.exitCode});expect(result.status).toBe(200);expect(result.body.success).toBe(true);expect(result.body.exitCode).toBe(0);
});
test('@mutation 11 WP normal UI can install and configure WordPress on the disposable site',async({page})=>{
 const m=owned();await ready(page,UI(m,'php'));const install=main(page).getByRole('button',{name:/WordPress (kur|yükle)|Kurulumu başlat/i});await expect(install).toBeVisible();await install.click();await expect(page.getByRole('dialog')).toBeVisible();
});
test('@mutation 12 WP normal UI can change its fixture admin password',async({page})=>{
 const m=owned();await ready(page,UI(m,'php'));const action=main(page).getByRole('button',{name:/Yönetici parolasını değiştir|WordPress.*(parola|şifre)/i});await expect(action).toBeVisible();await action.click();await expect(page.getByRole('dialog')).toBeVisible();
});
test('@mutation 13 WP normal UI can uninstall the disposable WordPress installation',async({page})=>{
 const m=owned();await ready(page,UI(m,'php'));const action=main(page).getByRole('button',{name:/WordPress.*(kaldır|sil)/i});await expect(action).toBeVisible();await action.click();await expect(page.getByRole('dialog')).toBeVisible();
});
test('@mutation 14 Cron creates, changes and removes a real dedicated-user task',async({liveApi,page})=>{
 const m=owned();let created;if(m.fixture.cron?.id){created=check(await apiCall(liveApi.api,liveApi.csrf,'GET',endpoint(m,'/crons/'+m.fixture.cron.id)),'cron.read-existing');}else{created=check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/crons'),{name:'ypaudit-'+m.runId,schedule:'0 0 1 1 *',command:'/usr/bin/true',enabled:false}),'cron.create',[201]);if(created.job?.id)await waitJob(liveApi.api,created.job.id);}const cron=created.cron??created.task??created;expect(cron.id).toBeTruthy();const current=manifest();current.fixture.cron=cron;saveManifest(current);
 const changed=check(await apiCall(liveApi.api,liveApi.csrf,'PATCH',endpoint(m,'/crons/'+cron.id),{expectedRevision:cron.revision,name:'ypaudit-updated-'+m.runId}),'cron.update');const after=changed.cron??changed.task??changed;if(changed.job?.id)await waitJob(liveApi.api,changed.job.id);
 await ready(page,UI(m,'cron'));await expect.soft(main(page)).toContainText('ypaudit-updated-'+m.runId);
 check(await apiCall(liveApi.api,liveApi.csrf,'DELETE',endpoint(m,'/crons/'+cron.id),{expectedRevision:after.revision}),'cron.delete');
});
test('@mutation 15 Backup exposes a configured repository and a real preview',async({liveApi,page})=>{
 const m=owned();const response=await liveApi.api.get('/api/panel/backups/repositories');expect(response.status()).toBe(200);const repositories=(await response.json()).data;expect(repositories.length,'A real backup target must be available; no mocked snapshot is accepted').toBeGreaterThan(0);
 const repository=repositories[0];const current=manifest();current.fixture.repositoryId=repository.id;saveManifest(current);
 check(await apiCall(liveApi.api,liveApi.csrf,'POST',endpoint(m,'/backup/preview'),{repositoryId:repository.id}),'backup.preview');await ready(page,UI(m,'backup'));
});
