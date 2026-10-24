import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailChangeController } from '../src/workspace/mail-change-controller.js';
function fixture() {
 const calls=[];let lost=false,invalid=false;
 const evidence={readyToApply:true,previewDigest:'a'.repeat(64),configuration:{sha256:'b'.repeat(64)}};
 const result={version:3,applied:true,sideEffects:true,mailDomainId:'domain',previewDigest:evidence.previewDigest,configurationSha256:evidence.configuration.sha256,previousRevision:4,previousStatus:'enabled',desiredStatus:'enabled'};
 const job={id:'job',status:'succeeded',result};
 const controller=createMailChangeController({domainId:'domain',requestId:'request',getDomain:async()=>({id:'domain',managementMode:'local',status:'enabled',revision:4}),
  preview:async()=>{calls.push('preview');return evidence;},apply:async()=>{calls.push('apply');if(lost)throw new Error('Connection interrupted');return job;},
  getRequest:async()=>{calls.push('resume');return job;},waitForJob:async()=>({...job,result:invalid?{...result,mailDomainId:'foreign'}:result})});
 return {controller,calls,mutate:async()=>{calls.push('mutate');return {id:'mailbox'};},lose:()=>{lost=true;},invalidate:()=>{invalid=true;}};
}
test('mail mutation finishes only after exact native apply evidence and current state',async()=>{const f=fixture();assert.deepEqual(await f.controller.run(f.mutate),{id:'mailbox'});assert.deepEqual(f.calls,['mutate','preview','apply']);assert.equal(f.controller.completed,true);});
test('lost mail apply response resumes the same durable job without repeating the metadata write or apply',async()=>{const f=fixture();f.lose();await assert.rejects(f.controller.run(f.mutate),e=>e.saved===true);assert.equal(f.controller.saved,true);assert.equal(f.controller.completed,false);await f.controller.run(()=>{throw new Error('Must never recreate');});assert.deepEqual(f.calls,['mutate','preview','apply','resume']);assert.equal(f.controller.completed,true);});
test('foreign or incomplete native mail result never closes a successful-looking form',async()=>{const f=fixture();f.invalidate();await assert.rejects(f.controller.run(f.mutate),/sonucu doğrulanamadı/);assert.equal(f.controller.completed,false);});
test('metadata write failure never dispatches a mail configuration job',async()=>{const f=fixture();await assert.rejects(f.controller.run(()=>{throw new Error('Revision conflict');}),/Revision conflict/);assert.equal(f.controller.saved,false);assert.deepEqual(f.calls,[]);});
test('completed action is stable under repeated clicks',async()=>{const f=fixture();await f.controller.run(f.mutate);await f.controller.run(f.mutate);assert.equal(f.calls.filter(x=>x==='mutate').length,1);});
