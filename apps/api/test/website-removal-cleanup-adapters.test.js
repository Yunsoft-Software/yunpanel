import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalCleanupAdapters } from '../src/websites/website-removal-cleanup-adapters.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServerRegistry } from '../src/runtime/server-registry.js';
import { createApplicationRegistry } from '../src/applications/application-registry.js';
import { createWebsiteRegistry } from '../src/websites/website-registry.js';
import { createApplicationEnvironmentRegistry } from '../src/applications/application-environment-registry.js';
import { createWebsiteProvisioningRuntime } from '../src/provisioning/website-provisioning-runtime.js';
import { createWebsiteRemovalOperationRegistry } from '../src/websites/website-removal-operation-registry.js';
import { createWebsitePassengerEnvironmentManager } from '@yunpanel/host-runtime/website-passenger-environment-manager';
import { createDomainRegistry } from '../src/domains/domain-registry.js';
import { createSiteMutationLock } from '../src/websites/site-mutation-lock.js';
import { withPassengerEnvironmentRetirementScope } from '../src/websites/website-removal-runtime.js';
import { createWebsitePassengerApplicationReleaseProvisioningHandler } from '../src/provisioning/website-passenger-application-release-provisioning-handler.js';

const websiteId='11111111-1111-4111-8111-111111111111';
const applicationId='22222222-2222-4222-8222-222222222222';
const systemUser='yunapp-123456789abc';
function fixture({otherWebsite=false,symlink=false,failRetirement=false,foreignPool=false,elfinderState='succeeded',elfinderRetireThrowsWithoutReceipt=false,php=false,phpConfig,failPhp=false,missingPhpJournal=false,phpState='succeeded',failSftp=false,withSftpJournal=false,sftpState='succeeded',sftpRetireThrowsWithoutReceipt=false,unixState='succeeded',unixReceipt=true,unixHostAccount=false,unixInspectThrows=false}={}) {
  const removed=[]; const removedSet=new Set(); const compensated=[];
  const retirementCalls=[]; const order=[];
  const phpCalls=[];
  const unixCompensation=()=>unixReceipt?{satisfied:true,removedUser:true,removedGroup:true}:{satisfied:true,removedUser:false,preservedUnownedState:true};
  const retirement = { satisfied:true,poolRemoved:true,socketRemoved:true,websiteId,applicationId,unixUser:systemUser };
  const adapters=createWebsiteRemovalCleanupAdapters({
    websiteRegistry:{
      getWebsite:async()=>({id:websiteId,serverId:'33333333-3333-4333-8333-333333333333',applicationId,unixUser:systemUser,phpConfig}),
      listWebsites:async()=>[{id:websiteId,applicationId},...(otherWebsite?[{id:'44444444-4444-4444-8444-444444444444',applicationId}]:[])],
    },
    applicationRegistry:{getApplication:async()=>({id:applicationId,type:php?'php':'static',serverId:'33333333-3333-4333-8333-333333333333'})},
    websiteProvisioningRuntime:{
      registry:{listForWebsite:async()=>[{operationId:'55555555-5555-4555-8555-555555555555',steps:[{
        kind:'unix_identity',state:unixState,intent:{websiteId,applicationId,unixUser:systemUser,homeDirectory:'/var/lib/yunpanel/data/'+applicationId},evidence:unixState==='succeeded'?{owned:true}:null,
      }, {kind:'elfinder',state:elfinderState,intent:{adapter:'elfinder-fpm',websiteId:foreignPool?'44444444-4444-4444-8444-444444444444':websiteId,applicationId,unixUser:systemUser}},
      ...(php&&!missingPhpJournal?[{kind:'php_runtime',state:phpState,intent:{adapter:'php-fpm',websiteId,applicationId,unixUser:systemUser,documentRoot:'/var/lib/yunpanel/apps/'+applicationId+'/current/public'}}]:[]),
      ...(withSftpJournal?[{kind:'sftp',state:sftpState,intent:{adapter:'openssh-internal-sftp',websiteId,applicationId,unixUser:systemUser}}]:[])]}]},
      handlers:{elfinder:{
        retire:async(ctx)=>{order.push('elfinder');retirementCalls.push(ctx);if(elfinderRetireThrowsWithoutReceipt||failRetirement)throw new Error('fixture pool retained');return retirement;},
        inspectRetirement:async()=>retirement,
      },sftp:{
        retire:async()=>{order.push('sftp');if(sftpRetireThrowsWithoutReceipt||failSftp)throw new Error('fixture mount retained or receipt missing');},
        inspectRetirement:async()=>({satisfied:!failSftp,sshdConfigRemoved:true,mountUnitRemoved:true,chrootRemoved:true,websiteId,applicationId,unixUser:systemUser}),
      },php_runtime:{
        retire:async(ctx)=>{order.push('php');phpCalls.push(ctx);if(failPhp)throw new Error('fixture PHP pool retained');return retirement;},
        inspectRetirement:async()=>retirement,
      },unix_identity:{
        compensate:async(ctx)=>{order.push('unix');compensated.push(ctx);return unixCompensation();},
        inspectCompensation:async()=>unixCompensation(),
        inspect:async()=>{if(unixInspectThrows)throw new Error('fixture host unreadable');return unixHostAccount?{satisfied:true,uid:2001,gid:2001}:{satisfied:false,reason:'website_identity_user_missing'};},
      }},
    },
    lstatFn:async(path)=>{
      if(removedSet.has(path)) throw Object.assign(new Error('missing'),{code:'ENOENT'});
      return {isSymbolicLink:()=>symlink,isDirectory:()=>!symlink};
    },
    rmFn:async(path)=>{order.push('files');removed.push(path);removedSet.add(path);},
  });
  return {adapters,removed,compensated,retirementCalls,phpCalls,order};
}

