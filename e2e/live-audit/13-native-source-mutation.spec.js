import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import {randomBytes,randomUUID,createHmac,createHash} from 'node:crypto';
import {request} from '@playwright/test';
import {test,expect,apiContext,waitJob,RUN_DIR,ORIGIN,ready,main} from './support.js';
import {createOwnedFixture,cleanupOwnedFixture,readOnlyHostProbe} from './owned-fixture.js';
import {nextRemovalStep} from '../../apps/web/src/workspace/website-removal-model.js';
import {createMailboxRemoval} from '../../apps/web/src/workspace/mailbox-removal-controller.js';

test.describe.configure({mode:'serial'});

// These acceptance gates are retained, never counted as passing or skipped tests.
export const openAcceptances=[

 {id:'13.04',oldCommit:'ba33f4a8^',title:'recovers only the owned static Domain left by the earlier incomplete Website removal plan',assertions:['an orphan Domain belonging to an interrupted removal is recovered using its exact journal and checksum'],reason:'The old case used one fixed October journal. Current normal provisioning and automatic removal do not provide a supported way to manufacture that orphan without corrupting server state.',requiredChannel:'An actual owned interrupted Domain journal, or a separately approved process interruption test'},
 {id:'13.07.version-switch',oldCommit:'ba33f4a8^',title:'PHP version and settings change the actual FPM runtime and persist in the site record',assertions:['a different available PHP major/minor is selected and actual FPM HTTP agrees'],reason:'The authorized native host has only PHP 8.3 installed. Same-version FPM settings are tested separately; installing another server-wide runtime is outside this test scope.',requiredChannel:'A second installed supported PHP runtime'},
 ...(process.env.YUNPANEL_AUDIT_MANAGED_REPAIR==='1'?[]:[{id:'13.02',oldCommit:'ba33f4a8^',title:'managed phpMyAdmin repair stages actual templates and verifies the native gateway',assertions:['repair job succeeded and configuration applied, HTTP/FPM/gateway sockets healthy, transaction receipt'],reason:'Managed repair changes a shared server service. It is executable only in a separately exclusive server window after effect review.',requiredChannel:'Explicit managed repair flag and server-global plus all test-slot locks'}]),
];
let primary,owner,state,stateFile,secretsFile,uploadedStatic,primaryKey,staticKey;
let phase2Uncertain=false;const phase2Jobs=new Map();
let orphanFixture,orphanKey,orphanRecovery;const orphanAdvancedActions=new Set();
const manifest=()=>state;
function saveManifest(value){state=value;fs.writeFileSync(stateFile,JSON.stringify(value,null,2),{mode:0o600});}
function owned(){expect(primary?.ledger.websiteId,'The current run must own its disposable PHP site').toBe(state?.fixture.websiteId);return state;}
function record(action,data){primary.record(action,data);state.fixture.operations.push({action,...data,at:new Date().toISOString()});saveManifest(state);}
function check(r,label,status=200){record(label,{status:r.status,code:r.body?.error?.code??null});expect(Array.isArray(status)?status:[status],label+' '+(r.body?.error?.code??'')).toContain(r.status);if(label.endsWith('.connection')){const value=r.data;expect(value.databaseName).toBe(state.fixture.databaseName);expect(value.username).toBe(state.fixture.credential.username);expect(value.username).not.toBe('root');expect(value.host).toBe('localhost');expect(value.port).toBe(3306);}return r.data;}
async function apiCall(api,csrf,method,endpoint,data){
 let response;for(let attempt=0;;attempt++){try{response=await api.fetch(endpoint,{method,data,headers:{Origin:ORIGIN,'x-csrf-token':csrf,Connection:'close'},timeout:120000,maxRedirects:0});}catch(error){if(method==='GET'&&attempt<3){await new Promise(r=>setTimeout(r,700));continue;}throw error;}if(method==='GET'&&[502,503,504].includes(response.status())&&attempt<3){await new Promise(r=>setTimeout(r,700));continue;}break;}
 const body=await response.json().catch(()=>({}));return{status:response.status(),body,data:body.data??body};
}
async function phase2Read(api,csrf,method,endpoint){expect(method).toBe('GET');try{return await apiCall(api,csrf,method,endpoint);}catch{throw new Error('Phase2 authoritative GET failed; protected transport details withheld');}}
async function phase2OwnerContext(){try{return await apiContext();}catch{throw new Error('A new normal Owner context could not be verified; protected transport details withheld');}}
async function phase2OwnedEffect(label,action){expect(phase2Uncertain,'No new owned effect follows an uncertain outcome').toBe(false);phase2Uncertain=true;try{const result=await action();phase2Uncertain=false;return result;}catch(error){record('phase2.owned-effect-unverified',{label,state:'UNKNOWN_KEEP',noRetry:true});throw new Error('Phase2 owned effect was not verified; protected transport details withheld');}}
async function phase2Post(c,endpoint,data,label,status=200,verify=null){
 expect(phase2Uncertain,'No new mutation follows an uncertain phase2 outcome').toBe(false);phase2Uncertain=true;
 let reply;try{reply=await apiCall(c.api,c.csrf,'POST',endpoint,data);}catch(error){record('phase2.mutation-unknown',{label,state:'UNKNOWN_KEEP',noPostRetry:true});throw new Error('Phase2 mutation response is uncertain; protected transport details withheld');}
 if(reply.status!==status)record('phase2.mutation-hold',{label,status:reply.status,code:reply.body?.error?.code??null,noPostRetry:true});
 const result=check(reply,label,status);if(verify)verify(result);if(status!==202)phase2Uncertain=false;return result;
}
function phase2JobIntent(preview,actionId,options=null){
 const m=owned(),identity=m.fixture;
 if(!preview||!['php.fpm.update','wp.toolkit'].includes(actionId)||preview.serverId!==m.serverId||preview.websiteId!==identity.websiteId||preview.applicationId!==identity.applicationId||preview.unixUser!==identity.unixUser
  ||!Number.isSafeInteger(preview.websiteRevision)||preview.websiteRevision<1||typeof preview.previewDigest!=='string'||!/^([a-f0-9]{64})$/.test(preview.previewDigest))throw new Error('The initial own phase2 preview intent could not be verified');
 if(actionId==='wp.toolkit'&&(!options||Object.keys(options).length!==1||options.action!=='core.update'||!preview.options||Object.keys(preview.options).length!==1||preview.options.action!==options.action))throw new Error('The initial own WordPress core update intent could not be verified');
 if(actionId==='php.fpm.update'&&options!==null)throw new Error('The initial own PHP configuration intent could not be verified');
 const result=Object.freeze({version:1,websiteId:identity.websiteId,applicationId:identity.applicationId,unixUser:identity.unixUser,actionId,websiteRevision:preview.websiteRevision,previewDigest:preview.previewDigest,completed:true,sideEffects:true});
 return Object.freeze({serverId:m.serverId,type:'website.php.action',operation:'website.php.action',resourceType:'application',resourceId:identity.applicationId,result});
}
function phase2JobBinding(job,expected,{terminal=false}={}){
 const keys=['id','serverId','type','operation','resourceType','resourceId','createdAt'];
 if(!job||keys.some(key=>job[key]!==expected[key]))throw new Error('The exact phase2 job binding could not be verified');
 if(terminal&&job.status!==expected.status)throw new Error('The exact phase2 job did not reach its required terminal status');
 if(!terminal&&!['queued','running','succeeded'].includes(job.status))throw new Error('The accepted phase2 job is not queued running or verified succeeded');
 const resultRequired=terminal||job.status==='succeeded';
 if(resultRequired&&(job.result===null||typeof job.result!=='object'||Array.isArray(job.result)||job.error!==null))throw new Error('The terminal phase2 job requires its actual complete result; keep owned resources');
 if(job.result!==null){
  const fields=['version','websiteId','applicationId','unixUser','actionId','websiteRevision','previewDigest','completed','sideEffects'];
  if(!job.result||typeof job.result!=='object'||Array.isArray(job.result)||Object.keys(job.result).length!==fields.length||fields.some(key=>!Object.hasOwn(job.result,key)||job.result[key]!==expected.result[key]))throw new Error('The exact complete phase2 job result does not match its initial own intent');
 }
 return job;
}
function phase2JobTerminal(job,expected){
 phase2JobBinding(job,expected,{terminal:true});record('phase2.job-terminal',{jobId:expected.id,serverId:expected.serverId,resourceType:expected.resourceType,resourceId:expected.resourceId,operation:expected.operation,status:job.status});phase2Jobs.delete(expected.id);return job;
}
async function phase2Job(c,accepted,intent,timeout=120000){
 const id=accepted?.id;
 if(typeof id!=='string'||!/^([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.test(id)||!intent||!Object.isFrozen(intent)||!Object.isFrozen(intent.result)||!['php.fpm.update','wp.toolkit'].includes(intent.result.actionId)||!Number.isFinite(Date.parse(accepted.createdAt)))throw new Error('The accepted phase2 job identity or initial intent is unavailable; keep owned resources');
 const expected=Object.freeze({...intent,id,createdAt:accepted.createdAt,status:'succeeded'});
 phase2Jobs.set(id,expected);try{phase2JobBinding(accepted,expected);}catch(error){phase2Uncertain=true;throw error;}phase2Uncertain=false;
 let job;try{job=await waitJob(c.api,id,timeout);}catch{phase2Uncertain=true;record('phase2.job-read-unverified',{jobId:id,noPostRetry:true});throw new Error('The known phase2 job could not be read; protected transport details withheld');}
 try{return phase2JobTerminal(job,expected);}catch(error){phase2Uncertain=true;throw error;}
}
function secrets(){return JSON.parse(fs.readFileSync(secretsFile,'utf8'));}
function saveSecrets(value){fs.writeFileSync(secretsFile,JSON.stringify(value),{mode:0o600});}
async function ownRepository(c){
 const all=check(await apiCall(c.api,c.csrf,'GET','/api/panel/backups/repositories'),'backup.repository.inventory');
 let repo=all.find(v=>v.name==='website-'+state.fixture.websiteId);
 if(!repo){const password=randomBytes(32).toString('base64url');const sec=secrets();sec.repositoryPassword=password;saveSecrets(sec);repo=check(await apiCall(c.api,c.csrf,'POST','/api/panel/backups/repositories',{name:'website-'+state.fixture.websiteId,backend:'local',password,initialize:true}),'backup.repository.create',[200,201]);}
 expect(state.baselineRepositoryIds).not.toContain(repo.id);expect(repo.target).toBe('/var/lib/yunpanel/backups/restic/repos/'+repo.id);expect(repo.status).toBe('ready');state.fixture.repository={id:repo.id,target:repo.target};saveManifest(state);return repo;
}
test.beforeAll(async({},info)=>{
 test.setTimeout(300000);
 owner=await apiContext();
 primaryKey='t886-13-'+info.project.name;staticKey='t886-13-static-'+info.project.name;
 primary=await createOwnedFixture(owner,{key:primaryKey,runtime:'php'});
 stateFile=path.join(RUN_DIR,'t886-13-'+info.project.name+'-ledger.json');secretsFile=path.join(RUN_DIR,'t886-13-'+info.project.name+'-secrets.json');
 const repos=await apiCall(owner.api,owner.csrf,'GET','/api/panel/backups/repositories');expect(repos.status).toBe(200);
 state={sourceSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),helperSha256:createHash('sha256').update(fs.readFileSync(new URL('./owned-fixture.js',import.meta.url))).digest('hex'),runId:primary.ledger.runId,serverId:primary.ledger.serverId,baselineRepositoryIds:repos.data.map(v=>v.id),fixture:{...primary.ledger,provisioningReady:true,createdWebsiteIds:[primary.ledger.websiteId],createdDomainIds:[primary.ledger.domainId],databaseName:'t886_'+primary.ledger.nonce,operations:[]}};
 saveManifest(state);saveSecrets({siteAdminEmail:'t886@example.invalid',wpAdminPassword:randomBytes(30).toString('base64url')+'!aA7'});
 await primary.upload('sibling-proof.txt','T886-SIBLING-'+state.runId);
});
test.afterAll(async()=>{
 test.setTimeout(360000);
 const failures=[];
 try{for(const [id,expected] of [...phase2Jobs]){const job=await waitJob(owner.api,id,120000);phase2JobTerminal(job,expected);}}catch{phase2Uncertain=true;}
 if(phase2Uncertain){record('phase2.cleanup-hold',{state:'UNKNOWN_KEEP',noNewCleanupMutation:true});await owner?.api.dispose();throw new Error('Phase2 mutation outcome is uncertain; exact owned resources retained without replay');}
 if(owner&&orphanKey){try{if(orphanRecovery)await orphanRecovery(owner,'removed');const ledger=orphanFixture?await orphanFixture.cleanup():await cleanupOwnedFixture(owner,{key:orphanKey});if(orphanFixture)verifyOwnedAbsence(orphanFixture);else{const physical=readOnlyHostProbe({ledger},'lifecycle-absence');expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);expect(physical.roots.length).toBeGreaterThanOrEqual(4);expect(physical.roots.every(value=>!value.exists)).toBe(true);expect(physical.fpmFiles).toEqual([]);expect(physical.sockets).toEqual([]);expect(physical.mounts).toEqual([]);expect(physical.nginxFiles.every(value=>!value.exists)).toBe(true);}}catch(error){failures.push('orphan normal cleanup failed; exact journal retained');}if(phase2Uncertain){record('phase2.cleanup-hold',{state:'UNKNOWN_KEEP',noNewCleanupMutation:true});await owner.api.dispose();throw new Error('Orphan mutation outcome is uncertain; no cleanup replay');}}
 if(owner&&state?.fixture.mailboxIds)for(const id of state.fixture.mailboxIds){try{await removeMailbox(owner,id);}catch(e){failures.push('mailbox '+id+': '+String(e.message).split('\n')[0]);}}
 if(owner&&state?.fixture.websiteId){try{await recordOwnedSnapshotInventory();}catch(e){const current=manifest();current.fixture.repositorySnapshotInventory={status:'unknown_keep',snapshots:[]};saveManifest(current);failures.push('snapshot inventory: '+String(e.message).split('\n')[0]);}}
 if(uploadedStatic){try{await uploadedStatic.cleanup();verifyOwnedAbsence(uploadedStatic);}catch(e){failures.push('static cleanup: '+String(e.message).split('\n')[0]);}}
 if(owner&&staticKey&&!uploadedStatic&&fs.existsSync(path.join(RUN_DIR,'owned-fixtures',staticKey+'.json'))){try{await cleanupOwnedFixture(owner,{key:staticKey});}catch(e){failures.push('static ledger cleanup: '+String(e.message).split('\n')[0]);}}
 if(primary){try{await cleanupPrimary();verifyOwnedAbsence(primary);}catch(e){failures.push('primary cleanup: '+String(e.message).split('\n')[0]);}}
 else if(owner&&primaryKey&&fs.existsSync(path.join(RUN_DIR,'owned-fixtures',primaryKey+'.json'))){try{await cleanupOwnedFixture(owner,{key:primaryKey});}catch(e){failures.push('primary ledger cleanup: '+String(e.message).split('\n')[0]);}}
 await owner?.api.dispose();
 expect(failures,'All owned resources must be cleaned through their normal panel lifecycle').toEqual([]);
});
async function recordOwnedSnapshotInventory(){
 const m=owned(),id=m.fixture.websiteId;
 const jobs=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/jobs?resourceType=application&resourceId='+m.fixture.applicationId),'cleanup.snapshot-application-jobs');
 expect(jobs.some(job=>['queued','running'].includes(job.status)),'Snapshot inventory requires finished WordPress writers').toBe(false);
 const operations=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/websites/'+id+'/backup-operations'),'cleanup.snapshot-operations');
 expect(operations.some(op=>['queued','running'].includes(op.status)),'Snapshot inventory requires finished backup writers').toBe(false);
 const all=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/backups/repositories'),'cleanup.snapshot-repositories');
 const matches=all.filter(repo=>repo.name==='website-'+id);expect(matches.length).toBeLessThanOrEqual(1);
 const inventory=[];
 for(const repo of matches){
  expect(repo.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  expect(m.baselineRepositoryIds).not.toContain(repo.id);expect(repo.serverId).toBe(m.serverId);expect(repo.backend).toBe('local');expect(repo.target).toBe('/var/lib/yunpanel/backups/restic/repos/'+repo.id);
  const rows=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/backups/repositories/'+repo.id+'/snapshots'),'cleanup.snapshot-metadata');
  for(const snapshot of rows){expect(snapshot.id).toMatch(/^[a-f0-9]{64}$/i);expect(snapshot.tags).toContain('website:'+id);}
  inventory.push({repositoryId:repo.id,target:repo.target,snapshots:rows.map(snapshot=>({id:snapshot.id,tags:snapshot.tags}))});
 }
 m.fixture.repositorySnapshotInventory={status:'observed',repositories:inventory};saveManifest(m);
 record('cleanup.owned-snapshot-inventory',{repositories:inventory.length,snapshots:inventory.reduce((count,repo)=>count+repo.snapshots.length,0)});
}
function verifyOwnedAbsence(fixture){
 const physical=readOnlyHostProbe(fixture,'lifecycle-absence');
 expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);
 expect(physical.roots.length).toBeGreaterThanOrEqual(4);expect(physical.roots.every(root=>!root.exists)).toBe(true);
 expect(physical.mounts).toEqual([]);expect(physical.fpmFiles).toEqual([]);expect(physical.sockets).toEqual([]);
 expect(physical.nginxFiles.every(file=>!file.exists)).toBe(true);
 fixture.record('cleanup.physical-absence',{unixUserAbsent:true,unixGroupAbsent:true,rootsAbsent:true,mountsAbsent:true,fpmAbsent:true,socketsAbsent:true,nginxAbsent:true});
}
async function cleanupPrimary(){
 const identity=primary.ledger,mailDomainId=state?.fixture.mailDomainId;
 const root='/api/panel/domains/'+identity.domainId+'/removal-operations';
 let before=null;
 if(mailDomainId){
  const journals=check(await apiCall(owner.api,owner.csrf,'GET',root),'cleanup.domain-before');
  const jobs=await ownedMailCleanupJobs(identity,mailDomainId);
  expect(jobs.some(job=>['queued','running'].includes(job.status)),'Own mail setup/cleanup jobs must finish before Website removal').toBe(false);
  before={domainOperationIds:journals.operations.map(op=>op.id),mailJobIds:jobs.map(job=>job.id)};
  const current=manifest();current.fixture.cleanupBaseline=before;saveManifest(current);
 }
 try{await primary.cleanup();return;}catch(error){
  if(!String(error.message).startsWith('Owned removal stopped: domain_removal child_domain_removal_blocked'))throw error;
 }
 expect(before,'A child continuation requires the baseline recorded before this owned removal started').toBeTruthy();
 const websiteOperationId=primary.ledger.removalId;
 expect(websiteOperationId).toMatch(/^ws-rem-[a-f0-9-]{36}$/i);
 const website=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/website-removal-operations/'+websiteOperationId),'cleanup.website-boundary');
 expect(website.id).toBe(websiteOperationId);expect(website.websiteId).toBe(identity.websiteId);expect(website.serverId).toBe(identity.serverId);expect(website.applicationId).toBe(identity.applicationId);
 expect(website.steps.some(step=>step.kind==='domain_removal'&&step.resourceId===identity.domainId&&step.error?.code==='child_domain_removal_blocked')).toBe(true);
 const listed=check(await apiCall(owner.api,owner.csrf,'GET',root),'cleanup.domain-journals');
 const candidates=listed.operations.filter(op=>!before.domainOperationIds.includes(op.id));
 expect(candidates,'Exactly one new Domain journal must be observed during this owned Website lifecycle').toHaveLength(1);
 const child=candidates[0],childId=child.id;
 expect(child.domainId).toBe(identity.domainId);expect(child.serverId).toBe(identity.serverId);expect(child.primaryDomain).toBe(identity.hostname);
 expect(Date.parse(child.createdAt)).toBeGreaterThanOrEqual(Date.parse(website.createdAt));
 expect(child.plan.websiteId).toBe(identity.websiteId);expect(child.plan.applicationId).toBe(identity.applicationId);expect(child.plan.mailDomainIds).toEqual([mailDomainId]);
 const intent=child.plan.mailDomainIntents;expect(intent).toHaveLength(1);expect(intent[0]).toMatchObject({id:mailDomainId,webDomainId:identity.domainId,domainName:identity.hostname,managementMode:'local'});
 const current=manifest();current.fixture.cleanupDomainOperationId=childId;saveManifest(current);
 let removed=false;const deadline=Date.now()+180000;let continuations=0;
 while(Date.now()<deadline&&continuations<12){
  // Actual public job IDs belong to this exact new removal interval and owned mail domain.
  // No parent continuation is sent while its disable/backup/delete worker is pending.
  const jobs=await ownedMailCleanupJobs(identity,mailDomainId);
  for(const job of jobs.filter(job=>!before.mailJobIds.includes(job.id))){
   expect(Date.parse(job.createdAt)).toBeGreaterThanOrEqual(Date.parse(website.createdAt));
   const types={'mail.config.apply':'mail.config.apply','mail.data.backup':'mail_data_backup','mail.data.delete':'mail_data_delete'};
   expect(Object.keys(types)).toContain(job.operation);expect(job.type).toBe(types[job.operation]);
   const terminal=['queued','running'].includes(job.status)?await waitJob(owner.api,job.id,Math.min(120000,Math.max(1,deadline-Date.now()))):job;
   expect(terminal.id).toBe(job.id);expect(terminal.serverId).toBe(identity.serverId);expect(terminal.resourceType).toBe('mail_domain');expect(terminal.resourceId).toBe(mailDomainId);expect(terminal.operation).toBe(job.operation);
   record('cleanup.owned-mail-job',{jobId:terminal.id,operation:terminal.operation,status:terminal.status,code:terminal.error?.code??null});expect(terminal.status).toBe('succeeded');
  }
  const operation=check(await apiCall(owner.api,owner.csrf,'GET',root+'/'+childId),'cleanup.domain-journal').operation;
  expect(operation.id).toBe(childId);expect(operation.domainId).toBe(identity.domainId);expect(operation.serverId).toBe(identity.serverId);
  if(operation.status==='removed'){removed=true;break;}
  const step=operation.steps.find(item=>item.status!=='succeeded');
  expect(step,'An unfinished owned Domain child must expose its next step').toBeTruthy();
  expect(operation.checksum).toMatch(/^[a-f0-9]{64}$/);expect(operation.actions.stepContinuationConfirmation).toBeTruthy();
  const advanced=check(await apiCall(owner.api,owner.csrf,'POST',root+'/'+childId+'/continue',{
   expectedUpdatedAt:operation.updatedAt,stepId:step.id,checksum:operation.checksum,confirmation:operation.actions.stepContinuationConfirmation,
  }),'cleanup.domain-continue').operation;
  expect(advanced.id).toBe(childId);expect(advanced.domainId).toBe(identity.domainId);expect(advanced.updatedAt).not.toBe(operation.updatedAt);
  record('cleanup.domain-phase',{operationId:childId,stepId:step.id,status:advanced.status,continuation:++continuations});
  if(advanced.status==='removed'){removed=true;break;}
 }
 expect(removed,'The same observed owned Domain child must finish through its normal public lifecycle').toBe(true);
 const removedChild=check(await apiCall(owner.api,owner.csrf,'GET',root+'/'+childId),'cleanup.domain-removed').operation;
 expect(removedChild.id).toBe(childId);expect(removedChild.domainId).toBe(identity.domainId);expect(removedChild.status).toBe('removed');
 const operation=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/website-removal-operations/'+websiteOperationId),'cleanup.website-journal');
 expect(operation.websiteId).toBe(identity.websiteId);
 if(operation.status!=='removed'){
  expect(operation.status).toBe('blocked');expect(operation.error?.code).toBe('child_domain_removal_blocked');expect(operation.actions.runConfirmation).toBeTruthy();
  const resumed=check(await apiCall(owner.api,owner.csrf,'POST','/api/panel/website-removal-operations/'+websiteOperationId+'/run',{
   expectedUpdatedAt:operation.updatedAt,confirmation:operation.actions.runConfirmation,
  }),'cleanup.website-resume',202);expect(resumed.id).toBe(websiteOperationId);
 }
 await primary.cleanup();
}
async function ownedMailCleanupJobs(identity,mailDomainId){
 const rows=check(await apiCall(owner.api,owner.csrf,'GET','/api/panel/jobs?resourceType=mail_domain&resourceId='+mailDomainId),'cleanup.mail-jobs');
 expect(Array.isArray(rows)).toBe(true);
 for(const job of rows){expect(job.serverId).toBe(identity.serverId);expect(job.resourceType).toBe('mail_domain');expect(job.resourceId).toBe(mailDomainId);}
 return rows;
}
async function removeMailbox(c,id){
 const base='/api/panel/mailboxes/'+id;let r=await apiCall(c.api,c.csrf,'GET',base);if(r.status===404)return;const box=check(r,'cleanup.mailbox.read');expect(box.mailDomainId).toBe(state.fixture.mailDomainId);
 if(box.enabled){check(await apiCall(c.api,c.csrf,'PATCH',base,{expectedRevision:box.revision,enabled:false}),'cleanup.mailbox.disable');await applyMail(c,state.fixture.mailDomainId,'enabled');}
 const controller=createMailboxRemoval({target:{id,address:box.address,mailDomainId:box.mailDomainId},canManage:()=>true,request:async(route,options={})=>{const result=await apiCall(c.api,c.csrf,options.method??'GET','/api/panel'+route,options.body);if(result.status>=400)throw new Error('Mail cleanup HTTP '+result.status+' '+result.body.error?.code);return result.data;}});
 try{await controller.refresh();for(const action of ['backup','delete','finalize']){await controller.prepare(action);let view=controller.getState();expect(view.approval,'Mailbox cleanup '+action+': '+view.error).toBeTruthy();await controller.confirm(view.approval,view.approval.data.confirmation);view=controller.getState();if(view.job&&['queued','running'].includes(view.job.status)){const j=await waitJob(c.api,view.job.id);expect(j.status,'Mailbox cleanup '+action).toBe('succeeded');await controller.refresh();}expect(controller.getState().error).toBeNull();}expect(controller.getState().status).toBe('deleted');}finally{controller.dispose();}
}
async function applyMail(c,id,status='enabled'){
 const domain=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mail-domains/'+id),'mail.apply.domain');const input={expectedRevision:domain.revision,status};
 const preview=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-preview',input),'mail.apply.preview');
 const q=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+id+'/config-apply',{...input,previewDigest:preview.previewDigest,configurationSha256:preview.configuration.sha256,confirmation:preview.confirmation}),'mail.apply.queue',202);
 expect((await waitJob(c.api,q.id)).status).toBe('succeeded');
}
async function finishedBackup(c,root,operation){
 const job=await waitJob(c.api,operation.jobId);record('backup.native.job',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const actual=check(await apiCall(c.api,c.csrf,'GET',root+'/backup-operations/'+operation.id),'backup.native.operation');
 expect(actual.status).toBe('succeeded');return actual;
}
async function recordOwnedBackupResources(c,m){
 const set=check(await apiCall(c.api,c.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/backup-set'),'backup.owned-resource-set');
 expect(set.website.id).toBe(m.fixture.websiteId);expect(set.stagedRoot).toBe('/var/lib/yunpanel/backups/resources/website/'+m.fixture.websiteId);
 m.fixture.backupResources={websiteId:m.fixture.websiteId,stagedRoot:set.stagedRoot,observedFromActualBackupSet:true};saveManifest(m);
 record('backup.owned-staging',{websiteId:m.fixture.websiteId,stagedRoot:set.stagedRoot});
}
async function ensureWordPressRemovalSnapshot(c,m){
 if(m.fixture.nativeBackup?.snapshotId)return m.fixture.nativeBackup;
 // An independently selected WordPress case prepares its own normal backup.
 // It does not stand in for the separate combined mail/environment restore gate.
 await recordOwnedBackupResources(c,m);const repository=await ownRepository(c),root='/api/panel/websites/'+m.fixture.websiteId;
 const preview=check(await apiCall(c.api,c.csrf,'POST',root+'/backup/preview',{repositoryId:repository.id}),'wordpress.remove.backup-preview');
 const queued=check(await apiCall(c.api,c.csrf,'POST',root+'/backup-operations',{
  kind:'backup',repositoryId:repository.id,expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['t886-wp-remove-'+m.runId],
 }),'wordpress.remove.backup-queue',202);
 const actual=await finishedBackup(c,root,queued);expect(actual.result?.snapshot?.snapshotId).toBeTruthy();
 m.fixture.nativeBackup={repositoryId:repository.id,snapshotId:actual.result.snapshot.snapshotId,operationId:queued.id,purpose:'wordpress-removal-only'};saveManifest(m);
 record('wordpress.remove.standalone-snapshot',{operationId:queued.id,snapshotId:m.fixture.nativeBackup.snapshotId});return m.fixture.nativeBackup;
}
async function nativeMailboxPassword(c,m,password){
 const box=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]),'backup.mailbox');
 check(await apiCall(c.api,c.csrf,'POST','/api/panel/mailboxes/'+box.id+'/password',{expectedRevision:box.revision,password}),'backup.mailbox.change');
 const mailDomain=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mail-domains/'+m.fixture.mailDomainId),'backup.mail-domain');
 const input={expectedRevision:mailDomain.revision,status:'enabled'};
 const preview=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+mailDomain.id+'/config-preview',input),'backup.mail.apply.preview');
 const job=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains/'+mailDomain.id+'/config-apply',{
   ...input,previewDigest:preview.previewDigest,configurationSha256:preview.configuration.sha256,confirmation:preview.confirmation,requestId:randomUUID()}),'backup.mail.apply.queue',202);
 expect((await waitJob(c.api,job.id)).status).toBe('succeeded');
}

