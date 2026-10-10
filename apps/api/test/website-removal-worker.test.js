import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebsiteRemovalOperationRegistry } from '../src/website-removal-operation-registry.js';
import { createWebsiteRemovalRuntime } from '../src/website-removal-runtime.js';
import { createWebsiteRemovalWorker } from '../src/website-removal-worker.js';
import { removalFixture, removalStart, deferred } from '../test-support/website-removal-fixture.js';

const actor = { userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',role:'owner' };
const authorizeActor = async value => ({ ...value });
const runInput = operation => ({ websiteId:operation.websiteId,operationId:operation.id,expectedUpdatedAt:operation.updatedAt,
  confirmation:operation.actions.runConfirmation,actor });
async function finish(worker, runtime, id) {
  for (let i=0;i<15;i++) { await worker.runOnce();const operation=await runtime.get(id); if(operation.status==='removed')return operation; }
  assert.fail('The existing removal journal did not complete');
}

test('one durable automatic intent returns before host work and executes all steps without a browser',async()=>{
  const f=await removalFixture({authorizeActor,automaticExecution:true});
  const operation=await f.runtime.start({...removalStart(f.preview),actor});
  assert.equal(operation.status,'pending');assert.equal(f.calls.length,0);
  assert.deepEqual(operation.execution,{mode:'automatic'});assert.equal(Object.hasOwn(operation,'actor'),false);
  const worker=createWebsiteRemovalWorker({registry:f.registry,runtime:f.runtime});
  assert.equal((await finish(worker,f.runtime,operation.id)).status,'removed');assert.equal(f.calls.length,1);
  await worker.runOnce();assert.equal(f.calls.length,1);
});

test('manual legacy journals are never executed by the worker',async()=>{
  const f=await removalFixture({authorizeActor});
  const operation=await f.runtime.start({...removalStart(f.preview),actor});
  const before=await f.runtime.get(operation.id);const worker=createWebsiteRemovalWorker({registry:f.registry,runtime:f.runtime});
  await worker.runOnce();assert.deepEqual(await f.runtime.get(operation.id),before);
});

test('revoked Owner authorization stops before any host write and a fresh explicit consent resumes the same journal',async()=>{
  let authorized=true;const f=await removalFixture({automaticExecution:true,authorizeActor:async value=>authorized?value:null});
  const operation=await f.runtime.start({...removalStart(f.preview),actor});const worker=createWebsiteRemovalWorker({registry:f.registry,runtime:f.runtime});
  authorized=false;await worker.runOnce();let stopped=await f.runtime.get(operation.id);
  assert.equal(stopped.status,'blocked');assert.equal(stopped.error.code,'website_removal_actor_forbidden');assert.equal(f.calls.length,0);
  await worker.runOnce();assert.equal(f.calls.length,0);
  authorized=true;await assert.rejects(f.runtime.run({...runInput(stopped),actor:{...actor,userId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}}),e=>e.code==='website_removal_actor_mismatch');
  await assert.rejects(f.runtime.run({...runInput(stopped),confirmation:'stale'}),e=>e.code==='website_removal_execution_stale');
  await f.runtime.run(runInput(stopped));assert.equal((await finish(worker,f.runtime,operation.id)).id,operation.id);
});

test('failed cleanup is attempted once; only current explicit consent can authorize another attempt',async()=>{
  let writes=0,fail=true;const f=await removalFixture({authorizeActor,automaticExecution:true,fileCleanupHandler:async input=>{
    writes++;if(fail)throw new Error('fixture unavailable');return {...input,filesCleaned:true};
  }});
  const operation=await f.runtime.start({...removalStart(f.preview),actor});const worker=createWebsiteRemovalWorker({registry:f.registry,runtime:f.runtime});
  await worker.runOnce();assert.equal((await f.runtime.get(operation.id)).status,'failed');
  await worker.runOnce();await worker.runOnce();assert.equal(writes,1);
  const stopped=await f.runtime.get(operation.id);fail=false;await f.runtime.run(runInput(stopped));
  await finish(worker,f.runtime,operation.id);assert.equal(writes,2);
});

test('a cold restart reconciles an interrupted durable journal and preserves real already-cleaned fixture files',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'yp-removal-worker-'));let physicalRemovals=0;
  try {
    const filePath=path.join(dir,'operations.json'),target=path.join(dir,'owned-file');await writeFile(target,'real fixture');
    const registry=createWebsiteRemovalOperationRegistry({filePath});await registry.init();
    const f=await removalFixture({registry,authorizeActor,automaticExecution:true,fileCleanupHandler:async input=>{
      try{await stat(target);await rm(target);physicalRemovals++;}catch(e){if(e.code!=='ENOENT')throw e;}
      return {...input,filesCleaned:true};
    }});
    const operation=await f.runtime.start({...removalStart(f.preview),actor});
    await registry.markStepRunning(operation.id,operation.steps[0].id);await rm(target);physicalRemovals++;
    const reloaded=createWebsiteRemovalOperationRegistry({filePath});await reloaded.init();
    const runtime=createWebsiteRemovalRuntime({...f.dependencies,registry:reloaded});await runtime.init();
    const worker=createWebsiteRemovalWorker({registry:reloaded,runtime});const completed=await finish(worker,runtime,operation.id);
    assert.equal(completed.error,null);assert.equal(completed.steps.every(step=>step.error===null),true);
    assert.equal(physicalRemovals,1);const persisted=JSON.parse(await readFile(filePath,'utf8'));
    assert.equal(persisted[0].status,'removed');assert.equal(persisted[0].execution.mode,'automatic');
    assert.equal(persisted[0].steps[0].previousErrors.some(error=>error.code==='website_removal_interrupted'),true);
    assert.equal((await stat(filePath)).mode&0o777,0o600);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('overlapping worker sweeps share the same in-flight advance',async()=>{
  const gate=deferred();let writes=0;const f=await removalFixture({authorizeActor,automaticExecution:true,fileCleanupHandler:async input=>{
    writes++;await gate.promise;return {...input,filesCleaned:true};
  }});
  await f.runtime.start({...removalStart(f.preview),actor});const worker=createWebsiteRemovalWorker({registry:f.registry,runtime:f.runtime});
  const first=worker.runOnce(),second=worker.runOnce();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(writes,1);
  gate.resolve();await Promise.all([first,second]);assert.equal(writes,1);
});

test('tampered persisted execution authority cannot trigger a host write',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'yp-removal-worker-authority-'));
 try{
  const filePath=path.join(dir,'operations.json'),registry=createWebsiteRemovalOperationRegistry({filePath});await registry.init();
  const f=await removalFixture({registry,authorizeActor,automaticExecution:true});
  await f.runtime.start({...removalStart(f.preview),actor});
  const records=JSON.parse(await readFile(filePath,'utf8'));records[0].execution.userId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await writeFile(filePath,JSON.stringify(records),{mode:0o600});let reports=0;
  const worker=createWebsiteRemovalWorker({registry,runtime:f.runtime,onError:()=>reports++});await worker.runOnce();
  assert.equal(f.calls.length,0);assert.equal(reports,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
