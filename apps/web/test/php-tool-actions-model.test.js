import assert from 'node:assert/strict';
import test from 'node:test';
import { phpToolsScope, phpToolActionPreview, phpToolActionJob, phpToolQueueResult } from '../src/workspace/php-tools-model.js';

const scope={websiteId:'11111111-1111-4111-8111-111111111111',serverId:'33333333-3333-4333-8333-333333333333',applicationId:'22222222-2222-4222-8222-222222222222',unixUser:'yunapp-123456789abc'};
const preview={version:1,...scope,websiteRevision:4,actionId:'wp.cache.flush',tool:'wp-cli',command:'cache',args:['flush'],timeout:60000,label:'WordPress önbelleğini temizle',impact:'WordPress nesne önbelleği temizlenir. Site dosyaları ve veritabanı şeması değiştirilmez.',previewDigest:'a'.repeat(64),confirmation:`php-tool:${scope.websiteId}:wp.cache.flush:${'a'.repeat(64)}`};
const job={id:'job-12345678',serverId:scope.serverId,type:'website.php.action',operation:'website.php.action',resourceType:'application',resourceId:scope.applicationId,status:'queued',createdAt:'2026-09-25T00:00:00.000Z',startedAt:null,finishedAt:null,attempts:0,result:null,error:null};

test('action preview keeps only reviewed display fields',()=>{
 const value=phpToolActionPreview(preview,phpToolsScope(scope),'wp.cache.flush');
 assert.equal(value.actionId,'wp.cache.flush'); assert.equal(Object.hasOwn(value,'command'),false);
});
test('queued job rejects private payload exposure',()=>{
 assert.throws(()=>phpToolActionJob({...job,payload:{actorSessionId:'secret'}},scope));
});
test('queue response binds action and job to same Website/Application',()=>{
 const value=phpToolQueueResult({action:{tool:'wp-cli',actionId:'wp.cache.flush',websiteId:scope.websiteId,applicationId:scope.applicationId,websiteRevision:4},job},scope,phpToolActionPreview(preview,scope));
 assert.equal(value.job.id,'job-12345678');
});
test('succeeded job must carry matching safe result',()=>{
 assert.throws(()=>phpToolActionJob({...job,status:'succeeded',result:{version:1,websiteId:scope.websiteId,applicationId:scope.applicationId,actionId:'composer.dump-autoload',websiteRevision:4,previewDigest:'a'.repeat(64),completed:true,sideEffects:true}},scope,'wp.cache.flush'));
});