test('@mutation source three-step form creates an uploaded static site without Git and serves the actual uploaded HTML',async({page,liveApi},info)=>{
 test.setTimeout(300000);const m=owned();
 uploadedStatic=await createOwnedFixture(owner,{key:staticKey,runtime:'static',create:async(input,_preview,recordInput)=>{
  let uiOperationId=null;const route='**/api/panel/sites';const observe=async routed=>{if(routed.request().method()==='POST'){const actual=routed.request().postDataJSON().input;recordInput(actual);uiOperationId=actual.operationId;}await routed.continue();};await page.route(route,observe);
  const rejected=async response=>{const match=new URL(response.url()).pathname.match(/^\/api\/panel\/sites\/provisioning\/([a-f0-9-]{36})\/continue$/i);if(response.request().method()!=='POST'||response.status()<400||match?.[1]!==uiOperationId)return;const body=await response.json().catch(()=>({})),code=body.error?.code;record('static.ui-provisioning-rejected',{operationId:uiOperationId,status:response.status(),code:typeof code==='string'&&/^[a-z0-9_]{1,120}$/.test(code)?code:null});};page.on('response',rejected);
  try{await ready(page,'/websites/new');await page.getByLabel('Alan adı',{exact:true}).fill(input.primaryDomain);await page.locator('label').filter({hasText:'www davranışı'}).locator('select').selectOption('none');await main(page).getByRole('button',{name:'Devam et',exact:true}).click();
   await page.getByLabel('Site türü',{exact:true}).selectOption('new_static_upload');await expect(page.getByRole('textbox',{name:'GitHub repository',exact:true})).toHaveCount(0);await main(page).getByRole('button',{name:'Devam et',exact:true}).click();await page.getByLabel('DNS yönetimi',{exact:true}).selectOption('external');await page.getByLabel('Sertifika yönetimi',{exact:true}).selectOption('off');await page.getByRole('checkbox',{name:/Otomatik E-Posta|E-posta ve Webmail/}).uncheck();
   const createdEvent=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/panel/sites'&&r.request().method()==='POST',{timeout:180000});await main(page).getByRole('button',{name:'Siteyi oluştur',exact:true}).click();const response=await createdEvent;expect([200,201]).toContain(response.status());const created=(await response.json()).data;await expect(main(page).getByLabel('Site kurulum durumu')).toContainText('Kurulum planındaki zorunlu adımlar tamamlandı',{timeout:180000});return created;
  }finally{page.off('response',rejected);await page.unroute(route,observe);}
 }});
 const target=uploadedStatic.ledger;m.fixture.extraStatic={...target};m.fixture.createdWebsiteIds.push(target.websiteId);m.fixture.createdDomainIds.push(target.domainId);saveManifest(m);
 const application=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/applications/'+target.applicationId),'static.upload.application');expect(application.state).toBe('active');expect(application.repositoryUrl).toBe(null);expect(application.currentCommitSha).toBe(null);
 const marker='<!doctype html><html lang="tr"><head><title>Uploaded site</title></head><body><h1>STATIC-NATIVE-'+m.runId+'</h1></body></html>';await uploadedStatic.upload('index.html',marker);const actual=await uploadedStatic.http('/');expect(actual.status).toBe(200);expect(actual.body).toBe(marker);
 await ready(page,uploadedStatic.route('files'));await expect(main(page)).toContainText('index.html');await expect(page.getByRole('navigation',{name:'Site araçları'}).getByRole('link',{name:/Git/})).toHaveCount(0);record('static.upload.actual-html',{verified:true,websiteId:target.websiteId,noGitRequired:true});
});

