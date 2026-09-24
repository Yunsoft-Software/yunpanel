import assert from 'node:assert/strict';
import test from 'node:test';
import { runRunningPhpToolRecoveryFromStores } from '../src/job-running-php-tool-recovery-runtime.js';

const serverId='33333333-3333-4333-8333-333333333333', jobId='php-action-job-01';

test('runtime composes durable context and receipt readers without executing a command', async () => {
  const reads=[];
  const result = await runRunningPhpToolRecoveryFromStores({
    serverId, jobId, hostname:'panel.test', env:{}, cwd:'/tmp/yunpanel-recovery-test',
    serverRegistryFactory:()=>({init:async()=>{},getServer:async()=>({id:serverId,hostname:'panel.test'})}),
    jobRegistryFactory:()=>({}),
    durableRegistryFactory:()=>({marker:'jobs'}),
    recoveryStoreFactory:()=>({}),
    contextReaderFactory:()=>({read:async(id)=>{reads.push(['context',id]);return{id};}}),
    receiptStoreFactory:()=>({read:async(s,j)=>{reads.push(['receipt',s,j]);return{receipt:true};}}),
    serviceStatus:async()=>({apiActive:false,agentActive:false}),
    recoverCommand:async(args)=>{
      assert.equal(args.jobRegistry.marker,'jobs');
      assert.deepEqual(await args.loadJobContext(jobId),{id:jobId});
      assert.deepEqual(await args.readOperationReceipt(serverId,jobId),{receipt:true});
      return{serverId,jobId,operation:'website.php.action',status:'succeeded',recoveryMethod:'verified_php_tool_receipt',reconciled:true};
    },
  });
  assert.equal(result.statePaths.jobStore.endsWith('job-registry.json'),true);
  assert.deepEqual(reads,[['context',jobId],['receipt',serverId,jobId]]);
});

test('runtime rejects receipt stores without read()', async () => {
  await assert.rejects(()=>runRunningPhpToolRecoveryFromStores({
    serverId,jobId,hostname:'panel.test',env:{},cwd:'/tmp/yunpanel-recovery-test',
    serverRegistryFactory:()=>({init:async()=>{},getServer:async()=>({id:serverId,hostname:'panel.test'})}),
    jobRegistryFactory:()=>({}),durableRegistryFactory:()=>({}),recoveryStoreFactory:()=>({}),
    contextReaderFactory:()=>({read:async()=>null}),receiptStoreFactory:()=>({}),
    serviceStatus:async()=>({apiActive:false,agentActive:false}),recoverCommand:async()=>null,
  }),(e)=>e.code==='job_recovery_php_tool_receipt_invalid');
});
