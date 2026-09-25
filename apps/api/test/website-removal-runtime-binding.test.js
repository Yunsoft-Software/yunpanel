import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { removalFixture, removalPreview } from '../test-support/website-removal-fixture.js';

test('removal preview blocks direct-systemd runtime binding without host service cleanup', async()=>{
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]});
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>({adapter:'direct-systemd',revision:2,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
  removeOwnedPassenger:async()=>{},removeOwnedStatic:async()=>{},
 }},preview);
 const value=await f.runtime.preview({websiteId:'site-a'});
 assert.equal(value.readyToStart,false);
 assert.ok(value.hardBlockers.includes('runtime_cleanup_adapter_unsupported'));
});
test('static runtime cleanup uses static ownership API, never Passenger API', async()=>{
 let staticCalls=0,passengerCalls=0;
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]},{systemUser:null});
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>({adapter:'static',revision:3,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
  removeOwnedPassenger:async()=>{passengerCalls++;},
  removeOwnedStatic:async(_id,options)=>{staticCalls++;assert.equal(options.sourceOperationId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');},
 }},preview);
 let op=await f.runtime.start({websiteId:preview.website.id,previewDigest:preview.previewDigest,confirmation:preview.confirmation});
 while(op.status==='running'){
  const step=op.steps.find((x)=>x.status!=='succeeded'); if(!step)break;
  op=await f.runtime.continueStep({websiteId:op.websiteId,operationId:op.id,stepId:step.id,expectedUpdatedAt:op.updatedAt,confirmation:op.actions.stepContinuationConfirmation});
 }
 assert.equal(staticCalls,1);assert.equal(passengerCalls,0);
});