test('@mutation @managed-repair source managed phpMyAdmin repair stages actual templates and verifies the native gateway', async ({ liveApi }) => {
 test.setTimeout(180000);expect(process.env.YUNPANEL_AUDIT_MANAGED_REPAIR,'Managed repair requires the separately approved exclusive server window').toBe('1');const m = owned();
 const queued = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/services/phpmyadmin/install', { confirmation: 'install:phpmyadmin' }), 'phpmyadmin.repair.queue', 202);
 const job = await waitJob(liveApi.api, queued.id, 150000);
 record('phpmyadmin.repair.native', { status: job.status, code: job.error?.code, transactionId: job.result?.configurationResult?.transactionId });
 expect(job.status).toBe('succeeded');
 expect(job.result?.configurationResult?.applied).toBe(true);
 expect(job.result.configurationResult.httpHealthy).toBe(true);
 expect(job.result.configurationResult.fpmSocketHealthy).toBe(true);
 expect(job.result.configurationResult.gatewaySocketHealthy).toBe(true);
 expect(job.result.configurationResult.transactionId,'A real managed repair must expose its transaction receipt identity').toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
 const current = manifest(); current.fixture.phpMyAdminConfigurationTransaction = job.result.configurationResult.transactionId; saveManifest(current);
});

async function upload(c,m,name,source){return check(await apiCall(c.api,c.csrf,'PUT','/api/panel/websites/'+m.fixture.websiteId+'/files/upload?path='+name,Buffer.from(source)),'native.file.upload',[200,201]);}

async function remove(c,m,name){check(await apiCall(c.api,c.csrf,'DELETE','/api/panel/websites/'+m.fixture.websiteId+'/files',{path:name,confirmation:'delete:'+m.fixture.websiteId+':'+name}),'native.file.remove');}

test('@mutation source resumes one detached owned Domain from its unfinished journal in a new Owner context',async()=>{
 test.setTimeout(300000);const m=owned(),marker='T883-ORPHAN-'+m.runId;
 orphanKey='t883-orphan-'+randomUUID().slice(0,8);try{orphanFixture=await createOwnedFixture(owner,{key:orphanKey,runtime:'static'});}catch(error){if(['owned_fixture_creation_unconfirmed','owned_fixture_transport'].includes(error?.code))phase2Uncertain=true;throw error;}const f=orphanFixture,t=f.ledger;
 expect(t.websiteId).not.toBe(m.fixture.websiteId);expect(t.applicationId).not.toBe(m.fixture.applicationId);expect(t.domainId).not.toBe(m.fixture.domainId);
 state.fixture.createdWebsiteIds.push(t.websiteId);state.fixture.createdDomainIds.push(t.domainId);saveManifest(state);
 await phase2OwnedEffect('orphan.index-upload',()=>f.upload('index.html',marker));const first=await f.http('/');expect(first.status).toBe(200);expect(first.body).toBe(marker);
 const contentSha256=createHash('sha256').update((await f.readText('index.html')).content).digest('hex');expect(contentSha256).toBe(createHash('sha256').update(marker).digest('hex'));
 const ownUid=readOnlyHostProbe(f,'owned-site-files').uid;expect(ownUid).toBeGreaterThan(0);
 const initialNginx=readOnlyHostProbe(f,'nginx-config');expect(initialNginx.exists&&initialNginx.regular&&!initialNginx.symlink).toBe(true);expect(initialNginx.sha256).toMatch(/^[a-f0-9]{64}$/);
 const initialWebsite=check(await phase2Read(owner.api,owner.csrf,'GET',f.endpoint()),'orphan.website-before');expect(initialWebsite.id).toBe(t.websiteId);expect(initialWebsite.applicationId).toBe(t.applicationId);expect(initialWebsite.unixUser).toBe(t.unixUser);
 const siblingUid=readOnlyHostProbe(primary,'owned-site-files').uid,siblingConfig=check(await phase2Read(owner.api,owner.csrf,'GET',primary.endpoint('/php-tools/config')),'orphan.sibling-config');expect(siblingUid).toBeGreaterThan(0);
 const siblingName='orphan-sibling-'+t.nonce+'.php',siblingProof='ORPHAN-SIBLING-'+t.runId;
 await phase2OwnedEffect('orphan.sibling-upload',()=>primary.upload(siblingName,'<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(["proof"=>'+JSON.stringify(siblingProof)+',"version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);'));
 const sibling=async phase=>{const r=await primary.http('/'+siblingName);record('orphan.sibling-first-response',{phase,status:r.status});expect(r.status).toBe(200);expect(r.headers['cache-control']).toContain('no-store');expect(JSON.parse(r.body)).toEqual({proof:siblingProof,version:siblingConfig.phpVersion,uid:siblingUid,sapi:'fpm-fcgi'});};
 await sibling('before-detachment');let initiator,resumer;
 const domainRoot='/api/panel/domains/'+t.domainId;
 try{
  initiator=await phase2OwnerContext();const session=check(await phase2Read(initiator.api,initiator.csrf,'GET','/api/auth/session'),'orphan.initiator-session');expect(session.user.role).toBe('owner');
  const preview=check(await phase2Read(initiator.api,initiator.csrf,'GET',domainRoot+'/removal'),'orphan.preview').preview;expect(preview.readyToStart).toBe(true);
  const created=(await phase2Post(initiator,domainRoot+'/removal',{previewDigest:preview.previewDigest,confirmation:preview.confirmation},'orphan.start',201,result=>{const op=result.operation;expect(Boolean(op&&op.domainId===t.domainId&&op.serverId===t.serverId&&op.plan?.websiteId===t.websiteId&&op.plan?.applicationId===t.applicationId)).toBe(true);})).operation;
  expect(created.domainId).toBe(t.domainId);expect(created.serverId).toBe(t.serverId);expect(created.plan.websiteId).toBe(t.websiteId);expect(created.plan.applicationId).toBe(t.applicationId);expect(created.checksum).toMatch(/^[a-f0-9]{64}$/);expect(created.checksum).toBe(initialNginx.sha256);
  expect(created.id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);const ownedDnsZoneIds=[...created.plan.dnsZoneIds];expect(new Set(ownedDnsZoneIds).size).toBe(ownedDnsZoneIds.length);
  const expected={id:created.id,checksum:created.checksum,domainRevision:created.domainRevision,createdAt:created.createdAt};
  const scope=op=>{expect(op.id).toBe(expected.id);expect(op.domainId).toBe(t.domainId);expect(op.serverId).toBe(t.serverId);expect(op.primaryDomain).toBe(t.hostname);expect(op.plan.websiteId).toBe(t.websiteId);expect(op.plan.applicationId).toBe(t.applicationId);expect(op.checksum).toBe(expected.checksum);expect(op.domainRevision).toBe(expected.domainRevision);expect(op.createdAt).toBe(expected.createdAt);};
  orphanRecovery=async(c,goal)=>{
   const deadline=Date.now()+180000;
   for(let n=0;n<40&&Date.now()<deadline;n++){
    const op=check(await phase2Read(c.api,c.csrf,'GET',domainRoot+'/removal-operations/'+expected.id),'orphan.same-journal').operation;scope(op);
    if(goal==='detached'&&op.steps.find(step=>step.kind==='website_binding')?.status==='succeeded'){expect(op.status).not.toBe('removed');expect(op.steps.find(step=>step.kind==='metadata_finalization')?.status).not.toBe('succeeded');return op;}
    if(op.status==='removed'){expect(goal).toBe('removed');return op;}
    expect(['failed','blocked']).not.toContain(op.status);const step=op.steps.find(value=>value.status!=='succeeded');expect(step).toBeTruthy();expect(step.kind).not.toBe('routing_suspend');expect(op.actions.stepContinuationConfirmation).toBeTruthy();
    const action=op.id+':'+step.id+':'+op.updatedAt;expect(orphanAdvancedActions.has(action),'A known typed continuation is never replayed, including cleanup').toBe(false);orphanAdvancedActions.add(action);record('orphan.typed-intent',{operationId:op.id,stepId:step.id,expectedUpdatedAt:op.updatedAt});
    const advanced=(await phase2Post(c,domainRoot+'/removal-operations/'+expected.id+'/continue',{expectedUpdatedAt:op.updatedAt,stepId:step.id,checksum:op.checksum,confirmation:op.actions.stepContinuationConfirmation},'orphan.continue',200,result=>{scope(result.operation);expect(result.operation.updatedAt).not.toBe(op.updatedAt);})).operation;scope(advanced);
    record('orphan.typed-phase',{operationId:expected.id,stepId:step.id,status:advanced.status,updatedAt:advanced.updatedAt});
   }
   throw new Error('The exact owned Domain journal did not reach the required phase');
  };
  const detached=await orphanRecovery(initiator,'detached');const actualDomain=check(await phase2Read(initiator.api,initiator.csrf,'GET',domainRoot),'orphan.detached-domain');expect(actualDomain.id).toBe(t.domainId);expect(actualDomain.serverId).toBe(t.serverId);expect(actualDomain.websiteId).toBeNull();
  const intent={websiteId:t.websiteId,applicationId:t.applicationId,domainId:t.domainId,serverId:t.serverId,operationId:expected.id,checksum:expected.checksum,updatedAt:detached.updatedAt,unixUid:ownUid,contentSha256,originalNginxSha256:initialNginx.sha256,unfinished:true,detachmentAcknowledged:true,metadataFinalizationPending:true,backendProcessCrash:false};f.record('orphan.detached-checkpoint',intent);record('orphan.detached-checkpoint',intent);
  await sibling('after-detachment');await initiator.api.dispose();initiator=null;
  resumer=await phase2OwnerContext();const resumedSession=check(await phase2Read(resumer.api,resumer.csrf,'GET','/api/auth/session'),'orphan.resumer-session');expect(resumedSession.user.role).toBe('owner');
  const beforeResume=check(await phase2Read(resumer.api,resumer.csrf,'GET',domainRoot+'/removal-operations/'+expected.id),'orphan.resumer-checkpoint').operation;scope(beforeResume);expect(beforeResume.updatedAt).toBe(intent.updatedAt);expect(beforeResume.status).not.toBe('removed');expect(beforeResume.steps.find(step=>step.kind==='website_binding').status).toBe('succeeded');
  const done=await orphanRecovery(resumer,'removed');expect(done.status).toBe('removed');
  expect((await phase2Read(resumer.api,resumer.csrf,'GET',domainRoot)).status).toBe(404);expect(done.steps.find(step=>step.kind==='metadata_finalization').status).toBe('succeeded');
  for(const id of ownedDnsZoneIds)expect((await phase2Read(resumer.api,resumer.csrf,'GET','/api/panel/dns-zones/'+id)).status).toBe(404);const survivingZones=check(await phase2Read(resumer.api,resumer.csrf,'GET','/api/panel/dns-zones'),'orphan.dns-zone-absence');expect(survivingZones.filter(zone=>zone.webDomainId===t.domainId)).toEqual([]);
  const website=check(await phase2Read(resumer.api,resumer.csrf,'GET',f.endpoint()),'orphan.website-after');expect(website.id).toBe(t.websiteId);expect(website.applicationId).toBe(t.applicationId);expect(website.unixUser).toBe(initialWebsite.unixUser);
  const application=check(await phase2Read(resumer.api,resumer.csrf,'GET','/api/panel/applications/'+t.applicationId),'orphan.application-after');expect(application.id).toBe(t.applicationId);expect(application.serverId).toBe(t.serverId);
  expect(readOnlyHostProbe(f,'owned-site-files').uid).toBe(ownUid);expect(createHash('sha256').update((await f.readText('index.html')).content).digest('hex')).toBe(contentSha256);expect(readOnlyHostProbe(f,'nginx-config').exists).toBe(false);
  const routing=await resumer.api.get('http://'+t.hostname+'/',{maxRedirects:0,maxRetries:0,headers:{Connection:'close'}});const ownMarkerServed=(await routing.text()).includes(marker);record('orphan.routing-after-removal',{status:routing.status(),ownMarkerServed});expect(ownMarkerServed).toBe(false);
  await sibling('after-recovery');await phase2OwnedEffect('orphan.normal-website-cleanup',()=>f.cleanup());verifyOwnedAbsence(f);await sibling('after-normal-cleanup');await phase2OwnedEffect('orphan.sibling-delete',()=>primary.deleteFile(siblingName));
  record('orphan.current-owned-workflow-recovery',{verified:true,...intent,newOwnerContext:true,sameJournal:true,normalCleanup:true,historicalWebsite404OrphanCauseProved:false,ownedDnsZoneCount:ownedDnsZoneIds.length});
 }finally{await initiator?.api.dispose();await resumer?.api.dispose();}
});

test('@mutation source one database form creates real schema, binding, grants and an application query',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();await ready(page,'/databases');await main(page).getByRole('button',{name:'Veritabanı oluştur',exact:true}).first().click();
 const d=page.getByRole('dialog');await expect(d).toBeVisible();await d.locator('select').filter({has:page.locator('option[value="'+m.fixture.websiteId+'"]')}).selectOption(m.fixture.websiteId);await d.getByLabel('Veritabanı adı',{exact:true}).fill(m.fixture.databaseName);
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases'&&r.request().method()==='POST');
 await d.getByRole('button',{name:'Oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(202);const created=(await r.json()).data;
 expect(created.binding.websiteId).toBe(m.fixture.websiteId);expect(created.binding.applicationId).toBe(m.fixture.applicationId);expect(created.binding.unixUser).toBe(m.fixture.unixUser);expect(created.credential.websiteId).toBe(m.fixture.websiteId);expect(created.credential.applicationId).toBe(m.fixture.applicationId);expect(created.credential.siteUnixUser).toBe(m.fixture.unixUser);m.fixture.binding=created.binding;m.fixture.credential=created.credential;m.fixture.createdDatabaseNames=[m.fixture.databaseName];saveManifest(m);
 const j=await waitJob(liveApi.api,created.job.id);expect(j.status).toBe('succeeded');await expect(d).toContainText('hazır. Site bağlantısı ve kullanıcı izinleri uygulandı.',{timeout:30000});await d.getByRole('button',{name:'Tamam',exact:true}).click();await expect(d).toBeHidden();
 const connection=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+created.binding.id+'/connection',{revealPassword:true}),'database.connection');expect(Boolean(connection.password&&connection.username&&connection.databaseName)).toBe(true);
 const proof='DB-NATIVE-'+m.runId,name='db-proof.php';const source='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(v=>JSON.stringify(v)).join(',')+');$db->query("CREATE TABLE yp_native_proof (id INT PRIMARY KEY, value VARCHAR(128))");$s=$db->prepare("INSERT INTO yp_native_proof VALUES (1, ?)");$v='+JSON.stringify(proof)+';$s->bind_param("s",$v);$s->execute();$r=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();$global=false;$grants=$db->query("SHOW GRANTS");while($grant=$grants->fetch_row()){if(str_contains($grant[0]," ON *.* ")&&!str_starts_with($grant[0],"GRANT USAGE ON *.* "))$global=true;}echo json_encode(["proof"=>$r["value"],"globalPrivileges"=>$global]);';
 try{await upload(liveApi,m,name,source);const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/'+name);expect(actual.status()).toBe(200);const actualData=await actual.json();expect(actualData.proof).toBe(proof);expect(actualData.globalPrivileges).toBe(false);record('database.real-application-query',{verified:true,jobId:j.id});}finally{await remove(liveApi,m,name);}
});

