import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalCleanupAdapters } from '../src/website-removal-cleanup-adapters.js';

const websiteId='11111111-1111-4111-8111-111111111111';
const applicationId='22222222-2222-4222-8222-222222222222';
const systemUser='yunapp-123456789abc';
function fixture({otherWebsite=false,symlink=false}={}) {
  const removed=[]; const removedSet=new Set(); const compensated=[];
  const adapters=createWebsiteRemovalCleanupAdapters({
    websiteRegistry:{
      getWebsite:async()=>({id:websiteId,serverId:'33333333-3333-4333-8333-333333333333',applicationId,unixUser:systemUser}),
      listWebsites:async()=>[{id:websiteId,applicationId},...(otherWebsite?[{id:'44444444-4444-4444-8444-444444444444',applicationId}]:[])],
    },
    applicationRegistry:{getApplication:async()=>({id:applicationId,serverId:'33333333-3333-4333-8333-333333333333'})},
    websiteProvisioningRuntime:{
      registry:{listForWebsite:async()=>[{operationId:'55555555-5555-4555-8555-555555555555',steps:[{
        kind:'unix_identity',state:'succeeded',intent:{websiteId,applicationId,unixUser:systemUser,homeDirectory:'/var/lib/yunpanel/data/'+applicationId},evidence:{owned:true},
      }]}]},
      handlers:{unix_identity:{
        compensate:async(ctx)=>{compensated.push(ctx);return{satisfied:true,removedUser:true,removedGroup:true};},
        inspectCompensation:async()=>({satisfied:true,removedUser:true,removedGroup:true}),
      }},
    },
    lstatFn:async(path)=>{
      if(removedSet.has(path)) throw Object.assign(new Error('missing'),{code:'ENOENT'});
      return {isSymbolicLink:()=>symlink,isDirectory:()=>!symlink};
    },
    rmFn:async(path)=>{removed.push(path);removedSet.add(path);},
  });
  return {adapters,removed,compensated};
}
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
 assert.deepEqual(value.targets.sort(),[
  '/var/lib/yunpanel/apps/'+applicationId,
  '/var/lib/yunpanel/build/'+applicationId,
  '/var/lib/yunpanel/data/'+applicationId,
  '/var/www/yunpanel/apps/'+applicationId,
 ].sort());
 assert.equal(f.removed.length,0);
});
