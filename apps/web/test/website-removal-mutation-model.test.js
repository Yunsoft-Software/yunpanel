import assert from 'node:assert/strict';import test from 'node:test';
import {globalRemovalOperation,nextRemovalStep,removalOperation} from '../src/workspace/website-removal-model.js';
const scope={websiteId:'11111111-1111-4111-8111-111111111111',serverId:'22222222-2222-4222-8222-222222222222',label:'example.test'};
const op={id:'ws-rem-12345678',websiteId:scope.websiteId,serverId:scope.serverId,applicationId:'33333333-3333-4333-8333-333333333333',previewDigest:'a'.repeat(64),status:'running',updatedAt:'2026-09-25T00:00:00.000Z',
 steps:[{id:'001:file_cleanup:app',kind:'file_cleanup',status:'pending'}],actions:{stepContinuationConfirmation:'continue-token'}};
test('operation exposes exactly one explicit next step confirmation',()=>{const value=removalOperation(op,scope);assert.deepEqual(nextRemovalStep(value),{stepId:op.steps[0].id,kind:'file_cleanup',status:'pending',confirmation:'continue-token'});});
test('global operation validates its own Website/server scope',()=>{assert.equal(globalRemovalOperation(op).websiteId,scope.websiteId);assert.throws(()=>globalRemovalOperation({...op,websiteId:'bad'}));});
test('removed operation has no continuation',()=>{const value=removalOperation({...op,status:'removed',steps:[{...op.steps[0],status:'succeeded'}],actions:{stepContinuationConfirmation:null}},scope);assert.equal(nextRemovalStep(value),null);});