test('@mutation source SQL import uploads a real SQL file through phpMyAdmin, verifies the database row and removes only its table', async ({ page, liveApi }) => {
 test.setTimeout(120000); const m = owned(), suffix = randomBytes(8).toString('hex');
 const table = 'yp_native_import_' + suffix, proof = 'IMPORT-NATIVE-' + m.runId + '-' + suffix;
 const file = path.join(RUN_DIR, 'owned-sql-import-' + suffix + '.sql');
 fs.writeFileSync(file, 'CREATE TABLE `' + table + '` (id INT PRIMARY KEY, value VARCHAR(128) NOT NULL);\nINSERT INTO `' + table + '` VALUES (1, ' + "'" + proof + "');\n", { mode: 0o600 });
 const connection = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/websites/' + m.fixture.websiteId + '/databases/' + m.fixture.binding.id + '/connection', { revealPassword: true }), 'sql.import.connection');
 const probe = 'native-sql-import-proof-' + suffix + '.php';
 const countSql = JSON.stringify("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='" + table + "'");
 const source = `<?php
 header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
 try {$db=new mysqli(${[connection.host, connection.username, connection.password, connection.databaseName].map(value => JSON.stringify(value)).join(',')});
 if($_SERVER["REQUEST_METHOD"]==="POST"){$db->query("DROP TABLE IF EXISTS ${table}");echo json_encode(["removed"=>$db->query(${countSql})->fetch_row()[0]==0]);}
 elseif($db->query(${countSql})->fetch_row()[0]==0){echo json_encode(["present"=>false]);}
 else{$row=$db->query("SELECT value FROM ${table} WHERE id=1")->fetch_assoc();echo json_encode(["present"=>true,"proof"=>$row["value"]]);}
 }catch(Throwable $error){http_response_code(500);echo json_encode(["verified"=>false]);}`;
 const current = manifest(); current.fixture.createdSqlImportTables ??= [];
 current.fixture.createdSqlImportTables.push({ databaseName: m.fixture.databaseName, table, probe, removed: false }); saveManifest(current);
 let uploaded = false, absentVerified = false;
 try {
  await upload(liveApi, m, probe, source); uploaded = true;
  const preflight = await liveApi.api.get('http://' + m.fixture.hostname + '/' + probe);
  expect(preflight.status()).toBe(200); expect((await preflight.json()).present).toBe(false); absentVerified = true;
  await ready(page, '/websites/' + m.fixture.domainId + '/databases');
  await main(page).getByRole('row').filter({ hasText: m.fixture.databaseName }).getByRole('button', { name: 'SQL içe aktar', exact: true }).click();
  const importPage=page;
  await expect(importPage).toHaveURL(/\/tools\/phpmyadmin\/index.php\?/);
  expect(new URL(importPage.url()).searchParams.get('db')).toBe(m.fixture.databaseName);
  expect(new URL(importPage.url()).searchParams.get('route')).toBe('/database/import');
  await importPage.locator('input[type="file"][name="import_file"]').setInputFiles(file);
  const submit = importPage.getByRole('button', { name: /^(Import|Go|İçe aktar|Git)$/ });
  await expect(submit).toHaveCount(1);
  const responseEvent = importPage.waitForResponse(response => new URL(response.url()).pathname === '/tools/phpmyadmin/index.php' && response.request().method() === 'POST');
  await submit.click(); const response = await responseEvent; expect(response.status()).toBe(200);
  const actual = await liveApi.api.get('http://' + m.fixture.hostname + '/' + probe);
  expect(actual.status()).toBe(200); expect((await actual.json()).proof).toBe(proof);
  record('database.actual-phpmyadmin-sql-import', { verified: true, table, uniqueRowVerified: true });
 } finally {
  if (absentVerified) {
   const removed = await liveApi.api.post('http://' + m.fixture.hostname + '/' + probe);
   expect(removed.status()).toBe(200); expect((await removed.json()).removed).toBe(true);
   const cleanup = manifest(); cleanup.fixture.createdSqlImportTables.find(item => item.table === table).removed = true; saveManifest(cleanup);
  }
  if (uploaded) await remove(liveApi, m, probe);
 }
});

test('@mutation source PHP settings switch to a different installed FPM version and restore the original runtime',async({liveApi})=>{
 test.setTimeout(120000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/php-tools/config';
 const before=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'php.config.read'),target=process.env.YUNPANEL_AUDIT_PHP_TARGET_VERSION;
 const prerequisite=typeof target==='string'&&/^\d+\.\d+$/.test(target)&&target!==before.phpVersion&&Array.isArray(before.availablePhpVersions)&&before.availablePhpVersions.includes(target);
 record('php.version-switch.prerequisite',{state:prerequisite?'READY':'HOLD',currentVersion:before.phpVersion,targetVersion:typeof target==='string'&&/^\d+\.\d+$/.test(target)?target:null,availableVersions:before.availablePhpVersions});
 expect(prerequisite,'HOLD: a different explicitly selected installed PHP runtime is required').toBe(true);
 const original={phpVersion:before.phpVersion,maxChildren:before.fpm.maxChildren,memoryLimitMb:before.fpm.memoryLimitMb,maxExecutionSeconds:before.fpm.maxExecutionSeconds};
 const uid=readOnlyHostProbe(primary,'owned-site-files').uid;expect(uid).toBeGreaterThan(0);
 const config={phpVersion:target,maxChildren:before.fpm.maxChildren===10?11:10,memoryLimitMb:256,maxExecutionSeconds:31};
 const name='php-runtime-proof.php';await phase2OwnedEffect('php.runtime-proof-upload',()=>upload(liveApi,m,name,'<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(["proof"=>'+JSON.stringify('PHP-SWITCH-'+m.runId)+',"version"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI,"memory"=>ini_get("memory_limit"),"seconds"=>ini_get("max_execution_time")]);'));
 const verify=async expected=>{const reply=await primary.http('/'+name);expect(reply.status,'The first actual FPM reply must succeed').toBe(200);expect(reply.headers['cache-control']).toContain('no-store');expect(JSON.parse(reply.body)).toEqual({proof:'PHP-SWITCH-'+m.runId,version:expected.phpVersion,uid,sapi:'fpm-fcgi',memory:expected.memoryLimitMb+'M',seconds:String(expected.maxExecutionSeconds)});};
 let applied=false,primaryError;
 try{
  await verify(original);const preview=await phase2Post(liveApi,root+'/preview',config,'php.config.preview');const intent=phase2JobIntent(preview,'php.fpm.update');
  const queued=await phase2Post(liveApi,root,{config,expectedRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation},'php.config.queue',202);
  const job=await phase2Job(liveApi,queued.job,intent);record('php.native.finished',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');applied=true;
  const after=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'php.config.persisted');expect(after.phpVersion).toBe(target);expect(after.fpm.maxChildren).toBe(config.maxChildren);expect(after.fpm.memoryLimitMb).toBe(256);expect(after.fpm.maxExecutionSeconds).toBe(31);
  await verify(config);record('php.actual-http-runtime',{verified:true,beforeVersion:original.phpVersion,afterVersion:target,versionChanged:true,uid,sapi:'fpm-fcgi'});
 }catch(error){primaryError=error;throw error;}
 finally{
  try{
   if(applied&&!phase2Uncertain){const preview=await phase2Post(liveApi,root+'/preview',original,'php.config.restore-preview');const intent=phase2JobIntent(preview,'php.fpm.update');const queued=await phase2Post(liveApi,root,{config:original,expectedRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation},'php.config.restore-queue',202);expect((await phase2Job(liveApi,queued.job,intent)).status).toBe('succeeded');const current=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'php.config.restore-read');expect(current.phpVersion).toBe(original.phpVersion);expect(current.fpm.maxChildren).toBe(original.maxChildren);expect(current.fpm.memoryLimitMb).toBe(original.memoryLimitMb);expect(current.fpm.maxExecutionSeconds).toBe(original.maxExecutionSeconds);await verify(original);record('php.version-switch.restored',{verified:true,phpVersion:original.phpVersion});}
   if(!phase2Uncertain&&phase2Jobs.size===0)await phase2OwnedEffect('php.runtime-proof-delete',()=>remove(liveApi,m,name));
  }catch(error){record('php.version-switch.cleanup-failed',{firstFailurePreserved:Boolean(primaryError),state:phase2Uncertain?'UNKNOWN_KEEP':'FAILED'});if(!primaryError)throw error;}
 }
});

