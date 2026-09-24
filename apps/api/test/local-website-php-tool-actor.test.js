import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalWebsitePhpToolOperation } from '../src/local-website-php-tool-operation.js';

test('worker rejects revoked queued actor before reading action preview', async()=>{
  let previewRead=false, ran=false;
  const op=createLocalWebsitePhpToolOperation({
    websitePhpToolsService:{
      getActionPreview:async()=>{previewRead=true;return null;},
      runWpCli:async()=>{ran=true;},runComposer:async()=>{ran=true;},
    },
    authorizeActor:async()=>null,
  });
  await assert.rejects(()=>op.execute({
    websiteId:'11111111-1111-4111-8111-111111111111',
    applicationId:'22222222-2222-4222-8222-222222222222',
    unixUser:'yunapp-123456789abc',expectedWebsiteRevision:4,
    actorSessionId:'44444444-4444-4444-8444-444444444444',
    actorUserId:'55555555-5555-4555-8555-555555555555',actorRole:'site_manager',
    actionId:'wp.cache.flush',previewDigest:'a'.repeat(64),
    confirmation:`php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`,
  },{
    jobId:'job-12345678',serverId:'33333333-3333-4333-8333-333333333333',
    resourceType:'application',resourceId:'22222222-2222-4222-8222-222222222222',
  }),(e)=>e.code==='website_php_action_actor_forbidden');
  assert.equal(previewRead,false); assert.equal(ran,false);
});
