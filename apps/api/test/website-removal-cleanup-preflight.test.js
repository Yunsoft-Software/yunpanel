import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { removalFixture, removalPreview } from '../test-support/website-removal-fixture.js';

test('preview blocks before destructive work when Unix ownership evidence is unavailable',async()=>{
 const preview=removalPreview();
 const f=await removalFixture({
   fileCleanupInspector:async()=>({ready:true}),
   unixIdentityCleanupInspector:async()=>{throw new Error('no receipt');},
 },preview);
 const runtime=createWebsiteRemovalRuntime({
   ...f.dependencies,
   fileCleanupInspector:async()=>({ready:true}),
   unixIdentityCleanupInspector:async()=>{throw new Error('no receipt');},
 });
 const value=await runtime.preview({websiteId:preview.website.id});
 assert.equal(value.readyToStart,false);
 assert.ok(value.hardBlockers.includes('unix_cleanup_evidence_unavailable'));
 assert.equal(value.confirmation,null);
});
test('preview blocks unsafe canonical file roots before removal starts',async()=>{
 const preview=removalPreview();
 const runtime=createWebsiteRemovalRuntime({
   ...(await removalFixture()).dependencies,
   fileCleanupInspector:async()=>{throw new Error('unsafe');},
   unixIdentityCleanupInspector:async()=>({ready:true}),
 });
 const value=await runtime.preview({websiteId:preview.website.id});
 assert.equal(value.readyToStart,false);
 assert.ok(value.hardBlockers.includes('file_cleanup_preflight_failed'));
});
