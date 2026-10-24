import fs from 'node:fs';
import path from 'node:path';
import {test,expect,manifest,saveManifest,apiCall,ORIGIN,RUN_DIR,ready,main} from './support.js';
import {restartAcceptanceApi} from './native-control.js';
test.beforeEach(async({context})=>{
 const dist=path.resolve('apps/web/dist');
 await context.route(url=>url.origin===ORIGIN&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/tools/'),async route=>{
  const url=new URL(route.request().url()),file=route.request().isNavigationRequest()?path.join(dist,'index.html'):path.join(dist,url.pathname);
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
  const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
  return route.fulfill({body:fs.readFileSync(file),contentType,headers:{'Cache-Control':'no-store'}});
 });
});
function record(action,proof){const m=manifest();m.fixture.operations.push({action,...proof,at:new Date().toISOString()});saveManifest(m);}
test('@mutation source resumes the exact previously blocked owned static removal journal',async({liveApi})=>{
 test.setTimeout(180000);const m=manifest(),target=m.fixture.extraStatic;
 expect(target?.removed).not.toBe(true);expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);
 expect(m.fixture.createdDomainIds).toContain(target.domainId);expect(target.removalOperationId).toMatch(/^ws-rem-/);
 const base='/api/panel/website-removal-operations/'+target.removalOperationId;
 const current=await apiCall(liveApi.api,liveApi.csrf,'GET',base);expect(current.status).toBe(200);
 let operation=current.data;expect(operation.websiteId).toBe(target.websiteId);
 expect(['blocked','failed']).toContain(operation.status);expect(operation.actions.runConfirmation).toBeTruthy();
 const resumed=await apiCall(liveApi.api,liveApi.csrf,'POST',base+'/run',{
  expectedUpdatedAt:operation.updatedAt,confirmation:operation.actions.runConfirmation,
 });
 expect(resumed.status).toBe(202);expect(resumed.data.id).toBe(target.removalOperationId);
 for(let attempt=0;attempt<160&&operation.status!=='removed';attempt++){
  await new Promise(resolve=>setTimeout(resolve,650));const result=await apiCall(liveApi.api,liveApi.csrf,'GET',base);
  expect(result.status).toBe(200);operation=result.data;
  record('static.exact-blocked-journal-recovery-phase',{operationId:operation.id,status:operation.status,code:operation.error?.code});
  expect(['failed','blocked']).not.toContain(operation.status);
 }
 expect(operation.status).toBe('removed');expect(operation.error).toBeNull();
 for(const [kind,id] of [['websites',target.websiteId],['domains',target.domainId],['applications',target.applicationId]]){
  expect((await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/'+kind+'/'+id)).status).toBe(404);
 }
 expect((await liveApi.api.get('https://'+m.fixture.hostname+'/')).status()).toBe(200);
 const saved=manifest();saved.fixture.extraStatic.removed=true;saveManifest(saved);
 record('static.exact-blocked-journal-recovered',{verified:true,operationId:operation.id,physicalSshAbsenceVerificationPending:true});
});
test('@mutation source one browser confirmation survives browser closure and a real API restart with the same removal journal',async({page,liveApi})=>{
 test.setTimeout(240000);const m=manifest(),target=m.fixture.extraStatic;
 expect(target?.removed).not.toBe(true);expect(m.fixture.createdWebsiteIds).toContain(target.websiteId);
 expect(m.fixture.createdDomainIds).toContain(target.domainId);
 const root='/api/panel/websites/'+target.websiteId;
 const before=await apiCall(liveApi.api,liveApi.csrf,'GET',root);expect(before.status).toBe(200);
 const isolation=await apiCall(liveApi.api,liveApi.csrf,'GET',root+'/isolation-audit');expect(isolation.status).toBe(200);
 const runtime=isolation.data.inspectedSteps.find(step=>step.stepId==='runtime');expect(runtime?.satisfied).toBe(true);
 record('static.uploaded-user-content-runtime-inspection',{verified:true,satisfied:runtime.satisfied});
 await ready(page,'/websites/'+target.domainId+'/settings');
 await main(page).getByRole('button',{name:'Siteyi sil…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Siteyi kalıcı olarak sil'});await expect(dialog).toBeVisible();
 await dialog.getByRole('textbox').fill(target.hostname);
 const response=page.waitForResponse(value=>new URL(value.url()).pathname===root+'/removal'&&value.request().method()==='POST');
 await dialog.getByRole('button',{name:'Silme işlemini başlat',exact:true}).click();
 const result=await response;expect(result.status()).toBe(201);let operation=(await result.json()).data;
 expect(operation.execution?.mode).toBe('automatic');expect(operation.websiteId).toBe(target.websiteId);
 const saved=manifest();saved.fixture.extraStatic.removalOperationId=operation.id;
 saved.fixture.extraStatic.removalPhysicalScope={applicationId:before.data.applicationId,unixUser:before.data.unixUser,
  documentRoot:before.data.documentRoot,hostname:target.hostname};saveManifest(saved);
 await expect(page.getByLabel('Site silme durumu')).toBeVisible();
 const screenshot=path.join(RUN_DIR,'static-single-confirm-removal-in-progress.png');
 await page.screenshot({path:screenshot,fullPage:false,mask:[page.locator('input[type="password"]')]});fs.chmodSync(screenshot,0o600);
 expect(page.auditTraffic.filter(value=>value.method==='POST'&&value.path.endsWith('/continue'))).toHaveLength(0);
 expect(page.auditErrors).toEqual([]);await page.context().close();
 for(let attempt=0;attempt<20&&operation.status==='pending';attempt++){
  await new Promise(resolve=>setTimeout(resolve,100));const status=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/website-removal-operations/'+operation.id);
  expect(status.status).toBe(200);operation=status.data;
 }
 expect(operation.status).toBe('running');
 record('static.browser-closed-before-restart',{operationId:operation.id,clientContinuationRequests:0});
 record('static.actual-api-restart',await restartAcceptanceApi({operationId:operation.id,websiteId:target.websiteId}));
 for(let attempt=0;attempt<120&&operation.status!=='removed';attempt++){
  await new Promise(resolve=>setTimeout(resolve,650));const result=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/website-removal-operations/'+operation.id);
  expect(result.status).toBe(200);operation=result.data;
  record('static.browser-closed-worker-phase',{operationId:operation.id,status:operation.status,code:operation.error?.code});
  expect(['failed','blocked']).not.toContain(operation.status);
 }
 expect(operation.status).toBe('removed');
 expect(operation.error).toBeNull();
 expect((await apiCall(liveApi.api,liveApi.csrf,'GET',root)).status).toBe(404);
 expect((await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/domains/'+target.domainId)).status).toBe(404);
 expect((await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/applications/'+target.applicationId)).status).toBe(404);
 expect((await liveApi.api.get('https://'+m.fixture.hostname+'/')).status()).toBe(200);
 const final=manifest();final.fixture.extraStatic.removed=true;saveManifest(final);
 record('static.browser-closed-and-api-restarted-removal',{verified:true,operationId:operation.id,physicalSshAbsenceVerificationPending:true});
});
