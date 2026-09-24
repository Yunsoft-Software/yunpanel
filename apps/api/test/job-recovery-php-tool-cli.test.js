import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobRecoveryArguments, runJobRecoveryCli } from '../../../scripts/job-recovery.mjs';

test('CLI parser accepts explicit PHP tool receipt recovery', () => {
  assert.deepEqual(parseJobRecoveryArguments(['recover-php-tool','server-1','job-12345678','--confirm']), {
    action:'recover-php-tool',serverId:'server-1',jobId:'job-12345678',confirm:true,
  });
});

test('CLI dispatches recover-php-tool only in packaged confirmed mode', async () => {
  const writes=[]; let args=null;
  const result=await runJobRecoveryCli({
    argv:['recover-php-tool','server-1','job-12345678','--confirm'],
    filePath:'/usr/lib/yunpanel/scripts/job-recovery.mjs',uid:0,env:{},cwd:'/tmp',
    recoverPhpTool:async(value)=>{args=value;return{
      serverId:value.serverId,jobId:value.jobId,status:'succeeded',
      operation:'website.php.action',recoveryMethod:'verified_php_tool_receipt',
      statePaths:{jobStore:'/var/lib/yunpanel/jobs.json',recoveryStore:'/var/lib/yunpanel/jobs.recovery.json'},
    };},
    recoveryAudit:null,
    stdout:{write:(value)=>writes.push(value)},
  });
  assert.equal(args.serverId,'server-1'); assert.equal(result.operation,'website.php.action');
  assert.match(writes.join(''),/method=verified_php_tool_receipt/);
});