test('PHP removal preserves the original ownership intent and separately passes registered current settings',async()=>{
 const phpConfig={phpVersion:'8.4',maxChildren:9,memoryLimitMb:512,maxExecutionSeconds:60};
 const f=fixture({php:true,phpConfig});
 await f.adapters.fileCleanupHandler({websiteId,applicationId});
 await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
 assert.equal(f.phpCalls.length,2);
 for(const ctx of f.phpCalls){
   assert.equal(ctx.intent.phpVersion,undefined);
   assert.equal(ctx.operationId,'55555555-5555-4555-8555-555555555555');
   assert.deepEqual(ctx.currentIntent,{...ctx.intent,...phpConfig});
 }
});

test('PHP retirement precedes file deletion and repeats before Unix identity cleanup',async()=>{
 const f=fixture({php:true});
 await f.adapters.fileCleanupHandler({websiteId,applicationId});
 assert.deepEqual(f.order.slice(0,3),['php','elfinder','files']);
 // Four canonical Application roots plus this Website's backup resource folder (T971).
 assert.equal(f.removed.length,5);
 f.order.length=0;
 await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
 assert.deepEqual(f.order,['php','elfinder','unix']);
});

test('a surviving SFTP mount prevents canonical file and Unix cleanup even without a retained journal',async()=>{
 const f=fixture({failSftp:true});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_sftp_unverified');
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),e=>e.code==='website_cleanup_sftp_unverified');
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);assert.equal(f.retirementCalls.length,0);
});

test('receipt-owned SFTP retirement precedes PHP, files and Unix deletion',async()=>{
 const f=fixture({php:true,withSftpJournal:true});await f.adapters.fileCleanupHandler({websiteId,applicationId});
 assert.deepEqual(f.order.slice(0,4),['sftp','php','elfinder','files']);
 f.order.length=0;await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
 assert.deepEqual(f.order,['sftp','php','elfinder','unix']);
});

test('pending or compensated SFTP, elFinder and PHP provisioning steps verify host absence without requiring an apply receipt',async()=>{
 for(const sftpState of ['pending','compensated','failed','blocked']){
  const f=fixture({elfinderState:sftpState,elfinderRetireThrowsWithoutReceipt:true,php:true,phpState:'pending',withSftpJournal:true,sftpState,sftpRetireThrowsWithoutReceipt:true});
  await f.adapters.fileCleanupHandler({websiteId,applicationId});
  assert.equal(f.removed.length,5);
  await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
  assert.equal(f.compensated.length,1);
 }
});