async function browserLogin(browser,installed,username,password,phase='initial'){
 const c=await browser.newContext({ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]}});
 let p,primaryError;
 const transportCodes=new Set(['ERR_ABORTED','ERR_FAILED','ERR_EMPTY_RESPONSE','ERR_CONNECTION_CLOSED','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED','ERR_CONNECTION_TIMED_OUT','ERR_TIMED_OUT','ERR_NAME_NOT_RESOLVED','ERR_NETWORK_CHANGED','ERR_INTERNET_DISCONNECTED','ERR_ADDRESS_UNREACHABLE','ERR_SSL_PROTOCOL_ERROR','ERR_CERT_AUTHORITY_INVALID','ERR_PROXY_CONNECTION_FAILED','NS_ERROR_NET_RESET','NS_ERROR_NET_TIMEOUT','NS_BINDING_ABORTED']);
 const transportCode=value=>{const code=String(value??'').match(/\b(?:ERR_[A-Z_]+|NS_ERROR_[A-Z_]+|NS_BINDING_ABORTED)\b/)?.[0];return transportCodes.has(code)?code:null;};
 const observation={phase,requestCount:0,postRequestCount:0,responseCount:0,postResponseCount:0,requestFailedCount:0,submitEventCount:0,trustedSubmitEventCount:0,submitListenerInstalled:false,clickAttempted:false,clickResolved:false,events:[],droppedEvents:0,lifecycleEvents:[],droppedLifecycleEvents:0,lifecycleLimitReached:false,publicScripts:[],inlineFocusShape:null,credentialsProvided:{userNonempty:typeof username==='string'&&username.length>0,passNonempty:typeof password==='string'&&password.length>0},formBeforeSubmit:null,failure:null};
 let stage='fresh-context';
 const events=new Map(),publicScriptTasks=[];
 const append=value=>{if(observation.events.length<40)observation.events.push(value);else observation.droppedEvents+=1;};
 const requestIdentity=request=>{try{const url=new URL(request.url());if(url.hostname!==new URL(installed.loginUrl).hostname||!(url.pathname==='/wp-login.php'||url.pathname.startsWith('/wp-admin/')))return null;return{method:request.method(),path:url.pathname};}catch{return null;}};
 async function safeState(){
  let timer;
  try{return await Promise.race([p.evaluate(()=>{
   const message=document.querySelector('#login_error')?.textContent??'';
   return{path:location.pathname,title:document.title,adminBarPresent:Boolean(document.querySelector('#wpadminbar')),loginErrorPresent:Boolean(message),testSessionFailure:/çerez|cookie/i.test(message),credentialsRejected:/(parola|şifre).*(yanlış|geçersiz)|incorrect.*password|invalid.*username/i.test(message)};
  }),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2000);})]);}catch{return null;}finally{clearTimeout(timer);}
 }
 try{
  const hostname=new URL(installed.loginUrl).hostname,own=values=>values.filter(v=>v.domain===hostname||v.domain==='.'+hostname);const previousSiteSessions=own(await c.cookies()).length;expect(previousSiteSessions,'A fresh login context must contain no site session').toBe(0);
  const lifecycleBinding='__yunpanelT905ObservedLifecycle';
  await c.exposeBinding(lifecycleBinding,(source,value)=>{
   if(source.page!==p||source.frame!==p.mainFrame())return;
   let url;try{url=new URL(source.frame.url());}catch{return;}if(url.hostname!==hostname||url.pathname!=='/wp-login.php')return;
   const kinds=['focusin','input','change','invalid','DOMContentLoaded','load','readystatechange'],fields=[null,'user','password','submit','form'];
   if(!value||Object.keys(value).length!==8||!kinds.includes(value.kind)||!fields.includes(value.field)||!fields.includes(value.activeField)||!['loading','interactive','complete'].includes(value.readyState)||typeof value.trusted!=='boolean'||!Number.isFinite(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>600000||![value.userNonempty,value.passNonempty].every(v=>typeof v==='boolean'||v===null))return;
   if(observation.lifecycleEvents.length<80)observation.lifecycleEvents.push(value);else observation.droppedLifecycleEvents+=1;
   if(observation.lifecycleEvents.length===80)observation.lifecycleLimitReached=true;
  });
  await c.addInitScript(name=>{
   let count=0;const field=node=>node?.id==='user_login'?'user':node?.id==='user_pass'?'password':node?.id==='wp-submit'?'submit':node?.id==='loginform'?'form':null;
   const observe=event=>{if(location.pathname!=='/wp-login.php'||count>=80)return;const target=field(event.target);if(['focusin','input','change','invalid'].includes(event.type)&&target===null)return;count+=1;
    const user=document.querySelector('#user_login'),pass=document.querySelector('#user_pass');
    const value={kind:event.type,field:target,activeField:field(document.activeElement),readyState:document.readyState,trusted:event.isTrusted,elapsedMs:Math.round(performance.now()),userNonempty:user?Boolean(user.value):null,passNonempty:pass?Boolean(pass.value):null};
    if(typeof window[name]==='function')void window[name](value).catch(()=>{});
   };
   for(const kind of ['focusin','input','change','invalid','DOMContentLoaded','readystatechange'])document.addEventListener(kind,observe,{capture:true,passive:true});
   window.addEventListener('load',observe,{capture:true,passive:true});
  },lifecycleBinding);
  p=await c.newPage();
  events.set('request',request=>{const id=requestIdentity(request);if(!id)return;observation.requestCount+=1;if(id.method==='POST')observation.postRequestCount+=1;append({kind:'request',...id});});
  events.set('response',response=>{const id=requestIdentity(response.request());if(!id)return;observation.responseCount+=1;if(id.method==='POST')observation.postResponseCount+=1;append({kind:'response',...id,status:response.status()});
   if(id.method!=='GET'||!['/wp-admin/load-scripts.php','/wp-admin/js/user-profile.js','/wp-admin/js/user-profile.min.js','/wp-admin/js/password-strength-meter.js','/wp-admin/js/password-strength-meter.min.js'].includes(id.path)||publicScriptTasks.length>=8)return;
   const version=new URL(response.url()).searchParams.get('ver'),asset={path:id.path,status:response.status(),version:/^\d+\.\d+(?:\.\d+)?$/.test(version??'')?version:null,bodyObserved:false,sha256:null};observation.publicScripts.push(asset);
   publicScriptTasks.push(response.body().then(body=>{if(body.length>1048576){asset.oversized=true;return;}asset.bodyObserved=true;asset.bytes=body.length;asset.sha256=createHash('sha256').update(body).digest('hex');}).catch(error=>{asset.transportCode=transportCode(error?.message);}));
  });
  events.set('requestfailed',request=>{const id=requestIdentity(request);if(!id)return;observation.requestFailedCount+=1;append({kind:'requestfailed',...id,transportCode:transportCode(request.failure()?.errorText)});});
  for(const [name,handler]of events)p.on(name,handler);
  stage='login-get';const response=await p.goto(installed.loginUrl,{waitUntil:'domcontentloaded'});const afterGet=own(await c.cookies());record('wordpress.browser-login.http',{phase,status:response?.status()??null,hostname:new URL(p.url()).hostname,path:new URL(p.url()).pathname,title:await p.title(),formInputs:await p.locator('#user_login').count(),previousSiteSessions,wpTestSessionPresent:afterGet.some(v=>v.name==='wordpress_test_cookie'),secureSessions:afterGet.filter(v=>v.secure).length});expect(response?.status(),'The real login form must respond successfully').toBe(200);
  const binding='__yunpanelT905ObservedSubmit';
  await p.exposeBinding(binding,(source,value)=>{if(source.page!==p||source.frame!==p.mainFrame()||typeof value?.trusted!=='boolean'||Object.keys(value).length!==1)return;observation.submitEventCount+=1;if(value.trusted)observation.trustedSubmitEventCount+=1;});
  observation.inlineFocusShape=await p.evaluate(name=>{
   document.addEventListener('submit',event=>{if(!(event.target instanceof HTMLFormElement)||event.target.id!=='loginform')return;void window[name]({trusted:event.isTrusted}).catch(()=>{});},{capture:true,passive:true});
   const source=typeof window.wp_attempt_focus==='function'?Function.prototype.toString.call(window.wp_attempt_focus):'';
   return{functionPresent:Boolean(source),delayed200ms:/setTimeout\s*\(/.test(source)&&/},\s*200\s*\)/.test(source),targetsUser:/getElementById\(\s*["']user_login["']\s*\)/.test(source),targetsPass:/getElementById\(\s*["']user_pass["']\s*\)/.test(source),clearsValue:/\.value\s*=\s*["']["']/.test(source),focusAndSelect:/\.focus\(\)/.test(source)&&/\.select\(\)/.test(source),callPrinted:[...document.scripts].some(script=>!script.src&&/\bwp_attempt_focus\s*\(\s*\)\s*;/.test(script.textContent??''))};
  },binding);
  observation.submitListenerInstalled=true;
  stage='initial-autofocus';
  expect(observation.inlineFocusShape.functionPresent&&observation.inlineFocusShape.targetsUser&&!observation.inlineFocusShape.targetsPass&&observation.inlineFocusShape.focusAndSelect&&observation.inlineFocusShape.callPrinted,'The fresh WordPress form must expose its normal username autofocus').toBe(true);
  // WordPress focuses/selects the username asynchronously; wait before either private fill.
  await expect(p.locator('#user_login'),'The initial WordPress autofocus must finish before entering credentials').toBeFocused();
  observation.initialFocus=await p.evaluate(()=>{const user=document.querySelector('#user_login'),pass=document.querySelector('#user_pass');return{userFocused:document.activeElement===user,userNonempty:user?Boolean(user.value):null,passNonempty:pass?Boolean(pass.value):null,elapsedMs:Math.round(performance.now())};});
  expect(observation.initialFocus.userFocused,'The initial focus must still belong to the username field').toBe(true);
  async function fillPrivate(selector,value,field){try{await p.locator(selector).fill(value);}catch(error){observation.fillFailure={field,timeout:error?.name==='TimeoutError',transportCode:transportCode(error?.message)};const safe=new Error('WordPress private input fill failed; values and call log withheld');if(error?.name==='TimeoutError')safe.name='TimeoutError';throw safe;}}
  stage='fill-user';await fillPrivate('#user_login',username,'user');stage='fill-pass';await fillPrivate('#user_pass',password,'password');
  stage='form-before-submit';observation.formBeforeSubmit=await p.evaluate(({expectedUser,expectedPassword})=>{
   const form=document.querySelector('#loginform'),user=document.querySelector('#user_login'),pass=document.querySelector('#user_pass'),button=document.querySelector('#wp-submit');
   const action=form?new URL(form.action,location.href):null;
   return{formPresent:Boolean(form),checkValidity:form?form.checkValidity():null,userNonempty:user?Boolean(user.value):null,passNonempty:pass?Boolean(pass.value):null,userMatchesExpected:user?user.value===expectedUser:null,passMatchesExpected:pass?pass.value===expectedPassword:null,userEqualsSuppliedPass:user?user.value===expectedPassword:null,activeField:document.activeElement===user?'user':document.activeElement===pass?'password':null,buttonDisabled:button?button.disabled:null,actionScheme:action?.protocol??null,actionOrigin:action?.origin??null,actionPath:action?.pathname??null};
  },{expectedUser:username,expectedPassword:password});
  expect(observation.formBeforeSubmit.userMatchesExpected,'The username must remain in its own field').toBe(true);
  expect(observation.formBeforeSubmit.passMatchesExpected,'The supplied pass must remain in its own field').toBe(true);
  expect(observation.formBeforeSubmit.userEqualsSuppliedPass,'The username field must never contain the supplied pass').toBe(false);
  expect(observation.formBeforeSubmit.checkValidity,'The real login form must be valid before its only submit click').toBe(true);
  // Attach both handlers immediately: a click error must not leave the response waiter rejecting unobserved.
  const submitted=p.waitForResponse(r=>new URL(r.url()).pathname==='/wp-login.php'&&r.request().method()==='POST',{timeout:45000}).then(response=>({response}),error=>({error}));
  stage='submit-click';observation.clickAttempted=true;await p.locator('#wp-submit').click();observation.clickResolved=true;
  stage='post-response';const settled=await submitted;if(settled.error)throw settled.error;const result=settled.response;
  let testSessionSent=null;try{testSessionSent=/(?:^|;\s*)wordpress_test_cookie=/.test((await result.request().allHeaders()).cookie??'');}catch{}record('wordpress.browser-login.post',{phase,status:result.status(),testSessionSent});
  stage='admin-url';await expect(p).toHaveURL(/\/wp-admin\//,{timeout:30000});stage='admin-bar';await expect(p.locator('#wpadminbar')).toBeVisible({timeout:30000});stage='verified';
 }catch(error){
  primaryError=error;
  const current=await safeState();
  observation.failure={stage,timeout:error?.name==='TimeoutError'||/timed?\s*out|timeout/i.test(String(error?.message??'')),transportCode:transportCode(error?.message),path:current?.path??null,adminBarPresent:current?.adminBarPresent??null,loginErrorPresent:current?.loginErrorPresent??null,testSessionFailure:current?.testSessionFailure??null,credentialsRejected:current?.credentialsRejected??null};
  try{record('wordpress.browser-login.result',{phase,path:current?.path??null,title:current?.title??null,loginErrorPresent:current?.loginErrorPresent??null,testSessionFailure:current?.testSessionFailure??null,credentialsRejected:current?.credentialsRejected??null});}catch{/* Preserve the original browser failure even if writing its observation fails. */}
  throw error;
 }finally{
  let cleanupError;
  try{if(p)for(const [name,handler]of events)p.off(name,handler);}catch(error){cleanupError=error;}
  try{await c.close();}catch(error){cleanupError??=error;}
  await Promise.allSettled(publicScriptTasks);
  try{record('wordpress.browser-login.observation',{...observation,stage});}catch(error){cleanupError??=error;}
  if(!primaryError&&cleanupError)throw cleanupError;
 }
}

test('@mutation source WordPress installs in Turkish against the real site DB and verifies actual HTTP and locale',async({liveApi,page,browser})=>{
 test.setTimeout(480000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',sec=secrets(),username='t886_admin';expect(m.fixture.binding?.id).toBeTruthy();
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');const form=main(page).locator('form.ws-form-grid');await expect(form).toBeVisible();
 await form.getByLabel('Site başlığı',{exact:true}).fill('T886 Türkçe '+m.runId);await form.getByLabel('Yönetici kullanıcı adı',{exact:true}).fill(username);await form.getByLabel('Yönetici e-posta adresi',{exact:true}).fill(sec.siteAdminEmail);await form.locator('input[type=password]').fill(sec.wpAdminPassword);
 await form.locator('select').filter({has:page.locator('option[value=tr_TR]')}).selectOption('tr_TR');await form.locator('select').filter({has:page.locator('option[value=http]')}).selectOption('http');await form.locator('select').filter({has:page.locator('option[value="'+m.fixture.binding.id+'"]')}).selectOption(m.fixture.binding.id);
 const queued=page.waitForResponse(r=>new URL(r.url()).pathname===root+'/actions'&&r.request().method()==='POST',{timeout:180000});await form.getByRole('button',{name:'WordPress kur',exact:true}).click();const response=await queued;expect(response.status()).toBe(202);const install=(await response.json()).data;
 expect((await waitJob(liveApi.api,install.job.id,420000)).status).toBe('succeeded');
 const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.installed');expect(installed.installed).toBe(true);expect(installed.loginUrl).toBe('http://'+m.fixture.hostname+'/wp-login.php');expect(installed.administrators).toContain(username);
 const http=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(http.status()).toBe(200);expect(await http.text()).toMatch(/<html[^>]*\blang=["']tr(?:-TR)?["']/i);const locale=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/websites/'+m.fixture.websiteId+'/wp-cli/run',{command:'eval',args:['echo json_encode(array("locale"=>get_locale(),"available"=>in_array("tr_TR",get_available_languages(),true)));','--skip-plugins','--skip-themes','--skip-packages'],timeout:30000}),'wordpress.actual-locale');expect(locale.success).toBe(true);expect(JSON.parse(locale.stdout.trim())).toEqual({locale:'tr_TR',available:true});
 record('wordpress.real-installation',{verified:true,locale:'tr_TR'});

});

test('@mutation source mail domain and mailbox forms apply the actual service before closing',async({liveApi,page})=>{
 test.setTimeout(180000);const m=owned();
 if(!m.fixture.mailDomainId){await ready(page,'/mail');await main(page).getByRole('button',{name:'Mail alan adı ekle',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.locator('select').filter({has:page.locator('option[value="'+m.fixture.domainId+'"]')}).selectOption(m.fixture.domainId);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mail-domains')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'Posta hizmetini oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const current=manifest();current.fixture.mailDomainId=(await r.json()).data.id;saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});
 }
 const now=manifest();const domain=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mail-domains/'+now.fixture.mailDomainId),'mail.native.enabled');expect(domain.status).toBe('enabled');
 await ready(page,'/mail/'+domain.id);const file=secretsFile,secrets=JSON.parse(fs.readFileSync(file,'utf8'));secrets.mailPasswords??={};
 for(const name of ['alpha','beta']){
  secrets.mailPasswords[name]??=randomBytes(24).toString('base64url');fs.writeFileSync(file,JSON.stringify(secrets),{mode:0o600});
  const boxes=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes?mailDomainId='+domain.id),'mail.boxes.read');expect(boxes.some(b=>b.address===name+'@'+now.fixture.hostname),'Every fresh mailbox must be created through its form').toBe(false);
  await main(page).getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).first().click();const dialog=page.getByRole('dialog');await expect(dialog).toHaveCount(1);await dialog.getByLabel('Adres',{exact:true}).fill(name);await dialog.getByLabel('İlk parola',{exact:true}).fill(secrets.mailPasswords[name]);const response=page.waitForResponse(r=>r.url().endsWith('/api/panel/mailboxes')&&r.request().method()==='POST');await dialog.getByRole('button',{name:'E-posta hesabı oluştur',exact:true}).click();const r=await response;expect(r.status()).toBe(201);const box=(await r.json()).data;const current=manifest();current.fixture.mailboxIds??=[];current.fixture.mailboxIds.push(box.id);saveManifest(current);await expect(dialog).toBeHidden({timeout:120000});await expect(main(page)).toContainText(name+'@'+now.fixture.hostname);const actualBox=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes/'+box.id),'mail.actual-enabled');expect(actualBox.enabled).toBe(true);
 }
 record('mail.native-forms',{verified:true,mailboxes:2});
 const current=manifest();const delivered=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes/'+current.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+current.fixture.hostname,subject:'OWNED-NATIVE-'+current.runId}),'mail.owned-delivery');expect(delivered.delivered).toBe(true);record('mail.owned-smtp-delivery',{verified:true});
});


async function verifyProtectedWebhookSecret(secret,expectedStatus){
 const jobEndpoint='/api/panel/jobs?resourceId='+state.fixture.applicationId;const before=check(await apiCall(owner.api,owner.csrf,'GET',jobEndpoint),'webhook.jobs.before').map(job=>job.id).sort();
 const api=await request.newContext({baseURL:ORIGIN,ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]}});
 try{const body='{}',signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');const response=await api.post('/api/webhooks/github/'+state.fixture.applicationId,{data:body,headers:{'content-type':'application/json','x-github-event':'ping','x-github-delivery':randomUUID(),'x-hub-signature-256':signature},timeout:30000});expect(response.status(),'Actual protected secret HMAC verification').toBe(expectedStatus);const result=await response.json();if(expectedStatus===202)expect(result.data).toMatchObject({status:'ignored',reason:'event_not_supported',event:'ping'});else expect(result.error?.code).toBe('github_webhook_signature_invalid');}finally{await api.dispose();}const after=check(await apiCall(owner.api,owner.csrf,'GET',jobEndpoint),'webhook.jobs.after').map(job=>job.id).sort();expect(after,'Signed non-push verification must not queue a deployment').toEqual(before);
}
async function imapReceipt({hostname,address,password,subject=null}){
 return await new Promise((resolve,reject)=>{
 const socket=tls.connect({host:'157.180.11.28',port:993,servername:hostname,rejectUnauthorized:true});let buffer='',stage='greeting';
 const timer=setTimeout(()=>finish(new Error('Actual IMAP receipt deadline exceeded; credentials and protocol withheld')),25000);
 function finish(error,result){clearTimeout(timer);socket.destroy();if(error)reject(error);else resolve(result);}
 socket.on('error',()=>finish(new Error('Trusted IMAP transport failed; credentials and protocol withheld')));
 socket.on('data',chunk=>{buffer+=chunk.toString();
 if(stage==='greeting'&&buffer.includes('\r\n')){stage='login';buffer='';socket.write('A1 LOGIN '+JSON.stringify(address)+' '+JSON.stringify(password)+'\r\n');return;}
 if(stage==='login'&&/A1 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A1 OK '))return finish(null,{authenticated:false});if(!subject)return finish(null,{authenticated:true});stage='examine';buffer='';socket.write('A2 EXAMINE INBOX\r\n');return;}
 if(stage==='examine'&&/A2 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A2 OK '))return finish(new Error('Owned IMAP inbox could not be examined'));stage='search';buffer='';socket.write('A3 SEARCH HEADER Subject '+JSON.stringify(subject)+'\r\n');return;}
 if(stage==='search'&&/A3 (OK|NO|BAD) /.test(buffer)){if(!buffer.includes('A3 OK '))return finish(new Error('Actual IMAP subject search failed'));const matches=(buffer.match(/\* SEARCH([^\r\n]*)/)?.[1]??'').trim().split(/\s+/).filter(v=>/^\d+$/.test(v));finish(null,{authenticated:true,received:matches.length>0,messages:matches.length});}
 });
 });
}
test('@mutation source actual IMAP authentication finds the SMTP test message only in the owned recipient',async({liveApi})=>{
 test.setTimeout(90000);const m=owned();expect(m.fixture.mailboxIds?.length).toBe(2);const sec=secrets();
 const settings=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]+'/connection-settings'),'mail.imap.settings');const hostname=settings.mailHostname??settings.incoming?.hostname;expect(typeof hostname).toBe('string');m.fixture.mailHostname=hostname;saveManifest(m);
 const input={hostname,subject:'OWNED-NATIVE-'+m.runId};let received;
 for(let attempt=0;attempt<10;attempt++){received=await imapReceipt({...input,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta});if(received.received)break;await new Promise(r=>setTimeout(r,500));}
 expect(received).toMatchObject({authenticated:true,received:true,messages:1});
 const sender=await imapReceipt({...input,address:'alpha@'+m.fixture.hostname,password:sec.mailPasswords.alpha});expect(sender).toMatchObject({authenticated:true,received:false,messages:0});record('mail.actual-imap-receipt',{recipient:received,sender});
});

