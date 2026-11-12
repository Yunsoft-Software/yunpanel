import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request} from '@playwright/test';
import {test,expect,apiContext,safeApi,ORIGIN,ready,main,RUN_DIR} from './support.js';
import {createOwnedFixture,cleanupOwnedFixture,readOnlyHostProbe} from './owned-fixture.js';

// Browser closure and a real server process restart are distinct acceptance gates.
// No synthetic restart fixture, skip or expected-failure is used to conflate them.
export const openAcceptances=[{id:'15.02.api-restart',oldCommit:'ba33f4a8^',title:'one browser confirmation survives browser closure and a real API restart with the same removal journal',assertions:['an in-progress owned removal survives a real native API process restart and completes with the same durable operation ID'],reason:'The native panel service is shared. The previous temporary acceptance-service restart harness is retired, and restarting the native API is outside this authorized test window. The executable case below proves only client independence.',requiredChannel:'A separately authorized exclusive native-service restart acceptance window'}];
let owner,sibling,siblingUid,siblingPhpVersion;
const targets=[];
async function cleanupOne(f){const existing=await call(owner,'GET',f.endpoint());if(existing.status===200){const preview=ok(await call(owner,'GET',f.endpoint('/removal')),'Cleanup inspect owned removal');const op=preview.operations?.find(v=>v.websiteId===f.ledger.websiteId&&v.status==='blocked'&&v.steps?.some(step=>step.error?.code==='website_removal_actor_forbidden'));if(op){ok(await call(owner,'POST','/api/panel/website-removal-operations/'+op.id+'/run',{expectedUpdatedAt:op.updatedAt,confirmation:op.actions.runConfirmation}),'Cleanup resume revoked owned journal',202);await poll(owner,op.id,v=>v.status==='removed');}}await f.cleanup();}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test.beforeAll(async({},info)=>{
 test.setTimeout(300000);owner=await apiContext();sibling=await createOwnedFixture(owner,{key:'t886-15-sibling-'+info.project.name+'-'+info.workerIndex,runtime:'php'});
 sibling.record('source-proof',{sourceSha256:createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'),helperSha256:createHash('sha256').update(fs.readFileSync(new URL('./owned-fixture.js',import.meta.url))).digest('hex')});
 const phpConfig=ok(await call(owner,'GET',sibling.endpoint('/php-tools/config')),'Read actual sibling PHP configuration');siblingPhpVersion=phpConfig.phpVersion;siblingUid=readOnlyHostProbe(sibling,'owned-site-files').uid;expect(siblingUid).toBeGreaterThan(0);
 const code='<?php header("Content-Type: application/json");header("Cache-Control: no-store");echo json_encode(["proof"=>'+JSON.stringify('T886-SIBLING-'+sibling.ledger.runId)+',"phpVersion"=>PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION,"uid"=>function_exists("posix_geteuid")?posix_geteuid():-1,"sapi"=>PHP_SAPI]);';
 await sibling.upload('removal-sibling.php',code);await verifyPhpSibling('before-removal');
});
test.afterAll(async()=>{test.setTimeout(360000);const failures=[];for(const fixture of targets.reverse()){try{await cleanupOne(fixture);}catch(error){failures.push({websiteId:fixture.ledger.websiteId,message:String(error.message).split('\n')[0]});}}try{await sibling?.cleanup();}catch(error){failures.push({sibling:true,message:String(error.message).split('\n')[0]});}if(owner&&fs.existsSync(path.join(RUN_DIR,'owned-fixtures')))for(const name of fs.readdirSync(path.join(RUN_DIR,'owned-fixtures'))){if(!name.startsWith('t886-15-')||!name.endsWith('.json'))continue;const ledger=JSON.parse(fs.readFileSync(path.join(RUN_DIR,'owned-fixtures',name),'utf8'));if(ledger.removed)continue;try{await cleanupOwnedFixture(owner,{key:ledger.key});}catch(error){failures.push({websiteId:ledger.websiteId,message:String(error.message).split('\n')[0]});}}await owner?.api.dispose();expect(failures,'Owned removal fixtures must be cleaned').toEqual([]);});
async function call(c,method,endpoint,data){let r;for(let attempt=0;;attempt++){try{r=await c.api.fetch(endpoint,{method,data,headers:{Origin:ORIGIN,'x-csrf-token':c.csrf,Connection:'close'},timeout:90000,maxRedirects:0});}catch(error){if(method==='GET'&&attempt<3){await sleep(700);continue;}throw error;}if(method==='GET'&&[502,503,504].includes(r.status())&&attempt<3){await sleep(700);continue;}break;}const body=await r.json().catch(()=>({}));return{status:r.status(),data:body.data??body,body};}
function ok(r,label,status=200){expect(r.status,label+' '+(r.body?.error?.code??'')).toBe(status);return r.data;}
async function poll(c,id,until,timeout=180000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const operation=ok(await call(c,'GET','/api/panel/website-removal-operations/'+id),'Read exact removal journal');expect(operation.id).toBe(id);if(until(operation))return operation;await sleep(300);}throw new Error('The same real removal journal did not reach the required state');}
async function verifyPhpSibling(phase,captured=null){
 const first=captured??await sibling.http('/removal-sibling.php');sibling.record('sibling.php-first-response',{phase,status:first.status});
 if(first.status!==200){const physical=readOnlyHostProbe(sibling,'owned-site-files');sibling.record('sibling.php-runtime',{phase,uid:physical.uid,unixUserExists:physical.unixUserExists,fpmFiles:physical.fpmFiles,sockets:physical.sockets});await sleep(1000);const later=await sibling.http('/removal-sibling.php');sibling.record('sibling.php-followup',{phase,status:later.status});}
 expect(first.status,'The real PHP/FPM sibling must remain available immediately').toBe(200);let value;try{value=JSON.parse(first.body);}catch{}expect(value,'A static PHP source file cannot satisfy the dynamic runtime nonce').toEqual({proof:'T886-SIBLING-'+sibling.ledger.runId,phpVersion:siblingPhpVersion,uid:siblingUid,sapi:'fpm-fcgi'});expect(first.headers['cache-control']).toContain('no-store');
}
async function verifyRemoved(f,id){
 const op=await poll(owner,id,v=>v.status==='removed');expect(op.error).toBeNull();expect(op.websiteId).toBe(f.ledger.websiteId);
 for(const[kind,key]of[['websites','websiteId'],['domains','domainId'],['applications','applicationId']])expect((await call(owner,'GET','/api/panel/'+kind+'/'+f.ledger[key])).status).toBe(404);
 const firstSiblingReply=await sibling.http('/removal-sibling.php');sibling.record('sibling.php-earliest-reply',{operationId:id,status:firstSiblingReply.status});
 await f.cleanup();const physical=readOnlyHostProbe(f,'lifecycle-absence');expect(physical.unixUserExists).toBe(false);expect(physical.unixGroupExists).toBe(false);expect(physical.roots.length).toBeGreaterThanOrEqual(4);expect(physical.roots.every(v=>v.exists===false)).toBe(true);expect(physical.mounts).toEqual([]);expect(physical.fpmFiles).toEqual([]);expect(physical.sockets).toEqual([]);expect(physical.nginxFiles.every(v=>v.exists===false)).toBe(true);
 f.record('removal.physical-absence',{unixUserAbsent:true,unixGroupAbsent:true,rootsAbsent:true,mountsAbsent:true,fpmAbsent:true,socketsAbsent:true,nginxAbsent:true});
 await verifyPhpSibling(id,firstSiblingReply);return op;
}
async function independentOwner(){const prior=await owner.api.get('/api/auth/session');expect(prior.status()).toBe(200);const previous=(await prior.json()).data;const credentials=JSON.parse(fs.readFileSync('.local/yunpanel-owner-password-only.json','utf8'));const api=safeApi(await request.newContext({baseURL:ORIGIN,ignoreHTTPSErrors:false,storageState:{cookies:[],origins:[]},extraHTTPHeaders:{Origin:ORIGIN}}));const login=await api.post('/api/auth/login',{data:{username:credentials.username,password:credentials.password}});expect(login.status()).toBe(200);const session=await api.get('/api/auth/session');expect(session.status()).toBe(200);const current=(await session.json()).data;expect(current.id).not.toBe(previous.id);expect((await owner.api.get('/api/auth/session')).status(),'Independent login must preserve the main Owner session').toBe(200);return{api,csrf:current.csrfToken,sessionId:current.id};}

test('@mutation source revoking only the initiating session blocks and resumes the exact owned removal journal',async()=>{
 test.setTimeout(480000);let recovered=false;
 for(let attempt=0;attempt<3&&!recovered;attempt++){
  const f=await createOwnedFixture(owner,{key:'t886-15-revoked-'+attempt+'-'+randomUUID().slice(0,8),runtime:'static'});targets.push(f);await f.upload('index.html','T886-REVOCATION-'+f.ledger.runId);
  const initiator=await independentOwner();let id;
  try{
   const preview=ok(await call(initiator,'GET',f.endpoint('/removal')),'Removal preview').preview;expect(preview.readyToStart).toBe(true);
   const created=ok(await call(initiator,'POST',f.endpoint('/removal'),{previewDigest:preview.previewDigest,confirmation:preview.confirmation}),'Start owned removal',201);id=created.id;expect(id).toMatch(/^ws-rem-[a-f0-9-]{36}$/i);expect(created.execution?.mode).toBe('automatic');expect(created.websiteId).toBe(f.ledger.websiteId);f.record('session-revocation.started',{operationId:id,attempt});
   const logout=await initiator.api.post('/api/auth/logout',{data:{},headers:{Origin:ORIGIN,'x-csrf-token':initiator.csrf}});expect([200,204]).toContain(logout.status());
   expect((await initiator.api.get('/api/auth/session')).status()).toBe(401);expect((await owner.api.get('/api/auth/session')).status(),'Only the initiating session is revoked').toBe(200);
   const blocked=await poll(owner,id,v=>['blocked','failed','removed'].includes(v.status));
   if(blocked.status==='removed'){f.record('session-revocation.completed-before-revocation',{operationId:id,attempt,coverageProved:false});await f.cleanup();continue;}
   expect(blocked.status).toBe('blocked');expect(blocked.steps.some(step=>step.error?.code==='website_removal_actor_forbidden')).toBe(true);expect(blocked.actions.runConfirmation).toBeTruthy();
   const resumed=ok(await call(owner,'POST','/api/panel/website-removal-operations/'+id+'/run',{expectedUpdatedAt:blocked.updatedAt,confirmation:blocked.actions.runConfirmation}),'Resume same owned journal',202);expect(resumed.id).toBe(id);expect(resumed.websiteId).toBe(f.ledger.websiteId);
   await verifyRemoved(f,id);recovered=true;f.record('session-revocation.recovered',{operationId:id,blockedThenResumed:true,distinctSession:true});
  }finally{await initiator.api.dispose();}
 }
 expect(recovered,'A real session-revocation block must be observed; an already-completed removal is not a recovery pass').toBe(true);
});

test('@mutation source one browser confirmation survives browser closure and completes with the same native worker journal',async({page})=>{
 test.setTimeout(300000);const f=await createOwnedFixture(owner,{key:'t886-15-browser-'+randomUUID().slice(0,8),runtime:'static'});targets.push(f);await f.upload('index.html','T886-BROWSER-CLOSE-'+f.ledger.runId);
 const isolation=ok(await call(owner,'GET',f.endpoint('/isolation-audit')),'Real runtime isolation');expect(isolation.inspectedSteps.find(step=>step.stepId==='runtime')?.satisfied).toBe(true);
 await ready(page,f.route('settings'));await main(page).getByRole('button',{name:'Siteyi sil…',exact:true}).click();const d=page.getByRole('dialog',{name:'Siteyi kalıcı olarak sil'});await expect(d).toBeVisible();await d.getByRole('textbox').fill(f.ledger.hostname);
 const responseEvent=page.waitForResponse(r=>new URL(r.url()).pathname===f.endpoint('/removal')&&r.request().method()==='POST');await d.getByRole('button',{name:'Silme işlemini başlat',exact:true}).click();const response=await responseEvent;expect(response.status()).toBe(201);const created=(await response.json()).data;expect(created.execution?.mode).toBe('automatic');expect(created.websiteId).toBe(f.ledger.websiteId);expect(created.status).not.toBe('removed');
 const id=created.id;await expect(page.getByLabel('Site silme durumu')).toBeVisible();const beforeClose=ok(await call(owner,'GET','/api/panel/website-removal-operations/'+id),'Removal before browser closure');expect(beforeClose.status).not.toBe('removed');f.record('browser-closed.started',{operationId:id});expect(page.auditTraffic.filter(v=>v.method==='POST'&&v.path.endsWith('/continue'))).toHaveLength(0);expect(page.auditErrors).toEqual([]);
 await page.context().close();expect(page.isClosed()).toBe(true);
 const done=await verifyRemoved(f,id);f.record('browser-closed.completed',{operationId:id,status:done.status,clientContinuationRequests:0,apiRestartTested:false});
});
