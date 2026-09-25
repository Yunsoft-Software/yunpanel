import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { removalFixture, removalPreview } from '../test-support/website-removal-fixture.js';

test('removal preview blocks legacy direct-systemd binding without matching Application runtime authority', async()=>{
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]});
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>({adapter:'direct-systemd',revision:2,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),
  removeOwnedPassenger:async()=>{},removeOwnedStatic:async()=>{},removeOwnedDirectSystemd:async()=>{},
 }},preview);
 const value=await f.runtime.preview({websiteId:'site-a'});
 assert.equal(value.readyToStart,false);
 assert.ok(value.hardBlockers.includes('runtime_cleanup_authority_conflict'));
});
test('static runtime cleanup uses static ownership API, never Passenger API', async()=>{
 let staticCalls=0,passengerCalls=0;
 const preview=removalPreview('site-a',{runtimeBindings:[{id:'binding-a'}]},{systemUser:null});
 let binding={adapter:'static',revision:3,sourceOperationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
 const f=await removalFixture({runtimeBindingRegistry:{
  getBinding:async()=>binding,
  removeOwnedPassenger:async()=>{passengerCalls++;},
  removeOwnedStatic:async(_id,options)=>{staticCalls++;assert.equal(options.sourceOperationId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');binding=null;},
 }},preview);
 let op=await f.runtime.start({websiteId:preview.website.id,previewDigest:preview.previewDigest,confirmation:preview.confirmation});
 while(op.status==='running'){
  const step=op.steps.find((x)=>x.status!=='succeeded'); if(!step)break;
  op=await f.runtime.continueStep({websiteId:op.websiteId,operationId:op.id,stepId:step.id,expectedUpdatedAt:op.updatedAt,confirmation:op.actions.stepContinuationConfirmation});
 }
 assert.equal(staticCalls,1);assert.equal(passengerCalls,0);
});