// Fetch and remove only the unique message created by this run. Never EXPUNGE a whole mailbox.
async function ownedImapMessage({hostname,address,password,subject,remove=false,expectedSha256=null}){
 return await new Promise((resolve,reject)=>{
  const socket=tls.connect({host:'157.180.11.28',port:993,servername:hostname,rejectUnauthorized:true});let buffer=Buffer.alloc(0),stage='greeting',uid=null,uidValidity=null,message=null,finished=false;
  const timer=setTimeout(()=>fail(),45000);
  function finish(error,value){if(finished)return;finished=true;clearTimeout(timer);if(error){socket.destroy();reject(error);}else{socket.end('A9 LOGOUT\r\n');resolve(value);}}
  function fail(){finish(new Error('Owned IMAP message operation failed at '+stage+'; credentials and protocol withheld'));}
  function send(next,command){stage=next;buffer=Buffer.alloc(0);socket.write(command+'\r\n');}
  function tagged(tag,text=buffer.toString('latin1')){return text.match(new RegExp('(?:^|\\r\\n)'+tag+' (OK|NO|BAD) '))?.[1];}
  function ids(text){const line=text.match(/\* SEARCH([^\r\n]*)/)?.[1]?.trim()??'';if(!line)return[];const list=line.split(/\s+/);if(list.some(v=>!/^\d+$/.test(v)))throw new Error('Invalid owned UID search');return list.map(Number);}
  socket.on('error',()=>fail());
  socket.on('data',chunk=>{if(finished)return;buffer=Buffer.concat([buffer,chunk]);if(buffer.length>1024*1024)return fail();try{
   const text=buffer.toString('latin1');
   if(stage==='greeting'&&text.includes('\r\n'))return send('login','A1 LOGIN '+JSON.stringify(address)+' '+JSON.stringify(password));
   if(stage==='login'&&tagged('A1')){if(tagged('A1')!=='OK')return fail();return send('select','A2 SELECT INBOX');}
   if(stage==='select'&&tagged('A2')){if(tagged('A2')!=='OK')return fail();uidValidity=Number(text.match(/\[UIDVALIDITY (\d+)\]/)?.[1]);if(!Number.isSafeInteger(uidValidity)||uidValidity<1)return fail();return send('search','A3 UID SEARCH HEADER Subject '+JSON.stringify(subject));}
   if(stage==='search'&&tagged('A3')){if(tagged('A3')!=='OK')return fail();const matches=ids(text);if(matches.length===0&&!remove)return finish(null,{count:0});if(matches.length!==1)return fail();uid=matches[0];return send('fetch','A4 UID FETCH '+uid+' (BODY.PEEK[])');}
   if(stage==='fetch'){
    const literal=text.match(/\{(\d+)\}\r\n/);if(!literal)return;if(Number(literal[1])>512*1024)return fail();const start=literal.index+literal[0].length,end=start+Number(literal[1]);if(buffer.length<end)return;const status=tagged('A4',buffer.subarray(end).toString('latin1'));if(!status)return;if(status!=='OK')return fail();const contents=buffer.subarray(start,end);message={count:1,uid,uidValidity,bytes:contents.length,sha256:createHash('sha256').update(contents).digest('hex')};
    if(expectedSha256&&message.sha256!==expectedSha256)return fail();if(!remove)return finish(null,message);return send('mark','A5 UID STORE '+uid+' +FLAGS.SILENT (\\Deleted)');
   }
   if(stage==='mark'&&tagged('A5')){if(tagged('A5')!=='OK')return fail();return send('expunge','A6 UID EXPUNGE '+uid);}
   if(stage==='expunge'&&tagged('A6')){if(tagged('A6')!=='OK')return fail();return send('absent','A7 UID SEARCH HEADER Subject '+JSON.stringify(subject));}
   if(stage==='absent'&&tagged('A7')){if(tagged('A7')!=='OK')return fail();const matches=ids(text);if(matches.length)return fail();finish(null,{...message,removed:true,remaining:0});}
  }catch{fail();}});
 });
}

function sqlToken(value){return String(value).replace(/[^A-Za-z0-9_-]/g,'-').slice(0,40);}
async function ensureCompoundPrerequisites(c,m){
 if(!m.fixture.binding?.id){
  const site=check(await apiCall(c.api,c.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId),'compound.prerequisite.website');
  const created=check(await apiCall(c.api,c.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases',{databaseName:m.fixture.databaseName,mode:'create',expectedWebsiteRevision:site.revision}),'compound.prerequisite.database',202);
  expect((await waitJob(c.api,created.job.id)).status).toBe('succeeded');
  m.fixture.binding=created.binding;m.fixture.credential=created.credential;m.fixture.createdDatabaseNames=[m.fixture.databaseName];saveManifest(m);
  const connection=check(await apiCall(c.api,c.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+created.binding.id+'/connection',{revealPassword:true}),'compound.prerequisite.connection');
  const initName='compound-db-init-'+m.runId+'.php',proof='DB-NATIVE-'+sqlToken(m.runId);
  const initSource='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(v=>JSON.stringify(v)).join(',')+');$db->query("CREATE TABLE IF NOT EXISTS yp_native_proof (id INT PRIMARY KEY, value VARCHAR(128))");$s=$db->prepare("REPLACE INTO yp_native_proof VALUES (1, ?)");$v='+JSON.stringify(proof)+';$s->bind_param("s",$v);$s->execute();$r=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["proof"=>$r["value"]]);';
  try{await upload(c,m,initName,initSource);const actual=await c.api.get('http://'+m.fixture.hostname+'/'+initName);expect(actual.status()).toBe(200);expect((await actual.json()).proof).toBe(proof);}finally{await remove(c,m,initName);}
  record('compound.db.api-prerequisite-only',{databaseName:m.fixture.databaseName,uiCreateVerified:false});
 }
 if(!m.fixture.mailDomainId){
  const createdDomain=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mail-domains',{name:m.fixture.hostname,webDomainId:m.fixture.domainId,managementMode:'local'}),'compound.prerequisite.mail-domain',201);
  m.fixture.mailDomainId=createdDomain.id;saveManifest(m);
 }
 if((m.fixture.mailboxIds?.length??0)<2){
  const sec=secrets();sec.mailPasswords??={};m.fixture.mailboxIds??=[];
  const existingBoxes=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mailboxes?mailDomainId='+m.fixture.mailDomainId),'compound.prerequisite.mailboxes');
  for(const name of ['alpha','beta']){
   sec.mailPasswords[name]??=randomBytes(24).toString('base64url');saveSecrets(sec);
   const address=name+'@'+m.fixture.hostname;let box=existingBoxes.find(item=>item.address===address);
   if(!box)box=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mailboxes',{mailDomainId:m.fixture.mailDomainId,address,password:sec.mailPasswords[name]}),'compound.prerequisite.mailbox',201);
   if(!m.fixture.mailboxIds.includes(box.id))m.fixture.mailboxIds.push(box.id);
  }
  saveManifest(m);await applyMail(c,m.fixture.mailDomainId,'enabled');
  record('compound.mail.api-prerequisite-only',{mailDomainId:m.fixture.mailDomainId,mailboxes:m.fixture.mailboxIds.length,uiCreateVerified:false});
 }
 if(!m.fixture.mailHostname){
  const settings=check(await apiCall(c.api,c.csrf,'GET','/api/panel/mailboxes/'+m.fixture.mailboxIds[1]+'/connection-settings'),'compound.prerequisite.imap-settings');
  const hostname=settings.mailHostname??settings.incoming?.hostname;expect(typeof hostname).toBe('string');m.fixture.mailHostname=hostname;saveManifest(m);
 }
}
async function ensureCompoundBackupFixture(c,m){
 if(m.fixture.nativeBackup?.purpose==='compound')return m.fixture.nativeBackup;
 await ensureCompoundPrerequisites(c,m);
 const root='/api/panel/websites/'+m.fixture.websiteId,sec=secrets();expect(m.fixture.mailHostname).toBeTruthy();
 await recordOwnedBackupResources(c,m);
 await nativeMailboxPassword(c,m,sec.mailPasswords.beta);
 const messageInput={hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:'OWNED-NATIVE-'+m.runId};
 let originalMessage=await ownedImapMessage(messageInput);
 if(originalMessage.count===0){
  const delivered=check(await apiCall(c.api,c.csrf,'POST','/api/panel/mailboxes/'+m.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+m.fixture.hostname,subject:'OWNED-NATIVE-'+m.runId}),'compound.prerequisite.delivery');
  expect(delivered.delivered).toBe(true);
  for(let attempt=0;attempt<15&&originalMessage.count===0;attempt++){await new Promise(r=>setTimeout(r,500));originalMessage=await ownedImapMessage(messageInput);}
 }
 expect(originalMessage.count).toBe(1);m.fixture.originalMessage=originalMessage;saveManifest(m);record('backup.mail-message-before',originalMessage);
 const repo=await ownRepository(c);
 const markerName='native-restore-proof-'+m.runId+'.txt',marker='NATIVE-RESTORE-'+m.runId;
 const healthProbeName='native-restore-health-'+m.runId+'.php',snapshotAHealthBody='OWNED-SNAPSHOT-A-HEALTH-503';
 const snapshotAHealthSource='<?php http_response_code(503); header("Content-Type: text/plain"); echo "OWNED-SNAPSHOT-A-HEALTH-503";';
 const sqlName='native-restore-sql-'+m.runId+'.php';
 const connection=check(await apiCall(c.api,c.csrf,'POST','/api/panel/servers/'+m.serverId+'/websites/'+m.fixture.websiteId+'/databases/'+m.fixture.binding.id+'/connection',{revealPassword:true}),'backup.database.connection');
 const sql='<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli('+[connection.host,connection.username,connection.password,connection.databaseName].map(v=>JSON.stringify(v)).join(',')+');if($_SERVER["REQUEST_METHOD"]==="POST"){$raw=file_get_contents("php://input");$decoded=is_string($raw)&&$raw!==""?json_decode($raw,true):null;$next=is_array($decoded)&&isset($decoded["value"])?$decoded["value"]:($_POST["value"]??($_GET["value"]??""));if(!is_string($next)||!preg_match("/^[A-Za-z0-9_-]{1,96}$/",$next)){http_response_code(400);echo json_encode(["error"=>"invalid_sql_proof"]);exit;}$stmt=$db->prepare("UPDATE yp_native_proof SET value = ? WHERE id = 1");$stmt->bind_param("s",$next);$stmt->execute();}$row=$db->query("SELECT value FROM yp_native_proof WHERE id = 1")->fetch_assoc();echo json_encode(["proof"=>$row["value"]]);';
 await upload(c,m,markerName,marker);await upload(c,m,healthProbeName,snapshotAHealthSource);await upload(c,m,sqlName,sql);
 const beforeMarker=await c.api.get('http://'+m.fixture.hostname+'/'+markerName);expect(beforeMarker.status()).toBe(200);expect(await beforeMarker.text()).toBe(marker);
 const beforeHealth=await c.api.get('http://'+m.fixture.hostname+'/'+healthProbeName);expect(beforeHealth.status()).toBe(503);expect(await beforeHealth.text()).toBe(snapshotAHealthBody);
 const sqlUrl='http://'+m.fixture.hostname+'/'+sqlName;const beforeSql=await c.api.get(sqlUrl);expect(beforeSql.status()).toBe(200);const beforeRow=await beforeSql.json();expect(typeof beforeRow.proof).toBe('string');
 const envRoot='/api/panel/applications/'+m.fixture.applicationId+'/github-webhook';sec.environmentBefore=randomBytes(32).toString('base64url');sec.environmentAfter=randomBytes(32).toString('base64url');saveSecrets(sec);
 check(await apiCall(c.api,c.csrf,'PUT',envRoot,{secret:sec.environmentBefore}),'backup.environment.original');
 const envBefore=check(await apiCall(c.api,c.csrf,'GET',envRoot),'backup.environment.before');await verifyProtectedWebhookSecret(sec.environmentBefore,202);
 const preview=check(await apiCall(c.api,c.csrf,'POST',root+'/backup/preview',{repositoryId:repo.id}),'backup.preview');const queued=check(await apiCall(c.api,c.csrf,'POST',root+'/backup-operations',{kind:'backup',repositoryId:repo.id,expectedPreviewDigest:preview.backupSetDigest,confirmation:preview.confirmation,tags:['t886-'+m.runId]}),'backup.queue',202);
 const backedUp=await finishedBackup(c,root,queued),snapshotId=backedUp.result?.snapshot?.snapshotId;expect(snapshotId).toBeTruthy();
 m.fixture.nativeBackup={purpose:'compound',repositoryId:repo.id,snapshotId,operationId:queued.id,markerName,marker,healthProbeName,snapshotAHealthBody,sqlName,snapshotASqlProof:beforeRow.proof,originalMessage,envBefore};saveManifest(m);
 return m.fixture.nativeBackup;
}

test('@mutation source real backup restores file content, SQL, mailbox authentication and the protected environment secret',async({liveApi})=>{
 test.setTimeout(480000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId;
 const saved=await ensureCompoundBackupFixture(liveApi,m),sec=secrets();
 const {repositoryId,snapshotId,markerName,marker,healthProbeName,snapshotAHealthBody,sqlName,snapshotASqlProof,originalMessage,envBefore}=saved;
 const sqlUrl='http://'+m.fixture.hostname+'/'+sqlName,envRoot='/api/panel/applications/'+m.fixture.applicationId+'/github-webhook';
 const messageInput={hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:'OWNED-NATIVE-'+m.runId};
 const changedProof='CHANGED-'+sqlToken(m.runId)+'-'+randomBytes(6).toString('hex');
 const removedMessage=await ownedImapMessage({...messageInput,remove:true,expectedSha256:originalMessage.sha256});expect(removedMessage.removed).toBe(true);expect(removedMessage.remaining).toBe(0);expect((await ownedImapMessage(messageInput)).count).toBe(0);record('backup.mail-message-deleted',{uid:removedMessage.uid,sha256:removedMessage.sha256,remaining:0});
 await upload(liveApi,m,markerName,'CHANGED-'+m.runId);const changedSql=await liveApi.api.post(sqlUrl,{data:{value:changedProof}});expect(changedSql.status()).toBe(200);expect((await changedSql.json()).proof).toBe(changedProof);
 sec.nativeBackupChangedPassword=randomBytes(30).toString('base64url');saveSecrets(sec);await nativeMailboxPassword(liveApi,m,sec.nativeBackupChangedPassword);
 expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.nativeBackupChangedPassword})).authenticated).toBe(true);
 check(await apiCall(liveApi.api,liveApi.csrf,'PUT',envRoot,{secret:sec.environmentAfter}),'backup.environment.changed');await verifyProtectedWebhookSecret(sec.environmentBefore,401);await verifyProtectedWebhookSecret(sec.environmentAfter,202);
 const input={repositoryId,snapshotId,healthPath:'/'+markerName,timeoutSeconds:30,include:['paths','databases','mail','environment']};const restorePreview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'backup.restore.preview');const restore=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation}),'backup.restore.queue',202);
 await finishedBackup(liveApi,root,restore);
 const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/'+markerName);expect(actual.status()).toBe(200);expect(await actual.text()).toBe(marker);
 const restoredHealthProbe=await liveApi.api.get('http://'+m.fixture.hostname+'/'+healthProbeName);expect(restoredHealthProbe.status()).toBe(503);expect(await restoredHealthProbe.text()).toBe(snapshotAHealthBody);
 const restoredSql=await liveApi.api.get(sqlUrl);expect(restoredSql.status()).toBe(200);expect((await restoredSql.json()).proof).toBe(snapshotASqlProof);
 const restoredMessage=await ownedImapMessage(messageInput);expect(restoredMessage.count).toBe(1);expect(restoredMessage.sha256).toBe(originalMessage.sha256);expect(restoredMessage.bytes).toBe(originalMessage.bytes);record('backup.mail-message-restored',{sha256:restoredMessage.sha256,bytes:restoredMessage.bytes,count:restoredMessage.count});const oldLogin=await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:'OWNED-NATIVE-'+m.runId});expect(oldLogin).toMatchObject({authenticated:true,received:true,messages:1});expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.nativeBackupChangedPassword})).authenticated).toBe(false);
 const envAfter=check(await apiCall(liveApi.api,liveApi.csrf,'GET',envRoot),'backup.environment.restored');expect(envAfter).toEqual(envBefore);await verifyProtectedWebhookSecret(sec.environmentBefore,202);await verifyProtectedWebhookSecret(sec.environmentAfter,401);
 record('backup.real-content-and-authentication',{verified:true,snapshotId,restoreOperationId:restore.id,file:true,sql:true,originalMailboxAuthentication:true,changedMailboxAuthenticationRejected:true,messageRestored:true,environmentMetadata:true,environmentValueVerified:true,verificationQueuedNoDeployment:true});
});

