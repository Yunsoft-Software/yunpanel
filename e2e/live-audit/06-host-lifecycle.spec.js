import tls from 'node:tls';
import {randomBytes} from 'node:crypto';
import {test,expect,manifest,saveManifest,apiCall,waitJob,ready,main} from './support.js';
function owned(){const m=manifest();expect(m.fixture.createdWebsiteIds).toContain(m.fixture.websiteId);expect(m.fixture.createdDomainIds).toContain(m.fixture.domainId);expect(m.fixture.provisioningReady).toBe(true);return m;}
function record(action,data){const m=manifest();m.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(m);}
async function applyDomain(api,csrf,m){
 for(const action of ['stage','activate']){const r=await apiCall(api,csrf,'POST','/api/panel/domains/'+m.fixture.domainId+'/'+action,{});record('domain.'+action,{httpStatus:r.status});expect(r.status).toBe(202);const job=await waitJob(api,r.data.id);record('domain.'+action+'.finished',{jobId:job.id,status:job.status});expect(job.status).toBe('succeeded');}
}
function presented(hostname){return new Promise((resolve,reject)=>{const socket=tls.connect({host:'157.180.11.28',port:443,servername:hostname,rejectUnauthorized:true},()=>{const c=socket.getPeerCertificate();resolve({fingerprint:c.fingerprint256,validFrom:c.valid_from,validTo:c.valid_to,subjectaltname:c.subjectaltname,authorized:socket.authorized});socket.end();});socket.setTimeout(10000,()=>socket.destroy(new Error('TLS observation timed out')));socket.on('error',reject);});}

