import assert from 'node:assert/strict';
import test from 'node:test';
import {createWebsiteRemovalClient} from '../src/workspace/website-removal-client.js';
const scope={websiteId:'11111111-1111-4111-8111-111111111111',serverId:'22222222-2222-4222-8222-222222222222',label:'example.test'};
const bucket={status:'available',ids:[]};
const preview={version:1,operation:'website_remove',website:{id:scope.websiteId,serverId:scope.serverId,name:scope.label},
 plan:{domains:[],activeJobIds:[],additional:Object.fromEntries(['databases','sftpKeys','runtimeBindings','unixIdentities','logScopes','crons','backups'].map(key=>[key,bucket]))},
 hardBlockers:[],readyToStart:true,previewDigest:'a'.repeat(64),confirmation:'create-removal',sideEffects:false};
const operation={id:'ws-rem-fixture',websiteId:scope.websiteId,serverId:scope.serverId,label:scope.label,execution:{mode:'automatic'},
 previewDigest:preview.previewDigest,status:'pending',updatedAt:'2026-10-10T00:00:00.000Z',
 steps:[{id:'001:file_cleanup:app',kind:'file_cleanup',status:'pending'}],actions:{stepContinuationConfirmation:'step-token',runConfirmation:'run-token'}};
const removed={...operation,status:'removed',steps:[{...operation.steps[0],status:'succeeded'}],actions:{stepContinuationConfirmation:null,runConfirmation:null}};
function reached(client,predicate){return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{unsubscribe();reject(new Error('Expected client state was not reached'));},1500);
 const unsubscribe=client.subscribe(value=>{if(predicate(value)){clearTimeout(timer);unsubscribe();resolve(value);}});
});}
test('a single start POST is followed only by GET polling through completion',async()=>{
 const calls=[];let completed=0;const client=createWebsiteRemovalClient({scope,pollIntervalMs:100,onRemoved:()=>completed++,request:async(url,options={})=>{
  calls.push({url,method:options.method??'GET'});if(url.includes('/websites/')&&options.method!=='POST')return{preview,operations:[]};
  return options.method==='POST'?operation:removed;
 }});
 try{await client.load();const done=reached(client,value=>value.operation?.status==='removed');await client.start();await done;
  assert.equal(completed,1);assert.equal(calls.filter(call=>call.method==='POST').length,1);
  assert.equal(calls.some(call=>call.url.endsWith('/continue')),false);
 }finally{client.dispose();}
});
test('a lost start reply reconciles one durable operation without repeating its POST',async()=>{
 let writes=0;const client=createWebsiteRemovalClient({scope,pollIntervalMs:100,request:async(url,options={})=>{
  if(options.method==='POST'){writes++;throw new Error('fixture reply lost');}
  if(url==='/website-removal-operations')return[operation];
  if(url.includes('/websites/'))return{preview,operations:[]};return removed;
 }});
 try{await client.load();const done=reached(client,value=>value.operation?.status==='removed');await client.start();await done;assert.equal(writes,1);}finally{client.dispose();}
});
test('an ambiguous lost reply cannot send another creation POST',async()=>{
 let writes=0;const client=createWebsiteRemovalClient({scope,request:async(url,options={})=>{
  if(options.method==='POST'){writes++;throw new Error('fixture reply lost');}
  if(url==='/website-removal-operations')return[operation,{...operation,id:'ws-rem-other'}];return{preview,operations:[]};
 }});
 try{await client.load();await client.start();assert.equal(client.getSnapshot().unknownMutation,true);await client.start();assert.equal(writes,1);}finally{client.dispose();}
});
test('closing or superseding the client stops its polls without cancelling server work',async()=>{
 let reads=0,current=true;const client=createWebsiteRemovalClient({scope,pollIntervalMs:100,isCurrent:()=>current,request:async(url,options={})=>{
  if(options.method==='POST')return operation;if(url.includes('/websites/'))return{preview,operations:[]};reads++;return operation;
 }});
 await client.load();await client.start();current=false;client.dispose();await new Promise(resolve=>setTimeout(resolve,140));assert.equal(reads,0);
});
test('permission revocation during polling clears the operation and sends no continuation POST',async()=>{
 const calls=[];const client=createWebsiteRemovalClient({scope,pollIntervalMs:100,request:async(url,options={})=>{
  calls.push({url,method:options.method??'GET'});if(options.method==='POST')return operation;
  if(url.includes('/websites/'))return{preview,operations:[]};throw Object.assign(new Error('revoked'),{status:403});
 }});
 try{await client.load();const stopped=reached(client,value=>value.denied);await client.start();await stopped;
  assert.equal(client.getSnapshot().operation,null);assert.equal(calls.filter(call=>call.method==='POST').length,1);
 }finally{client.dispose();}
});
test('a foreign operation returned by a poll is not published or completed',async()=>{
 let completed=0;const client=createWebsiteRemovalClient({scope,pollIntervalMs:100,onRemoved:()=>completed++,request:async(url,options={})=>{
  if(options.method==='POST')return operation;if(url.includes('/websites/'))return{preview,operations:[]};
  return{...removed,websiteId:'44444444-4444-4444-8444-444444444444'};
 }});
 try{await client.load();const rejected=reached(client,value=>Boolean(value.error));await client.start();await rejected;
  assert.equal(client.getSnapshot().operation.websiteId,scope.websiteId);assert.equal(client.getSnapshot().operation.status,'pending');assert.equal(completed,0);
 }finally{client.dispose();}
});