test('unverified PHP retirement preserves files, file manager and Unix identity',async()=>{
 const f=fixture({php:true,failPhp:true});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_php_unverified');
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),e=>e.code==='website_cleanup_php_unverified');
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);assert.equal(f.retirementCalls.length,0);
});

test('PHP Application without its provisioning journal cannot delete files',async()=>{
 const f=fixture({php:true,missingPhpJournal:true});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_php_evidence_invalid');
 assert.equal(f.removed.length,0);assert.equal(f.retirementCalls.length,0);
});
test('file cleanup touches only canonical Application direct-child roots and this Website backup resource folder, keeping Restic backups out of scope',async()=>{
 const f=fixture();
 const result=await f.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:['backup-a']});
 assert.deepEqual(f.removed.sort(),[
  '/var/lib/yunpanel/apps/'+applicationId,
  '/var/lib/yunpanel/backups/resources/website/'+websiteId,
  '/var/lib/yunpanel/build/'+applicationId,
  '/var/lib/yunpanel/data/'+applicationId,
  '/var/www/yunpanel/apps/'+applicationId,
 ].sort());
 assert.deepEqual(f.removed.filter((path)=>path.includes('/backups/')),['/var/lib/yunpanel/backups/resources/website/'+websiteId]);
 assert.deepEqual(result.retainedBackups,['backup-a']);
});
test('file cleanup rejects a shared Application or symlink root before recursive deletion',async()=>{
 const shared=fixture({otherWebsite:true});await assert.rejects(()=>shared.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:[]}),(e)=>e.code==='website_cleanup_application_shared');assert.equal(shared.removed.length,0);
 const linked=fixture({symlink:true});await assert.rejects(()=>linked.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:[]}),(e)=>e.code==='website_cleanup_path_unsafe');assert.equal(linked.removed.length,0);
});
test('Unix cleanup requires exact provisioning journal identity and verifies compensation',async()=>{
 const f=fixture();const value=await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
 assert.deepEqual(value,{websiteId,systemUser,unixIdentityCleaned:true});assert.equal(f.compensated.length,1);
 assert.equal(f.compensated[0].operationId,'55555555-5555-4555-8555-555555555555');
  assert.equal(f.retirementCalls.length,1);
  assert.equal(f.retirementCalls[0].intent.websiteId,websiteId);
});

test('file manager retirement failure prevents file and Unix identity deletion',async()=>{
 const f=fixture({failRetirement:true});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_elfinder_unverified');
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),e=>e.code==='website_cleanup_elfinder_unverified');
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);
});

test('a foreign file manager journal is rejected before any cleanup',async()=>{
 const f=fixture({foreignPool:true});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_elfinder_evidence_invalid');
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);assert.equal(f.retirementCalls.length,0);
});

test('file cleanup is idempotent when canonical roots are already absent',async()=>{
 const f=fixture();
 await f.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:[]});
 const first=f.removed.length;
 await f.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:[]});
 assert.equal(f.removed.length,first);
});

test('file cleanup preflight returns canonical direct-child roots without recursion', async()=>{
 const f=fixture();
 const value=await f.adapters.inspectFileCleanup({websiteId,applicationId});
 assert.deepEqual([...value.targets].sort(),[
  '/var/lib/yunpanel/apps/'+applicationId,
  '/var/lib/yunpanel/build/'+applicationId,
  '/var/lib/yunpanel/data/'+applicationId,
  '/var/www/yunpanel/apps/'+applicationId,
 ].sort());
 assert.equal(f.removed.length,0);
});