test('@mutation SSL issue on the disposable hostname produces a trusted, matching live certificate',async({liveApi,page})=>{
 test.setTimeout(240000);const m=owned();
 const all=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/certificates');const email=m.fixture.acmeEmail??all.data.find(v=>v.state==='active'&&v.email)?.email;expect(Boolean(email),'Reuse the existing ACME account contact').toBe(true);
 let issue=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/domains/'+m.fixture.domainId+'/certificates/issue',{email,staging:false});record('ssl.initial-issue',{httpStatus:issue.status,code:issue.body.error?.code});
 if(issue.status===409&&issue.body.error?.code==='http_domain_not_active'){
  await applyDomain(liveApi.api,liveApi.csrf,m);
  issue=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/domains/'+m.fixture.domainId+'/certificates/issue',{email,staging:false});record('ssl.issue-after-publish',{httpStatus:issue.status,code:issue.body.error?.code});
 }
 expect(issue.status,'Real CA issuance must succeed, never a mock').toBe(202);const issueJob=issue.data.job??issue.data;const finished=await waitJob(liveApi.api,issueJob.id,180000);record('ssl.issue.finished',{jobId:finished.id,status:finished.status});expect(finished.status).toBe('succeeded');
 const certificates=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/certificates');const certificate=certificates.data.find(v=>v.domainId===m.fixture.domainId&&v.state==='active');expect(certificate).toBeDefined();const current=manifest();current.fixture.certificateId=certificate.id;saveManifest(current);
 await applyDomain(liveApi.api,liveApi.csrf,m);const physical=await presented(m.fixture.hostname);record('ssl.physical-issued',physical);expect(physical.authorized).toBe(true);expect(physical.subjectaltname).toContain(m.fixture.hostname);
 await ready(page,'/websites/'+m.fixture.domainId+'/ssl');await expect(main(page)).toContainText(/\d+ gün/);
});
test('@mutation SSL manual renewal changes the actual fingerprint and expiry instead of returning false success',async({liveApi})=>{
 test.setTimeout(180000);const m=owned();expect(m.fixture.certificateId,'Real issuance is required before the renewal test').toBeTruthy();const before=await presented(m.fixture.hostname);
 const queued=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/certificates/'+m.fixture.certificateId+'/renew',{dryRun:false});expect(queued.status).toBe(202);const job=await waitJob(liveApi.api,queued.data.id);record('ssl.renew.finished',{jobId:job.id,status:job.status,resultStatus:job.result?.status});expect(job.status).toBe('succeeded');
 const after=await presented(m.fixture.hostname);record('ssl.renew.physical-comparison',{before,after,changed:before.fingerprint!==after.fingerprint});expect.soft(after.fingerprint,'Manual renewal must actually create a new certificate').not.toBe(before.fingerprint);expect.soft(Date.parse(after.validTo)).toBeGreaterThan(Date.parse(before.validTo));
});
test('@mutation A dedicated Restic repository initializes on the actual host',async({liveApi})=>{
 test.setTimeout(120000);const m=owned();const name='ypaudit-'+m.runId;
 const previous=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/backups/repositories');expect(previous.status).toBe(200);
 let repo=previous.data.find(r=>r.name===name);
 if(!repo){const created=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/backups/repositories',{name,backend:'local',password:randomBytes(24).toString('base64url'),initialize:true});record('backup.repository.create',{httpStatus:created.status,code:created.body.error?.code});expect(created.status).toBe(201);repo=created.data;}
 const current=manifest();current.fixture.ownedRepositoryId=repo.id;current.fixture.ownedRepositoryTarget=repo.target;current.fixture.repositoryId=repo.id;saveManifest(current);expect(repo.status).toBe('ready');
});
test('@mutation Backup creates an actual Restic snapshot receipt before content verification',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();expect(m.fixture.repositoryId).toBeTruthy();const marker='BACKUP-MARKER-'+m.runId;const name='backup-proof-'+m.runId+'.txt';
 const uploaded=await apiCall(liveApi.api,liveApi.csrf,'PUT','/api/panel/websites/'+m.fixture.websiteId+'/files/upload?path='+name,Buffer.from(marker));expect([200,201]).toContain(uploaded.status);
 const preview=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/backup/preview',{repositoryId:m.fixture.repositoryId});expect(preview.status).toBe(200);
 const backup=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/backup-operations',{kind:'backup',repositoryId:m.fixture.repositoryId,expectedPreviewDigest:preview.data.backupSetDigest,confirmation:preview.data.confirmation,tags:['ypaudit-'+m.runId]});record('backup.execute',{httpStatus:backup.status,status:backup.data?.status});expect(backup.status).toBe(202);
 let operation=backup.data;for(let n=0;n<90&&!['succeeded','failed'].includes(operation.status);n++){await new Promise(r=>setTimeout(r,600));operation=(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/backup-operations/'+operation.id)).data;}record('backup.finished',{operationId:operation.id,status:operation.status,code:operation.error?.code});expect(operation.status).toBe('succeeded');
 const snapshot=operation.result?.snapshot??operation.snapshot;const snapshotId=snapshot?.snapshotId??snapshot?.id;expect(snapshotId,'A real snapshot receipt is required').toBeTruthy();const current=manifest();current.fixture.snapshotId=snapshotId;current.fixture.backupMarkerPath=name;saveManifest(current);
 await ready(page,'/websites/'+m.fixture.domainId+'/backup');
});
test('@mutation A real selective Restic restore restores the saved file contents',async({liveApi})=>{
 test.setTimeout(180000);const m=owned();expect(m.fixture.snapshotId).toBeTruthy();expect(m.fixture.ownedRepositoryId).toBe(m.fixture.repositoryId);const name=m.fixture.backupMarkerPath;
 const website=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId);expect(website.status).toBe(200);const target=website.data.documentRoot+'/'+name;
 const upload=await apiCall(liveApi.api,liveApi.csrf,'PUT','/api/panel/websites/'+m.fixture.websiteId+'/files/upload?path='+name,Buffer.from('AFTER-SNAPSHOT-'+m.runId));expect(upload.status).toBe(200);
 const input={repositoryId:m.fixture.repositoryId,snapshotId:m.fixture.snapshotId,healthPath:'/'+name,timeoutSeconds:30,include:[target]};
 const p=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/restore/preview',input);record('backup.restore.preview',{httpStatus:p.status,code:p.body.error?.code});expect(p.status).toBe(200);
 const q=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:p.data.previewDigest,confirmation:p.data.confirmation});record('backup.restore.queue',{httpStatus:q.status,code:q.body.error?.code});expect(q.status).toBe(202);
 let op=q.data;for(let n=0;n<150&&!['succeeded','failed'].includes(op.status);n++){await new Promise(r=>setTimeout(r,600));op=(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/backup-operations/'+op.id)).data;}record('backup.restore.finished',{operationId:op.id,status:op.status,code:op.error?.code});expect(op.status).toBe('succeeded');
 const actual=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/files/text?path='+name);expect(actual.status).toBe(200);expect(actual.data.content).toBe('BACKUP-MARKER-'+m.runId);
});
test('@mutation Suspension stops only the owned Website and resume restores its HTTP service',async({liveApi})=>{
 test.setTimeout(120000);const m=owned();const root='/api/panel/websites/'+m.fixture.websiteId+'/files',name='suspend-proof-'+m.runId+'.txt',marker='SUSPEND-PROOF-'+m.runId;
 await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/file',{path:name});const upload=await liveApi.api.put(root+'/upload?path='+encodeURIComponent(name),{data:Buffer.from(marker),headers:{'x-csrf-token':liveApi.csrf,'content-type':'application/octet-stream'}});expect(upload.status()).toBe(200);
 const before=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(before.status()).toBe(200);expect(await before.text()).toBe(marker);
 const preview=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/suspension');expect(preview.status).toBe(200);
 const p=preview.data.preview;expect(p.readyToSuspend).toBe(true);const started=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/suspension/start',{previewDigest:p.previewDigest,confirmation:p.confirmation});record('site.suspend',{httpStatus:started.status,status:started.data?.status});expect(started.status).toBe(201);const op=started.data;
 const paused=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect.soft(await paused.text(),'The suspended site must stop serving its active content').not.toBe(marker);record('site.suspend.physical',{httpStatus:paused.status(),activeMarkerServed:(await paused.text())===marker});
 const confirmation=op.actions?.resumeConfirmation??'resume-website:'+m.fixture.websiteId+':'+op.id+':'+op.updatedAt;
 const resumed=await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/suspension/resume',{operationId:op.id,expectedUpdatedAt:op.updatedAt,confirmation});record('site.resume',{httpStatus:resumed.status,status:resumed.data?.status});expect(resumed.status).toBe(200);
 let active;for(let n=0;n<20;n++){active=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);if(active.status()===200&&(await active.text())===marker)break;await new Promise(r=>setTimeout(r,500));}expect(active.status()).toBe(200);expect(await active.text()).toBe(marker);
 await apiCall(liveApi.api,liveApi.csrf,'DELETE',root,{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name});
});
