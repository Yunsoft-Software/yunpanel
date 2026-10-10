import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizeNodeRuntimeConfig} from '@yunpanel/shared';
import {createLocalPassengerRestartOperation} from '../src/local-passenger-restart-operation.js';

function fixture(){
 const app={id:randomUUID(),serverId:randomUUID(),type:'node',runtimeAdapter:'passenger',currentReleaseId:randomUUID(),
  activeRuntime:normalizeNodeRuntimeConfig({nodeMajor:24,startMode:'node',entryFile:'index.js',healthPath:'/'},{requirePort:false})};
 const website={id:randomUUID(),applicationId:app.id,serverId:app.serverId,runtimeType:'node',unixUser:'yunapp-123456abcdef',name:'owned.example.test'};
 let websites=[website],revision=3,applied=0,restored=0,marked=0,markFailure=false;
 let appliedMetadata={appliedRevision:3,appliedReleaseId:app.currentReleaseId,lastAppliedAt:new Date().toISOString()};const calls=[];
 const runtimeManager={captureEnvironment:async()=>({version:1,content:'protected previous contents'}),
  applyEnvironment:async input=>{calls.push(input);applied++;assert.equal(await input.verifyHealth(),true);return{verified:true,appliedMatchesSaved:true,applicationId:app.id};},
  restoreEnvironment:async()=>{restored++;return{verified:true};},
  inspectAppliedPassengerEnvironment:async input=>({verified:true,applicationId:app.id,releaseId:app.currentReleaseId,environmentRevision:input.environmentRevision,processes:1})};
 const operation=createLocalPassengerRestartOperation({applicationRegistry:{getApplication:async()=>app},websiteRegistry:{listWebsites:async()=>websites},
  domainRegistry:{listDomains:async()=>[{id:randomUUID(),websiteId:website.id,serverId:app.serverId,primaryDomain:website.name,parentDomainId:null}]},
  applicationEnvironmentRegistry:{environmentStatus:async()=>({savedRevision:revision,...appliedMetadata}),materialize:async(id,options)=>{assert.equal(id,app.id);assert.equal(options.expectedRevision,revision);return{OWNED_PROOF:'controlled-value'};},
   markApplied:async input=>{assert.equal(input.applicationId,app.id);if(markFailure)throw Object.assign(new Error('controlled failure'),{code:'store_write_failed'});marked++;}},
  siteMutationLock:{withSiteLock:async(scope,run)=>{assert.equal(scope.websiteId,website.id);return run();}},runtimeManager,
  healthInspector:{inspect:async input=>{assert.equal(input.primaryDomain,website.name);return{satisfied:true};}}});
 const payload={applicationId:app.id,releaseId:app.currentReleaseId,runtime:app.activeRuntime,runtimeAdapter:'passenger',environmentRevision:3};
 const execution={jobId:randomUUID(),serverId:app.serverId,resourceType:'application',resourceId:app.id};
 return{app,website,operation,payload,execution,calls,get applied(){return applied;},get restored(){return restored;},get marked(){return marked;},
  changeRevision(){revision++;},shared(){websites.push({...website,id:randomUUID()});},failMark(){markFailure=true;},changeApplied(patch){appliedMetadata={...appliedMetadata,...patch};}};
}
test('Passenger restart pins stored runtime, site, environment revision and HTTP verification before marking applied',async()=>{
 const f=fixture(),result=await f.operation.execute(f.payload,f.execution);
 assert.equal(result.restarted,true);assert.equal(result.healthy,true);assert.equal(result.runtimeAdapter,'passenger');assert.equal(f.applied,1);assert.equal(f.marked,1);
 assert.deepEqual(f.calls[0].values,{OWNED_PROOF:'controlled-value'});
});
test('shared Website identity and stale environment revision fail before any runtime mutation',async()=>{
 for(const change of ['shared','changeRevision']){const f=fixture();f[change]();await assert.rejects(f.operation.execute(f.payload,f.execution));assert.equal(f.applied,0);assert.equal(f.marked,0);}
});
test('foreign job scope, release and adapter cannot select the Passenger executor',async()=>{
 for(const patch of [{serverId:randomUUID()},{resourceId:randomUUID()},{jobId:'untracked'}]){
  const f=fixture();await assert.rejects(f.operation.execute(f.payload,{...f.execution,...patch}));assert.equal(f.applied,0);
 }
 const f=fixture();f.app.runtimeAdapter='direct-systemd';await assert.rejects(f.operation.execute(f.payload,f.execution));assert.equal(f.applied,0);
});
test('a failed applied-state write restores the previous protected environment before reporting failure',async()=>{
 const f=fixture();f.failMark();await assert.rejects(f.operation.execute(f.payload,f.execution),{code:'store_write_failed'});assert.equal(f.applied,1);assert.equal(f.restored,1);assert.equal(f.marked,0);
});
test('Passenger recovery inspects the pinned applied catalog and process without restarting or writing the environment',async()=>{
 const f=fixture(),proof=await f.operation.inspectRecovery(f.payload,f.execution);
 assert.equal(proof.verified,true);assert.equal(proof.processes,1);assert.equal(proof.environmentRevision,3);
 assert.equal(proof.runtimeAdapter,'passenger');assert.equal(proof.port,null);assert.ok(Date.parse(proof.appliedAt));
 assert.equal(f.applied,0);assert.equal(f.restored,0);assert.equal(f.marked,0);assert.equal(f.calls.length,0);
});
test('Passenger recovery rejects unapplied revisions, foreign releases and missing applied timestamps without mutation',async()=>{
 for(const patch of [{appliedRevision:2},{appliedReleaseId:randomUUID()},{lastAppliedAt:null}]){
  const f=fixture();f.changeApplied(patch);
  await assert.rejects(f.operation.inspectRecovery(f.payload,f.execution),{code:'passenger_restart_applied_state_unverified'});
  assert.equal(f.applied,0);assert.equal(f.restored,0);assert.equal(f.marked,0);
 }
});
