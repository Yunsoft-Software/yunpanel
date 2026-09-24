import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsitePhpToolActionService } from '../src/website-php-tool-action-service.js';

const preview={
  version:1,websiteId:'11111111-1111-4111-8111-111111111111',serverId:'33333333-3333-4333-8333-333333333333',
  applicationId:'22222222-2222-4222-8222-222222222222',unixUser:'yunapp-123456789abc',websiteRevision:4,
  actionId:'wp.cache.flush',tool:'wp-cli',command:'cache',args:['flush'],timeout:60000,label:'WordPress önbelleğini temizle',
  impact:'WordPress nesne önbelleği temizlenir. Site dosyaları ve veritabanı şeması değiştirilmez.',
  previewDigest:'a'.repeat(64),confirmation:`php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`,
};
const input={actionId:preview.actionId,expectedWebsiteRevision:4,previewDigest:preview.previewDigest,confirmation:preview.confirmation};
const actor={sessionId:'44444444-4444-4444-8444-444444444444',userId:'55555555-5555-4555-8555-555555555555',role:'site_manager'};

function service({authorize=async()=>actor, jobs=[]}={}) {
  const enqueued=[];
  return {enqueued, value:createWebsitePhpToolActionService({
    websitePhpToolsService:{getActionPreview:async()=>preview},
    jobRegistry:{listJobs:async()=>jobs,enqueue:async(v)=>{enqueued.push(v);return{id:'job-12345678',status:'queued',...v};}},
    authorizeActor:authorize,
    withApplicationLock:async(_id,op)=>op(),
  })};
}
test('queue binds live actor session identity into durable payload', async()=>{
  const h=service(); await h.value.queue(preview.websiteId,input,actor);
  assert.equal(h.enqueued[0].payload.actorSessionId,actor.sessionId);
  assert.equal(h.enqueued[0].payload.actorUserId,actor.userId);
  assert.equal(h.enqueued[0].payload.actorRole,actor.role);
});
test('revoked actor before first authorization cannot enqueue', async()=>{
  const h=service({authorize:async()=>null});
  await assert.rejects(()=>h.value.queue(preview.websiteId,input,actor),(e)=>e.code==='website_php_action_actor_forbidden');
  assert.equal(h.enqueued.length,0);
});
test('actor revoked while waiting for application lock cannot enqueue', async()=>{
  let calls=0; const h=service({authorize:async()=>++calls===1?actor:null});
  await assert.rejects(()=>h.value.queue(preview.websiteId,input,actor),(e)=>e.code==='website_php_action_actor_forbidden');
  assert.equal(h.enqueued.length,0);
});