function directSystemdAdapterFixture({ receipt = true, applicationChanges = {} } = {}) {
  const serverId = '33333333-3333-4333-8333-333333333333';
  const releaseId = '55555555-5555-4555-8555-555555555555';
  const serviceName = 'yunpanel-node-aaaaaaaaaaaaaaaa.service';
  const commitSha = 'b'.repeat(40);
  const hostCalls = [];
  const application = {
    id: applicationId,
    serverId,
    type: 'node',
    runtimeAdapter: 'direct-systemd',
    desiredRevision: 4,
    currentReleaseId: releaseId,
    serviceName,
    currentCommitSha: commitSha,
    servicePort: 3100,
    healthPath: '/health',
    ...applicationChanges,
  };
  const nodeServiceRemovalManager = {
    inspectRemoval: async (input) => {
      hostCalls.push({ type: 'inspect', input });
      return { ready: true, ...input, serviceName: input.serviceName ?? serviceName };
    },
    removeService: async (input) => {
      hostCalls.push({ type: 'remove', input });
      return { ...input, serviceName: input.serviceName ?? serviceName, directSystemdCleaned: true };
    },
  };
  const adapters = createWebsiteRemovalCleanupAdapters({
    websiteRegistry: {
      getWebsite: async () => ({ id: websiteId, serverId, applicationId, unixUser: systemUser }),
      listWebsites: async () => [{ id: websiteId, applicationId }],
    },
    applicationRegistry: { getApplication: async () => application },
    websiteProvisioningRuntime: {
      registry: { listForWebsite: async () => [] },
      handlers: { unix_identity: {
        compensate: async () => ({ satisfied: true, removedUser: true, removedGroup: true }),
        inspectCompensation: async () => ({ satisfied: true, removedUser: true, removedGroup: true }),
      } },
    },
    nodeServiceRemovalManager,
    nodeDeploymentReceiptStore: {
      read: async () => receipt ? {
        version: 1,
        serverId,
        jobId: releaseId,
        applicationId,
        releaseId,
        previousReleaseId: null,
        commitSha,
        serviceName,
        port: 3100,
        healthPath: '/health',
      } : null,
    },
    lstatFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    rmFn: async () => {},
  });
  const input = {
    websiteId,
    applicationId,
    serverId,
    releaseId,
    serviceName,
    currentCommitSha: commitSha,
    servicePort: 3100,
    healthPath: '/health',
  };
  return { adapters, hostCalls, input };
}

test('direct-systemd cleanup requires matching deployment receipt and verified host result', async () => {
  const f = directSystemdAdapterFixture();
  const preflight = await f.adapters.inspectDirectSystemdCleanup(f.input);
  assert.equal(preflight.ready, true);
  const result = await f.adapters.directSystemdCleanupHandler(f.input);
  assert.equal(result.directSystemdCleaned, true);
  assert.equal(result.applicationId, applicationId);
  assert.equal(f.hostCalls.filter((entry) => entry.type === 'remove').length, 1);
});

test('direct-systemd cleanup fails closed before host mutation when receipt is missing or state drifted', async () => {
  const missing = directSystemdAdapterFixture({ receipt: false });
  await assert.rejects(
    missing.adapters.inspectDirectSystemdCleanup(missing.input),
    (error) => error.code === 'website_cleanup_direct_systemd_evidence_unavailable',
  );
  assert.equal(missing.hostCalls.some((entry) => entry.type === 'remove'), false);

  const drifted = directSystemdAdapterFixture({ applicationChanges: { currentReleaseId: '66666666-6666-4666-8666-666666666666' } });
  await assert.rejects(
    drifted.adapters.directSystemdCleanupHandler(drifted.input),
    (error) => error.code === 'website_cleanup_direct_systemd_drift',
  );
  assert.equal(drifted.hostCalls.some((entry) => entry.type === 'remove'), false);
});

test('a site whose Unix identity never ran is removable once the host confirms no account exists',async()=>{
 for(const unixState of ['pending','failed','blocked']){
  const f=fixture({unixState,unixReceipt:false,elfinderState:'pending'});
  assert.equal((await f.adapters.inspectUnixIdentityCleanup({websiteId,systemUser})).ready,true);
  assert.equal((await f.adapters.inspectFileCleanup({websiteId,applicationId})).ready,true);
  await f.adapters.fileCleanupHandler({websiteId,applicationId});
  assert.deepEqual(await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),{websiteId,systemUser,unixIdentityCleaned:true});
  assert.equal(f.compensated.length,0,'nothing was created, so nothing is compensated');
 }
});

test('an account with the site user name but no ownership receipt blocks removal',async()=>{
 const f=fixture({unixState:'pending',unixReceipt:false,unixHostAccount:true,elfinderState:'pending'});
 const blocked=e=>e.code==='website_cleanup_identity_unowned_account';
 await assert.rejects(()=>f.adapters.inspectUnixIdentityCleanup({websiteId,systemUser}),blocked);
 await assert.rejects(()=>f.adapters.inspectFileCleanup({websiteId,applicationId}),blocked);
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),blocked);
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),blocked);
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);
});

