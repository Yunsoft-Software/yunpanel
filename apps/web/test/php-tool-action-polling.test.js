import assert from 'node:assert/strict';
import test from 'node:test';
import { phpToolActionJob } from '../src/workspace/php-tools-model.js';

const scope={websiteId:'11111111-1111-4111-8111-111111111111',serverId:'33333333-3333-4333-8333-333333333333',applicationId:'22222222-2222-4222-8222-222222222222',unixUser:'yunapp-123456789abc'};
const job={id:'job-12345678',serverId:scope.serverId,operation:'website.php.action',resourceType:'application',resourceId:scope.applicationId,status:'running',result:null};

test('action polling accepts only the originally queued job id',()=>{
 assert.equal(phpToolActionJob(job,scope,'wp.cache.flush','job-12345678').id,'job-12345678');
 assert.throws(()=>phpToolActionJob({...job,id:'job-87654321'},scope,'wp.cache.flush','job-12345678'));
});
