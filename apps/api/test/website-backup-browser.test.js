import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebsiteBackupBrowser } from '../src/website-backup-browser.js';

const websiteId='11111111-1111-4111-8111-111111111111';
const serverId='22222222-2222-4222-8222-222222222222';
const repoId='33333333-3333-4333-8333-333333333333';

function browser({snapshotFailure=false}={}) {
 return createWebsiteBackupBrowser({
  websiteRegistry:{getWebsite:async(id)=>id===websiteId?{id:websiteId,serverId,runtimeType:'php'}:null},
  websiteBackupSetProvider:{getWebsiteBackupSet:async()=>({version:1,website:{id:websiteId,runtimeType:'php'},digest:'a'.repeat(64),databases:[{}],mail:[{}],dns:[{}],targetPaths:['/secret/path'],composeHooks:{enabled:false}})},
  resticRepositoryRegistry:{
   listRepositories:async()=>[{id:repoId,serverId,name:'primary',backend:'local',target:'/secret/repo',status:'ready',retentionPolicy:{keepLast:5},lastCheckedAt:'2026-09-25T00:00:00.000Z',lastSnapshotAt:'2026-09-25T00:10:00.000Z',error:null}],
   listSnapshots:async(id,options)=>{assert.equal(id,repoId);assert.deepEqual(options,{tags:[`website:${websiteId}`]});if(snapshotFailure)throw new Error('private');return[
    {id:'a'.repeat(64),shortId:'aaaaaaaa',time:'2026-09-25T00:10:00.000Z',paths:['/private'],tags:[`website:${websiteId}`],hostname:'private-host',username:'root'},
   ];},
  },
  localServerId:serverId,
 });
}

test('site backup browser projects repositories and snapshots without host paths or errors',async()=>{
 const value=await browser().browse(websiteId);
 assert.equal(value.websiteId,websiteId); assert.equal(value.backupSet.databaseCount,1);
 assert.equal(value.backupSet.pathCount,1); assert.equal(value.repositories.length,1);
 const repo=value.repositories[0]; assert.equal(repo.name,'primary'); assert.equal(repo.snapshots.length,1);
 assert.equal(Object.hasOwn(repo,'target'),false); assert.equal(Object.hasOwn(repo,'error'),false);
 assert.equal(Object.hasOwn(repo.snapshots[0],'paths'),false); assert.equal(Object.hasOwn(repo.snapshots[0],'hostname'),false);
});
test('repository snapshot failure is visible but does not expose raw error',async()=>{
 const repo=(await browser({snapshotFailure:true}).browse(websiteId)).repositories[0];
 assert.equal(repo.snapshotStatus,'error'); assert.deepEqual(repo.snapshots,[]);
});
test('foreign or missing Website cannot browse server repositories',async()=>{
 await assert.rejects(()=>browser().browse('44444444-4444-4444-8444-444444444444'),(e)=>e.code==='website_not_found');
});
