import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recoverRunningPhpTool } from '../src/job-running-php-tool-recovery.js';
import { createJobRegistry, JobRegistryError } from '../src/job-registry.js';
import { createDurableJobRegistry } from '../src/durable-job-registry.js';
import { createWebsitePhpToolOperationReceiptStore } from '../src/website-php-tool-operation-receipt.js';

const serverId='33333333-3333-4333-8333-333333333333', jobId='php-action-job-01', applicationId='22222222-2222-4222-8222-222222222222';
const payload={websiteId:'11111111-1111-4111-8111-111111111111',applicationId,unixUser:'yunapp-123456789abc',expectedWebsiteRevision:4,actorSessionId:'44444444-4444-4444-8444-444444444444',actorUserId:'55555555-5555-4555-8555-555555555555',actorRole:'site_manager',actionId:'wp.cache.flush',previewDigest:'a'.repeat(64),confirmation:`php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`};
const result={version:1,websiteId:payload.websiteId,applicationId,unixUser:payload.unixUser,actionId:payload.actionId,websiteRevision:4,previewDigest:payload.previewDigest,completed:true,sideEffects:true};

function harness({ receipt=true, actorRole=payload.actorRole }={}) {
  const calls=[];
  const job={id:jobId,serverId,status:'running',operation:'website.php.action',resourceType:'application',resourceId:applicationId};
  const actorPayload={...payload,actorRole};
  return {
    calls,
    args:{
      serverId,jobId,
      serviceStatus:async()=>({apiActive:false,agentActive:false}),
      inspect:async()=>({jobs:[{jobId,serverId,status:'running',operation:'website.php.action',resourceType:'application',resourceId:applicationId}]}),
      loadJobContext:async()=>({...job,payload:actorPayload}),
      readOperationReceipt:async()=>receipt?{version:1,serverId,jobId,payload:actorPayload,result}:null,
      jobRegistry:{
        getJob:async()=>job,
        beginReconciliation:async(v)=>{calls.push(['begin',v]);return{...v,status:'running',pending:true};},
        complete:async(v)=>{calls.push(['complete',v]);return{...job,status:'succeeded'};},
        acknowledgeReconciliation:async(v)=>{calls.push(['ack',v]);return{...v,status:'succeeded',acknowledged:true};},
      },
    },
  };
}

test('verified receipt completes running action without re-executing command', async()=>{
  const h=harness(); const value=await recoverRunningPhpTool(h.args);
  assert.equal(value.recoveryMethod,'verified_php_tool_receipt');
  assert.deepEqual(h.calls.map(([name])=>name),['begin','complete','ack']);
});

test('verified tenant receipt recovers reseller and customer jobs without re-execution', async(t)=>{
  for (const actorRole of ['reseller','customer']) {
    await t.test(actorRole, async()=>{
      const h=harness({actorRole});
      const value=await recoverRunningPhpTool(h.args);
      assert.equal(value.recoveryMethod,'verified_php_tool_receipt');
      assert.deepEqual(h.calls.map(([name])=>name),['begin','complete','ack']);
    });
  }
});

test('missing receipt leaves running job unresolved', async()=>{
  const h=harness({receipt:false});
  await assert.rejects(()=>recoverRunningPhpTool(h.args),(e)=>e.code==='job_php_tool_recovery_receipt_missing');
  assert.equal(h.calls.length,0);
});

test('recovery requires stopped consumers', async()=>{
  const h=harness(); h.args.serviceStatus=async()=>({apiActive:true,agentActive:false});
  await assert.rejects(()=>recoverRunningPhpTool(h.args),(e)=>e.code==='job_php_tool_recovery_consumers_must_be_stopped');
  assert.equal(h.calls.length,0);
});

test('mismatched receipt evidence fails closed and prevents unverified re-execution', async () => {
  const h = harness();
  h.args.readOperationReceipt = async () => ({
    version: 1,
    serverId,
    jobId,
    payload: { ...payload, actionId: 'composer.dump-autoload' },
    result: { ...result, actionId: 'composer.dump-autoload' },
  });
  await assert.rejects(
    () => recoverRunningPhpTool(h.args),
    (error) => error.code === 'job_php_tool_recovery_evidence_mismatch',
  );
  assert.equal(h.calls.length, 0);
});

