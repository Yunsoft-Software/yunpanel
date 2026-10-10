import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mountWebsiteRemovalRoutes } from '../src/website-removal-http.js';
import { removalFixture, removalStart } from '../test-support/website-removal-fixture.js';

// Real Express/HTTP parsing and route guards with controlled session authority.
// Native cookies/CSRF/host execution are accepted separately in the browser lane.
test('whole-operation resume rejects forged authority, foreign Owner, stale state and extra input before queueing',async()=>{
 const actor={userId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',role:'owner'};
 const f=await removalFixture({automaticExecution:true,authorizeActor:async value=>value});
 const started=await f.runtime.start({...removalStart(f.preview),actor});
 await f.registry.failStep(started.id,started.steps[0].id,{code:'fixture_failure',message:'Controlled failure'});
 const operation=await f.runtime.get(started.id);
 let auth={id:actor.sessionId,user:{id:actor.userId,role:'owner',active:true},access:{mode:'management',permissions:['*']},security:{managementAllowed:true}};
 const app=express();app.use(express.json());app.use((request,response,next)=>{request.auth=auth;next();});
 mountWebsiteRemovalRoutes(app,{runtime:f.runtime});
 app.use((error,request,response,next)=>response.status(error.status??500).json({error:{code:error.code??'unknown'}}));
 const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
 const url='http://127.0.0.1:'+server.address().port+'/api/website-removal-operations/'+operation.id+'/run';
 const body={expectedUpdatedAt:operation.updatedAt,confirmation:operation.actions.runConfirmation};
 async function post(value=body,headers={}){return fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});}
 const owner=auth;
 try{
  auth=null;assert.equal((await post(body,{'X-Role':'owner','X-User-Id':actor.userId})).status,401);
  auth={...owner,user:{...owner.user,role:'read_only'},access:{mode:'read_only',permissions:[]}};
  assert.equal((await post()).status,403);
  auth={...owner,user:{...owner.user,id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}};
  const foreign=await post();assert.equal(foreign.status,403);assert.equal((await foreign.json()).error.code,'website_removal_actor_mismatch');
  auth=owner;assert.equal((await post({...body,actor})).status,400);
  assert.equal((await post({...body,expectedUpdatedAt:started.updatedAt})).status,409);
  assert.equal((await post({...body,confirmation:'wrong'})).status,409);
  assert.equal((await f.runtime.get(operation.id)).status,'failed');assert.equal(f.calls.length,0);
  const queued=await post();assert.equal(queued.status,202);const publicResult=(await queued.json()).data;
  assert.equal(publicResult.id,operation.id);assert.equal(publicResult.status,'pending');assert.equal(publicResult.execution.mode,'automatic');
  assert.equal(Object.hasOwn(publicResult,'actor'),false);assert.equal(f.calls.length,0);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