test('@mutation source compound restore refuses owned HTTP health failure and rolls back file, SQL, mailbox password, deleted RFC822 message and protected secret while preserving sibling HTTP',async({liveApi})=>{
 test.setTimeout(540000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId;
 const siblingTarget=await ensureStaticRemovalTarget(m);expect(siblingTarget?.websiteId).toBeTruthy();expect(siblingTarget.removed).not.toBe(true);expect(uploadedStatic).toBeTruthy();
 const siblingBefore=await uploadedStatic.http('/');expect(siblingBefore.status).toBe(200);expect(siblingBefore.body).toContain(m.runId);
 const saved=await ensureCompoundBackupFixture(liveApi,m),sec=secrets();
 const {repositoryId,snapshotId,markerName,marker,healthProbeName,sqlName,snapshotASqlProof,originalMessage}=saved;
 const sqlUrl='http://'+m.fixture.hostname+'/'+sqlName,envRoot='/api/panel/applications/'+m.fixture.applicationId+'/github-webhook';
 const stateBMarker='ROLLBACK-STATE-B-FILE-'+m.runId,stateBHealthBody='OWNED-STATE-B-HEALTH-200-'+m.runId;
 const stateBHealthSource='<?php http_response_code(200); header("Content-Type: text/plain"); echo '+JSON.stringify(stateBHealthBody)+';';
 await upload(liveApi,m,markerName,stateBMarker);await upload(liveApi,m,healthProbeName,stateBHealthSource);
 const markerBeforeRestore=await liveApi.api.get('http://'+m.fixture.hostname+'/'+markerName);expect(markerBeforeRestore.status()).toBe(200);const markerBeforeText=await markerBeforeRestore.text();expect(markerBeforeText).toBe(stateBMarker);expect(markerBeforeText).not.toBe(marker);
 const healthBeforeRestore=await liveApi.api.get('http://'+m.fixture.hostname+'/'+healthProbeName);expect(healthBeforeRestore.status()).toBe(200);expect(await healthBeforeRestore.text()).toBe(stateBHealthBody);
 const stateBSqlProof='ROLLBACK-B-SQL-'+sqlToken(m.runId)+'-'+randomBytes(6).toString('hex');expect(stateBSqlProof).not.toBe(snapshotASqlProof);
 const updatedSql=await liveApi.api.post(sqlUrl,{data:{value:stateBSqlProof}});expect(updatedSql.status()).toBe(200);expect((await updatedSql.json()).proof).toBe(stateBSqlProof);
 const sqlBeforeRestore=await liveApi.api.get(sqlUrl);expect(sqlBeforeRestore.status()).toBe(200);const sqlBeforeRow=await sqlBeforeRestore.json();expect(sqlBeforeRow.proof).toBe(stateBSqlProof);expect(sqlBeforeRow.proof).not.toBe(snapshotASqlProof);
 const snapshotAMessageInput={hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:'OWNED-NATIVE-'+m.runId};
 const presentSnapshotAMessage=await ownedImapMessage(snapshotAMessageInput);expect(presentSnapshotAMessage.count).toBe(1);expect(presentSnapshotAMessage.sha256).toBe(originalMessage.sha256);
 const deletedSnapshotAMessage=await ownedImapMessage({...snapshotAMessageInput,remove:true,expectedSha256:originalMessage.sha256});expect(deletedSnapshotAMessage.removed).toBe(true);expect(deletedSnapshotAMessage.remaining).toBe(0);
 expect((await ownedImapMessage(snapshotAMessageInput)).count).toBe(0);
 const stateBSubject='OWNED-ROLLBACK-B-'+m.runId;
 const deliveredStateB=check(await apiCall(liveApi.api,liveApi.csrf,'POST','/api/panel/mailboxes/'+m.fixture.mailboxIds[0]+'/test-delivery',{recipient:'beta@'+m.fixture.hostname,subject:stateBSubject}),'backup.rollback.mail-delivery');expect(deliveredStateB.delivered).toBe(true);
 let stateBMessage={count:0};
 for(let attempt=0;attempt<15&&stateBMessage.count===0;attempt++){stateBMessage=await ownedImapMessage({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta,subject:stateBSubject});if(stateBMessage.count===0)await new Promise(r=>setTimeout(r,500));}
 expect(stateBMessage.count).toBe(1);expect(stateBMessage.sha256).toMatch(/^[a-f0-9]{64}$/);expect(stateBMessage.sha256).not.toBe(originalMessage.sha256);expect(stateBMessage.bytes).toBeGreaterThan(0);
 sec.rollbackStateBPassword=randomBytes(30).toString('base64url');expect(sec.rollbackStateBPassword).not.toBe(sec.mailPasswords.beta);saveSecrets(sec);
 await nativeMailboxPassword(liveApi,m,sec.rollbackStateBPassword);
 expect(await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.rollbackStateBPassword,subject:stateBSubject})).toMatchObject({authenticated:true,received:true,messages:1});
 expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta})).authenticated).toBe(false);
 sec.rollbackEnvironmentB=randomBytes(32).toString('base64url');expect(sec.rollbackEnvironmentB).not.toBe(sec.environmentBefore);saveSecrets(sec);
 check(await apiCall(liveApi.api,liveApi.csrf,'PUT',envRoot,{secret:sec.rollbackEnvironmentB}),'backup.rollback.environment-state-b');
 const envStateBMeta=check(await apiCall(liveApi.api,liveApi.csrf,'GET',envRoot),'backup.rollback.environment-before');
 await verifyProtectedWebhookSecret(sec.rollbackEnvironmentB,202);await verifyProtectedWebhookSecret(sec.environmentBefore,401);
 const input={repositoryId,snapshotId,healthPath:'/'+healthProbeName,timeoutSeconds:5,include:['paths','databases','mail','environment']};
 const restorePreview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/restore/preview',input),'backup.rollback.restore-preview');
 const restoreOp=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/backup-operations',{kind:'restore',...input,expectedPreviewDigest:restorePreview.previewDigest,confirmation:restorePreview.confirmation}),'backup.rollback.restore-queue',202);
 const restoreJob=await waitJob(liveApi.api,restoreOp.jobId,360000);record('backup.rollback.job',{jobId:restoreJob.id,status:restoreJob.status,code:restoreJob.error?.code??null});expect(restoreJob.status).toBe('succeeded');
 const rolledBackOp=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/backup-operations/'+restoreOp.id),'backup.rollback.operation');
 expect(rolledBackOp.status).toBe('rolled_back');expect(rolledBackOp.result?.status).toBe('rolled_back');
 expect(rolledBackOp.result?.rollbackReason).toBe('health_check_failed');expect(rolledBackOp.result?.failurePhase).toBe('health_check');
 expect(rolledBackOp.preRestoreSnapshotId).toMatch(/^[a-f0-9]{64}$/i);expect(rolledBackOp.result?.preRestoreSnapshotId).toBe(rolledBackOp.preRestoreSnapshotId);expect(rolledBackOp.result?.preRestoreSnapshotId).not.toBe(snapshotId);
 expect(rolledBackOp.result?.healthCheck?.satisfied).toBe(false);expect(rolledBackOp.result?.healthCheck?.statusCode).toBe(503);
 const siblingFirstHttp=await uploadedStatic.http('/');const primaryFirstHttp=await primary.http('/');
 expect(siblingFirstHttp.status,'Static sibling first HTTP response after compound rollback must be 200 without retry').toBe(200);expect(siblingFirstHttp.body).toBe(siblingBefore.body);
 expect(primaryFirstHttp.status,'Primary site root first HTTP response after compound rollback must be 200 without retry').toBe(200);
 const markerAfterRollback=await liveApi.api.get('http://'+m.fixture.hostname+'/'+markerName);expect(markerAfterRollback.status()).toBe(200);const markerAfterText=await markerAfterRollback.text();expect(markerAfterText).toBe(stateBMarker);expect(markerAfterText).not.toBe(marker);
 const healthAfterRollback=await liveApi.api.get('http://'+m.fixture.hostname+'/'+healthProbeName);expect(healthAfterRollback.status()).toBe(200);expect(await healthAfterRollback.text()).toBe(stateBHealthBody);
 const sqlAfterRollback=await liveApi.api.get(sqlUrl);expect(sqlAfterRollback.status()).toBe(200);const sqlAfterRow=await sqlAfterRollback.json();expect(sqlAfterRow.proof).toBe(stateBSqlProof);expect(sqlAfterRow.proof).not.toBe(snapshotASqlProof);
 expect(await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.rollbackStateBPassword,subject:stateBSubject})).toMatchObject({authenticated:true,received:true,messages:1});
 expect((await imapReceipt({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.mailPasswords.beta})).authenticated).toBe(false);
 const deletedSnapshotAAfterRollback=await ownedImapMessage({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.rollbackStateBPassword,subject:'OWNED-NATIVE-'+m.runId});expect(deletedSnapshotAAfterRollback.count).toBe(0);
 const stateBMessageAfterRollback=await ownedImapMessage({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.rollbackStateBPassword,subject:stateBSubject});expect(stateBMessageAfterRollback.count).toBe(1);expect(stateBMessageAfterRollback.sha256).toBe(stateBMessage.sha256);expect(stateBMessageAfterRollback.bytes).toBe(stateBMessage.bytes);
 const cleanedStateBMessage=await ownedImapMessage({hostname:m.fixture.mailHostname,address:'beta@'+m.fixture.hostname,password:sec.rollbackStateBPassword,subject:stateBSubject,remove:true,expectedSha256:stateBMessage.sha256});expect(cleanedStateBMessage.removed).toBe(true);expect(cleanedStateBMessage.remaining).toBe(0);
 const envAfterRollback=check(await apiCall(liveApi.api,liveApi.csrf,'GET',envRoot),'backup.rollback.environment-after');expect(envAfterRollback).toEqual(envStateBMeta);
 await verifyProtectedWebhookSecret(sec.rollbackEnvironmentB,202);await verifyProtectedWebhookSecret(sec.environmentBefore,401);
 record('backup.compound-health-rollback-verified',{verified:true,snapshotId,preRestoreSnapshotId:rolledBackOp.result.preRestoreSnapshotId,restoreOperationId:restoreOp.id,rollbackReason:rolledBackOp.result.rollbackReason,failurePhase:rolledBackOp.result.failurePhase,healthStatusCode:rolledBackOp.result.healthCheck.statusCode,siblingFirstHttpStatus:siblingFirstHttp.status,siblingBodyPreserved:true,primaryFirstHttpStatus:primaryFirstHttp.status,fileStateBRestored:true,healthProbeStateBRestored:true,sqlStateBRestored:true,stateBMailboxAuthentication:true,snapshotAMailboxAuthenticationRejected:true,deletedSnapshotAMessageAbsent:true,stateBMessagePreserved:true,stateBMessageCleaned:true,environmentMetadataPreserved:true,environmentHmacStateBVerified:true,environmentHmacSnapshotARejected:true,verificationQueuedNoDeployment:true});
});