test('a host that cannot be read keeps removal blocked instead of assuming the account is absent',async()=>{
 const f=fixture({unixState:'pending',unixReceipt:false,unixInspectThrows:true,elfinderState:'pending'});
 await assert.rejects(()=>f.adapters.fileCleanupHandler({websiteId,applicationId}),e=>e.code==='website_cleanup_identity_evidence_unavailable');
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),e=>e.code==='website_cleanup_identity_evidence_unavailable');
 assert.equal(f.removed.length,0);assert.equal(f.compensated.length,0);
});

test('an interrupted identity step with a receipt still compensates what it created',async()=>{
 const f=fixture({unixState:'pending',unixReceipt:true,elfinderState:'pending'});
 await f.adapters.unixIdentityCleanupHandler({websiteId,systemUser});
 assert.equal(f.compensated.length,1);
});

test('a provisioning step in an unknown state stays blocked',async()=>{
 const f=fixture({unixState:'running'});
 await assert.rejects(()=>f.adapters.unixIdentityCleanupHandler({websiteId,systemUser}),e=>e.code==='website_cleanup_identity_evidence_unavailable');
 assert.equal(f.compensated.length,0);
});

async function realPassengerControlPlane(t,{released=true}={}) {
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'yp-retirement-control-plane-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const servers=createServerRegistry({filePath:path.join(root,'servers.json')});await servers.init();const server=await servers.createLocalServer({hostname:'retirement-control.example.test'});
 const applications=createApplicationRegistry({filePath:path.join(root,'applications.json'),serverExists:async id=>Boolean(await servers.getServer(id))});await applications.init();
 let application=await applications.createNodeApplication({serverId:server.id,name:'Own Passenger retirement',repositoryUrl:'https://github.com/heroku/node-js-getting-started.git',runtimeAdapter:'passenger',runtime:{nodeMajor:24,installMode:'ci',startMode:'node',entryFile:'index.js',healthPath:'/',healthTimeoutSeconds:30,restartPolicy:'on-failure'}});
 const websites=createWebsiteRegistry({filePath:path.join(root,'websites.json'),serverExists:async id=>Boolean(await servers.getServer(id)),getApplication:id=>applications.getApplication(id)});await websites.init();
 const website=await websites.createWebsite({serverId:server.id,name:'retirement-control.example.test',applicationId:application.id,runtimeType:'node'});
 const environments=createApplicationEnvironmentRegistry({filePath:path.join(root,'environments.json'),applicationExists:async id=>Boolean(await applications.getApplication(id))});await environments.init();
 const includeRoot=path.join(root,'includes');await mkdir(includeRoot,{mode:0o700});
 const manager=createWebsitePassengerEnvironmentManager({includeRoot,receiptRoot:path.join(root,'receipts'),ownerUid:process.getuid(),ownerGid:process.getgid()});
 const sourceOperationId=randomUUID(),evidence=await manager.apply({applicationId:application.id,environmentRevision:0,values:{}},{operationId:sourceOperationId});
 const provisioning=createWebsiteProvisioningRuntime({filePath:path.join(root,'provisioning.json'),passengerEnvironmentManager:manager});await provisioning.registry.init();
 // Actual registry transitions, driven by pure release policy input; no host/deployment result is asserted.
 const commitSha=createHash('sha1').update(await readFile(new URL(import.meta.url))).digest('hex');
 await provisioning.registry.create({operationId:sourceOperationId,websiteId:website.id,resources:{application,website},steps:[{id:'passenger_environment',kind:'passenger_environment',intent:{adapter:'passenger-environment',applicationId:application.id},state:'pending'},
 {id:'node_release',kind:'node_release',intent:{adapter:'passenger-release',applicationId:application.id},state:'pending'},
 {id:'passenger_application_release',kind:'passenger_application_release',intent:{adapter:'passenger-application-release',applicationId:application.id,releaseId:sourceOperationId},state:'pending'}]});
 await provisioning.registry.beginStep({operationId:sourceOperationId,stepId:'passenger_environment'});await provisioning.registry.completeStep({operationId:sourceOperationId,stepId:'passenger_environment',evidence});
 await provisioning.registry.beginStep({operationId:sourceOperationId,stepId:'node_release'});await provisioning.registry.completeStep({operationId:sourceOperationId,stepId:'node_release',evidence:{adapter:'passenger-release',applicationId:application.id,releaseId:sourceOperationId,deploymentId:sourceOperationId,previousReleaseId:null,commitSha}});
 const sourceOperation=await provisioning.registry.get(sourceOperationId),releaseStep=sourceOperation.steps.find(row=>row.kind==='passenger_application_release');
 // released=false: provisioning stopped before its first release (failed health check), leaving a draft Application.
 if(released){const releaseEvidence=await createWebsitePassengerApplicationReleaseProvisioningHandler({applicationRegistry:applications}).apply({operation:sourceOperation,operationId:sourceOperationId,intent:releaseStep.intent});
 await provisioning.registry.beginStep({operationId:sourceOperationId,stepId:'passenger_application_release'});await provisioning.registry.completeStep({operationId:sourceOperationId,stepId:'passenger_application_release',evidence:releaseEvidence});}
 application=await applications.getApplication(application.id);
 const journal=createWebsiteRemovalOperationRegistry({filePath:path.join(root,'removals.json')});await journal.init();
 // Pure removal policy input from these actual new registry records; no HTTP or host outcome is substituted.
 const operation=await journal.create({operation:'website_remove',readyToStart:true,previewDigest:'a'.repeat(64),confirmation:'own-retirement-policy',website:{...website,desiredRevision:website.revision},plan:{applicationId:application.id,applicationRevision:application.desiredRevision,applicationRuntime:{type:'node',adapter:'passenger',releaseId:released?sourceOperationId:null},domainIds:[],domains:[],systemUser:website.unixUser,additional:{}}});
 const adapters=createWebsiteRemovalCleanupAdapters({websiteRegistry:websites,applicationRegistry:applications,applicationEnvironmentRegistry:environments,websiteProvisioningRuntime:provisioning,passengerEnvironmentManager:manager});
 return{root,server,servers,application,website,applications,websites,environments,manager,journal,operation,adapters,target:path.join(includeRoot,application.id+'.conf')};
}

