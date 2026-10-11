import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createJobRegistry } from '../src/job-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createLocalJobExecutor } from '../src/local-job-executor.js';
import { createSystemWatchdogService } from '../src/system-watchdog-service.js';
import { reconcileTerminalRecovery } from '../src/job-recovery-command.js';
import { OPERATIONS } from '@yunpanel/protocol';

test('watchdog keeps real durable work running past five minutes and the executor saves its verified success', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-watchdog-executor-'));
 let now=1700000000000;
 const registry=createDurableJobRegistry({filePath:path.join(root,'jobs.json'),now:()=>now,registryFactory:options=>createJobRegistry(options)});
 const serverId='long-operation-server';
 const job=await registry.enqueue({serverId,type:'system.packages.inspect',operation:OPERATIONS.SYSTEM_PACKAGES_INSPECT,payload:{},resourceType:'system',resourceId:serverId});
 let release,entered;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const executor=createLocalJobExecutor({serverId,jobRegistry:registry,executeOperation:async()=>{entered();await gate;return {packageName:'yunpanel',installed:false,installedVersion:null,candidateVersion:null,updateAvailable:false};},reconcileCompletedJob:async()=>({reconciled:true})});
 const operation=executor.runOnce();await started;
 t.after(async()=>{release();await operation.catch(()=>{});await executor.stop();await rm(root,{recursive:true,force:true});});
 now+=400000;
 const watchdog=createSystemWatchdogService({jobRegistry:registry,now:()=>now,inspectServices:async()=>[],serviceControl:async()=>{throw new Error('No service mutation expected');}});
 const report=await watchdog.check({serverId});
 assert.ok(report.incidents.some(i=>i.code==='job_stalled'));
 assert.equal(report.lastRecoveryResults.recovered.length,0);
 assert.equal((await registry.getJob(job.id)).status,'running');
 await assert.rejects(registry.enqueue({serverId,type:'system.packages.inspect',operation:OPERATIONS.SYSTEM_PACKAGES_INSPECT,payload:{},resourceType:'system',resourceId:serverId}),e=>e.code==='system_job_conflict');
 release();const terminal=await operation;
 assert.equal(terminal.job.status,'succeeded');assert.equal((await registry.getJob(job.id)).status,'succeeded');
 assert.equal(executor.failure(),null);
 assert.equal(registry.recovery(),null);
});

test('the real terminal recovery transaction can inspect and acknowledge its durable store under one outer lock',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'yp-terminal-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const registry=createDurableJobRegistry({filePath:path.join(root,'jobs.json'),registryFactory:options=>createJobRegistry(options)});
 const serverId='terminal-recovery-server';const job=await registry.enqueue({serverId,type:'system.packages.inspect',operation:OPERATIONS.SYSTEM_PACKAGES_INSPECT,payload:{},resourceType:'system',resourceId:serverId});
 await registry.claimNext(serverId);await registry.beginReconciliation({serverId,jobId:job.id});
 await registry.complete({serverId,jobId:job.id,status:'failed',error:{code:'apt_inspection_failed',message:'private details must stay hidden'}});
 assert.ok(registry.recovery());
 const result=await reconcileTerminalRecovery({serverId,jobId:job.id,jobRegistry:registry,domainRegistry:{},certificateRegistry:{},applicationRegistry:{},serviceStatus:async()=>({apiActive:false,agentActive:false})});
 assert.equal(result.reconciled,true);assert.equal((await registry.getJob(job.id)).status,'failed');
 assert.equal(registry.recovery(),null);assert.equal(registry.recoveryRecord().jobs.length,0);
});