test('@mutation source WordPress plugin and theme lifecycle changes real inventory and keeps the actual site responding', async ({ liveApi, page }) => {
 test.setTimeout(360000); const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress';
 const initial=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.packages.initial');expect(initial.installed).toBe(true);
 const plugin='hello-dolly',previousTheme=initial.themes.find(item=>item.status==='active')?.name,theme=previousTheme==='twentytwentyone'?'twentytwentytwo':'twentytwentyone';const installJobs=[];
 expect(previousTheme).toBeTruthy();expect(previousTheme).not.toBe(theme);
 async function action(options){
  const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.package.preview');
  const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,
   previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'wordpress.package.queue',202);
  const job=await waitJob(liveApi.api,queued.job.id,180000);record('wordpress.package.native',{action:options.action,package:options.package,jobId:job.id,status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');if(options.action.endsWith('.install'))installJobs.push({action:options.action,jobId:job.id});
  const status=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.package.inventory');
  const response=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(response.status()).toBe(200);
  return status;
 }
 let current=initial;
 if(current.plugins.some(item=>item.name===plugin)){if(current.plugins.find(item=>item.name===plugin).status==='active')current=await action({action:'plugin.deactivate',package:plugin});expect(current.plugins.find(item=>item.name===plugin).status).toBe('inactive');current=await action({action:'plugin.remove',package:plugin});}expect(current.plugins.some(item=>item.name===plugin)).toBe(false);current=await action({action:'plugin.install',package:plugin});
 expect(current.plugins.some(item=>item.name===plugin)).toBe(true);
 current=await action({action:'plugin.activate',package:plugin});expect(current.plugins.find(item=>item.name===plugin)?.status).toBe('active');
 current=await action({action:'plugin.deactivate',package:plugin});expect(current.plugins.find(item=>item.name===plugin)?.status).toBe('inactive');
 current=await action({action:'plugin.remove',package:plugin});expect(current.plugins.some(item=>item.name===plugin)).toBe(false);
 if(current.themes.some(item=>item.name===theme)){expect(current.themes.find(item=>item.name===theme).status).toBe('inactive');current=await action({action:'theme.remove',package:theme});}expect(current.themes.some(item=>item.name===theme)).toBe(false);current=await action({action:'theme.install',package:theme});expect(current.themes.some(item=>item.name===theme)).toBe(true);
 current=await action({action:'theme.activate',package:theme});expect(current.themes.find(item=>item.name===theme)?.status).toBe('active');
 const themed=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(await themed.text()).toContain('/themes/'+theme+'/');
 current=await action({action:'theme.activate',package:previousTheme});expect(current.themes.find(item=>item.name===previousTheme)?.status).toBe('active');
 current=await action({action:'theme.remove',package:theme});expect(current.themes.some(item=>item.name===theme)).toBe(false);
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');await expect(main(page).getByRole('heading',{name:'WordPress',exact:true})).toBeVisible();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(installJobs.map(item=>item.action).sort()).toEqual(['plugin.install','theme.install']);expect(new Set(installJobs.map(item=>item.jobId)).size).toBe(2);record('wordpress.package-install-jobs',{jobs:installJobs});record('wordpress.package-lifecycle',{verified:true,pluginRemoved:true,themeRemoved:true,previousThemeRestored:true});
});

test('@mutation source WordPress refuses CLI success when a plugin breaks actual HTTP and verifies the real backup rollback', async ({ liveApi }) => {
 test.setTimeout(240000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress';
 const slug='yp-owned-health-failure',pluginPath='wp-content/plugins/'+slug+'.php';
 await upload(liveApi,m,pluginPath,'<?php\n/* Plugin Name: YunPanel owned health verification */\nif (!defined("WP_CLI") || !WP_CLI) { http_response_code(503); exit("Owned health verification"); }\n');
 try {
  const before=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.failure.before');
  expect(before.plugins.some(item=>item.name===slug)).toBe(true);
  const options={action:'plugin.activate',package:slug};
  const preview=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/preview',{options}),'wordpress.failure.preview');
  const queued=check(await apiCall(liveApi.api,liveApi.csrf,'POST',root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,
   previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'wordpress.failure.queue',202);
  const job=await waitJob(liveApi.api,queued.job.id,180000);record('wordpress.real-http-failure',{status:job.status,code:job.error?.code});
  expect(job.status).toBe('failed');expect(job.error?.code).toBe('wordpress_http_health_failed');
  const actual=await liveApi.api.get('http://'+m.fixture.hostname+'/');expect(actual.status()).toBe(200);expect(await actual.text()).not.toBe('Owned health verification');
  const after=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.failure.after');expect(after.plugins.find(item=>item.name===slug)?.status).toBe('inactive');
  record('wordpress.real-http-rollback',{verified:true,pluginInactive:true});
 } finally {await remove(liveApi,m,pluginPath);}
});

test('@mutation source WordPress core update changes 7.1.3 to 7.1.4 through the current worker and preserves SQL content and administrator login', async ({liveApi,browser})=>{
 test.setTimeout(240000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',options={action:'core.update'};
 expect(m.fixture.binding?.id,'The fresh owned installation must use its actual dedicated DB').toBeTruthy();
 const tool=async(label,args,command='core')=>{const r=await phase2Post(liveApi,'/api/panel/websites/'+m.fixture.websiteId+'/wp-cli/run',{command,args,timeout:120000},label,200,value=>expect(typeof value.success==='boolean'&&Number.isSafeInteger(value.exitCode)&&typeof value.stdout==='string').toBe(true));expect(r.success).toBe(true);expect(r.exitCode).toBe(0);return r;};
 const sql=async phase=>{const r=await tool('wordpress.core.sql-'+phase,['query','SELECT value FROM yp_native_proof WHERE id=1','--skip-column-names','--skip-plugins','--skip-themes','--skip-packages'],'db');expect(Boolean(r.stdout.trim())).toBe(true);return createHash('sha256').update(r.stdout.trim()).digest('hex');};
 const sqlBefore=await sql('before');
 const latest=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'wordpress.core.preparation-before');expect(latest.installed).toBe(true);expect(latest.coreVersion).toBe('7.1.4');
 await tool('wordpress.core.older-owned-preparation',['download','--version=7.1.3','--force','--skip-content','--locale=tr_TR']);
 await tool('wordpress.core.older-checksums',['verify-checksums','--version=7.1.3','--locale=tr_TR','--skip-plugins','--skip-themes','--skip-packages']);
 const before=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'wordpress.core.before');expect(before.installed).toBe(true);expect(before.coreVersion).toBe('7.1.3');expect(await sql('prepared')).toBe(sqlBefore);
 const preparedReply=await primary.http('/');expect(preparedReply.status,'The first actual older installation HTTP reply must work').toBe(200);
 await browserLogin(browser,before,'t886_admin',secrets().wpAdminPassword,'before-core-upgrade');
 const preview=await phase2Post(liveApi,root+'/preview',{options},'wordpress.core.preview');const intent=phase2JobIntent(preview,'wp.toolkit',options);
 const queued=await phase2Post(liveApi,root+'/actions',{options,requestId:randomUUID(),expectedWebsiteRevision:preview.websiteRevision,previewDigest:preview.previewDigest,confirmation:preview.confirmation},'wordpress.core.queue',202);
 const job=await phase2Job(liveApi,queued.job,intent,180000);record('wordpress.core.native',{status:job.status,code:job.error?.code});expect(job.status).toBe('succeeded');
 const after=check(await phase2Read(liveApi.api,liveApi.csrf,'GET',root),'wordpress.core.after');expect(after.installed).toBe(true);expect(after.coreVersion).toBe('7.1.4');expect(after.coreVersion).not.toBe(before.coreVersion);expect(await sql('after')).toBe(sqlBefore);
 const actual=await primary.http('/');expect(actual.status,'The first upgraded installation HTTP reply must work').toBe(200);
 await tool('wordpress.core.actual-checksums',['verify-checksums','--version=7.1.4','--locale=tr_TR','--skip-plugins','--skip-themes','--skip-packages']);
 await browserLogin(browser,after,'t886_admin',secrets().wpAdminPassword,'after-core-upgrade');
 record('wordpress.core.result',{verified:true,beforeVersion:before.coreVersion,afterVersion:after.coreVersion,versionChanged:true,sqlSha256:sqlBefore,freshAdminVerified:true});
});

test('@mutation source WordPress removal removes actual core files and prefix tables, preserves other content, then restores the owned installation', async ({ liveApi }) => {
 test.setTimeout(420000);
 const m = owned(), websiteRoot = '/api/panel/websites/' + m.fixture.websiteId, root = websiteRoot + '/wordpress';
 const saved = await ensureWordPressRemovalSnapshot(liveApi,m);
 expect(saved?.snapshotId).toBeTruthy();
 const connection = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/servers/' + m.serverId + '/websites/' + m.fixture.websiteId + '/databases/' + m.fixture.binding.id + '/connection', { revealPassword: true }), 'wordpress.remove.connection');
 const probe = 'native-wp-remove-proof-' + m.runId + '.php';
 const source = '<?php header("Content-Type: application/json");mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);$db=new mysqli(' + [connection.host, connection.username, connection.password, connection.databaseName].map(value => JSON.stringify(value)).join(',') + ');$tables=[];$r=$db->query("SHOW TABLES");while($row=$r->fetch_row()){$tables[]=$row[0];}$proof=$db->query("SELECT value FROM yp_native_proof WHERE id=1")->fetch_assoc();echo json_encode(["wpTables"=>array_values(array_filter($tables,fn($name)=>str_starts_with($name,"' + ('yp' + m.fixture.websiteId.replaceAll('-', '').slice(0, 12) + '_') + '"))),"otherProof"=>$proof["value"]]);';
 let queued = false;
 try {
 await upload(liveApi, m, probe, source);
 const url = 'http://' + m.fixture.hostname + '/' + probe;
 const beforeResponse = await liveApi.api.get(url); expect(beforeResponse.status()).toBe(200);
 const before = await beforeResponse.json(); expect(before.wpTables.length).toBeGreaterThan(8);
  const options = { action: 'remove' };
  const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/preview', { options }), 'wordpress.remove.preview');
  const result = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/actions', { options, requestId: randomUUID(), expectedWebsiteRevision: preview.websiteRevision, previewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'wordpress.remove.queue', 202);
  queued = true;
  const job = await waitJob(liveApi.api, result.job.id, 120000);
  record('wordpress.remove.native', { status: job.status, code: job.error?.code });
  expect(job.status).toBe('succeeded');
  const afterResponse = await liveApi.api.get(url); expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json(); expect(after.wpTables).toEqual([]); expect(after.otherProof).toBe(before.otherProof);
  const files = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + m.fixture.websiteId + '/files'), 'wordpress.remove.files');
  const names = (files.entries ?? files.files ?? []).map(entry => entry.name);
  for (const name of ['wp-config.php', 'wp-load.php', 'wp-admin', 'wp-includes', 'wp-content']) expect(names).not.toContain(name);
  expect(names).toContain(probe);
  record('wordpress.remove.physical-content', { verified: true, prefixTablesRemoved: true, unrelatedContentPreserved: true });
 } finally {
  if (queued) {
   const input = { repositoryId: saved.repositoryId, snapshotId: saved.snapshotId, healthPath: '/', timeoutSeconds: 30, include: ['paths', 'databases'] };
   const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', websiteRoot + '/restore/preview', input), 'wordpress.remove.restore-preview');
   const operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', websiteRoot + '/backup-operations', { kind: 'restore', ...input, expectedPreviewDigest: preview.previewDigest, confirmation: preview.confirmation }), 'wordpress.remove.restore-queue', 202);
   await finishedBackup(liveApi, websiteRoot, operation);
   const status = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root), 'wordpress.remove.restored'); expect(status.installed).toBe(true);
   const actual = await liveApi.api.get('http://' + m.fixture.hostname + '/'); expect(actual.status()).toBe(200);
   record('wordpress.remove.restored-installation', { verified: true });
  }
  const remainingProbe=await apiCall(liveApi.api,liveApi.csrf,'GET',websiteRoot+'/files/text?path='+probe);
  expect([200,404],'The exact owned probe must be readable or already absent').toContain(remainingProbe.status);
  if(remainingProbe.status===200)await remove(liveApi,m,probe);
  const absent=await apiCall(liveApi.api,liveApi.csrf,'GET',websiteRoot+'/files/text?path='+probe);expect(absent.status).toBe(404);
 }
});


test('@mutation source WordPress administrator authenticates in a fresh browser after Turkish installation',async({liveApi,browser})=>{
 test.setTimeout(180000);const m=owned(),sec=secrets();const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.websiteId+'/wordpress'),'wordpress.login.installed');expect(installed.installed).toBe(true);await browserLogin(browser,installed,'t886_admin',sec.wpAdminPassword);record('wordpress.real-browser-login',{verified:true});
});

test('@mutation source WordPress administrator password rotates through the UI and authenticates in a fresh browser',async({liveApi,page,browser})=>{
 test.setTimeout(180000);const m=owned(),root='/api/panel/websites/'+m.fixture.websiteId+'/wordpress',sec=secrets(),username='t886_admin';const installed=check(await apiCall(liveApi.api,liveApi.csrf,'GET',root),'wordpress.password.installed');expect(installed.installed).toBe(true);
 await ready(page,'/websites/'+m.fixture.domainId+'/wordpress');await main(page).getByRole('button',{name:'Yönetici parolası',exact:true}).click();const d=page.getByRole('dialog');await expect(d).toBeVisible();const next=randomBytes(30).toString('base64url')+'!aA7';sec.pendingWpPassword=next;saveSecrets(sec);await d.getByLabel('Yeni parola',{exact:true}).fill(next);
 const passwordJob=page.waitForResponse(r=>new URL(r.url()).pathname===root+'/actions'&&r.request().method()==='POST');await d.getByRole('button',{name:'Yönetici parolasını değiştir',exact:true}).click();const changed=await passwordJob;const result=await changed.json().catch(()=>({}));const requestId=changed.request().postDataJSON()?.requestId;m.fixture.wpPasswordRequestId=requestId;saveManifest(m);record('wordpress.password.queue',{status:changed.status(),code:result.error?.code??null,requestId});if(changed.status()!==202){const existing=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/requests/'+requestId);record('wordpress.password.queue-readback',{status:existing.status,code:existing.body.error?.code??null,jobStatus:existing.data?.status??null});}expect(changed.status(),'WordPress password queue '+(result.error?.code??'unknown')).toBe(202);expect((await waitJob(liveApi.api,result.data.job.id)).status).toBe('succeeded');await expect(d).toBeHidden();
 sec.wpAdminPassword=next;delete sec.pendingWpPassword;saveSecrets(sec);const loginHttp=await primary.http('/wp-login.php');record('wordpress.password.login-http',{status:loginHttp.status,formPresent:/id=["']loginform["']/.test(loginHttp.body)});expect(loginHttp.status,'Actual login HTTP after password change').toBe(200);expect(loginHttp.body).toMatch(/id=["']loginform["']/);await browserLogin(browser,installed,username,next,'rotated');record('wordpress.rotated-browser-login',{verified:true,independentBrowserContext:true});
});


async function ensureStaticRemovalTarget(m){
 if(m.fixture.extraStatic)return m.fixture.extraStatic;
 // A selected removal run prepares an independent API fixture. It cannot satisfy the UI-create gate.
 uploadedStatic=await createOwnedFixture(owner,{key:staticKey,runtime:'static'});
 const target=uploadedStatic.ledger,marker='T886-STATIC-REMOVAL-PREREQUISITE-'+m.runId;
 const site=check(await apiCall(owner.api,owner.csrf,'GET',uploadedStatic.endpoint()),'static.remove.prerequisite-site');expect(site.runtimeType).toBe('static');
 await uploadedStatic.upload('index.html',marker);const actual=await uploadedStatic.http('/');expect(actual.status).toBe(200);expect(actual.body).toBe(marker);
 const physical=readOnlyHostProbe(uploadedStatic,'owned-site-files');expect(physical.unixUserExists).toBe(true);expect(physical.uid).toBeGreaterThan(0);
 m.fixture.extraStatic={...target};m.fixture.createdWebsiteIds.push(target.websiteId);m.fixture.createdDomainIds.push(target.domainId);saveManifest(m);
 record('static.remove.api-prerequisite-only',{websiteId:target.websiteId,actualHttp:true,siteUid:physical.uid,uiCreateVerified:false});return m.fixture.extraStatic;
}
test('@mutation source uploaded static Website removal completes its real lifecycle and preserves the PHP sibling', async ({ liveApi }) => {
 test.setTimeout(420000); const m = owned(), target = await ensureStaticRemovalTarget(m);
 expect(target?.websiteId).toBeTruthy(); expect(target.removed).not.toBe(true);
 expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);
 const beforeNginx=readOnlyHostProbe(primary,'nginx-config');expect(beforeNginx.exists).toBe(true);expect(beforeNginx.sha256).toMatch(/^[a-f0-9]{64}$/);const beforeHttp=await primary.http('/');record('static.remove.sibling-before',{status:beforeHttp.status,nginxSha256:beforeNginx.sha256});expect(beforeHttp.status).toBe(200);
 const root = '/api/panel/websites/' + target.websiteId;
 const before = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root), 'static.remove.website');
 expect(before.runtimeType).toBe('static');
 let operation;
 if (target.removalOperationId) {
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/website-removal-operations/' + target.removalOperationId), 'static.remove.resume');
 } else {
  const preview = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', root + '/removal'), 'static.remove.preview').preview;
  expect(preview.readyToStart).toBe(true);
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', root + '/removal', {
   previewDigest: preview.previewDigest, confirmation: preview.confirmation,
  }), 'static.remove.start', 201);
 }
 const saved = manifest(); saved.fixture.extraStatic.removalOperationId = operation.id;
 saved.fixture.extraStatic.removalPhysicalScope = { applicationId: before.applicationId, unixUser: before.unixUser,
  documentRoot: before.documentRoot, hostname: target.hostname }; saveManifest(saved);
 for (let attempt = 0; attempt < 80 && operation.status !== 'removed'; attempt++) {
  if (operation.execution?.mode === 'automatic') {
   await new Promise(resolve => setTimeout(resolve, 650));
   operation = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/website-removal-operations/' + operation.id), 'static.remove.server-worker');
   expect(['failed', 'blocked']).not.toContain(operation.status);continue;
  }
  const step = nextRemovalStep(operation); expect(step).toBeTruthy();
  operation = check(await apiCall(liveApi.api, liveApi.csrf, 'POST', '/api/panel/website-removal-operations/' + operation.id + '/continue', {
   expectedUpdatedAt: operation.updatedAt, stepId: step.stepId, confirmation: step.confirmation,
  }), 'static.remove.continue');
  record('static.remove.step', { operationId: operation.id, stepId: step.stepId, status: operation.status,
   code: operation.lastError?.code ?? operation.error?.code });
  expect(['failed', 'blocked']).not.toContain(operation.status);
  if (operation.status !== 'removed') await new Promise(resolve => setTimeout(resolve, 650));
 }
 expect(operation.status).toBe('removed');
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', root)).status).toBe(404);
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/domains/' + target.domainId)).status).toBe(404);
 expect((await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/applications/' + target.applicationId)).status).toBe(404);
 const sibling = check(await apiCall(liveApi.api, liveApi.csrf, 'GET', '/api/panel/websites/' + m.fixture.websiteId + '/wordpress'), 'static.remove.php-sibling');
 expect(sibling.installed).toBe(true);
 const siblingHttp=await liveApi.api.get('http://'+m.fixture.hostname+'/');const direct=await primary.http('/');const afterNginx=readOnlyHostProbe(primary,'nginx-config');record('static.remove.sibling-after',{status:siblingHttp.status(),directStatus:direct.status,nginxSha256:afterNginx.sha256});if(siblingHttp.status()!==200||direct.status!==200){const physical=readOnlyHostProbe(primary,'owned-site-files');record('static.remove.sibling-runtime',{uid:physical.uid,unixUserExists:physical.unixUserExists,fpmFiles:physical.fpmFiles,sockets:physical.sockets});await new Promise(r=>setTimeout(r,1000));const followup=await primary.http('/');record('static.remove.sibling-followup',{status:followup.status});}expect(siblingHttp.status(),'Deleting the static site must preserve the PHP sibling immediately').toBe(200);expect(direct.status).toBe(200);expect(afterNginx.sha256).toBe(beforeNginx.sha256);
 const result = manifest(); result.fixture.extraStatic.removed = true; saveManifest(result);await uploadedStatic.cleanup();const physical=readOnlyHostProbe(uploadedStatic,'lifecycle-absence');expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);expect(physical.roots.length).toBeGreaterThanOrEqual(4);expect(physical.roots.every(v=>!v.exists)).toBe(true);expect(physical.mounts).toEqual([]);expect(physical.fpmFiles).toEqual([]);expect(physical.sockets).toEqual([]);expect(physical.nginxFiles.every(v=>!v.exists)).toBe(true);
 record('static.remove.catalog-and-sibling', { verified: true, websiteId: target.websiteId,
  physicalAbsenceVerified: true });
});