test('actual registries retire an initial Passenger include before deletion and reuse the receipt after Website and Application are gone',async t=>{
 const f=await realPassengerControlPlane(t),step=f.operation.steps.find(s=>s.kind==='file_cleanup');
 const checkpoint=receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt});
 const result=await f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint});assert.equal(result.includeAbsent,true);
 await assert.rejects(readFile(f.target),{code:'ENOENT'});
 await f.journal.succeedStep(f.operation.id,step.id,{passengerEnvironmentRetirement:result});
 await f.websites.finalizeWebsiteRemoval({websiteId:f.website.id,serverId:f.server.id,applicationId:f.application.id,expectedRevision:f.website.revision,operationId:f.operation.id});
 const appStep=f.operation.steps.find(s=>s.kind==='application_cleanup');
 const appCheckpoint=receipt=>f.journal.checkpointStep(f.operation.id,appStep.id,{passengerEnvironmentRetirement:receipt});
 assert.deepEqual(await f.adapters.passengerEnvironmentCleanupHandler({operation:await f.journal.get(f.operation.id),priorReceipt:result,checkpoint:appCheckpoint}),result);
 await f.environments.purgeApplication(f.application.id);await f.applications.deleteApplication({applicationId:f.application.id,expectedServerId:f.server.id,expectedDesiredRevision:f.application.desiredRevision});
 assert.deepEqual(await f.adapters.passengerEnvironmentCleanupHandler({operation:await f.journal.get(f.operation.id),priorReceipt:result,checkpoint:appCheckpoint}),result);
 const persisted=JSON.parse(await readFile(path.join(f.root,'removals.json'),'utf8'));assert.equal(persisted[0].steps.find(s=>s.id===step.id).result.passengerEnvironmentRetirement.state,'retired');
});

