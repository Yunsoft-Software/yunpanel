import assert from 'node:assert/strict';import test from 'node:test';
import {parseJobRecoveryArguments,runJobRecoveryCli} from '../../../scripts/job-recovery.mjs';
for(const action of ['recover-passenger-release','compensate-passenger-release']){
 test(`${action} is exact-job confirmed packaged root recovery and carries no force option`,async()=>{
  assert.throws(()=>parseJobRecoveryArguments([action,'server','job']));
  assert.throws(()=>parseJobRecoveryArguments([action,'server','job','--force']));
  assert.deepEqual(parseJobRecoveryArguments([action,'server','job','--confirm']),{action,serverId:'server',jobId:'job',confirm:true});
  let calls=0;const input={argv:[action,'server','job','--confirm'],filePath:'/usr/lib/yunpanel/scripts/job-recovery.mjs',uid:0,
   stdout:{write:()=>{}},recoveryAudit:()=>{},recoverPassengerRelease:async options=>{calls++;assert.equal(options.compensationOnly,action==='compensate-passenger-release');
    assert.equal(options.serverId,'server');assert.equal(options.jobId,'job');return{serverId:'server',jobId:'job',status:'failed',statePaths:{}};}};
  await runJobRecoveryCli(input);assert.equal(calls,1);
  await assert.rejects(runJobRecoveryCli({...input,uid:1001}));
  await assert.rejects(runJobRecoveryCli({...input,filePath:'/source/scripts/job-recovery.mjs'}));assert.equal(calls,1);
 });
}
