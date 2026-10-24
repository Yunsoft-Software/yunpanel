import fs from 'node:fs';
import path from 'node:path';
import {test,expect,ORIGIN,manifest,apiContext,apiCall,main,ready} from './support.js';

// Local production UI assets over the actual bounded .28 source API. API and
// vendor tool responses are never fulfilled, intercepted or replaced here.
test.beforeEach(async({context})=>{
 const dist=path.resolve('apps/web/dist');
 await context.route(url=>url.origin===ORIGIN&&!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/tools/'),async route=>{
  const url=new URL(route.request().url()),file=route.request().isNavigationRequest()?path.join(dist,'index.html'):path.join(dist,url.pathname);
  if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile())return route.continue();
  const contentType={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'}[path.extname(file)]??'application/octet-stream';
  return route.fulfill({body:fs.readFileSync(file),contentType,headers:{'Cache-Control':'no-store'}});
 });
});
let contexts;
test.beforeAll(async()=>{
 if(!/^[a-f0-9]{64}$/.test(process.env.YUNPANEL_AUDIT_ACCEPTANCE_SHA??''))throw new Error('Exact bounded native source identity required');
 const c=await apiContext();try{
  const websites=await apiCall(c.api,c.csrf,'GET','/api/panel/websites'),domains=await apiCall(c.api,c.csrf,'GET','/api/panel/domains');
  expect(websites.status).toBe(200);expect(domains.status).toBe(200);const m=manifest();
  contexts=Object.fromEntries(['php','static','node','python','docker'].map(runtime=>{
   const own=runtime==='php'?m.fixture.websiteId:runtime==='static'&&!m.fixture.extraStatic?.removed?m.fixture.extraStatic?.websiteId:null;
   const site=websites.data.find(item=>item.id===own)??websites.data.find(item=>item.runtimeType===runtime&&item.state!=='removed');
   const domain=domains.data.find(item=>item.websiteId===site?.id&&!item.parentDomainId);
   return[runtime,domain?{websiteId:site.id,domainId:domain.id,hostname:domain.primaryDomain}:null];
  }));
 }finally{await c.api.dispose();}
});

async function assertScreen(page){
 await expect(main(page).locator('h1')).not.toHaveText(/^\s*$/);
 await expect(main(page)).not.toContainText(/Sayfa bulunamadı|Cannot GET|Beklenmeyen bir hata|Bu işlev henüz uygulanmadı/i);
 expect(page.auditErrors).toEqual([]);
 expect(page.auditTraffic.filter(item=>typeof item.status==='number'&&item.status>=500)).toEqual([]);
 const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:window.innerWidth}));
 expect(dimensions.scroll,'The page itself must not overflow; tables may scroll within their own container').toBeLessThanOrEqual(dimensions.width+1);
 await expect(page.getByRole('dialog')).toHaveCount(0);
}

const globals=['websites','dashboard','files','databases','mail','statistics','tools-settings','servers','firewall','applications','domains','docker','jobs','audit','settings','settings/users','websites/new','applications/new','settings?section=account','settings?section=dns','settings?section=ai','settings?section=updates','ssl','cron','backup','backups','logs','php','access','customers','wordpress'];
for(const width of [320,390,834,1440])for(const route of globals){
 test(`@native-ui current screen /${route} at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:1000});await ready(page,'/'+route);await assertScreen(page);
 });
}
const tabs=['overview','hosting','settings','domains','dns','files','databases','ssl','node','deploy','logs','analytics','access','terminal','cron','backup','mail','wordpress','php'];
for(const runtime of ['php','static','node','python','docker'])for(const tab of tabs){
 test(`@native-ui actual ${runtime} Website /${tab} retains its Domain context`,async({page})=>{
  test.skip(!contexts?.[runtime],`No provisioned ${runtime} Website with an explicit Domain exists in this native catalog`);
  const target=contexts[runtime];await ready(page,'/websites/'+target.domainId+'/'+tab);
  await expect(main(page).locator('h1')).toHaveText(target.hostname);await assertScreen(page);
 });
}

test('@native-ui isolation tools have one canonical access location and settings stays focused on site lifecycle',async({page})=>{
 const target=contexts.php;expect(target).toBeTruthy();
 await ready(page,'/websites/'+target.domainId+'/settings');
 await expect(main(page).getByRole('heading',{name:'Website izolasyon denetimi',exact:true})).toHaveCount(0);
 await ready(page,'/websites/'+target.domainId+'/access');
 const disclosure=main(page).locator('details').filter({has:page.locator('summary',{hasText:'Gelişmiş güvenlik denetimi ve geçiş araçları'})});
 await expect(disclosure).toHaveCount(1);await expect(disclosure.locator('summary')).toBeVisible();
 await expect(disclosure).not.toHaveAttribute('open','');await disclosure.locator('summary').click();
 await expect(disclosure.getByRole('heading',{name:'Website izolasyon denetimi',exact:true})).toBeVisible();
 expect(page.auditErrors).toEqual([]);
});

test('@native-ui actual rolled-back restore is clearly shown in the job list and the single job dialog',async({page,liveApi})=>{
 const m=manifest();let saved=m.fixture.nativeHostingRollback;
 if(!saved){
  const proof=m.fixture.operations.findLast(item=>item.action==='hosting-dns.physical-rollback'&&item.verified);expect(proof).toBeTruthy();
  const operation=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/websites/'+m.fixture.extraStatic.websiteId+'/backup-operations/'+proof.operationId);
  expect(operation.status).toBe(200);expect(operation.data.status).toBe('rolled_back');saved={jobId:operation.data.jobId};
 }
 const job=await apiCall(liveApi.api,liveApi.csrf,'GET','/api/panel/jobs/'+saved.jobId);expect(job.status).toBe(200);
 expect(job.data.status).toBe('succeeded');expect(job.data.result).toMatchObject({kind:'restore',status:'rolled_back',verified:true});
 await ready(page,'/jobs?q='+encodeURIComponent(saved.jobId));
 const row=main(page).getByRole('row').filter({hasText:saved.jobId.slice(0,12)});await expect(row).toHaveCount(1);
 await expect(row.locator('.ws-badge')).toHaveText('Geri alındı');await row.getByRole('button',{name:'İncele',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'İşlem durumu'});await expect(dialog).toHaveCount(1);
 await expect(dialog.locator('.ws-job-status')).toContainText('işlem öncesindeki durum geri getirildi');
 await expect(dialog.locator('.ws-job-status')).not.toContainText('Sunucu işlemi başarıyla tamamladı');
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect(page.auditErrors).toEqual([]);
});