test('actual registries retire the owned include of a never-released Passenger draft and reuse the receipt in Application cleanup',async t=>{
 const f=await realPassengerControlPlane(t,{released:false});
 assert.equal(f.application.currentReleaseId,null);assert.deepEqual(f.application.releases,[]);
 const step=f.operation.steps.find(s=>s.kind==='file_cleanup');
 const result=await f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt})});
 assert.equal(result.state,'retired');assert.equal(result.includeAbsent,true);assert.equal(result.authoritySnapshot.releaseId,null);
 await assert.rejects(readFile(f.target),{code:'ENOENT'});
 await f.journal.succeedStep(f.operation.id,step.id,{passengerEnvironmentRetirement:result});
 await f.websites.finalizeWebsiteRemoval({websiteId:f.website.id,serverId:f.server.id,applicationId:f.application.id,expectedRevision:f.website.revision,operationId:f.operation.id});
 const appStep=f.operation.steps.find(s=>s.kind==='application_cleanup');
 assert.deepEqual(await f.adapters.passengerEnvironmentCleanupHandler({operation:await f.journal.get(f.operation.id),priorReceipt:result,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,appStep.id,{passengerEnvironmentRetirement:receipt})}),result);
});

test('actual registry legacy continuation can retire the owned include after Website metadata disappeared without requiring a release symlink',async t=>{
 const f=await realPassengerControlPlane(t);await f.websites.finalizeWebsiteRemoval({websiteId:f.website.id,serverId:f.server.id,applicationId:f.application.id,expectedRevision:f.website.revision,operationId:f.operation.id});
 const step=f.operation.steps.find(s=>s.kind==='application_cleanup');
 const result=await f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt})});
 assert.equal(result.includeAbsent,true);await assert.rejects(readFile(f.target),{code:'ENOENT'});
});

test('real App and Website leases plus Domain namespace cover the actual checkpoint and include unlink',async t=>{
 const f=await realPassengerControlPlane(t),lock=createSiteMutationLock({root:path.join(f.root,'resource-locks')});
 const domains=createDomainRegistry({filePath:path.join(f.root,'domains.json'),serverExists:async id=>Boolean(await f.servers.getServer(id)),getWebsite:id=>f.websites.getWebsite(id),siteMutationLock:lock});await domains.init();
 const domain=await domains.createDomain({serverId:f.server.id,primaryDomain:'lease-race.example.test',targetType:'proxy',target:{upstreamPort:3000},httpsMode:'off'});
 const step=f.operation.steps.find(s=>s.kind==='file_cleanup');let enter,release;
 const entered=new Promise(resolve=>{enter=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
 const retirement=lock.withApplicationLock(f.application.id,()=>withPassengerEnvironmentRetirementScope({operation:f.operation,siteMutationLock:lock,domainRegistry:domains},()=>f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:async receipt=>{
   await f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt});
   if(receipt.state==='prepared'){enter();await barrier;}
 }})));
 await Promise.race([entered,retirement.then(()=>{throw new Error('checkpoint was not observed');})]);
 const binding=domains.bindWebsite(domain.id,f.website.id);
 try{await new Promise(setImmediate);assert.equal((await domains.getDomain(domain.id)).websiteId,null);assert.ok((await readFile(f.target)).length>0);}
 finally{release();await retirement;await binding;}
 await assert.rejects(readFile(f.target),{code:'ENOENT'});assert.equal((await binding).websiteId,f.website.id);
});

test('an actual still-bound Domain blocks retirement before checkpoint or unlink',async t=>{
 const f=await realPassengerControlPlane(t),lock=createSiteMutationLock({root:path.join(f.root,'resource-locks')});
 const domains=createDomainRegistry({filePath:path.join(f.root,'domains.json'),serverExists:async id=>Boolean(await f.servers.getServer(id)),getWebsite:id=>f.websites.getWebsite(id),siteMutationLock:lock});await domains.init();
 const domain=await domains.createDomain({serverId:f.server.id,primaryDomain:'still-bound.example.test',targetType:'proxy',target:{upstreamPort:3000},httpsMode:'off'});
 await domains.bindWebsite(domain.id,f.website.id);const before=await readFile(f.target),step=f.operation.steps.find(s=>s.kind==='file_cleanup');
 await assert.rejects(lock.withApplicationLock(f.application.id,()=>withPassengerEnvironmentRetirementScope({operation:f.operation,siteMutationLock:lock,domainRegistry:domains},()=>f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt})}))),e=>e.code==='website_removal_domains_still_attached');
 assert.deepEqual(await readFile(f.target),before);assert.equal((await domains.getDomain(domain.id)).websiteId,f.website.id);
 assert.equal((await f.journal.get(f.operation.id)).steps.find(s=>s.id===step.id).result?.passengerEnvironmentRetirement,undefined);
});

