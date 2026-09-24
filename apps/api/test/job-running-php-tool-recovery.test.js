import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverRunningPhpTool } from '../src/job-running-php-tool-recovery.js';

const serverId='33333333-3333-4333-8333-333333333333', jobId='php-action-job-01', applicationId='22222222-2222-4222-8222-222222222222';
const payload={websiteId:'11111111-1111-4111-8111-111111111111',applicationId,unixUser:'yunapp-123456789abc',expectedWebsiteRevision:4,actionId:'wp.cache.flush',previewDigest:'a'.repeat(64),confirmation:`php-tool:11111111-1111-4111-8111-111111111111:wp.cache.flush:${'a'.repeat(64)}`};
const result={version:1,websiteId:payload.websiteId,applicationId,unixUser:payload.unixUser,actionId:payload.actionId,websiteRevision:4,previewDigest:payload.previewDigest,completed:true,sideEffects:true};

function harness({ receipt=true }={}) {
  const calls=[];
  const job={id:jobId,serverId,status:'running',operation:'website.php.action',resourceType:'application',resourceId:applicationId};
  return {
    calls,
    args:{
      serverId,jobId,
      serviceStatus:async()=>({apiActive:false,agentActive:false}),
      inspect:async()=>({jobs:[{jobId,serverId,status:'running',operation:'website.php.action',resourceType:'application',resourceId:applicationId}]}),
      loadJobContext:async()=>({...job,payload}),
      readOperationReceipt:async()=>receipt?{version:1,serverId,jobId,payload,result}:null,
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
