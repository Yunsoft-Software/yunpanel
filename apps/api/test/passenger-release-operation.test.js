import {verifyPassengerReleaseBaselineTarget} from '../src/passenger-release-snapshot.js';
import {websitePassengerEnvironmentInternals} from '@yunpanel/host-runtime/website-passenger-environment-manager';
import {recoverPassengerRelease} from '../src/passenger-release-recovery.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {OPERATIONS} from '@yunpanel/protocol';
import {createApplicationIdentity} from '@yunpanel/host-runtime/application-identity';
import {createApplicationRegistry} from '../src/application-registry.js';
import {createApplicationEnvironmentRegistry} from '../src/application-environment-registry.js';
import {createApplicationRuntimeBindingRegistry} from '../src/application-runtime-binding-registry.js';
import {createApplicationDeployQueue} from '../src/application-deploy-queue.js';
import {createPassengerReleaseRollbackQueue} from '../src/passenger-release-rollback-queue.js';
import {createJobRegistry} from '../src/job-registry.js';
import {createSiteMutationLock} from '../src/site-mutation-lock.js';
import {createPassengerReleasePhaseStore,passengerReleasePhaseIdentity} from '../src/passenger-release-phase-store.js';
import {createWebsiteResourceBackupCodec} from '../src/website-resource-backup-codec.js';
import {createLocalPassengerReleaseOperation} from '../src/local-passenger-release-operation.js';
import {reconcileCompletedJob} from '../src/job-reconciliation.js';
const id=n=>`${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const serverId=id('1'),applicationId=id('2'),websiteId=id('3'),releaseA=id('4'),domainId=id('5');
const secret='private-env-source-test';
async function fixture(t,{multiple=false}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'yp-passenger-release-')));t.after(()=>rm(root,{recursive:true,force:true}));
 const applicationRegistry=createApplicationRegistry({serverExists:async s=>s===serverId});
 let app=await applicationRegistry.createNodeApplication({applicationId,serverId,name:'Passenger',repositoryUrl:'https://github.com/example/app',branch:'main',runtime:{nodeMajor:24,entryFile:'index.js'}});
 app=await applicationRegistry.activatePassengerRelease(applicationId,{operationId:releaseA,releaseId:releaseA,previousReleaseId:null,commitSha:'a'.repeat(40),runtime:app.runtime});
 const unixUser=createApplicationIdentity(applicationId).unixUser;
 const website={id:websiteId,applicationId,serverId,runtimeType:'node',name:'node.example.test',unixUser,revision:1};
 const websiteRegistry={listWebsites:async()=>[structuredClone(website)],getWebsite:async()=>structuredClone(website)};
 const domains=[{id:domainId,websiteId,serverId,primaryDomain:website.name,aliases:[],desiredRevision:2,appliedRevision:2,stagedRevision:2,
  state:'active',lastError:null,targetType:'passenger',httpsMode:'off',certificateId:null,nginxSettings:{},stagedChecksum:'a'.repeat(64),stagedConfigName:'node.conf'}];
 if(multiple) domains.push({...domains[0],id:id('6'),primaryDomain:'other.example.test'});
 const domainRegistry={listDomains:async()=>structuredClone(domains),getDomain:async key=>structuredClone(domains.find(d=>d.id===key)),
  markStaged:async(key,s)=>{const d=domains.find(d=>d.id===key);assert.equal(s.expectedRevision,d.desiredRevision);d.stagedChecksum=s.checksum;d.stagedConfigName=s.configName;d.stagedRevision=d.desiredRevision;d.state='staged';return structuredClone(d);},
  markApplied:async(key,s)=>{const d=domains.find(d=>d.id===key);assert.equal(d.stagedChecksum,s.checksum);d.appliedRevision=d.desiredRevision;d.state='active';return structuredClone(d);}};
 const applicationEnvironmentRegistry=createApplicationEnvironmentRegistry({masterKey:'ab'.repeat(32),applicationExists:async k=>k===applicationId});
 await applicationEnvironmentRegistry.markApplied({applicationId,revision:0,releaseId:releaseA});
 await applicationEnvironmentRegistry.setVariable({applicationId,key:'API_SECRET',value:secret,secret:true});
 const runtimeBindingRegistry={...createApplicationRuntimeBindingRegistry()};
 const target=releaseId=>({appRoot:`/var/lib/yunpanel/apps/${applicationId}/releases/${releaseId}`,documentRoot:`/var/lib/yunpanel/apps/${applicationId}/releases/${releaseId}`,
 startupFile:'index.js',nodeBinary:'/opt/yunpanel/node-runtimes/v24/bin/node',user:unixUser,group:unixUser,appEnv:'production',environmentInclude:`/etc/yunpanel/passenger-env/${applicationId}.conf`});
 await runtimeBindingRegistry.activate({applicationId,serverId,adapter:'passenger',state:'active',sourceOperationId:releaseA,releaseId:releaseA,
 websiteId,websiteRevision:1,domains:domains.map(d=>({domainId:d.id,desiredRevision:d.desiredRevision,nginxChecksum:d.stagedChecksum})),passengerTarget:target(releaseA)});
 const jobRegistry=createJobRegistry();const siteMutationLock=createSiteMutationLock({root:path.join(root,'locks')});
 const dependencies={applicationRegistry,applicationEnvironmentRegistry,websiteRegistry,domainRegistry,runtimeBindingRegistry,localServerId:serverId,jobRegistry,siteMutationLock};
 const phaseStore=createPassengerReleasePhaseStore({root:path.join(root,'phases'),codec:createWebsiteResourceBackupCodec({masterKey:'ab'.repeat(32)})});
 const physical={current:releaseA,values:{},revision:0,prepared:0,published:0,discarded:0,retention:0,releases:new Map([[releaseA,{commitSha:'a'.repeat(40)}]]),routes:new Map(domains.map(d=>[d.primaryDomain,'a'.repeat(64)])),reloads:0};
 const hooks={};
 const evidence=releaseId=>({satisfied:true,applicationId,releaseId,currentReleaseId:physical.current,commitSha:physical.releases.get(releaseId)?.commitSha,
  ...target(releaseId),unixUser});
 const releaseManager={prepare:async(s,options)=>{assert.equal(options.activate,false);physical.prepared++;physical.releases.set(s.deploymentId,{commitSha:'b'.repeat(40)});await hooks.prepare?.(s);return {...evidence(s.deploymentId),previousReleaseId:releaseA};},
  inspectRetainedRelease:async s=>{assert.ok(physical.releases.has(s.releaseId));assert.equal(physical.releases.get(s.releaseId).commitSha,s.commitSha);return evidence(s.releaseId);},
  publishPrepared:async(s,o)=>{assert.equal(physical.current,o.expectedPreviousReleaseId);physical.current=s.deploymentId;physical.published++;return evidence(s.deploymentId);},
  switchRetainedRelease:async s=>{assert.equal(physical.current,s.currentReleaseId);assert.ok(physical.releases.has(s.releaseId));physical.current=s.releaseId;return evidence(s.releaseId);},
  inspectCompensation:async()=>({reason:'website_node_release_compensation_pending'}),
  inspectOperationReleaseAbsence:async s=>({satisfied:!physical.releases.has(s.deploymentId)}),
  discardOperationRelease:async s=>{assert.equal(physical.current,s.previousReleaseId);physical.releases.delete(s.deploymentId);physical.discarded++;return{satisfied:true};},
  finalizeRetention:async()=>{physical.retention++;}};
 const environmentManager={apply:async s=>{physical.values=structuredClone(s.values);physical.revision=s.environmentRevision;return{satisfied:true};}};
 const runtimeManager={captureEnvironment:async()=>({version:1,applicationId,releaseId:physical.current,runtime:app.activeRuntime,content:websitePassengerEnvironmentInternals.renderInclude(applicationId,physical.revision,physical.values)}),
 capturedPassengerEnvironment:({savedRuntime})=>({values:Object.fromEntries([...savedRuntime.content.matchAll(/passenger_env_var ([A-Z_]+) \"([^\"]*)\";/g)].map(m=>[m[1],m[2]])),environmentRevision:Number(savedRuntime.content.match(/revision (\d+)/)[1])}),
 applyEnvironment:async s=>{physical.values=structuredClone(s.values);physical.revision=s.environmentRevision;await hooks.apply?.(s);assert.equal(await s.verifyHealth(),true);return{verified:true};},
 restoreEnvironment:async s=>{assert.equal(s.expectedCurrentContent,websitePassengerEnvironmentInternals.renderInclude(applicationId,physical.revision,physical.values));physical.values=Object.fromEntries([...s.savedRuntime.content.matchAll(/passenger_env_var ([A-Z_]+) \"([^\"]*)\";/g)].map(m=>[m[1],m[2]]));physical.revision=Number(s.savedRuntime.content.match(/revision (\d+)/)[1]);return{verified:true};},
 inspectAppliedPassengerEnvironment:async s=>{await hooks.inspect?.(s);assert.ok((s.absentKeys??[]).every(key=>!Object.hasOwn(physical.values,key)));assert.equal(physical.current,s.application.currentReleaseId);assert.deepEqual(physical.values,s.values);assert.equal(physical.revision,s.environmentRevision);assert.equal(await s.verifyHealth(),true);return {verified:true,applicationId,releaseId:physical.current,environmentRevision:physical.revision,processes:1};}};
 const receipts=new Map();
 const nginxManager={previewDomain:s=>({configName:s.primaryDomain+'.conf',checksum:[target(releaseA).appRoot,`/var/lib/yunpanel/apps/${applicationId}/current`].includes(s.target.appRoot)?'a'.repeat(64):'b'.repeat(64)}),
  inspectActiveDomain:async s=>({satisfied:physical.routes.get(s.primaryDomain)===s.checksum}),
  stageDomain:async s=>({...nginxManager.previewDomain(s),bytes:500}),
  activateDomain:async s=>{receipts.set(s.primaryDomain,physical.routes.get(s.primaryDomain));physical.routes.set(s.primaryDomain,s.checksum);physical.reloads++;await hooks.activate?.(s);return{active:true};},
  compensateDomain:async s=>{assert.ok(receipts.has(s.primaryDomain));physical.routes.set(s.primaryDomain,receipts.get(s.primaryDomain));return{satisfied:true};}};
 const operation=createLocalPassengerReleaseOperation({...dependencies,baselineTargetOptions:{realpathFn:async value=>{assert.equal(value,`/var/lib/yunpanel/apps/${applicationId}/current`);return target(physical.current).appRoot;}},phaseStore,releaseManager,environmentManager,runtimeManager,nginxManager,
  provisioningRegistry:{getLatestForWebsite:async()=>null},certificateRegistry:{},healthInspector:{inspect:async()=>({satisfied:true})}});
 const queue=createApplicationDeployQueue(dependencies),rollback=createPassengerReleaseRollbackQueue(dependencies);
 const execution=job=>({jobId:job.id,serverId,resourceType:'application',resourceId:applicationId});
 const perform=async(job,reauthorize=async()=>true)=>{await jobRegistry.claimNext(serverId);return operation.execute(job.operation,job.payload,execution(job),{reauthorize});};
 const complete=async(job,result)=>{const terminal=await jobRegistry.complete({serverId,jobId:job.id,status:'succeeded',result});await reconcileCompletedJob({...dependencies,job:terminal,passengerReleasePhaseStore:phaseStore});return terminal;};
 return {...dependencies,phaseStore,physical,hooks,operation,queue,rollback,execution,perform,complete,domains,website};
}
test('Passenger daily Git publish reconciles native target/env/metadata and retained rollback never rebuilds or deletes either release',async t=>{
 const f=await fixture(t);const queued=await f.queue({applicationId,idempotencyKey:'passenger-source-operation-1'});
 assert.equal(queued.job.operation,OPERATIONS.APP_NODE_PASSENGER_DEPLOY);assert.equal(queued.job.payload.deploymentId,queued.job.id);
 const result=await f.perform(queued.job);assert.equal(f.physical.current,queued.job.id);assert.equal(f.physical.values.API_SECRET,secret);
 const terminal=await f.complete(queued.job,result);assert.equal(terminal.status,'succeeded');assert.equal(f.physical.retention,1);
 const record=await f.phaseStore.read(passengerReleasePhaseIdentity(queued.job.operation,queued.job.payload,f.execution(queued.job)));
 assert.equal((await readFile(f.phaseStore.file(record),'utf8')).includes(secret),false);
 const replay=await f.queue({applicationId,idempotencyKey:'passenger-source-operation-1'});assert.equal(replay.job.id,queued.job.id);assert.equal(replay.replayed,true);
 const back=await f.rollback({application:await f.applicationRegistry.getApplication(applicationId),releaseId:releaseA});
 const restored=await f.perform(back.job);await f.complete(back.job,restored);
 assert.equal(f.physical.current,releaseA);assert.equal(f.physical.prepared,1);assert.equal(f.physical.discarded,0);assert.equal(f.physical.releases.size,2);
 const app=await f.applicationRegistry.getApplication(applicationId);assert.equal(app.previousReleaseId,queued.job.id);assert.equal(app.proxyTarget,null);
 assert.equal((await f.runtimeBindingRegistry.getBinding(applicationId)).releaseId,releaseA);
});
test('Passenger authority revoked after build restores baseline and discards only the unaccepted candidate',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});let calls=0;
 await assert.rejects(f.perform(job,async()=>{if(++calls>1)throw Object.assign(new Error('revoked'),{code:'panel_job_actor_forbidden'});}),{code:'panel_job_actor_forbidden'});
 assert.equal(f.physical.published,0);assert.equal(f.physical.discarded,1);assert.equal(f.physical.current,releaseA);assert.deepEqual(f.physical.values,{});
 const terminal=await f.jobRegistry.complete({serverId,jobId:job.id,status:'failed',error:{code:'panel_job_actor_forbidden',message:'revoked'}});
 await reconcileCompletedJob({...f,job:terminal,passengerReleasePhaseStore:f.phaseStore});assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,null);
});
test('Passenger failure after the second Nginx activation restores every route, pointer and old environment before clearing the active job',async t=>{
 const f=await fixture(t,{multiple:true});const {job}=await f.queue({applicationId});let n=0;
 f.hooks.activate=async()=>{if(++n===2)throw Object.assign(new Error('reload failed'),{code:'nginx_reload_failed'});};
 await assert.rejects(f.perform(job),{code:'nginx_reload_failed'});assert.equal(f.physical.current,releaseA);assert.equal(f.physical.discarded,1);
 assert.ok([...f.physical.routes.values()].every(s=>s==='a'.repeat(64)));assert.deepEqual(f.physical.values,{});
 const record=await f.phaseStore.read(passengerReleasePhaseIdentity(job.operation,job.payload,f.execution(job)));assert.equal(record.phase,'compensated');
});
test('Passenger publication with a metadata failure retains its guard and recovers from native evidence without rebuilding',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});const original=f.runtimeBindingRegistry.activate;let failOnce=true;
 f.runtimeBindingRegistry.activate=async(...args)=>{if(failOnce){failOnce=false;throw new Error('store unavailable');}return original(...args);};
 await assert.rejects(f.perform(job),{code:'passenger_release_reconciliation_required'});
 const terminal=await f.jobRegistry.complete({serverId,jobId:job.id,status:'failed',error:{code:'passenger_release_reconciliation_required',message:'requires inspection'}});
 await assert.rejects(reconcileCompletedJob({...f,job:terminal,passengerReleasePhaseStore:f.phaseStore}));
 assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,job.id);
 const proof=await f.operation.inspectRecovery(job.operation,job.payload,f.execution(job));assert.equal(proof.releaseId,job.id);
 await reconcileCompletedJob({...f,job:terminal,passengerReleasePhaseStore:f.phaseStore});
 assert.equal(f.physical.prepared,1);assert.equal(f.physical.current,job.id);assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,null);
});
test('Passenger queued desired state or foreign Website drift is rejected before building and public results cannot carry secrets',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});f.website.revision++;
 await assert.rejects(f.perform(job),{code:'passenger_release_scope_drift'});assert.equal(f.physical.prepared,0);assert.equal(f.physical.current,releaseA);
 const another=await fixture(t);const queued=await another.queue({applicationId});const result=await another.perform(queued.job);
 await assert.rejects(another.jobRegistry.complete({serverId,jobId:queued.job.id,status:'succeeded',result:{...result,password:secret}}),{code:'invalid_job_result'});
});

async function recoveryInputs(f,job){
 const registry={...f.jobRegistry,beginReconciliation:async({serverId,jobId})=>({serverId,jobId,pending:true}),
  acknowledgeReconciliation:async({serverId,jobId})=>({serverId,jobId,status:(await f.jobRegistry.getJob(jobId)).status,acknowledged:true})};
 return {serverId,jobId:job.id,jobRegistry:registry,operation:f.operation,dependencies:f,
  serviceStatus:async()=>({apiActive:false,agentActive:false}),
  loadJobContext:async key=>{const current=await f.jobRegistry.getJob(key);return {...current,payload:current.payload};},
  inspect:async()=>({jobs:[{jobId:job.id,serverId,operation:job.operation,resourceType:'application',resourceId:applicationId,status:(await f.jobRegistry.getJob(job.id)).status}]})};
}
test('Stopped-consumer Passenger recovery completes a lost result from exact native evidence without re-running Git',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});await f.perform(job);
 const inputs=await recoveryInputs(f,job);
 await assert.rejects(recoverPassengerRelease({...inputs,serviceStatus:async()=>({apiActive:true,agentActive:false})}),{code:'passenger_release_recovery_consumers_must_be_stopped'});
 await assert.rejects(recoverPassengerRelease({...inputs,loadJobContext:async key=>{const context=await inputs.loadJobContext(key);context.payload={...context.payload,websiteId:id('7')};return context;}}));
 assert.equal((await f.jobRegistry.getJob(job.id)).status,'running');
 const proof=await recoverPassengerRelease(inputs);assert.equal(proof.status,'succeeded');assert.equal(f.physical.prepared,1);
 assert.equal((await f.jobRegistry.getJob(job.id)).status,'succeeded');assert.equal(f.physical.current,job.id);
});
test('Stopped-consumer Passenger compensation verifies old native state before terminalizing and acknowledging failed work',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});f.hooks.activate=async()=>{throw Object.assign(new Error('reload failed'),{code:'nginx_reload_failed'});};
 await assert.rejects(f.perform(job),{code:'nginx_reload_failed'});
 const proof=await recoverPassengerRelease({...await recoveryInputs(f,job),compensationOnly:true});
 assert.equal(proof.status,'failed');assert.equal(f.physical.current,releaseA);assert.equal(f.physical.releases.size,1);
 assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,null);
});

test('Passenger recovery repairs only its own staged Domain after markApplied failure and refuses a substituted checksum',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});const apply=f.domainRegistry.markApplied;let failOnce=true;
 f.domainRegistry.markApplied=async(...args)=>{if(failOnce){failOnce=false;throw new Error('domain catalog write unavailable');}return apply(...args);};
 await assert.rejects(f.perform(job),{code:'passenger_release_reconciliation_required'});
 assert.equal(f.domains[0].state,'staged');assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,job.id);
 const saved=f.domains[0].stagedChecksum;f.domains[0].stagedChecksum='c'.repeat(64);
 await assert.rejects(f.operation.inspectRecovery(job.operation,job.payload,f.execution(job)),{code:'passenger_release_domain_drift'});
 assert.equal(f.domains[0].stagedChecksum,'c'.repeat(64));f.domains[0].stagedChecksum=saved;
 await f.operation.inspectRecovery(job.operation,job.payload,f.execution(job));assert.equal(f.domains[0].state,'active');
 assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,null);assert.equal(f.physical.prepared,1);
});

test('Stopped-consumer compensation resumes a crash after entering compensating without losing the saved original state',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});f.hooks.activate=async()=>{throw Object.assign(new Error('reload failed'),{code:'nginx_reload_failed'});};
 await assert.rejects(f.perform(job),{code:'nginx_reload_failed'});
 const identity=passengerReleasePhaseIdentity(job.operation,job.payload,f.execution(job));
 const previous=await f.phaseStore.read(identity);assert.equal(previous.phase,'compensated');
 await f.phaseStore.save(identity,{phase:'compensating'},{expectedPhase:'compensated'});
 const proof=await recoverPassengerRelease({...await recoveryInputs(f,job),compensationOnly:true});
 assert.equal(proof.status,'failed');assert.equal((await f.phaseStore.read(identity)).phase,'compensated');
 assert.equal(f.physical.current,releaseA);assert.equal(f.physical.releases.size,1);assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,null);
});

test('Passenger interrupted compensation refuses a foreign native environment without erasing it or acknowledging the active guard',async t=>{
 const f=await fixture(t);const {job}=await f.queue({applicationId});f.hooks.activate=async()=>{throw Object.assign(new Error('reload failed'),{code:'nginx_reload_failed'});};
 await assert.rejects(f.perform(job),{code:'nginx_reload_failed'});
 const identity=passengerReleasePhaseIdentity(job.operation,job.payload,f.execution(job));await f.phaseStore.save(identity,{phase:'compensating'},{expectedPhase:'compensated'});
 f.physical.values={FOREIGN_VALUE:'unrelated native change'};f.physical.revision=123;
 await assert.rejects(f.operation.compensateRecovery(job.operation,job.payload,f.execution(job)),{code:'passenger_release_compensation_environment_drift'});
 assert.deepEqual(f.physical.values,{FOREIGN_VALUE:'unrelated native change'});assert.equal(f.physical.revision,123);
 assert.equal((await f.phaseStore.read(identity)).phase,'compensating');assert.equal((await f.applicationRegistry.getApplication(applicationId)).activeDeploymentId,job.id);
});

test('Passenger daily publisher checks removed managed keys and compensation checks job-added keys in the native process proof',async t=>{
 const f=await fixture(t);await f.applicationEnvironmentRegistry.setVariable({applicationId,key:'REMOVED_SECRET',value:'prior-private-value',secret:true});
 await f.applicationEnvironmentRegistry.markApplied({applicationId,revision:2,releaseId:releaseA});f.physical.values={API_SECRET:secret,REMOVED_SECRET:'prior-private-value'};f.physical.revision=2;
 await f.applicationEnvironmentRegistry.deleteVariable(applicationId,'REMOVED_SECRET');
 const seen=[];f.hooks.inspect=async s=>seen.push({releaseId:s.application.currentReleaseId,absentKeys:s.absentKeys});
 const {job}=await f.queue({applicationId});await f.perform(job);
 assert.ok(seen.some(s=>s.releaseId===job.id && s.absentKeys.includes('REMOVED_SECRET')));
 const other=await fixture(t);const calls=[];other.hooks.inspect=async s=>calls.push(s.absentKeys??[]);
 other.hooks.activate=async()=>{throw Object.assign(new Error('reload failed'),{code:'nginx_reload_failed'});};
 const queued=await other.queue({applicationId});await assert.rejects(other.perform(queued.job),{code:'nginx_reload_failed'});
 assert.ok(calls.some(keys=>keys.includes('API_SECRET')));
});

test('Passenger initial current-path binding resolves only to the same owned physical release before daily publication',async t=>{
 const f=await fixture(t),binding=await f.runtimeBindingRegistry.getBinding(applicationId);
 const currentRoot=`/var/lib/yunpanel/apps/${applicationId}/current`;
 await f.runtimeBindingRegistry.activate({...binding,passengerTarget:{...binding.passengerTarget,appRoot:currentRoot,documentRoot:currentRoot}}, {expectedRevision:binding.revision});
 const {job}=await f.queue({applicationId});await f.perform(job);assert.equal(f.physical.current,job.id);assert.equal(f.physical.prepared,1);
});

test('Passenger current-path baseline refuses a foreign resolved release or arbitrary binding path before touching a candidate',async t=>{
 const f=await fixture(t),application=await f.applicationRegistry.getApplication(applicationId),binding=await f.runtimeBindingRegistry.getBinding(applicationId);
 const release={applicationId,currentReleaseId:releaseA,releaseId:releaseA,unixUser:f.website.unixUser,...binding.passengerTarget};
 const current=`/var/lib/yunpanel/apps/${applicationId}/current`;
 const alias={...binding,passengerTarget:{...binding.passengerTarget,appRoot:current,documentRoot:current}};
 await assert.rejects(verifyPassengerReleaseBaselineTarget({application,binding:alias,release},{realpathFn:async()=>`/var/lib/yunpanel/apps/${applicationId}/releases/${id('7')}`}),{code:'passenger_release_baseline_target_unverified'});
 let read=false;await assert.rejects(verifyPassengerReleaseBaselineTarget({application,binding:{...alias,passengerTarget:{...alias.passengerTarget,appRoot:'/foreign/current'}},release},
  {realpathFn:async()=>{read=true;return release.appRoot;}}),{code:'passenger_release_baseline_target_unverified'});assert.equal(read,false);
});
