import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';

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
 assert.equal(f.removed.length,4);
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
  assert.equal(f.removed.length,4);
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
test('file cleanup touches only canonical Application direct-child roots and keeps backups out of scope',async()=>{
 const f=fixture();
 await f.adapters.fileCleanupHandler({websiteId,applicationId,retainedBackups:['backup-a']});
 assert.deepEqual(f.removed.sort(),[
  '/var/lib/yunpanel/apps/'+applicationId,
  '/var/lib/yunpanel/build/'+applicationId,
  '/var/lib/yunpanel/data/'+applicationId,
  '/var/www/yunpanel/apps/'+applicationId,
 ].sort());
 assert.equal(f.removed.some((path)=>path.includes('/backups/')),false);
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