test('multi-process independent API instances safely coordinate enqueue and claim on shared JSON store without stale state overwrite', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-test-'));
  try {
    const jobStorePath = path.join(tmpDir, 'job-registry.json');
    const proc1 = createJobRegistry({ filePath: jobStorePath });
    const proc2 = createJobRegistry({ filePath: jobStorePath });
    await proc1.init();
    await proc2.init();

    // 1. Both processes enqueue non-conflicting jobs concurrently
    const [enq1, enq2] = await Promise.all([
      proc1.enqueue({
        serverId,
        type: 'website.php.action',
        operation: 'website.php.action',
        payload: { ...payload, applicationId: '22222222-2222-4222-8222-222222222222' },
        resourceType: 'application',
        resourceId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: 'idem-app-1-key-00001',
      }),
      proc2.enqueue({
        serverId,
        type: 'website.php.action',
        operation: 'website.php.action',
        payload: { ...payload, applicationId: '33333333-3333-4333-8333-333333333333' },
        resourceType: 'application',
        resourceId: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'idem-app-2-key-00002',
      }),
    ]);

    assert.ok(enq1.id);
    assert.ok(enq2.id);
    assert.notEqual(enq1.id, enq2.id);

    // Verify durable permissions (0600)
    const stat = await fs.stat(jobStorePath);
    assert.equal(stat.mode & 0o777, 0o600);

    // Verify both jobs exist when inspected from either process
    const jobs1 = await proc1.listJobs({ serverId });
    const jobs2 = await proc2.listJobs({ serverId });
    assert.equal(jobs1.length, 2);
    assert.equal(jobs2.length, 2);

    // 2. Cross-process resource conflict: while app-1 has a queued job, proc2 cannot enqueue for app-1
    await assert.rejects(
      proc2.enqueue({
        serverId,
        type: 'website.php.action',
        operation: 'website.php.action',
        payload: { ...payload, applicationId: '22222222-2222-4222-8222-222222222222' },
        resourceType: 'application',
        resourceId: '22222222-2222-4222-8222-222222222222',
        idempotencyKey: 'idem-app-1-conflict-00001',
      }),
      (err) => err instanceof JobRegistryError && err.code === 'application_job_conflict',
    );

    // 3. Cross-process claim race condition: two processes try to claimNext concurrently
    // There are 2 queued jobs. Each process should claim exactly one unique job.
    const [c1, c2] = await Promise.all([
      proc1.claimNext(serverId),
      proc2.claimNext(serverId),
    ]);
    assert.ok(c1?.job?.id);
    assert.ok(c2?.job?.id);
    assert.notEqual(c1.job.id, c2.job.id);
    assert.equal(c1.job.status, 'running');
    assert.equal(c2.job.status, 'running');

    // Trying to claim next should return null now
    const c3 = await proc1.claimNext(serverId);
    assert.equal(c3, null);

    // 4. Cross-process state reload: proc1 sees c2.job as running
    const observedRunning = await proc1.getJob(c2.job.id);
    assert.equal(observedRunning.status, 'running');

    // 5. Cross-process completion: proc2 completes c2.job
    const completedJob = await proc2.complete({
      serverId,
      jobId: c2.job.id,
      status: 'succeeded',
      result: { ...result, applicationId: '33333333-3333-4333-8333-333333333333' },
    });
    assert.equal(completedJob.status, 'succeeded');

    // Proc1 reads and sees succeeded status with result
    const observedSucceeded = await proc1.getJob(c2.job.id);
    assert.equal(observedSucceeded.status, 'succeeded');
    assert.equal(observedSucceeded.result.completed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('claimNext fail-closed cancels job on tenant session revocation and commits across processes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunpanel-job-revoke-'));
  try {
    const jobStorePath = path.join(tmpDir, 'job-registry.json');
    const proc1 = createJobRegistry({ filePath: jobStorePath });
    const proc2 = createJobRegistry({ filePath: jobStorePath });
    await proc1.init();
    await proc2.init();

    const enq = await proc1.enqueue({
      serverId,
      type: 'website.php.action',
      operation: 'website.php.action',
      payload,
      resourceType: 'application',
      resourceId: applicationId,
      authorization: { actorSessionId: '44444444-4444-4444-8444-444444444444', actorUserId: '55555555-5555-4555-8555-555555555555' },
    });

    const claimed = await proc2.claimNext(serverId, {
      reauthorize: async () => ({ authorized: false, message: 'Session revoked by admin' }),
    });

    assert.equal(claimed.cancelled, true);
    assert.equal(claimed.reason, 'job_tenant_reauthorization_failed');

    // Verified on disk by proc1
    const jobOnDisk = await proc1.getJob(enq.id);
    assert.equal(jobOnDisk.status, 'cancelled');
    assert.equal(jobOnDisk.error.code, 'job_tenant_reauthorization_failed');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('real DurableJobRegistry integrates with recoverRunningPhpTool and 0600 receipt store on restart recovery', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunpanel-durable-recovery-'));
  try {
    const jobStorePath = path.join(tmpDir, 'jobs.json');
    const receiptsRoot = path.join(tmpDir, 'receipts');
    const receiptStore = createWebsitePhpToolOperationReceiptStore({ root: receiptsRoot });

    // 1. Initial process runs and claims job to 'running'
    const initialRegistry = createDurableJobRegistry({
      filePath: jobStorePath,
      registryFactory: createJobRegistry,
    });
    await initialRegistry.init();

    const enq = await initialRegistry.enqueue({
      serverId,
      type: 'website.php.action',
      operation: 'website.php.action',
      payload,
      resourceType: 'application',
      resourceId: applicationId,
    });

    const claimed = await initialRegistry.claimNext(serverId);
    assert.equal(claimed.job.status, 'running');

    // 2. Write durable 0600 receipt from host action execution
    await receiptStore.write({
      serverId,
      jobId: enq.id,
      payload,
      result,
    });

    // 3. Process restarts (crash recovery): new DurableJobRegistry detects running jobs on init
    const recoveryRegistry = createDurableJobRegistry({
      filePath: jobStorePath,
      registryFactory: createJobRegistry,
    });
    await recoveryRegistry.init();

    const recoveryResult = await recoverRunningPhpTool({
      serverId,
      jobId: enq.id,
      jobRegistry: recoveryRegistry,
      loadJobContext: async () => ({ ...claimed.job, payload }),
      readOperationReceipt: (sId, jId) => receiptStore.read(sId, jId),
      serviceStatus: async () => ({ apiActive: false, agentActive: false }),
    });

    assert.equal(recoveryResult.recoveryMethod, 'verified_php_tool_receipt');
    assert.equal(recoveryResult.reconciled, true);

    const recoveredJob = await recoveryRegistry.getJob(enq.id);
    assert.equal(recoveredJob.status, 'succeeded');
    assert.equal(recoveredJob.result.completed, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