test('a real unbound Domain retaining the same Passenger Application blocks include retirement',async t=>{
 const f=await realPassengerControlPlane(t),lock=createSiteMutationLock({root:path.join(f.root,'resource-locks')});
 const domains=createDomainRegistry({filePath:path.join(f.root,'domains.json'),serverExists:async id=>Boolean(await f.servers.getServer(id)),getWebsite:id=>f.websites.getWebsite(id),websiteBindingRequired:()=>true,siteMutationLock:lock});await domains.init();
 const domain=await domains.createDomain({serverId:f.server.id,websiteId:f.website.id,primaryDomain:'unbound-app.example.test',targetType:'passenger',target:{applicationId:f.application.id},httpsMode:'off'});await domains.rollbackWebsiteBinding(domain.id,f.website.id);
 const before=await readFile(f.target),step=f.operation.steps.find(s=>s.kind==='file_cleanup');
 await assert.rejects(lock.withApplicationLock(f.application.id,()=>withPassengerEnvironmentRetirementScope({operation:f.operation,siteMutationLock:lock,domainRegistry:domains},()=>f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt})}))),e=>e.code==='website_removal_domains_still_attached');
 assert.deepEqual(await readFile(f.target),before);const remaining=await domains.getDomain(domain.id);assert.equal(remaining.websiteId,null);assert.equal(remaining.target.applicationId,f.application.id);
});

test('missing Application cannot advance a prepared retirement or adopt absence without a retired checkpoint',async t=>{
 for(const phase of ['prepared-present','prepared-absent','no-prior']){
  const hasPrepared=phase!=='no-prior';
  const f=await realPassengerControlPlane(t),step=f.operation.steps.find(s=>s.kind==='file_cleanup');let prepared;
  const checkpoint=receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt});
  if(hasPrepared)await assert.rejects(f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:async receipt=>{if(receipt.state==='prepared'){await checkpoint(receipt);prepared=receipt;}if(phase==='prepared-present'||receipt.state==='retired')await writeFile(f.root,'actual EISDIR checkpoint boundary');}}),{code:'EISDIR'});
  else await rm(f.target);
  await f.websites.finalizeWebsiteRemoval({websiteId:f.website.id,serverId:f.server.id,applicationId:f.application.id,expectedRevision:f.website.revision,operationId:f.operation.id});
  await f.environments.purgeApplication(f.application.id);await f.applications.deleteApplication({applicationId:f.application.id,expectedServerId:f.server.id,expectedDesiredRevision:f.application.desiredRevision});
  await assert.rejects(f.adapters.passengerEnvironmentCleanupHandler({operation:await f.journal.get(f.operation.id),priorReceipt:prepared??null,checkpoint}),e=>e.code==='website_cleanup_passenger_environment_ownership_missing');
  if(phase==='prepared-present')assert.ok((await readFile(f.target)).length>0);else await assert.rejects(readFile(f.target),{code:'ENOENT'});
 }
});

test('an actual later Passenger release with absent applied metadata cannot reuse initial include authority',async t=>{
 const f=await realPassengerControlPlane(t),before=await readFile(f.target),next=randomUUID();
 await f.applications.activatePassengerRelease(f.application.id,{operationId:next,releaseId:next,previousReleaseId:f.application.currentReleaseId,commitSha:f.application.currentCommitSha});
 const step=f.operation.steps.find(s=>s.kind==='file_cleanup');
 await assert.rejects(f.adapters.passengerEnvironmentCleanupHandler({operation:f.operation,checkpoint:receipt=>f.journal.checkpointStep(f.operation.id,step.id,{passengerEnvironmentRetirement:receipt})}),e=>e.code==='website_passenger_environment_retirement_drift');
 assert.deepEqual(await readFile(f.target),before);assert.equal((await f.journal.get(f.operation.id)).steps.find(s=>s.id===step.id).result?.passengerEnvironmentRetirement,undefined);
});
